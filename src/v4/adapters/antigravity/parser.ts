import type { ProcessResult } from "../../process/types";
import {
  AgentStepOutcomeSchema,
  type NativeExecutionMetadata,
  type NormalizedUsage,
  type StepResult,
} from "../../contracts/step-result";
import {
  malformedOutputFailure,
  processFailure,
} from "../shared/adapter-failure";

export function parseAntigravityExecution(input: {
  readonly executionId: string;
  readonly process: ProcessResult;
}): StepResult {
  const { executionId, process } = input;

  if (process.termination === "timed-out") {
    return processFailure({
      executionId,
      hostId: "antigravity",
      code: "TIMEOUT",
      message: `Antigravity execution timed out after ${process.durationMs}ms`,
      retryable: true,
    });
  }

  if (process.termination === "aborted") {
    return processFailure({
      executionId,
      hostId: "antigravity",
      code: "ABORTED",
      message: "Antigravity execution was aborted",
      retryable: true,
    });
  }

  if (process.termination === "output-limit") {
    return processFailure({
      executionId,
      hostId: "antigravity",
      code: "OUTPUT_LIMIT",
      message: "Antigravity exceeded output limit",
      retryable: false,
    });
  }

  if (process.termination === "spawn-error") {
    return processFailure({
      executionId,
      hostId: "antigravity",
      code: "SPAWN_ERROR",
      message: `Failed to spawn agy: ${process.error.message}`,
      retryable: false,
    });
  }

  if (process.termination !== "exited" || process.exitCode !== 0) {
    return processFailure({
      executionId,
      hostId: "antigravity",
      code: "CLI_EXIT",
      message: process.stderr.trim() || `Antigravity exited with code ${process.exitCode}`,
      retryable: true,
    });
  }

  const rawStdout = process.stdout.trim();
  if (!rawStdout) {
    return malformedOutputFailure(executionId, "antigravity", "Antigravity output was empty");
  }

  let envelope: any;
  try {
    envelope = JSON.parse(rawStdout);
  } catch (err: any) {
    return malformedOutputFailure(
      executionId,
      "antigravity",
      `Invalid JSON in Antigravity output: ${err.message}`
    );
  }

  if (envelope.status === "error" || envelope.is_error === true) {
    const errorMsg =
      envelope.error?.message || envelope.message || "Antigravity error envelope";
    return processFailure({
      executionId,
      hostId: "antigravity",
      code: "CLI_EXIT",
      message: errorMsg,
      retryable: true,
    });
  }

  let rawStructured: unknown;
  if (envelope.structured_output !== undefined) {
    rawStructured = envelope.structured_output;
  } else if (typeof envelope.result === "string") {
    try {
      rawStructured = JSON.parse(envelope.result);
    } catch (err: any) {
      return malformedOutputFailure(
        executionId,
        "antigravity",
        `Could not parse JSON result string: ${err.message}`
      );
    }
  } else if (typeof envelope.result === "object" && envelope.result !== null) {
    rawStructured = envelope.result;
  } else if (envelope.status === "succeeded" || envelope.status === "failed") {
    rawStructured = envelope;
  } else {
    return malformedOutputFailure(
      executionId,
      "antigravity",
      "Missing structured output in envelope"
    );
  }

  const parsedOutcome = AgentStepOutcomeSchema.safeParse(rawStructured);
  if (!parsedOutcome.success) {
    return malformedOutputFailure(
      executionId,
      "antigravity",
      `Result schema validation failed: ${parsedOutcome.error.message}`
    );
  }

  const outcome = parsedOutcome.data;
  if (outcome.executionId !== executionId) {
    return malformedOutputFailure(
      executionId,
      "antigravity",
      `ExecutionId mismatch: expected '${executionId}', got '${outcome.executionId}'`
    );
  }

  const sessionId =
    typeof envelope.session_id === "string"
      ? envelope.session_id
      : typeof envelope.conversation_id === "string"
      ? envelope.conversation_id
      : undefined;

  let usage: NormalizedUsage | undefined;
  if (envelope.usage) {
    usage = {
      inputTokens: envelope.usage.input_tokens,
      outputTokens: envelope.usage.output_tokens,
      cachedInputTokens: envelope.usage.cached_input_tokens,
      totalTokens: envelope.usage.total_tokens,
      costUsd: envelope.usage.cost_usd,
    };
  }

  const native: NativeExecutionMetadata | undefined =
    sessionId !== undefined || usage !== undefined
      ? {
          sessionId,
          usage,
        }
      : undefined;

  if (native !== undefined) {
    return {
      ...outcome,
      native,
    } as StepResult;
  }

  return outcome as StepResult;
}
