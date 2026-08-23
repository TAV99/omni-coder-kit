import {
  correlateEvidence,
  indexAndValidateEvidenceCollection,
  type GateResult,
  type QualityCycleId,
  type QualityDecision,
  type QualityEvidence,
  type QualityEvidenceId,
  type RequirementId,
  type RequirementRecord,
  type RequirementVerdict,
} from "../contracts/quality";
import type { RunId } from "../contracts/ids";

export interface AcceptanceContext {
  readonly runId: RunId;
  readonly cycleId: QualityCycleId;
}

export interface AgentJudgement {
  readonly status: "accepted" | "rejected" | "inconclusive";
  readonly rationale: string;
  readonly evidenceIds: readonly QualityEvidenceId[];
  readonly reason?: string | undefined;
}

export class AcceptanceEngine {
  evaluateRequirement(
    req: RequirementRecord,
    gateResults: readonly GateResult[],
    evidence: readonly QualityEvidence[],
    context: AcceptanceContext,
    agentJudgement?: AgentJudgement | undefined
  ): RequirementVerdict {
    if (!context || !context.runId || !context.cycleId) {
      return {
        requirementId: req.requirementId,
        status: "inconclusive",
        evidenceIds: [],
        rationale: "Missing required execution context (runId/cycleId)",
      };
    }

    // Pre-validate the raw evidence collection for the cycle
    const validatedColl = indexAndValidateEvidenceCollection(evidence, context);
    if (!validatedColl.valid) {
      return {
        requirementId: req.requirementId,
        status: "inconclusive",
        evidenceIds: [],
        rationale: `Evidence collection validation failed: ${validatedColl.reason}`,
      };
    }

    const evidenceMap = validatedColl.index.byId;

    if (req.testStrategy.kind === "hard") {
      if (gateResults.length === 0) {
        return {
          requirementId: req.requirementId,
          status: "inconclusive",
          evidenceIds: [],
          rationale: `Unmapped hard requirement '${req.requirementId}' has no gate results`,
        };
      }

      // Check mandatory failed gates (nonzero exit)
      const mandatoryFailed = gateResults.find(
        (g) => g.status === "failed" && g.mandatory !== false
      );
      if (mandatoryFailed) {
        let evIds: QualityEvidenceId[] = [];
        if (mandatoryFailed.evidenceId && evidenceMap.has(mandatoryFailed.evidenceId)) {
          const ev = evidenceMap.get(mandatoryFailed.evidenceId)!;
          const corr = correlateEvidence(ev, {
            runId: context.runId,
            cycleId: context.cycleId,
            gateId: mandatoryFailed.gateId,
            operationId: mandatoryFailed.operationId,
          });
          if (corr.correlated) {
            evIds = [mandatoryFailed.evidenceId];
          }
        }
        return {
          requirementId: req.requirementId,
          status: "rejected",
          evidenceIds: evIds,
          rationale: mandatoryFailed.reason ?? "Mandatory gate failed",
        };
      }

      // Check mandatory inconclusive gates
      const mandatoryInconcl = gateResults.find(
        (g) => g.status === "inconclusive" && g.mandatory !== false
      );
      if (mandatoryInconcl) {
        let evIds: QualityEvidenceId[] = [];
        if (mandatoryInconcl.evidenceId && evidenceMap.has(mandatoryInconcl.evidenceId)) {
          const ev = evidenceMap.get(mandatoryInconcl.evidenceId)!;
          const corr = correlateEvidence(ev, {
            runId: context.runId,
            cycleId: context.cycleId,
            gateId: mandatoryInconcl.gateId,
            operationId: mandatoryInconcl.operationId,
          });
          if (corr.correlated) {
            evIds = [mandatoryInconcl.evidenceId];
          }
        }
        return {
          requirementId: req.requirementId,
          status: "inconclusive",
          evidenceIds: evIds,
          rationale:
            mandatoryInconcl.reason ||
            `Mandatory gate '${mandatoryInconcl.gateId}' status is 'inconclusive'`,
        };
      }

      // Check mandatory skipped gates
      const mandatorySkipped = gateResults.find(
        (g) => g.status === "skipped" && g.mandatory !== false
      );
      if (mandatorySkipped) {
        return {
          requirementId: req.requirementId,
          status: "inconclusive",
          evidenceIds: [],
          rationale:
            mandatorySkipped.reason ||
            `Mandatory gate '${mandatorySkipped.gateId}' was skipped`,
        };
      }

      // Only mandatory mapped gates decide acceptance
      const mandatoryPassedGates = gateResults.filter(
        (g) => g.status === "passed" && g.mandatory !== false
      );
      if (mandatoryPassedGates.length === 0) {
        return {
          requirementId: req.requirementId,
          status: "inconclusive",
          evidenceIds: [],
          rationale: `No passed mandatory gates found for requirement '${req.requirementId}'`,
        };
      }

      const validEvidenceIds: QualityEvidenceId[] = [];
      const seenEvidenceIds = new Set<QualityEvidenceId>();

      for (const g of mandatoryPassedGates) {
        if (!g.evidenceId) {
          return {
            requirementId: req.requirementId,
            status: "inconclusive",
            evidenceIds: [],
            rationale: `Passed gate '${g.gateId}' is missing evidenceId`,
          };
        }

        if (seenEvidenceIds.has(g.evidenceId)) {
          return {
            requirementId: req.requirementId,
            status: "inconclusive",
            evidenceIds: [],
            rationale: `Duplicate evidenceId '${g.evidenceId}' detected across gates for requirement '${req.requirementId}'`,
          };
        }
        seenEvidenceIds.add(g.evidenceId);

        const ev = evidenceMap.get(g.evidenceId);
        if (!ev) {
          return {
            requirementId: req.requirementId,
            status: "inconclusive",
            evidenceIds: [],
            rationale: `Evidence '${g.evidenceId}' not found for passed gate '${g.gateId}'`,
          };
        }

        const corr = correlateEvidence(ev, {
          runId: context.runId,
          cycleId: context.cycleId,
          gateId: g.gateId,
          operationId: g.operationId,
        });

        if (!corr.correlated || ev.termination !== "exited" || ev.exitCode !== 0) {
          return {
            requirementId: req.requirementId,
            status: "inconclusive",
            evidenceIds: [],
            rationale: corr.reason || `Evidence correlation failed for gate '${g.gateId}'`,
          };
        }

        validEvidenceIds.push(g.evidenceId);
      }

      if (validEvidenceIds.length === 0) {
        return {
          requirementId: req.requirementId,
          status: "inconclusive",
          evidenceIds: [],
          rationale: `No valid evidence for accepted requirement '${req.requirementId}'`,
        };
      }

      return {
        requirementId: req.requirementId,
        status: "accepted",
        evidenceIds: validEvidenceIds,
        rationale: "All mapped mandatory gates passed with valid correlated evidence",
      };
    } else {
      // Agent judged requirement
      if (!agentJudgement) {
        return {
          requirementId: req.requirementId,
          status: "inconclusive",
          evidenceIds: [],
          rationale: "No agent judge evaluation available",
        };
      }

      const cited = agentJudgement.evidenceIds ?? [];

      // Validate cited evidence IDs against the pre-validated collection
      const seenCited = new Set<QualityEvidenceId>();
      for (const cid of cited) {
        if (seenCited.has(cid)) {
          return {
            requirementId: req.requirementId,
            status: "inconclusive",
            evidenceIds: [],
            rationale: `Agent judgement contains duplicate cited evidenceId '${cid}'`,
          };
        }
        seenCited.add(cid);

        if (!evidenceMap.has(cid)) {
          return {
            requirementId: req.requirementId,
            status: "inconclusive",
            evidenceIds: [],
            rationale: `Agent judgement cited unknown or unvalidated evidence ID '${cid}'`,
          };
        }
      }

      return {
        requirementId: req.requirementId,
        status: agentJudgement.status,
        evidenceIds: cited,
        rationale:
          agentJudgement.rationale ||
          agentJudgement.reason ||
          "Evaluated by agent judge",
      };
    }
  }

