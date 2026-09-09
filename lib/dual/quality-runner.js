'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveSetupInvocation } = require('./setup-runner');
const { createCliResolver } = require('./setup-command');

function resolveCommand(program) {
    if (process.platform !== 'win32') return program;
    return ({ npm: 'npm.cmd', npx: 'npx.cmd', pnpm: 'pnpm.cmd', yarn: 'yarn.cmd', bun: 'bun.cmd' })[program] || program;
}

function runBoundedCommand(spec, options = {}) {
    const {
        spawnSyncImpl = spawnSync,
        timeoutMs = 120000,
        cwd = process.cwd(),
        env = process.env,
        workspaceRoot = cwd,
    } = options;
    const args = Array.isArray(spec.args) ? spec.args : [];
    const started = Date.now();
    const command = `${spec.program} ${args.join(' ')}`.trim();
    let invocation = { command: resolveCommand(spec.program), args, cwd };
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(spec.program)) {
        try {
            const relativeCwd = path.relative(workspaceRoot, cwd).replace(/\\/g, '/') || '.';
            invocation = resolveSetupInvocation({ kind: 'package-manager', program: spec.program, args, cwd: relativeCwd }, {
                workspaceRoot, env, resolveExecutable: createCliResolver(workspaceRoot, { env }),
            });
        } catch (error) {
            return { command, exit_code: 1, duration_ms: Math.max(1, Date.now() - started), ok: false, failure: 'spawn-error', error: error.message || 'package manager resolution failed', output: '' };
        }
    }
    let result;
    try {
        result = spawnSyncImpl(invocation.command, invocation.args, { cwd: invocation.cwd || cwd, env, encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs });
    } catch (error) {
        return { command, exit_code: 1, duration_ms: Math.max(1, Date.now() - started), ok: false, failure: 'spawn-error', error: error.message || 'spawn failed', output: '' };
    }
    const output = `${result?.stdout || ''}${result?.stderr ? `\n${result.stderr}` : ''}`.slice(0, 16384);
    const status = Number.isSafeInteger(result?.status) ? result.status : null;
    const timedOut = Boolean(result?.error && (result.error.code === 'ETIMEDOUT' || /timed out/i.test(result.error.message || '')));
    const signaled = Boolean(result?.signal);
    const failedToSpawn = status === null && Boolean(result?.error);
    const failure = timedOut ? 'timeout' : signaled ? 'signal' : failedToSpawn ? 'spawn-error' : status === null ? 'unavailable' : status === 0 ? null : 'nonzero';
    return { command, exit_code: status === null ? 1 : status, duration_ms: Math.max(1, Date.now() - started), ok: status === 0 && !result?.error && !result?.signal, failure, signal: result?.signal || null, error: result?.error?.message || null, output };
}

function readPackage(workspaceRoot, fsImpl = fs) {
    const packagePath = path.join(workspaceRoot, 'package.json');
    if (!fsImpl.existsSync(packagePath)) return { packageJson: null, packagePath, scripts: {} };
    try {
        const packageJson = JSON.parse(fsImpl.readFileSync(packagePath, 'utf8'));
        return { packageJson, packagePath, scripts: packageJson?.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {} };
    } catch (error) {
        return { packageJson: null, packagePath, scripts: {}, error: error.message };
    }
}

function buildQualityPlan(workspaceRoot, fsImpl = fs, policy = {}) {
    const { packageJson, scripts, error } = readPackage(workspaceRoot, fsImpl);
    const manager = fsImpl.existsSync(path.join(workspaceRoot, 'pnpm-lock.yaml')) ? 'pnpm'
        : fsImpl.existsSync(path.join(workspaceRoot, 'yarn.lock')) ? 'yarn'
            : fsImpl.existsSync(path.join(workspaceRoot, 'bun.lockb')) ? 'bun' : 'npm';
    const audit = manager === 'npm' ? { id: 'p0-security', name: 'security audit', program: 'npm', args: ['audit', '--audit-level=high'], available: fsImpl.existsSync(path.join(workspaceRoot, 'package-lock.json')) || fsImpl.existsSync(path.join(workspaceRoot, 'npm-shrinkwrap.json')) }
        : { id: 'p0-security', name: 'security audit', program: manager, args: ['audit'], available: true };
    const scriptGate = (id, name, script) => ({ id, name, program: manager, args: ['run', script], script, available: Boolean(packageJson && scripts[script]) });
    const requestedScripts = Array.isArray(policy.requiredScripts) ? policy.requiredScripts : [];
    const scriptsToRun = [...new Set(['test', ...requestedScripts])].filter((script) => scripts[script] || requestedScripts.includes(script));
    const commands = [audit];
    for (const script of scriptsToRun) {
        const id = script === 'test' ? 'p3-tests' : `script-${script}`;
        commands.push(scriptGate(id, script, script));
    }
    return { manager, packageJson, error, commands };
}

function executeQualityPlan(plan, options = {}) {
    const workspaceRoot = options.workspaceRoot || options.cwd || process.cwd();
    return plan.commands.map((spec) => {
        if (!spec.available) {
            return { ...spec, command: `${spec.program} ${spec.args.join(' ')}`, exit_code: 1, duration_ms: 0, ok: false, failure: 'unavailable', error: `Required command is unavailable${spec.script ? `: npm script '${spec.script}'` : ''}`, output: '' };
        }
        return { ...spec, ...runBoundedCommand(spec, { ...options, workspaceRoot: options.workspaceRoot || workspaceRoot }) };
    });
}

function qualityGateResults(results) {
    return results.map((result) => ({
        id: result.id,
        required: true,
        status: result.ok ? 'PASSED' : result.failure === 'unavailable' ? 'UNAVAILABLE' : 'FAILED',
        reason: result.ok ? `${result.name} exited 0` : (result.error || `${result.name} failed (${result.failure || 'unknown'})`).slice(0, 256),
    }));
}

module.exports = { buildQualityPlan, executeQualityPlan, qualityGateResults, readPackage, resolveCommand, runBoundedCommand };
