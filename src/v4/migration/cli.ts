import path from "node:path";
import {
  applyMigration,
  createMigrationPlan,
  rollbackMigration,
} from "./migrator";

export type MigrationCliArgs =
  | { readonly projectRoot: string; readonly migrationId: string; readonly mode: "dry-run" | "apply" }
  | { readonly projectRoot: string; readonly mode: "rollback"; readonly backupManifestPath: string };

function invalid(message: string): Error {
  return new Error(`[MIGRATION_CLI_INVALID] ${message}`);
}

export function parseMigrationCliArgs(argv: readonly string[]): MigrationCliArgs {
  let projectRoot: string | undefined;
  let migrationId: string | undefined;
  let apply = false;
  let rollbackPath: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--project") {
      const value = argv[++index];
      if (!value || projectRoot) throw invalid("--project requires exactly one path");
      projectRoot = value;
    } else if (arg === "--id") {
      const value = argv[++index];
      if (!value || migrationId) throw invalid("--id requires exactly one migration ID");
      migrationId = value;
    } else if (arg === "--apply") {
      if (apply) throw invalid("--apply may be specified once");
      apply = true;
    } else if (arg === "--rollback") {
      const value = argv[++index];
      if (!value || rollbackPath) throw invalid("--rollback requires exactly one manifest path");
      rollbackPath = value;
    } else {
      throw invalid(`unknown argument '${arg}'`);
    }
  }
  if (!projectRoot) throw invalid("--project is required");
  if (apply && rollbackPath) throw invalid("--apply and --rollback are mutually exclusive");
  if (rollbackPath) {
    if (migrationId) throw invalid("--id and --rollback are mutually exclusive");
    return { projectRoot, mode: "rollback", backupManifestPath: rollbackPath };
  }
  if (!migrationId) throw invalid("--id is required for dry-run and apply");
  return { projectRoot, migrationId, mode: apply ? "apply" : "dry-run" };
}

export async function runMigrationCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseMigrationCliArgs(argv);
  const root = path.resolve(args.projectRoot);
  if (args.mode === "rollback") {
    await rollbackMigration(root, args.backupManifestPath);
    console.log(`[Omni v4 Migration] Rollback verified: ${args.backupManifestPath}`);
    return;
  }
  const plan = await createMigrationPlan(root, args.migrationId);
  if (args.mode === "dry-run") {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const receipt = await applyMigration(root, plan);
  console.log(JSON.stringify(receipt, null, 2));
}

if (require.main === module) {
  runMigrationCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
