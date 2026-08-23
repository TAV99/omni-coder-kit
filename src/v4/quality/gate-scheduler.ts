import type {
  GateDefinition,
  GateId,
  GateResult,
  QualityEvidence,
  QualityCycleId,
} from "../contracts/quality";
import type { RunId } from "../contracts/ids";
import { asQualityEvidenceId } from "../contracts/quality";
import { QualityError } from "./errors";
import type { GateRunner } from "./gate-runner";
import type { ProcessRunner } from "../process/types";

export interface GateSchedulerOptions {
  readonly maxParallelGates: number; // default 2, valid 1..8
}

export interface GateScheduleResult {
  readonly results: ReadonlyMap<GateId, GateResult>;
  readonly evidences: ReadonlyMap<GateId, QualityEvidence>;
  readonly peakParallelism: number;
  readonly totalQueueMs: number;
}

export function validateGateDag(gates: readonly GateDefinition[]): void {
  const gateMap = new Map<GateId, GateDefinition>();

  for (const gate of gates) {
    if (gateMap.has(gate.id)) {
      throw new QualityError(
        "GATE_DEPENDENCY_INVALID",
        `Duplicate gate ID '${gate.id}' in DAG`
      );
    }
    gateMap.set(gate.id, gate);

    if (gate.concurrencyKey !== undefined && gate.concurrencyKey.trim().length === 0) {
      throw new QualityError(
        "GATE_DEPENDENCY_INVALID",
        `Gate '${gate.id}' has invalid empty concurrencyKey`
      );
    }

    const seenDeps = new Set<GateId>();
    for (const dep of gate.dependsOn) {
      if (dep === gate.id) {
        throw new QualityError(
          "GATE_DEPENDENCY_INVALID",
          `Gate '${gate.id}' cannot depend on itself`
        );
      }
      if (seenDeps.has(dep)) {
        throw new QualityError(
          "GATE_DEPENDENCY_INVALID",
          `Gate '${gate.id}' has duplicate dependency on '${dep}'`
        );
      }
      seenDeps.add(dep);
    }
  }

  for (const gate of gates) {
    for (const dep of gate.dependsOn) {
      if (!gateMap.has(dep)) {
        throw new QualityError(
          "GATE_DEPENDENCY_INVALID",
          `Gate '${gate.id}' depends on missing gate '${dep}'`
        );
      }
    }
  }

  const state = new Map<GateId, number>();

  function dfs(currentId: GateId, path: GateId[]): void {
    state.set(currentId, 1);
    const gate = gateMap.get(currentId)!;

    for (const dep of gate.dependsOn) {
      const depState = state.get(dep) ?? 0;
      if (depState === 1) {
        throw new QualityError(
          "GATE_DEPENDENCY_CYCLE",
          `Dependency cycle detected: ${[...path, currentId, dep].join(" -> ")}`
        );
      }
      if (depState === 0) {
        dfs(dep, [...path, currentId]);
      }
    }

    state.set(currentId, 2);
  }

  for (const gate of gates) {
    if ((state.get(gate.id) ?? 0) === 0) {
      dfs(gate.id, []);
    }
  }
}

export class GateScheduler {
  private readonly options: GateSchedulerOptions;

  constructor(options?: Partial<GateSchedulerOptions>) {
    const max = options?.maxParallelGates ?? 2;
    if (!Number.isInteger(max) || max < 1 || max > 8) {
      throw new QualityError(
        "QUALITY_CONFIG_INVALID",
        `maxParallelGates must be an integer between 1 and 8, received ${max}`
      );
    }
    this.options = { maxParallelGates: max };
  }

