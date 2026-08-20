import type { RunEvent } from "../contracts/event";
import type { RunId } from "../contracts/ids";
import type { RunState } from "../contracts/run";
import { isAllowedTransition, TransitionError } from "./transitions";

export class EventSequenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventSequenceError";
  }
}

export class InvalidStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateError";
  }
}

export function createInitialState(input: {
  readonly runId: RunId;
  readonly startedAt: string;
}): RunState {
  return {
    schemaVersion: 1,
    runId: input.runId,
    phase: "INTAKE",
    sequence: 0,
    attempt: 1,
    sameFailureCount: 0,
    startedAt: input.startedAt,
    updatedAt: input.startedAt,
  };
}

export function reduceEvent(state: RunState, event: RunEvent): RunState {
  if (event.runId !== state.runId) {
    throw new InvalidStateError(
      `Event runId mismatch: expected '${state.runId}', got '${event.runId}'`
    );
  }

  if (event.sequence !== state.sequence + 1) {
    throw new EventSequenceError(
      `Event sequence mismatch: expected ${state.sequence + 1}, got ${event.sequence}`
    );
  }

  if (state.phase === "READY") {
    throw new InvalidStateError("Cannot apply event to a run that is already in READY terminal phase");
  }

  let nextPhase: import("../contracts/run").RunPhase = state.phase;
  let nextAttempt = state.attempt;
  let nextSameFailureCount = state.sameFailureCount;
  let nextLastFailureSignature = state.lastFailureSignature;
  let nextInFlight = state.inFlight;

  switch (event.type) {
    case "run.created": {
      throw new InvalidStateError("run.created can only be sequence 0 (initial event)");
    }

    case "step.started": {
      if (event.payload.phase !== state.phase) {
        throw new InvalidStateError(
          `step.started phase mismatch: expected '${state.phase}', got '${event.payload.phase}'`
        );
      }
      if (state.inFlight) {
        throw new InvalidStateError(
          `Cannot start step '${event.payload.stepId}'; step '${state.inFlight.stepId}' is already in flight`
        );
      }
      nextInFlight = {
        stepId: event.payload.stepId,
        operationId: event.payload.operationId,
        sideEffect: event.payload.sideEffect,
      };
      break;
    }

    case "artifact.recorded": {
      if (event.payload.record.runId !== state.runId) {
        throw new InvalidStateError(
          `artifact.recorded runId mismatch: expected '${state.runId}', got '${event.payload.record.runId}'`
        );
      }
      if (!state.inFlight || event.payload.record.producerStepId !== state.inFlight.stepId) {
        throw new InvalidStateError(
          `artifact.recorded producerStepId '${event.payload.record.producerStepId}' does not match in-flight step '${state.inFlight?.stepId}'`
        );
      }
      break;
    }

    case "policy.decided": {
      // Policy decision does not change phase or attempt counters directly
      break;
    }

    case "step.succeeded": {
      if (!state.inFlight) {
        throw new InvalidStateError("step.succeeded received with no step in flight");
      }
      if (event.payload.stepId !== state.inFlight.stepId) {
        throw new InvalidStateError(
          `step.succeeded stepId '${event.payload.stepId}' does not match in-flight step '${state.inFlight.stepId}'`
        );
      }
      if (event.payload.result.executionId !== state.inFlight.operationId) {
        throw new InvalidStateError(
          `step.succeeded executionId '${event.payload.result.executionId}' does not match in-flight operation '${state.inFlight.operationId}'`
        );
      }
      nextInFlight = undefined;
      nextSameFailureCount = 0;
      nextLastFailureSignature = undefined;
      break;
    }

    case "step.failed": {
      if (!state.inFlight) {
        throw new InvalidStateError("step.failed received with no step in flight");
      }
      if (event.payload.stepId !== state.inFlight.stepId) {
        throw new InvalidStateError(
          `step.failed stepId '${event.payload.stepId}' does not match in-flight step '${state.inFlight.stepId}'`
        );
      }
      if (event.payload.result.executionId !== state.inFlight.operationId) {
        throw new InvalidStateError(
          `step.failed executionId '${event.payload.result.executionId}' does not match in-flight operation '${state.inFlight.operationId}'`
        );
      }
      nextInFlight = undefined;
      const signature = event.payload.result.failure.signature;
      if (state.lastFailureSignature === signature) {
        nextSameFailureCount = state.sameFailureCount + 1;
      } else {
        nextSameFailureCount = 1;
        nextLastFailureSignature = signature;
      }
      nextAttempt = state.attempt + 1;
      break;
    }

    case "step.blocked":
    case "step.cancelled":
    case "step.interrupted": {
      if (!state.inFlight) {
        throw new InvalidStateError(`${event.type} received with no step in flight`);
      }
      if (event.payload.stepId !== state.inFlight.stepId) {
        throw new InvalidStateError(
          `${event.type} stepId '${event.payload.stepId}' does not match in-flight step '${state.inFlight.stepId}'`
        );
      }
      if (event.payload.operationId !== state.inFlight.operationId) {
        throw new InvalidStateError(
          `${event.type} operationId '${event.payload.operationId}' does not match in-flight operation '${state.inFlight.operationId}'`
        );
      }
      nextInFlight = undefined;
      break;
    }

    case "run.transitioned": {
      if (event.payload.from !== state.phase) {
        throw new TransitionError(
          `Cannot transition from '${event.payload.from}' because current phase is '${state.phase}'`
        );
      }
      if (!isAllowedTransition(event.payload.from, event.payload.to)) {
        throw new TransitionError(
          `Forbidden phase transition: '${event.payload.from}' -> '${event.payload.to}'`
        );
      }
      nextPhase = event.payload.to;
      nextAttempt = 1;
      nextSameFailureCount = 0;
      nextLastFailureSignature = undefined;
      break;
    }

    case "run.blocked": {
      if (state.phase === "CANCELLED" || state.phase === "BLOCKED") {
        throw new InvalidStateError(`Cannot block a run in terminal phase: ${state.phase}`);
      }
      nextPhase = "BLOCKED";
      nextInFlight = undefined;
      break;
    }

    case "run.cancelled": {
      if (state.phase === "CANCELLED" || state.phase === "BLOCKED") {
        throw new InvalidStateError(`Cannot cancel a run in terminal phase: ${state.phase}`);
      }
      nextPhase = "CANCELLED";
      nextInFlight = undefined;
      break;
    }
  }

  const newState: {
    schemaVersion: 1;
    runId: RunId;
    phase: typeof nextPhase;
    sequence: number;
    attempt: number;
    sameFailureCount: number;
    lastFailureSignature?: string | undefined;
    inFlight?: typeof nextInFlight | undefined;
    startedAt: string;
    updatedAt: string;
  } = {
    schemaVersion: 1,
    runId: state.runId,
    phase: nextPhase,
    sequence: event.sequence,
    attempt: nextAttempt,
    sameFailureCount: nextSameFailureCount,
    startedAt: state.startedAt,
    updatedAt: event.at,
  };

  if (nextLastFailureSignature !== undefined) {
    newState.lastFailureSignature = nextLastFailureSignature;
  }
  if (nextInFlight !== undefined) {
    newState.inFlight = nextInFlight;
  }

  return newState;
}
