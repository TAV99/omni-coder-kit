import { z } from "zod";
import {
  asArtifactId,
  asEventId,
  asRunId,
  type ArtifactId,
  type EventId,
  type RunId,
} from "./ids";

// Branded IDs
export type GateId = string & { readonly __brand: "GateId" };
export type RequirementId = string & { readonly __brand: "RequirementId" };
export type QualityCycleId = string & { readonly __brand: "QualityCycleId" };
export type QualityEvidenceId = string & { readonly __brand: "QualityEvidenceId" };

export function asGateId(id: string): GateId {
  if (!id || typeof id !== "string" || id.trim().length === 0) {
    throw new Error("GateId must be a non-empty string");
  }
  return id as GateId;
}

export function asRequirementId(id: string): RequirementId {
  if (!id || typeof id !== "string" || id.trim().length === 0) {
    throw new Error("RequirementId must be a non-empty string");
  }
  return id as RequirementId;
}

export function asQualityCycleId(id: string): QualityCycleId {
  if (!id || typeof id !== "string" || id.trim().length === 0) {
    throw new Error("QualityCycleId must be a non-empty string");
  }
  if (
    id.includes("/") ||
    id.includes("\\") ||
    id.includes(":") ||
    id === "." ||
    id === ".." ||
    id.startsWith(".") ||
    id.includes("..")
  ) {
    throw new Error("QualityCycleId cannot contain path separators or dot traversal segments");
  }
  return id as QualityCycleId;
}

export function asQualityEvidenceId(id: string): QualityEvidenceId {
  if (!id || typeof id !== "string" || id.trim().length === 0) {
    throw new Error("QualityEvidenceId must be a non-empty string");
  }
  return id as QualityEvidenceId;
}

export const GateIdSchema = z.string().min(1).transform(asGateId);
export const RequirementIdSchema = z.string().min(1).transform(asRequirementId);
export const QualityCycleIdSchema = z.string().min(1).transform(asQualityCycleId);
export const QualityEvidenceIdSchema = z.string().min(1).transform(asQualityEvidenceId);

const RunIdTransformSchema = z.string().min(1).transform(asRunId);
const ArtifactIdTransformSchema = z.string().min(1).transform(asArtifactId);

// Gate Status
export const GATE_STATUSES = ["passed", "failed", "skipped", "inconclusive"] as const;
export const GateStatusSchema = z.enum(GATE_STATUSES);
export type GateStatus = z.infer<typeof GateStatusSchema>;

// Requirement Status
export const REQUIREMENT_STATUSES = ["accepted", "rejected", "inconclusive"] as const;
export const RequirementStatusSchema = z.enum(REQUIREMENT_STATUSES);
export type RequirementStatus = z.infer<typeof RequirementStatusSchema>;

// Gate Definition
export const GateDefinitionSchema = z
  .object({
    id: GateIdSchema,
    command: z.string().min(1),
    args: z.array(z.string()).readonly(),
    cwd: z.string().min(1),
    timeoutMs: z.number().int().positive(),
    mandatory: z.boolean(),
    requirementIds: z.array(RequirementIdSchema).readonly(),
    dependsOn: z.array(GateIdSchema).readonly(),
    sideEffect: z.enum(["read-only", "workspace-write"]),
    retrySafe: z.boolean(),
    concurrencyKey: z.string().min(1).optional(),
  })
  .strict();

export type GateDefinition = z.infer<typeof GateDefinitionSchema>;

// Gate Result
const BaseGateResultFields = {
  schemaVersion: z.literal(1),
  cycleId: QualityCycleIdSchema,
  gateId: GateIdSchema,
  operationId: z.string().min(1),
  startedAt: z.string().datetime({ offset: true }),
  durationMs: z.number().int().nonnegative(),
  mandatory: z.boolean().optional(),
};

export const GateResultPassedSchema = z
  .object({
    ...BaseGateResultFields,
    status: z.literal("passed"),
    evidenceId: QualityEvidenceIdSchema,
    failureSignature: z.undefined().optional(),
    reason: z.string().optional(),
  })
  .strict();

