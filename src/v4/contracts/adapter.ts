import type { StepResult } from "./step-result";
import type { RunState } from "./run";

export interface AgentAdapter {
  executeStep(state: RunState): Promise<StepResult>;
}
