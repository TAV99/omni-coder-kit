import test from "node:test";
import assert from "node:assert/strict";
import { AgentJudge } from "../../src/v4/quality/agent-judge";
import {
  asRequirementId,
  asQualityCycleId,
  asQualityEvidenceId,
  asGateId,
  type RequirementRecord,
  type QualityEvidence,
} from "../../src/v4/contracts/quality";
import { asRunId, asStepId } from "../../src/v4/contracts/ids";
import type { AgentAdapter, StepRequest, AdapterContext } from "../../src/v4/contracts/adapter";
import { AcceptanceEngine } from "../../src/v4/quality/acceptance-engine";
import { QualityError } from "../../src/v4/quality/errors";

const runId = asRunId("run-1");
const cycleId = asQualityCycleId("cycle-1");
const evId = asQualityEvidenceId("ev-1");

const agentReq: RequirementRecord = {
  requirementId: asRequirementId("R21"),
  text: "UI matches layout specification",
  testStrategy: { kind: "agent" },
};

const hardReq: RequirementRecord = {
  requirementId: asRequirementId("R1"),
  text: "Unit test passes",
  testStrategy: { kind: "hard", sourceText: "test: npm test" },
};

const sampleEvidence: QualityEvidence = {
  schemaVersion: 1,
  evidenceId: evId,
  runId,
  cycleId,
  gateId: asGateId("unit-test"),
  operationId: "op-1",
  command: ["npm", "test"],
  cwd: "/workspace",
  timeoutMs: 30000,
  termination: "exited",
  exitCode: 0,
  startedAt: "2026-08-20T10:00:00.000Z",
  durationMs: 100,
  stdoutSummary: "PASS",
  stderrSummary: "",
  stdoutSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  stderrSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  artifactIds: [],
};

test("agent_strategy_only", async () => {
  const judge = new AgentJudge();
  const fakeAdapter: AgentAdapter = {
    id: "fake",
    async probe() {
      return { available: true, adapterId: "fake", capabilities: ["workspace.read"], diagnostics: [] };
    },
    async execute(): Promise<unknown> {
      throw new Error("should not be called for hard requirement");
    },
    async cancel() {},
  };

  await assert.rejects(
    () =>
      judge.judgeRequirement(hardReq, {
        runId,
        cycleId,
        stepId: asStepId("s-judge"),
        operationId: "op-judge-1",
        workspaceDir: process.cwd(),
        adapter: fakeAdapter,
      }),
    (err: unknown) => err instanceof QualityError && err.code === "AGENT_JUDGE_MALFORMED"
  );
});

test("read_only_no_elevation", async () => {
  const judge = new AgentJudge();
  let capturedRequest: StepRequest | undefined;
  let capturedContext: AdapterContext | undefined;

  const fakeAdapter: AgentAdapter = {
    id: "fake",
    async probe() {
      return { available: true, adapterId: "fake", capabilities: ["workspace.read"], diagnostics: [] };
    },
    async execute(request: StepRequest, context: AdapterContext): Promise<unknown> {
      capturedRequest = request;
      capturedContext = context;
      return {
        status: "succeeded",
        resultText: JSON.stringify({
          requirementId: "R21",
          status: "accepted",
          rationale: "Read-only inspection verified",
          evidenceIds: [evId],
        }),
      };
    },
    async cancel() {},
  };

  const judgement = await judge.judgeRequirement(agentReq, {
    runId,
    cycleId,
    stepId: asStepId("s-judge"),
    operationId: "op-judge-1",
    workspaceDir: process.cwd(),
    adapter: fakeAdapter,
    existingEvidence: [sampleEvidence],
  });

  assert.equal(judgement.status, "accepted");
  assert.deepEqual(judgement.evidenceIds, [evId]);
  assert.ok(capturedRequest);
  assert.equal(capturedRequest.sideEffect, "read-only");
  assert.deepEqual(capturedRequest.requiredCapabilities, ["workspace.read"]);
  assert.ok(capturedContext);
  assert.equal(capturedContext.elevatedPermissions, false);
});

