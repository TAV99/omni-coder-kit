import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const MigrationIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

const MigrationFileSchema = z.object({
  relativePath: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
}).strict();

export const MigrationPlanSchema = z.object({
  schemaVersion: z.literal(1),
  migrationId: MigrationIdSchema,
  mode: z.literal("dry-run"),
  sourceFormat: z.literal("omni-v3"),
  destinationFormat: z.literal("omni-v4-legacy-import"),
  files: z.array(MigrationFileSchema).readonly(),
  planSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type MigrationPlan = z.infer<typeof MigrationPlanSchema>;

const BackupEntrySchema = MigrationFileSchema.extend({
  backupPath: z.string().min(1),
}).strict();

const BackupManifestSchema = z.object({
  schemaVersion: z.literal(1),
  migrationId: MigrationIdSchema,
  createdAt: z.string().datetime({ offset: true }),
  files: z.array(BackupEntrySchema).readonly(),
}).strict();

const MigrationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  migrationId: MigrationIdSchema,
  sourceFormat: z.literal("omni-v3"),
  destinationFormat: z.literal("omni-v4-legacy-import"),
  planSha256: z.string().regex(/^[0-9a-f]{64}$/),
  backupManifestPath: z.string().min(1),
  backupManifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sourceFiles: z.array(MigrationFileSchema).readonly(),
  status: z.literal("imported"),
}).strict();

export interface MigrationReceipt {
  readonly migrationId: string;
  readonly backupManifestPath: string;
  readonly backupManifestSha256: string;
  readonly migrationRecordPath: string;
}