export const GateResultFailedSchema = z
  .object({
    ...BaseGateResultFields,
    status: z.literal("failed"),
    evidenceId: QualityEvidenceIdSchema.optional(),
    failureSignature: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();

export const GateResultSkippedSchema = z
  .object({
    ...BaseGateResultFields,
    status: z.literal("skipped"),
    evidenceId: QualityEvidenceIdSchema.optional(),
    reason: z.string().min(1),
    failureSignature: z.string().optional(),
  })
  .strict();

export const GateResultInconclusiveSchema = z
  .object({
    ...BaseGateResultFields,
    status: z.literal("inconclusive"),
    evidenceId: QualityEvidenceIdSchema.optional(),
    reason: z.string().min(1),
    failureSignature: z.string().min(1),
  })
  .strict();

export const GateResultSchema = z.discriminatedUnion("status", [
  GateResultPassedSchema,
  GateResultFailedSchema,
  GateResultSkippedSchema,
  GateResultInconclusiveSchema,
]);

export type GateResult = z.infer<typeof GateResultSchema>;

// UTF-8 byte bounding helper (does not split multi-byte UTF-8 sequences)
export function truncateUtf8Bytes(str: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) {
    return str;
  }
  let end = maxBytes;
  let i = end - 1;
  while (i >= 0 && (buf[i]! & 0xc0) === 0x80) {
    i--;
  }
  if (i >= 0) {
    const lead = buf[i]!;
    let charLen = 1;
    if ((lead & 0xe0) === 0xc0) charLen = 2;
    else if ((lead & 0xf0) === 0xe0) charLen = 3;
    else if ((lead & 0xf8) === 0xf0) charLen = 4;
    else if ((lead & 0x80) === 0x00) charLen = 1;

    if (i + charLen > end) {
      end = i;
    }
  }
  return buf.subarray(0, end).toString("utf-8");
}

// Quality Evidence
export const QualityEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    evidenceId: QualityEvidenceIdSchema,
    runId: RunIdTransformSchema,
    cycleId: QualityCycleIdSchema,
    gateId: GateIdSchema,
    operationId: z.string().min(1),
    command: z.array(z.string()).readonly(),
    cwd: z.string().min(1),
    timeoutMs: z.number().int().positive(),
    termination: z.enum([
      "exited",
      "signalled",
      "timed-out",
      "aborted",
      "output-limit",
      "spawn-error",
    ]),
    exitCode: z.number().int().nullable(),
    startedAt: z.string().datetime({ offset: true }),
    durationMs: z.number().int().nonnegative(),
    stdoutSummary: z.string(),
    stderrSummary: z.string(),
    stdoutSha256: z.string().regex(/^[0-9a-f]{64}$/),
    stderrSha256: z.string().regex(/^[0-9a-f]{64}$/),
    artifactIds: z.array(ArtifactIdTransformSchema).readonly(),
  })
  .strict();

export type QualityEvidence = z.infer<typeof QualityEvidenceSchema>;

export function validateQualityEvidence(evidence: unknown): {
  readonly valid: boolean;
  readonly evidence?: QualityEvidence;
  readonly error?: string;
} {
  const parseRes = QualityEvidenceSchema.safeParse(evidence);
  if (!parseRes.success) {
    return {
      valid: false,
      error: `QualityEvidence validation failed: ${parseRes.error.message}`,
    };
  }
  return { valid: true, evidence: parseRes.data };
}

export function correlateEvidence(
  evidence: QualityEvidence,
  expected: {
    readonly runId?: RunId;
    readonly cycleId?: QualityCycleId;
    readonly gateId?: GateId;
    readonly operationId?: string;
  }
): { readonly correlated: boolean; readonly reason?: string } {
  if (expected.runId && evidence.runId !== expected.runId) {
    return {
      correlated: false,
      reason: `Run ID mismatch: evidence '${evidence.runId}' !== expected '${expected.runId}'`,
    };
  }
  if (expected.cycleId && evidence.cycleId !== expected.cycleId) {
    return {
      correlated: false,
      reason: `Cycle ID mismatch: evidence '${evidence.cycleId}' !== expected '${expected.cycleId}'`,
    };
  }
  if (expected.gateId && evidence.gateId !== expected.gateId) {
    return {
      correlated: false,
      reason: `Gate ID mismatch: evidence '${evidence.gateId}' !== expected '${expected.gateId}'`,
    };
  }
  if (expected.operationId && evidence.operationId !== expected.operationId) {
    return {
      correlated: false,
      reason: `Operation ID mismatch: evidence '${evidence.operationId}' !== expected '${expected.operationId}'`,
    };
  }
  return { correlated: true };
}

export interface EvidenceIndex {
  readonly byId: ReadonlyMap<QualityEvidenceId, QualityEvidence>;
  readonly all: readonly QualityEvidence[];
}

export type EvidenceCollectionValidationResult =
  | { readonly valid: true; readonly index: EvidenceIndex }
  | {
      readonly valid: false;
      readonly reason: string;
      readonly code:
        | "EVIDENCE_INVALID"
        | "DUPLICATE_EVIDENCE_ID"
        | "CROSS_RUN_EVIDENCE"
        | "CROSS_CYCLE_EVIDENCE";
    };