test("cannot_forge_hard_evidence", async () => {
  const judge = new AgentJudge();

  const makeForgeryAdapter = (evidenceIds: string[]): AgentAdapter => ({
    id: "fake",
    async probe() {
      return { available: true, adapterId: "fake", capabilities: ["workspace.read"], diagnostics: [] };
    },
    async execute(): Promise<unknown> {
      return {
        status: "succeeded",
        resultText: JSON.stringify({
          requirementId: "R21",
          status: "accepted",
          rationale: "Claiming test result",
          evidenceIds,
        }),
      };
    },
    async cancel() {},
  });

  // 1. Agent judge cannot cite non-existent evidence IDs
  const judgementNonExistent = await judge.judgeRequirement(agentReq, {
    runId,
    cycleId,
    stepId: asStepId("s-judge"),
    operationId: "op-judge-1",
    workspaceDir: process.cwd(),
    adapter: makeForgeryAdapter(["forged-ev-999"]),
    existingEvidence: [sampleEvidence], // only ev-1 exists
  });
  assert.equal(judgementNonExistent.status, "inconclusive");
  assert.match(judgementNonExistent.rationale, /AGENT_JUDGE_MALFORMED|unknown/i);

  // 2. Agent judge citing evidence when existingEvidence is undefined/empty
  const judgementEmptyExisting = await judge.judgeRequirement(agentReq, {
    runId,
    cycleId,
    stepId: asStepId("s-judge"),
    operationId: "op-judge-1",
    workspaceDir: process.cwd(),
    adapter: makeForgeryAdapter(["ev-1"]),
    existingEvidence: [],
  });
  assert.equal(judgementEmptyExisting.status, "inconclusive");
  assert.match(judgementEmptyExisting.rationale, /AGENT_JUDGE_MALFORMED/i);

  // 3. Agent judge with invalid cross-run existingEvidence -> AGENT_JUDGE_MALFORMED, execute never called
  let crossRunExecuteCalled = false;
  const crossRunEv: QualityEvidence = {
    ...sampleEvidence,
    runId: asRunId("other-run"),
  };
  const judgementCrossRun = await judge.judgeRequirement(agentReq, {
    runId,
    cycleId,
    stepId: asStepId("s-judge"),
    operationId: "op-judge-1",
    workspaceDir: process.cwd(),
    adapter: {
      id: "fake",
      async probe() {
        return { available: true, adapterId: "fake", capabilities: ["workspace.read"], diagnostics: [] };
      },
      async execute(): Promise<unknown> {
        crossRunExecuteCalled = true;
        return {
          status: "succeeded",
          resultText: JSON.stringify({
            requirementId: "R21",
            status: "accepted",
            rationale: "Claiming test result",
            evidenceIds: [evId],
          }),
        };
      },
      async cancel() {},
    },
    existingEvidence: [crossRunEv],
  });
  assert.equal(judgementCrossRun.status, "inconclusive");
  assert.match(judgementCrossRun.rationale, /AGENT_JUDGE_MALFORMED/i);
  assert.equal(crossRunExecuteCalled, false, "Adapter execute must NOT be called when existingEvidence is invalid");

  // 4. Agent judge with duplicate existingEvidence -> AGENT_JUDGE_MALFORMED, execute never called
  let duplicateExecuteCalled = false;
  const judgementDuplicate = await judge.judgeRequirement(agentReq, {
    runId,
    cycleId,
    stepId: asStepId("s-judge"),
    operationId: "op-judge-1",
    workspaceDir: process.cwd(),
    adapter: {
      id: "fake",
      async probe() {
        return { available: true, adapterId: "fake", capabilities: ["workspace.read"], diagnostics: [] };
      },
      async execute(): Promise<unknown> {
        duplicateExecuteCalled = true;
        return {
          status: "succeeded",
          resultText: JSON.stringify({
            requirementId: "R21",
            status: "accepted",
            rationale: "Claiming test result",
            evidenceIds: [],
          }),
        };
      },
      async cancel() {},
    },
    existingEvidence: [sampleEvidence, sampleEvidence],
  });
  assert.equal(judgementDuplicate.status, "inconclusive");
  assert.match(judgementDuplicate.rationale, /duplicate evidence/i);
  assert.equal(duplicateExecuteCalled, false, "Adapter execute must NOT be called when existingEvidence has duplicates");

  // 4. AcceptanceEngine test: agent judgement cannot satisfy a hard requirement
  const acceptanceEngine = new AcceptanceEngine();
  const verdict = acceptanceEngine.evaluateRequirement(
    hardReq,
    [], // 0 gate results
    [sampleEvidence],
    { runId, cycleId },
    { status: "accepted", rationale: "Agent says hard test passed", evidenceIds: [evId] }
  );
  assert.notEqual(verdict.status, "accepted");
  assert.equal(verdict.status, "inconclusive");
});

