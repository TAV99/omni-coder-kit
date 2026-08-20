import type { AgentAdapter } from "../contracts/adapter";
import type { ProcessRunner } from "../process/types";
import { loadCompatibilityManifest } from "../compatibility/manifest";
import { probeHost, type HostCompatibilityResult } from "../compatibility/probe";
import { CodexAdapter } from "./codex/adapter";
import { ClaudeCodeAdapter } from "./claude/adapter";
import type { ClaudeToolPolicy } from "./claude/command";
import { AntigravityAdapter } from "./antigravity/adapter";

export type HostId = "codex" | "claude" | "antigravity";

export interface AdapterRegistryOptions {
  readonly runner: ProcessRunner;
  readonly projectDir: string;
  readonly compatibilityManifestPath: string;
  readonly allowExperimental: boolean;
}

export type AdapterHostOptions =
  | { readonly hostId: "codex"; readonly tempDir: string }
  | { readonly hostId: "claude"; readonly toolPolicy?: ClaudeToolPolicy | undefined }
  | {
      readonly hostId: "antigravity";
      readonly model?: string | undefined;
      readonly printTimeoutMs?: number | undefined;
    };

export class UnsupportedAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedAdapterError";
  }
}

export class AdapterNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterNotReadyError";
  }
}

const KNOWN_HOST_IDS: readonly HostId[] = ["codex", "claude", "antigravity"];

export async function listAdapterStatuses(
  options: Omit<AdapterRegistryOptions, "allowExperimental">
): Promise<readonly HostCompatibilityResult[]> {
  const manifest = await loadCompatibilityManifest(
    options.compatibilityManifestPath
  );
  const results: HostCompatibilityResult[] = [];

  for (const hostId of KNOWN_HOST_IDS) {
    const spec = manifest.hosts[hostId];
    const probeRes = await probeHost(
      hostId,
      spec,
      options.runner,
      options.projectDir
    );
    results.push(probeRes);
  }

  return results;
}

export async function createAdapter(
  options: AdapterRegistryOptions,
  host: AdapterHostOptions
): Promise<AgentAdapter> {
  if (!KNOWN_HOST_IDS.includes(host.hostId)) {
    throw new UnsupportedAdapterError(`Unsupported host adapter ID: '${(host as any).hostId}'`);
  }

  const manifest = await loadCompatibilityManifest(
    options.compatibilityManifestPath
  );
  const spec = manifest.hosts[host.hostId];
  const probeRes = await probeHost(
    host.hostId,
    spec,
    options.runner,
    options.projectDir
  );

  if (probeRes.status === "unavailable") {
    throw new AdapterNotReadyError(
      `Adapter '${host.hostId}' is unavailable (binary not found or failed to spawn)`
    );
  }

  if (probeRes.status === "incompatible") {
    throw new AdapterNotReadyError(
      `Adapter '${host.hostId}' is incompatible: ${probeRes.diagnostics.join("; ")}`
    );
  }

  if (probeRes.status === "experimental" && !options.allowExperimental) {
    throw new AdapterNotReadyError(
      `Adapter '${host.hostId}' is experimental and allowExperimental is false: ${probeRes.diagnostics.join("; ")}`
    );
  }

  switch (host.hostId) {
    case "codex":
      return new CodexAdapter({
        runner: options.runner,
        projectDir: options.projectDir,
        compatibilityManifestPath: options.compatibilityManifestPath,
        tempDir: host.tempDir,
      });
    case "claude":
      return new ClaudeCodeAdapter({
        runner: options.runner,
        projectDir: options.projectDir,
        compatibilityManifestPath: options.compatibilityManifestPath,
        toolPolicy: host.toolPolicy,
      });
    case "antigravity":
      return new AntigravityAdapter({
        runner: options.runner,
        projectDir: options.projectDir,
        compatibilityManifestPath: options.compatibilityManifestPath,
        model: host.model,
        printTimeoutMs: host.printTimeoutMs,
      });
  }
}
