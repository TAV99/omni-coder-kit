import type { Capability, RunState } from "./run";
import type { StepResult } from "./step-result";

export interface SafetyPolicy {
  evaluateCapability(capability: Capability, state: RunState): boolean;
  evaluateStep(result: StepResult, state: RunState): boolean;
}
