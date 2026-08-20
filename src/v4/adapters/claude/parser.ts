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

export function parseClaudeExecution(input: {
  readonly executionId: string;
  readonly process: ProcessResult;
}): StepResult {
  const { executionId, process } = input;

  if (process.termination === "timed-out") {
    return processFailure({
      executionId,
      hostId: "claude",
      code: "TIMEOUT",
      message: `Claude execution timed out after ${process.durationMs}ms`,
      retryable: true,
    });
  }

  if (process.termination === "aborted") {
    return processFailure({
      executionId,
      hostId: "claude",
      code: "ABORTED",
      message: "Claude execution was aborted",
      retryable: true,
    });
  }

  if (process.termination === "output-limit") {
    return processFailure({
      executionId,
      hostId: "claude",
      code: "OUTPUT_LIMIT",
      message: "Claude exceeded output limit",
      retryable: false,
    });
  }

  if (process.termination === "spawn-error") {
    return processFailure({
      executionId,
      hostId: "claude",
      code: "SPAWN_ERROR",
      message: `Failed to spawn claude: ${process.error.message}`,
      retryable: false,
    });
  }

  if (process.termination !== "exited" || process.exitCode !== 0) {
    return processFailure({
      executionId,
      hostId: "claude",
      code: "CLI_EXIT",
      message: process.stderr.trim() || `Claude exited with code ${process.exitCode}`,
      retryable: true,
    });
  }

  const rawStdout = process.stdout.trim();
  if (!rawStdout) {
    return malformedOutputFailure(executionId, "claude", "Claude output was empty");
  }

  let envelope: any;
  try {
    envelope = JSON.parse(rawStdout);
  } catch (err: any) {
    return malformedOutputFailure(
      executionId,
      "claude",
      `Invalid JSON in Claude envelope: ${err.message}`
    );
  }

  if (envelope.is_error === true || envelope.subtype === "error") {
    return processFailure({
      executionId,
      hostId: "claude",
      code: "CLI_EXIT",
      message: envelope.result || "Claude reported error envelope",
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
        "claude",
        `Could not parse structured JSON from result string: ${err.message}`
      );
    }
  } else if (typeof envelope.result === "object" && envelope.result !== null) {
    rawStructured = envelope.result;
  } else {
    return malformedOutputFailure(
      executionId,
      "claude",
      "Missing structured output in envelope"
    );
  }

  const parsedOutcome = AgentStepOutcomeSchema.safeParse(rawStructured);
  if (!parsedOutcome.success) {
    return malformedOutputFailure(
      executionId,
      "claude",
      `Result schema validation failed: ${parsedOutcome.error.message}`
    );
  }

  const outcome = parsedOutcome.data;
  if (outcome.executionId !== executionId) {
    return malformedOutputFailure(
      executionId,
      "claude",
      `ExecutionId mismatch: expected '${executionId}', got '${outcome.executionId}'`
    );
  }

  const sessionId =
    typeof envelope.session_id === "string" ? envelope.session_id : undefined;

  let usage: NormalizedUsage | undefined;
  if (typeof envelope.total_cost_usd === "number") {
    usage = {
      costUsd: envelope.total_cost_usd,
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
