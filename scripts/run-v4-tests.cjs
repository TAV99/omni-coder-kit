"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const testDir = path.join(root, "test", "v4");
const files = fs.existsSync(testDir)
  ? fs.readdirSync(testDir)
      .filter((name) => name.endsWith(".test.ts"))
      .sort()
      .map((name) => path.join(testDir, name))
  : [];

if (files.length === 0) {
  console.error("No v4 test files found in test/v4");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...files],
  { cwd: root, stdio: "inherit" },
);

process.exit(result.status ?? 1);
