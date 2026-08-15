import type { AgentAdapter } from "../contracts/adapter";
import type { RunState } from "../contracts/run";
import type { StepResult } from "../contracts/step-result";

export class FakeAdapter implements AgentAdapter {
  private readonly queue: StepResult[];

  constructor(responses: StepResult[]) {
    this.queue = [...responses];
  }

  async executeStep(state: RunState): Promise<StepResult> {
    if (this.queue.length === 0) {
      throw new Error("FakeAdapter queue is empty");
    }
    
    // Shift the first item from the queue
    return this.queue.shift()!;
  }
}
