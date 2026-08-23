import type { RunController } from "../core/controller";
import type { QualityCoordinator } from "../quality/quality-coordinator";
import type { RunId } from "../contracts/ids";
import type { RunState } from "../contracts/run";
import type { EvidenceBundle } from "../quality/evidence-bundle-store";
import type { StepRequest } from "../contracts/adapter";

export interface RunOrchestratorDeps {
  readonly controller: RunController;
  readonly coordinator: QualityCoordinator;
  readonly maxRepairAttempts?: number | undefined;
}

export interface OrchestrationResult {
  readonly finalState: RunState;
  readonly qualityBundles: readonly EvidenceBundle[];
}

export class RunOrchestrator {
  private readonly controller: RunController;
  private readonly coordinator: QualityCoordinator;
  private readonly maxRepairAttempts: number;

  constructor(deps: RunOrchestratorDeps) {
    this.controller = deps.controller;
    this.coordinator = deps.coordinator;
    this.maxRepairAttempts = deps.maxRepairAttempts ?? 2;
  }

  async runUntilTerminal(
    runId: RunId,
    stepSupplier: (state: RunState) => Promise<StepRequest | undefined>,
    signal?: AbortSignal | undefined
  ): Promise<OrchestrationResult> {
    const qualityBundles: EvidenceBundle[] = [];
    let state = await this.controller.getState(runId);
    let repairCount = 0;

    while (
      state.phase !== "READY" &&
      state.phase !== "BLOCKED" &&
      state.phase !== "CANCELLED"
    ) {
      if (signal?.aborted) {
        break;
      }

      if (state.phase === "VERIFY" || state.phase === "ACCEPT") {
        const currentPhase = state.phase;
        const { bundle, decision } = await this.coordinator.runCycle(
          runId,
          currentPhase,
          repairCount,
          this.maxRepairAttempts
        );

        if (bundle) {
          qualityBundles.push(bundle);
        }

        if (decision.kind === "repair") {
          repairCount++;
        }

        state = await this.controller.getState(runId);
      } else {
        // Agent execution step
        const stepReq = await stepSupplier(state);
        if (!stepReq) {
          break;
        }

        state = await this.controller.executeNext(stepReq);
        if (state.phase === "BLOCKED" || state.phase === "CANCELLED") {
          break;
        }
      }
    }

    return {
      finalState: state,
      qualityBundles,
    };
  }
}