test("unavailable_is_inconclusive", async () => {
  const judge = new AgentJudge();

  // 1. Missing adapter
  const noAdapterRes = await judge.judgeRequirement(agentReq, {
    runId,
    cycleId,
    stepId: asStepId("s-judge"),
    operationId: "op-judge-1",
    workspaceDir: process.cwd(),
    adapter: undefined,
  });
  assert.equal(noAdapterRes.status, "inconclusive");
  assert.match(noAdapterRes.rationale, /AGENT_JUDGE_UNAVAILABLE/i);

  // 2. Adapter probe available = false
  const unavailableAdapter: AgentAdapter = {
    id: "fake-unavail",
    async probe() {
      return {
        available: false,
        adapterId: "fake-unavail",
        capabilities: [],
        diagnostics: ["API key not set"],
      };
    },
    async execute(): Promise<unknown> {
      throw new Error("Should not execute");
    },
    async cancel() {},
  };

  const probeUnavailRes = await judge.judgeRequirement(agentReq, {
    runId,
    cycleId,
    stepId: asStepId("s-judge"),
    operationId: "op-judge-1",
    workspaceDir: process.cwd(),
    adapter: unavailableAdapter,
  });
  assert.equal(probeUnavailRes.status, "inconclusive");
  assert.match(probeUnavailRes.rationale, /AGENT_JUDGE_UNAVAILABLE/i);
});

