import { spawn, type ChildProcess } from "node:child_process";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "./types";
import { resolveWindowsNativeCommand } from "./windows-native-command";

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MiB
const FORCE_KILL_GRACE_MS = 500;

function forceKillProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.unref();
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

export class NodeProcessRunner implements ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult> {
    if (request.signal?.aborted) {
      return Promise.resolve({
        stdout: "",
        stderr: "",
        durationMs: 0,
        termination: "aborted",
        exitCode: null,
        signal: null,
      });
    }

    return new Promise<ProcessResult>((resolve) => {
      const startTime = Date.now();
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let isSettled = false;
      let terminationReason: ProcessResult["termination"] | undefined;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let forceKillHandle: NodeJS.Timeout | undefined;
      let child: ChildProcess | undefined;

      const cleanup = () => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
        if (forceKillHandle) {
          clearTimeout(forceKillHandle);
          forceKillHandle = undefined;
        }
        if (request.signal) {
          request.signal.removeEventListener("abort", onAbort);
        }
      };

      const safeResolve = (result: ProcessResult) => {
        if (isSettled) return;
        isSettled = true;
        cleanup();
        resolve(result);
      };

      const terminateChild = (reason: ProcessResult["termination"]) => {
        if (terminationReason) return;
        terminationReason = reason;

        if (child && !child.killed) {
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }

          forceKillHandle = setTimeout(() => {
            if (child && !child.killed) {
              forceKillProcessTree(child);
            }
          }, FORCE_KILL_GRACE_MS);
        }
      };

      const onAbort = () => {
        terminateChild("aborted");
      };

      const onTimeout = () => {
        terminateChild("timed-out");
      };

      if (request.signal) {
        request.signal.addEventListener("abort", onAbort, { once: true });
      }

      if (request.timeoutMs > 0) {
        timeoutHandle = setTimeout(onTimeout, request.timeoutMs);
      }

      try {
        const childEnv = request.env ? { ...process.env, ...request.env } : process.env;
        const command = resolveWindowsNativeCommand(request.command, childEnv);
        child = spawn(command, [...request.args], {
          cwd: request.cwd,
          env: childEnv,
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err: any) {
        return safeResolve({
          stdout: "",
          stderr: "",
          durationMs: Date.now() - startTime,
          termination: "spawn-error",
          exitCode: null,
          signal: null,
          error: {
            code: err.code ?? "SPAWN_ERROR",
            message: err.message ?? String(err),
          },
        });
      }

      child.on("error", (err: any) => {
        safeResolve({
          stdout,
          stderr,
          durationMs: Date.now() - startTime,
          termination: "spawn-error",
          exitCode: null,
          signal: null,
          error: {
            code: err.code ?? "SPAWN_ERROR",
            message: err.message ?? String(err),
          },
        });
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES && !terminationReason) {
          terminateChild("output-limit");
          return;
        }
        if (!terminationReason) {
          stdout += chunk.toString("utf-8");
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_OUTPUT_BYTES && !terminationReason) {
          terminateChild("output-limit");
          return;
        }
        if (!terminationReason) {
          stderr += chunk.toString("utf-8");
        }
      });

      if (request.stdin !== undefined && child.stdin) {
        child.stdin.write(request.stdin, "utf-8", () => {
          child?.stdin?.end();
        });
      } else if (child.stdin) {
        child.stdin.end();
      }

      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        const durationMs = Date.now() - startTime;

        if (terminationReason === "timed-out") {
          safeResolve({
            stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
            stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
            durationMs,
            termination: "timed-out",
            exitCode: null,
            signal: null,
          });
          return;
        }

        if (terminationReason === "aborted") {
          safeResolve({
            stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
            stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
            durationMs,
            termination: "aborted",
            exitCode: null,
            signal: null,
          });
          return;
        }

        if (terminationReason === "output-limit") {
          safeResolve({
            stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
            stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
            durationMs,
            termination: "output-limit",
            exitCode: null,
            signal: null,
          });
          return;
        }

        if (code !== null) {
          safeResolve({
            stdout,
            stderr,
            durationMs,
            termination: "exited",
            exitCode: code,
            signal: null,
          });
        } else if (signal !== null) {
          safeResolve({
            stdout,
            stderr,
            durationMs,
            termination: "signalled",
            exitCode: null,
            signal,
          });
        } else {
          safeResolve({
            stdout,
            stderr,
            durationMs,
            termination: "exited",
            exitCode: 0,
            signal: null,
          });
        }
      });
    });
  }
}
