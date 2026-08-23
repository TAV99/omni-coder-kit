import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  asQualityEvidenceId,
  truncateUtf8Bytes,
  validateQualityEvidence,
  type GateDefinition,
  type GateResult,
  type QualityCycleId,
  type QualityEvidence,
  type QualityEvidenceId,
} from "../contracts/quality";
import type { RunId } from "../contracts/ids";
import type { ProcessRunner } from "../process/types";

export interface GateRunnerContext {
  readonly runId: RunId;
  readonly cycleId: QualityCycleId;
  readonly operationId: string;
  readonly projectRoot: string;
  readonly runner: ProcessRunner;
  readonly signal?: AbortSignal | undefined;
  readonly now?: (() => string) | undefined;
  readonly newEvidenceId?: (() => QualityEvidenceId) | undefined;
  readonly outputSummaryBytes?: number | undefined;
}

export class GateRunner {
  async run(
    definition: GateDefinition,
    context: GateRunnerContext
  ): Promise<{ result: GateResult; evidence?: QualityEvidence }> {
    const startedAt = context.now ? context.now() : new Date().toISOString();
    const evidenceId = context.newEvidenceId
      ? context.newEvidenceId()
      : asQualityEvidenceId(crypto.randomUUID());

    const maxSummaryBytes = context.outputSummaryBytes ?? 16384;
    const resolvedProjectRoot = path.resolve(context.projectRoot);
    const resolvedCwd = path.resolve(resolvedProjectRoot, definition.cwd);

    let cwdContained = false;

    try {
      if (fs.existsSync(resolvedProjectRoot) && fs.existsSync(resolvedCwd)) {
        const realRoot = fs.realpathSync(resolvedProjectRoot);
        const realCwd = fs.realpathSync(resolvedCwd);
        if (realCwd === realRoot || realCwd.startsWith(realRoot + path.sep)) {
          cwdContained = true;
        }
      }
    } catch {
      cwdContained = false;
    }

    if (!cwdContained) {
      const reason = `Working directory '${definition.cwd}' cannot be resolved within existing project root '${context.projectRoot}'`;
      const result: GateResult = {
        schemaVersion: 1,
        cycleId: context.cycleId,
        gateId: definition.id,
        operationId: context.operationId,
        status: "inconclusive",
        startedAt,
        durationMs: 0,
        mandatory: definition.mandatory,
        failureSignature: "spawn-error",
        reason,
      };

      return { result };
    }

    const processResult = await context.runner.run({
      command: definition.command,
      args: [...definition.args],
      cwd: resolvedCwd,
      timeoutMs: definition.timeoutMs,
      signal: context.signal,
    });

    const rawStdout = processResult.stdout;
    const rawStderr = processResult.stderr;

    const stdoutSha256 = crypto.createHash("sha256").update(rawStdout).digest("hex");
    const stderrSha256 = crypto.createHash("sha256").update(rawStderr).digest("hex");

    const stdoutSummary = truncateUtf8Bytes(rawStdout, maxSummaryBytes);
    const stderrSummary = truncateUtf8Bytes(rawStderr, maxSummaryBytes);

    const evidence: QualityEvidence = {
      schemaVersion: 1,
      evidenceId,
      runId: context.runId,
      cycleId: context.cycleId,
      gateId: definition.id,
      operationId: context.operationId,
      command: [definition.command, ...definition.args],
      cwd: resolvedCwd,
      timeoutMs: definition.timeoutMs,
      termination: processResult.termination,
      exitCode: processResult.exitCode,
      startedAt,
      durationMs: processResult.durationMs,
      stdoutSummary,
      stderrSummary,
      stdoutSha256,
      stderrSha256,
      artifactIds: [],
    };

    const evidenceValidation = validateQualityEvidence(evidence);
    if (!evidenceValidation.valid) {
      const result: GateResult = {
        schemaVersion: 1,
        cycleId: context.cycleId,
        gateId: definition.id,
        operationId: context.operationId,
        status: "inconclusive",
        startedAt,
        durationMs: processResult.durationMs,
        mandatory: definition.mandatory,
        failureSignature: "GATE_EVIDENCE_INVALID",
        reason: evidenceValidation.error ?? "Evidence validation failed",
      };
      return { result };
    }

    let result: GateResult;

    if (processResult.termination === "exited" && processResult.exitCode === 0) {
      result = {
        schemaVersion: 1,
        cycleId: context.cycleId,
        gateId: definition.id,
        operationId: context.operationId,
        status: "passed",
        startedAt,
        durationMs: processResult.durationMs,
        evidenceId,
        mandatory: definition.mandatory,
      };
    } else if (processResult.termination === "exited" && processResult.exitCode !== 0) {
      result = {
        schemaVersion: 1,
        cycleId: context.cycleId,
        gateId: definition.id,
        operationId: context.operationId,
        status: "failed",
        startedAt,
        durationMs: processResult.durationMs,
        evidenceId,
        mandatory: definition.mandatory,
        failureSignature: `exit_${processResult.exitCode}`,
        reason: stderrSummary.trim() || `Process exited with code ${processResult.exitCode}`,
      };
    } else {
      // timed-out, aborted, output-limit, spawn-error, signalled
      const sig =
        processResult.termination === "spawn-error"
          ? "spawn-error"
          : processResult.termination;

      const reason =
        processResult.termination === "spawn-error"
          ? `Spawn error: ${processResult.error.message}`
          : `Process terminated with ${processResult.termination}`;

      result = {
        schemaVersion: 1,
        cycleId: context.cycleId,
        gateId: definition.id,
        operationId: context.operationId,
        status: "inconclusive",
        startedAt,
        durationMs: processResult.durationMs,
        evidenceId,
        mandatory: definition.mandatory,
        failureSignature: sig,
        reason,
      };
    }

    return { result, evidence };
  }
}
