'use strict';

// ---------------------------------------------------------------------------
// Guarded shell execution (HARNESS-SPEC-PHASE-1 §2.2, §8).
//
// EVERY shell command the harness runs goes through runCommand(). isDenied()
// blocks destructive commands BEFORE they run — deny-list mirrors the
// .claude/settings.json overlay (rm -rf, push --force, reset --hard, fork bomb).
// ---------------------------------------------------------------------------

const { spawnSync } = require('child_process');

const DENY = [
    /\brm\s+-rf\b/,
    /git\s+push\b/,        // harness never pushes/deploys (covers --force too)
    /git\s+reset\s+--hard/,
    /:\(\)\s*\{.*\};\s*:/, // fork bomb
];

// Pure — testable without spawning anything.
function isDenied(cmd) {
    if (typeof cmd !== 'string' || !cmd.trim()) return false;
    return DENY.some((re) => re.test(cmd));
}

// Synchronous command runner. Throws on a denied command (never executes it).
function runCommand(cmd, { cwd = process.cwd(), timeoutMs = 120000, env } = {}) {
    if (isDenied(cmd)) {
        throw new Error(`Lệnh bị chặn bởi deny-list (an toàn): ${cmd}`);
    }
    const res = spawnSync(cmd, {
        cwd,
        shell: true,
        encoding: 'utf-8',
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: env || process.env,
    });
    const timedOut = res.error ? (res.error.code === 'ETIMEDOUT' || res.signal === 'SIGTERM') : false;
    return {
        exitCode: typeof res.status === 'number' ? res.status : (timedOut ? 124 : 1),
        stdout: res.stdout || '',
        stderr: res.stderr || (res.error ? String(res.error.message) : ''),
        timedOut,
    };
}

module.exports = { DENY, isDenied, runCommand };
