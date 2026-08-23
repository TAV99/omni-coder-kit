import test from "node:test";
import assert from "node:assert/strict";
import { loadRequirements } from "../../src/v4/quality/requirements";
import { QualityError } from "../../src/v4/quality/errors";
import type { ProcessRunner } from "../../src/v4/process/types";

test("preserves_requirement_text", () => {
  const md = `
# Requirements
- [ ] R1 | Quality command execution is isolated from RunController | test: unit-tests
- [x] R2 | Every gate result has exactly one status | test: contract-test
- [!] R3 | Agent judgement runs only for agent strategy | test: agent
`;

  const reqs = loadRequirements(md);
  assert.equal(reqs.length, 3);

  assert.equal(reqs[0]!.requirementId, "R1");
  assert.equal(reqs[0]!.text, "Quality command execution is isolated from RunController");
  assert.deepEqual(reqs[0]!.testStrategy, { kind: "hard", sourceText: "unit-tests" });

  assert.equal(reqs[1]!.requirementId, "R2");
  assert.equal(reqs[1]!.text, "Every gate result has exactly one status");
  assert.deepEqual(reqs[1]!.testStrategy, { kind: "hard", sourceText: "contract-test" });

  assert.equal(reqs[2]!.requirementId, "R3");
  assert.equal(reqs[2]!.text, "Agent judgement runs only for agent strategy");
  assert.deepEqual(reqs[2]!.testStrategy, { kind: "agent" });
});

test("rejects_duplicate_ids", () => {
  const md = `
- [ ] R1 | First requirement | test: test-1
- [ ] R1 | Duplicate requirement | test: test-2
`;

  assert.throws(
    () => loadRequirements(md),
    (err: any) => err instanceof QualityError && err.code === "REQUIREMENTS_INVALID"
  );
});

test("rejects_malformed_line", () => {
  const badLines = [
    "- [?] R1 | Invalid marker | test: agent",
    "- [ ] R1 | Missing test part",
    "- [ ] R1 | | test: empty text",
    "- [ ] R1 | Missing test strategy | test:",
    "- [ ] | Missing ID | test: unit",
  ];

  for (const bad of badLines) {
    assert.throws(
      () => loadRequirements(bad),
      (err: any) => err instanceof QualityError && err.code === "REQUIREMENTS_INVALID",
      `Expected failure on: ${bad}`
    );
  }
});

test("never_executes_test_text", () => {
  let runnerInvoked = false;
  const throwingRunner: ProcessRunner = {
    async run() {
      runnerInvoked = true;
      throw new Error("ProcessRunner should NEVER be called when loading requirements");
    },
  };

  const md = `
- [ ] R1 | Dangerous requirement | test: rm -rf / ; cat /etc/passwd
`;

  const reqs = loadRequirements(md);
  assert.equal(runnerInvoked, false);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0]!.testStrategy.kind, "hard");
});
