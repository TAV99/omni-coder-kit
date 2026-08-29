import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  createAdapter,
  listAdapterStatuses,
  AdapterNotReadyError,
} from "../../src/v4/adapters/registry";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../../src/v4/process/types";

const manifestPath = path.resolve(__dirname, "../../compatibility/v4/hosts.json");

test("adapter-registry: listAdapterStatuses returns status for all hosts", async () => {
  const runner: ProcessRunner = {
    async run(): Promise<ProcessResult> {
      return {
        stdout: "codex 0.147.0 claude 2.1.185 agy 1.1.13",
        stderr: "",
        durationMs: 1,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };

  const statuses = await listAdapterStatuses({
    runner,
    projectDir: process.cwd(),
    compatibilityManifestPath: manifestPath,
  });

  assert.equal(statuses.length, 3);
  const ids = statuses.map((s) => s.hostId);
  assert.ok(ids.includes("codex"));
  assert.ok(ids.includes("claude"));
  assert.ok(ids.includes("antigravity"));
});

test("adapter-registry: rejects experimental adapter when allowExperimental is false", async () => {
  const runner: ProcessRunner = {
    async run(req: ProcessRequest): Promise<ProcessResult> {
      return {
        stdout:
          "codex 0.147.0 exec --json --strict-config --ignore-user-config --output-schema --output-last-message --skip-git-repo-check --sandbox --approve-for-me --cd",
        stderr: "",
        durationMs: 1,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };

  await assert.rejects(
    async () =>
      createAdapter(
        {
          runner,
          projectDir: process.cwd(),
          compatibilityManifestPath: manifestPath,
          allowExperimental: false,
        },
        { hostId: "codex", tempDir: "/tmp" }
      ),
    AdapterNotReadyError
  );
});

test("adapter-registry: constructs adapter when experimental is allowed", async () => {
  const runner: ProcessRunner = {
    async run(req: ProcessRequest): Promise<ProcessResult> {
      return {
        stdout:
          "codex 0.147.0 exec --json --strict-config --ignore-user-config --output-schema --output-last-message --skip-git-repo-check --sandbox --approve-for-me --cd",
        stderr: "",
        durationMs: 1,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    },
  };

  const adapter = await createAdapter(
    {
      runner,
      projectDir: process.cwd(),
      compatibilityManifestPath: manifestPath,
      allowExperimental: true,
    },
    { hostId: "codex", tempDir: "/tmp" }
  );

  assert.equal(adapter.id, "codex");
});
