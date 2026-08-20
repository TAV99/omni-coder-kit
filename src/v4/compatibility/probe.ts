import type { ProcessRunner } from "../process/types";
import type { HostSpec } from "./manifest";

export type CompatibilityStatus =
  | "first-class"
  | "experimental"
  | "incompatible"
  | "unavailable";

export interface HostCompatibilityResult {
  readonly hostId: "codex" | "claude" | "antigravity";
  readonly status: CompatibilityStatus;
  readonly installedVersion?: string | undefined;
  readonly verifiedVersion?: string | undefined;
  readonly missingFlags: readonly string[];
  readonly contractVerified: boolean;
  readonly liveSmokeVerified: boolean;
  readonly platformVerified: boolean;
  readonly diagnostics: readonly string[];
}

export function extractSemver(text: string): string | undefined {
  const match = text.match(/(?:^|[^\d])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match ? match[1] : undefined;
}

export async function probeHost(
  hostId: "codex" | "claude" | "antigravity",
  spec: HostSpec,
  runner: ProcessRunner,
  cwd: string,
  signal?: AbortSignal
): Promise<HostCompatibilityResult> {
  const diagnostics: string[] = [];

  // 1. Version Probe
  const versionRes = await runner.run({
    command: spec.binary,
    args: [...spec.versionArgs],
    cwd,
    timeoutMs: 5000,
    signal,
  });

  if (versionRes.termination === "spawn-error") {
    diagnostics.push(`Binary '${spec.binary}' not found or could not spawn: ${versionRes.error.message}`);
    return {
      hostId,
      status: "unavailable",
      verifiedVersion: spec.verifiedVersion,
      missingFlags: [...spec.requiredFlags],
      contractVerified: spec.contractVerified,
      liveSmokeVerified: spec.liveSmokeVerified,
      platformVerified: false,
      diagnostics,
    };
  }

  if (versionRes.termination !== "exited" || versionRes.exitCode !== 0) {
    diagnostics.push(
      `Version probe failed with termination '${versionRes.termination}' and exit code ${versionRes.exitCode}`
    );
    return {
      hostId,
      status: "incompatible",
      verifiedVersion: spec.verifiedVersion,
      missingFlags: [...spec.requiredFlags],
      contractVerified: spec.contractVerified,
      liveSmokeVerified: spec.liveSmokeVerified,
      platformVerified: false,
      diagnostics,
    };
  }

  const combinedVersionOutput = `${versionRes.stdout}\n${versionRes.stderr}`;
  const installedVersion = extractSemver(combinedVersionOutput);

  if (!installedVersion) {
    diagnostics.push(`Could not parse version from output: ${combinedVersionOutput.trim()}`);
    return {
      hostId,
      status: "incompatible",
      verifiedVersion: spec.verifiedVersion,
      missingFlags: [...spec.requiredFlags],
      contractVerified: spec.contractVerified,
      liveSmokeVerified: spec.liveSmokeVerified,
      platformVerified: false,
      diagnostics,
    };
  }

  // 2. Help/Flags Probe
  const helpRes = await runner.run({
    command: spec.binary,
    args: [...spec.helpArgs],
    cwd,
    timeoutMs: 5000,
    signal,
  });

  if (helpRes.termination === "spawn-error") {
    diagnostics.push(`Help probe failed to spawn binary '${spec.binary}': ${helpRes.error.message}`);
    return {
      hostId,
      status: "unavailable",
      installedVersion,
      verifiedVersion: spec.verifiedVersion,
      missingFlags: [...spec.requiredFlags],
      contractVerified: spec.contractVerified,
      liveSmokeVerified: spec.liveSmokeVerified,
      platformVerified: false,
      diagnostics,
    };
  }

  if (helpRes.termination !== "exited" || helpRes.exitCode !== 0) {
    diagnostics.push(
      `Help probe failed with termination '${helpRes.termination}' and exit code ${helpRes.exitCode}`
    );
    return {
      hostId,
      status: "incompatible",
      installedVersion,
      verifiedVersion: spec.verifiedVersion,
      missingFlags: [...spec.requiredFlags],
      contractVerified: spec.contractVerified,
      liveSmokeVerified: spec.liveSmokeVerified,
      platformVerified: false,
      diagnostics,
    };
  }

  const combinedHelpOutput = `${helpRes.stdout}\n${helpRes.stderr}`;
  const missingFlags: string[] = [];

  for (const flag of spec.requiredFlags) {
    if (!combinedHelpOutput.includes(flag)) {
      missingFlags.push(flag);
    }
  }

  if (missingFlags.length > 0) {
    diagnostics.push(`Missing required flags: ${missingFlags.join(", ")}`);
    return {
      hostId,
      status: "incompatible",
      installedVersion,
      verifiedVersion: spec.verifiedVersion,
      missingFlags,
      contractVerified: spec.contractVerified,
      liveSmokeVerified: spec.liveSmokeVerified,
      platformVerified: false,
      diagnostics,
    };
  }

  // 3. Platform & Evidence Checks
  const currentPlatformKey = `${process.platform}-${process.arch}`;
  const platformVerified = spec.verifiedPlatforms.includes(currentPlatformKey);

  const isExactVersion = installedVersion === spec.verifiedVersion;
  const isFirstClass =
    isExactVersion &&
    spec.contractVerified &&
    spec.liveSmokeVerified &&
    platformVerified;

  if (isFirstClass) {
    return {
      hostId,
      status: "first-class",
      installedVersion,
      verifiedVersion: spec.verifiedVersion,
      missingFlags: [],
      contractVerified: true,
      liveSmokeVerified: true,
      platformVerified: true,
      diagnostics: [],
    };
  }

  if (!isExactVersion) {
    diagnostics.push(
      `Installed version (${installedVersion}) differs from verified version (${spec.verifiedVersion})`
    );
  }
  if (!spec.contractVerified) {
    diagnostics.push("Contract test evidence not recorded for this host");
  }
  if (!spec.liveSmokeVerified) {
    diagnostics.push("Live smoke run evidence not recorded for this host");
  }
  if (!platformVerified) {
    diagnostics.push(`Platform '${currentPlatformKey}' not in verifiedPlatforms`);
  }

  return {
    hostId,
    status: "experimental",
    installedVersion,
    verifiedVersion: spec.verifiedVersion,
    missingFlags: [],
    contractVerified: spec.contractVerified,
    liveSmokeVerified: spec.liveSmokeVerified,
    platformVerified,
    diagnostics,
  };
}
