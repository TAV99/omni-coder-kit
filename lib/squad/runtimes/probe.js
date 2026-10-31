'use strict';

// Shared probe spawn for adapters: bounded, shell-free, never throws.

const { spawnBoundedProcess } = require('./spawn-bounded');

async function runProbe(runtime, ctx, args) {
    const resolved = ctx.resolved;
    const command = resolved && resolved.found ? resolved.command : runtime.binary.name;
    const prefixArgs = resolved && resolved.found ? resolved.prefixArgs : [];
    try {
        return await spawnBoundedProcess(command, [...prefixArgs, ...args], {
            spawnImpl: ctx.spawnImpl,
            cwd: ctx.cwd,
            env: ctx.env,
            timeoutMs: ctx.timeoutMs,
            maxOutputBytes: ctx.maxOutputBytes,
        });
    } catch (error) {
        return { ok: false, code: null, stdout: '', stderr: '', error: String((error && error.message) || error) };
    }
}

function probeFailure(result, what) {
    if (result.timedOut || result.error_code === 'TIMEOUT') {
        return { ok: false, code: 'SQUAD_RUNTIME_PROBE_TIMEOUT', reason: `${what} timed out` };
    }
    const detail = String(result.stderr || result.error || `exit ${result.code}`).trim().split(/\r?\n/).slice(-3).join(' ');
    return { ok: false, code: 'SQUAD_RUNTIME_PROBE_FAILED', reason: `${what} failed: ${detail}`.slice(0, 400) };
}

module.exports = { runProbe, probeFailure };
