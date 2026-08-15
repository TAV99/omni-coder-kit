import crypto from "node:crypto";
import type { AgentAdapter } from "../contracts/adapter";
import type { SafetyPolicy } from "../contracts/policy";
import type { EventStorage } from "../storage/events";
import type { ArtifactStorage } from "../storage/artifacts";
import { asEventId, asStepId, type RunId } from "../contracts/ids";
import type { RunState } from "../contracts/run";
import type { RunEvent } from "../contracts/events";
import type { StepResult } from "../contracts/step-result";
import type { ArtifactClaim } from "../contracts/artifact";

export class RunController {
  constructor(
    public readonly runId: RunId,
    private readonly adapter: AgentAdapter,
    private readonly policy: SafetyPolicy,
    private readonly eventStorage: EventStorage,
    private readonly artifactStorage: ArtifactStorage
  ) {}

  async advance(): Promise<RunState> {
    let state = await this.eventStorage.replay();
    
    if (!state) {
      throw new Error("Run state is null, cannot advance before RunStarted");
    }

    if (state.inFlight) {
      const stepCompletedEvent: RunEvent = {
        type: "StepCompleted",
        eventId: asEventId(crypto.randomUUID()),
        runId: this.runId,
        sequence: state.sequence + 1,
        timestamp: new Date().toISOString(),
        stepId: state.inFlight.stepId,
        result: {
          status: "failed",
          executionId: crypto.randomUUID(),
          failure: {
            code: "PROCESS_CRASH",
            message: "Process crashed while step was in flight",
            retryable: true,
            signature: "process_crash"
          }
        }
      };
      await this.eventStorage.append(stepCompletedEvent);
      return this.advance();
    }

    if (state.phase === "READY" || state.phase === "BLOCKED" || state.phase === "CANCELLED") {
      throw new Error(`Cannot advance run in terminal phase: ${state.phase}`);
    }

    const stepId = asStepId(crypto.randomUUID());
    const stepStartedEvent: RunEvent = {
      type: "StepStarted",
      eventId: asEventId(crypto.randomUUID()),
      runId: this.runId,
      sequence: state.sequence + 1,
      timestamp: new Date().toISOString(),
      stepId,
    };

    await this.eventStorage.append(stepStartedEvent);

    // Replay to get the new state with inFlight step
    state = await this.eventStorage.replay();
    if (!state) throw new Error("State is null after StepStarted");

    let result: StepResult;
    try {
      result = await this.adapter.executeStep(state);
    } catch (err: any) {
      result = {
        status: "failed",
        executionId: crypto.randomUUID(),
        failure: {
          code: "ADAPTER_ERROR",
          message: err?.message || "Unknown adapter error",
          retryable: false,
          signature: "adapter_uncaught"
        }
      };
    }

    const policyPassed = this.policy.evaluateStep(result, state);
    if (!policyPassed) {
      result = {
        status: "failed",
        executionId: result.executionId || crypto.randomUUID(),
        failure: {
          code: "POLICY_VIOLATION",
          message: "Step result violated safety policy",
          retryable: false,
          signature: "policy_violation"
        }
      };
    }

    // Process artifacts
    if (result.status === "succeeded") {
      for (const claim of result.artifacts) {
        // Absolute paths would typically be passed from the adapter, but here we only have the claim.
        // Assuming the artifact is written to the workspace, we resolve it relative to the runDirectory or a workspace dir.
        // For now, we assume it's relative to the run directory as we didn't define a separate workspace directory in this P0.
        const absolutePath = require("node:path").join(this.artifactStorage.runDirectory, claim.relativePath);
        await this.artifactStorage.store(claim, absolutePath, this.runId, stepId);
      }
    }

    const stepCompletedEvent: RunEvent = {
      type: "StepCompleted",
      eventId: asEventId(crypto.randomUUID()),
      runId: this.runId,
      sequence: state.sequence + 1,
      timestamp: new Date().toISOString(),
      stepId,
      result,
    };

    await this.eventStorage.append(stepCompletedEvent);
    
    // Check if the run failed due to this step. 
    // The Reducer updates state.attempt, but does not transition the phase to BLOCKED by itself on StepCompleted (unless we map it, but we map RunFailed).
    // Let's replay and return the new state.
    state = await this.eventStorage.replay();
    
    // If the step failed and hit limits, we should emit RunFailed. For now P0 asks to just implement advance().
    
    return state!;
  }
}
