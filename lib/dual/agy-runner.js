'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');

class DualAgyRunnerError extends Error {
    constructor(code, message, options = {}) {
        super(message, options);
        this.name = 'DualAgyRunnerError';
        this.code = code;
    }
}

function relativeReference(repoRoot, target, label) {
    const relative = path.relative(repoRoot, target);
    if (
        relative.length === 0
        || relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
    ) {
        throw new DualAgyRunnerError('DUAL_AGY_INPUT_SCOPE', `${label} must be inside the repository`);
    }
    return relative.split(path.sep).join('/');
}

function buildAgyInvocation({
    agyCommand = 'agy',
    agyPrefixArgs = [],
    prefixArgs,
    repoRoot,
    phase,
    inputPath,
    schemaPath,
    timeoutMs,
    retryHint,
    model,
    effort,
}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new DualAgyRunnerError('DUAL_AGY_TIMEOUT_INVALID', 'Agy timeout must be positive');
    }
    const inputReference = relativeReference(repoRoot, inputPath, 'Input path');
    relativeReference(repoRoot, schemaPath, 'Schema path');
    const resolvedPrefixArgs = prefixArgs === undefined ? agyPrefixArgs : prefixArgs;
    const projectFlagIndex = resolvedPrefixArgs.indexOf('--project');
    const reusesRegisteredProject = projectFlagIndex >= 0
        && typeof resolvedPrefixArgs[projectFlagIndex + 1] === 'string'
        && resolvedPrefixArgs[projectFlagIndex + 1].length > 0;
    const mode = phase === 'implement' ? 'accept-edits' : 'plan';
    if (
        retryHint !== undefined
        && (typeof retryHint !== 'string'
            || retryHint.length === 0
            || retryHint.length > 256
            || /[\r\n\u0000-\u001f\u007f]/u.test(retryHint))
    ) {
        throw new DualAgyRunnerError(
            'DUAL_AGY_RETRY_HINT_INVALID',
            'Agy retry hint must be a single bounded line of at most 256 characters',
        );
    }
    const printTimeoutMinutes = Math.max(1, Math.floor((timeoutMs - 30_000) / 60_000));
    const prompt = [
        `Read ${inputReference} and complete only the ${phase} phase. Return the required JSON contract.`,
        retryHint ? `Retry correction: ${retryHint}` : null,
    ].filter(Boolean).join(' ');
    const workerModel = (typeof model === 'string' && model.trim()) ? model.trim() : 'gemini-3.7-flash-high';
    const workerEffort = (typeof effort === 'string' && effort.trim()) ? effort.trim() : 'high';
    const args = [
        ...resolvedPrefixArgs,
        ...(reusesRegisteredProject ? [] : ['--new-project', '--add-dir', repoRoot]),
        '--model', workerModel,
        '--effort', workerEffort,
        '--mode', mode,
        '--dangerously-skip-permissions',
        '--print-timeout', `${printTimeoutMinutes}m`,
        '--output-format', 'json',
        '--json-schema', schemaPath,
        `-p=${prompt}`,
    ];

    return {
        command: agyCommand,
        args,
        cwd: repoRoot,
        timeoutMs,
        redactedArgs: [...args],
    };
}

function waitForClose(child) {
    return new Promise((resolve) => {
        if (child.exitCode !== null && child.exitCode !== undefined) {
            resolve(child.exitCode);
            return;
        }
        child.once('close', resolve);
        child.once('error', () => resolve(null));
    });
}

async function terminateProcessTree(child, deps = {}) {
    if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return;
    const platform = deps.platform || process.platform;
    if (platform === 'win32') {
        const spawnHelper = deps.spawnHelper || childProcess.spawn;
        const helper = spawnHelper(
            'taskkill.exe',
            ['/PID', String(child.pid), '/T', '/F'],
            { shell: false, windowsHide: true, stdio: 'ignore' },
        );
        await waitForClose(helper);
        return;
    }

    const processKill = deps.processKill || process.kill;
    const delay = deps.delay || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const graceMs = deps.terminationGraceMs ?? 500;
    try {
        processKill(-child.pid, 'SIGTERM');
    } catch (error) {
        if (!error || error.code !== 'ESRCH') throw error;
        return;
    }
    await delay(graceMs);
    if (child.exitCode === null || child.exitCode === undefined) {
        try {
            processKill(-child.pid, 'SIGKILL');
        } catch (error) {
            if (!error || error.code !== 'ESRCH') throw error;
        }
    }
}

function runProcess(invocation, deps = {}) {
    const spawn = deps.spawn || childProcess.spawn;
    const now = deps.now || (() => new Date());
    const startedAt = now();

    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(invocation.command, [...invocation.args], {
                cwd: invocation.cwd,
                shell: false,
                windowsHide: true,
                detached: (deps.platform || process.platform) !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe'],
                env: deps.env || process.env,
            });
        } catch (cause) {
            reject(new DualAgyRunnerError('DUAL_AGY_SPAWN', 'Unable to start Agy', { cause }));
            return;
        }

        const stdout = [];
        const stderr = [];
        let timedOut = false;
        let settled = false;
        let terminationError = null;

        child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));

        const timer = setTimeout(async () => {
            timedOut = true;
            try {
                await terminateProcessTree(child, deps);
            } catch (error) {
                terminationError = error;
                try {
                    child.kill('SIGKILL');
                } catch {
                    // The child may already have exited between termination attempts.
                }
            }
        }, invocation.timeoutMs);

        child.once('error', (cause) => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            reject(new DualAgyRunnerError('DUAL_AGY_SPAWN', 'Agy process failed to start', { cause }));
        });

        child.once('close', (exitCode) => {
            clearTimeout(timer);
            if (settled) return;
            settled = true;
            const endedAt = now();
            const result = {
                exitCode,
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
                timedOut,
                startedAt,
                endedAt,
                durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
            };
            if (terminationError) {
                result.terminationError = terminationError;
            }
            resolve(result);
        });
    });
}

module.exports = {
    DualAgyRunnerError,
    buildAgyInvocation,
    terminateProcessTree,
    runProcess,
};
