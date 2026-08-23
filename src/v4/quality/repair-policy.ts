import crypto from "node:crypto";
import type {
  QualityCycleId,
  QualityEvidence,
  RepairHistoryEntry,
  RequirementId,
  RequirementVerdict,
} from "../contracts/quality";
import type { QualityErrorCode } from "./errors";
import { canonicalJsonStringify } from "./evidence-bundle-store";

export interface RepairPolicyOptions {
  readonly maxRepairs?: number | undefined;
}

export interface DecideRepairInput {
  readonly cycleId: QualityCycleId;
  readonly phase: "VERIFY" | "ACCEPT";
  readonly failingRequirements: readonly RequirementId[];
  readonly failingVerdicts?: readonly RequirementVerdict[] | undefined;
  readonly failingGateEvidences?: readonly QualityEvidence[] | undefined;
  readonly failureSignatures?: readonly string[] | undefined;
  readonly priorRepairHistory?: readonly RepairHistoryEntry[] | undefined;
  readonly currentAttempt?: number | undefined;
  readonly now?: string | undefined;
}

export type RepairDecision =
  | {
      readonly action: "none";
    }
  | {
      readonly action: "repair";
      readonly targetPhase: "FIX" | "REWORK";
      readonly requirementIds: readonly RequirementId[];
      readonly nextAttempt: number;
      readonly historyEntry: RepairHistoryEntry;
      readonly newHistory: readonly RepairHistoryEntry[];
    }
  | {
      readonly action: "block";
      readonly reason: string;
      readonly code: QualityErrorCode;
      readonly failingRequirementIds: readonly RequirementId[];
    };

export function countPriorAttemptsPerRequirement(
  history: readonly RepairHistoryEntry[]
): Map<RequirementId, number> {
  const counts = new Map<RequirementId, number>();
  for (const entry of history) {
    for (const reqId of entry.requirementIds) {
      const curr = counts.get(reqId) ?? 0;
      counts.set(reqId, curr + 1);
    }
  }
  return counts;
}

export function computeNoProgressFingerprint(input: {
  readonly failureSignatures?: readonly string[] | undefined;
  readonly requirementIds: readonly RequirementId[];
  readonly evidenceDigests?: readonly string[] | undefined;
}): string {
  const sortedReqs = [...input.requirementIds].sort();
  const sortedSigs = input.failureSignatures ? [...input.failureSignatures].sort() : [];
  const sortedDigests = input.evidenceDigests ? [...input.evidenceDigests].sort() : [];

  const tuple = {
    evidenceDigests: sortedDigests,
    failureSignatures: sortedSigs,
    requirementIds: sortedReqs,
  };
  return crypto.createHash("sha256").update(canonicalJsonStringify(tuple)).digest("hex");
}

export class RepairPolicy {
  private readonly maxRepairs: number;

  constructor(options?: RepairPolicyOptions | undefined) {
    this.maxRepairs = options?.maxRepairs ?? 2;
  }

