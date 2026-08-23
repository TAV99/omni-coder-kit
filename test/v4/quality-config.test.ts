import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { loadQualityConfig, QualityConfigSchema } from "../../src/v4/quality/config";
import { asGateId, asRequirementId } from "../../src/v4/contracts/quality";
import { GateRegistry } from "../../src/v4/quality/gate-registry";
import { loadRequirements } from "../../src/v4/quality/requirements";
import { QualityError } from "../../src/v4/quality/errors";
import { GateScheduler } from "../../src/v4/quality/gate-scheduler";

test("strict_versioned_config", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-quality-test-"));
  const omniDir = path.join(tempDir, ".omni", "v4");
  await fs.mkdir(omniDir, { recursive: true });

  const validConfig = {
    schemaVersion: 1,
    requirementsPath: ".omni/sdlc/requirements.md",
    outputSummaryBytes: 16384,
    maxRepairAttemptsPerRequirement: 2,
    gates: [
      {
        id: "unit-tests",
        command: "npm",
        args: ["test"],
        cwd: ".",
        timeoutMs: 60000,
        mandatory: true,
        requirementIds: ["R1"],
        dependsOn: [],
        sideEffect: "read-only",
        retrySafe: true,
      },
    ],
  };

  await fs.writeFile(
    path.join(omniDir, "quality.json"),
    JSON.stringify(validConfig, null, 2),
    "utf-8"
  );

  const config = await loadQualityConfig(tempDir);
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.gates.length, 1);
  assert.equal(config.gates[0]!.id, "unit-tests");

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("missing_config_fails_closed", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-quality-missing-"));

  await assert.rejects(
    () => loadQualityConfig(tempDir),
    (err: unknown) => err instanceof QualityError && err.code === "QUALITY_CONFIG_MISSING"
  );

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("invalid_config_fails_before_execution", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-quality-invalid-"));
  const omniDir = path.join(tempDir, ".omni", "v4");
  await fs.mkdir(omniDir, { recursive: true });

  // 1. Escaping cwd
  const escapingConfig = {
    schemaVersion: 1,
    requirementsPath: ".omni/sdlc/requirements.md",
    outputSummaryBytes: 16384,
    maxRepairAttemptsPerRequirement: 2,
    gates: [
      {
        id: "escape-gate",
        command: "npm",
        args: ["test"],
        cwd: "../../../etc",
        timeoutMs: 60000,
        mandatory: true,
        requirementIds: ["R1"],
        dependsOn: [],
        sideEffect: "read-only",
        retrySafe: true,
      },
    ],
  };

  await fs.writeFile(
    path.join(omniDir, "quality.json"),
    JSON.stringify(escapingConfig),
    "utf-8"
  );

  await assert.rejects(
    () => loadQualityConfig(tempDir),
    (err: unknown) => err instanceof QualityError && err.code === "QUALITY_CONFIG_INVALID"
  );

  // 2. maxRepairAttemptsPerRequirement > 2
  const badRepairConfig = {
    ...escapingConfig,
    gates: [],
    maxRepairAttemptsPerRequirement: 5,
  };

  await fs.writeFile(
    path.join(omniDir, "quality.json"),
    JSON.stringify(badRepairConfig),
    "utf-8"
  );

  await assert.rejects(
    () => loadQualityConfig(tempDir),
    (err: unknown) => err instanceof QualityError && err.code === "QUALITY_CONFIG_INVALID"
  );

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("default_parallelism_two", () => {
  // R48: maxParallelGates defaults to 2
  const parsed = QualityConfigSchema.parse({
    schemaVersion: 1,
    gates: [],
  });
  assert.equal(parsed.maxParallelGates, 2);

  const scheduler = new GateScheduler();
  assert.ok(scheduler);
});

test("parallelism_bounds", () => {
  // R49: maxParallelGates accepts only integers from 1 through 8
  const s1 = new GateScheduler({ maxParallelGates: 1 });
  assert.ok(s1);

  const s8 = new GateScheduler({ maxParallelGates: 8 });
  assert.ok(s8);

  assert.throws(
    () => new GateScheduler({ maxParallelGates: 0 }),
    (err: unknown) => err instanceof QualityError && err.code === "QUALITY_CONFIG_INVALID"
  );
  assert.throws(
    () => new GateScheduler({ maxParallelGates: 9 }),
    (err: unknown) => err instanceof QualityError && err.code === "QUALITY_CONFIG_INVALID"
  );
  assert.throws(
    () => new GateScheduler({ maxParallelGates: 2.5 }),
    (err: unknown) => err instanceof QualityError && err.code === "QUALITY_CONFIG_INVALID"
  );
});

test("gate_registry", () => {
  const reqs = loadRequirements(`
- [ ] R1 | First req | test: unit-tests
- [ ] R2 | Unmapped req | test: missing-gate
- [ ] R3 | Agent req | test: agent
`);

  const config = {
    schemaVersion: 1 as const,
    requirementsPath: ".omni/sdlc/requirements.md",
    outputSummaryBytes: 16384,
    maxRepairAttemptsPerRequirement: 2,
    maxParallelGates: 2,
    gates: [
      {
        id: asGateId("gate-1"),
        command: "npm",
        args: ["test"],
        cwd: ".",
        timeoutMs: 30000,
        mandatory: true,
        requirementIds: [asRequirementId("R1")],
        dependsOn: [],
        sideEffect: "read-only" as const,
        retrySafe: true,
      },
    ],
  };

  const registry = new GateRegistry(config, reqs);
  assert.equal(registry.getAllGates().length, 1);
  assert.deepEqual(registry.getMappedRequirements(), ["R1"]);

  const unmapped = registry.getUnmappedHardRequirements();
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0]!.requirementId, "R2");
});
