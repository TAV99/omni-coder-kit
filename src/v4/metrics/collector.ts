import type { RunEvent, RunId, EventId } from "../contracts";
import type { EvidenceBundleStore } from "../quality/evidence-bundle-store";
import type { NativeExecutionMetadata, NormalizedUsage } from "../contracts/step-result";
import type { AdapterIdentity, RunMetrics, RunMetricStatus } from "./contracts";
import type { RunState, RunPhase } from "../contracts/run";
import type { GateStatus, QualityDecision } from "../contracts/quality";

function decisionsMatch(a: QualityDecision, b: QualityDecision): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "advance" && b.kind === "advance") {
    return a.to === b.to;
  }
  if (a.kind === "repair" && b.kind === "repair") {
    return (
      a.to === b.to &&
      a.requirementIds.length === b.requirementIds.length &&
      a.requirementIds.every((id, idx) => id === b.requirementIds[idx])
    );
  }
  if (a.kind === "block" && b.kind === "block") {
    return a.reason === b.reason && a.requiredAction === b.requiredAction;
  }
  return false;
}

export interface MetricsCollectorInput {
  readonly runId: RunId;
  readonly events: readonly RunEvent[];
  readonly bundleStore?: EvidenceBundleStore | undefined;
  readonly nativeMetadata?: readonly NativeExecutionMetadata[] | undefined;
  readonly adapter?: AdapterIdentity | undefined;
  readonly state?: { readonly phase: RunPhase; readonly runId: RunId } | RunState | undefined;
}