  decideRepair(
    cycleIdOrInput: QualityCycleId | DecideRepairInput,
    phaseArg?: "VERIFY" | "ACCEPT",
    failingRequirementsArg?: readonly RequirementId[],
    currentAttemptArg?: number,
    priorVerdictsArg?: readonly RequirementVerdict[],
    priorEvidencesArg?: readonly QualityEvidence[]
  ): RepairDecision {
    let cycleId: QualityCycleId;
    let phase: "VERIFY" | "ACCEPT";
    let failingRequirements: readonly RequirementId[];
    let failingVerdicts: readonly RequirementVerdict[] | undefined;
    let failingGateEvidences: readonly QualityEvidence[] | undefined;
    let failureSignatures: readonly string[] | undefined;
    let priorRepairHistory: readonly RepairHistoryEntry[] = [];
    let nowStr: string = new Date().toISOString();

    if (typeof cycleIdOrInput === "object" && "cycleId" in cycleIdOrInput) {
      cycleId = cycleIdOrInput.cycleId;
      phase = cycleIdOrInput.phase;
      failingRequirements = cycleIdOrInput.failingRequirements;
      failingVerdicts = cycleIdOrInput.failingVerdicts;
      failingGateEvidences = cycleIdOrInput.failingGateEvidences;
      failureSignatures = cycleIdOrInput.failureSignatures;
      priorRepairHistory = cycleIdOrInput.priorRepairHistory ?? [];
      if (cycleIdOrInput.now) {
        nowStr = cycleIdOrInput.now;
      }
    } else {
      cycleId = cycleIdOrInput;
      phase = phaseArg!;
      failingRequirements = failingRequirementsArg!;
      failingVerdicts = priorVerdictsArg;
      failingGateEvidences = priorEvidencesArg;
    }

    if (failingRequirements.length === 0) {
      return { action: "none" };
    }

    // 1. Check attempt limit per requirement from durable prior history
    const priorCounts = countPriorAttemptsPerRequirement(priorRepairHistory);
    for (const reqId of failingRequirements) {
      const priorCount = priorCounts.get(reqId) ?? 0;
      if (priorCount >= this.maxRepairs) {
        return {
          action: "block",
          reason: `Repair budget exhausted for requirement '${reqId}' (${priorCount}/${this.maxRepairs})`,
          code: "REPAIR_BUDGET_EXHAUSTED",
          failingRequirementIds: failingRequirements,
        };
      }
    }

    // 2. Compute canonical fingerprint strictly over stdout/stderr SHA256 digests and failure signatures
    const sigs: string[] = failureSignatures ? [...failureSignatures] : [];
    if (failingVerdicts) {
      for (const v of failingVerdicts) {
        if (v.status !== "accepted") {
          sigs.push(`${v.requirementId}:${v.status}:${v.rationale}`);
        }
      }
    }

    const digests: string[] = [];
    if (failingGateEvidences) {
      for (const ev of failingGateEvidences) {
        digests.push(`${ev.stdoutSha256}:${ev.stderrSha256}:${ev.exitCode}`);
      }
    }

    const fingerprint = computeNoProgressFingerprint({
      requirementIds: failingRequirements,
      failureSignatures: sigs,
      evidenceDigests: digests,
    });

    // Check if the most recent prior repair in this phase had identical fingerprint
    const priorPhaseRepairs = priorRepairHistory.filter((h) => h.phase === phase);
    if (priorPhaseRepairs.length > 0) {
      const lastRepair = priorPhaseRepairs[priorPhaseRepairs.length - 1]!;
      if (lastRepair.fingerprint === fingerprint) {
        return {
          action: "block",
          reason: "No progress made: failing requirements and evidence digests remain unchanged",
          code: "REPAIR_NO_PROGRESS",
          failingRequirementIds: failingRequirements,
        };
      }
    }

    // 3. Build new history entry
    const perRequirementAttempts: Record<string, number> = {};
    for (const reqId of failingRequirements) {
      const curr = priorCounts.get(reqId) ?? 0;
      perRequirementAttempts[reqId] = curr + 1;
    }

    const nextAttempt = priorRepairHistory.length + 1;
    const historyEntry: RepairHistoryEntry = {
      attempt: nextAttempt,
      phase,
      cycleId,
      requirementIds: failingRequirements,
      priorVerdicts: failingVerdicts ? [...failingVerdicts] : [],
      priorEvidenceIds: failingGateEvidences ? failingGateEvidences.map((e) => e.evidenceId) : [],
      perRequirementAttempts,
      fingerprint,
      outcome: "failed",
      timestamp: nowStr,
    };

    const targetPhase: "FIX" | "REWORK" = phase === "VERIFY" ? "FIX" : "REWORK";
    const newHistory = [...priorRepairHistory, historyEntry];

    return {
      action: "repair",
      targetPhase,
      requirementIds: failingRequirements,
      nextAttempt,
      historyEntry,
      newHistory,
    };
  }
}
