import crypto from "node:crypto";
import type { EventStore } from "../storage/event-store";
import {
  canonicalJsonStringify,
  type EvidenceBundle,
  type EvidenceBundleStorePort,
} from "./evidence-bundle-store";
import type { GateRegistry } from "./gate-registry";
import type { GateRunner } from "./gate-runner";
import type {
  AcceptanceEngine,
  AgentJudgement,
} from "./acceptance-engine";
import type { RepairPolicy } from "./repair-policy";
import type { AgentJudge } from "./agent-judge";
import type { ProcessRunner } from "../process/types";
import type { AgentAdapter } from "../contracts/adapter";
import { GateScheduler, type GateScheduleResult } from "./gate-scheduler";
import {
  asEventId,
  asQualityCycleId,
  asStepId,
  type EventId,
  type GateId,
  type GateResult,
  type QualityCycleId,
  type QualityDecision,
  type QualityEvidence,
  type QualityEvidenceId,
  type RequirementId,
  type RequirementVerdict,
  type RouteIntent,
  type RepairHistoryEntry,
  type RunEvent,
  type RunId,
} from "../contracts";
import { QualityError } from "./errors";

export interface QualityCoordinatorDeps {
  readonly projectRoot: string;
  readonly events: EventStore;
  readonly bundles: EvidenceBundleStorePort;
  readonly registry: GateRegistry;
  readonly gateRunner: GateRunner;
  readonly acceptanceEngine: AcceptanceEngine;
  readonly repairPolicy: RepairPolicy;
  readonly scheduler?: GateScheduler | undefined;
  readonly agentJudge?: AgentJudge | undefined;
  readonly processRunner: ProcessRunner;
  readonly adapter?: AgentAdapter | undefined;
  readonly now?: (() => string) | undefined;
  readonly newEventId?: (() => EventId) | undefined;
  readonly newQualityCycleId?: (() => QualityCycleId) | undefined;
}

export interface QualityCycleRunResult {
  readonly decision: QualityDecision;
  readonly bundle?: EvidenceBundle | undefined;
  readonly scheduleResult: GateScheduleResult;
}

export class QualityCoordinator {
  private readonly deps: QualityCoordinatorDeps;
  private readonly scheduler: GateScheduler;

