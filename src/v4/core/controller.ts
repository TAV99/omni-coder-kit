import type { AgentAdapter, StepRequest } from "../contracts/adapter";
import type { ArtifactRecord } from "../contracts/artifact";
import type { EventId, RunId } from "../contracts/ids";
import type { RunEvent } from "../contracts/event";
import type { Policy } from "../contracts/policy";
import type { RunState } from "../contracts/run";
import { StepResultSchema, type StepResult } from "../contracts/step-result";
import type { ArtifactStore } from "../storage/artifact-store";
import type { EventStore } from "../storage/event-store";
import { replayRun } from "../storage/event-store";
import { nextPhaseOnSuccess } from "./transitions";

export interface RunControllerDeps {
  readonly adapter: AgentAdapter;
  readonly policy: Policy;
  readonly events: EventStore;
  readonly artifacts: ArtifactStore;
  readonly now: () => string;
  readonly newEventId: () => EventId;
}

export class RunController {
  constructor(private readonly deps: RunControllerDeps) {}

  async start(input: { readonly runId: RunId; readonly startedAt?: string }): Promise<RunState> {
    const startedAt = input.startedAt ?? this.deps.now();
    const createdEvent: RunEvent = {
      schemaVersion: 1,
      eventId: this.deps.newEventId(),
      runId: input.runId,
      sequence: 0,
      at: startedAt,
      type: "run.created",
      payload: {
        startedAt,
      },
    };

    await this.deps.events.append(createdEvent, -1);
    return replayRun([createdEvent]);
  }

  async getState(runId: RunId): Promise<RunState> {
    const events = await this.deps.events.read(runId);
    return replayRun(events);
  }

  async resume(runId: RunId): Promise<import("./recovery").ResumeResult> {
    const { recoverRun } = await import("./recovery");
    return recoverRun(this.deps, runId);
  }

  async executeNext(
    request: StepRequest,
    options?: { readonly elevatedPermissions?: boolean; readonly resumeSessionId?: string }
  ): Promise<RunState> {
    let events = await this.deps.events.read(request.runId);
    let state = replayRun(events);

    if (request.phase !== state.phase) {
      throw new Error(
        `Cannot execute step in phase '${request.phase}'; current run phase is '${state.phase}'`
      );
    }

    if (state.phase === "READY" || state.phase === "BLOCKED" || state.phase === "CANCELLED") {
      throw new Error(`Cannot execute step in terminal phase '${state.phase}'`);
    }

    const elevated = options?.elevatedPermissions ?? false;
    const probe = await this.deps.adapter.probe();
    const preflight = this.deps.policy.evaluatePreflight({
      request,
      probe,
      elevatedPermissions: elevated,
    });

    let currentSequence = state.sequence;

    const preflightEvent: RunEvent = {
      schemaVersion: 1,
      eventId: this.deps.newEventId(),
      runId: request.runId,
      sequence: currentSequence + 1,
      at: this.deps.now(),
      type: "policy.decided",
      payload: {
        stage: "preflight",
        stepId: request.stepId,
        operationId: request.operationId,
        decision: preflight,
      },
    };
    await this.deps.events.append(preflightEvent, currentSequence);
    currentSequence = preflightEvent.sequence;

    if (preflight.kind === "deny") {
      const blockedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: this.deps.newEventId(),
        runId: request.runId,
        sequence: currentSequence + 1,
        at: this.deps.now(),
        type: "run.blocked",
        payload: {
          reason: preflight.reason,
          requiredAction: "Resolve preflight policy denial",
          causedByEventId: preflightEvent.eventId,
        },
      };
      await this.deps.events.append(blockedEvent, currentSequence);
      events = await this.deps.events.read(request.runId);
      return replayRun(events);
    }

