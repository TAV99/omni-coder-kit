export const QUALITY_ERROR_CODES = [
  // P2 codes
  "QUALITY_CONFIG_MISSING",
  "QUALITY_CONFIG_INVALID",
  "REQUIREMENTS_MISSING",
  "REQUIREMENTS_INVALID",
  "GATE_TIMEOUT",
  "GATE_ABORTED",
  "GATE_OUTPUT_LIMIT",
  "GATE_EXIT_NONZERO",
  "GATE_EVIDENCE_INVALID",
  "AGENT_JUDGE_UNAVAILABLE",
  "AGENT_JUDGE_MALFORMED",
  "MANDATORY_GATE_SKIPPED",
  "MANDATORY_GATE_INCONCLUSIVE",
  "REPAIR_NO_PROGRESS",
  "REPAIR_BUDGET_EXHAUSTED",
  "QUALITY_RECOVERY_UNSAFE",
  // P3 codes
  "GATE_DEPENDENCY_INVALID",
  "GATE_DEPENDENCY_CYCLE",
  "BUDGET_METRIC_MISSING",
  "BUDGET_EXCEEDED",
  "BENCHMARK_MANIFEST_INVALID",
  "BENCHMARK_EXPECTATION_MISMATCH",
  "BENCHMARK_WORKSPACE_UNSAFE",
  "LIVE_BENCHMARK_NOT_APPROVED",
] as const;

export type QualityErrorCode = (typeof QUALITY_ERROR_CODES)[number];

export class QualityError extends Error {
  readonly code: QualityErrorCode;
  readonly details?: unknown | undefined;

  constructor(code: QualityErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "QualityError";
    this.code = code;
    this.details = details;
  }
}