  async schedule(
    gates: readonly GateDefinition[],
    deps: {
      readonly runId: RunId;
      readonly cycleId: QualityCycleId;
      readonly projectRoot: string;
      readonly runner: ProcessRunner;
      readonly gateRunner: GateRunner;
      readonly signal?: AbortSignal | undefined;
      readonly now?: (() => string) | undefined;
      readonly onGateStarted?: ((gate: GateDefinition, operationId: string) => Promise<void>) | undefined;
      readonly onGateCompleted?: ((result: GateResult, evidence?: QualityEvidence) => Promise<void>) | undefined;
    }
  ): Promise<GateScheduleResult> {
    validateGateDag(gates);

    const results = new Map<GateId, GateResult>();
    const evidences = new Map<GateId, QualityEvidence>();
    const gateStatusMap = new Map<GateId, GateResult["status"]>();

    let peakParallelism = 0;
    let totalQueueMs = 0;
    let activeParallelCount = 0;
    let opSeq = 0;

    let workspaceWriteLocked = false;
    const activeConcurrencyKeys = new Set<string>();
    const activePromises = new Set<Promise<void>>();

    const remaining = new Map<GateId, GateDefinition>();
    for (const g of gates) {
      remaining.set(g.id, g);
    }

    const enqueuedAt = new Map<GateId, number>();
    const startTime = Date.now();
    for (const g of gates) {
      enqueuedAt.set(g.id, startTime);
    }

    let callbackError: unknown | undefined;

    while (remaining.size > 0 || activePromises.size > 0) {
      if (callbackError !== undefined) {
        // Callback persistence error occurred: do not launch any further queued/remaining gates
        break;
      }

      if (deps.signal?.aborted) {
        for (const [id, gate] of remaining) {
          const opId = `${deps.cycleId}-${id}-${++opSeq}`;
          const startedAt = deps.now ? deps.now() : new Date().toISOString();
          const skippedResult: GateResult = gate.mandatory
            ? {
                schemaVersion: 1,
                cycleId: deps.cycleId,
                gateId: id,
                operationId: opId,
                status: "inconclusive",
                startedAt,
                durationMs: 0,
                mandatory: gate.mandatory,
                failureSignature: "cycle_aborted",
                reason: "Quality cycle was aborted",
              }
            : {
                schemaVersion: 1,
                cycleId: deps.cycleId,
                gateId: id,
                operationId: opId,
                status: "skipped",
                startedAt,
                durationMs: 0,
                mandatory: gate.mandatory,
                reason: "Quality cycle was aborted",
              };
          results.set(id, skippedResult);
          gateStatusMap.set(id, skippedResult.status);
          if (deps.onGateCompleted) {
            try {
              await deps.onGateCompleted(skippedResult);
            } catch (err: unknown) {
              if (!callbackError) {
                callbackError = err;
              }
            }
          }
          remaining.delete(id);
        }
        break;
      }

      // Check remaining gates for failed dependencies
      const toSkip: GateDefinition[] = [];
      for (const [id, gate] of remaining) {
        let hasFailedDep = false;

        for (const depId of gate.dependsOn) {
          const status = gateStatusMap.get(depId);
          if (status !== undefined && status !== "passed") {
            hasFailedDep = true;
            break;
          }
        }

        if (hasFailedDep) {
          toSkip.push(gate);
          remaining.delete(id);
        }
      }

      for (const gate of toSkip) {
        const opId = `${deps.cycleId}-${gate.id}-${++opSeq}`;
        const startedAt = deps.now ? deps.now() : new Date().toISOString();
        const skippedResult: GateResult = gate.mandatory
          ? {
              schemaVersion: 1,
              cycleId: deps.cycleId,
              gateId: gate.id,
              operationId: opId,
              status: "inconclusive",
              startedAt,
              durationMs: 0,
              mandatory: gate.mandatory,
              failureSignature: "dependency_failed",
              reason: `Dependency gate '${gate.dependsOn.join(", ")}' did not pass`,
            }
          : {
              schemaVersion: 1,
              cycleId: deps.cycleId,
              gateId: gate.id,
              operationId: opId,
              status: "skipped",
              startedAt,
              durationMs: 0,
              mandatory: gate.mandatory,
              reason: `Dependency gate '${gate.dependsOn.join(", ")}' did not pass`,
            };
        results.set(gate.id, skippedResult);
        gateStatusMap.set(gate.id, skippedResult.status);
        if (deps.onGateCompleted) {
          try {
            await deps.onGateCompleted(skippedResult);
          } catch (err: unknown) {
            if (!callbackError) {
              callbackError = err;
            }
          }
        }
      }

      if (callbackError !== undefined) {
        break;
      }

      // Select eligible gates to launch in this round
      const toLaunch: GateDefinition[] = [];
      let roundWorkspaceLocked = workspaceWriteLocked;
      const roundConcurrencyKeys = new Set<string>(activeConcurrencyKeys);

      for (const [id, gate] of remaining) {
        if (callbackError !== undefined) {
          break;
        }

        if (activeParallelCount + toLaunch.length >= this.options.maxParallelGates) {
          break;
        }

        const allDepsPassed = gate.dependsOn.every((depId) => gateStatusMap.get(depId) === "passed");
        if (!allDepsPassed) {
          continue;
        }

        if (gate.sideEffect === "workspace-write") {
          if (activeParallelCount === 0 && toLaunch.length === 0 && !roundWorkspaceLocked) {
            toLaunch.push(gate);
            roundWorkspaceLocked = true;
            break;
          }
        } else {
          // read-only gate
          if (!roundWorkspaceLocked) {
            if (!gate.concurrencyKey || !roundConcurrencyKeys.has(gate.concurrencyKey)) {
              toLaunch.push(gate);
              if (gate.concurrencyKey) {
                roundConcurrencyKeys.add(gate.concurrencyKey);
              }
            }
          }
        }
      }

      if (toLaunch.length === 0 && activePromises.size === 0 && remaining.size > 0) {
        const unresolvable = Array.from(remaining.keys()).join(", ");
        throw new QualityError(
          "GATE_DEPENDENCY_INVALID",
          `Gate scheduler deadlocked: impossible state with ${remaining.size} unresolvable gate(s): ${unresolvable}`
        );
      }

      // Launch all chosen gates
      for (const gate of toLaunch) {
        if (callbackError !== undefined) {
          break;
        }

        remaining.delete(gate.id);
        activeParallelCount++;
        if (activeParallelCount > peakParallelism) {
          peakParallelism = activeParallelCount;
        }

        if (gate.sideEffect === "workspace-write") {
          workspaceWriteLocked = true;
        }
        if (gate.concurrencyKey) {
          activeConcurrencyKeys.add(gate.concurrencyKey);
        }

        const qStart = enqueuedAt.get(gate.id) ?? Date.now();
        const launchTime = Date.now();
        totalQueueMs += Math.max(0, launchTime - qStart);

        const opId = `${deps.cycleId}-${gate.id}-${++opSeq}`;

        const runTask = async () => {
          try {
            let startedOk = true;
            if (deps.onGateStarted) {
              try {
                await deps.onGateStarted(gate, opId);
              } catch (err: unknown) {
                if (!callbackError) {
                  callbackError = err;
                }
                startedOk = false;
              }
            }

            if (!startedOk) {
              const startedAt = deps.now ? deps.now() : new Date().toISOString();
              const persistenceFailResult: GateResult = gate.mandatory
                ? {
                    schemaVersion: 1,
                    cycleId: deps.cycleId,
                    gateId: gate.id,
                    operationId: opId,
                    status: "inconclusive",
                    startedAt,
                    durationMs: 0,
                    mandatory: gate.mandatory,
                    failureSignature: "persistence_error",
                    reason: "Gate start persistence callback failed",
                  }
                : {
                    schemaVersion: 1,
                    cycleId: deps.cycleId,
                    gateId: gate.id,
                    operationId: opId,
                    status: "failed",
                    startedAt,
                    durationMs: 0,
                    mandatory: gate.mandatory,
                    reason: "Gate start persistence callback failed",
                  };
              results.set(gate.id, persistenceFailResult);
              gateStatusMap.set(gate.id, persistenceFailResult.status);
              return;
            }

            let runOutcome: { result: GateResult; evidence?: QualityEvidence };
            try {
              runOutcome = await deps.gateRunner.run(gate, {
                runId: deps.runId,
                cycleId: deps.cycleId,
                operationId: opId,
                projectRoot: deps.projectRoot,
                runner: deps.runner,
                signal: deps.signal,
                now: deps.now,
              });
            } catch (runErr: unknown) {
              const errMsg = runErr instanceof Error ? runErr.message : String(runErr);
              const startedAt = deps.now ? deps.now() : new Date().toISOString();
              runOutcome = {
                result: gate.mandatory
                  ? {
                      schemaVersion: 1,
                      cycleId: deps.cycleId,
                      gateId: gate.id,
                      operationId: opId,
                      status: "inconclusive",
                      startedAt,
                      durationMs: 0,
                      mandatory: gate.mandatory,
                      failureSignature: "runner_exception",
                      reason: `Gate execution threw unexpected error: ${errMsg}`,
                    }
                  : {
                      schemaVersion: 1,
                      cycleId: deps.cycleId,
                      gateId: gate.id,
                      operationId: opId,
                      status: "failed",
                      startedAt,
                      durationMs: 0,
                      mandatory: gate.mandatory,
                      reason: `Gate execution threw unexpected error: ${errMsg}`,
                    },
              };
            }

            results.set(gate.id, runOutcome.result);
            if (runOutcome.evidence) {
              evidences.set(gate.id, runOutcome.evidence);
            }
            gateStatusMap.set(gate.id, runOutcome.result.status);

            if (deps.onGateCompleted) {
              try {
                await deps.onGateCompleted(runOutcome.result, runOutcome.evidence);
              } catch (err: unknown) {
                if (!callbackError) {
                  callbackError = err;
                }
              }
            }
          } catch (unexpectedError: unknown) {
            const errMsg = unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError);
            const startedAt = deps.now ? deps.now() : new Date().toISOString();
            const emergencyResult: GateResult = {
              schemaVersion: 1,
              cycleId: deps.cycleId,
              gateId: gate.id,
              operationId: opId,
              status: gate.mandatory ? "inconclusive" : "failed",
              startedAt,
              durationMs: 0,
              mandatory: gate.mandatory,
              failureSignature: "scheduler_unexpected_error",
              reason: `Gate task encountered unexpected failure: ${errMsg}`,
            };
            results.set(gate.id, emergencyResult);
            gateStatusMap.set(gate.id, emergencyResult.status);
          } finally {
            activeParallelCount--;
            if (gate.sideEffect === "workspace-write") {
              workspaceWriteLocked = false;
            }
            if (gate.concurrencyKey) {
              activeConcurrencyKeys.delete(gate.concurrencyKey);
            }
          }
        };

        const taskPromise = runTask();
        activePromises.add(taskPromise);
        taskPromise.then(() => {
          activePromises.delete(taskPromise);
        });
      }

      // Wait for at least one active promise to settle before continuing
      if (activePromises.size > 0) {
        await Promise.race(Array.from(activePromises));
      }
    }

    if (activePromises.size > 0) {
      await Promise.all(Array.from(activePromises));
    }

    if (callbackError !== undefined) {
      const errMsg = callbackError instanceof Error ? callbackError.message : String(callbackError);
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Gate callback persistence failed: ${errMsg}`
      );
    }

    // Preserve strict declaration order for returned results and evidences
    const orderedResults = new Map<GateId, GateResult>();
    const orderedEvidences = new Map<GateId, QualityEvidence>();
    for (const g of gates) {
      const res = results.get(g.id);
      if (res) {
        orderedResults.set(g.id, res);
      }
      const ev = evidences.get(g.id);
      if (ev) {
        orderedEvidences.set(g.id, ev);
      }
    }

    return {
      results: orderedResults,
      evidences: orderedEvidences,
      peakParallelism,
      totalQueueMs,
    };
  }
}
