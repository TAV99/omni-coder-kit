'use strict';

// Shared probe spawn for adapters: bounded, shell-free; throws only when the
// caller's prespawnGuard refuses the spawn.

const { spawnBoundedProcess } = require('./spawn-bounded');

async function runProbe(runtime, ctx, args) {
    const resolved = ctx.resolved;
    const command = resolved && resolved.found ? resolved.command : runtime.binary.name;
    const prefixArgs = resolved && resolved.found ? resolved.prefixArgs : [];
    // A guard refusal is the caller's decision, not a probe failure: let it throw.
    if (ctx.prespawnGuard) await ctx.prespawnGuard(Object.freeze({ phase: 'probe', cwd: ctx.cwd, env: ctx.env }));
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

// `raw` keeps the spawn result (resource error symbols included) so legacy
// callers can keep their own retry classification (SPEC-SQUAD-P3 §4.3).
function probeFailure(result, what) {
    if (result.timedOut || result.error_code === 'TIMEOUT') {
        return { ok: false, code: 'SQUAD_RUNTIME_PROBE_TIMEOUT', reason: `${what} timed out`, raw: result };
    }
    const detail = String(result.stderr || result.error || `exit ${result.code}`).trim().split(/\r?\n/).slice(-3).join(' ');
    return { ok: false, code: 'SQUAD_RUNTIME_PROBE_FAILED', reason: `${what} failed: ${detail}`.slice(0, 400), raw: result };
}

module.exports = { runProbe, probeFailure };
