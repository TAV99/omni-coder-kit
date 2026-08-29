import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSmokeEvidence,
  renderSmokeEvidenceMarkdown,
  validatePromotionEvidence,
  writeSmokeEvidence,
} from "../../src/v4/compatibility/smoke-evidence";
import { runCompatibilitySmoke } from "../../src/v4/compatibility/smoke-runner";
import { FakeAdapter } from "../../src/v4/testing/fake-adapter";

const base = {
  host: "codex" as const,
  cliVersion: "0.150.1",
  platform: "win32-x64",
  operationId: "smoke-op-1",
  executionId: "smoke-op-1",
  startedAt: "2026-08-29T10:00:00.000+07:00",
  completedAt: "2026-08-29T10:00:10.000+07:00",
  structuredStatus: "succeeded" as const,
  mutationVerified: true,
  contractVerified: true,
  modelCallCount: 1,
};

test("dated_evidence", async () => {
  const evidence = createSmokeEvidence(base);
  assert.equal(evidence.schemaVersion, 1);
  assert.match(evidence.evidenceId, /^smoke-[0-9a-f]{16}$/);
  assert.equal(evidence.correlationVerified, true);
  assert.equal(evidence.liveSmokeVerified, true);
  const markdown = renderSmokeEvidenceMarkdown(evidence);
  assert.match(markdown, /Codex/);
  assert.match(markdown, /0\.150\.1/);
  assert.match(markdown, /win32-x64/);
  assert.match(markdown, /smoke-op-1/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-smoke-evidence-"));
  try {
    const written = await writeSmokeEvidence(root, evidence);
    assert.match(written.jsonPath, /2026-08-29/);
    assert.match(written.markdownPath, /2026-08-29/);
    assert.deepEqual(JSON.parse(await fs.readFile(written.jsonPath, "utf8")), evidence);
    assert.match(await fs.readFile(written.markdownPath, "utf8"), /Live smoke verified: true/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("promotion_fail_closed", () => {
  const evidence = createSmokeEvidence(base);
  const plan = validatePromotionEvidence(evidence, {
    host: "codex",
    cliVersion: "0.150.1",
    platform: "win32-x64",
    now: "2026-08-29T12:00:00.000+07:00",
    maxAgeMs: 24 * 60 * 60 * 1000,
  });
  assert.equal(plan.eligible, true);
  assert.equal(plan.writesManifest, false);

  assert.equal(validatePromotionEvidence(evidence, { ...plan.request, cliVersion: "0.151.0" }).eligible, false);
  assert.equal(
    validatePromotionEvidence(evidence, {
      ...plan.request,
      now: "2026-09-01T12:00:00.000+07:00",
    }).eligible,
    false
  );
  const forged = {
    ...createSmokeEvidence({ ...base, structuredStatus: "failed", mutationVerified: false }),
    liveSmokeVerified: true,
    correlationVerified: true,
  };
  assert.equal(validatePromotionEvidence(forged, plan.request).eligible, false);
});

test("smoke evidence does not qualify mismatched or unsuccessful results", () => {
  assert.equal(createSmokeEvidence({ ...base, executionId: "wrong" }).liveSmokeVerified, false);
  assert.equal(createSmokeEvidence({ ...base, structuredStatus: "failed" }).liveSmokeVerified, false);
  assert.equal(createSmokeEvidence({ ...base, mutationVerified: false }).liveSmokeVerified, false);
});

test("compatibility smoke requires all three paid-run approval signals", async () => {
  const adapter = new FakeAdapter({ outcomes: [] });
  await assert.rejects(
    () => runCompatibilitySmoke({
      host: "codex",
      adapter,
      manifestOptIn: true,
      environmentOptIn: false,
      allowModelCost: true,
      contractVerified: true,
    }),
    /LIVE_SMOKE_NOT_APPROVED/
  );
  assert.equal(adapter.calls.length, 0);
});

test("compatibility smoke persists facts from one correlated workspace mutation", async () => {
  const calls: string[] = [];
  const adapter = {
    id: "codex",
    async probe() {
      return {
        available: true,
        adapterId: "codex",
        version: "0.150.1",
        capabilities: ["workspace.read" as const, "workspace.write" as const, "structured-output" as const],
        diagnostics: [],
      };
    },
    async execute(request: { workspaceDir: string; operationId: string }) {
      calls.push(request.operationId);
      await fs.appendFile(path.join(request.workspaceDir, "README.md"), "Smoke test passed.\n");
      return {
        status: "succeeded",
        executionId: request.operationId,
        summary: "updated README",
        artifacts: [],
        evidence: [],
      };
    },
    async cancel() {},
  };
  const result = await runCompatibilitySmoke({
    host: "codex",
    adapter,
    manifestOptIn: true,
    environmentOptIn: true,
    allowModelCost: true,
    contractVerified: true,
  });
  assert.equal(result.evidence.liveSmokeVerified, true);
  assert.equal(result.evidence.modelCallCount, 1);
  assert.equal(calls.length, 1);
  assert.equal(result.json.includes('"liveSmokeVerified": true'), true);
  assert.match(result.markdown, /Live smoke verified: true/);
});
