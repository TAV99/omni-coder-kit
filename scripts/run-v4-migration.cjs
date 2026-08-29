"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const entry = path.join(root, "src", "v4", "migration", "cli.ts");
const result = spawnSync(process.execPath, ["--import", "tsx", entry, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
process.exit(result.status ?? 1);
