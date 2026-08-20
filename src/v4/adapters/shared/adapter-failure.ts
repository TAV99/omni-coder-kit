import type { StepResult } from "../../contracts/step-result";

export function processFailure(input: {
  readonly executionId: string;
  readonly hostId: string;
  readonly code:
    | "BINARY_MISSING"
    | "SPAWN_ERROR"
    | "CLI_EXIT"
    | "SIGNAL"
    | "TIMEOUT"
    | "ABORTED"
    | "OUTPUT_LIMIT";
  readonly message: string;
  readonly retryable: boolean;
}): StepResult {
  const signature = `${input.hostId}:${input.code.toLowerCase()}`;
  return {
    status: "failed",
    executionId: input.executionId,
    failure: {
      code: `${input.hostId.toUpperCase()}_${input.code}`,
      message: input.message,
      retryable: input.retryable,
      signature,
    },
  };
}

export function malformedOutputFailure(
  executionId: string,
  hostId: string,
  detail: string
): StepResult {
  const signature = `${hostId}:malformed_output`;
  return {
    status: "failed",
    executionId,
    failure: {
      code: `${hostId.toUpperCase()}_MALFORMED_OUTPUT`,
      message: `Failed to parse host structured output: ${detail}`,
      retryable: false,
      signature,
    },
  };
}
