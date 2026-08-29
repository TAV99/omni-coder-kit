import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseCodexExecution } from "../../src/v4/adapters/codex/parser";
import type { ProcessResult } from "../../src/v4/process/types";

const successJsonl = fs.readFileSync(
  path.resolve(__dirname, "../fixtures/v4/hosts/codex/success.jsonl"),
  "utf-8"
);

test("codex-parser: successfully parses valid outcome and extracts JSONL native metadata", () => {
  const resultJson = JSON.stringify({
    status: "succeeded",
    executionId: "exec-1",
    summary: "Task finished successfully",
    artifacts: [],
    evidence: [],
  });

  const proc: ProcessResult = {
    stdout: successJsonl,
    stderr: "",
    durationMs: 120,
    termination: "exited",
    exitCode: 0,
    signal: null,
  };

  const stepResult = parseCodexExecution({
    executionId: "exec-1",
    process: proc,
    resultText: resultJson,
  });

  assert.equal(stepResult.status, "succeeded");
  if (stepResult.status === "succeeded") {
    assert.equal(stepResult.executionId, "exec-1");
    assert.equal(stepResult.native?.sessionId, "00000000-0000-0000-0000-000000000001");
    assert.equal(stepResult.native?.usage?.totalTokens, 15);
  }
});

test("codex-parser: unwraps the object-root structured-output envelope", () => {
  const resultJson = JSON.stringify({
    outcome: {
      status: "succeeded",
      executionId: "exec-1",
      summary: "Task finished successfully",
      artifacts: [],
      evidence: [],
    },
  });
  const proc: ProcessResult = {
    stdout: successJsonl,
    stderr: "",
    durationMs: 120,
    termination: "exited",
    exitCode: 0,
    signal: null,
  };

  const stepResult = parseCodexExecution({
    executionId: "exec-1",
    process: proc,
    resultText: resultJson,
  });

  assert.equal(stepResult.status, "succeeded");
});

test("codex-parser: non-zero exit returns failure even if result text exists", () => {
  const resultJson = JSON.stringify({
    status: "succeeded",
    executionId: "exec-1",
    summary: "ok",
    artifacts: [],
    evidence: [],
  });

  const proc: ProcessResult = {
    stdout: "",
    stderr: "API timeout",
    durationMs: 50,
    termination: "exited",
    exitCode: 1,
    signal: null,
  };

  const stepResult = parseCodexExecution({
    executionId: "exec-1",
    process: proc,
    resultText: resultJson,
  });

  assert.equal(stepResult.status, "failed");
});

test("codex-parser: non-zero exit without structured result returns failure", () => {
  const proc: ProcessResult = {
    stdout: "",
    stderr: "network unavailable",
    durationMs: 50,
    termination: "exited",
    exitCode: 1,
    signal: null,
  };

  const stepResult = parseCodexExecution({
    executionId: "exec-unstructured-nonzero",
    process: proc,
  });

  assert.equal(stepResult.status, "failed");
  if (stepResult.status === "failed") {
    assert.equal(stepResult.failure.code, "CODEX_CLI_EXIT");
  }
});

test("codex-parser: missing result text returns malformed output failure", () => {
  const proc: ProcessResult = {
    stdout: successJsonl,
    stderr: "",
    durationMs: 120,
    termination: "exited",
    exitCode: 0,
    signal: null,
  };

  const stepResult = parseCodexExecution({
    executionId: "exec-1",
    process: proc,
  });

  assert.equal(stepResult.status, "failed");
  if (stepResult.status === "failed") {
    assert.equal(stepResult.failure.signature, "codex:malformed_output");
  }
});