  constructor(deps: QualityCoordinatorDeps) {
    this.deps = deps;
    this.scheduler = deps.scheduler ?? new GateScheduler({ maxParallelGates: 2 });
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  private nextEventId(): EventId {
    return this.deps.newEventId
      ? this.deps.newEventId()
      : asEventId(`ev-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  }

  private nextCycleId(): QualityCycleId {
    return this.deps.newQualityCycleId
      ? this.deps.newQualityCycleId()
      : asQualityCycleId(`qc-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  }

  async runCycle(
    runId: RunId,
    phase: "VERIFY" | "ACCEPT",
    repairAttempt = 0,
    maxRepairs = 2
  ): Promise<QualityCycleRunResult> {
    const cycleId = this.nextCycleId();

    // Serialize all event appends to avoid sequence conflicts under concurrent gates
    let appendLock = Promise.resolve();
    const emitEvent = (factory: (sequence: number) => RunEvent): Promise<RunEvent> => {
      const p = appendLock.then(async () => {
        const history = await this.deps.events.read(runId);
        const lastSeq = history.length > 0 ? history[history.length - 1]!.sequence : -1;
        const ev = factory(lastSeq + 1);
        await this.deps.events.append(ev, lastSeq);
        return ev;
      });
      appendLock = p.then(() => {}, () => {});
      return p;
    };

    // 0. Check durable event history and validate exact prior authorized bundle BEFORE quality.started / scheduler / judge
    const initialHistory = await this.deps.events.read(runId);
    const priorCompletedEvents = initialHistory.filter(
      (e): e is RunEvent & { type: "quality.completed" } => e.type === "quality.completed"
    );

    let previousRepairHistory: readonly RepairHistoryEntry[] = [];
    if (priorCompletedEvents.length > 0) {
      const lastPriorCompleted = priorCompletedEvents[priorCompletedEvents.length - 1]!;
      const priorCycleId = lastPriorCompleted.payload.cycleId;
      try {
        const prevBundle = await this.deps.bundles.readBundle(runId, priorCycleId);
        if (prevBundle && Array.isArray(prevBundle.repairHistory)) {
          previousRepairHistory = prevBundle.repairHistory;
        } else {
          throw new QualityError(
            "GATE_EVIDENCE_INVALID",
            `Prior quality evidence bundle for cycle '${priorCycleId}' is missing repair history`
          );
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const blockingDecision: QualityDecision = {
          kind: "block",
          reason: `GATE_EVIDENCE_INVALID: Failed to read prior authorized quality cycle bundle '${priorCycleId}': ${errMsg}`,
          requiredAction: "Inspect prior evidence bundle storage and resolve corruption",
        };

        await emitEvent((sequence) => ({
          schemaVersion: 1,
          eventId: this.nextEventId(),
          runId,
          sequence,
          at: this.now(),
          type: "run.blocked",
          payload: {
            reason: blockingDecision.reason,
            requiredAction: blockingDecision.requiredAction,
            causedByEventId: lastPriorCompleted.eventId,
          },
        }));

        return {
          decision: blockingDecision,
          scheduleResult: {
            results: new Map(),
            evidences: new Map(),
            peakParallelism: 0,
            totalQueueMs: 0,
          },
        };
      }
    }

    // 1. Emit quality.started (only after prior history is validated)
    await emitEvent((sequence) => ({
      schemaVersion: 1,
      eventId: this.nextEventId(),
      runId,
      sequence,
      at: this.now(),
      type: "quality.started",
      payload: {
        cycleId,
        phase,
        startedAt: this.now(),
      },
    }));

    // 2. Select gates for current phase
    const allGates = this.deps.registry.getAllGates();
    const phaseGates = allGates.filter((g) => {
      if (phase === "VERIFY") {
        return g.sideEffect === "read-only";
      }
      return true;
    });

    // 3. Run gates via GateScheduler
    const scheduleResult: GateScheduleResult = await this.scheduler.schedule(phaseGates, {
      cycleId,
      runId,
      runner: this.deps.processRunner,
      gateRunner: this.deps.gateRunner,
      projectRoot: this.deps.projectRoot,
      now: this.deps.now,
      onGateStarted: async (gate, operationId) => {
        await emitEvent((sequence) => ({
          schemaVersion: 1,
          eventId: this.nextEventId(),
          runId,
          sequence,
          at: this.now(),
          type: "gate.started",
          payload: {
            cycleId,
            gateId: gate.id,
            operationId,
            startedAt: this.now(),
          },
        }));
      },
      onGateCompleted: async (result, evidence) => {
        await emitEvent((sequence) => {
          const payload: { result: GateResult; evidence?: QualityEvidence } = {
            result,
          };
          if (evidence) {
            payload.evidence = evidence;
          }
          return {
            schemaVersion: 1,
            eventId: this.nextEventId(),
            runId,
            sequence,
            at: this.now(),
            type: "gate.completed",
            payload,
          };
        });
      },
    });

    // Stable sort in declaration order for evidence bundle
    const gateResults: GateResult[] = [];
    const gateEvidences: QualityEvidence[] = [];
    for (const gate of allGates) {
      const res = scheduleResult.results.get(gate.id);
      if (res) {
        gateResults.push(res);
      }
      const ev = scheduleResult.evidences.get(gate.id);
      if (ev) {
        gateEvidences.push(ev);
      }
    }

    // 4. Group gate results by requirement with trusted mandatory property from definition
    const gateResultsByReq = new Map<RequirementId, GateResult[]>();
    for (const gate of allGates) {
      const res = scheduleResult.results.get(gate.id);
      if (res) {
        const trustedRes: GateResult = {
          ...res,
          mandatory: gate.mandatory,
        };
        for (const reqId of gate.requirementIds) {
          let list = gateResultsByReq.get(reqId);
          if (!list) {
            list = [];
            gateResultsByReq.set(reqId, list);
          }
          list.push(trustedRes);
        }
      }
    }

    // Optional Agent Judgement for agent-strategy requirements
    const agentJudgements = new Map<RequirementId, AgentJudgement>();
    if (phase === "ACCEPT" && this.deps.agentJudge && this.deps.adapter) {
      const allRequirements = this.deps.registry.getAllRequirements();
      for (const req of allRequirements) {
        if (req.testStrategy.kind === "agent") {
          try {
            const judgement = await this.deps.agentJudge.judgeRequirement(req, {
              runId,
              cycleId,
              stepId: asStepId(`judge-${cycleId}-${req.requirementId}`),
              operationId: `judge-op-${cycleId}-${req.requirementId}`,
              workspaceDir: this.deps.projectRoot,
              adapter: this.deps.adapter,
              existingEvidence: gateEvidences,
            });
            agentJudgements.set(req.requirementId, judgement);
          } catch {
            agentJudgements.set(req.requirementId, {
              status: "inconclusive",
              evidenceIds: [],
              rationale: "Agent judgement failed or threw an error",
            });
          }
        }
      }
    }

    // 5. Evaluate all requirements with evidence correlation
    const allRequirements = this.deps.registry.getAllRequirements();
    const verdicts = this.deps.acceptanceEngine.evaluateAll(
      allRequirements,
      gateResultsByReq,
      gateEvidences,
      { runId, cycleId },
      agentJudgements
    );

    // 6. Emit requirement.evaluated for each requirement
    for (const verdict of verdicts) {
      await emitEvent((sequence) => ({
        schemaVersion: 1,
        eventId: this.nextEventId(),
        runId,
        sequence,
        at: this.now(),
        type: "requirement.evaluated",
        payload: {
          verdict,
        },
      }));
    }

    // 7. Decide cycle outcome via RepairPolicy with pre-validated prior history and observation
    const failingVerdicts = verdicts.filter((v) => v.status !== "accepted");
    let decision: QualityDecision;
    let repairHistory: RepairHistoryEntry[] = [...previousRepairHistory];
    let nextAttemptNum = repairAttempt + 1;

    if (failingVerdicts.length === 0) {
      decision = {
        kind: "advance",
        to: phase === "VERIFY" ? "ACCEPT" : "DOCUMENT",
      };
    } else {
      const failingIds = failingVerdicts.map((v) => v.requirementId);
      const repDec = this.deps.repairPolicy.decideRepair({
        cycleId,
        phase,
        failingRequirements: failingIds,
        failingVerdicts,
        failingGateEvidences: gateEvidences,
        priorRepairHistory: previousRepairHistory,
        currentAttempt: repairAttempt,
        now: this.now(),
      });
      if (repDec.action === "repair") {
        decision = {
          kind: "repair",
          to: repDec.targetPhase,
          requirementIds: repDec.requirementIds,
        };
        repairHistory = [...repDec.newHistory];
        nextAttemptNum = repDec.nextAttempt;
      } else if (repDec.action === "block") {
        decision = {
          kind: "block",
          reason: repDec.reason,
          requiredAction: "Resolve failing quality requirements and resume run",
        };
      } else {
        decision = {
          kind: "block",
          reason: "Quality check failed",
          requiredAction: "Resolve failing requirements and resume run",
        };
      }
    }

    // 8. Emit durable quality.completed event first!
    const qualityCompletedEvent = await emitEvent((sequence) => ({
      schemaVersion: 1,
      eventId: this.nextEventId(),
      runId,
      sequence,
      at: this.now(),
      type: "quality.completed",
      payload: {
        cycleId,
        decision,
        completedAt: this.now(),
      },
    }));

    // 9. If repair decision, emit durable repair.decided event!
    let repairDecidedEvent: RunEvent | undefined;
    if (decision.kind === "repair") {
      repairDecidedEvent = await emitEvent((sequence) => ({
        schemaVersion: 1,
        eventId: this.nextEventId(),
        runId,
        sequence,
        at: this.now(),
        type: "repair.decided",
        payload: {
          cycleId,
          requirementIds: decision.requirementIds,
          attempt: nextAttemptNum,
          reason: "Quality cycle requested repairs",
        },
      }));
    }

    // 10. Construct RouteIntent citing exact durable cause event
    let routeIntent: RouteIntent;
    if (decision.kind === "advance") {
      routeIntent = {
        kind: "advance",
        from: phase,
        to: decision.to,
        causedByEventId: qualityCompletedEvent.eventId,
      };
    } else if (decision.kind === "repair") {
      routeIntent = {
        kind: "repair",
        from: phase,
        to: decision.to,
        requirementIds: decision.requirementIds,
        attempt: nextAttemptNum,
        causedByEventId: repairDecidedEvent!.eventId,
      };
    } else {
      routeIntent = {
        kind: "block",
        from: phase,
        reason: decision.reason,
        requiredAction: decision.requiredAction,
        causedByEventId: qualityCompletedEvent.eventId,
      };
    }

    // 11. Construct complete EvidenceBundle containing exact routeIntent and accumulated repairHistory
    const configHash = this.deps.registry.getConfigHash();
    const requirementsHash = this.deps.registry.getRequirementsHash();

    const bundle: EvidenceBundle = {
      schemaVersion: 1,
      runId,
      cycleId,
      phase,
      configHash,
      requirementsHash,
      generatedAt: this.now(),
      gates: gateResults,
      evidence: gateEvidences,
      verdicts,
      repairHistory,
      decision,
      routeIntent,
    };

    // 12. Persist authorized bundle and re-read/verify authorized run-level pair
    try {
      await this.deps.bundles.writeBundle(bundle);
      const authorizedReadBack = await this.deps.bundles.readBundle(runId, cycleId);

      const expectedCanonical = canonicalJsonStringify(bundle);
      const readBackCanonical = canonicalJsonStringify(authorizedReadBack);
      if (expectedCanonical !== readBackCanonical) {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          "Authorized bundle read-back content mismatch against written bundle"
        );
      }
    } catch (persistErr: unknown) {
      const errMsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
      const blockingDecision: QualityDecision = {
        kind: "block",
        reason: `GATE_EVIDENCE_INVALID: Evidence bundle persistence/verification failed: ${errMsg}`,
        requiredAction: "Resolve evidence bundle storage failure and retry quality cycle",
      };

      await emitEvent((sequence) => ({
        schemaVersion: 1,
        eventId: this.nextEventId(),
        runId,
        sequence,
        at: this.now(),
        type: "run.blocked",
        payload: {
          reason: blockingDecision.reason,
          requiredAction: blockingDecision.requiredAction,
          causedByEventId: qualityCompletedEvent.eventId,
        },
      }));

      return {
        decision: blockingDecision,
        scheduleResult,
      };
    }

    // 13. Only now that bundle is verified durable on disk, emit run.routed (or run.blocked if block)
    if (decision.kind === "advance") {
      await emitEvent((sequence) => ({
        schemaVersion: 1,
        eventId: this.nextEventId(),
        runId,
        sequence,
        at: this.now(),
        type: "run.routed",
        payload: {
          from: phase,
          to: decision.to,
          causedByEventId: qualityCompletedEvent.eventId,
        },
      }));
    } else if (decision.kind === "repair") {
      await emitEvent((sequence) => ({
        schemaVersion: 1,
        eventId: this.nextEventId(),
        runId,
        sequence,
        at: this.now(),
        type: "run.routed",
        payload: {
          from: phase,
          to: decision.to,
          causedByEventId: repairDecidedEvent!.eventId,
        },
      }));
    } else if (decision.kind === "block") {
      await emitEvent((sequence) => ({
        schemaVersion: 1,
        eventId: this.nextEventId(),
        runId,
        sequence,
        at: this.now(),
        type: "run.blocked",
        payload: {
          reason: decision.reason,
          requiredAction: decision.requiredAction,
          causedByEventId: qualityCompletedEvent.eventId,
        },
      }));
    }

    return { decision, bundle, scheduleResult };
  }
}
