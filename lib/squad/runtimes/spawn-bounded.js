'use strict';

// Bounded probe spawn (SPEC-SQUAD-P1 §9): moved verbatim from
// lib/dual/capability-preflight.js so the squad runtime registry can probe CLIs
// without requiring lib/dual. capability-preflight re-exports it unchanged.

const { spawn } = require('node:child_process');
const { childEnv } = require('../acceptance-telemetry');

const RETRYABLE_PRESPAWN_RESOURCE_CODES = new Set(['EAGAIN', 'EMFILE', 'ENFILE']);
const PRESPAWN_RESOURCE_FAILURE = Symbol('dual-capability-preflight-prespawn-resource-failure');

function markPreSpawnResourceFailure(result, errorCode) {
    if (RETRYABLE_PRESPAWN_RESOURCE_CODES.has(errorCode)) {
        Object.defineProperty(result, PRESPAWN_RESOURCE_FAILURE, { value: errorCode });
    }
    return result;
}

function preSpawnResourceFailureCode(result) {
    const errorCode = result && result[PRESPAWN_RESOURCE_FAILURE];
    return RETRYABLE_PRESPAWN_RESOURCE_CODES.has(errorCode) ? errorCode : null;
}

function spawnBoundedProcess(command, args, options = {}) {
    const {
        spawnImpl = spawn,
        timeoutMs = 15_000,
        maxOutputBytes = 64 * 1024,
        cwd,
        env = process.env,
        signal,
        prespawnGuard,
    } = options;

    if (
        typeof command !== 'string' || !command.trim() ||
        !Array.isArray(args) || !args.every((arg) => typeof arg === 'string') ||
        !Number.isFinite(timeoutMs) || timeoutMs <= 0 ||
        !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0
    ) {
        return Promise.resolve({
            ok: false,
            error: 'INVALID_BOUNDED_PROCESS_OPTIONS: command, args, timeoutMs, or maxOutputBytes is invalid',
            error_code: 'INVALID_BOUNDED_PROCESS_OPTIONS',
            code: null,
            signal: null,
            stdout: '',
            stderr: '',
        });
    }

    if (prespawnGuard) {
        return Promise.resolve().then(() => prespawnGuard(Object.freeze({ phase: 'probe', cwd, env, signal })))
            .then(() => spawnBoundedProcess(command, args, { ...options, prespawnGuard: undefined }));
    }
    if (signal?.aborted) {
        return Promise.resolve({ ok: false, error: 'ABORTED: Process aborted before spawn',
            error_code: 'ABORTED', code: null, signal: null, stdout: '', stderr: '' });
    }

    return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        let termination = null;
        const abort = () => {
            termination = { ...termination, error: 'ABORTED: Process aborted', error_code: 'ABORTED', aborted: true };
            try { child.kill('SIGKILL'); } catch {}
        };

        function settle(result) {
            if (settled) return;
            settled = true;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            signal?.removeEventListener('abort', abort);
            resolve(result);
        }

        let child;
        try {
            child = spawnImpl(command, args, {
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                ...(cwd ? { cwd } : {}),
                env: childEnv(env), signal,
            });
        } catch (err) {
            return settle(markPreSpawnResourceFailure({
                ok: false,
                error: err.message,
                code: null,
                signal: null,
                stdout: '',
                stderr: '',
            }, err && err.code));
        }

        if (!child || typeof child.on !== 'function') {
            return settle({
                ok: false,
                error: 'Failed to spawn child process',
                code: null,
                signal: null,
                stdout: '',
                stderr: '',
            });
        }

        let stdout = '';
        let stderr = '';
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let spawned = false;

        child.on('spawn', () => {
            spawned = true;
        });

        if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
            timer = setTimeout(() => {
                if (signal) termination = { ...termination, error: `TIMEOUT: Process timed out after ${timeoutMs}ms`,
                    error_code: 'TIMEOUT', timedOut: true };
                try {
                    if (typeof child.kill === 'function') {
                        child.kill('SIGKILL');
                    }
                } catch {}
                if (signal) return;
                settle({
                    ok: false,
                    error: `TIMEOUT: Process timed out after ${timeoutMs}ms`,
                    error_code: 'TIMEOUT',
                    timedOut: true,
                    code: null,
                    signal: 'SIGKILL',
                    stdout,
                    stderr,
                });
            }, timeoutMs);
        }

        if (child.stdout && typeof child.stdout.on === 'function') {
            child.stdout.on('data', (chunk) => {
                if (settled || termination?.overflow) return;
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                stdoutBytes += buf.length;
                if (stdoutBytes > maxOutputBytes) {
                    try {
                        if (typeof child.kill === 'function') child.kill('SIGTERM');
                    } catch {}
                    const overflow = {
                        ok: false,
                        error: `STDOUT_OVERFLOW: stdout exceeded ${maxOutputBytes} bytes`,
                        overflow: true,
                        code: null,
                        signal: 'SIGTERM',
                        stdout: '',
                        stderr: '',
                    };
                    if (signal) {
                        stdout = ''; stderr = '';
                        termination = { error: overflow.error, overflow: true };
                        return;
                    }
                    return settle(overflow);
                }
                stdout += buf.toString('utf8');
            });
        }

        if (child.stderr && typeof child.stderr.on === 'function') {
            child.stderr.on('data', (chunk) => {
                if (settled || termination?.overflow) return;
                const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                stderrBytes += buf.length;
                if (stderrBytes > maxOutputBytes) {
                    try {
                        if (typeof child.kill === 'function') child.kill('SIGTERM');
                    } catch {}
                    const overflow = {
                        ok: false,
                        error: `STDERR_OVERFLOW: stderr exceeded ${maxOutputBytes} bytes`,
                        overflow: true,
                        code: null,
                        signal: 'SIGTERM',
                        stdout: '',
                        stderr: '',
                    };
                    if (signal) {
                        stdout = ''; stderr = '';
                        termination = { error: overflow.error, overflow: true };
                        return;
                    }
                    return settle(overflow);
                }
                stderr += buf.toString('utf8');
            });
        }

        child.on('error', (err) => {
            if (signal?.aborted && err?.name === 'AbortError') return;
            if (settled) return;
            const beforeSpawn = !spawned && child.pid === undefined;
            if (signal && !beforeSpawn) {
                termination = { ...termination, error: err.message };
                return;
            }
            settle(markPreSpawnResourceFailure({
                ok: false,
                error: err.message,
                code: null,
                signal: null,
                stdout,
                stderr,
            }, beforeSpawn ? err && err.code : null));
        });

        child.on('close', (code, signal) => {
            settle({
                ok: !termination && code === 0,
                code,
                signal,
                stdout,
                stderr,
                error: code === 0 ? null : (stderr || `Process exited with code ${code}`),
                ...termination,
            });
        });
        if (signal) {
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
        }
    });
}

module.exports = {
    RETRYABLE_PRESPAWN_RESOURCE_CODES,
    spawnBoundedProcess,
    preSpawnResourceFailureCode,
};
