import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import {
  GateResultSchema,
  QualityCycleIdSchema,
  QualityDecisionSchema,
  QualityEvidenceSchema,
  RequirementVerdictSchema,
  RequirementIdSchema,
  RouteIntentSchema,
  RepairHistoryEntrySchema,
  indexAndValidateEvidenceCollection,
  correlateEvidence,
  type GateResult,
  type QualityCycleId,
  type QualityDecision,
  type QualityEvidence,
  type RequirementVerdict,
  type RouteIntent,
  type RepairHistoryEntry,
} from "../contracts/quality";
import { asRunId, type RunId } from "../contracts/ids";
import { RunPhaseSchema, type RunPhase } from "../contracts/run";
import { QualityError } from "./errors";

export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    if (typeof obj === "function" || typeof obj === "symbol") {
      throw new Error(`Unsupported type for canonical JSON serialization: ${typeof obj}`);
    }
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => (item === undefined ? "null" : canonicalJsonStringify(item))).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs: string[] = [];
  for (const k of keys) {
    const val = (obj as Record<string, unknown>)[k];
    if (val !== undefined && typeof val !== "function" && typeof val !== "symbol") {
      pairs.push(`${JSON.stringify(k)}:${canonicalJsonStringify(val)}`);
    }
  }
  return "{" + pairs.join(",") + "}";
}

export function computeCanonicalSha256(data: unknown): string {
  const canonicalStr = canonicalJsonStringify(data);
  return crypto.createHash("sha256").update(canonicalStr, "utf8").digest("hex");
}

export interface EvidenceBundle {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly cycleId: QualityCycleId;
  readonly phase: RunPhase;
  readonly configHash: string;
  readonly requirementsHash: string;
  readonly generatedAt: string;
  readonly gates: readonly GateResult[];
  readonly evidence: readonly QualityEvidence[];
  readonly verdicts: readonly RequirementVerdict[];
  readonly repairHistory: readonly RepairHistoryEntry[];
  readonly decision: QualityDecision;
  readonly routeIntent: RouteIntent;
}

export const EvidenceBundleSchema: z.ZodType<EvidenceBundle> = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1).transform(asRunId),
    cycleId: QualityCycleIdSchema,
    phase: RunPhaseSchema,
    configHash: z.string().regex(/^[0-9a-f]{64}$/),
    requirementsHash: z.string().regex(/^[0-9a-f]{64}$/),
    generatedAt: z.string().datetime({ offset: true }),
    gates: z.array(GateResultSchema).readonly(),
    evidence: z.array(QualityEvidenceSchema).readonly(),
    verdicts: z.array(RequirementVerdictSchema).readonly(),
    repairHistory: z.array(RepairHistoryEntrySchema).readonly(),
    decision: QualityDecisionSchema,
    routeIntent: RouteIntentSchema,
  })
  .strict();

export interface BundleRecord {
  readonly schemaVersion: 1;
  readonly bundleSchemaVersion: 1;
  readonly runId: RunId;
  readonly cycleId: QualityCycleId;
  readonly sha256: string;
  readonly byteLength: number;
  readonly recordedAt: string;
}