    const startEvent: RunEvent = {
      schemaVersion: 1,
      eventId: this.deps.newEventId(),
      runId: request.runId,
      sequence: currentSequence + 1,
      at: this.deps.now(),
      type: "step.started",
      payload: {
        stepId: request.stepId,
        operationId: request.operationId,
        phase: request.phase,
        sideEffect: request.sideEffect,
        workspaceDir: request.workspaceDir,
      },
    };
    await this.deps.events.append(startEvent, currentSequence);
    currentSequence = startEvent.sequence;

    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort(new Error("Timeout"));
    }, request.timeoutMs);

    let rawOutcome: unknown;
    let executionError: Error | undefined;

    const adapterContext: import("../contracts/adapter").AdapterContext =
      options?.resumeSessionId !== undefined
        ? {
            signal: abortController.signal,
            elevatedPermissions: elevated,
            resumeSessionId: options.resumeSessionId,
          }
        : {
            signal: abortController.signal,
            elevatedPermissions: elevated,
          };

    try {
      rawOutcome = await this.deps.adapter.execute(request, adapterContext);
    } catch (err: any) {
      executionError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timeout);
    }

    let parsedResult: StepResult;

    if (executionError) {
      const isTimeout =
        abortController.signal.aborted ||
        executionError.name === "AbortError" ||
        executionError.message === "Timeout";

      parsedResult = {
        status: "failed",
        executionId: request.operationId,
        failure: {
          code: isTimeout ? "TIMEOUT" : "ADAPTER_THROW",
          message: executionError.message,
          retryable: true,
          signature: isTimeout ? "timeout" : "adapter_throw",
        },
      };
    } else {
      try {
        parsedResult = StepResultSchema.parse(rawOutcome);
        if (parsedResult.executionId !== request.operationId) {
          parsedResult = {
            status: "failed",
            executionId: request.operationId,
            failure: {
              code: "CORRELATION_MISMATCH",
              message: `Returned executionId '${parsedResult.executionId}' does not match request operationId '${request.operationId}'`,
              retryable: false,
              signature: "correlation_mismatch",
            },
          };
        }
      } catch (err: any) {
        parsedResult = {
          status: "failed",
          executionId: request.operationId,
          failure: {
            code: "MALFORMED_OUTPUT",
            message: `Result failed schema validation: ${err.message}`,
            retryable: false,
            signature: "malformed_output",
          },
        };
      }
    }

    // Process Succeeded
    if (parsedResult.status === "succeeded") {
      let validationFailure: string | undefined;

      if (parsedResult.artifacts.length === 0) {
        validationFailure = "Succeeded step must produce at least one artifact";
      } else if (parsedResult.evidence.length === 0) {
        validationFailure = "Succeeded step must produce at least one evidence item";
      }

      const seenArtIds = new Set<string>();
      for (const claim of parsedResult.artifacts) {
        if (seenArtIds.has(claim.artifactId)) {
          validationFailure = `Duplicate artifactId '${claim.artifactId}' in result`;
          break;
        }
        seenArtIds.add(claim.artifactId);
      }

      const recordedRecords: ArtifactRecord[] = [];
      if (!validationFailure) {
        for (const claim of parsedResult.artifacts) {
          try {
            const record = await this.deps.artifacts.record({
              workspaceDir: request.workspaceDir,
              runId: request.runId,
              producerStepId: request.stepId,
              claim,
              recordedAt: this.deps.now(),
            });
            const verification = await this.deps.artifacts.verify({
              workspaceDir: request.workspaceDir,
              record,
            });
            if (!verification.valid) {
              validationFailure = `Artifact '${claim.relativePath}' verification failed: ${verification.reason}`;
              break;
            }
            recordedRecords.push(record);
          } catch (err: any) {
            validationFailure = `Failed to record artifact '${claim.relativePath}': ${err.message}`;
            break;
          }
        }
      }

      if (!validationFailure) {
        const recordedIds = new Set(recordedRecords.map((r) => r.artifactId));
        const referencedInEvidence = new Set<string>();

        for (const ev of parsedResult.evidence) {
          if (ev.producerStepId !== request.stepId) {
            validationFailure = `Evidence item producerStepId '${ev.producerStepId}' does not match stepId '${request.stepId}'`;
            break;
          }
          for (const artId of ev.artifactIds) {
            if (!recordedIds.has(artId)) {
              validationFailure = `Evidence references unknown/unrecorded artifactId '${artId}'`;
              break;
            }
            referencedInEvidence.add(artId);
          }
        }

        if (!validationFailure) {
          for (const artId of recordedIds) {
            if (!referencedInEvidence.has(artId)) {
              validationFailure = `Recorded artifact '${artId}' is not referenced by any evidence item`;
              break;
            }
          }
        }
      }

      if (validationFailure) {
        parsedResult = {
          status: "failed",
          executionId: request.operationId,
          failure: {
            code: "ARTIFACT_EVIDENCE_VALIDATION_ERROR",
            message: validationFailure,
            retryable: false,
            signature: "artifact_evidence_validation_error",
          },
        };
      } else {
        // Append artifact.recorded events
        for (const record of recordedRecords) {
          const artEvent: RunEvent = {
            schemaVersion: 1,
            eventId: this.deps.newEventId(),
            runId: request.runId,
            sequence: currentSequence + 1,
            at: this.deps.now(),
            type: "artifact.recorded",
            payload: { record },
          };
          await this.deps.events.append(artEvent, currentSequence);
          currentSequence = artEvent.sequence;
        }

        const stepSucceededEvent: RunEvent = {
          schemaVersion: 1,
          eventId: this.deps.newEventId(),
          runId: request.runId,
          sequence: currentSequence + 1,
          at: this.deps.now(),
          type: "step.succeeded",
          payload: {
            stepId: request.stepId,
            operationId: request.operationId,
            result: parsedResult,
          },
        };
        await this.deps.events.append(stepSucceededEvent, currentSequence);
        currentSequence = stepSucceededEvent.sequence;

        const nextPhase = nextPhaseOnSuccess(request.phase);
        const transitionedEvent: RunEvent = {
          schemaVersion: 1,
          eventId: this.deps.newEventId(),
          runId: request.runId,
          sequence: currentSequence + 1,
          at: this.deps.now(),
          type: "run.transitioned",
          payload: {
            stepId: request.stepId,
            operationId: request.operationId,
            from: request.phase,
            to: nextPhase,
            causedByEventId: stepSucceededEvent.eventId,
          },
        };
        await this.deps.events.append(transitionedEvent, currentSequence);

        events = await this.deps.events.read(request.runId);
        return replayRun(events);
      }
    }

    // Process Failed
    if (parsedResult.status === "failed") {
      const stepFailedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: this.deps.newEventId(),
        runId: request.runId,
        sequence: currentSequence + 1,
        at: this.deps.now(),
        type: "step.failed",
        payload: {
          stepId: request.stepId,
          operationId: request.operationId,
          result: parsedResult,
        },
      };
      await this.deps.events.append(stepFailedEvent, currentSequence);
      currentSequence = stepFailedEvent.sequence;

      const stateAfterFail = replayRun(await this.deps.events.read(request.runId));
      const failDecision = this.deps.policy.decideFailure({
        request,
        failure: parsedResult.failure,
        attempt: stateAfterFail.attempt,
        sameFailureCount: stateAfterFail.sameFailureCount,
      });

      const failurePolicyEvent: RunEvent = {
        schemaVersion: 1,
        eventId: this.deps.newEventId(),
        runId: request.runId,
        sequence: currentSequence + 1,
        at: this.deps.now(),
        type: "policy.decided",
        payload: {
          stage: "failure",
          stepId: request.stepId,
          operationId: request.operationId,
          decision: failDecision,
        },
      };
      await this.deps.events.append(failurePolicyEvent, currentSequence);
      currentSequence = failurePolicyEvent.sequence;

      if (failDecision.kind === "block") {
        const runBlockedEvent: RunEvent = {
          schemaVersion: 1,
          eventId: this.deps.newEventId(),
          runId: request.runId,
          sequence: currentSequence + 1,
          at: this.deps.now(),
          type: "run.blocked",
          payload: {
            reason: failDecision.reason,
            requiredAction: failDecision.requiredAction,
            causedByEventId: failurePolicyEvent.eventId,
          },
        };
        await this.deps.events.append(runBlockedEvent, currentSequence);
      }

      events = await this.deps.events.read(request.runId);
      return replayRun(events);
    }

    // Process Blocked
    if (parsedResult.status === "blocked") {
      const stepBlockedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: this.deps.newEventId(),
        runId: request.runId,
        sequence: currentSequence + 1,
        at: this.deps.now(),
        type: "step.blocked",
        payload: {
          stepId: request.stepId,
          operationId: request.operationId,
          result: parsedResult,
        },
      };
      await this.deps.events.append(stepBlockedEvent, currentSequence);
      currentSequence = stepBlockedEvent.sequence;

      const runBlockedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: this.deps.newEventId(),
        runId: request.runId,
        sequence: currentSequence + 1,
        at: this.deps.now(),
        type: "run.blocked",
        payload: {
          reason: parsedResult.reason,
          requiredAction: parsedResult.requiredAction,
          causedByEventId: stepBlockedEvent.eventId,
        },
      };
      await this.deps.events.append(runBlockedEvent, currentSequence);

      events = await this.deps.events.read(request.runId);
      return replayRun(events);
    }

    // Process Cancelled
    if (parsedResult.status === "cancelled") {
      const stepCancelledEvent: RunEvent = {
        schemaVersion: 1,
        eventId: this.deps.newEventId(),
        runId: request.runId,
        sequence: currentSequence + 1,
        at: this.deps.now(),
        type: "step.cancelled",
        payload: {
          stepId: request.stepId,
          operationId: request.operationId,
          result: parsedResult,
        },
      };
      await this.deps.events.append(stepCancelledEvent, currentSequence);
      currentSequence = stepCancelledEvent.sequence;

      const runCancelledEvent: RunEvent = {
        schemaVersion: 1,
        eventId: this.deps.newEventId(),
        runId: request.runId,
        sequence: currentSequence + 1,
        at: this.deps.now(),
        type: "run.cancelled",
        payload: {
          reason: parsedResult.reason,
          causedByEventId: stepCancelledEvent.eventId,
        },
      };
      await this.deps.events.append(runCancelledEvent, currentSequence);

      events = await this.deps.events.read(request.runId);
      return replayRun(events);
    }

    events = await this.deps.events.read(request.runId);
    return replayRun(events);
  }
}
