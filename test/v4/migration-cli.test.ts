import assert from "node:assert/strict";
import test from "node:test";
import { parseMigrationCliArgs } from "../../src/v4/migration/cli";

test("migration CLI defaults to non-mutating dry-run", () => {
  assert.deepEqual(parseMigrationCliArgs(["--project", "C:\\repo", "--id", "m-1"]), {
    projectRoot: "C:\\repo",
    migrationId: "m-1",
    mode: "dry-run",
  });
});

test("migration CLI requires explicit apply and exact rollback manifest", () => {
  assert.equal(parseMigrationCliArgs(["--project", ".", "--id", "m-2", "--apply"]).mode, "apply");
  assert.deepEqual(
    parseMigrationCliArgs(["--project", ".", "--rollback", ".omni/v4/migrations/m-2/backup-manifest.json"]),
    {
      projectRoot: ".",
      mode: "rollback",
      backupManifestPath: ".omni/v4/migrations/m-2/backup-manifest.json",
    }
  );
  assert.throws(() => parseMigrationCliArgs(["--project", ".", "--apply"]), /--id/);
  assert.throws(() => parseMigrationCliArgs(["--project", ".", "--id", "m", "--apply", "--rollback", "x"]), /exclusive/);
});
