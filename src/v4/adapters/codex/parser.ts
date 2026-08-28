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

export interface CodexParserInput {
  readonly executionId: string;
  readonly process: ProcessResult;
  readonly resultText?: string | undefined;
}

export function parseCodexExecution(input: {
  readonly executionId: string;
  readonly process: ProcessResult;
  readonly resultText?: string | undefined;
}): StepResult {
  const { executionId, process } = input;

  if (process.termination === "timed-out") {
    return processFailure({
      executionId,
      hostId: "codex",
      code: "TIMEOUT",
      message: `Codex execution timed out after ${process.durationMs}ms`,
      retryable: true,
    });
  }

  if (process.termination === "aborted") {
    return processFailure({
      executionId,
      hostId: "codex",
      code: "ABORTED",
      message: "Codex execution was aborted",
      retryable: true,
    });
  }

  if (process.termination === "output-limit") {
    return processFailure({
      executionId,
      hostId: "codex",
      code: "OUTPUT_LIMIT",
      message: "Codex exceeded output byte limit",
      retryable: false,
    });
  }

  if (process.termination === "spawn-error") {
    return processFailure({
      executionId,
      hostId: "codex",
      code: "SPAWN_ERROR",
      message: `Failed to spawn codex: ${process.error.message}`,
      retryable: false,
    });
  }

  if (process.termination !== "exited" || process.exitCode !== 0) {
    return processFailure({
      executionId,
      hostId: "codex",
      code: "CLI_EXIT",
      message: process.stderr.trim() || `Codex exited with code ${process.exitCode}`,
      retryable: true,
    });
  }

  if (!input.resultText || input.resultText.trim().length === 0) {
    return malformedOutputFailure(
      executionId,
      "codex",
      "Result file was missing or empty"
    );
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(input.resultText.trim());
  } catch (err: any) {
    return malformedOutputFailure(
      executionId,
      "codex",
      `Invalid JSON in result file: ${err.message}`
    );
  }

  let rawOutcome = rawJson;
  if (
    typeof rawJson === "object" &&
    rawJson !== null &&
    Object.prototype.hasOwnProperty.call(rawJson, "outcome")
  ) {
    const keys = Object.keys(rawJson);
    if (keys.length !== 1) {
      return malformedOutputFailure(
        executionId,
        "codex",
        "Structured output envelope contains unexpected fields"
      );
    }
    rawOutcome = (rawJson as { outcome: unknown }).outcome;
  }

  const parsedOutcome = AgentStepOutcomeSchema.safeParse(rawOutcome);
  if (!parsedOutcome.success) {
    return malformedOutputFailure(
      executionId,
      "codex",
      `Result schema validation failed: ${parsedOutcome.error.message}`
    );
  }

  const outcome = parsedOutcome.data;
  if (outcome.executionId !== executionId) {
    return malformedOutputFailure(
      executionId,
      "codex",
      `ExecutionId mismatch: expected '${executionId}', got '${outcome.executionId}'`
    );
  }

  // Parse JSONL from stdout for native session ID and usage with strict validation
  let sessionId: string | undefined;
  let usage: NormalizedUsage | undefined;
  let hasTurnCompleted = false;

  const lines = process.stdout.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return malformedOutputFailure(
        executionId,
        "codex",
        `Malformed JSON line in Codex JSONL output: ${trimmed}`
      );
    }

    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      sessionId = event.thread_id;
    }

    if (event.type === "turn.completed") {
      hasTurnCompleted = true;
      if (event.usage && typeof event.usage === "object") {
        usage = {
          inputTokens:
            typeof event.usage.input_tokens === "number" && event.usage.input_tokens >= 0
              ? event.usage.input_tokens
              : undefined,
          outputTokens:
            typeof event.usage.output_tokens === "number" && event.usage.output_tokens >= 0
              ? event.usage.output_tokens
              : undefined,
          cachedInputTokens:
            typeof event.usage.cached_input_tokens === "number" &&
            event.usage.cached_input_tokens >= 0
              ? event.usage.cached_input_tokens
              : undefined,
          totalTokens:
            typeof event.usage.total_tokens === "number" && event.usage.total_tokens >= 0
              ? event.usage.total_tokens
              : undefined,
          costUsd:
            typeof event.usage.cost_usd === "number" && event.usage.cost_usd >= 0
              ? event.usage.cost_usd
              : undefined,
        };
      }
    }
  }

  if (!hasTurnCompleted && process.stdout.trim().length > 0) {
    return malformedOutputFailure(
      executionId,
      "codex",
      "Missing turn.completed event in Codex JSONL stream"
    );
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