export class MetricsCollector {
  static async collect(input: MetricsCollectorInput): Promise<RunMetrics> {
    const { runId } = input;
    const missingMetrics: string[] = [];

    // Filter events for this runId only (cross-run events ignored) and sort deterministically by sequence
    const runEvents = (input.events || [])
      .filter((e) => e.runId === runId)
      .slice()
      .sort((a, b) => a.sequence - b.sequence);

    // 0. Event Log Integrity check (duplicate sequence or duplicate eventId)
    const seenEventIds = new Set<string>();
    const seenSequences = new Set<number>();
    let eventLogIntegrityViolation = false;

    for (const ev of runEvents) {
      if (seenEventIds.has(ev.eventId)) {
        eventLogIntegrityViolation = true;
      }
      seenEventIds.add(ev.eventId);

      if (seenSequences.has(ev.sequence)) {
        eventLogIntegrityViolation = true;
      }
      seenSequences.add(ev.sequence);
    }

    if (eventLogIntegrityViolation) {
      missingMetrics.push("eventLog.integrity");
    }

    // 1. Pass 1: Validate Quality Cycles
    type QualityStartedEvent = Extract<RunEvent, { type: "quality.started" }>;
    type QualityCompletedEvent = Extract<RunEvent, { type: "quality.completed" }>;

    const qualityStartedByCycle = new Map<string, QualityStartedEvent[]>();
    const qualityCompletedByCycle = new Map<string, QualityCompletedEvent[]>();

    for (const ev of runEvents) {
      if (ev.type === "quality.started") {
        const list = qualityStartedByCycle.get(ev.payload.cycleId) ?? [];
        list.push(ev);
        qualityStartedByCycle.set(ev.payload.cycleId, list);
      } else if (ev.type === "quality.completed") {
        const list = qualityCompletedByCycle.get(ev.payload.cycleId) ?? [];
        list.push(ev);
        qualityCompletedByCycle.set(ev.payload.cycleId, list);
      }
    }

    let wallClockMs = 0;
    const validQualityStartTimes = new Map<string, number>();
    const validQualityCompleted = new Map<
      string,
      { eventId: EventId; decision: QualityDecision; at: string; sequence: number }
    >();
    let hasDuplicateQualityLifecycle = false;

    // Collect all cycle IDs present
    const allCycleIds = new Set<string>([
      ...Array.from(qualityStartedByCycle.keys()),
      ...Array.from(qualityCompletedByCycle.keys()),
    ]);

    for (const cycleId of allCycleIds) {
      const starts = qualityStartedByCycle.get(cycleId) ?? [];
      const completions = qualityCompletedByCycle.get(cycleId) ?? [];

      if (starts.length > 1 || completions.length > 1) {
        hasDuplicateQualityLifecycle = true;
        missingMetrics.push(`quality.${cycleId}.duplicate_lifecycle`);
        // Invalid cycle: does not contribute to wallClock and cannot serve as queue baseline
        continue;
      }

      if (starts.length === 1 && completions.length === 1) {
        const sEv = starts[0]!;
        const cEv = completions[0]!;
        const sTime = new Date(sEv.payload.startedAt || sEv.at).getTime();
        const cTime = new Date(cEv.payload.completedAt || cEv.at).getTime();

        if (isNaN(sTime) || isNaN(cTime) || cTime < sTime || cEv.sequence < sEv.sequence) {
          missingMetrics.push(`quality.${cycleId}.invalid_time`);
          // Invalid timestamps: do not contribute to wallClock
          continue;
        }

        // Valid cycle
        wallClockMs += cTime - sTime;
        validQualityStartTimes.set(cycleId, sTime);
        validQualityCompleted.set(cycleId, {
          eventId: cEv.eventId,
          decision: cEv.payload.decision,
          at: cEv.payload.completedAt || cEv.at,
          sequence: cEv.sequence,
        });
      } else if (starts.length === 1) {
        const sEv = starts[0]!;
        const sTime = new Date(sEv.payload.startedAt || sEv.at).getTime();
        if (isNaN(sTime)) {
          missingMetrics.push(`quality.${cycleId}.invalid_time`);
        }
      }
    }

    // 2. Event counters (Reliability counts)
    let retryCount = 0;
    let repairCount = 0;
    let resumeCount = 0;
    let userInterventionCount = 0;

    for (const ev of runEvents) {
      if (ev.type === "step.failed") {
        retryCount++;
      } else if (ev.type === "repair.decided") {
        repairCount++;
      } else if (ev.type === "policy.decided" && ev.payload.stage === "resume") {
        resumeCount++;
      } else if (ev.type === "run.blocked") {
        userInterventionCount++;
      }
    }

    // 3. Pass 2: Validate Gate Lifecycles per Gate Key
    type GateStartedEvent = Extract<RunEvent, { type: "gate.started" }>;
    type GateCompletedEvent = Extract<RunEvent, { type: "gate.completed" }>;

    const gateStartedByKey = new Map<string, GateStartedEvent[]>();
    const gateCompletedByKey = new Map<string, GateCompletedEvent[]>();

    for (const ev of runEvents) {
      if (ev.type === "gate.started") {
        const key = `${ev.payload.cycleId}:${ev.payload.gateId}:${ev.payload.operationId}`;
        const list = gateStartedByKey.get(key) ?? [];
        list.push(ev);
        gateStartedByKey.set(key, list);
      } else if (ev.type === "gate.completed") {
        const res = ev.payload.result;
        const key = `${res.cycleId}:${res.gateId}:${res.operationId}`;
        const list = gateCompletedByKey.get(key) ?? [];
        list.push(ev);
        gateCompletedByKey.set(key, list);
      }
    }

    const gateCounts: Record<GateStatus, number> = {
      passed: 0,
      failed: 0,
      skipped: 0,
      inconclusive: 0,
    };
    let summedGateDurationMs = 0;
    let gateQueueMs = 0;

    interface GateInterval {
      readonly start: number;
      readonly end: number;
    }
    const gateIntervals: GateInterval[] = [];

    const allGateKeys = new Set<string>([
      ...Array.from(gateStartedByKey.keys()),
      ...Array.from(gateCompletedByKey.keys()),
    ]);

    for (const key of allGateKeys) {
      const starts = gateStartedByKey.get(key) ?? [];
      const completions = gateCompletedByKey.get(key) ?? [];
      const parts = key.split(":");
      const cycleId = parts[0] || "";
      const gateId = parts[1] || "unknown";

      // 3a. Gate status count & duration: counted exactly once if at least one completion exists
      if (completions.length >= 1) {
        const primaryComp = completions[0]!;
        const status = primaryComp.payload.result.status;
        if (gateCounts[status] !== undefined) {
          gateCounts[status]++;
        }
        summedGateDurationMs += primaryComp.payload.result.durationMs;
      }

      // 3b. Validate anomalies
      let keyInvalidForInterval = false;

      if (starts.length > 1) {
        missingMetrics.push(`gate.${gateId}.duplicate_start`);
        keyInvalidForInterval = true;
      }
      if (completions.length > 1) {
        missingMetrics.push(`gate.${gateId}.duplicate_completion`);
        keyInvalidForInterval = true;
      }

      if (starts.length === 0 && completions.length >= 1) {
        if (completions[0]!.payload.result.status !== "skipped") {
          missingMetrics.push(`gate.${gateId}.unmatched_start`);
        }
        keyInvalidForInterval = true;
      }

      if (starts.length >= 1 && completions.length === 0) {
        missingMetrics.push(`gate.${gateId}.incomplete`);
        keyInvalidForInterval = true;
      }

      if (!keyInvalidForInterval && starts.length === 1 && completions.length === 1) {
        const sEv = starts[0]!;
        const cEv = completions[0]!;
        const startAt = new Date(sEv.payload.startedAt || sEv.at).getTime();
        const endAt = new Date(cEv.at).getTime();

        if (isNaN(startAt) || isNaN(endAt)) {
          missingMetrics.push(`gate.${gateId}.invalid_time`);
          keyInvalidForInterval = true;
        } else if (endAt < startAt || cEv.sequence < sEv.sequence) {
          missingMetrics.push(`gate.${gateId}.completion_before_start`);
          keyInvalidForInterval = true;
        } else {
          // Valid matched interval
          gateIntervals.push({ start: startAt, end: endAt });

          // Calculate queue from baseline quality start
          const qStart = validQualityStartTimes.get(cycleId);
          if (qStart !== undefined) {
            if (startAt >= qStart) {
              gateQueueMs += startAt - qStart;
            } else {
              missingMetrics.push(`gate.${gateId}.invalid_time`);
            }
          } else {
            missingMetrics.push(`gate.${gateId}.queue`);
          }
        }
      }
    }

    // Peak parallelism sweep-line algorithm (deterministic with tie-break completion before start)
    let peakParallelism = 0;
    if (gateIntervals.length > 0) {
      interface SweepPoint {
        readonly time: number;
        readonly type: "start" | "end";
      }
      const points: SweepPoint[] = [];
      for (const interval of gateIntervals) {
        points.push({ time: interval.start, type: "start" });
        points.push({ time: interval.end, type: "end" });
      }

      points.sort((a, b) => {
        if (a.time !== b.time) {
          return a.time - b.time;
        }
        // At the exact same timestamp: tie-break 'end' before 'start'
        if (a.type === "end" && b.type === "start") return -1;
        if (a.type === "start" && b.type === "end") return 1;
        return 0;
      });

      let currentParallel = 0;
      for (const p of points) {
        if (p.type === "start") {
          currentParallel++;
          if (currentParallel > peakParallelism) {
            peakParallelism = currentParallel;
          }
        } else {
          currentParallel = Math.max(0, currentParallel - 1);
        }
      }
    }

    // Measured Speedup
    let measuredSpeedup: number | undefined;
    if (wallClockMs > 0 && summedGateDurationMs > 0) {
      measuredSpeedup = Number((summedGateDurationMs / wallClockMs).toFixed(4));
    } else {
      missingMetrics.push("measuredSpeedup");
    }

    // 4. Native Identity & Usage Aggregation with conflict handling
    const nativeList = input.nativeMetadata ?? [];

    const collectField = (
      fieldName: "model" | "cliVersion" | "sessionId",
      adapterVal?: string
    ): string | undefined => {
      const values = new Set<string>();
      if (adapterVal) values.add(adapterVal);
      for (const meta of nativeList) {
        const v = meta[fieldName];
        if (v !== undefined && v !== "") {
          values.add(v);
        }
      }
      if (values.size > 1) {
        missingMetrics.push(`adapter.${fieldName}`);
        return undefined;
      }
      if (values.size === 1) {
        return Array.from(values)[0];
      }
      missingMetrics.push(`adapter.${fieldName}`);
      return undefined;
    };

    const adapterName = input.adapter?.name;
    if (!adapterName) {
      missingMetrics.push("adapter.name");
    }

    const resolvedModel = collectField("model", input.adapter?.model);
    const resolvedCliVersion = collectField("cliVersion", input.adapter?.cliVersion);
    const resolvedSessionId = collectField("sessionId", input.adapter?.sessionId);

    let adapter: AdapterIdentity | undefined;
    if (adapterName) {
      adapter = {
        name: adapterName,
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(resolvedCliVersion ? { cliVersion: resolvedCliVersion } : {}),
        ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
      };
    }

    // Usage aggregation (absent remains undefined, never zeroed)
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cachedInputTokens: number | undefined;
    let totalTokens: number | undefined;
    let costUsd: number | undefined;

    for (const meta of nativeList) {
      if (meta.usage) {
        if (meta.usage.inputTokens !== undefined) {
          inputTokens = (inputTokens ?? 0) + meta.usage.inputTokens;
        }
        if (meta.usage.outputTokens !== undefined) {
          outputTokens = (outputTokens ?? 0) + meta.usage.outputTokens;
        }
        if (meta.usage.cachedInputTokens !== undefined) {
          cachedInputTokens = (cachedInputTokens ?? 0) + meta.usage.cachedInputTokens;
        }
        if (meta.usage.totalTokens !== undefined) {
          totalTokens = (totalTokens ?? 0) + meta.usage.totalTokens;
        }
        if (meta.usage.costUsd !== undefined) {
          costUsd = (costUsd ?? 0) + meta.usage.costUsd;
        }
      }
    }

    if (inputTokens === undefined) missingMetrics.push("usage.inputTokens");
    if (outputTokens === undefined) missingMetrics.push("usage.outputTokens");
    if (cachedInputTokens === undefined) missingMetrics.push("usage.cachedInputTokens");
    if (totalTokens === undefined) missingMetrics.push("usage.totalTokens");
    if (costUsd === undefined) missingMetrics.push("usage.costUsd");

    const hasAnyUsage =
      inputTokens !== undefined ||
      outputTokens !== undefined ||
      cachedInputTokens !== undefined ||
      totalTokens !== undefined ||
      costUsd !== undefined;

    let usage: NormalizedUsage | undefined;
    if (hasAnyUsage) {
      usage = {
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(totalTokens !== undefined ? { totalTokens } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    }

    // 5. Reported Status
    let finalPhase: string | undefined;
    if (input.state) {
      if (input.state.runId === runId) {
        finalPhase = input.state.phase;
      } else {
        missingMetrics.push("state.runId");
      }
    }

    if (!finalPhase && runEvents.length > 0) {
      for (let i = runEvents.length - 1; i >= 0; i--) {
        const ev = runEvents[i]!;
        if (ev.type === "run.blocked") {
          finalPhase = "BLOCKED";
          break;
        }
        if (ev.type === "run.cancelled") {
          finalPhase = "CANCELLED";
          break;
        }
        if (ev.type === "run.routed") {
          finalPhase = ev.payload.to;
          break;
        }
        if (ev.type === "run.transitioned") {
          finalPhase = ev.payload.to;
          break;
        }
      }
    }

    let reportedStatus: RunMetricStatus;
    if (finalPhase === "DOCUMENT" || finalPhase === "READY") {
      reportedStatus = "succeeded";
    } else if (
      finalPhase === "FIX" ||
      finalPhase === "REWORK" ||
      finalPhase === "BLOCKED" ||
      finalPhase === "CANCELLED"
    ) {
      reportedStatus = "failed";
    } else {
      reportedStatus = "inconclusive";
    }

    // 6. Actual Status (Exact / Latest Causation & Fail-Closed)
    const allQualityStarted = runEvents.filter(
      (e): e is Extract<RunEvent, { type: "quality.started" }> => e.type === "quality.started"
    );

    let actualStatus: RunMetricStatus = "inconclusive";

    const hasBlockedOrCancelled = runEvents.some(
      (e) => e.type === "run.blocked" || e.type === "run.cancelled"
    );
    const hasRepairDecided = runEvents.some((e) => e.type === "repair.decided");
    const hasGateFailed = gateCounts.failed > 0;

    if (eventLogIntegrityViolation || hasDuplicateQualityLifecycle) {
      // Corrupt/ambiguous lifecycle or event log integrity violation fails closed
      actualStatus = "inconclusive";
    } else if (allQualityStarted.length === 0) {
      if (
        hasBlockedOrCancelled ||
        hasRepairDecided ||
        finalPhase === "BLOCKED" ||
        finalPhase === "CANCELLED" ||
        finalPhase === "FIX" ||
        finalPhase === "REWORK"
      ) {
        actualStatus = "failed";
      } else {
        actualStatus = "inconclusive";
      }
    } else {
      const latestQualityStarted = allQualityStarted[allQualityStarted.length - 1]!;
      const latestCycleId = latestQualityStarted.payload.cycleId;
      const latestPhase = latestQualityStarted.payload.phase;

      if (latestPhase !== "ACCEPT") {
        if (
          hasGateFailed ||
          hasRepairDecided ||
          hasBlockedOrCancelled ||
          finalPhase === "BLOCKED" ||
          finalPhase === "CANCELLED" ||
          finalPhase === "FIX" ||
          finalPhase === "REWORK"
        ) {
          actualStatus = "failed";
        } else {
          actualStatus = "inconclusive";
        }
      } else {
        const qualityCompletedInfo = validQualityCompleted.get(latestCycleId);
        if (!qualityCompletedInfo) {
          actualStatus = "inconclusive";
        } else if (!input.bundleStore) {
          actualStatus = "inconclusive";
        } else {
          let bundlePassed = false;
          let bundleRejected = false;
          let bundleError = false;

          try {
            const bundle = await input.bundleStore.readBundle(runId, latestCycleId);
            if (bundle.runId !== runId || bundle.cycleId !== latestCycleId) {
              bundleError = true;
            } else {
              const qDec = qualityCompletedInfo.decision;
              const bDec = bundle.decision;
              const decisionMatched = decisionsMatch(qDec, bDec);

              if (!decisionMatched) {
                bundleError = true;
              } else if (bundle.verdicts.length === 0) {
                bundleRejected = true;
              } else if (bundle.verdicts.some((v) => v.status === "rejected")) {
                bundleRejected = true;
              } else if (
                bundle.verdicts.every(
                  (v) => v.status === "accepted" && v.evidenceIds && v.evidenceIds.length > 0
                ) &&
                bDec.kind === "advance" &&
                bDec.to === "DOCUMENT"
              ) {
                bundlePassed = true;
              } else {
                bundleError = true;
              }
            }
          } catch {
            bundleError = true;
          }

          if (bundleError) {
            actualStatus = "inconclusive";
          } else if (bundleRejected) {
            actualStatus = "failed";
          } else if (bundlePassed) {
            const qCompAt = new Date(qualityCompletedInfo.at).getTime();
            const routedEvent = runEvents.find(
              (e) =>
                e.type === "run.routed" &&
                e.payload.from === "ACCEPT" &&
                e.payload.to === "DOCUMENT" &&
                e.payload.causedByEventId === qualityCompletedInfo.eventId &&
                new Date(e.at).getTime() >= qCompAt &&
                e.sequence > qualityCompletedInfo.sequence
            );

            if (routedEvent) {
              actualStatus = "succeeded";
            } else {
              actualStatus = "inconclusive";
            }
          } else {
            actualStatus = "inconclusive";
          }
        }
      }
    }

    const falseSuccess = actualStatus !== "succeeded" && reportedStatus === "succeeded";
    const falseFailure = actualStatus === "succeeded" && reportedStatus === "failed";

    const uniqueMissingMetrics = Array.from(new Set(missingMetrics)).sort();

    return {
      schemaVersion: 1,
      runId,
      actualStatus,
      reportedStatus,
      falseSuccess,
      falseFailure,
      gateCounts,
      retryCount,
      repairCount,
      resumeCount,
      userInterventionCount,
      wallClockMs,
      summedGateDurationMs,
      gateQueueMs,
      peakParallelism,
      ...(measuredSpeedup !== undefined ? { measuredSpeedup } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(adapter !== undefined ? { adapter } : {}),
      missingMetrics: uniqueMissingMetrics,
    };
  }
}
