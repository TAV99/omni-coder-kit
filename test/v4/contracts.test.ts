import test from "node:test";
import assert from "node:assert/strict";
import { V4_SCHEMA_VERSION } from "../../src/v4/index";
import {
  StepResultSchema,
  type StepResult,
} from "../../src/v4/contracts";

test("v4 exports schema version 1", () => {
  assert.equal(V4_SCHEMA_VERSION, 1);
});

test("StepResultSchema accepts a complete success", () => {
  const result = StepResultSchema.parse({
    status: "succeeded",
    executionId: "exec-1",
    summary: "wrote one file",
    artifacts: [],
    evidence: [],
  }) satisfies StepResult;
  assert.equal(result.status, "succeeded");
});

test("StepResultSchema rejects prose-only success", () => {
  assert.throws(() => StepResultSchema.parse({ ok: true, summary: "done" }));
});

test("StepResultSchema rejects failure without a stable signature", () => {
  assert.throws(() => StepResultSchema.parse({
    status: "failed",
    executionId: "exec-1",
    failure: { code: "CLI_EXIT", message: "failed", retryable: true },
  }));
});
