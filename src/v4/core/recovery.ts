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
        reason: lastEvent.payload.reason,
        requiredAction: "User intervention required",
        causedByEventId: lastEvent.eventId,
      },
    };
    await deps.events.append(blockedEvent, currentSeq);
    events = await deps.events.read(runId);
    return {
      kind: "blocked",
      state: replayRun(events),
      reason: lastEvent.payload.reason,
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
        reason: lastEvent.payload.reason,
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

  // 7. quality.completed without run.routed or run.blocked
  if (lastEvent.type === "quality.completed") {
    if (!deps.bundles) {
      const blockedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: deps.newEventId(),
        runId,
        sequence: currentSeq + 1,
        at: deps.now(),
        type: "run.blocked",
        payload: {
          reason: "QUALITY_RECOVERY_UNSAFE: Evidence bundle store is required to verify completed quality cycle",
          requiredAction: "Provide evidence bundle store to recovery controller",
          causedByEventId: lastEvent.eventId,
        },
      };
      await deps.events.append(blockedEvent, currentSeq);
      events = await deps.events.read(runId);
      return {
        kind: "blocked",
        state: replayRun(events),
        reason: blockedEvent.payload.reason,
      };
    }

    try {
      const bundle = await deps.bundles.readBundle(runId, lastEvent.payload.cycleId);
      if (
        bundle.runId !== runId ||
        bundle.cycleId !== lastEvent.payload.cycleId ||
        bundle.decision.kind !== lastEvent.payload.decision.kind
      ) {
        throw new Error("Evidence bundle identity or decision mismatch against quality.completed event");
      }

      const decision = lastEvent.payload.decision;
      if (decision.kind === "advance") {
        if (
          bundle.routeIntent.kind !== "advance" ||
          bundle.routeIntent.from !== state.phase ||
          bundle.routeIntent.to !== decision.to ||
          bundle.routeIntent.causedByEventId !== lastEvent.eventId
        ) {
          throw new Error("Evidence bundle routeIntent semantic mismatch for advance decision");
        }
        const routedEvent: RunEvent = {
          schemaVersion: 1,
          eventId: deps.newEventId(),
          runId,
          sequence: currentSeq + 1,
          at: deps.now(),
          type: "run.routed",
          payload: {
            from: state.phase,
            to: decision.to,
            causedByEventId: lastEvent.eventId,
          },
        };
        await deps.events.append(routedEvent, currentSeq);
        events = await deps.events.read(runId);
        return {
          kind: "continue",
          state: replayRun(events),
        };
      } else if (decision.kind === "block") {
        if (
          bundle.routeIntent.kind !== "block" ||
          bundle.routeIntent.from !== state.phase ||
          bundle.routeIntent.reason !== decision.reason ||
          bundle.routeIntent.requiredAction !== decision.requiredAction ||
          bundle.routeIntent.causedByEventId !== lastEvent.eventId
        ) {
          throw new Error("Evidence bundle routeIntent semantic mismatch for block decision");
        }
        const blockedEvent: RunEvent = {
          schemaVersion: 1,
          eventId: deps.newEventId(),
          runId,
          sequence: currentSeq + 1,
          at: deps.now(),
          type: "run.blocked",
          payload: {
            reason: decision.reason,
            requiredAction: decision.requiredAction,
            causedByEventId: lastEvent.eventId,
          },
        };
        await deps.events.append(blockedEvent, currentSeq);
        events = await deps.events.read(runId);
        return {
          kind: "blocked",
          state: replayRun(events),
          reason: decision.reason,
        };
      } else if (decision.kind === "repair") {
        // Cannot roll forward repair directly from quality.completed; authorized cause must be repair.decided
        const blockedEvent: RunEvent = {
          schemaVersion: 1,
          eventId: deps.newEventId(),
          runId,
          sequence: currentSeq + 1,
          at: deps.now(),
          type: "run.blocked",
          payload: {
            reason: "QUALITY_RECOVERY_UNSAFE: Quality cycle completed with repair decision but repair.decided event was not durably recorded",
            requiredAction: "Resume run to re-evaluate quality cycle or record repair.decided event",
            causedByEventId: lastEvent.eventId,
          },
        };
        await deps.events.append(blockedEvent, currentSeq);
        events = await deps.events.read(runId);
        return {
          kind: "blocked",
          state: replayRun(events),
          reason: blockedEvent.payload.reason,
        };
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const blockedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: deps.newEventId(),
        runId,
        sequence: currentSeq + 1,
        at: deps.now(),
        type: "run.blocked",
        payload: {
          reason: `QUALITY_RECOVERY_UNSAFE: Missing or corrupt authorized evidence bundle: ${errMsg}`,
          requiredAction: "Inspect quality evidence bundle storage",
          causedByEventId: lastEvent.eventId,
        },
      };
      await deps.events.append(blockedEvent, currentSeq);
      events = await deps.events.read(runId);
      return {
        kind: "blocked",
        state: replayRun(events),
        reason: blockedEvent.payload.reason,
      };
    }
  }

  // 8. repair.decided cut point without run.routed
  if (lastEvent.type === "repair.decided") {
    if (!deps.bundles) {
      const blockedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: deps.newEventId(),
        runId,
        sequence: currentSeq + 1,
        at: deps.now(),
        type: "run.blocked",
        payload: {
          reason: "QUALITY_RECOVERY_UNSAFE: Evidence bundle store is required to verify repair decision",
          requiredAction: "Provide evidence bundle store to recovery controller",
          causedByEventId: lastEvent.eventId,
        },
      };
      await deps.events.append(blockedEvent, currentSeq);
      events = await deps.events.read(runId);
      return {
        kind: "blocked",
        state: replayRun(events),
        reason: blockedEvent.payload.reason,
      };
    }

    try {
      const bundle = await deps.bundles.readBundle(runId, lastEvent.payload.cycleId);
      if (
        bundle.runId !== runId ||
        bundle.cycleId !== lastEvent.payload.cycleId ||
        bundle.decision.kind !== "repair" ||
        bundle.routeIntent.kind !== "repair" ||
        bundle.routeIntent.from !== state.phase ||
        bundle.routeIntent.to !== bundle.decision.to ||
        bundle.routeIntent.attempt !== lastEvent.payload.attempt ||
        JSON.stringify(bundle.routeIntent.requirementIds) !== JSON.stringify(lastEvent.payload.requirementIds) ||
        JSON.stringify(bundle.decision.requirementIds) !== JSON.stringify(lastEvent.payload.requirementIds) ||
        bundle.routeIntent.causedByEventId !== lastEvent.eventId
      ) {
        throw new Error("Evidence bundle identity or routeIntent semantic mismatch against repair.decided event");
      }

      if (bundle.repairHistory.length === 0) {
        throw new Error("Evidence bundle repair history is empty for repair.decided event");
      }

      const latest = bundle.repairHistory[bundle.repairHistory.length - 1]!;
      if (
        latest.attempt !== lastEvent.payload.attempt ||
        latest.cycleId !== lastEvent.payload.cycleId ||
        JSON.stringify(latest.requirementIds) !== JSON.stringify(lastEvent.payload.requirementIds)
      ) {
        throw new Error("Evidence bundle repair history mismatch against repair.decided event");
      }

      const routedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: deps.newEventId(),
        runId,
        sequence: currentSeq + 1,
        at: deps.now(),
        type: "run.routed",
        payload: {
          from: state.phase,
          to: bundle.routeIntent.to,
          causedByEventId: lastEvent.eventId,
        },
      };
      await deps.events.append(routedEvent, currentSeq);
      events = await deps.events.read(runId);
      return {
        kind: "continue",
        state: replayRun(events),
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const blockedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: deps.newEventId(),
        runId,
        sequence: currentSeq + 1,
        at: deps.now(),
        type: "run.blocked",
        payload: {
          reason: `QUALITY_RECOVERY_UNSAFE: Missing or corrupt authorized evidence bundle for repair decision: ${errMsg}`,
          requiredAction: "Inspect quality evidence bundle storage",
          causedByEventId: lastEvent.eventId,
        },
      };
      await deps.events.append(blockedEvent, currentSeq);
      events = await deps.events.read(runId);
      return {
        kind: "blocked",
        state: replayRun(events),
        reason: blockedEvent.payload.reason,
      };
    }
  }

  // 9. In-flight / interrupted quality cycle without completion (R34, R35, R36, R37, R38)
  const lastQualityStart = [...events].reverse().find((e) => e.type === "quality.started");
  if (lastQualityStart && lastQualityStart.type === "quality.started") {
    const qualityStartSeq = lastQualityStart.sequence;
    const cycleId = lastQualityStart.payload.cycleId;

    if (!deps.gateRegistry) {
      const blockedEvent: RunEvent = {
        schemaVersion: 1,
        eventId: deps.newEventId(),
        runId,
        sequence: currentSeq + 1,
        at: deps.now(),
        type: "run.blocked",
        payload: {
          reason: "QUALITY_RECOVERY_UNSAFE: Quality gate registry is required for recovery of in-flight quality gates",
          requiredAction: "Provide gate registry to recovery controller",
          causedByEventId: lastQualityStart.eventId,
        },
      };
      await deps.events.append(blockedEvent, currentSeq);
      events = await deps.events.read(runId);
      return {
        kind: "blocked",
        state: replayRun(events),
        reason: blockedEvent.payload.reason,
      };
    }

    // Check if there are quality events with conflicting/ambiguous cycle IDs (R38)
    const subsequentQualityEvents = events.slice(qualityStartSeq + 1);
    for (const ev of subsequentQualityEvents) {
      const evCycleId =
        ev.type === "gate.started"
          ? ev.payload.cycleId
          : ev.type === "gate.completed"
          ? ev.payload.result.cycleId
          : undefined;
      if (evCycleId !== undefined && evCycleId !== cycleId) {
        const blockedEvent: RunEvent = {
          schemaVersion: 1,
          eventId: deps.newEventId(),
          runId,
          sequence: currentSeq + 1,
          at: deps.now(),
          type: "run.blocked",
          payload: {
            reason: `QUALITY_RECOVERY_UNSAFE: Ambiguous quality cycle correlation ('${evCycleId}' !== '${cycleId}')`,
            requiredAction: "Inspect event log for cross-cycle corruption",
            causedByEventId: ev.eventId,
          },
        };
        await deps.events.append(blockedEvent, currentSeq);
        events = await deps.events.read(runId);
        return {
          kind: "blocked",
          state: replayRun(events),
          reason: blockedEvent.payload.reason,
        };
      }
    }

    // Track active and completed gates strictly by cycleId + gateId + operationId
    const startedGates = new Map<string, { gateId: import("../contracts/quality").GateId; opId: string; eventId: EventId }>();
    for (const ev of subsequentQualityEvents) {
      if (ev.type === "gate.started") {
        const key = `${ev.payload.gateId}:${ev.payload.operationId}`;
        if (startedGates.has(key)) {
          const blockedEvent: RunEvent = {
            schemaVersion: 1,
            eventId: deps.newEventId(),
            runId,
            sequence: currentSeq + 1,
            at: deps.now(),
            type: "run.blocked",
            payload: {
              reason: `QUALITY_RECOVERY_UNSAFE: Duplicate in-flight gate.started for gate '${ev.payload.gateId}' (operation '${ev.payload.operationId}')`,
              requiredAction: "Inspect event log for duplicate gate execution",
              causedByEventId: ev.eventId,
            },
          };
          await deps.events.append(blockedEvent, currentSeq);
          events = await deps.events.read(runId);
          return {
            kind: "blocked",
            state: replayRun(events),
            reason: blockedEvent.payload.reason,
          };
        }
        startedGates.set(key, {
          gateId: ev.payload.gateId,
          opId: ev.payload.operationId,
          eventId: ev.eventId,
        });
      } else if (ev.type === "gate.completed") {
        const key = `${ev.payload.result.gateId}:${ev.payload.result.operationId}`;
        if (!startedGates.has(key)) {
          const blockedEvent: RunEvent = {
            schemaVersion: 1,
            eventId: deps.newEventId(),
            runId,
            sequence: currentSeq + 1,
            at: deps.now(),
            type: "run.blocked",
            payload: {
              reason: `QUALITY_RECOVERY_UNSAFE: gate.completed for gate '${ev.payload.result.gateId}' has no matching gate.started in cycle`,
              requiredAction: "Inspect event log for gate correlation failure",
              causedByEventId: ev.eventId,
            },
          };
          await deps.events.append(blockedEvent, currentSeq);
          events = await deps.events.read(runId);
          return {
            kind: "blocked",
            state: replayRun(events),
            reason: blockedEvent.payload.reason,
          };
        }
        startedGates.delete(key);
      }
    }

    // Validate in-flight gates against registry
    if (startedGates.size > 0) {
      for (const inFlight of startedGates.values()) {
        const def = deps.gateRegistry.getGate(inFlight.gateId);
        if (!def) {
          const blockedEvent: RunEvent = {
            schemaVersion: 1,
            eventId: deps.newEventId(),
            runId,
            sequence: currentSeq + 1,
            at: deps.now(),
            type: "run.blocked",
            payload: {
              reason: `QUALITY_RECOVERY_UNSAFE: Missing gate definition for in-flight gate '${inFlight.gateId}'`,
              requiredAction: "Verify quality gate configuration",
              causedByEventId: inFlight.eventId,
            },
          };
          await deps.events.append(blockedEvent, currentSeq);
          events = await deps.events.read(runId);
          return {
            kind: "blocked",
            state: replayRun(events),
            reason: blockedEvent.payload.reason,
          };
        }

        if (def.sideEffect === "workspace-write" && !def.retrySafe) {
          const blockedEvent: RunEvent = {
            schemaVersion: 1,
            eventId: deps.newEventId(),
            runId,
            sequence: currentSeq + 1,
            at: deps.now(),
            type: "run.blocked",
            payload: {
              reason: `QUALITY_RECOVERY_UNSAFE: Workspace-write gate '${inFlight.gateId}' is not retry-safe`,
              requiredAction: "Manual recovery required for non-retry-safe workspace modifications",
              causedByEventId: inFlight.eventId,
            },
          };
          await deps.events.append(blockedEvent, currentSeq);
          events = await deps.events.read(runId);
          return {
            kind: "blocked",
            state: replayRun(events),
            reason: blockedEvent.payload.reason,
          };
        }
      }
    }

    const inFlightEntry = startedGates.values().next().value;
    const previousOperationId = inFlightEntry?.opId ?? `quality-cycle-${cycleId}`;
    return {
      kind: "rerun",
      state,
      previousOperationId,
    };
  }

  return { kind: "continue", state };
}
