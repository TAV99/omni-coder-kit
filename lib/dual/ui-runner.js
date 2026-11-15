'use strict';

// F17 phase 1: the daemon-owned headless runner behind createTrustedUiAdapter.
// It runs lib/dual/ui-runner-child.js under the macOS source-write fence with
// the run's private artifact directory as the only writable path, and returns
// the child's runtime result unchanged. Any failure is thrown, so
// evaluateAdaptiveVisualQa records an UNAVAILABLE verdict with its reason.

const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createWorkerWriteFence } = require('./worker-write-fence');
const { buildValidatorEnv } = require('./validator-security');

const CHILD = path.join(__dirname, 'ui-runner-child.js');
const RUN_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 256 * 1024;

function runnerError(message) { return Object.assign(new Error(message), { code: 'DUAL_UI_RUNNER_FAILED' }); }

function createPlaywrightUiRunner({ spawn = cp.spawn, env = process.env, timeoutMs = RUN_TIMEOUT_MS } = {}) {
    return async function runPlaywrightUi({ viewports, workspaceRoot, source_fingerprint: sourceFingerprint, artifactDir }) {
        if (!artifactDir) throw runnerError('UI runner needs an artifact directory');
        // One directory per run: an earlier run's attested screenshots are never overwritten.
        const runDir = path.join(artifactDir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
        fs.mkdirSync(runDir, { recursive: true });
        const fence = createWorkerWriteFence({ sourceRoot: workspaceRoot, workerRoot: runDir, spawn, env });
        const input = JSON.stringify({ workspaceRoot: fs.realpathSync.native(workspaceRoot), viewports, sourceFingerprint,
            artifactDir: fs.realpathSync.native(runDir) });
        const child = fence.spawn(process.execPath, [CHILD, input], {
            cwd: runDir, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
            env: buildValidatorEnv(env, { NODE_OPTIONS: '' }),
        });
        const result = await new Promise((resolve, reject) => {
            let stdout = '', stderr = '', settled = false;
            const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
            const timer = setTimeout(() => {
                try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
                finish(reject, runnerError(`UI runner timed out after ${Math.round(timeoutMs / 1000)} s`));
            }, timeoutMs);
            child.stdout.on('data', (chunk) => {
                stdout += chunk;
                if (stdout.length > MAX_STDOUT_BYTES) { try { child.kill('SIGKILL'); } catch {} finish(reject, runnerError('UI runner output exceeded its bound')); }
            });
            child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
            child.on('error', (error) => finish(reject, runnerError(`UI runner failed to start: ${error.message}`)));
            child.on('close', (code) => {
                const line = stdout.trim().split('\n').pop();
                try { finish(resolve, JSON.parse(line)); } catch {
                    finish(reject, runnerError(`UI runner exited ${code} without a result${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`));
                }
            });
        });
        if (result?.success !== true) throw runnerError(result?.reason || 'UI runner reported no result');
        return result;
    };
}

module.exports = { createPlaywrightUiRunner };