test("malformed_is_inconclusive", async () => {
  const judge = new AgentJudge();

  const makeAdapterWithText = (text: string): AgentAdapter => ({
    id: "fake",
    async probe() {
      return { available: true, adapterId: "fake", capabilities: ["workspace.read"], diagnostics: [] };
    },
    async execute(): Promise<unknown> {
      return {
        status: "succeeded",
        resultText: text,
      };
    },
    async cancel() {},
  });

  // 1. Code fences -> malformed
  const fenceRes = await judge.judgeRequirement(agentReq, {
    runId,
    cycleId,
    stepId: asStepId("s-judge"),
    operationId: "op-judge-1",
    workspaceDir: process.cwd(),
    adapter: makeAdapterWithText("```json\n{\"requirementId\": \"R21\", \"status\": \"accepted\", \"rationale\": \"ok\", \"evidenceIds\": []}\n```"),
  });
  assert.equal(fenceRes.status, "inconclusive");
  assert.match(fenceRes.rationale, /AGENT_JUDGE_MALFORMED/i);

  // 2. Plain prose -> malformed
  const proseRes = await judge.judgeRequirement(agentReq, {
    runId,
    cycleId,
    stepId: asStepId("s-judge"),
    operationId: "op-judge-1",
    workspaceDir: process.cwd(),
    adapter: makeAdapterWithText("Everything looks great to me!"),
  });
  assert.equal(proseRes.status, "inconclusive");
  assert.match(proseRes.rationale, /AGENT_JUDGE_MALFORMED/i);

  // 3. Mismatched requirementId in JSON -> malformed
  const mismatchRes = await judge.judgeRequirement(agentReq, {
    runId,
    cycleId,
    stepId: asStepId("s-judge"),
    operationId: "op-judge-1",
    workspaceDir: process.cwd(),
    adapter: makeAdapterWithText(JSON.stringify({
      requirementId: "R99_WRONG",
      status: "accepted",
      rationale: "Looks good",
      evidenceIds: [],
    })),
  });
  assert.equal(mismatchRes.status, "inconclusive");
  assert.match(mismatchRes.rationale, /AGENT_JUDGE_MALFORMED/i);

  // 4. Missing required rationale -> malformed
  const missingRationaleRes = await judge.judgeRequirement(agentReq, {
    runId,
    cycleId,
    stepId: asStepId("s-judge"),
    operationId: "op-judge-1",
    workspaceDir: process.cwd(),
    adapter: makeAdapterWithText(JSON.stringify({
      requirementId: "R21",
      status: "accepted",
      evidenceIds: [],
    })),
  });
  assert.equal(missingRationaleRes.status, "inconclusive");
  assert.match(missingRationaleRes.rationale, /AGENT_JUDGE_MALFORMED/i);

  // 5. Missing required evidenceIds array -> malformed
  const missingEvIdsRes = await judge.judgeRequirement(agentReq, {
    runId,
    cycleId,
    stepId: asStepId("s-judge"),
    operationId: "op-judge-1",
    workspaceDir: process.cwd(),
    adapter: makeAdapterWithText(JSON.stringify({
      requirementId: "R21",
      status: "accepted",
      rationale: "Looks good",
    })),
  });
  assert.equal(missingEvIdsRes.status, "inconclusive");
  assert.match(missingEvIdsRes.rationale, /AGENT_JUDGE_MALFORMED/i);

  // 6. Rejected alias "reason" instead of "rationale" -> malformed
  const aliasReasonRes = await judge.judgeRequirement(agentReq, {
    runId,
    cycleId,
    stepId: asStepId("s-judge"),
    operationId: "op-judge-1",
    workspaceDir: process.cwd(),
    adapter: makeAdapterWithText(JSON.stringify({
      requirementId: "R21",
      status: "accepted",
      reason: "Looks good",
      evidenceIds: [],
    })),
  });
  assert.equal(aliasReasonRes.status, "inconclusive");
  assert.match(aliasReasonRes.rationale, /AGENT_JUDGE_MALFORMED/i);

  // 7. Rejected alias "citedEvidenceIds" instead of "evidenceIds" -> malformed
  const aliasCitedRes = await judge.judgeRequirement(agentReq, {
    runId,
    cycleId,
    stepId: asStepId("s-judge"),
    operationId: "op-judge-1",
    workspaceDir: process.cwd(),
    adapter: makeAdapterWithText(JSON.stringify({
      requirementId: "R21",
      status: "accepted",
      rationale: "Looks good",
      citedEvidenceIds: [evId],
    })),
  });
  assert.equal(aliasCitedRes.status, "inconclusive");
  assert.match(aliasCitedRes.rationale, /AGENT_JUDGE_MALFORMED/i);

  // 8. Extra unpermitted fields -> malformed
  const extraFieldsRes = await judge.judgeRequirement(agentReq, {
    runId,
    cycleId,
    stepId: asStepId("s-judge"),
    operationId: "op-judge-1",
    workspaceDir: process.cwd(),
    adapter: makeAdapterWithText(JSON.stringify({
      requirementId: "R21",
      status: "accepted",
      rationale: "Looks good",
      evidenceIds: [],
      extraField: 12345,
    })),
  });
  assert.equal(extraFieldsRes.status, "inconclusive");
  assert.match(extraFieldsRes.rationale, /AGENT_JUDGE_MALFORMED/i);

  // 9. Duplicate evidenceIds in list -> malformed
  const duplicateEvIdsRes = await judge.judgeRequirement(agentReq, {
    runId,
    cycleId,
    stepId: asStepId("s-judge"),
    operationId: "op-judge-1",
    workspaceDir: process.cwd(),
    adapter: makeAdapterWithText(JSON.stringify({
      requirementId: "R21",
      status: "accepted",
      rationale: "Looks good",
      evidenceIds: [evId, evId],
    })),
    existingEvidence: [sampleEvidence],
  });
  assert.equal(duplicateEvIdsRes.status, "inconclusive");
  assert.match(duplicateEvIdsRes.rationale, /duplicate evidence/i);
});
