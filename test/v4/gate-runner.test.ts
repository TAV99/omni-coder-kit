import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { GateRunner } from "../../src/v4/quality/gate-runner";
import {
  asGateId,
  asQualityCycleId,
  asQualityEvidenceId,
  asRequirementId,
  type GateDefinition,
} from "../../src/v4/contracts/quality";
import { asRunId } from "../../src/v4/contracts/ids";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../../src/v4/process/types";

const dummyGate: GateDefinition = {
  id: asGateId("unit-test"),
  command: "npm",
  args: ["test", "--", "--run"],
  cwd: ".",
  timeoutMs: 30000,
  mandatory: true,
  requirementIds: [asRequirementId("R1")],
  dependsOn: [],
  sideEffect: "read-only",
  retrySafe: true,
};

test("argv_only_execution", async () => {
  let executedReq: ProcessRequest | undefined;
  const fakeRunner: ProcessRunner = {
    async run(req: ProcessRequest): Promise<ProcessResult> {
      executedReq = req;
      return {
        stdout: "PASS",
        stderr: "",
        durationMs: 42,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };

  const gateRunner = new GateRunner();
  const { result, evidence } = await gateRunner.run(dummyGate, {
    runId: asRunId("run-1"),
    cycleId: asQualityCycleId("cycle-1"),
    operationId: "op-gate-1",
    projectRoot: process.cwd(),
    runner: fakeRunner,
  });

  assert.ok(executedReq);
  assert.equal(executedReq.command, "npm");
  assert.deepEqual(executedReq.args, ["test", "--", "--run"]);
  assert.equal(executedReq.timeoutMs, 30000);

  assert.equal(result.status, "passed");
  assert.equal(result.gateId, "unit-test");
  assert.ok(evidence);
  assert.equal(evidence.termination, "exited");
  assert.equal(evidence.exitCode, 0);

  // 1. Test repository root lexical containment check (../../ outside workspace)
  let spawnAttempted = false;
  const escapeRunner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      spawnAttempted = true;
      return {
        stdout: "",
        stderr: "",
        durationMs: 0,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };

  const escapingGate: GateDefinition = {
    ...dummyGate,
    id: asGateId("escape-gate"),
    cwd: "../../outside-workspace",
  };

  const escapeRes = await gateRunner.run(escapingGate, {
    runId: asRunId("run-1"),
    cycleId: asQualityCycleId("cycle-1"),
    operationId: "op-gate-escape",
    projectRoot: path.resolve(process.cwd(), "sandbox"),
    runner: escapeRunner,
  });

  assert.equal(spawnAttempted, false, "Must not spawn process when cwd escapes project root lexically");
  assert.equal(escapeRes.result.status, "inconclusive");
  assert.equal(escapeRes.result.failureSignature, "spawn-error");
  assert.equal(escapeRes.result.evidenceId, undefined);
  assert.equal(escapeRes.evidence, undefined);
  assert.match(escapeRes.result.reason ?? "", /escapes project root|cannot be resolved/i);

  // 2. Test symlink / junction containment escape (actual temp root + outside dir + junction)
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omni-root-"));
  const tempOutside = fs.mkdtempSync(path.join(os.tmpdir(), "omni-outside-"));
  const symlinkInsideRoot = path.join(tempRoot, "symlinked-outside");

  try {
    const symlinkType = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(tempOutside, symlinkInsideRoot, symlinkType);

    let symlinkSpawnAttempted = false;
    const symlinkRunner: ProcessRunner = {
      async run(): Promise<ProcessResult> {
        symlinkSpawnAttempted = true;
        return {
          stdout: "",
          stderr: "",
          durationMs: 0,
          termination: "exited",
          exitCode: 0,
          signal: null,
        };
      },
    };

    const symlinkGate: GateDefinition = {
      ...dummyGate,
      id: asGateId("symlink-gate"),
      cwd: "./symlinked-outside",
    };

    const symlinkRes = await gateRunner.run(symlinkGate, {
      runId: asRunId("run-1"),
      cycleId: asQualityCycleId("cycle-1"),
      operationId: "op-gate-symlink",
      projectRoot: tempRoot,
      runner: symlinkRunner,
    });

    assert.equal(symlinkSpawnAttempted, false, "Must not spawn process when cwd escapes project root via symlink/junction");
    assert.equal(symlinkRes.result.status, "inconclusive");
    assert.equal(symlinkRes.result.failureSignature, "spawn-error");
    assert.equal(symlinkRes.result.evidenceId, undefined);
    assert.equal(symlinkRes.evidence, undefined);
    assert.match(symlinkRes.result.reason ?? "", /escapes project root|cannot be resolved/i);
  } finally {
    try {
      if (fs.existsSync(symlinkInsideRoot)) {
        fs.unlinkSync(symlinkInsideRoot);
      }
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(tempOutside, { recursive: true, force: true });
    } catch {
      // safe cleanup
    }
  }

  // 3. Test nonexistent cwd: no spawn, inconclusive, no evidence
  let nonexistentSpawnAttempted = false;
  const nonexistentRunner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      nonexistentSpawnAttempted = true;
      return {
        stdout: "",
        stderr: "",
        durationMs: 0,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };

  const nonexistentGate: GateDefinition = {
    ...dummyGate,
    id: asGateId("nonexistent-gate"),
    cwd: "./nonexistent-directory-98765",
  };

  const nonexistentRes = await gateRunner.run(nonexistentGate, {
    runId: asRunId("run-1"),
    cycleId: asQualityCycleId("cycle-1"),
    operationId: "op-gate-nonexistent",
    projectRoot: process.cwd(),
    runner: nonexistentRunner,
  });

  assert.equal(nonexistentSpawnAttempted, false, "Must not spawn process when cwd does not exist");
  assert.equal(nonexistentRes.result.status, "inconclusive");
  assert.equal(nonexistentRes.result.failureSignature, "spawn-error");
  assert.equal(nonexistentRes.result.evidenceId, undefined);
  assert.equal(nonexistentRes.evidence, undefined);
});

test("records_command_evidence", async () => {
  const fakeRunner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      return {
        stdout: "ok",
        stderr: "",
        durationMs: 123,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };

  const gateRunner = new GateRunner();
  const nowFixed = "2026-08-20T10:00:00.000Z";
  const { result, evidence } = await gateRunner.run(dummyGate, {
    runId: asRunId("run-1"),
    cycleId: asQualityCycleId("cycle-1"),
    operationId: "op-gate-1",
    projectRoot: process.cwd(),
    runner: fakeRunner,
    now: () => nowFixed,
    newEvidenceId: () => asQualityEvidenceId("ev-fixed-1"),
  });

  assert.equal(result.startedAt, nowFixed);
  assert.equal(result.evidenceId, "ev-fixed-1");
  assert.ok(evidence);
  assert.equal(evidence.startedAt, nowFixed);
  assert.equal(evidence.durationMs, 123);
  assert.equal(evidence.evidenceId, "ev-fixed-1");
  assert.deepEqual(evidence.command, ["npm", "test", "--", "--run"]);
  assert.equal(evidence.runId, "run-1");
  assert.equal(evidence.cycleId, "cycle-1");
  assert.equal(evidence.gateId, "unit-test");
  assert.equal(evidence.operationId, "op-gate-1");
});

test("bounds_output_summaries", async () => {
  // UTF-8 multi-byte string: Vietnamese diacritics and emojis
  const multiByteStr = "Xin chào các bạn 👋 🌍! ".repeat(500);
  const fakeRunner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      return {
        stdout: multiByteStr,
        stderr: "Lỗi hệ thống ❌".repeat(100),
        durationMs: 50,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };

  const gateRunner = new GateRunner();
  // Bound to 25 bytes - ensures multi-byte character boundary is respected
  const { evidence } = await gateRunner.run(dummyGate, {
    runId: asRunId("run-1"),
    cycleId: asQualityCycleId("cycle-1"),
    operationId: "op-gate-1",
    projectRoot: process.cwd(),
    runner: fakeRunner,
    outputSummaryBytes: 25,
  });

  assert.ok(evidence);
  const stdoutBuf = Buffer.from(evidence.stdoutSummary, "utf-8");
  assert.ok(stdoutBuf.length <= 25, `Expected summary byte length <= 25, got ${stdoutBuf.length}`);
  // Ensure no replacement characters \uFFFD from broken multi-byte sequences
  assert.equal(evidence.stdoutSummary.includes("\uFFFD"), false);

  const stderrBuf = Buffer.from(evidence.stderrSummary, "utf-8");
  assert.ok(stderrBuf.length <= 25, `Expected stderr summary byte length <= 25, got ${stderrBuf.length}`);
  assert.equal(evidence.stderrSummary.includes("\uFFFD"), false);
});

test("records_output_digests", async () => {
  const fullStdout = "FULL STDOUT CONTENT WITH SPECIAL CHARACTERS: \u0000\u001b[31mError\u001b[0m";
  const fullStderr = "FULL STDERR CONTENT";
  const expectedStdoutSha = crypto.createHash("sha256").update(fullStdout).digest("hex");
  const expectedStderrSha = crypto.createHash("sha256").update(fullStderr).digest("hex");

  const fakeRunner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      return {
        stdout: fullStdout,
        stderr: fullStderr,
        durationMs: 50,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };

  const gateRunner = new GateRunner();
  const { evidence } = await gateRunner.run(dummyGate, {
    runId: asRunId("run-1"),
    cycleId: asQualityCycleId("cycle-1"),
    operationId: "op-gate-1",
    projectRoot: process.cwd(),
    runner: fakeRunner,
    outputSummaryBytes: 10, // summaries are truncated but digests reflect full output
  });

  assert.ok(evidence);
  assert.equal(evidence.stdoutSha256, expectedStdoutSha);
  assert.equal(evidence.stderrSha256, expectedStderrSha);
  assert.match(evidence.stdoutSha256, /^[0-9a-f]{64}$/);
  assert.match(evidence.stderrSha256, /^[0-9a-f]{64}$/);
});

test("redacts_environment", async () => {
  const fakeRunner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      return {
        stdout: "done",
        stderr: "",
        durationMs: 10,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };

  const gateRunner = new GateRunner();
  const { evidence } = await gateRunner.run(dummyGate, {
    runId: asRunId("run-1"),
    cycleId: asQualityCycleId("cycle-1"),
    operationId: "op-gate-1",
    projectRoot: process.cwd(),
    runner: fakeRunner,
  });

  assert.ok(evidence);
  assert.equal("env" in evidence, false);
  assert.equal("environment" in evidence, false);
  assert.equal("processEnv" in evidence, false);
});

test("termination_taxonomy", async () => {
  const gateRunner = new GateRunner();
  const baseContext = {
    runId: asRunId("run-1"),
    cycleId: asQualityCycleId("cycle-1"),
    operationId: "op-gate-1",
    projectRoot: process.cwd(),
  };

  // 1. Nonzero exit -> failed
  const failRes = await gateRunner.run(dummyGate, {
    ...baseContext,
    runner: {
      async run(): Promise<ProcessResult> {
        return {
          stdout: "",
          stderr: "Test failed with assert error",
          durationMs: 10,
          termination: "exited",
          exitCode: 1,
          signal: null,
        };
      },
    },
  });
  assert.equal(failRes.result.status, "failed");
  assert.ok(failRes.evidence);
  assert.equal(failRes.evidence.exitCode, 1);

  // 2. Timed out -> inconclusive
  const timeoutRes = await gateRunner.run(dummyGate, {
    ...baseContext,
    runner: {
      async run(): Promise<ProcessResult> {
        return {
          stdout: "",
          stderr: "",
          durationMs: 30000,
          termination: "timed-out",
          exitCode: null,
          signal: null,
        };
      },
    },
  });
  assert.equal(timeoutRes.result.status, "inconclusive");
  assert.equal(timeoutRes.result.failureSignature, "timed-out");

  // 3. Aborted -> inconclusive
  const abortRes = await gateRunner.run(dummyGate, {
    ...baseContext,
    runner: {
      async run(): Promise<ProcessResult> {
        return {
          stdout: "",
          stderr: "",
          durationMs: 50,
          termination: "aborted",
          exitCode: null,
          signal: null,
        };
      },
    },
  });
  assert.equal(abortRes.result.status, "inconclusive");
  assert.equal(abortRes.result.failureSignature, "aborted");

  // 4. Output limit -> inconclusive
  const limitRes = await gateRunner.run(dummyGate, {
    ...baseContext,
    runner: {
      async run(): Promise<ProcessResult> {
        return {
          stdout: "",
          stderr: "",
          durationMs: 50,
          termination: "output-limit",
          exitCode: null,
          signal: null,
        };
      },
    },
  });
  assert.equal(limitRes.result.status, "inconclusive");
  assert.equal(limitRes.result.failureSignature, "output-limit");

  // 5. Spawn error -> inconclusive
  const spawnRes = await gateRunner.run(dummyGate, {
    ...baseContext,
    runner: {
      async run(): Promise<ProcessResult> {
        return {
          stdout: "",
          stderr: "",
          durationMs: 5,
          termination: "spawn-error",
          exitCode: null,
          signal: null,
          error: { code: "ENOENT", message: "binary not found" },
        };
      },
    },
  });
  assert.equal(spawnRes.result.status, "inconclusive");
  assert.equal(spawnRes.result.failureSignature, "spawn-error");
});

test("passed_requires_zero_exit_and_evidence", async () => {
  const gateRunner = new GateRunner();

  // Valid exit 0 -> passed
  const passRes = await gateRunner.run(dummyGate, {
    runId: asRunId("run-1"),
    cycleId: asQualityCycleId("cycle-1"),
    operationId: "op-gate-1",
    projectRoot: process.cwd(),
    runner: {
      async run(): Promise<ProcessResult> {
        return {
          stdout: "All 10 tests passed",
          stderr: "",
          durationMs: 100,
          termination: "exited",
          exitCode: 0,
          signal: null,
        };
      },
    },
  });
  assert.equal(passRes.result.status, "passed");
  assert.ok(passRes.evidence);
  assert.equal(passRes.evidence.exitCode, 0);
  assert.equal(passRes.evidence.termination, "exited");
  assert.equal(passRes.result.evidenceId, passRes.evidence.evidenceId);

  // Nonzero exit code -> cannot report passed
  const failRes = await gateRunner.run(dummyGate, {
    runId: asRunId("run-1"),
    cycleId: asQualityCycleId("cycle-1"),
    operationId: "op-gate-2",
    projectRoot: process.cwd(),
    runner: {
      async run(): Promise<ProcessResult> {
        return {
          stdout: "",
          stderr: "Assertion error",
          durationMs: 100,
          termination: "exited",
          exitCode: 1,
          signal: null,
        };
      },
    },
  });
  assert.notEqual(failRes.result.status, "passed");
  assert.equal(failRes.result.status, "failed");

  // Invalid constructed evidence (e.g. negative durationMs) -> cannot report passed, fails closed with GATE_EVIDENCE_INVALID and omitted evidence
  const badEvRes = await gateRunner.run(dummyGate, {
    runId: asRunId("run-1"),
    cycleId: asQualityCycleId("cycle-1"),
    operationId: "op-gate-3",
    projectRoot: process.cwd(),
    runner: {
      async run(): Promise<ProcessResult> {
        return {
          stdout: "OK",
          stderr: "",
          durationMs: -1, // Negative duration triggers schema validation failure
          termination: "exited",
          exitCode: 0,
          signal: null,
        };
      },
    },
  });
  assert.notEqual(badEvRes.result.status, "passed");
  assert.equal(badEvRes.result.status, "inconclusive");
  assert.equal(badEvRes.result.failureSignature, "GATE_EVIDENCE_INVALID");
  assert.equal(badEvRes.result.evidenceId, undefined);
  assert.equal(badEvRes.evidence, undefined);
});
