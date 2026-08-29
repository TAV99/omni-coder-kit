import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const HostSchema = z.enum(["codex", "claude", "antigravity"]);

const SmokeInputSchema = z.object({
  host: HostSchema,
  cliVersion: z.string().min(1),
  platform: z.string().min(1),
  operationId: z.string().min(1),
  executionId: z.string().min(1),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  structuredStatus: z.enum(["succeeded", "failed", "cancelled"]),
  mutationVerified: z.boolean(),
  contractVerified: z.boolean(),
  modelCallCount: z.number().int().nonnegative(),
}).strict();

export type SmokeEvidenceInput = z.infer<typeof SmokeInputSchema>;

export const SmokeEvidenceSchema = SmokeInputSchema.extend({
  schemaVersion: z.literal(1),
  evidenceId: z.string().regex(/^smoke-[0-9a-f]{16}$/),
  correlationVerified: z.boolean(),
  liveSmokeVerified: z.boolean(),
}).strict();

export type SmokeEvidence = z.infer<typeof SmokeEvidenceSchema>;

export interface PromotionRequest {
  readonly host: z.infer<typeof HostSchema>;
  readonly cliVersion: string;
  readonly platform: string;
  readonly now: string;
  readonly maxAgeMs: number;
}

export interface PromotionPlan {
  readonly eligible: boolean;
  readonly writesManifest: false;
  readonly reasons: readonly string[];
  readonly request: PromotionRequest;
}

export function createSmokeEvidence(raw: SmokeEvidenceInput): SmokeEvidence {
  const input = SmokeInputSchema.parse(raw);
  const correlationVerified = input.operationId === input.executionId;
  const liveSmokeVerified =
    correlationVerified &&
    input.structuredStatus === "succeeded" &&
    input.mutationVerified &&
    input.contractVerified &&
    input.modelCallCount === 1;
  const digest = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
  return SmokeEvidenceSchema.parse({
    ...input,
    schemaVersion: 1,
    evidenceId: `smoke-${digest}`,
    correlationVerified,
    liveSmokeVerified,
  });
}

export function renderSmokeEvidenceMarkdown(evidence: SmokeEvidence): string {
  const item = SmokeEvidenceSchema.parse(evidence);
  const label = item.host === "codex" ? "Codex" : item.host === "claude" ? "Claude" : "Antigravity";
  return [
    `# ${label} Compatibility Smoke Evidence`,
    "",
    `- Evidence: \`${item.evidenceId}\``,
    `- CLI: \`${item.cliVersion}\``,
    `- Platform: \`${item.platform}\``,
    `- Started: ${item.startedAt}`,
    `- Completed: ${item.completedAt}`,
    `- Operation: \`${item.operationId}\``,
    `- Correlation verified: ${item.correlationVerified}`,
    `- Mutation verified: ${item.mutationVerified}`,
    `- Contract verified: ${item.contractVerified}`,
    `- Live smoke verified: ${item.liveSmokeVerified}`,
    "",
  ].join("\n");
}

export async function writeSmokeEvidence(
  outputRoot: string,
  evidenceInput: SmokeEvidence
): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
  const evidence = SmokeEvidenceSchema.parse(evidenceInput);
  const date = evidence.completedAt.slice(0, 10);
  const directory = path.resolve(outputRoot, date, evidence.host, evidence.evidenceId);
  const resolvedRoot = path.resolve(outputRoot);
  const relative = path.relative(resolvedRoot, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("SMOKE_EVIDENCE_PATH_UNSAFE");
  }
  await fs.mkdir(directory, { recursive: true });
  const jsonPath = path.join(directory, "evidence.json");
  const markdownPath = path.join(directory, "evidence.md");
  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" }),
    fs.writeFile(markdownPath, renderSmokeEvidenceMarkdown(evidence), { flag: "wx" }),
  ]);
  return { jsonPath, markdownPath };
}

export function validatePromotionEvidence(
  evidenceInput: SmokeEvidence,
  request: PromotionRequest
): PromotionPlan {
  const evidence = SmokeEvidenceSchema.parse(evidenceInput);
  const reasons: string[] = [];
  const canonical = createSmokeEvidence({
    host: evidence.host,
    cliVersion: evidence.cliVersion,
    platform: evidence.platform,
    operationId: evidence.operationId,
    executionId: evidence.executionId,
    startedAt: evidence.startedAt,
    completedAt: evidence.completedAt,
    structuredStatus: evidence.structuredStatus,
    mutationVerified: evidence.mutationVerified,
    contractVerified: evidence.contractVerified,
    modelCallCount: evidence.modelCallCount,
  });
  if (
    evidence.evidenceId !== canonical.evidenceId ||
    evidence.correlationVerified !== canonical.correlationVerified ||
    evidence.liveSmokeVerified !== canonical.liveSmokeVerified
  ) {
    reasons.push("EVIDENCE_INTEGRITY_INVALID");
  }
  if (!canonical.liveSmokeVerified) reasons.push("SMOKE_NOT_VERIFIED");
  if (evidence.host !== request.host) reasons.push("HOST_MISMATCH");
  if (evidence.cliVersion !== request.cliVersion) reasons.push("CLI_VERSION_MISMATCH");
  if (evidence.platform !== request.platform) reasons.push("PLATFORM_MISMATCH");
  const now = Date.parse(request.now);
  const completed = Date.parse(evidence.completedAt);
  if (!Number.isFinite(now) || !Number.isFinite(completed) || now < completed) {
    reasons.push("EVIDENCE_TIME_INVALID");
  } else if (!Number.isSafeInteger(request.maxAgeMs) || request.maxAgeMs <= 0 || now - completed > request.maxAgeMs) {
    reasons.push("EVIDENCE_STALE");
  }
  return { eligible: reasons.length === 0, writesManifest: false, reasons, request };
}
