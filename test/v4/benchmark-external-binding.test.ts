import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ExternalCaseBindingSchema,
  ExternalBindingFileSchema,
  enforceExternalBindingContract,
  loadExternalBindings,
  requireExternalCaseBinding,
} from "../../src/v4/benchmark/external-binding";
import { BenchmarkLiveTaskSchema } from "../../src/v4/benchmark/contracts";

const revision = "a".repeat(40);

test("external_binding: accepts a strict absolute repository binding", () => {
  const repositoryRoot = path.resolve(os.tmpdir(), "external-binding-repo");
  const parsed = ExternalBindingFileSchema.parse({
    schemaVersion: 1,
    cases: {
      "case-15-external-js-slot": {
        repositoryRoot,
        revision,
        dependencyPolicy: "clean-install",
        toolchain: { node: "v20.19.0", npm: "10.8.2" },
      },
    },
  });

  assert.equal(parsed.cases["case-15-external-js-slot"]?.repositoryRoot, repositoryRoot);
});

test("external_binding: rejects relative roots, short revisions, and unknown keys", () => {
  const base = {
    schemaVersion: 1,
    cases: {
      case15: {
        repositoryRoot: path.resolve(os.tmpdir(), "external-binding-repo"),
        revision,
        dependencyPolicy: "clean-install",
      },
    },
  };

  assert.equal(
    ExternalBindingFileSchema.safeParse({
      ...base,
      cases: { case15: { ...base.cases.case15, repositoryRoot: "relative/repo" } },
    }).success,
    false
  );
  assert.equal(
    ExternalBindingFileSchema.safeParse({
      ...base,
      cases: { case15: { ...base.cases.case15, revision: "abc123" } },
    }).success,
    false
  );
  assert.equal(ExternalBindingFileSchema.safeParse({ ...base, extra: true }).success, false);
  assert.equal(
    ExternalBindingFileSchema.safeParse({
      ...base,
      cases: { case15: { ...base.cases.case15, extra: true } },
    }).success,
    false
  );
});

test("external_binding: loader fails closed without echoing binding contents", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-binding-test-"));
  const malformedPath = path.join(tempDir, "bindings.json");
  await fs.writeFile(malformedPath, '{"secret":"do-not-echo"}', "utf-8");

  await assert.rejects(
    loadExternalBindings(malformedPath),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /BENCHMARK_EXTERNAL_BINDING_INVALID/);
      assert.doesNotMatch(error.message, /do-not-echo/);
      return true;
    }
  );

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("external_binding: exact case lookup is mandatory", () => {
  const parsed = ExternalBindingFileSchema.parse({
    schemaVersion: 1,
    cases: {
      "case-15-external-js-slot": {
        repositoryRoot: path.resolve(os.tmpdir(), "external-binding-repo"),
        revision,
        dependencyPolicy: "existing-lockfile",
      },
    },
  });

  assert.equal(requireExternalCaseBinding(parsed, "case-15-external-js-slot").revision, revision);
  assert.throws(
    () => requireExternalCaseBinding(parsed, "case-15-external-js"),
    /BENCHMARK_EXTERNAL_BINDING_MISSING/
  );
});

test("external_binding: live task contract is typed and workspace-write", () => {
  const parsed = BenchmarkLiveTaskSchema.parse({
    prompt: "Change package.json so npm test runs once.",
    allowedPaths: ["package.json"],
    requiredCapabilities: ["workspace.read", "workspace.write", "structured-output"],
    sideEffect: "workspace-write",
    timeoutMs: 180000,
    outputSummaryBytes: 8192,
    allowedPathPrefixes: ["backend/tests"],
    requiredDependencyPolicy: "clean-install",
    requiredToolchain: { python: "3.13.14" },
    setupCommands: [
      {
        program: "backend/.venv/Scripts/python.exe",
        args: ["-m", "pip", "install", "-r", "requirements.txt"],
        cwd: "backend",
        timeoutMs: 180000,
      },
    ],
    requirements: [
      { id: "EXT-JS-1", text: "npm test runs once and exits deterministically" },
    ],
    gates: [
      {
        id: "external-test",
        command: "npm",
        args: ["test"],
        cwd: ".",
        timeoutMs: 120000,
        mandatory: true,
        requirementIds: ["EXT-JS-1"],
        dependsOn: [],
        sideEffect: "read-only",
        retrySafe: true,
      },
    ],
  });

  assert.equal(parsed.sideEffect, "workspace-write");
  assert.equal(parsed.gates.length, 1);
  assert.equal(parsed.setupCommands[0]?.cwd, "backend");
  assert.equal(parsed.outputSummaryBytes, 8192);
  assert.deepEqual(parsed.allowedPathPrefixes, ["backend/tests"]);
  assert.equal(
    BenchmarkLiveTaskSchema.safeParse({ ...parsed, sideEffect: "read-only" }).success,
    false
  );
});

test("external_binding: setup executables reject absolute paths and traversal", () => {
  const base = {
    prompt: "Maintain a bounded external project.",
    allowedPaths: ["README.md"],
    requiredCapabilities: ["workspace.read", "workspace.write", "structured-output"],
    sideEffect: "workspace-write",
    timeoutMs: 180000,
    setupCommands: [],
    requirements: [{ id: "EXT-1", text: "The gate passes" }],
    gates: [
      {
        id: "external-test",
        command: "python",
        args: ["-m", "pytest"],
        cwd: ".",
        timeoutMs: 120000,
        mandatory: true,
        requirementIds: ["EXT-1"],
        dependsOn: [],
        sideEffect: "read-only",
        retrySafe: true,
      },
    ],
  };

  assert.equal(
    BenchmarkLiveTaskSchema.safeParse({
      ...base,
      setupCommands: [{ program: "C:/Python/python.exe", args: [], cwd: ".", timeoutMs: 1000 }],
    }).success,
    false
  );
  assert.equal(
    BenchmarkLiveTaskSchema.safeParse({
      ...base,
      setupCommands: [{ program: "../python", args: [], cwd: ".", timeoutMs: 1000 }],
    }).success,
    false
  );
});

test("external_binding: enforces declared dependency policy and toolchain without leaking values", () => {
  const parsed = ExternalCaseBindingSchema.parse({
    repositoryRoot: path.resolve(os.tmpdir(), "external-binding-repo"),
    revision,
    dependencyPolicy: "clean-install",
    toolchain: { python: "3.13.14", pytest: "8.4.2" },
  });

  assert.doesNotThrow(() =>
    enforceExternalBindingContract(parsed, {
      requiredDependencyPolicy: "clean-install",
      requiredToolchain: { python: "3.13.14" },
    })
  );
  assert.throws(
    () =>
      enforceExternalBindingContract(parsed, {
        requiredDependencyPolicy: "existing-lockfile",
        requiredToolchain: { python: "3.13.14" },
      }),
    /BENCHMARK_EXTERNAL_DEPENDENCY_POLICY_MISMATCH/
  );
  assert.throws(
    () =>
      enforceExternalBindingContract(parsed, {
        requiredDependencyPolicy: "clean-install",
        requiredToolchain: { python: "unexpected-secret-value" },
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /BENCHMARK_EXTERNAL_TOOLCHAIN_MISMATCH/);
      assert.doesNotMatch(error.message, /unexpected-secret-value/);
      return true;
    }
  );
});
