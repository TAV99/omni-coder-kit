import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseAntigravityExecution } from "../../src/v4/adapters/antigravity/parser";
import type { ProcessResult } from "../../src/v4/process/types";

const successJson = fs.readFileSync(
  path.resolve(__dirname, "../fixtures/v4/hosts/antigravity/success.json"),
  "utf-8"
);

test("antigravity-parser: parses valid envelope and extracts session/usage metadata", () => {
  const proc: ProcessResult = {
    stdout: successJson,
    stderr: "",
    durationMs: 100,
    termination: "exited",
    exitCode: 0,
    signal: null,
  };

  const stepResult = parseAntigravityExecution({
    executionId: "exec-1",
    process: proc,
  });

  assert.equal(stepResult.status, "succeeded");
  if (stepResult.status === "succeeded") {
    assert.equal(stepResult.executionId, "exec-1");
    assert.equal(stepResult.native?.sessionId, "00000000-0000-0000-0000-000000000003");
    assert.equal(stepResult.native?.usage?.totalTokens, 30);
  }
});

test("antigravity-parser: error envelope returns failure", () => {
  const failedJson = fs.readFileSync(
    path.resolve(__dirname, "../fixtures/v4/hosts/antigravity/failed.json"),
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

  const stepResult = parseAntigravityExecution({
    executionId: "exec-1",
    process: proc,
  });

  assert.equal(stepResult.status, "failed");
});

test("antigravity-parser: malformed JSON returns malformed output failure", () => {
  const proc: ProcessResult = {
    stdout: "not valid json",
    stderr: "",
    durationMs: 10,
    termination: "exited",
    exitCode: 0,
    signal: null,
  };

  const stepResult = parseAntigravityExecution({
    executionId: "exec-1",
    process: proc,
  });

  assert.equal(stepResult.status, "failed");
  if (stepResult.status === "failed") {
    assert.equal(stepResult.failure.signature, "antigravity:malformed_output");
  }
});
