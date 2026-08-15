import type { RunPhase } from "../contracts/run";
import type { RunEvent } from "../contracts/events";

export function getNextPhase(currentPhase: RunPhase | null, event: RunEvent): RunPhase {
  if (event.type === "RunStarted") {
    if (currentPhase !== null) {
      throw new Error("RunStarted event can only occur when state is null");
    }
    return event.initialPhase;
  }

  if (currentPhase === null) {
    throw new Error(`Event ${event.type} cannot occur when state is null`);
  }

  if (currentPhase === "BLOCKED" || currentPhase === "CANCELLED" || currentPhase === "READY") {
    throw new Error(`Event ${event.type} cannot occur in terminal phase ${currentPhase}`);
  }

  switch (event.type) {
    case "RunPhaseChanged":
      return event.phase;

    case "RunFailed":
      return "BLOCKED";

    case "RunSucceeded":
      return "READY";

    case "StepStarted":
    case "StepCompleted":
    case "CapabilityRequested":
      return currentPhase;

    default:
      throw new Error(`Unknown event type`);
  }
}
