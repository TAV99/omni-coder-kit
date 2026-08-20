"use strict";

const mode = process.argv[2];

if (mode === "echo") {
  process.stdin.setEncoding("utf8");
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({ args: process.argv.slice(3), input }));
  });
} else if (mode === "stderr") {
  process.stderr.write("fixture-error");
  process.exit(7);
} else if (mode === "wait") {
  setInterval(() => {}, 1000);
} else if (mode === "flood") {
  process.stdout.write("x".repeat(11 * 1024 * 1024));
} else if (mode === "signal" && process.platform !== "win32") {
  process.kill(process.pid, "SIGTERM");
} else {
  process.stderr.write("unknown fixture mode");
  process.exit(2);
}
