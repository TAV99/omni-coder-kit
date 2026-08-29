import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { BenchmarkRunReport } from "./runner";
import { renderBenchmarkAggregateMarkdown } from "./aggregate";

function normalizeStringPaths(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return text
    .replace(/\\/g, "/")
    .replace(/\/tmp\/[^\s'"]+/gi, "<tempdir>")
    .replace(/\/var\/folders\/[^\s'"]+/gi, "<tempdir>")
    .replace(/[A-Za-z]:\/Users\/[^\s'"]+\/AppData\/Local\/Temp\/[^\s'"]+/gi, "<tempdir>")
    .replace(/[A-Za-z]:\/[^\s'"]+/g, "<tempdir>");
}

export function normalizeBenchmarkReport(report: BenchmarkRunReport): BenchmarkRunReport {
  return {
    ...report,
    benchmarkRunId: "bm-normalized-run-id",
    semanticHash: "",
    startedAt: "2026-08-20T10:00:00.000Z",
    completedAt: "2026-08-20T10:00:05.000Z",
    durationMs: 5000,
    gitMetadata: {
      revision: report.gitMetadata ? report.gitMetadata.revision : null,
      isDirty: report.gitMetadata ? report.gitMetadata.isDirty : null,
    },
    cases: report.cases.map((c) => ({
      ...c,
      reason: normalizeStringPaths(c.reason),
      error: normalizeStringPaths(c.error),
      actual: {
        ...c.actual,
        ...(c.actual.source
          ? { source: { ...c.actual.source, repositoryRoot: "<external-root>" } }
          : {}),
        ...(c.actual.adapterNative
          ? {
              adapterNative: {
                ...c.actual.adapterNative,
                ...(c.actual.adapterNative.sessionId ? { sessionId: "<session>" } : {}),
                ...(c.actual.adapterNative.processEvidence
                  ? {
                      processEvidence: {
                        ...c.actual.adapterNative.processEvidence,
                        command: c.actual.adapterNative.processEvidence.command.map(
                          (part) => normalizeStringPaths(part) ?? part
                        ),
                        stdoutSummary: "<bounded-output>",
                        stderrSummary: "<bounded-output>",
                        stdoutSha256: "<output-sha256>",
                        stderrSha256: "<output-sha256>",
                      },
                    }
                  : {}),
              },
            }
          : {}),
        executedCommands: c.actual.executedCommands
          ? c.actual.executedCommands.map((cmd) => normalizeStringPaths(cmd) ?? cmd)
          : undefined,
        commandEvidence: c.actual.commandEvidence?.map((item) => ({
          ...item,
          cwd: normalizeStringPaths(item.cwd) ?? item.cwd,
          stdoutSummary: "<bounded-output>",
          stderrSummary: "<bounded-output>",
          stdoutSha256: "<output-sha256>",
          stderrSha256: "<output-sha256>",
          ...(item.evidenceId ? { evidenceId: "<evidence-id>" } : {}),
          artifactIds: item.artifactIds.map(() => "<artifact-id>"),
        })),
      },
      metrics: c.metrics
        ? {
            ...c.metrics,
            wallClockMs: 1000,
            summedGateDurationMs: 1000,
            gateQueueMs: 0,
            measuredSpeedup: c.metrics.measuredSpeedup !== undefined ? 1.0 : undefined,
          }
        : undefined,
    })),
  };
}

export function computeSemanticHash(report: BenchmarkRunReport): string {
  const normalized = normalizeBenchmarkReport(report);
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function generateBenchmarkJson(report: BenchmarkRunReport): string {
  return JSON.stringify(report, null, 2);
}

export function generateBenchmarkMarkdown(report: BenchmarkRunReport): string {
  const lines: string[] = [];

  lines.push(`# Omni v4 Benchmark Verification Report`);
  lines.push(``);
  lines.push(`**Run ID:** \`${report.benchmarkRunId}\`  `);
  lines.push(`**Started At:** ${report.startedAt}  `);
  lines.push(`**Completed At:** ${report.completedAt}  `);
  lines.push(`**Duration:** ${report.durationMs}ms  `);
  lines.push(`**Manifest Hash:** \`${report.manifestHash}\`  `);
  lines.push(`**Semantic Hash:** \`${report.semanticHash}\`  `);
  lines.push(`**Live Approved:** ${report.liveApproved ? "YES" : "NO"}  `);
  lines.push(`**Model Call Count:** ${report.modelCallCount}  `);
  lines.push(``);

  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`| :--- | :--- |`);
  lines.push(`| Total Cases | ${report.totalCases} |`);
  lines.push(`| Passed Cases | ${report.passedCases} |`);
  lines.push(`| Failed Cases | ${report.failedCases} |`);
  lines.push(`| Skipped Cases | ${report.skippedCases} |`);
  lines.push(`| False Successes | ${report.falseSuccessCount} |`);
  lines.push(`| False Failures | ${report.falseFailureCount} |`);
  lines.push(
    `| Unclassified False Failures | ${report.cases.filter((item) => item.actual.falseFailureClassified === false).length} |`
  );
  lines.push(``);
  lines.push(renderBenchmarkAggregateMarkdown(report.reliability));
  lines.push(``);

  lines.push(`## Case Breakdown`);
  lines.push(``);
  lines.push(
    `| Case ID | Status | Final Phase | Acceptance | Passed Gates | Repairs | Recovery | Budget Breached | Reason / Error |`
  );
  lines.push(
    `| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`
  );

  for (const c of report.cases) {
    const reasonOrError = c.error ? `Error: ${c.error}` : (c.reason ?? "-");
    const recovery = c.actual.recoveryOutcome ?? "-";
    const budget = c.actual.budgetBreached !== undefined ? (c.actual.budgetBreached ? "YES" : "NO") : "-";
    lines.push(
      `| \`${c.id}\` | **${c.status.toUpperCase()}** | \`${c.actual.finalPhase}\` | \`${c.actual.acceptanceStatus}\` | ${c.actual.passedGateCount} | ${c.actual.repairCount} | ${recovery} | ${budget} | ${reasonOrError} |`
    );
  }

  lines.push(``);
  lines.push(`## Efficiency & Concurrency Summary`);
  lines.push(``);
  lines.push(`| Case ID | Peak Parallelism | Speedup | Wall-clock ms | Gate Duration ms | Queue ms |`);
  lines.push(`| :--- | :--- | :--- | :--- | :--- | :--- |`);

  for (const c of report.cases) {
    if (c.metrics) {
      lines.push(
        `| \`${c.id}\` | ${c.metrics.peakParallelism} | ${c.metrics.measuredSpeedup ?? "-"} | ${c.metrics.wallClockMs}ms | ${c.metrics.summedGateDurationMs}ms | ${c.metrics.gateQueueMs}ms |`
      );
    }
  }

  lines.push(``);
  lines.push(`## Audit & Environment`);
  lines.push(``);
  lines.push(`| Key | Value |`);
  lines.push(`| :--- | :--- |`);
  lines.push(`| Schema Version | ${report.schemaVersion} |`);
  lines.push(`| Platform | ${report.environment.platform} |`);
  lines.push(`| Node Version | ${report.environment.nodeVersion} |`);
  lines.push(`| Live Approved | ${report.environment.liveApproved ? "YES" : "NO"} |`);
  lines.push(`| Config Hash | \`${report.configHash}\` |`);
  lines.push(`| Semantic Hash | \`${report.semanticHash}\` |`);
  lines.push(
    `| External Binding Hash | ${report.externalBindingHash ? `\`${report.externalBindingHash}\`` : "-"} |`
  );

  const gitRev = report.gitMetadata?.revision ? `\`${report.gitMetadata.revision}\`` : "unavailable";
  const gitDirty =
    report.gitMetadata?.isDirty === null || report.gitMetadata?.isDirty === undefined
      ? "unavailable"
      : report.gitMetadata.isDirty
      ? "DIRTY"
      : "CLEAN";

  let sourceRepro = "NOT CLAIMABLE (Git metadata unavailable)";
  if (
    report.gitMetadata?.revision &&
    report.gitMetadata?.isDirty !== null &&
    report.gitMetadata?.isDirty !== undefined
  ) {
    if (report.gitMetadata.isDirty) {
      sourceRepro = "NOT CLAIMABLE (dirty worktree)";
    } else {
      sourceRepro = "ELIGIBLE (clean Git revision)";
    }
  }

  lines.push(`| Git Revision | ${gitRev} |`);
  lines.push(`| Git Dirty | ${gitDirty} |`);
  lines.push(`| Source Reproducibility | ${sourceRepro} |`);
  lines.push(``);

  const externalCases = report.cases.filter((item) => item.actual.source);
  if (externalCases.length > 0) {
    lines.push(`## External Evidence`);
    lines.push(``);
    lines.push(
      `| Case ID | Source Revision | Tracked Files | Tree SHA-256 | Modified Files | Diff Fingerprint | Adapter |`
    );
    lines.push(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);
    for (const item of externalCases) {
      const source = item.actual.source!;
      const modified = item.actual.modifiedFiles?.join(", ") || "-";
      const adapter = item.actual.adapterNative
        ? [item.actual.adapterNative.cliVersion, item.actual.adapterNative.model]
            .filter(Boolean)
            .join(" / ") || "recorded"
        : "-";
      lines.push(
        `| \`${item.id}\` | \`${source.revision}\` | ${source.trackedFileCount} | \`${source.treeSha256}\` | ${modified} | ${item.actual.diffFingerprint ? `\`${item.actual.diffFingerprint}\`` : "-"} | ${adapter} |`
      );
    }
    lines.push(``);

    const adapterProcessCases = externalCases.filter(
      (item) => item.actual.adapterNative?.processEvidence
    );
    if (adapterProcessCases.length > 0) {
      lines.push(`## External Adapter Process Evidence`);
      lines.push(``);
      lines.push(`| Case ID | Command | Timeout | Termination | Exit | Stdout SHA-256 | Stderr SHA-256 |`);
      lines.push(`| :--- | :--- | ---: | :--- | ---: | :--- | :--- |`);
      for (const item of adapterProcessCases) {
        const processEvidence = item.actual.adapterNative!.processEvidence!;
        const normalizedCommand = processEvidence.command
          .map((part) => normalizeStringPaths(part) ?? part)
          .join(" ");
        lines.push(
          `| \`${item.id}\` | \`${normalizedCommand}\` | ${processEvidence.timeoutMs}ms | ${processEvidence.termination} | ${processEvidence.exitCode ?? "-"} | \`${processEvidence.stdoutSha256}\` | \`${processEvidence.stderrSha256}\` |`
        );
      }
      lines.push(``);
    }

    lines.push(`## External Command Evidence`);
    lines.push(``);
    lines.push(
      `| Case ID | Phase | Command | CWD | Timeout | Termination | Exit | Evidence ID | Artifacts |`
    );
    lines.push(`| :--- | :--- | :--- | :--- | ---: | :--- | ---: | :--- | :--- |`);
    for (const item of externalCases) {
      for (const evidence of item.actual.commandEvidence ?? []) {
        lines.push(
          `| \`${item.id}\` | ${evidence.phase} | \`${evidence.command.join(" ")}\` | \`${evidence.cwd}\` | ${evidence.timeoutMs}ms | ${evidence.termination} | ${evidence.exitCode ?? "-"} | ${evidence.evidenceId ? `\`${evidence.evidenceId}\`` : "-"} | ${evidence.artifactIds.length ? evidence.artifactIds.join(", ") : "-"} |`
        );
      }
    }
    lines.push(``);
  }

  return lines.join("\n");
}

export async function writeBenchmarkArtifacts(
  report: BenchmarkRunReport,
  outputDir: string
): Promise<{ jsonPath: string; mdPath: string }> {
  await fs.mkdir(outputDir, { recursive: true });

  const jsonPath = path.join(outputDir, "report.json");
  const mdPath = path.join(outputDir, "summary.md");

  const jsonContent = generateBenchmarkJson(report);

  const tmpJson = `${jsonPath}.tmp-${Date.now()}`;
  await fs.writeFile(tmpJson, jsonContent, "utf-8");
  await fs.rename(tmpJson, jsonPath);

  // Re-read persisted JSON to guarantee Markdown is strictly derived from persisted JSON
  const persistedJsonRaw = await fs.readFile(jsonPath, "utf-8");
  const persistedReport: BenchmarkRunReport = JSON.parse(persistedJsonRaw);
  const mdContent = generateBenchmarkMarkdown(persistedReport);

  const tmpMd = `${mdPath}.tmp-${Date.now()}`;
  await fs.writeFile(tmpMd, mdContent, "utf-8");
  await fs.rename(tmpMd, mdPath);

  return { jsonPath, mdPath };
}
