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

    case "artifact.recorded":
    case "policy.decided": {
      // These events do not change phase, inFlight, or failure counters directly
      break;
    }

    case "step.succeeded": {
      nextInFlight = undefined;
      nextSameFailureCount = 0;
      nextLastFailureSignature = undefined;
      break;
    }

    case "step.failed": {
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
    lastFailureSignature?: string;
    inFlight?: typeof nextInFlight;
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
