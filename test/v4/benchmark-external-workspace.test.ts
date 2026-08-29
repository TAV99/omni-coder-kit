import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExternalCaseBinding } from "../../src/v4/benchmark/external-binding";
import {
  captureWorkspaceSnapshot,
  compareWorkspaceSnapshots,
  inspectExternalRepository,
  stagePinnedTrackedTree,
} from "../../src/v4/benchmark/external-workspace";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf-8",
    windowsHide: true,
    shell: false,
  }).trim();
}

async function createRepository(): Promise<{ root: string; revision: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-external-repo-"));
  git(root, ["init"]);
  git(root, ["config", "user.name", "Omni Test"]);
  git(root, ["config", "user.email", "omni-test@example.invalid"]);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{"test":"vitest"}}\n', "utf-8");
  await fs.writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n", "utf-8");
  await fs.writeFile(path.join(root, ".env.example"), "API_URL=http://localhost\n", "utf-8");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "baseline"]);
  return { root, revision: git(root, ["rev-parse", "HEAD"]) };
}

function binding(root: string, revision: string): ExternalCaseBinding {
  return {
    repositoryRoot: root,
    revision,
    dependencyPolicy: "clean-install",
  };
}

test("external_workspace: stages exact bytes from a clean pinned tree", async () => {
  const repo = await createRepository();
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "omni-external-stage-"));

  const inspected = inspectExternalRepository(binding(repo.root, repo.revision));
  const staged = await stagePinnedTrackedTree(binding(repo.root, repo.revision), destination);

  assert.equal(inspected.revision, repo.revision);
  assert.equal(inspected.isDirty, false);
  assert.equal(staged.trackedFileCount, 3);
  assert.match(staged.treeSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    await fs.readFile(path.join(destination, "src", "index.ts"), "utf-8"),
    "export const value = 1;\n"
  );
  assert.equal(await fs.readFile(path.join(destination, ".env.example"), "utf-8"), "API_URL=http://localhost\n");
  await assert.rejects(fs.access(path.join(destination, ".git")));

  await fs.rm(repo.root, { recursive: true, force: true });
  await fs.rm(destination, { recursive: true, force: true });
});

test("external_workspace: rejects dirty, stale, and commitless repositories", async () => {
  const repo = await createRepository();
  await fs.writeFile(path.join(repo.root, "untracked.txt"), "dirty", "utf-8");
  assert.throws(
    () => inspectExternalRepository(binding(repo.root, repo.revision)),
    /BENCHMARK_EXTERNAL_SOURCE_DIRTY/
  );
  await fs.rm(path.join(repo.root, "untracked.txt"));

  await fs.writeFile(path.join(repo.root, "src", "index.ts"), "export const value = 2;\n", "utf-8");
  git(repo.root, ["add", "src/index.ts"]);
  git(repo.root, ["commit", "-m", "second"]);
  assert.throws(
    () => inspectExternalRepository(binding(repo.root, repo.revision)),
    /BENCHMARK_EXTERNAL_REVISION_MISMATCH/
  );

  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "omni-external-empty-"));
  git(empty, ["init"]);
  assert.throws(
    () => inspectExternalRepository(binding(empty, "b".repeat(40))),
    /BENCHMARK_EXTERNAL_SOURCE_INVALID/
  );

  await fs.rm(repo.root, { recursive: true, force: true });
  await fs.rm(empty, { recursive: true, force: true });
});

test("external_workspace: rejects a binding that points inside a repository", async () => {
  const repo = await createRepository();
  assert.throws(
    () => inspectExternalRepository(binding(path.join(repo.root, "src"), repo.revision)),
    /BENCHMARK_EXTERNAL_ROOT_MISMATCH/
  );
  await fs.rm(repo.root, { recursive: true, force: true });
});

test("external_workspace: rejects tracked runtime secrets and generated paths", async () => {
  for (const unsafePath of [".env", "node_modules/pkg/index.js", "dist/index.js", "credentials.json"]) {
    const repo = await createRepository();
    const fullPath = path.join(repo.root, unsafePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, "unsafe\n", "utf-8");
    git(repo.root, ["add", "-f", unsafePath.replace(/\\/g, "/")]);
    git(repo.root, ["commit", "-m", `track ${unsafePath}`]);
    const revision = git(repo.root, ["rev-parse", "HEAD"]);

    assert.throws(
      () => inspectExternalRepository(binding(repo.root, revision)),
      /BENCHMARK_EXTERNAL_TRACKED_PATH_UNSAFE/
    );
    await fs.rm(repo.root, { recursive: true, force: true });
  }
});

test("external_diff: fingerprints an exact allowed modification and deletion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-external-diff-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{"test":"vitest"}}\n');
  await fs.writeFile(path.join(root, "src", "obsolete.ts"), "export {};\n");
  const before = await captureWorkspaceSnapshot(root);

  await fs.writeFile(path.join(root, "package.json"), '{"scripts":{"test":"vitest run"}}\n');
  await fs.rm(path.join(root, "src", "obsolete.ts"));
  const after = await captureWorkspaceSnapshot(root);
  const evidence = compareWorkspaceSnapshots(before, after, ["package.json", "src/obsolete.ts"]);

  assert.deepEqual(evidence.modifiedFiles, ["package.json", "src/obsolete.ts"]);
  assert.match(evidence.patchSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(evidence.secretFindings, []);
  await fs.rm(root, { recursive: true, force: true });
});

