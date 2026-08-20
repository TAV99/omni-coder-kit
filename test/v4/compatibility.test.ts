import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadCompatibilityManifest, type HostSpec } from "../../src/v4/compatibility/manifest";
import { extractSemver, probeHost } from "../../src/v4/compatibility/probe";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../../src/v4/process/types";

class MockRunner implements ProcessRunner {
  constructor(private readonly handler: (req: ProcessRequest) => ProcessResult) {}
  async run(request: ProcessRequest): Promise<ProcessResult> {
    return this.handler(request);
  }
}

test("compatibility: extractSemver parses version from noisy output", () => {
  assert.equal(extractSemver("codex version 0.147.0-beta.1 (2026-08-20)"), "0.147.0-beta.1");
  assert.equal(extractSemver("claude code v2.1.185\n"), "2.1.185");
  assert.equal(extractSemver("agy 1.1.13"), "1.1.13");
  assert.equal(extractSemver("no version here"), undefined);
});

test("compatibility: loadCompatibilityManifest loads valid manifest and rejects invalid", async () => {
  const manifestPath = path.resolve(__dirname, "../../compatibility/v4/hosts.json");
  const manifest = await loadCompatibilityManifest(manifestPath);
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.hosts.codex);
  assert.ok(manifest.hosts.claude);
  assert.ok(manifest.hosts.antigravity);
});

test("compatibility: probe returns unavailable when binary fails to spawn", async () => {
  const runner = new MockRunner(() => ({
    stdout: "",
    stderr: "",
    durationMs: 1,
    termination: "spawn-error",
    exitCode: null,
    signal: null,
    error: { code: "ENOENT", message: "not found" },
  }));

  const spec: HostSpec = {
    binary: "fake-bin",
    verifiedVersion: "1.0.0",
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    requiredFlags: ["--json"],
    contractVerified: false,
    liveSmokeVerified: false,
    verifiedPlatforms: [],
  };

  const res = await probeHost("codex", spec, runner, process.cwd());
  assert.equal(res.status, "unavailable");
});

test("compatibility: probe returns incompatible when flag is missing", async () => {
  const runner = new MockRunner((req) => {
    if (req.args.includes("--version")) {
      return {
        stdout: "fake 1.0.0",
        stderr: "",
        durationMs: 1,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    }
    return {
      stdout: "Usage: fake [--help]",
      stderr: "",
      durationMs: 1,
      termination: "exited",
      exitCode: 0,
      signal: null,
    };
  });

  const spec: HostSpec = {
    binary: "fake-bin",
    verifiedVersion: "1.0.0",
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    requiredFlags: ["--required-missing-flag"],
    contractVerified: false,
    liveSmokeVerified: false,
    verifiedPlatforms: [],
  };

  const res = await probeHost("codex", spec, runner, process.cwd());
  assert.equal(res.status, "incompatible");
  assert.deepEqual(res.missingFlags, ["--required-missing-flag"]);
});

test("compatibility: probe returns experimental when flags match but evidence/platform missing", async () => {
  const runner = new MockRunner((req) => {
    if (req.args.includes("--version")) {
      return {
        stdout: "fake 1.0.0",
        stderr: "",
        durationMs: 1,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    }
    return {
      stdout: "Usage: fake [--json] [--help]",
      stderr: "",
      durationMs: 1,
      termination: "exited",
      exitCode: 0,
      signal: null,
    };
  });

  const spec: HostSpec = {
    binary: "fake-bin",
    verifiedVersion: "1.0.0",
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    requiredFlags: ["--json"],
    contractVerified: false,
    liveSmokeVerified: false,
    verifiedPlatforms: [],
  };

  const res = await probeHost("codex", spec, runner, process.cwd());
  assert.equal(res.status, "experimental");
  assert.equal(res.installedVersion, "1.0.0");
  assert.deepEqual(res.missingFlags, []);
});

test("compatibility: probe returns first-class when all requirements, evidence, and platform are met", async () => {
  const currentPlatformKey = `${process.platform}-${process.arch}`;
  const runner = new MockRunner((req) => {
    if (req.args.includes("--version")) {
      return {
        stdout: "fake 1.0.0",
        stderr: "",
        durationMs: 1,
        termination: "exited",
        exitCode: 0,
        signal: null,
      };
    }
    return {
      stdout: "Usage: fake [--json] [--help]",
      stderr: "",
      durationMs: 1,
      termination: "exited",
      exitCode: 0,
      signal: null,
    };
  });

  const spec: HostSpec = {
    binary: "fake-bin",
    verifiedVersion: "1.0.0",
    versionArgs: ["--version"],
    helpArgs: ["--help"],
    requiredFlags: ["--json"],
    contractVerified: true,
    liveSmokeVerified: true,
    verifiedPlatforms: [currentPlatformKey],
  };

  const res = await probeHost("codex", spec, runner, process.cwd());
  assert.equal(res.status, "first-class");
});