  evaluateAll(
    requirements: readonly RequirementRecord[],
    gateResultsByReq: Map<RequirementId, GateResult[]>,
    evidence: readonly QualityEvidence[],
    context: AcceptanceContext,
    agentJudgements?: Map<RequirementId, AgentJudgement> | undefined
  ): readonly RequirementVerdict[] {
    return requirements.map((req) => {
      const gates = gateResultsByReq.get(req.requirementId) ?? [];
      const judge = agentJudgements?.get(req.requirementId);
      return this.evaluateRequirement(req, gates, evidence, context, judge);
    });
  }

  decideCycle(
    verdicts: readonly RequirementVerdict[],
    currentPhase: "VERIFY" | "ACCEPT",
    repairAttempt: number,
    maxRepairs: number
  ): QualityDecision {
    const failingVerdicts = verdicts.filter((v) => v.status !== "accepted");

    if (failingVerdicts.length === 0) {
      return {
        kind: "advance",
        to: currentPhase === "VERIFY" ? "ACCEPT" : "DOCUMENT",
      };
    }

    const failingIds = failingVerdicts.map((v) => v.requirementId);

    if (repairAttempt < maxRepairs) {
      return {
        kind: "repair",
        to: currentPhase === "VERIFY" ? "FIX" : "REWORK",
        requirementIds: failingIds,
      };
    }

    return {
      kind: "block",
      reason: `Repair budget exhausted (${repairAttempt}/${maxRepairs})`,
      requiredAction: "Resolve failing quality requirements and resume run",
    };
  }
}