function sha256(value: Buffer | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function portable(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function canonicalMigrationRoot(root: string, migrationId: string): string {
  return path.join(root, ".omni", "v4", "migrations", migrationId);
}

function canonicalManifestRelativePath(migrationId: string): string {
  return `.omni/v4/migrations/${migrationId}/backup-manifest.json`;
}

function canonicalRecordRelativePath(migrationId: string): string {
  return `.omni/v4/migrations/${migrationId}/migration.json`;
}

function isCanonicalSourcePath(relativePath: string): boolean {
  const normalized = portable(relativePath);
  return normalized.startsWith(".omni/run/") || normalized.startsWith(".omni/sdlc/");
}

function planHashBasis(plan: Omit<MigrationPlan, "planSha256">): string {
  return JSON.stringify({
    schemaVersion: plan.schemaVersion,
    migrationId: plan.migrationId,
    mode: plan.mode,
    sourceFormat: plan.sourceFormat,
    destinationFormat: plan.destinationFormat,
    files: plan.files,
  });
}

function computePlanHash(plan: Omit<MigrationPlan, "planSha256">): string {
  return sha256(planHashBasis(plan));
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function atomicWrite(filePath: string, content: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, content);
  await fs.rename(temporary, filePath);
}

async function walkFiles(root: string, current: string): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const target = path.join(current, entry.name);
    if (!contained(root, target)) throw new Error("MIGRATION_PATH_UNSAFE: path escapes project root");
    if (entry.isSymbolicLink()) throw new Error("MIGRATION_PATH_UNSAFE: symbolic links are not allowed");
    if (entry.isDirectory()) files.push(...await walkFiles(root, target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

export async function createMigrationPlan(projectRoot: string, migrationId: string): Promise<MigrationPlan> {
  const parsedId = MigrationIdSchema.parse(migrationId);
  const root = path.resolve(projectRoot);
  const candidates = [
    ...await walkFiles(root, path.join(root, ".omni", "run")),
    ...await walkFiles(root, path.join(root, ".omni", "sdlc")),
  ];
  const files = [];
  for (const filePath of candidates) {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("MIGRATION_PATH_UNSAFE: source must be a regular file");
    }
    const content = await fs.readFile(filePath);
    files.push({
      relativePath: portable(path.relative(root, filePath)),
      sha256: sha256(content),
      sizeBytes: content.byteLength,
    });
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const planWithoutHash = {
    schemaVersion: 1,
    migrationId: parsedId,
    mode: "dry-run",
    sourceFormat: "omni-v3",
    destinationFormat: "omni-v4-legacy-import",
    files,
  } as const;
  return MigrationPlanSchema.parse({
    ...planWithoutHash,
    planSha256: computePlanHash(planWithoutHash),
  });
}

async function verifyManifestFiles(
  root: string,
  manifest: z.infer<typeof BackupManifestSchema>
): Promise<boolean> {
  const migrationRoot = canonicalMigrationRoot(root, manifest.migrationId);
  for (const item of manifest.files) {
    if (!isCanonicalSourcePath(item.relativePath)) return false;
    const expectedBackupPath = path.join(migrationRoot, "backup", ...item.relativePath.split("/"));
    const backupPath = path.resolve(root, item.backupPath);
    if (
      portable(path.relative(root, backupPath)) !== portable(path.relative(root, expectedBackupPath)) ||
      !contained(migrationRoot, backupPath)
    ) return false;
    const stat = await fs.lstat(backupPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const content = await fs.readFile(backupPath);
    if (content.byteLength !== item.sizeBytes || sha256(content) !== item.sha256) return false;
  }
  return true;
}

export async function verifyBackup(projectRoot: string, manifestRelativePath: string): Promise<boolean> {
  const root = path.resolve(projectRoot);
  const manifestPath = path.resolve(root, manifestRelativePath);
  if (!contained(root, manifestPath)) return false;
  try {
    const manifestContent = await fs.readFile(manifestPath);
    const manifest = BackupManifestSchema.parse(JSON.parse(manifestContent.toString("utf8")));
    if (portable(path.relative(root, manifestPath)) !== canonicalManifestRelativePath(manifest.migrationId)) {
      return false;
    }
    const recordPath = path.join(root, canonicalRecordRelativePath(manifest.migrationId));
    const record = MigrationRecordSchema.parse(JSON.parse(await fs.readFile(recordPath, "utf8")));
    if (
      record.migrationId !== manifest.migrationId ||
      record.backupManifestPath !== canonicalManifestRelativePath(manifest.migrationId) ||
      record.backupManifestSha256 !== sha256(manifestContent) ||
      JSON.stringify(record.sourceFiles) !==
        JSON.stringify(manifest.files.map(({ backupPath: _backupPath, ...source }) => source)) ||
      record.planSha256 !== computePlanHash({
        schemaVersion: 1,
        migrationId: record.migrationId,
        mode: "dry-run",
        sourceFormat: record.sourceFormat,
        destinationFormat: record.destinationFormat,
        files: record.sourceFiles,
      })
    ) return false;
    return await verifyManifestFiles(root, manifest);
  } catch {
    return false;
  }
}

export async function applyMigration(projectRoot: string, input: MigrationPlan): Promise<MigrationReceipt> {
  const plan = MigrationPlanSchema.parse(input);
  const root = path.resolve(projectRoot);
  const { planSha256: suppliedPlanHash, ...planWithoutHash } = plan;
  if (computePlanHash(planWithoutHash) !== suppliedPlanHash) {
    throw new Error("MIGRATION_PLAN_TAMPERED: plan contents do not match plan hash");
  }
  const migrationRoot = canonicalMigrationRoot(root, plan.migrationId);
  if (await fs.lstat(migrationRoot).then(() => true).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  })) {
    throw new Error("MIGRATION_ID_REUSED: migration ID already exists");
  }
  const current = await createMigrationPlan(root, plan.migrationId);
  if (JSON.stringify(current) !== JSON.stringify(plan)) {
    throw new Error("MIGRATION_SOURCE_CHANGED: dry-run plan no longer matches source");
  }
  await fs.mkdir(path.dirname(migrationRoot), { recursive: true });
  try {
    await fs.mkdir(migrationRoot);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("MIGRATION_ID_REUSED: migration ID already exists");
    }
    throw error;
  }
  const backupEntries = [];
  try {
    for (const item of plan.files) {
      const sourcePath = path.resolve(root, item.relativePath);
      const backupPath = path.join(migrationRoot, "backup", item.relativePath);
      if (
        !isCanonicalSourcePath(item.relativePath) ||
        !contained(root, sourcePath) ||
        !contained(migrationRoot, backupPath)
      ) {
        throw new Error("MIGRATION_PATH_UNSAFE: planned path escapes allowed root");
      }
      const content = await fs.readFile(sourcePath);
      if (sha256(content) !== item.sha256) throw new Error("MIGRATION_SOURCE_CHANGED: checksum mismatch");
      await atomicWrite(backupPath, content);
      backupEntries.push({ ...item, backupPath: portable(path.relative(root, backupPath)) });
    }
    const manifest = BackupManifestSchema.parse({
    schemaVersion: 1,
    migrationId: plan.migrationId,
    createdAt: new Date().toISOString(),
    files: backupEntries,
  });
    const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestPath = path.join(migrationRoot, "backup-manifest.json");
    await atomicWrite(manifestPath, manifestContent);
    const manifestRelativePath = canonicalManifestRelativePath(plan.migrationId);
    if (!await verifyManifestFiles(root, manifest)) {
      throw new Error("MIGRATION_BACKUP_INVALID: backup verification failed");
    }
    const recordPath = path.join(migrationRoot, "migration.json");
    const record = MigrationRecordSchema.parse({
    schemaVersion: 1,
    migrationId: plan.migrationId,
    sourceFormat: plan.sourceFormat,
    destinationFormat: plan.destinationFormat,
    planSha256: plan.planSha256,
    backupManifestPath: manifestRelativePath,
    backupManifestSha256: sha256(manifestContent),
    sourceFiles: plan.files,
    status: "imported",
    });
    await atomicWrite(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    if (!await verifyBackup(root, manifestRelativePath)) {
      throw new Error("MIGRATION_BACKUP_INVALID: receipt or backup verification failed");
    }
    return {
      migrationId: plan.migrationId,
      backupManifestPath: manifestRelativePath,
      backupManifestSha256: sha256(manifestContent),
      migrationRecordPath: canonicalRecordRelativePath(plan.migrationId),
    };
  } catch (error) {
    await fs.rm(migrationRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function rollbackMigration(projectRoot: string, manifestRelativePath: string): Promise<void> {
  const root = path.resolve(projectRoot);
  const manifestPath = path.resolve(root, manifestRelativePath);
  if (!contained(root, manifestPath) || !await verifyBackup(root, manifestRelativePath)) {
    throw new Error("BACKUP_TAMPERED: backup manifest or file checksum is invalid");
  }
  const manifest = BackupManifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, "utf8")));
  for (const item of manifest.files) {
    const targetPath = path.resolve(root, item.relativePath);
    const backupPath = path.resolve(root, item.backupPath);
    const migrationRoot = canonicalMigrationRoot(root, manifest.migrationId);
    const expectedBackupPath = path.join(migrationRoot, "backup", ...item.relativePath.split("/"));
    if (
      !isCanonicalSourcePath(item.relativePath) ||
      !contained(root, targetPath) ||
      !contained(migrationRoot, backupPath) ||
      portable(path.relative(root, backupPath)) !== portable(path.relative(root, expectedBackupPath))
    ) {
      throw new Error("MIGRATION_PATH_UNSAFE: rollback path escapes project root");
    }
    await atomicWrite(targetPath, await fs.readFile(backupPath));
  }
}