export function indexAndValidateEvidenceCollection(
  evidence: readonly QualityEvidence[],
  expected: { readonly runId: RunId; readonly cycleId: QualityCycleId }
): EvidenceCollectionValidationResult {
  if (!evidence || !Array.isArray(evidence)) {
    return {
      valid: false,
      reason: "Evidence collection must be an array",
      code: "EVIDENCE_INVALID",
    };
  }

  const byId = new Map<QualityEvidenceId, QualityEvidence>();

  for (const ev of evidence) {
    const parseRes = QualityEvidenceSchema.safeParse(ev);
    if (!parseRes.success) {
      return {
        valid: false,
        reason: `QualityEvidence validation failed: ${parseRes.error.message}`,
        code: "EVIDENCE_INVALID",
      };
    }

    const validEv = parseRes.data;

    if (validEv.runId !== expected.runId) {
      return {
        valid: false,
        reason: `Cross-run evidence detected: evidence runId '${validEv.runId}' !== expected '${expected.runId}'`,
        code: "CROSS_RUN_EVIDENCE",
      };
    }

    if (validEv.cycleId !== expected.cycleId) {
      return {
        valid: false,
        reason: `Cross-cycle evidence detected: evidence cycleId '${validEv.cycleId}' !== expected '${expected.cycleId}'`,
        code: "CROSS_CYCLE_EVIDENCE",
      };
    }

    if (byId.has(validEv.evidenceId)) {
      return {
        valid: false,
        reason: `Duplicate evidence ID '${validEv.evidenceId}' detected in cycle '${expected.cycleId}'`,
        code: "DUPLICATE_EVIDENCE_ID",
      };
    }

    byId.set(validEv.evidenceId, validEv);
  }

  return {
    valid: true,
    index: {
      byId,
      all: evidence,
    },
  };
}

// Requirement Record
export const RequirementRecordSchema = z
  .object({
    requirementId: RequirementIdSchema,
    text: z.string().min(1),
    testStrategy: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("agent") }).strict(),
      z.object({ kind: z.literal("hard"), sourceText: z.string().min(1) }).strict(),
    ]),
  })
  .strict();

export type RequirementRecord = z.infer<typeof RequirementRecordSchema>;

// Requirement Verdict
export const RequirementVerdictSchema = z
  .object({
    requirementId: RequirementIdSchema,
    status: RequirementStatusSchema,
    evidenceIds: z.array(QualityEvidenceIdSchema).readonly(),
    rationale: z.string(),
  })
  .strict();

export type RequirementVerdict = z.infer<typeof RequirementVerdictSchema>;

// Quality Decision
export const QualityDecisionAdvanceSchema = z
  .object({
    kind: z.literal("advance"),
    to: z.enum(["ACCEPT", "DOCUMENT"]),
  })
  .strict();

export const QualityDecisionRepairSchema = z
  .object({
    kind: z.literal("repair"),
    to: z.enum(["FIX", "REWORK"]),
    requirementIds: z.array(RequirementIdSchema).min(1).readonly(),
  })
  .strict();

export const QualityDecisionBlockSchema = z
  .object({
    kind: z.literal("block"),
    reason: z.string().min(1),
    requiredAction: z.string().min(1),
  })
  .strict();

export const QualityDecisionSchema = z.discriminatedUnion("kind", [
  QualityDecisionAdvanceSchema,
  QualityDecisionRepairSchema,
  QualityDecisionBlockSchema,
]);

export type QualityDecision = z.infer<typeof QualityDecisionSchema>;

// Route Intent (Discriminated by kind)
export const RouteIntentAdvanceSchema = z
  .object({
    kind: z.literal("advance"),
    from: z.enum(["VERIFY", "ACCEPT"]),
    to: z.enum(["ACCEPT", "DOCUMENT"]),
    causedByEventId: z.string().min(1).transform(asEventId),
  })
  .strict();

export const RouteIntentRepairSchema = z
  .object({
    kind: z.literal("repair"),
    from: z.enum(["VERIFY", "ACCEPT"]),
    to: z.enum(["FIX", "REWORK"]),
    requirementIds: z.array(RequirementIdSchema).min(1).readonly(),
    attempt: z.number().int().positive(),
    causedByEventId: z.string().min(1).transform(asEventId),
  })
  .strict();

export const RouteIntentBlockSchema = z
  .object({
    kind: z.literal("block"),
    from: z.enum(["VERIFY", "ACCEPT"]),
    reason: z.string().min(1),
    requiredAction: z.string().min(1),
    causedByEventId: z.string().min(1).transform(asEventId),
  })
  .strict();

export const RouteIntentSchema = z.discriminatedUnion("kind", [
  RouteIntentAdvanceSchema,
  RouteIntentRepairSchema,
  RouteIntentBlockSchema,
]);

export type RouteIntent = z.infer<typeof RouteIntentSchema>;

// Repair History Entry
export const RepairOutcomeSchema = z.enum([
  "repaired",
  "failed",
  "exhausted",
  "no_progress",
]);
export type RepairOutcome = z.infer<typeof RepairOutcomeSchema>;

export const RepairHistoryEntrySchema = z
  .object({
    attempt: z.number().int().positive(),
    phase: z.enum(["VERIFY", "ACCEPT"]),
    cycleId: QualityCycleIdSchema,
    requirementIds: z.array(RequirementIdSchema).min(1).readonly(),
    priorVerdicts: z.array(RequirementVerdictSchema).readonly(),
    priorEvidenceIds: z.array(QualityEvidenceIdSchema).readonly(),
    perRequirementAttempts: z.record(z.string(), z.number().int().positive()).readonly(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    outcome: RepairOutcomeSchema,
    timestamp: z.string().datetime({ offset: true }),
  })
  .strict();

export type RepairHistoryEntry = z.infer<typeof RepairHistoryEntrySchema>;
