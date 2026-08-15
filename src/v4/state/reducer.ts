import type { RunState } from "../contracts/run";
import type { RunEvent } from "../contracts/events";
import { getNextPhase } from "./transitions";

export function reduce(state: RunState | null, event: RunEvent): RunState {
  if (state === null) {
    if (event.type !== "RunStarted") {
      throw new Error("Initial event must be RunStarted");
    }
    if (event.sequence !== 0) {
      throw new Error(`Sequence gap: expected 0, got ${event.sequence}`);
    }
    
    return {
      schemaVersion: 1,
      runId: event.runId,
      phase: event.initialPhase,
      sequence: 0,
      attempt: 1,
      sameFailureCount: 0,
      startedAt: event.timestamp,
      updatedAt: event.timestamp,
    };
  }

  if (event.sequence !== state.sequence + 1) {
    throw new Error(`Sequence gap: expected ${state.sequence + 1}, got ${event.sequence}`);
  }

  const nextPhase = getNextPhase(state.phase, event);
  
  let inFlight = state.inFlight;
  let attempt = state.attempt;
  let sameFailureCount = state.sameFailureCount;
  let lastFailureSignature = state.lastFailureSignature;

  if (event.type === "StepStarted") {
    if (inFlight) {
      throw new Error(`Cannot start step ${event.stepId} when step ${inFlight.stepId} is in flight`);
    }
    inFlight = {
      stepId: event.stepId,
      operationId: "default",
      sideEffect: "external",
    };
  }

  if (event.type === "StepCompleted") {
    if (!inFlight || inFlight.stepId !== event.stepId) {
      throw new Error(`Cannot complete step ${event.stepId} which is not in flight`);
    }
    inFlight = undefined;

    if (event.result.status === "failed") {
      if (lastFailureSignature === event.result.failure.signature) {
        sameFailureCount++;
      } else {
        lastFailureSignature = event.result.failure.signature;
        sameFailureCount = 1;
      }
      attempt++;
    } else {
      // On success, reset the failure trackers
      sameFailureCount = 0;
      lastFailureSignature = undefined;
      attempt = 1;
    }
  }

  const newState: any = {
    ...state,
    phase: nextPhase,
    sequence: event.sequence,
    updatedAt: event.timestamp,
    attempt,
    sameFailureCount,
  };

  if (inFlight !== undefined) {
    newState.inFlight = inFlight;
  } else {
    delete newState.inFlight;
  }

  if (lastFailureSignature !== undefined) {
    newState.lastFailureSignature = lastFailureSignature;
  } else {
    delete newState.lastFailureSignature;
  }

  return newState as RunState;
}
