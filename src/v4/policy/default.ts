import type { SafetyPolicy } from "../contracts/policy";
import type { Capability, RunState } from "../contracts/run";
import type { StepResult } from "../contracts/step-result";

export const DefaultSafetyPolicy: SafetyPolicy = {
  evaluateCapability(capability: Capability, state: RunState): boolean {
    return capability === "workspace.read" || capability === "structured-output";
  },

  evaluateStep(result: StepResult, state: RunState): boolean {
    if (result.status === "succeeded") {
      return result.artifacts.length > 0;
    }
    return false;
  }
};
