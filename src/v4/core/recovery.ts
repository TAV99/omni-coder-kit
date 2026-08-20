import type { EventId, RunId } from "../contracts/ids";
import type { RunEvent } from "../contracts/event";
import type { RunState } from "../contracts/run";
import type { StepRequest } from "../contracts/adapter";
import { replayRun } from "../storage/event-store";
import type { RunControllerDeps } from "./controller";
import { nextPhaseOnSuccess } from "./transitions";

export type ResumeResult =
  | { readonly kind: "continue"; readonly state: RunState }
  | { readonly kind: "rerun"; readonly state: RunState; readonly previousOperationId: string }
  | { readonly kind: "blocked"; readonly state: RunState; readonly reason: string };

export async function recoverRun(
  deps: RunControllerDeps,
  runId: RunId
): Promise<ResumeResult> {
  let events = await deps.events.read(runId);
  if (events.length === 0) {
    throw new Error(`Cannot recover run '${runId}'; no events found`);
  }

  let state = replayRun(events);
  if (state.phase === "READY" || state.phase === "BLOCKED" || state.phase === "CANCELLED") {
    return { kind: "continue", state };
  }

  const lastEvent = events[events.length - 1]!;
  let currentSeq = state.sequence;

  // 1. In flight interrupted
  if (state.inFlight) {
    const { stepId, operationId, sideEffect } = state.inFlight;
    const resumeDecision = deps.policy.decideResume({
      runId,
      phase: state.phase,
      stepId,
      operationId,
      sideEffect,
      attempt: state.attempt,
    });

    const interruptedEvent: RunEvent = {
      schemaVersion: 1,
      eventId: deps.newEventId(),
      runId,
      sequence: currentSeq + 1,
      at: deps.now(),
      type: "step.interrupted",
      payload: {
        stepId,
        operationId,
        sideEffect,
        reason: "Process interrupted while step was in flight",
      },
    };
    await deps.events.append(interruptedEvent, currentSeq);
    currentSeq = interruptedEvent.sequence;

    const policyEvent: RunEvent = {
      schemaVersion: 1,
      eventId: deps.newEventId(),
      runId,
      sequence: currentSeq + 1,
      at: deps.now(),
      type: "policy.decided",
      payload: {
        stage: "resume",
        stepId,
        operationId,
        decision: resumeDecision,
      },
    };
    await deps.events.append(policyEvent, currentSeq);
    currentSeq = policyEvent.sequence;

    if (resumeDecision.kind === "retry") {
      events = await deps.events.read(runId);
      return {
        kind: "rerun",
        state: replayRun(events),
        previousOperationId: operationId,
      };
    } else {
      const blockedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: deps.newEventId(),
        runId,
        sequence: currentSeq + 1,
        at: deps.now(),
        type: "run.blocked",
        payload: {
          reason: resumeDecision.reason,
          requiredAction: resumeDecision.requiredAction,
          causedByEventId: policyEvent.eventId,
        },
      };
      await deps.events.append(blockedEvent, currentSeq);
      events = await deps.events.read(runId);
      return {
        kind: "blocked",
        state: replayRun(events),
        reason: resumeDecision.reason,
      };
    }
  }

  // 2. step.succeeded without run.transitioned -> Roll forward if valid
  if (lastEvent.type === "step.succeeded") {
    const startEvent = [...events].reverse().find(
      (e) =>
        e.type === "step.started" &&
        e.payload.stepId === lastEvent.payload.stepId &&
        e.payload.operationId === lastEvent.payload.operationId
    );

    if (!startEvent || startEvent.type !== "step.started") {
      const blockedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: deps.newEventId(),
        runId,
        sequence: currentSeq + 1,
        at: deps.now(),
        type: "run.blocked",
        payload: {
          reason: "Cannot find matching step.started for step.succeeded during recovery",
          requiredAction: "Inspect event log integrity",
          causedByEventId: lastEvent.eventId,
        },
      };
      await deps.events.append(blockedEvent, currentSeq);
      events = await deps.events.read(runId);
      return {
        kind: "blocked",
        state: replayRun(events),
        reason: "Cannot find matching step.started for step.succeeded during recovery",
      };
    }

    const workspaceDir = startEvent.payload.workspaceDir;
    const requiredArtifacts = lastEvent.payload.result.artifacts;

    if (requiredArtifacts.length === 0) {
      const blockedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: deps.newEventId(),
        runId,
        sequence: currentSeq + 1,
        at: deps.now(),
        type: "run.blocked",
        payload: {
          reason: "step.succeeded produced zero artifacts; roll forward blocked",
          requiredAction: "Rerun step with valid artifacts",
          causedByEventId: lastEvent.eventId,
        },
      };
      await deps.events.append(blockedEvent, currentSeq);
      events = await deps.events.read(runId);
      return {
        kind: "blocked",
        state: replayRun(events),
        reason: "step.succeeded produced zero artifacts; roll forward blocked",
      };
    }

    const artifactEvents = events.filter(
      (e) =>
        e.type === "artifact.recorded" &&
        e.payload.record.runId === runId &&
        e.payload.record.producerStepId === lastEvent.payload.stepId
    );

    const recordedMap = new Map(
      artifactEvents
        .filter((e): e is RunEvent & { type: "artifact.recorded" } => e.type === "artifact.recorded")
        .map((e) => [e.payload.record.artifactId, e.payload.record])
    );

    let allValid = true;
    for (const reqArt of requiredArtifacts) {
      const record = recordedMap.get(reqArt.artifactId);
      if (!record) {
        allValid = false;
        break;
      }
      const verifyRes = await deps.artifacts.verify({
        workspaceDir,
        record,
      });
      if (!verifyRes.valid) {
        allValid = false;
        break;
      }
    }

    if (allValid) {
      const nextPhase = nextPhaseOnSuccess(state.phase);
      const transitionedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: deps.newEventId(),
        runId,
        sequence: currentSeq + 1,
        at: deps.now(),
        type: "run.transitioned",
        payload: {
          stepId: lastEvent.payload.stepId,
          operationId: lastEvent.payload.operationId,
          from: state.phase,
          to: nextPhase,
          causedByEventId: lastEvent.eventId,
        },
      };
      await deps.events.append(transitionedEvent, currentSeq);
      events = await deps.events.read(runId);
      return { kind: "continue", state: replayRun(events) };
    } else {
      const blockedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: deps.newEventId(),
        runId,
        sequence: currentSeq + 1,
        at: deps.now(),
        type: "run.blocked",
        payload: {
          reason: "Artifact verification failed during recovery roll-forward",
          requiredAction: "Inspect workspace artifacts and rerun step",
          causedByEventId: lastEvent.eventId,
        },
      };
      await deps.events.append(blockedEvent, currentSeq);
      events = await deps.events.read(runId);
      return {
        kind: "blocked",
        state: replayRun(events),
        reason: "Artifact verification failed during recovery roll-forward",
      };
    }
  }

  // 3. step.failed without policy.decided
  if (lastEvent.type === "step.failed") {
    const startEvent = [...events].reverse().find(
      (e) =>
        e.type === "step.started" &&
        e.payload.stepId === lastEvent.payload.stepId &&
        e.payload.operationId === lastEvent.payload.operationId
    );

    if (!startEvent || startEvent.type !== "step.started") {
      const blockedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: deps.newEventId(),
        runId,
        sequence: currentSeq + 1,
        at: deps.now(),
        type: "run.blocked",
        payload: {
          reason: "Cannot find matching step.started for step.failed during recovery",
          requiredAction: "Inspect event log integrity",
          causedByEventId: lastEvent.eventId,
        },
      };
      await deps.events.append(blockedEvent, currentSeq);
      events = await deps.events.read(runId);
      return {
        kind: "blocked",
        state: replayRun(events),
        reason: "Cannot find matching step.started for step.failed during recovery",
      };
    }

    const reconstructedReq: StepRequest = {
      runId,
      stepId: startEvent.payload.stepId,
      phase: startEvent.payload.phase,
      operationId: startEvent.payload.operationId,
      workspaceDir: startEvent.payload.workspaceDir,
      prompt: "",
      requiredCapabilities: [],
      sideEffect: startEvent.payload.sideEffect,
      timeoutMs: 30000,
    };

    const failDecision = deps.policy.decideFailure({
      request: reconstructedReq,
      failure: lastEvent.payload.result.failure,
      attempt: state.attempt,
      sameFailureCount: state.sameFailureCount,
    });

    const policyEvent: RunEvent = {
      schemaVersion: 1,
      eventId: deps.newEventId(),
      runId,
      sequence: currentSeq + 1,
      at: deps.now(),
      type: "policy.decided",
      payload: {
        stage: "failure",
        stepId: lastEvent.payload.stepId,
        operationId: lastEvent.payload.operationId,
        decision: failDecision,
      },
    };
    await deps.events.append(policyEvent, currentSeq);
    currentSeq = policyEvent.sequence;

    if (failDecision.kind === "retry") {
      events = await deps.events.read(runId);
      return {
        kind: "rerun",
        state: replayRun(events),
        previousOperationId: lastEvent.payload.operationId,
      };
    } else {
      const blockedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: deps.newEventId(),
        runId,
        sequence: currentSeq + 1,
        at: deps.now(),
        type: "run.blocked",
        payload: {
          reason: failDecision.reason,
          requiredAction: failDecision.requiredAction,
          causedByEventId: policyEvent.eventId,
        },
      };
      await deps.events.append(blockedEvent, currentSeq);
      events = await deps.events.read(runId);
      return {
        kind: "blocked",
        state: replayRun(events),
        reason: failDecision.reason,
      };
    }
  }

  // 4. policy.decided cut-points
  if (lastEvent.type === "policy.decided") {
    if (lastEvent.payload.stage === "failure") {
      if (lastEvent.payload.decision.kind === "retry") {
        return {
          kind: "rerun",
          state,
          previousOperationId: lastEvent.payload.operationId,
        };
      } else {
        const blockedEvent: RunEvent = {
          schemaVersion: 1,
          eventId: deps.newEventId(),
          runId,
          sequence: currentSeq + 1,
          at: deps.now(),
          type: "run.blocked",
          payload: {
            reason: lastEvent.payload.decision.reason,
            requiredAction: lastEvent.payload.decision.requiredAction,
            causedByEventId: lastEvent.eventId,
          },
        };
        await deps.events.append(blockedEvent, currentSeq);
        events = await deps.events.read(runId);
        return {
          kind: "blocked",
          state: replayRun(events),
          reason: lastEvent.payload.decision.reason,
        };
      }
    }

    if (lastEvent.payload.stage === "preflight") {
      if (lastEvent.payload.decision.kind === "deny") {
        const blockedEvent: RunEvent = {
          schemaVersion: 1,
          eventId: deps.newEventId(),
          runId,
          sequence: currentSeq + 1,
          at: deps.now(),
          type: "run.blocked",
          payload: {
            reason: lastEvent.payload.decision.reason,
            requiredAction: "Resolve preflight policy denial",
            causedByEventId: lastEvent.eventId,
          },
        };
        await deps.events.append(blockedEvent, currentSeq);
        events = await deps.events.read(runId);
        return {
          kind: "blocked",
          state: replayRun(events),
          reason: lastEvent.payload.decision.reason,
        };
      } else {
        return { kind: "continue", state };
      }
    }

    if (lastEvent.payload.stage === "resume") {
      if (lastEvent.payload.decision.kind === "retry") {
        return {
          kind: "rerun",
          state,
          previousOperationId: lastEvent.payload.operationId,
        };
      } else {
        const blockedEvent: RunEvent = {
          schemaVersion: 1,
          eventId: deps.newEventId(),
          runId,
          sequence: currentSeq + 1,
          at: deps.now(),
          type: "run.blocked",
          payload: {
            reason: lastEvent.payload.decision.reason,
            requiredAction: lastEvent.payload.decision.requiredAction,
            causedByEventId: lastEvent.eventId,
          },
        };
        await deps.events.append(blockedEvent, currentSeq);
        events = await deps.events.read(runId);
        return {
          kind: "blocked",
          state: replayRun(events),
          reason: lastEvent.payload.decision.reason,
        };
      }
    }
  }

  // 5. step.blocked without run.blocked
  if (lastEvent.type === "step.blocked") {
    const blockedEvent: RunEvent = {
      schemaVersion: 1,
      eventId: deps.newEventId(),
      runId,
      sequence: currentSeq + 1,
      at: deps.now(),
      type: "run.blocked",
      payload: {
        reason: lastEvent.payload.result.reason,
        requiredAction: lastEvent.payload.result.requiredAction,
        causedByEventId: lastEvent.eventId,
      },
    };
    await deps.events.append(blockedEvent, currentSeq);
    events = await deps.events.read(runId);
    return {
      kind: "blocked",
      state: replayRun(events),
      reason: lastEvent.payload.result.reason,
    };
  }

  // 6. step.cancelled without run.cancelled
  if (lastEvent.type === "step.cancelled") {
    const cancelledEvent: RunEvent = {
      schemaVersion: 1,
      eventId: deps.newEventId(),
      runId,
      sequence: currentSeq + 1,
      at: deps.now(),
      type: "run.cancelled",
      payload: {
        reason: lastEvent.payload.result.reason,
        causedByEventId: lastEvent.eventId,
      },
    };
    await deps.events.append(cancelledEvent, currentSeq);
    events = await deps.events.read(runId);
    return {
      kind: "continue",
      state: replayRun(events),
    };
  }

  return { kind: "continue", state };
}
