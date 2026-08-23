import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  EvidenceBundleStore,
  computeCanonicalSha256,
  canonicalJsonStringify,
  type EvidenceBundle,
} from "../../src/v4/quality/evidence-bundle-store";
import {
  asGateId,
  asQualityCycleId,
  asQualityEvidenceId,
  asRequirementId,
} from "../../src/v4/contracts/quality";
import { asEventId, asRunId } from "../../src/v4/contracts/ids";
import { QualityError } from "../../src/v4/quality/errors";

test("complete_bundle", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-complete-bundle-"));
  const store = new EvidenceBundleStore({ projectRoot: tmpDir });

  const runId = asRunId("run-bundle-comp-1");
  const cycleId = asQualityCycleId("cycle-1");
  const evId = asQualityEvidenceId("ev-1");
  const causeId = asEventId("ev-qc-completed-1");

  // 1. Canonical hashing rule verification: logically identical key order produces identical exact bytes/hash
  const configA = { b: 2, a: 1, gates: [{ id: "g1" }] };
  const configB = { gates: [{ id: "g1" }], a: 1, b: 2 };
  const hashA = computeCanonicalSha256(configA);
  const hashB = computeCanonicalSha256(configB);
  assert.equal(hashA, hashB, "Canonical hashing must be independent of key order");
  assert.match(hashA, /^[0-9a-f]{64}$/);

  const reqs = [{ requirementId: "R1", text: "Unit test passes" }];
  const reqHash = computeCanonicalSha256(reqs);
  assert.match(reqHash, /^[0-9a-f]{64}$/);

  const completeBundle: EvidenceBundle = {
    schemaVersion: 1,
    runId,
    cycleId,
    phase: "VERIFY",
    configHash: hashA,
    requirementsHash: reqHash,
    generatedAt: "2026-08-20T10:00:00.000Z",
    gates: [
      {
        schemaVersion: 1,
        cycleId,
        gateId: asGateId("unit-test"),
        operationId: "op-1",
        status: "passed",
        startedAt: "2026-08-20T10:00:00.000Z",
        durationMs: 100,
        evidenceId: evId,
      },
    ],
    evidence: [
      {
        schemaVersion: 1,
        evidenceId: evId,
        runId,
        cycleId,
        gateId: asGateId("unit-test"),
        operationId: "op-1",
        command: ["npm", "test"],
        cwd: tmpDir,
        timeoutMs: 30000,
        termination: "exited",
        exitCode: 0,
        startedAt: "2026-08-20T10:00:00.000Z",
        durationMs: 100,
        stdoutSummary: "PASS",
        stderrSummary: "",
        stdoutSha256: crypto.createHash("sha256").update("PASS").digest("hex"),
        stderrSha256: crypto.createHash("sha256").update("").digest("hex"),
        artifactIds: [],
      },
    ],
    verdicts: [
      {
        requirementId: asRequirementId("R1"),
        status: "accepted",
        evidenceIds: [evId],
        rationale: "Unit tests passed cleanly",
      },
    ],
    repairHistory: [
      {
        attempt: 1,
        phase: "VERIFY",
        cycleId,
        requirementIds: [asRequirementId("R1")],
        priorVerdicts: [],
        priorEvidenceIds: [],
        perRequirementAttempts: { R1: 1 },
        fingerprint: crypto.createHash("sha256").update("fp").digest("hex"),
        outcome: "failed",
        timestamp: "2026-08-20T10:00:00.000Z",
      },
    ],
    decision: {
      kind: "advance",
      to: "ACCEPT",
    },
    routeIntent: {
      kind: "advance",
      from: "VERIFY",
      to: "ACCEPT",
      causedByEventId: causeId,
    },
  };

  const { bundlePath, recordPath, sha256, byteLength } = await store.writeBundle(completeBundle);
  assert.ok(fs.existsSync(bundlePath));
  assert.ok(fs.existsSync(recordPath));
  assert.ok(byteLength > 0);
  assert.match(sha256, /^[0-9a-f]{64}$/);

  // Read back authorized run-level bundle
  const readBack = await store.readBundle(runId);
  assert.deepEqual(readBack, completeBundle);
  assert.equal(readBack.configHash, hashA);
  assert.equal(readBack.requirementsHash, reqHash);
  assert.equal(readBack.repairHistory.length, 1);
  assert.equal(readBack.routeIntent.kind, "advance");
  assert.equal(readBack.routeIntent.causedByEventId, causeId);

  // Markdown summary includes hashes and decision
  const md = store.exportSummaryMarkdown(completeBundle);
  assert.match(md, new RegExp(hashA));
  assert.match(md, new RegExp(reqHash));

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("atomic_checksum_record", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-checksum-bundle-"));
  const store = new EvidenceBundleStore({ projectRoot: tmpDir });

  const runId = asRunId("run-bundle-chk-1");
  const cycleId = asQualityCycleId("cycle-1");
  const evId = asQualityEvidenceId("ev-1");
  const causeId = asEventId("ev-qc-completed-1");

  const sampleBundle: EvidenceBundle = {
    schemaVersion: 1,
    runId,
    cycleId,
    phase: "VERIFY",
    configHash: "a".repeat(64),
    requirementsHash: "b".repeat(64),
    generatedAt: "2026-08-20T10:00:00.000Z",
    gates: [
      {
        schemaVersion: 1,
        cycleId,
        gateId: asGateId("unit-test"),
        operationId: "op-1",
        status: "passed",
        startedAt: "2026-08-20T10:00:00.000Z",
        durationMs: 100,
        evidenceId: evId,
      },
    ],
    evidence: [
      {
        schemaVersion: 1,
        evidenceId: evId,
        runId,
        cycleId,
        gateId: asGateId("unit-test"),
        operationId: "op-1",
        command: ["npm", "test"],
        cwd: tmpDir,
        timeoutMs: 30000,
        termination: "exited",
        exitCode: 0,
        startedAt: "2026-08-20T10:00:00.000Z",
        durationMs: 100,
        stdoutSummary: "PASS",
        stderrSummary: "",
        stdoutSha256: crypto.createHash("sha256").update("PASS").digest("hex"),
        stderrSha256: crypto.createHash("sha256").update("").digest("hex"),
        artifactIds: [],
      },
    ],
    verdicts: [
      {
        requirementId: asRequirementId("R1"),
        status: "accepted",
        evidenceIds: [evId],
        rationale: "Unit tests passed cleanly",
      },
    ],
    repairHistory: [],
    decision: {
      kind: "advance",
      to: "ACCEPT",
    },
    routeIntent: {
      kind: "advance",
      from: "VERIFY",
      to: "ACCEPT",
      causedByEventId: causeId,
    },
  };

  const { bundlePath, recordPath, sha256, byteLength } = await store.writeBundle(sampleBundle);
  assert.ok(fs.existsSync(bundlePath));
  assert.ok(fs.existsSync(recordPath));

  // Verify disk bytes are exact canonical bytes and match record
  const diskRawBytes = await fs.promises.readFile(bundlePath);
  const expectedCanonical = canonicalJsonStringify(sampleBundle) + "\n";
  assert.equal(diskRawBytes.toString("utf8"), expectedCanonical);
  assert.equal(diskRawBytes.byteLength, byteLength);

  // Inspect record contents
  const recordContent = JSON.parse(await fs.promises.readFile(recordPath, "utf8"));
  assert.equal(recordContent.schemaVersion, 1);
  assert.equal(recordContent.bundleSchemaVersion, 1);
  assert.equal(recordContent.runId, runId);
  assert.equal(recordContent.cycleId, cycleId);
  assert.equal(recordContent.sha256, sha256);
  assert.equal(recordContent.byteLength, byteLength);

  // Read back validates checksum
  const readBack = await store.readBundle(runId);
  assert.deepEqual(readBack, sampleBundle);

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

test("corrupt_bundle_fails_closed", async () => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omni-corrupt-bundle-"));
  const store = new EvidenceBundleStore({ projectRoot: tmpDir });

  const runId = asRunId("run-bundle-corrupt");
  const cycleId = asQualityCycleId("cycle-1");
  const evId = asQualityEvidenceId("ev-1");
  const causeId = asEventId("ev-qc-completed-1");

  const sampleBundle: EvidenceBundle = {
    schemaVersion: 1,
    runId,
    cycleId,
    phase: "VERIFY",
    configHash: "a".repeat(64),
    requirementsHash: "b".repeat(64),
    generatedAt: "2026-08-20T10:00:00.000Z",
    gates: [
      {
        schemaVersion: 1,
        cycleId,
        gateId: asGateId("unit-test"),
        operationId: "op-1",
        status: "passed",
        startedAt: "2026-08-20T10:00:00.000Z",
        durationMs: 100,
        evidenceId: evId,
      },
    ],
    evidence: [
      {
        schemaVersion: 1,
        evidenceId: evId,
        runId,
        cycleId,
        gateId: asGateId("unit-test"),
        operationId: "op-1",
        command: ["npm", "test"],
        cwd: tmpDir,
        timeoutMs: 30000,
        termination: "exited",
        exitCode: 0,
        startedAt: "2026-08-20T10:00:00.000Z",
        durationMs: 100,
        stdoutSummary: "PASS",
        stderrSummary: "",
        stdoutSha256: crypto.createHash("sha256").update("PASS").digest("hex"),
        stderrSha256: crypto.createHash("sha256").update("").digest("hex"),
        artifactIds: [],
      },
    ],
    verdicts: [
      {
        requirementId: asRequirementId("R1"),
        status: "accepted",
        evidenceIds: [evId],
        rationale: "Unit tests passed cleanly",
      },
    ],
    repairHistory: [],
    decision: {
      kind: "advance",
      to: "ACCEPT",
    },
    routeIntent: {
      kind: "advance",
      from: "VERIFY",
      to: "ACCEPT",
      causedByEventId: causeId,
    },
  };

  const { bundlePath, recordPath } = await store.writeBundle(sampleBundle);
  const cycleBundlePath = path.join(tmpDir, ".omni", "v4", "runs", runId, "quality", cycleId, "bundle.json");
  const cycleRecordPath = path.join(tmpDir, ".omni", "v4", "runs", runId, "quality", cycleId, "bundle.record.json");

  // 1. Corrupt run-level bundle file bytes (tampering) -> fails closed
  await fs.promises.writeFile(bundlePath, "{\"corrupted\": true}\n", "utf8");
  await assert.rejects(
    () => store.readBundle(runId),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 2. Corrupt cycle-level bundle file bytes (tampering) -> fails closed
  await fs.promises.writeFile(cycleBundlePath, "{\"corrupted\": true}\n", "utf8");
  await assert.rejects(
    () => store.readBundle(runId, cycleId),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 3. Missing record file -> fails closed
  await fs.promises.unlink(recordPath);
  await assert.rejects(
    () => store.readBundle(runId),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  await fs.promises.unlink(cycleRecordPath);
  await assert.rejects(
    () => store.readBundle(runId, cycleId),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 4. Requested-run mismatch -> fails closed
  await assert.rejects(
    () => store.readBundle(asRunId("wrong-run")),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 5. Missing approved bundle despite legacy evidence.json existing -> fails closed (no fallback!)
  const legacyCycleDir = path.join(tmpDir, ".omni", "v4", "runs", "run-legacy", "quality", "cycle-1");
  await fs.promises.mkdir(legacyCycleDir, { recursive: true });
  await fs.promises.writeFile(path.join(legacyCycleDir, "evidence.json"), "{}", "utf8");
  await assert.rejects(
    () => store.readBundle(asRunId("run-legacy"), asQualityCycleId("cycle-1")),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 6. Duplicate gate ID in bundle -> write fails closed
  await assert.rejects(
    () =>
      store.writeBundle({
        ...sampleBundle,
        gates: [sampleBundle.gates[0]!, sampleBundle.gates[0]!],
      }),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 7. Duplicate gate operationId -> write fails closed
  await assert.rejects(
    () =>
      store.writeBundle({
        ...sampleBundle,
        gates: [
          sampleBundle.gates[0]!,
          { ...sampleBundle.gates[0]!, gateId: asGateId("unit-test-2"), operationId: "op-1" },
        ],
      }),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 8. Orphan evidence record in bundle not corresponding to any gate -> write fails closed
  const orphanEvId = asQualityEvidenceId("ev-orphan");
  await assert.rejects(
    () =>
      store.writeBundle({
        ...sampleBundle,
        evidence: [
          sampleBundle.evidence[0]!,
          {
            ...sampleBundle.evidence[0]!,
            evidenceId: orphanEvId,
            gateId: asGateId("foreign-gate"),
            operationId: "op-foreign",
          },
        ],
      }),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 9. Gate referencing missing evidence ID -> write fails closed
  await assert.rejects(
    () =>
      store.writeBundle({
        ...sampleBundle,
        gates: [
          {
            ...sampleBundle.gates[0]!,
            status: "failed",
            evidenceId: asQualityEvidenceId("ev-missing"),
          },
        ],
        evidence: [],
        verdicts: [{ ...sampleBundle.verdicts[0]!, status: "rejected", evidenceIds: [] }],
        decision: { kind: "repair", to: "FIX", requirementIds: [asRequirementId("R1")] },
        routeIntent: {
          kind: "repair",
          from: "VERIFY",
          to: "FIX",
          requirementIds: [asRequirementId("R1")],
          attempt: 1,
          causedByEventId: causeId,
        },
      }),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 10. Passed gate citing non-zero exit evidence -> write fails closed
  const failEvId = asQualityEvidenceId("ev-fail");
  await assert.rejects(
    () =>
      store.writeBundle({
        ...sampleBundle,
        gates: [{ ...sampleBundle.gates[0]!, evidenceId: failEvId }],
        evidence: [
          {
            ...sampleBundle.evidence[0]!,
            evidenceId: failEvId,
            exitCode: 1,
          },
        ],
        verdicts: [{ ...sampleBundle.verdicts[0]!, evidenceIds: [failEvId] }],
      }),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 11. Duplicate verdict requirement ID -> write fails closed
  await assert.rejects(
    () =>
      store.writeBundle({
        ...sampleBundle,
        verdicts: [sampleBundle.verdicts[0]!, sampleBundle.verdicts[0]!],
      }),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 12. Accepted verdict with zero evidence IDs -> write fails closed
  await assert.rejects(
    () =>
      store.writeBundle({
        ...sampleBundle,
        verdicts: [{ ...sampleBundle.verdicts[0]!, evidenceIds: [] }],
      }),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 13. Advance decision when a verdict is non-accepted -> write fails closed
  await assert.rejects(
    () =>
      store.writeBundle({
        ...sampleBundle,
        verdicts: [{ ...sampleBundle.verdicts[0]!, status: "rejected" }],
        decision: { kind: "advance", to: "ACCEPT" },
        routeIntent: { kind: "advance", from: "VERIFY", to: "ACCEPT", causedByEventId: causeId },
      }),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 14. Advance decision in VERIFY with invalid route intent (to: DOCUMENT) -> write fails closed
  await assert.rejects(
    () =>
      store.writeBundle({
        ...sampleBundle,
        phase: "VERIFY",
        decision: { kind: "advance", to: "DOCUMENT" },
        routeIntent: { kind: "advance", from: "VERIFY", to: "DOCUMENT", causedByEventId: causeId },
      }),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 15. Repair decision referencing unknown requirement ID -> write fails closed
  await assert.rejects(
    () =>
      store.writeBundle({
        ...sampleBundle,
        decision: {
          kind: "repair",
          to: "FIX",
          requirementIds: [asRequirementId("UNKNOWN-REQ")],
        },
        routeIntent: {
          kind: "repair",
          from: "VERIFY",
          to: "FIX",
          requirementIds: [asRequirementId("UNKNOWN-REQ")],
          attempt: 1,
          causedByEventId: causeId,
        },
      }),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 16. Block routeIntent reason mismatching block decision reason -> write fails closed
  await assert.rejects(
    () =>
      store.writeBundle({
        ...sampleBundle,
        verdicts: [{ ...sampleBundle.verdicts[0]!, status: "rejected" }],
        decision: { kind: "block", reason: "Budget exhausted", requiredAction: "Fix it" },
        routeIntent: {
          kind: "block",
          from: "VERIFY",
          reason: "Different reason",
          requiredAction: "Fix it",
          causedByEventId: causeId,
        },
      }),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 17. Repair routeIntent attempt mismatch with latest repair history -> write fails closed
  await assert.rejects(
    () =>
      store.writeBundle({
        ...sampleBundle,
        verdicts: [{ ...sampleBundle.verdicts[0]!, status: "rejected" }],
        repairHistory: [
          {
            attempt: 2,
            phase: "VERIFY",
            cycleId,
            requirementIds: [asRequirementId("R1")],
            priorVerdicts: sampleBundle.verdicts,
            priorEvidenceIds: [evId],
            perRequirementAttempts: { R1: 2 },
            fingerprint: crypto.createHash("sha256").update("fp-2").digest("hex"),
            outcome: "failed",
            timestamp: "2026-08-20T10:00:00.000Z",
          },
        ],
        decision: { kind: "repair", to: "FIX", requirementIds: [asRequirementId("R1")] },
        routeIntent: {
          kind: "repair",
          from: "VERIFY",
          to: "FIX",
          requirementIds: [asRequirementId("R1")],
          attempt: 1, // Mismatch: should be 2
          causedByEventId: causeId,
        },
      }),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 18. Repair decision with empty repairHistory -> rejected
  await assert.rejects(
    () =>
      store.writeBundle({
        ...sampleBundle,
        verdicts: [{ ...sampleBundle.verdicts[0]!, status: "rejected" }],
        repairHistory: [], // EMPTY repair history with repair decision!
        decision: { kind: "repair", to: "FIX", requirementIds: [asRequirementId("R1")] },
        routeIntent: {
          kind: "repair",
          from: "VERIFY",
          to: "FIX",
          requirementIds: [asRequirementId("R1")],
          attempt: 1,
          causedByEventId: causeId,
        },
      }),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 19. Latest repair history cycleId mismatch -> rejected
  await assert.rejects(
    () =>
      store.writeBundle({
        ...sampleBundle,
        verdicts: [{ ...sampleBundle.verdicts[0]!, status: "rejected" }],
        repairHistory: [
          {
            attempt: 1,
            phase: "VERIFY",
            cycleId: asQualityCycleId("different-cycle"), // Mismatch!
            requirementIds: [asRequirementId("R1")],
            priorVerdicts: sampleBundle.verdicts,
            priorEvidenceIds: [evId],
            perRequirementAttempts: { R1: 1 },
            fingerprint: crypto.createHash("sha256").update("fp-2").digest("hex"),
            outcome: "failed",
            timestamp: "2026-08-20T10:00:00.000Z",
          },
        ],
        decision: { kind: "repair", to: "FIX", requirementIds: [asRequirementId("R1")] },
        routeIntent: {
          kind: "repair",
          from: "VERIFY",
          to: "FIX",
          requirementIds: [asRequirementId("R1")],
          attempt: 1,
          causedByEventId: causeId,
        },
      }),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  // 20. Latest repair history requirementIds mismatch -> rejected
  await assert.rejects(
    () =>
      store.writeBundle({
        ...sampleBundle,
        verdicts: [{ ...sampleBundle.verdicts[0]!, status: "rejected" }],
        repairHistory: [
          {
            attempt: 1,
            phase: "VERIFY",
            cycleId,
            requirementIds: [asRequirementId("R2")], // Mismatch: decision has R1
            priorVerdicts: sampleBundle.verdicts,
            priorEvidenceIds: [evId],
            perRequirementAttempts: { R2: 1 },
            fingerprint: crypto.createHash("sha256").update("fp-2").digest("hex"),
            outcome: "failed",
            timestamp: "2026-08-20T10:00:00.000Z",
          },
        ],
        decision: { kind: "repair", to: "FIX", requirementIds: [asRequirementId("R1")] },
        routeIntent: {
          kind: "repair",
          from: "VERIFY",
          to: "FIX",
          requirementIds: [asRequirementId("R1")],
          attempt: 1,
          causedByEventId: causeId,
        },
      }),
    (err: unknown) => err instanceof QualityError && err.code === "GATE_EVIDENCE_INVALID"
  );

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});
