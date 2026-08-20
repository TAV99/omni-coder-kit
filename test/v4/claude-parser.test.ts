import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseClaudeExecution } from "../../src/v4/adapters/claude/parser";
import type { ProcessResult } from "../../src/v4/process/types";

const successJson = fs.readFileSync(
  path.resolve(__dirname, "../fixtures/v4/hosts/claude/success.json"),
  "utf-8"
);

test("claude-parser: parses valid envelope and extracts session/cost metadata", () => {
  const proc: ProcessResult = {
    stdout: successJson,
    stderr: "",
    durationMs: 100,
    termination: "exited",
    exitCode: 0,
    signal: null,
  };

  const stepResult = parseClaudeExecution({
    executionId: "exec-1",
    process: proc,
  });

  assert.equal(stepResult.status, "succeeded");
  if (stepResult.status === "succeeded") {
    assert.equal(stepResult.executionId, "exec-1");
    assert.equal(stepResult.native?.sessionId, "00000000-0000-0000-0000-000000000002");
    assert.equal(stepResult.native?.usage?.costUsd, 0.001);
  }
});

test("claude-parser: error envelope returns failure", () => {
  const failedJson = fs.readFileSync(
    path.resolve(__dirname, "../fixtures/v4/hosts/claude/failed.json"),
    "utf-8"
  );

  const proc: ProcessResult = {
    stdout: failedJson,
    stderr: "",
    durationMs: 50,
    termination: "exited",
    exitCode: 0,
    signal: null,
  };

  const stepResult = parseClaudeExecution({
    executionId: "exec-1",
    process: proc,
  });

  assert.equal(stepResult.status, "failed");
});

test("claude-parser: malformed JSON returns malformed output failure", () => {
  const proc: ProcessResult = {
    stdout: "not valid json",
    stderr: "",
    durationMs: 10,
    termination: "exited",
    exitCode: 0,
    signal: null,
  };

  const stepResult = parseClaudeExecution({
    executionId: "exec-1",
    process: proc,
  });

  assert.equal(stepResult.status, "failed");
  if (stepResult.status === "failed") {
    assert.equal(stepResult.failure.signature, "claude:malformed_output");
  }
});
