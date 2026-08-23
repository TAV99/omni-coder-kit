"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const runnerScript = path.join(root, "src", "v4", "benchmark", "cli.ts");

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", runnerScript, ...process.argv.slice(2)],
  { cwd: root, stdio: "inherit" }
);

process.exit(result.status ?? 1);
