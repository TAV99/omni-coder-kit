import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HOSTILE_PROCESS_PHASES,
  HOSTILE_LIFECYCLE_CUT_POINTS,
  HostileProcessEvidenceSchema,
  runHostileProcessQualification,
} from "../../src/v4/testing/hostile-process";
import { REQUIRED_CHAOS_SCENARIOS } from "../../src/v4/testing/chaos-manifest";

test("r83_hostile_process_qualification", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-hostile-process-"));
  try {
    const result = await runHostileProcessQualification({
      outputRoot: path.join(root, "evidence"),
      workingRoot: path.join(root, "runs"),
      now: () => "2026-08-29T10:15:00.000Z",
      markerTimeoutMs: 10_000,
    });

    const evidence = HostileProcessEvidenceSchema.parse(result.evidence);
    assert.equal(REQUIRED_CHAOS_SCENARIOS.length, 11);
    assert.ok(REQUIRED_CHAOS_SCENARIOS.every((scenario) => scenario.qualification === "component"));
    assert.deepEqual(evidence.phases.map((item) => item.phase), HOSTILE_PROCESS_PHASES);
    assert.deepEqual(
      evidence.cutPoints.map((item) => item.id),
      HOSTILE_LIFECYCLE_CUT_POINTS.map((item) => item.id)
    );
    for (const [index, item] of evidence.cutPoints.entries()) {
      const expected = HOSTILE_LIFECYCLE_CUT_POINTS[index]!;
      assert.equal(item.recoveryKind, expected.expectedRecoveryKind);
      assert.equal(item.recoveredPhase, expected.expectedRecoveredPhase);
      assert.equal(item.markerObserved, true);
      assert.equal(item.killExternal, true);
      assert.equal(item.killSignal, "SIGKILL");
      assert.equal(item.secondProcessStarted, true);
    }
    assert.equal(evidence.phases.length, HOSTILE_PROCESS_PHASES.length);
    const totalCases = HOSTILE_PROCESS_PHASES.length + HOSTILE_LIFECYCLE_CUT_POINTS.length;
    assert.equal(evidence.externalKillCount, totalCases);
    assert.equal(evidence.recoveryProcessCount, totalCases);
    assert.equal(evidence.falseSuccessCount, 0);
    assert.equal(evidence.qualified, true);

    for (const item of evidence.phases) {
      assert.equal(item.markerObserved, true);
      assert.equal(item.killExternal, true);
      assert.equal(item.killSignal, "SIGKILL");
      assert.equal(item.firstProcessExited, true);
      assert.equal(item.secondProcessStarted, true);
      assert.equal(item.recoveryKind, "rerun");
      assert.notEqual(item.recoveredPhase, "READY");
    }

    const json = JSON.parse(await fs.readFile(result.jsonPath, "utf8"));
    assert.deepEqual(json, evidence);
    const markdown = await fs.readFile(result.markdownPath, "utf8");
    assert.match(markdown, /Hostile Process Kill\/Restart Evidence/);
    assert.match(result.jsonPath.replaceAll("\\", "/"), /2026-08-29\/hostile-process-/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
