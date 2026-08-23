import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MetricsCollector } from "../../src/v4/metrics/collector";
import {
  asEventId,
  asGateId,
  asQualityCycleId,
  asQualityEvidenceId,
  asRequirementId,
  asRunId,
  asStepId,
  type RunEvent,
} from "../../src/v4/contracts";
import {
  EvidenceBundleStore,
  type EvidenceBundle,
} from "../../src/v4/quality/evidence-bundle-store";
import type { NativeExecutionMetadata } from "../../src/v4/contracts/step-result";
import { RunMetricsSchema } from "../../src/v4/metrics/contracts";

test("completion_metrics", async () => {
  // R60: Metrics include actual status, reported status, false-success, and false-failure
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-metrics-test-"));
  const store = new EvidenceBundleStore({ projectRoot: tmpDir });
  const runId = asRunId("run-cm-1");
  const cycleId = asQualityCycleId("cycle-1");

  // 1. Success case: Valid persisted bundle in ACCEPT + matching quality.completed & run.routed to DOCUMENT
  const validBundle: EvidenceBundle = {
    schemaVersion: 1,
    runId,
    cycleId,
    phase: "ACCEPT",
    configHash: "a".repeat(64),
    requirementsHash: "b".repeat(64),
    generatedAt: "2026-08-20T10:00:05.000Z",
    gates: [
      {
        schemaVersion: 1,
        cycleId,
        gateId: asGateId("gate-1"),
        operationId: "op-1",
        status: "passed",
        evidenceId: asQualityEvidenceId("ev-1"),
        startedAt: "2026-08-20T10:00:00.000Z",
        durationMs: 500,
      },
    ],
    evidence: [
      {
        schemaVersion: 1,
        evidenceId: asQualityEvidenceId("ev-1"),
        runId,
        cycleId,
        gateId: asGateId("gate-1"),
        operationId: "op-1",
        command: ["npm", "test"],
        cwd: ".",
        timeoutMs: 5000,
        termination: "exited",
        exitCode: 0,
        startedAt: "2026-08-20T10:00:00.000Z",
        durationMs: 500,
        stdoutSummary: "ok",
        stderrSummary: "",
        stdoutSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        stderrSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        artifactIds: [],
      },
    ],
    verdicts: [
      {
        requirementId: asRequirementId("R1"),
        status: "accepted",
        evidenceIds: [asQualityEvidenceId("ev-1")],
        rationale: "All passed",
      },
    ],
    repairHistory: [],
    decision: { kind: "advance", to: "DOCUMENT" },
    routeIntent: {
      kind: "advance",
      from: "ACCEPT",
      to: "DOCUMENT",
      causedByEventId: asEventId("ev-1"),
    },
  };

  await store.writeBundle(validBundle);

  const successEvents: RunEvent[] = [
    {
      schemaVersion: 1,
      eventId: asEventId("ev-start"),
      runId,
      sequence: 0,
      at: "2026-08-20T10:00:00.000Z",
      type: "quality.started",
      payload: {
        cycleId,
        phase: "ACCEPT",
        startedAt: "2026-08-20T10:00:00.000Z",
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-complete"),
      runId,
      sequence: 1,
      at: "2026-08-20T10:00:05.000Z",
      type: "quality.completed",
      payload: {
        cycleId,
        decision: { kind: "advance", to: "DOCUMENT" },
        completedAt: "2026-08-20T10:00:05.000Z",
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-route"),
      runId,
      sequence: 2,
      at: "2026-08-20T10:00:06.000Z",
      type: "run.routed",
      payload: {
        from: "ACCEPT",
        to: "DOCUMENT",
        causedByEventId: asEventId("ev-complete"),
      },
    },
  ];

  const successMetrics = await MetricsCollector.collect({
    runId,
    events: successEvents,
    bundleStore: store,
    state: { phase: "DOCUMENT", runId },
  });

  assert.equal(successMetrics.actualStatus, "succeeded");
  assert.equal(successMetrics.reportedStatus, "succeeded");
  assert.equal(successMetrics.falseSuccess, false);
  assert.equal(successMetrics.falseFailure, false);
  RunMetricsSchema.parse(successMetrics);

  // 2. Adversarial: Raw bundle / No-store quality cannot certify success -> inconclusive
  const noStoreMetrics = await MetricsCollector.collect({
    runId,
    events: successEvents,
    // bundleStore omitted!
    state: { phase: "DOCUMENT", runId },
  });
  assert.equal(noStoreMetrics.actualStatus, "inconclusive");

  // 3. Adversarial: Stale old ACCEPT success cannot win over newer incomplete or rejected cycle
  const cycle2 = asQualityCycleId("cycle-2");
  const staleEvents: RunEvent[] = [
    ...successEvents,
    {
      schemaVersion: 1,
      eventId: asEventId("ev-start-c2"),
      runId,
      sequence: 3,
      at: "2026-08-20T10:01:00.000Z",
      type: "quality.started",
      payload: {
        cycleId: cycle2,
        phase: "VERIFY",
        startedAt: "2026-08-20T10:01:00.000Z",
      },
    },
  ];
  const staleMetrics = await MetricsCollector.collect({
    runId,
    events: staleEvents,
    bundleStore: store,
    state: { phase: "DOCUMENT", runId },
  });
  assert.equal(staleMetrics.actualStatus, "inconclusive");

  // 4. Adversarial: Wrong causedByEventId on run.routed fails closed -> inconclusive
  const wrongCauseEvents: RunEvent[] = [
    successEvents[0]!,
    successEvents[1]!,
    {
      schemaVersion: 1,
      eventId: asEventId("ev-route-wrong"),
      runId,
      sequence: 2,
      at: "2026-08-20T10:00:06.000Z",
      type: "run.routed",
      payload: {
        from: "ACCEPT",
        to: "DOCUMENT",
        causedByEventId: asEventId("ev-arbitrary-cause"),
      },
    },
  ];
  const wrongCauseMetrics = await MetricsCollector.collect({
    runId,
    events: wrongCauseEvents,
    bundleStore: store,
    state: { phase: "DOCUMENT", runId },
  });
  assert.equal(wrongCauseMetrics.actualStatus, "inconclusive");

  // 5. Adversarial: Route before completion timestamp fails closed -> inconclusive
  const routeBeforeEvents: RunEvent[] = [
    successEvents[0]!,
    successEvents[1]!,
    {
      schemaVersion: 1,
      eventId: asEventId("ev-route-early"),
      runId,
      sequence: 2,
      at: "2026-08-20T10:00:04.000Z",
      type: "run.routed",
      payload: {
        from: "ACCEPT",
        to: "DOCUMENT",
        causedByEventId: asEventId("ev-complete"),
      },
    },
  ];
  const routeBeforeMetrics = await MetricsCollector.collect({
    runId,
    events: routeBeforeEvents,
    bundleStore: store,
    state: { phase: "DOCUMENT", runId },
  });
  assert.equal(routeBeforeMetrics.actualStatus, "inconclusive");

  // 6. Adversarial: Decision mismatch between quality.completed and bundle -> inconclusive
  const mismatchCycleId = asQualityCycleId("cycle-mismatch");
  const mismatchBundle: EvidenceBundle = {
    ...validBundle,
    cycleId: mismatchCycleId,
    gates: validBundle.gates.map((g) => ({ ...g, cycleId: mismatchCycleId })),
    evidence: validBundle.evidence.map((e) => ({ ...e, cycleId: mismatchCycleId })),
    decision: { kind: "block", reason: "Blocked", requiredAction: "Fix" },
    routeIntent: { kind: "block", from: "ACCEPT", reason: "Blocked", requiredAction: "Fix", causedByEventId: asEventId("ev-1") },
  };
  await store.writeBundle(mismatchBundle);

  const mismatchEvents: RunEvent[] = [
    {
      schemaVersion: 1,
      eventId: asEventId("ev-start-m"),
      runId,
      sequence: 0,
      at: "2026-08-20T10:00:00.000Z",
      type: "quality.started",
      payload: {
        cycleId: mismatchCycleId,
        phase: "ACCEPT",
        startedAt: "2026-08-20T10:00:00.000Z",
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-comp-m"),
      runId,
      sequence: 1,
      at: "2026-08-20T10:00:05.000Z",
      type: "quality.completed",
      payload: {
        cycleId: mismatchCycleId,
        decision: { kind: "advance", to: "DOCUMENT" },
        completedAt: "2026-08-20T10:00:05.000Z",
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-route-m"),
      runId,
      sequence: 2,
      at: "2026-08-20T10:00:06.000Z",
      type: "run.routed",
      payload: {
        from: "ACCEPT",
        to: "DOCUMENT",
        causedByEventId: asEventId("ev-comp-m"),
      },
    },
  ];
  const mismatchMetrics = await MetricsCollector.collect({
    runId,
    events: mismatchEvents,
    bundleStore: store,
    state: { phase: "DOCUMENT", runId },
  });
  assert.equal(mismatchMetrics.actualStatus, "inconclusive");

  // 7. Adversarial: run.transitioned is NOT accepted as quality route -> inconclusive
  const transitionedEvents: RunEvent[] = [
    successEvents[0]!,
    successEvents[1]!,
    {
      schemaVersion: 1,
      eventId: asEventId("ev-trans"),
      runId,
      sequence: 2,
      at: "2026-08-20T10:00:06.000Z",
      type: "run.transitioned",
      payload: {
        stepId: asStepId("s-1"),
        operationId: "op-1",
        from: "ACCEPT",
        to: "DOCUMENT",
        causedByEventId: asEventId("ev-complete"),
      },
    },
  ];
  const transitionedMetrics = await MetricsCollector.collect({
    runId,
    events: transitionedEvents,
    bundleStore: store,
    state: { phase: "DOCUMENT", runId },
  });
  assert.equal(transitionedMetrics.actualStatus, "inconclusive");

  // 8. Adversarial: Event log integrity violation (duplicate sequence) fails closed -> inconclusive
  const dupSeqEvents: RunEvent[] = [
    successEvents[0]!,
    {
      ...successEvents[1]!,
      sequence: 0, // Duplicate sequence!
    },
    successEvents[2]!,
  ];
  const dupSeqMetrics = await MetricsCollector.collect({
    runId,
    events: dupSeqEvents,
    bundleStore: store,
    state: { phase: "DOCUMENT", runId },
  });
  assert.equal(dupSeqMetrics.actualStatus, "inconclusive");
  assert.ok(dupSeqMetrics.missingMetrics.includes("eventLog.integrity"));

  // 9. Adversarial: Duplicate quality.started lifecycle event for same cycle -> inconclusive + duplicate_lifecycle in missingMetrics + wallClockMs=0
  const dupQualityEvents: RunEvent[] = [
    successEvents[0]!,
    {
      ...successEvents[0]!,
      eventId: asEventId("ev-start-dup"),
      sequence: 3,
    },
    successEvents[1]!,
    successEvents[2]!,
  ];
  const dupQualityMetrics = await MetricsCollector.collect({
    runId,
    events: dupQualityEvents,
    bundleStore: store,
    state: { phase: "DOCUMENT", runId },
  });
  assert.equal(dupQualityMetrics.actualStatus, "inconclusive");
  assert.equal(dupQualityMetrics.wallClockMs, 0); // Must not compute wallClock from duplicate lifecycle
  assert.ok(dupQualityMetrics.missingMetrics.includes(`quality.${cycleId}.duplicate_lifecycle`));

  // 10. Adversarial: Input state.runId mismatch -> ignores state and adds state.runId to missingMetrics
  const stateMismatchMetrics = await MetricsCollector.collect({
    runId,
    events: successEvents,
    bundleStore: store,
    state: { phase: "DOCUMENT", runId: asRunId("other-run-id") }, // Mismatched state runId!
  });
  assert.equal(stateMismatchMetrics.reportedStatus, "succeeded"); // derived from run.routed event
  assert.ok(stateMismatchMetrics.missingMetrics.includes("state.runId"));

  // 11. False Success case: Run reports DOCUMENT (reportedStatus="succeeded"), but ACCEPT bundle has rejected verdict (actualStatus="failed")
  const rejectCycleId = asQualityCycleId("cycle-reject");
  const rejectedBundle: EvidenceBundle = {
    ...validBundle,
    cycleId: rejectCycleId,
    gates: validBundle.gates.map((g) => ({ ...g, cycleId: rejectCycleId })),
    evidence: validBundle.evidence.map((e) => ({ ...e, cycleId: rejectCycleId })),
    verdicts: [
      {
        requirementId: asRequirementId("R1"),
        status: "rejected",
        evidenceIds: [],
        rationale: "Tests failed",
      },
    ],
    decision: { kind: "block", reason: "Rejected", requiredAction: "Fix" },
    routeIntent: { kind: "block", from: "ACCEPT", reason: "Rejected", requiredAction: "Fix", causedByEventId: asEventId("e-b") },
  };
  await store.writeBundle(rejectedBundle);

  const falseSuccessEvents: RunEvent[] = [
    {
      schemaVersion: 1,
      eventId: asEventId("ev-start-2"),
      runId,
      sequence: 3,
      at: "2026-08-20T10:01:00.000Z",
      type: "quality.started",
      payload: {
        cycleId: rejectCycleId,
        phase: "ACCEPT",
        startedAt: "2026-08-20T10:01:00.000Z",
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-comp-2"),
      runId,
      sequence: 4,
      at: "2026-08-20T10:01:05.000Z",
      type: "quality.completed",
      payload: {
        cycleId: rejectCycleId,
        decision: { kind: "block", reason: "Rejected", requiredAction: "Fix" },
        completedAt: "2026-08-20T10:01:05.000Z",
      },
    },
  ];

  const falseSuccessMetrics = await MetricsCollector.collect({
    runId,
    events: falseSuccessEvents,
    bundleStore: store,
    state: { phase: "DOCUMENT", runId }, // falsely claims DOCUMENT phase
  });

  assert.equal(falseSuccessMetrics.actualStatus, "failed");
  assert.equal(falseSuccessMetrics.reportedStatus, "succeeded");
  assert.equal(falseSuccessMetrics.falseSuccess, true);
  assert.equal(falseSuccessMetrics.falseFailure, false);

  // 12. False Failure case: Quality passed (actualStatus="succeeded"), but run state was set to BLOCKED (reportedStatus="failed")
  const falseFailureMetrics = await MetricsCollector.collect({
    runId,
    events: successEvents,
    bundleStore: store,
    state: { phase: "BLOCKED", runId },
  });

  assert.equal(falseFailureMetrics.actualStatus, "succeeded");
  assert.equal(falseFailureMetrics.reportedStatus, "failed");
  assert.equal(falseFailureMetrics.falseSuccess, false);
  assert.equal(falseFailureMetrics.falseFailure, true);

  // 13. Untrusted / corrupt bundle case: Tampered bundle fails checksum -> actualStatus becomes inconclusive
  const corruptCycleId = asQualityCycleId("cycle-corrupt");
  const corruptBundle: EvidenceBundle = {
    ...validBundle,
    cycleId: corruptCycleId,
    gates: validBundle.gates.map((g) => ({ ...g, cycleId: corruptCycleId })),
    evidence: validBundle.evidence.map((e) => ({ ...e, cycleId: corruptCycleId })),
    verdicts: validBundle.verdicts.map((v) => ({ ...v })),
  };
  const writeRes = await store.writeBundle(corruptBundle);
  const cycleBundlePath = path.join(tmpDir, ".omni", "v4", "runs", runId, "quality", corruptCycleId, "bundle.json");
  await fs.writeFile(cycleBundlePath, '{"corrupted": true}', "utf-8");
  await fs.writeFile(writeRes.bundlePath, '{"corrupted": true}', "utf-8");

  const corruptEvents: RunEvent[] = [
    {
      schemaVersion: 1,
      eventId: asEventId("ev-start-3"),
      runId,
      sequence: 5,
      at: "2026-08-20T10:02:00.000Z",
      type: "quality.started",
      payload: {
        cycleId: corruptCycleId,
        phase: "ACCEPT",
        startedAt: "2026-08-20T10:02:00.000Z",
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-comp-3"),
      runId,
      sequence: 6,
      at: "2026-08-20T10:02:05.000Z",
      type: "quality.completed",
      payload: {
        cycleId: corruptCycleId,
        decision: { kind: "advance", to: "DOCUMENT" },
        completedAt: "2026-08-20T10:02:05.000Z",
      },
    },
  ];

  const corruptMetrics = await MetricsCollector.collect({
    runId,
    events: corruptEvents,
    bundleStore: store,
    state: { phase: "DOCUMENT", runId },
  });

  assert.equal(corruptMetrics.actualStatus, "inconclusive");

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("reliability_counts", async () => {
  // R61: Metrics include gate counts, retry count, repair count, resume count, and user-intervention count
  const runId = asRunId("run-rel-1");
  const otherRunId = asRunId("run-other-99");
  const cycleId = asQualityCycleId("c-1");

  const events: RunEvent[] = [
    {
      schemaVersion: 1,
      eventId: asEventId("e-1"),
      runId,
      sequence: 1,
      at: "2026-08-20T10:00:02.000Z",
      type: "step.failed",
      payload: {
        stepId: asStepId("s-1"),
        operationId: "op-1",
        result: {
          status: "failed",
          executionId: "op-1",
          failure: {
            code: "INTERNAL_ERROR",
            message: "Failed",
            retryable: true,
            signature: "test_fail_sig",
          },
        },
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("e-2"),
      runId,
      sequence: 2,
      at: "2026-08-20T10:00:05.000Z",
      type: "repair.decided",
      payload: {
        cycleId,
        requirementIds: [asRequirementId("R1")],
        attempt: 1,
        reason: "Fix required",
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("e-3"),
      runId,
      sequence: 3,
      at: "2026-08-20T10:00:07.000Z",
      type: "policy.decided",
      payload: {
        stage: "resume",
        stepId: asStepId("s-1"),
        operationId: "op-resume",
        decision: {
          kind: "retry",
          delayMs: 0,
        },
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("e-4"),
      runId,
      sequence: 4,
      at: "2026-08-20T10:00:10.000Z",
      type: "run.blocked",
      payload: {
        reason: "Manual review required",
        requiredAction: "Inspect code",
        causedByEventId: asEventId("e-2"),
      },
    },
    // Durable gate events
    {
      schemaVersion: 1,
      eventId: asEventId("e-g1-s"),
      runId,
      sequence: 5,
      at: "2026-08-20T10:00:11.000Z",
      type: "gate.started",
      payload: {
        cycleId,
        gateId: asGateId("g1"),
        operationId: "op-g1",
        startedAt: "2026-08-20T10:00:11.000Z",
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("e-g1-c"),
      runId,
      sequence: 6,
      at: "2026-08-20T10:00:12.000Z",
      type: "gate.completed",
      payload: {
        result: {
          schemaVersion: 1,
          cycleId,
          gateId: asGateId("g1"),
          operationId: "op-g1",
          startedAt: "2026-08-20T10:00:11.000Z",
          durationMs: 1000,
          status: "passed",
          evidenceId: asQualityEvidenceId("ev-1"),
        },
      },
    },
    // Adversarial: Duplicate gate.completed for g1 must NOT double-count duration/count!
    {
      schemaVersion: 1,
      eventId: asEventId("e-g1-c-dup"),
      runId,
      sequence: 7,
      at: "2026-08-20T10:00:12.500Z",
      type: "gate.completed",
      payload: {
        result: {
          schemaVersion: 1,
          cycleId,
          gateId: asGateId("g1"),
          operationId: "op-g1",
          startedAt: "2026-08-20T10:00:11.000Z",
          durationMs: 1000,
          status: "passed",
          evidenceId: asQualityEvidenceId("ev-1"),
        },
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("e-g2-c"),
      runId,
      sequence: 8,
      at: "2026-08-20T10:00:13.000Z",
      type: "gate.completed",
      payload: {
        result: {
          schemaVersion: 1,
          cycleId,
          gateId: asGateId("g2"),
          operationId: "op-g2",
          startedAt: "2026-08-20T10:00:12.000Z",
          durationMs: 1000,
          status: "failed",
        },
      },
    },
    // Skipped gate without gate.started (skipped dependency)
    {
      schemaVersion: 1,
      eventId: asEventId("e-g3-c"),
      runId,
      sequence: 9,
      at: "2026-08-20T10:00:14.000Z",
      type: "gate.completed",
      payload: {
        result: {
          schemaVersion: 1,
          cycleId,
          gateId: asGateId("g3"),
          operationId: "op-g3",
          startedAt: "2026-08-20T10:00:14.000Z",
          durationMs: 0,
          status: "skipped",
          reason: "Skipped by rule",
        },
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("e-g4-c"),
      runId,
      sequence: 10,
      at: "2026-08-20T10:00:15.000Z",
      type: "gate.completed",
      payload: {
        result: {
          schemaVersion: 1,
          cycleId,
          gateId: asGateId("g4"),
          operationId: "op-g4",
          startedAt: "2026-08-20T10:00:14.000Z",
          durationMs: 1000,
          status: "inconclusive",
          reason: "Timeout",
          failureSignature: "timeout",
        },
      },
    },
    // Adversarial: Cross-run foreign events with failed gate, repair, step failure, block must be 100% ignored!
    {
      schemaVersion: 1,
      eventId: asEventId("e-foreign-step-fail"),
      runId: otherRunId,
      sequence: 11,
      at: "2026-08-20T10:00:16.000Z",
      type: "step.failed",
      payload: {
        stepId: asStepId("s-other"),
        operationId: "op-other",
        result: {
          status: "failed",
          executionId: "op-other",
          failure: {
            code: "ERR",
            message: "Other fail",
            retryable: true,
            signature: "sig",
          },
        },
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("e-foreign-repair"),
      runId: otherRunId,
      sequence: 12,
      at: "2026-08-20T10:00:17.000Z",
      type: "repair.decided",
      payload: {
        cycleId,
        requirementIds: [asRequirementId("R99")],
        attempt: 2,
        reason: "Foreign repair",
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("e-foreign-gate"),
      runId: otherRunId,
      sequence: 13,
      at: "2026-08-20T10:00:18.000Z",
      type: "gate.completed",
      payload: {
        result: {
          schemaVersion: 1,
          cycleId,
          gateId: asGateId("g-foreign"),
          operationId: "op-f",
          startedAt: "2026-08-20T10:00:18.000Z",
          durationMs: 5000,
          status: "failed",
        },
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("e-foreign-block"),
      runId: otherRunId,
      sequence: 14,
      at: "2026-08-20T10:00:19.000Z",
      type: "run.blocked",
      payload: {
        reason: "Foreign block",
        requiredAction: "Inspect",
        causedByEventId: asEventId("e-foreign-repair"),
      },
    },
  ];

  const metrics = await MetricsCollector.collect({
    runId,
    events,
    state: { phase: "BLOCKED", runId },
  });

  assert.equal(metrics.retryCount, 1);
  assert.equal(metrics.repairCount, 1);
  assert.equal(metrics.resumeCount, 1);
  assert.equal(metrics.userInterventionCount, 1);
  assert.equal(metrics.gateCounts.passed, 1); // Not 2 despite duplicate completion
  assert.equal(metrics.gateCounts.failed, 1); // Not 2 despite foreign gate
  assert.equal(metrics.gateCounts.skipped, 1);
  assert.equal(metrics.gateCounts.inconclusive, 1);
  assert.ok(metrics.missingMetrics.includes("gate.g1.duplicate_completion"));
});

test("efficiency_metrics", async () => {
  // R62: Metrics include wall-clock duration, summed gate duration, queue time, peak parallelism, and measured speedup
  const runId = asRunId("run-eff-1");
  const cycleId = asQualityCycleId("c-1");

  // Quality starts at 10:00:00.000Z, completes at 10:00:04.000Z (4000ms wallClock)
  // Gate 1: started at 10:00:01.000Z (1000ms queue), completed at 10:00:03.000Z (duration 2000ms)
  // Gate 2: started at 10:00:01.000Z (1000ms queue), completed at 10:00:03.000Z (duration 2000ms)
  // Peak parallelism = 2 (overlap between 10:00:01 and 10:00:03)
  const events: RunEvent[] = [
    {
      schemaVersion: 1,
      eventId: asEventId("ev-qs"),
      runId,
      sequence: 1,
      at: "2026-08-20T10:00:00.000Z",
      type: "quality.started",
      payload: {
        cycleId,
        phase: "VERIFY",
        startedAt: "2026-08-20T10:00:00.000Z",
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-g1-s"),
      runId,
      sequence: 2,
      at: "2026-08-20T10:00:01.000Z",
      type: "gate.started",
      payload: {
        cycleId,
        gateId: asGateId("g1"),
        operationId: "op-1",
        startedAt: "2026-08-20T10:00:01.000Z",
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-g2-s"),
      runId,
      sequence: 3,
      at: "2026-08-20T10:00:01.000Z",
      type: "gate.started",
      payload: {
        cycleId,
        gateId: asGateId("g2"),
        operationId: "op-2",
        startedAt: "2026-08-20T10:00:01.000Z",
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-g1-c"),
      runId,
      sequence: 4,
      at: "2026-08-20T10:00:03.000Z",
      type: "gate.completed",
      payload: {
        result: {
          schemaVersion: 1,
          cycleId,
          gateId: asGateId("g1"),
          operationId: "op-1",
          startedAt: "2026-08-20T10:00:01.000Z",
          durationMs: 2000,
          status: "passed",
          evidenceId: asQualityEvidenceId("ev-1"),
        },
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-g2-c"),
      runId,
      sequence: 5,
      at: "2026-08-20T10:00:03.000Z",
      type: "gate.completed",
      payload: {
        result: {
          schemaVersion: 1,
          cycleId,
          gateId: asGateId("g2"),
          operationId: "op-2",
          startedAt: "2026-08-20T10:00:01.000Z",
          durationMs: 2000,
          status: "passed",
          evidenceId: asQualityEvidenceId("ev-2"),
        },
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-qc"),
      runId,
      sequence: 6,
      at: "2026-08-20T10:00:04.000Z",
      type: "quality.completed",
      payload: {
        cycleId,
        decision: { kind: "advance", to: "ACCEPT" },
        completedAt: "2026-08-20T10:00:04.000Z",
      },
    },
  ];

  const metrics = await MetricsCollector.collect({
    runId,
    events,
    state: { phase: "ACCEPT", runId },
  });

  assert.equal(metrics.wallClockMs, 4000);
  assert.equal(metrics.summedGateDurationMs, 4000);
  assert.equal(metrics.gateQueueMs, 2000);
  assert.equal(metrics.peakParallelism, 2);
  assert.equal(metrics.measuredSpeedup, 1.0);

  // Adversarial: Sequential boundary tie-break test
  // Gate A finishes at 10:00:01.000Z, Gate B starts at 10:00:01.000Z -> Peak parallelism must be 1, NOT 2!
  const seqCycleId = asQualityCycleId("c-seq");
  const seqEvents: RunEvent[] = [
    {
      schemaVersion: 1,
      eventId: asEventId("ev-sqs"),
      runId,
      sequence: 1,
      at: "2026-08-20T10:00:00.000Z",
      type: "quality.started",
      payload: { cycleId: seqCycleId, phase: "VERIFY", startedAt: "2026-08-20T10:00:00.000Z" },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-ga-s"),
      runId,
      sequence: 2,
      at: "2026-08-20T10:00:00.000Z",
      type: "gate.started",
      payload: { cycleId: seqCycleId, gateId: asGateId("gA"), operationId: "op-A", startedAt: "2026-08-20T10:00:00.000Z" },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-ga-c"),
      runId,
      sequence: 3,
      at: "2026-08-20T10:00:01.000Z",
      type: "gate.completed",
      payload: {
        result: {
          schemaVersion: 1,
          cycleId: seqCycleId,
          gateId: asGateId("gA"),
          operationId: "op-A",
          startedAt: "2026-08-20T10:00:00.000Z",
          durationMs: 1000,
          status: "passed",
          evidenceId: asQualityEvidenceId("ev-A"),
        },
      },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-gb-s"),
      runId,
      sequence: 4,
      at: "2026-08-20T10:00:01.000Z", // Starts at exact completion timestamp of Gate A
      type: "gate.started",
      payload: { cycleId: seqCycleId, gateId: asGateId("gB"), operationId: "op-B", startedAt: "2026-08-20T10:00:01.000Z" },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-gb-c"),
      runId,
      sequence: 5,
      at: "2026-08-20T10:00:02.000Z",
      type: "gate.completed",
      payload: {
        result: {
          schemaVersion: 1,
          cycleId: seqCycleId,
          gateId: asGateId("gB"),
          operationId: "op-B",
          startedAt: "2026-08-20T10:00:01.000Z",
          durationMs: 1000,
          status: "passed",
          evidenceId: asQualityEvidenceId("ev-B"),
        },
      },
    },
  ];
  const seqMetrics = await MetricsCollector.collect({ runId, events: seqEvents });
  assert.equal(seqMetrics.peakParallelism, 1);

  // Adversarial: Unmatched gate.completed without gate.started does NOT synthesize interval
  const orphanCycleId = asQualityCycleId("c-orphan");
  const orphanEvents: RunEvent[] = [
    {
      schemaVersion: 1,
      eventId: asEventId("ev-orphan-c"),
      runId,
      sequence: 1,
      at: "2026-08-20T10:00:05.000Z",
      type: "gate.completed",
      payload: {
        result: {
          schemaVersion: 1,
          cycleId: orphanCycleId,
          gateId: asGateId("g-orphan"),
          operationId: "op-orphan",
          startedAt: "2026-08-20T10:00:00.000Z",
          durationMs: 5000,
          status: "passed",
          evidenceId: asQualityEvidenceId("ev-orphan"),
        },
      },
    },
  ];
  const orphanMetrics = await MetricsCollector.collect({ runId, events: orphanEvents });
  assert.equal(orphanMetrics.peakParallelism, 0); // No interval synthesized!
  assert.ok(orphanMetrics.missingMetrics.includes("gate.g-orphan.unmatched_start"));

  // Adversarial: Duplicate gate.started
  const dupStartCycleId = asQualityCycleId("c-dup-start");
  const dupStartEvents: RunEvent[] = [
    {
      schemaVersion: 1,
      eventId: asEventId("ev-ds-1"),
      runId,
      sequence: 1,
      at: "2026-08-20T10:00:00.000Z",
      type: "gate.started",
      payload: { cycleId: dupStartCycleId, gateId: asGateId("g-dup"), operationId: "op-dup", startedAt: "2026-08-20T10:00:00.000Z" },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-ds-2"),
      runId,
      sequence: 2,
      at: "2026-08-20T10:00:01.000Z",
      type: "gate.started",
      payload: { cycleId: dupStartCycleId, gateId: asGateId("g-dup"), operationId: "op-dup", startedAt: "2026-08-20T10:00:01.000Z" },
    },
  ];
  const dupStartMetrics = await MetricsCollector.collect({ runId, events: dupStartEvents });
  assert.equal(dupStartMetrics.peakParallelism, 0);
  assert.equal(dupStartMetrics.gateQueueMs, 0);
  assert.ok(dupStartMetrics.missingMetrics.includes("gate.g-dup.duplicate_start"));

  // Adversarial: Completion before start
  const compBeforeCycleId = asQualityCycleId("c-before");
  const compBeforeEvents: RunEvent[] = [
    {
      schemaVersion: 1,
      eventId: asEventId("ev-cb-s"),
      runId,
      sequence: 1,
      at: "2026-08-20T10:00:05.000Z",
      type: "gate.started",
      payload: { cycleId: compBeforeCycleId, gateId: asGateId("g-cb"), operationId: "op-cb", startedAt: "2026-08-20T10:00:05.000Z" },
    },
    {
      schemaVersion: 1,
      eventId: asEventId("ev-cb-c"),
      runId,
      sequence: 2,
      at: "2026-08-20T10:00:02.000Z", // Completed before started!
      type: "gate.completed",
      payload: {
        result: {
          schemaVersion: 1,
          cycleId: compBeforeCycleId,
          gateId: asGateId("g-cb"),
          operationId: "op-cb",
          startedAt: "2026-08-20T10:00:05.000Z",
          durationMs: 1000,
          status: "passed",
          evidenceId: asQualityEvidenceId("ev-cb"),
        },
      },
    },
  ];
  const compBeforeMetrics = await MetricsCollector.collect({ runId, events: compBeforeEvents });
  assert.equal(compBeforeMetrics.peakParallelism, 0);
  assert.ok(compBeforeMetrics.missingMetrics.includes("gate.g-cb.completion_before_start"));

  // Verify no schedule results => peakParallelism = 0
  const noSchedMetrics = await MetricsCollector.collect({
    runId,
    events: [],
    state: { phase: "INTAKE", runId },
  });
  assert.equal(noSchedMetrics.peakParallelism, 0);
  assert.equal(noSchedMetrics.measuredSpeedup, undefined);
  assert.ok(noSchedMetrics.missingMetrics.includes("measuredSpeedup"));
});

test("native_usage_metadata", async () => {
  // R63: Metrics include available token, cost, adapter, CLI, model, and session metadata
  const runId = asRunId("run-meta-1");

  // 1. Normal resolution without conflicts
  const normalNative: NativeExecutionMetadata[] = [
    {
      sessionId: "session-123",
      cliVersion: "1.5.0",
      model: "claude-3-7-sonnet",
      usage: {
        inputTokens: 1200,
        outputTokens: 400,
        cachedInputTokens: 100,
        totalTokens: 1600,
        costUsd: 0.025,
      },
    },
    {
      sessionId: "session-123",
      cliVersion: "1.5.0",
      model: "claude-3-7-sonnet",
      usage: {
        inputTokens: 800,
        outputTokens: 200,
        totalTokens: 1000,
        costUsd: 0.015,
      },
    },
  ];

  const normalMetrics = await MetricsCollector.collect({
    runId,
    events: [],
    nativeMetadata: normalNative,
    adapter: {
      name: "claude-code",
      model: "claude-3-7-sonnet",
      cliVersion: "1.5.0",
      sessionId: "session-123",
    },
    state: { phase: "DOCUMENT", runId },
  });

  assert.equal(normalMetrics.adapter?.name, "claude-code");
  assert.equal(normalMetrics.adapter?.model, "claude-3-7-sonnet");
  assert.equal(normalMetrics.adapter?.cliVersion, "1.5.0");
  assert.equal(normalMetrics.adapter?.sessionId, "session-123");

  assert.equal(normalMetrics.usage?.inputTokens, 2000);
  assert.equal(normalMetrics.usage?.outputTokens, 600);
  assert.equal(normalMetrics.usage?.cachedInputTokens, 100);
  assert.equal(normalMetrics.usage?.totalTokens, 2600);
  assert.equal(normalMetrics.usage?.costUsd, 0.04);

  // 2. Adversarial: Conflict between metadata records fails closed, omits conflicted fields, and adds to missingMetrics
  const conflictNative: NativeExecutionMetadata[] = [
    {
      sessionId: "session-A",
      model: "claude-3-5-sonnet",
      cliVersion: "1.0.0",
    },
    {
      sessionId: "session-B",
      model: "claude-3-7-sonnet",
      cliVersion: "2.0.0",
    },
  ];

  const conflictMetrics = await MetricsCollector.collect({
    runId,
    events: [],
    nativeMetadata: conflictNative,
    adapter: { name: "test-adapter" },
    state: { phase: "DOCUMENT", runId },
  });

  assert.equal(conflictMetrics.adapter?.name, "test-adapter");
  assert.equal(conflictMetrics.adapter?.model, undefined);
  assert.equal(conflictMetrics.adapter?.cliVersion, undefined);
  assert.equal(conflictMetrics.adapter?.sessionId, undefined);
  assert.ok(conflictMetrics.missingMetrics.includes("adapter.model"));
  assert.ok(conflictMetrics.missingMetrics.includes("adapter.cliVersion"));
  assert.ok(conflictMetrics.missingMetrics.includes("adapter.sessionId"));
});

test("missing_usage_not_zero", async () => {
  // R64: Missing provider usage remains explicitly unavailable and is never recorded as zero
  const runId = asRunId("run-miss-1");
  const nativeMetadata: NativeExecutionMetadata[] = [
    {
      sessionId: "session-456",
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        // cachedInputTokens and costUsd are absent
      },
    },
  ];

  const metrics = await MetricsCollector.collect({
    runId,
    events: [],
    nativeMetadata,
    adapter: { name: "test-adapter" },
    state: { phase: "READY", runId },
  });

  assert.equal(metrics.usage?.inputTokens, 1000);
  assert.equal(metrics.usage?.outputTokens, 500);
  assert.equal(metrics.usage?.totalTokens, 1500);
  assert.equal(metrics.usage?.cachedInputTokens, undefined);
  assert.equal(metrics.usage?.costUsd, undefined);

  assert.ok(metrics.missingMetrics.includes("usage.cachedInputTokens"));
  assert.ok(metrics.missingMetrics.includes("usage.costUsd"));
});