test("external_diff: rejects outside-scope and credential-like mutations without leaking values", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-external-diff-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  await fs.writeFile(path.join(root, "README.md"), "safe\n");
  const before = await captureWorkspaceSnapshot(root);

  await fs.writeFile(path.join(root, "README.md"), "changed\n");
  const outside = await captureWorkspaceSnapshot(root);
  assert.throws(
    () => compareWorkspaceSnapshots(before, outside, ["package.json"]),
    /BENCHMARK_EXTERNAL_DIFF_SCOPE/
  );

  await fs.writeFile(
    path.join(root, "package.json"),
    '{"api_key":"this-value-must-never-appear-in-errors"}\n'
  );
  await fs.writeFile(path.join(root, "README.md"), "safe\n");
  const secretAfter = await captureWorkspaceSnapshot(root);
  assert.throws(
    () => compareWorkspaceSnapshots(before, secretAfter, ["package.json"]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /BENCHMARK_EXTERNAL_SECRET_DETECTED/);
      assert.doesNotMatch(error.message, /this-value-must-never-appear-in-errors/);
      return true;
    }
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("external_diff: ignores generated dependency and build output", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-external-diff-"));
  await fs.writeFile(path.join(root, "package.json"), "{}\n");
  const before = await captureWorkspaceSnapshot(root);
  await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "generated");
  await fs.writeFile(path.join(root, "dist", "index.js"), "generated");
  const after = await captureWorkspaceSnapshot(root);
  const evidence = compareWorkspaceSnapshots(before, after, ["package.json"]);
  assert.deepEqual(evidence.modifiedFiles, []);
  await fs.rm(root, { recursive: true, force: true });
});

test("external_diff: treats allowed file paths as exact files, not directory prefixes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-external-diff-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "test.ts"), "export {};\n");
  const before = await captureWorkspaceSnapshot(root);
  await fs.rm(path.join(root, "src", "test.ts"));
  await fs.mkdir(path.join(root, "src", "test.ts"));
  await fs.writeFile(path.join(root, "src", "test.ts", "payload.txt"), "outside exact file\n");
  const after = await captureWorkspaceSnapshot(root);

  assert.throws(
    () => compareWorkspaceSnapshots(before, after, ["src/test.ts"]),
    /BENCHMARK_EXTERNAL_DIFF_SCOPE/
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("external_diff: allows only descendants of declared safe prefixes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-external-prefix-"));
  await fs.mkdir(path.join(root, "backend", "tests"), { recursive: true });
  await fs.writeFile(path.join(root, "backend", "tests", "existing.py"), "pass\n");
  await fs.writeFile(path.join(root, "backend", "tests-secret.py"), "pass\n");
  const before = await captureWorkspaceSnapshot(root);

  await fs.writeFile(path.join(root, "backend", "tests", "new_test.py"), "def test_ok(): assert True\n");
  const allowed = await captureWorkspaceSnapshot(root);
  assert.deepEqual(
    compareWorkspaceSnapshots(before, allowed, [], ["backend/tests"]).modifiedFiles,
    ["backend/tests/new_test.py"]
  );

  await fs.writeFile(path.join(root, "backend", "tests-secret.py"), "changed\n");
  const outside = await captureWorkspaceSnapshot(root);
  assert.throws(
    () => compareWorkspaceSnapshots(before, outside, [], ["backend/tests"]),
    /BENCHMARK_EXTERNAL_DIFF_SCOPE/
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("external_workspace: ignores generated Python paths but rejects them when tracked", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-python-generated-"));
  await fs.writeFile(path.join(root, "app.py"), "VALUE = 1\n");
  const before = await captureWorkspaceSnapshot(root);
  for (const generatedDir of [".venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache"]) {
    const generated = path.join(root, generatedDir);
    await fs.mkdir(generated, { recursive: true });
    await fs.writeFile(path.join(generated, "generated.bin"), "generated");
  }
  const after = await captureWorkspaceSnapshot(root);
  assert.deepEqual(compareWorkspaceSnapshots(before, after, ["app.py"]).modifiedFiles, []);
  await fs.rm(root, { recursive: true, force: true });

  for (const unsafePath of [".venv/pyvenv.cfg", "app/__pycache__/module.pyc", ".pytest_cache/state"]) {
    const repo = await createRepository();
    const fullPath = path.join(repo.root, ...unsafePath.split("/"));
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, "generated\n");
    git(repo.root, ["add", "-f", unsafePath]);
    git(repo.root, ["commit", "-m", `track ${unsafePath}`]);
    const trackedRevision = git(repo.root, ["rev-parse", "HEAD"]);
    assert.throws(
      () => inspectExternalRepository(binding(repo.root, trackedRevision)),
      /BENCHMARK_EXTERNAL_TRACKED_PATH_UNSAFE/
    );
    await fs.rm(repo.root, { recursive: true, force: true });
  }
});
