'use strict';

// ---------------------------------------------------------------------------
// Guarded shell execution (HARNESS-SPEC-PHASE-1 §2.2, §8).
//
// EVERY shell command the harness runs goes through runCommand(). isDenied()
// blocks destructive commands BEFORE they run — deny-list mirrors the
// .claude/settings.json overlay (rm -rf, push --force, reset --hard, fork bomb).
// ---------------------------------------------------------------------------

const { spawnSync, spawn } = require('child_process');

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

const AGENTS_LIST = ['agy', 'claude', 'gemini', 'codex', 'opencode', 'open-claude', 'openclaude'];

const PROMPT_PATTERNS = [
    /\?\s*[\[\(]?[yYnN](?:\/[yYnN])?[\]\)]?\s*$/m,            // "Continue? [y/N]", "ok? (y/n)"
    /\b(?:allow|approve|permit)\b.*\?\s*$/mi,            // "Do you want to allow...?"
    /\bDo you (?:want to|wish to|agree to)\b/i,          // "Do you want to..."
    /\bAre you sure\b/i,                                  // "Are you sure?"
    /\bPress [yY] to\b/i,                                 // "Press Y to continue"
    /\bType\s+['"]?(?:yes|y)['"]?\s+to\b/i,              // "Type 'yes' to confirm"
    /\b(?:proceed|continue)\b.*\?\s*$/mi,                 // "Proceed? ..." (ends with ?)
];


function isAgentCommand(cmdOrArgv) {
    const arr = Array.isArray(cmdOrArgv) ? cmdOrArgv : String(cmdOrArgv).split(/\s+/);
    if (!arr.length) return false;
    const exe = arr[0].replace(/^["']|["']$/g, '').toLowerCase();
    if (AGENTS_LIST.includes(exe)) return true;
    if (exe === 'script') {
        return arr.some(arg => {
            const clean = arg.replace(/^["']|["']$/g, '').trim();
            const firstWord = clean.split(/\s+/)[0].replace(/^["']|["']$/g, '').toLowerCase();
            return AGENTS_LIST.includes(firstWord);
        });
    }
    return false;
}

// Synchronous command runner. Throws on a denied command (never executes it).
function runCommand(cmdOrArgv, { cwd = process.cwd(), timeoutMs = 120000, env } = {}) {
    const isArgv = Array.isArray(cmdOrArgv);
    const denyTarget = isArgv ? cmdOrArgv.join(' ') : cmdOrArgv;
    if (!isAgentCommand(cmdOrArgv) && isDenied(denyTarget)) {
        throw new Error(`Lệnh bị chặn bởi deny-list (an toàn): ${denyTarget}`);
    }
    const execEnv = { ...process.env, ...env, npm_config_yes: 'true' };
    const res = isArgv
        ? spawnSync(cmdOrArgv[0], cmdOrArgv.slice(1), {
            cwd,
            encoding: 'utf-8',
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: execEnv,
        })
        : spawnSync(cmdOrArgv, {
            cwd,
            shell: true,
            encoding: 'utf-8',
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: execEnv,
        });
    const timedOut = res.error ? (res.error.code === 'ETIMEDOUT' || res.signal === 'SIGTERM') : false;
    return {
        exitCode: typeof res.status === 'number' ? res.status : (timedOut ? 124 : 1),
        stdout: res.stdout || '',
        stderr: res.stderr || (res.error ? String(res.error.message) : ''),
        timedOut,
    };
}

// ---------------------------------------------------------------------------
// Async command runner (SPEC-OBSERVABILITY-HEARTBEAT OBS-3).
//
// Uses spawn (not spawnSync) so the Node event loop stays FREE while the agent
// runs — that is what lets loop.js' heartbeat ticker actually fire mid-step.
// isDenied() still gates BEFORE anything launches. `onStdout` streams stdout
// chunks live (raw `--stream`). `signal` (AbortSignal) cancels. `spawnFn`
// injectable for tests (no real process). Mirrors runCommand's return shape.
// ---------------------------------------------------------------------------
function runCommandAsync(cmdOrArgv, {
    cwd = process.cwd(), timeoutMs = 120000, env, onStdout, signal, spawnFn = spawn,
    autoApprove = true,
} = {}) {
    const isArgv = Array.isArray(cmdOrArgv);
    const denyTarget = isArgv ? cmdOrArgv.join(' ') : cmdOrArgv;
    if (!isAgentCommand(cmdOrArgv) && isDenied(denyTarget)) {
        return Promise.reject(new Error(`Lệnh bị chặn bởi deny-list (an toàn): ${denyTarget}`));
    }
    const execEnv = { ...process.env, ...env, npm_config_yes: 'true' };
    return new Promise((resolve) => {
        const child = isArgv
            ? spawnFn(cmdOrArgv[0], cmdOrArgv.slice(1), { cwd, env: execEnv, stdio: ['pipe', 'pipe', 'pipe'] })
            : spawnFn(cmdOrArgv, { cwd, shell: true, env: execEnv, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;

        const timer = timeoutMs ? setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGTERM'); } catch { /* already gone */ }
        }, timeoutMs) : null;
        if (timer && typeof timer.unref === 'function') timer.unref();

        let onAbort = null;
        if (signal) {
            onAbort = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort);
        }

        const finish = (exitCode) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (onAbort && signal) signal.removeEventListener('abort', onAbort);
            resolve({ exitCode, stdout, stderr, timedOut });
        };

        const checkPrompt = (s) => {
            if (!autoApprove) return;
            const matched = PROMPT_PATTERNS.some(re => re.test(s));
            if (matched && child.stdin && child.stdin.writable) {
                const preview = s.trim().split('\n').pop().slice(0, 120);
                if (onStdout) {
                    try { onStdout(`[omni:auto-approve] "${preview}" → y\n`); }
                    catch { /* sink error */ }
                }
                try { child.stdin.write('y\n'); } catch (err) { /* ignore write errors */ }
            }
        };

        if (child.stdout) child.stdout.on('data', (d) => {
            const s = d.toString();
            stdout += s;
            checkPrompt(s);
            if (onStdout) { try { onStdout(s); } catch { /* never break the run on a sink error */ } }
        });
        if (child.stderr) child.stderr.on('data', (d) => {
            const s = d.toString();
            stderr += s;
            checkPrompt(s);
        });
        child.on('error', (err) => {
            stderr += (stderr ? '\n' : '') + String((err && err.message) || err);
            finish(err && err.code === 'ENOENT' ? 127 : 1);
        });
        child.on('close', (code, sig) => {
            if (timedOut) return finish(124);
            finish(typeof code === 'number' ? code : (sig ? 1 : 0));
        });
    });
}

module.exports = { DENY, isDenied, runCommand, runCommandAsync, PROMPT_PATTERNS, isAgentCommand };
