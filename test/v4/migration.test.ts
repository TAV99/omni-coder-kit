import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyMigration,
  createMigrationPlan,
  rollbackMigration,
  verifyBackup,
} from "../../src/v4/migration/migrator";

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omni-v4-migration-"));
  await fs.mkdir(path.join(root, ".omni", "run"), { recursive: true });
  await fs.mkdir(path.join(root, ".omni", "sdlc"), { recursive: true });
  await fs.writeFile(path.join(root, ".omni", "run", "state.json"), '{"state":"CHECK"}\n');
  await fs.writeFile(path.join(root, ".omni", "run", "events.ndjson"), '{"type":"transition"}\n');
  await fs.writeFile(path.join(root, ".omni", "sdlc", "todo.md"), "- [x] task\n");
  return root;
}

test("dry_run_is_non_mutating", async () => {
  const root = await fixture();
  try {
    const before = await fs.readdir(path.join(root, ".omni"));
    const plan = await createMigrationPlan(root, "migration-001");
    const after = await fs.readdir(path.join(root, ".omni"));
    assert.deepEqual(after, before);
    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.mode, "dry-run");
    assert.deepEqual(plan.files.map((item) => item.relativePath), [
      ".omni/run/events.ndjson",
      ".omni/run/state.json",
      ".omni/sdlc/todo.md",
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verified_backup_before_apply", async () => {
  const root = await fixture();
  try {
    const plan = await createMigrationPlan(root, "migration-002");
    const receipt = await applyMigration(root, plan);
    assert.equal(await verifyBackup(root, receipt.backupManifestPath), true);
    const record = JSON.parse(
      await fs.readFile(path.join(root, receipt.migrationRecordPath), "utf8")
    ) as { sourceFiles: unknown[]; backupManifestSha256: string };
    assert.equal(record.sourceFiles.length, 3);
    assert.match(record.backupManifestSha256, /^[0-9a-f]{64}$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rollback_byte_identical", async () => {
  const root = await fixture();
  try {
    const original = await fs.readFile(path.join(root, ".omni", "run", "state.json"));
    const plan = await createMigrationPlan(root, "migration-003");
    const receipt = await applyMigration(root, plan);
    await fs.writeFile(path.join(root, ".omni", "run", "state.json"), "changed\n");
    await rollbackMigration(root, receipt.backupManifestPath);
    assert.deepEqual(await fs.readFile(path.join(root, ".omni", "run", "state.json")), original);

    const manifestPath = path.join(root, receipt.backupManifestPath);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      files: Array<{ backupPath: string }>;
    };
    await fs.writeFile(path.join(root, manifest.files[0]!.backupPath), "tampered\n");
    await assert.rejects(() => rollbackMigration(root, receipt.backupManifestPath), /BACKUP_TAMPERED/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("migration rejects symlinked source artifacts", async (t) => {
  const root = await fixture();
  try {
    const target = path.join(root, "outside.txt");
    await fs.writeFile(target, "outside\n");
    await fs.rm(path.join(root, ".omni", "run", "state.json"));
    try {
      await fs.symlink(target, path.join(root, ".omni", "run", "state.json"));
    } catch {
      t.skip("Symlink creation is unavailable on this platform");
      return;
    }
    await assert.rejects(() => createMigrationPlan(root, "migration-004"), /MIGRATION_PATH_UNSAFE/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("apply rejects modified plan files even when the original plan hash is retained", async () => {
  const root = await fixture();
  try {
    const plan = await createMigrationPlan(root, "migration-plan-forgery");
    const forged = {
      ...plan,
      files: [
        ...plan.files,
        {
          relativePath: ".omni/sdlc/forged.md",
          sha256: "0".repeat(64),
          sizeBytes: 0,
        },
      ],
    };
    await assert.rejects(
      () => applyMigration(root, forged),
      /MIGRATION_PLAN_TAMPERED/
    );
    await assert.rejects(
      fs.access(path.join(root, ".omni", "v4", "migrations", plan.migrationId))
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("migration ID cannot be reused or overwrite an existing migration", async () => {
  const root = await fixture();
  try {
    const plan = await createMigrationPlan(root, "migration-reused");
    const receipt = await applyMigration(root, plan);
    const recordBefore = await fs.readFile(path.join(root, receipt.migrationRecordPath));
    await assert.rejects(() => applyMigration(root, plan), /MIGRATION_ID_REUSED/);
    assert.deepEqual(
      await fs.readFile(path.join(root, receipt.migrationRecordPath)),
      recordBefore
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verification rejects non-canonical manifests and backup paths", async () => {
  const root = await fixture();
  try {
    const plan = await createMigrationPlan(root, "migration-canonical-paths");
    const receipt = await applyMigration(root, plan);
    const canonicalManifest = path.join(root, receipt.backupManifestPath);
    const copiedManifest = path.join(root, ".omni", "copied-manifest.json");
    await fs.copyFile(canonicalManifest, copiedManifest);
    assert.equal(await verifyBackup(root, ".omni/copied-manifest.json"), false);

    const manifest = JSON.parse(await fs.readFile(canonicalManifest, "utf8")) as {
      files: Array<{ backupPath: string }>;
    };
    manifest.files[0]!.backupPath = ".omni/run/state.json";
    await fs.writeFile(canonicalManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.equal(await verifyBackup(root, receipt.backupManifestPath), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rollback verifies the canonical migration receipt and manifest digest", async () => {
  const root = await fixture();
  try {
    const plan = await createMigrationPlan(root, "migration-receipt-digest");
    const receipt = await applyMigration(root, plan);
    const recordPath = path.join(root, receipt.migrationRecordPath);
    const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
      backupManifestSha256: string;
    };
    record.backupManifestSha256 = "0".repeat(64);
    await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    assert.equal(await verifyBackup(root, receipt.backupManifestPath), false);
    await assert.rejects(
      () => rollbackMigration(root, receipt.backupManifestPath),
      /BACKUP_TAMPERED/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("verification rejects a receipt whose source inventory differs from the manifest", async () => {
  const root = await fixture();
  try {
    const plan = await createMigrationPlan(root, "migration-receipt-inventory");
    const receipt = await applyMigration(root, plan);
    const recordPath = path.join(root, receipt.migrationRecordPath);
    const record = JSON.parse(await fs.readFile(recordPath, "utf8")) as {
      sourceFiles: Array<{ relativePath: string }>;
    };
    record.sourceFiles = record.sourceFiles.slice(1);
    await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    assert.equal(await verifyBackup(root, receipt.backupManifestPath), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rollback cannot use a forged canonical-looking manifest to overwrite arbitrary files", async () => {
  const root = await fixture();
  try {
    const plan = await createMigrationPlan(root, "migration-forged-overwrite");
    const receipt = await applyMigration(root, plan);
    const protectedPath = path.join(root, "protected.txt");
    await fs.writeFile(protectedPath, "protected\n");
    const manifestPath = path.join(root, receipt.backupManifestPath);
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      files: Array<{ relativePath: string }>;
    };
    manifest.files[0]!.relativePath = "protected.txt";
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await assert.rejects(
      () => rollbackMigration(root, receipt.backupManifestPath),
      /BACKUP_TAMPERED|MIGRATION_PATH_UNSAFE/
    );
    assert.equal(await fs.readFile(protectedPath, "utf8"), "protected\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