export const BundleRecordSchema: z.ZodType<BundleRecord> = z
  .object({
    schemaVersion: z.literal(1),
    bundleSchemaVersion: z.literal(1),
    runId: z.string().min(1).transform(asRunId),
    cycleId: QualityCycleIdSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    byteLength: z.number().int().nonnegative(),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export interface EvidenceBundleStorePort {
  writeBundle(
    bundle: EvidenceBundle
  ): Promise<{ bundlePath: string; recordPath: string; sha256: string; byteLength: number }>;
  readBundle(runId: RunId, cycleId?: QualityCycleId): Promise<EvidenceBundle>;
  exportSummaryMarkdown(bundle: EvidenceBundle): string;
}

export interface EvidenceBundleStoreFsHooks {
  beforeTempWrite?: (targetPath: string, tempPath: string) => Promise<void> | void;
  beforeTempSync?: (targetPath: string, tempPath: string) => Promise<void> | void;
  beforeRename?: (tempPath: string, targetPath: string) => Promise<void> | void;
  beforeDirSync?: (dirPath: string) => Promise<void> | void;
  beforeRecordWrite?: (recordPath: string) => Promise<void> | void;
  beforeRecordRename?: (tempRecordPath: string, recordPath: string) => Promise<void> | void;
}

export interface EvidenceBundleStoreOptions {
  readonly projectRoot: string;
  readonly fsHooks?: EvidenceBundleStoreFsHooks | undefined;
}

function assertValidPathSegment(id: string, name: string): void {
  if (!id || typeof id !== "string" || id.trim().length === 0) {
    throw new QualityError("GATE_EVIDENCE_INVALID", `${name} must be a non-empty string`);
  }
  if (
    id.includes("/") ||
    id.includes("\\") ||
    id.includes(":") ||
    id === "." ||
    id === ".." ||
    id.startsWith(".") ||
    id.includes("..")
  ) {
    throw new QualityError(
      "GATE_EVIDENCE_INVALID",
      `${name} contains invalid path characters or traversal segments: '${id}'`
    );
  }
}

export class EvidenceBundleStore implements EvidenceBundleStorePort {
  private readonly projectRoot: string;
  private readonly fsHooks?: EvidenceBundleStoreFsHooks | undefined;

  constructor(options: EvidenceBundleStoreOptions) {
    this.projectRoot = options.projectRoot;
    this.fsHooks = options.fsHooks;
  }

  private resolveRunQualityDir(runId: RunId): string {
    assertValidPathSegment(runId, "runId");
    return path.join(this.projectRoot, ".omni", "v4", "runs", runId, "quality");
  }

  private resolveCycleDir(runId: RunId, cycleId: QualityCycleId): string {
    assertValidPathSegment(runId, "runId");
    assertValidPathSegment(cycleId, "cycleId");
    return path.join(this.resolveRunQualityDir(runId), cycleId);
  }

  private validateBundleReferences(bundle: EvidenceBundle): void {
    assertValidPathSegment(bundle.runId, "bundle.runId");
    assertValidPathSegment(bundle.cycleId, "bundle.cycleId");

    // 1. Evidence collection validation
    const valColl = indexAndValidateEvidenceCollection(bundle.evidence, {
      runId: bundle.runId,
      cycleId: bundle.cycleId,
    });
    if (!valColl.valid) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Evidence collection in bundle failed validation: ${valColl.reason}`
      );
    }

    const evidenceMap = valColl.index.byId;

    // 2. Validate gates (uniqueness of gateId and operationId, correlation, and mandatory pass evidence)
    const seenGateIds = new Set<string>();
    const seenOpIds = new Set<string>();
    for (const gate of bundle.gates) {
      if (seenGateIds.has(gate.gateId)) {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          `Duplicate gate result '${gate.gateId}' in bundle`
        );
      }
      seenGateIds.add(gate.gateId);

      if (seenOpIds.has(gate.operationId)) {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          `Duplicate gate operationId '${gate.operationId}' in bundle`
        );
      }
      seenOpIds.add(gate.operationId);

      if (gate.cycleId !== bundle.cycleId) {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          `Gate result '${gate.gateId}' cycleId '${gate.cycleId}' does not match bundle cycleId '${bundle.cycleId}'`
        );
      }

      if (gate.status === "passed") {
        if (!gate.evidenceId) {
          throw new QualityError(
            "GATE_EVIDENCE_INVALID",
            `Passed gate '${gate.gateId}' must have mandatory evidenceId`
          );
        }
        const ev = evidenceMap.get(gate.evidenceId);
        if (!ev || ev.termination !== "exited" || ev.exitCode !== 0) {
          throw new QualityError(
            "GATE_EVIDENCE_INVALID",
            `Passed gate '${gate.gateId}' evidence must have termination 'exited' and exitCode 0`
          );
        }
      }

      if (gate.evidenceId) {
        const ev = evidenceMap.get(gate.evidenceId);
        if (!ev) {
          throw new QualityError(
            "GATE_EVIDENCE_INVALID",
            `Gate result '${gate.gateId}' references missing evidence '${gate.evidenceId}'`
          );
        }
        const corr = correlateEvidence(ev, {
          runId: bundle.runId,
          cycleId: bundle.cycleId,
          gateId: gate.gateId,
          operationId: gate.operationId,
        });
        if (!corr.correlated) {
          throw new QualityError(
            "GATE_EVIDENCE_INVALID",
            `Gate result '${gate.gateId}' evidence correlation failed: ${corr.reason}`
          );
        }
      }
    }

    // Every evidence in bundle must correlate to a gate in bundle (no orphan/foreign gate evidence)
    const declaredGateOps = new Set(bundle.gates.map((g) => `${g.gateId}::${g.operationId}`));
    for (const ev of bundle.evidence) {
      if (!declaredGateOps.has(`${ev.gateId}::${ev.operationId}`)) {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          `Orphan evidence record '${ev.evidenceId}' for gate '${ev.gateId}' operation '${ev.operationId}' has no matching gate in bundle`
        );
      }
    }

    // 3. Validate verdicts (uniqueness, evidence references, and accepted verdicts having valid evidence)
    const seenReqIds = new Set<string>();
    for (const verdict of bundle.verdicts) {
      if (seenReqIds.has(verdict.requirementId)) {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          `Duplicate verdict for requirement '${verdict.requirementId}' in bundle`
        );
      }
      seenReqIds.add(verdict.requirementId);

      if (verdict.status === "accepted" && verdict.evidenceIds.length === 0) {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          `Accepted verdict for requirement '${verdict.requirementId}' must cite at least one evidence ID`
        );
      }

      const seenVerdictEvIds = new Set<string>();
      for (const evId of verdict.evidenceIds) {
        if (seenVerdictEvIds.has(evId)) {
          throw new QualityError(
            "GATE_EVIDENCE_INVALID",
            `Verdict for requirement '${verdict.requirementId}' contains duplicate evidence ID '${evId}'`
          );
        }
        seenVerdictEvIds.add(evId);

        const ev = evidenceMap.get(evId);
        if (!ev) {
          throw new QualityError(
            "GATE_EVIDENCE_INVALID",
            `Verdict for requirement '${verdict.requirementId}' references unknown evidence '${evId}'`
          );
        }

        if (verdict.status === "accepted" && (ev.termination !== "exited" || ev.exitCode !== 0)) {
          throw new QualityError(
            "GATE_EVIDENCE_INVALID",
            `Accepted verdict for requirement '${verdict.requirementId}' cites non-zero exit or non-exited evidence '${evId}'`
          );
        }
      }
    }

    // 4. Validate Decision & Route Intent Consistency
    if (bundle.routeIntent.kind !== bundle.decision.kind) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Bundle routeIntent kind '${bundle.routeIntent.kind}' does not match decision kind '${bundle.decision.kind}'`
      );
    }
    if (bundle.routeIntent.from !== bundle.phase) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Bundle routeIntent from '${bundle.routeIntent.from}' does not match bundle phase '${bundle.phase}'`
      );
    }

    if (bundle.decision.kind === "advance") {
      if (bundle.verdicts.length === 0) {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          "Cannot advance quality cycle with zero requirement verdicts"
        );
      }
      for (const v of bundle.verdicts) {
        if (v.status !== "accepted") {
          throw new QualityError(
            "GATE_EVIDENCE_INVALID",
            `Cannot advance quality cycle when requirement '${v.requirementId}' is not accepted (status: '${v.status}')`
          );
        }
      }
      if (bundle.phase === "VERIFY" && bundle.decision.to !== "ACCEPT") {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          `VERIFY phase advance decision must route to 'ACCEPT', got '${bundle.decision.to}'`
        );
      }
      if (bundle.phase === "ACCEPT" && bundle.decision.to !== "DOCUMENT") {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          `ACCEPT phase advance decision must route to 'DOCUMENT', got '${bundle.decision.to}'`
        );
      }
      if (bundle.routeIntent.kind === "advance") {
        if (bundle.routeIntent.to !== bundle.decision.to) {
          throw new QualityError(
            "GATE_EVIDENCE_INVALID",
            `Route intent target '${bundle.routeIntent.to}' does not match decision target '${bundle.decision.to}'`
          );
        }
      }
    } else if (bundle.decision.kind === "repair") {
      if (bundle.phase === "VERIFY" && bundle.decision.to !== "FIX") {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          `VERIFY phase repair decision must route to 'FIX', got '${bundle.decision.to}'`
        );
      }
      if (bundle.phase === "ACCEPT" && bundle.decision.to !== "REWORK") {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          `ACCEPT phase repair decision must route to 'REWORK', got '${bundle.decision.to}'`
        );
      }
      if (bundle.repairHistory.length === 0) {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          "Evidence bundle with repair decision must contain non-empty repairHistory"
        );
      }
      const latestHistory = bundle.repairHistory[bundle.repairHistory.length - 1]!;
      if (latestHistory.cycleId !== bundle.cycleId) {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          `Latest repair history cycleId '${latestHistory.cycleId}' does not match bundle cycleId '${bundle.cycleId}'`
        );
      }
      if (
        JSON.stringify(latestHistory.requirementIds) !==
        JSON.stringify(bundle.decision.requirementIds)
      ) {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          "Latest repair history requirementIds do not match decision requirementIds"
        );
      }
      if (bundle.routeIntent.kind === "repair") {
        if (bundle.routeIntent.to !== bundle.decision.to) {
          throw new QualityError(
            "GATE_EVIDENCE_INVALID",
            `Route intent target '${bundle.routeIntent.to}' does not match decision target '${bundle.decision.to}'`
          );
        }
        if (
          JSON.stringify(bundle.routeIntent.requirementIds) !==
          JSON.stringify(bundle.decision.requirementIds)
        ) {
          throw new QualityError(
            "GATE_EVIDENCE_INVALID",
            "Route intent requirementIds do not match decision requirementIds"
          );
        }
        if (bundle.routeIntent.attempt !== latestHistory.attempt) {
          throw new QualityError(
            "GATE_EVIDENCE_INVALID",
            `Route intent attempt ${bundle.routeIntent.attempt} does not match latest repair history attempt ${latestHistory.attempt}`
          );
        }
      }
      if (bundle.decision.requirementIds.length === 0) {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          "Repair decision must specify at least one requirement ID"
        );
      }
      for (const reqId of bundle.decision.requirementIds) {
        if (!seenReqIds.has(reqId)) {
          throw new QualityError(
            "GATE_EVIDENCE_INVALID",
            `Repair decision references unknown requirement '${reqId}' not in verdicts`
          );
        }
      }
    } else if (bundle.decision.kind === "block") {
      if (!bundle.decision.reason || bundle.decision.reason.trim().length === 0) {
        throw new QualityError("GATE_EVIDENCE_INVALID", "Block decision must have non-empty reason");
      }
      if (!bundle.decision.requiredAction || bundle.decision.requiredAction.trim().length === 0) {
        throw new QualityError("GATE_EVIDENCE_INVALID", "Block decision must have non-empty requiredAction");
      }
      if (bundle.routeIntent.kind === "block") {
        if (bundle.routeIntent.reason !== bundle.decision.reason) {
          throw new QualityError(
            "GATE_EVIDENCE_INVALID",
            "Route intent reason does not match block decision reason"
          );
        }
        if (bundle.routeIntent.requiredAction !== bundle.decision.requiredAction) {
          throw new QualityError(
            "GATE_EVIDENCE_INVALID",
            "Route intent requiredAction does not match block decision requiredAction"
          );
        }
      }
    }

    // 5. Validate repairHistory ordering, uniqueness, and structure
    let lastAttempt = 0;
    for (const rh of bundle.repairHistory) {
      if (!rh.cycleId || typeof rh.cycleId !== "string") {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          "Repair history entry must have a valid cycleId"
        );
      }
      if (rh.attempt <= lastAttempt) {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          `Repair history attempts must be strictly ascending: got ${rh.attempt} after ${lastAttempt}`
        );
      }
      if (!rh.requirementIds || rh.requirementIds.length === 0) {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          "Repair history entry must specify at least one requirement ID"
        );
      }
      if (!rh.fingerprint || !/^[0-9a-f]{64}$/.test(rh.fingerprint)) {
        throw new QualityError(
          "GATE_EVIDENCE_INVALID",
          "Repair history entry must have a valid SHA-256 fingerprint"
        );
      }
      lastAttempt = rh.attempt;
    }
  }

  private async writeAtomicFile(
    targetPath: string,
    content: string,
    kind: "bundle" | "record"
  ): Promise<void> {
    const dir = path.dirname(targetPath);
    await fs.promises.mkdir(dir, { recursive: true });
    const tempPath = path.join(
      dir,
      `.tmp.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}`
    );

    let fileHandle: fs.promises.FileHandle | undefined;
    try {
      if (kind === "bundle" && this.fsHooks?.beforeTempWrite) {
        await this.fsHooks.beforeTempWrite(targetPath, tempPath);
      }
      if (kind === "record" && this.fsHooks?.beforeRecordWrite) {
        await this.fsHooks.beforeRecordWrite(targetPath);
      }

      fileHandle = await fs.promises.open(tempPath, "w");
      await fileHandle.writeFile(content, "utf8");

      if (kind === "bundle" && this.fsHooks?.beforeTempSync) {
        await this.fsHooks.beforeTempSync(targetPath, tempPath);
      }
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = undefined;

      if (kind === "bundle" && this.fsHooks?.beforeRename) {
        await this.fsHooks.beforeRename(tempPath, targetPath);
      }
      if (kind === "record" && this.fsHooks?.beforeRecordRename) {
        await this.fsHooks.beforeRecordRename(tempPath, targetPath);
      }
      await fs.promises.rename(tempPath, targetPath);

      let dirHandle: fs.promises.FileHandle | undefined;
      try {
        if (this.fsHooks?.beforeDirSync) {
          await this.fsHooks.beforeDirSync(dir);
        }
        dirHandle = await fs.promises.open(dir, "r");
        await dirHandle.sync();
      } catch (dirErr: unknown) {
        const code = (dirErr as { code?: string })?.code;
        const msg = String(dirErr);
        const isUnsupported =
          code === "EINVAL" ||
          code === "EPERM" ||
          code === "ENOTDIR" ||
          code === "EISDIR" ||
          code === "EBADF" ||
          code === "ENOSYS" ||
          code === "ENOTSUP" ||
          msg.includes("operation not permitted") ||
          msg.includes("inappropriate ioctl for device");
        if (!isUnsupported) {
          throw dirErr;
        }
      } finally {
        if (dirHandle) {
          await dirHandle.close().catch(() => {});
        }
      }
    } catch (err) {
      if (fileHandle) {
        await fileHandle.close().catch(() => {});
      }
      if (fs.existsSync(tempPath)) {
        await fs.promises.unlink(tempPath).catch(() => {});
      }
      throw err;
    }
  }

  async writeBundle(
    bundle: EvidenceBundle
  ): Promise<{ bundlePath: string; recordPath: string; sha256: string; byteLength: number }> {
    let validated: EvidenceBundle;
    try {
      validated = EvidenceBundleSchema.parse(bundle);
    } catch (err: unknown) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Evidence bundle schema validation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    this.validateBundleReferences(validated);

    // Canonical JSON stringify ONCE and hash exact canonical bytes
    const canonicalJson = canonicalJsonStringify(validated) + "\n";
    const canonicalBytes = Buffer.from(canonicalJson, "utf8");
    const sha256 = crypto.createHash("sha256").update(canonicalBytes).digest("hex");
    const byteLength = canonicalBytes.byteLength;

    const record: BundleRecord = {
      schemaVersion: 1,
      bundleSchemaVersion: 1,
      runId: validated.runId,
      cycleId: validated.cycleId,
      sha256,
      byteLength,
      recordedAt: validated.generatedAt,
    };

    let canonicalRecordJson: string;
    try {
      canonicalRecordJson = canonicalJsonStringify(BundleRecordSchema.parse(record)) + "\n";
    } catch (err: unknown) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Bundle record schema validation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 1. Write immutable cycle-scoped bundle & record
    const cycleDir = this.resolveCycleDir(validated.runId, validated.cycleId);
    const cycleBundlePath = path.join(cycleDir, "bundle.json");
    const cycleRecordPath = path.join(cycleDir, "bundle.record.json");

    await this.writeAtomicFile(cycleBundlePath, canonicalJson, "bundle");
    await this.writeAtomicFile(cycleRecordPath, canonicalRecordJson, "record");

    // 2. Write authorized latest run-level bundle & record
    const runQualityDir = this.resolveRunQualityDir(validated.runId);
    const authorizedBundlePath = path.join(runQualityDir, "bundle.json");
    const authorizedRecordPath = path.join(runQualityDir, "bundle.record.json");

    await this.writeAtomicFile(authorizedBundlePath, canonicalJson, "bundle");
    await this.writeAtomicFile(authorizedRecordPath, canonicalRecordJson, "record");

    return {
      bundlePath: authorizedBundlePath,
      recordPath: authorizedRecordPath,
      sha256,
      byteLength,
    };
  }

  async readBundle(
    runId: RunId,
    cycleId?: QualityCycleId
  ): Promise<EvidenceBundle> {
    assertValidPathSegment(runId, "runId");
    if (cycleId) {
      assertValidPathSegment(cycleId, "cycleId");
    }

    let bundlePath: string;
    let recordPath: string;

    if (cycleId) {
      const cycleDir = this.resolveCycleDir(runId, cycleId);
      bundlePath = path.join(cycleDir, "bundle.json");
      recordPath = path.join(cycleDir, "bundle.record.json");
    } else {
      const runQualityDir = this.resolveRunQualityDir(runId);
      bundlePath = path.join(runQualityDir, "bundle.json");
      recordPath = path.join(runQualityDir, "bundle.record.json");
    }

    // 1. Read and validate checksum record
    if (!fs.existsSync(recordPath)) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Missing evidence bundle checksum record at '${recordPath}'`
      );
    }

    let record: BundleRecord;
    try {
      const recordRaw = await fs.promises.readFile(recordPath, "utf8");
      record = BundleRecordSchema.parse(JSON.parse(recordRaw));
    } catch (err: unknown) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Corrupt bundle record at '${recordPath}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (record.runId !== runId) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Record runId '${record.runId}' does not match requested runId '${runId}'`
      );
    }
    if (cycleId && record.cycleId !== cycleId) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Record cycleId '${record.cycleId}' does not match requested cycleId '${cycleId}'`
      );
    }

    // 2. Read bundle content
    if (!fs.existsSync(bundlePath)) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Missing evidence bundle file at '${bundlePath}'`
      );
    }

    let bundleRawBytes: Buffer;
    try {
      bundleRawBytes = await fs.promises.readFile(bundlePath);
    } catch (err: unknown) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Failed to read bundle at '${bundlePath}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 3. Verify byte length and sha256 checksum on exact bytes
    const actualByteLength = bundleRawBytes.byteLength;
    if (actualByteLength !== record.byteLength) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Bundle byte length mismatch: expected ${record.byteLength}, got ${actualByteLength}`
      );
    }

    const actualSha256 = crypto.createHash("sha256").update(bundleRawBytes).digest("hex");
    if (actualSha256 !== record.sha256) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Bundle checksum digest mismatch: expected ${record.sha256}, got ${actualSha256}`
      );
    }

    // 4. Parse schema & validate references
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(bundleRawBytes.toString("utf8"));
    } catch (err: unknown) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Bundle content is invalid JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    let bundle: EvidenceBundle;
    try {
      bundle = EvidenceBundleSchema.parse(parsedJson);
    } catch (err: unknown) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Evidence bundle schema validation failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (bundle.runId !== record.runId || bundle.cycleId !== record.cycleId) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Bundle identity mismatch between record (${record.runId}/${record.cycleId}) and content (${bundle.runId}/${bundle.cycleId})`
      );
    }

    if (bundle.runId !== runId) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Bundle runId '${bundle.runId}' does not match requested runId '${runId}'`
      );
    }

    if (cycleId && bundle.cycleId !== cycleId) {
      throw new QualityError(
        "GATE_EVIDENCE_INVALID",
        `Requested cycleId '${cycleId}' does not match bundle cycleId '${bundle.cycleId}'`
      );
    }

    this.validateBundleReferences(bundle);
    return bundle;
  }

  exportSummaryMarkdown(bundle: EvidenceBundle): string {
    const lines: string[] = [
      `# Quality Cycle Summary: ${bundle.cycleId}`,
      `- **Phase:** ${bundle.phase}`,
      `- **Run ID:** ${bundle.runId}`,
      `- **Config Hash:** \`${bundle.configHash}\``,
      `- **Requirements Hash:** \`${bundle.requirementsHash}\``,
      `- **Generated At:** ${bundle.generatedAt}`,
      `- **Decision:** ${bundle.decision.kind}${
        bundle.decision.kind === "advance"
          ? ` -> ${bundle.decision.to}`
          : bundle.decision.kind === "repair"
          ? ` -> ${bundle.decision.to}`
          : ` (${bundle.decision.reason})`
      }`,
      ``,
      `## Gates Execution`,
      `| Gate ID | Status | Duration (ms) | Reason / Note |`,
      `| :--- | :--- | :--- | :--- |`,
    ];

    for (const gate of bundle.gates) {
      const reason = gate.status === "passed" ? "OK" : gate.reason || "-";
      const dur = gate.status === "skipped" ? "-" : String(gate.durationMs);
      lines.push(`| \`${gate.gateId}\` | **${gate.status.toUpperCase()}** | ${dur} | ${reason} |`);
    }

    lines.push(``);
    lines.push(`## Requirements Verdicts`);
    lines.push(`| Requirement ID | Status | Evidence IDs | Rationale |`, `| :--- | :--- | :--- | :--- |`);

    for (const v of bundle.verdicts) {
      const evs = v.evidenceIds.map((e) => `\`${e}\``).join(", ") || "-";
      const rat = v.rationale || (v.status === "accepted" ? "Verified" : "-");
      lines.push(`| \`${v.requirementId}\` | **${v.status.toUpperCase()}** | ${evs} | ${rat} |`);
    }

    return lines.join("\n");
  }
}
