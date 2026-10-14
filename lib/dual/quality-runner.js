'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
    QualityEvidenceSchema,
    QualityExecutionArtifactSchema,
    parseContract,
} = require('./contracts');
const { resolveSetupInvocation, defaultResolveExecutable } = require('./setup-runner');
const { createCliResolver } = require('./setup-command');
const { buildValidatorEnv, redactArgv, redactDiagnostic } = require('./validator-security');
const { runOwnedValidator, createOwnedResultProofReader } = require('./validator-process');
const { createValidatorLifecycleWriter } = require('./validator-lifecycle-writer');

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_QUALITY_ARTIFACT_BYTES = 1024 * 1024;
const MAX_QUALITY_COMMANDS = 50;
const trustedCommandDigests = new WeakMap();

class DualQualityArtifactError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'DualQualityArtifactError';
        this.code = code;
    }
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function rememberTrustedCommandDigests(result, stdout, stderr, output) {
    trustedCommandDigests.set(result, {
        stdout_sha256: sha256(stdout),
        stderr_sha256: sha256(stderr),
        output_sha256: sha256(output),
        visibleStdout: String(result.stdout || ''),
        visibleStderr: String(result.stderr || ''),
        visibleOutput: String(result.output || ''),
    });
    return result;
}

function getTrustedCommandDigests(result) {
    if (!result || typeof result !== 'object') return null;
    const digests = trustedCommandDigests.get(result);
    if (!digests
        || String(result.stdout || '') !== digests.visibleStdout
        || String(result.stderr || '') !== digests.visibleStderr
        || String(result.output || '') !== digests.visibleOutput) return null;
    return digests;
}

function transferTrustedCommandDigests(source, target) {
    const digests = getTrustedCommandDigests(source);
    if (digests) trustedCommandDigests.set(target, digests);
    return target;
}

function qualityResultDigests(result, options = {}) {
    if (options.trustPersistedDigests) {
        return {
            stdout_sha256: result.stdout_sha256,
            stderr_sha256: result.stderr_sha256,
            output_sha256: result.output_sha256,
        };
    }
    const trusted = getTrustedCommandDigests(result);
    if (trusted) {
        return {
            stdout_sha256: trusted.stdout_sha256,
            stderr_sha256: trusted.stderr_sha256,
            output_sha256: trusted.output_sha256,
        };
    }

    const stdout = String(result.stdout || '');
    const stderr = String(result.stderr || '');
    const fallbackOutput = String(result.output || '');
    return {
        stdout_sha256: sha256(stdout || (stderr ? '' : fallbackOutput)),
        stderr_sha256: sha256(stderr),
        output_sha256: sha256(canonicalOutput(result)),
    };
}

const redactSecrets = redactDiagnostic;

function commandResult(command, startedMs, fields = {}, nowImpl = Date.now) {
    const endedMs = nowImpl();
    const stdout = String(fields.stdout || '');
    const stderr = String(fields.stderr || '');
    const combined = `${stdout}${stderr ? `\n${stderr}` : ''}`;
    return rememberTrustedCommandDigests({
        command: redactDiagnostic(command, { maxLength: 4096 }),
        exit_code: fields.exit_code,
        duration_ms: Math.max(1, endedMs - startedMs),
        ok: fields.ok,
        failure: fields.failure || null,
        signal: fields.signal || null,
        error: fields.error ? redactDiagnostic(fields.error, { maxLength: 4096 }) : null,
        started_at: new Date(startedMs).toISOString(),
        ended_at: new Date(endedMs).toISOString(),
        stdout_sha256: sha256(stdout),
        stderr_sha256: sha256(stderr),
        output_sha256: sha256(combined),
        stdout: redactDiagnostic(stdout),
        stderr: redactDiagnostic(stderr),
        output: redactDiagnostic(combined),
    }, stdout, stderr, combined);
}

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
        nowImpl = Date.now,
    } = options;
    const args = Array.isArray(spec.args) ? spec.args : [];
    const validatorEnv = buildValidatorEnv(env);
    const started = nowImpl();
    const command = `${spec.program} ${redactArgv(args).join(' ')}`.trim();
    let invocation = { command: resolveCommand(spec.program), args, cwd };
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(spec.program)) {
        try {
            const relativeCwd = path.relative(workspaceRoot, cwd).replace(/\\/g, '/') || '.';
            invocation = resolveSetupInvocation({ kind: 'package-manager', program: spec.program, args, cwd: relativeCwd }, {
                workspaceRoot, env: validatorEnv, resolveExecutable: createCliResolver(workspaceRoot, { env: validatorEnv }),
            });
        } catch (error) {
            return commandResult(command, started, {
                exit_code: 1,
                ok: false,
                failure: 'spawn-error',
                error: error.message || 'package manager resolution failed',
            }, nowImpl);
        }
    }
    let result;
    try {
        result = spawnSyncImpl(invocation.command, invocation.args, { cwd: invocation.cwd || cwd, env: validatorEnv, encoding: 'utf8', shell: false, windowsHide: true, timeout: timeoutMs });
    } catch (error) {
        return commandResult(command, started, {
            exit_code: 1,
            ok: false,
            failure: 'spawn-error',
            error: error.message || 'spawn failed',
        }, nowImpl);
    }
    const status = Number.isSafeInteger(result?.status) ? result.status : null;
    const timedOut = Boolean(result?.error && (result.error.code === 'ETIMEDOUT' || /timed out/i.test(result.error.message || '')));
    const signaled = Boolean(result?.signal);
    const failedToSpawn = status === null && Boolean(result?.error);
    const failure = timedOut ? 'timeout' : signaled ? 'signal' : failedToSpawn ? 'spawn-error' : status === null ? 'unavailable' : status === 0 ? null : 'nonzero';
    return commandResult(command, started, {
        exit_code: status === null ? 1 : status,
        ok: status === 0 && !result?.error && !result?.signal,
        failure,
        signal: result?.signal || null,
        error: result?.error?.message || null,
        stdout: result?.stdout || '',
        stderr: result?.stderr || '',
    }, nowImpl);
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
    const seenRegistered = new Set();
    for (const command of Array.isArray(policy.validationCommands) ? policy.validationCommands : []) {
        if (!command || typeof command !== 'object' || Array.isArray(command)
            || typeof command.program !== 'string' || !Array.isArray(command.args)
            || typeof command.cwd !== 'string') continue;
        const identity = JSON.stringify({ program: command.program, args: command.args, cwd: command.cwd });
        if (seenRegistered.has(identity)) continue;
        seenRegistered.add(identity);
        const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
        let available = true;
        if (['npm', 'pnpm', 'yarn', 'bun'].includes(command.program)) {
            const script = command.args[0] === 'run' && typeof command.args[1] === 'string'
                ? command.args[1]
                : (command.args[0] === 'test' ? 'test' : null);
            if (script) available = Boolean(packageJson && scripts[script]);
        }
        commands.push({
            id: `registered-${digest}`,
            name: `registered ${command.program} ${command.args.join(' ')}`.trim(),
            program: command.program,
            args: [...command.args],
            cwd: command.cwd,
            available,
            source: 'registered',
        });
    }
    const canonicalCommands = [];
    const seenCommands = new Set();
    for (const command of commands) {
        const normalized = { ...command, cwd: command.cwd || '.' };
        const identity = JSON.stringify({ program: normalized.program, args: normalized.args, cwd: normalized.cwd });
        if (seenCommands.has(identity)) continue;
        seenCommands.add(identity);
        canonicalCommands.push(normalized);
    }
    if (canonicalCommands.length > MAX_QUALITY_COMMANDS) {
        throw new DualQualityArtifactError(
            'DUAL_QUALITY_PLAN_OVERFLOW',
            `Quality plan has ${canonicalCommands.length} canonical commands exceeds maximum ${MAX_QUALITY_COMMANDS}`
        );
    }
    return { manager, packageJson, error, commands: canonicalCommands };
}

function executeQualityPlan(plan, options = {}) {
    const workspaceRoot = options.workspaceRoot || options.cwd || process.cwd();
    return plan.commands.map((spec) => {
        if (!spec.available) {
            const started = (options.nowImpl || Date.now)();
            const diagnostics = commandResult(`${spec.program} ${spec.args.join(' ')}`, started, {
                exit_code: 1,
                ok: false,
                failure: 'unavailable',
                error: `Required command is unavailable${spec.script ? `: npm script '${spec.script}'` : ''}`,
            }, options.nowImpl || Date.now);
            return transferTrustedCommandDigests(diagnostics, {
                ...spec,
                args: redactArgv(spec.args),
                name: redactDiagnostic(spec.name, { maxLength: 256 }),
                ...diagnostics,
            });
        }
        const commandCwd = path.resolve(workspaceRoot, spec.cwd || '.');
        const diagnostics = runBoundedCommand(spec, { ...options, cwd: commandCwd, workspaceRoot });
        return transferTrustedCommandDigests(diagnostics, {
            ...spec,
            args: redactArgv(spec.args),
            name: redactDiagnostic(spec.name, { maxLength: 256 }),
            ...diagnostics,
        });
    });
}

async function runBoundedCommandAsync(spec, options = {}) {
    const {
        timeoutMs = 120000,
        cwd = process.cwd(),
        env = process.env,
        workspaceRoot = cwd,
        nowImpl = Date.now,
        commandIndex = 0,
        runId = crypto.randomUUID(),
        purpose = 'quality',
    } = options;
    const args = Array.isArray(spec.args) ? spec.args : [];
    const validatorEnv = buildValidatorEnv(env);
    const started = nowImpl();
    const command = `${spec.program} ${redactArgv(args).join(' ')}`.trim();
    let invocation = null;
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(spec.program)) {
        try {
            const relativeCwd = path.relative(workspaceRoot, cwd).replace(/\\/g, '/') || '.';
            invocation = resolveSetupInvocation({ kind: 'package-manager', program: spec.program, args, cwd: relativeCwd }, {
                workspaceRoot, env: validatorEnv, resolveExecutable: createCliResolver(workspaceRoot, { env: validatorEnv }),
            });
        } catch (error) {
            return commandResult(command, started, {
                exit_code: 1,
                ok: false,
                failure: 'spawn-error',
                error: error.message || 'package manager resolution failed',
            }, nowImpl);
        }
    } else if (spec.program === 'node') {
        invocation = {
            command: process.execPath,
            args,
            cwd,
        };
    } else {
        const resolved = defaultResolveExecutable(spec.program, { platform: process.platform, cwd, kind: 'native', env: validatorEnv });
        if (resolved && resolved.path) {
            invocation = {
                command: resolved.path,
                args,
                cwd,
            };
        } else if (path.isAbsolute(spec.program) && fs.existsSync(spec.program)) {
            invocation = {
                command: spec.program,
                args,
                cwd,
            };
        } else {
            return commandResult(command, started, {
                exit_code: 1,
                ok: false,
                failure: 'spawn-error',
                error: `Program not found: ${spec.program}`,
            }, nowImpl);
        }
    }

    try {
        const owned = await runOwnedValidator({
            program: invocation.command,
            args: invocation.args,
            cwd: invocation.cwd || cwd,
            commandIndex,
            runId,
            purpose,
            env: validatorEnv,
        }, { timeoutMs });

        const readProof = createOwnedResultProofReader();
        const proof = readProof(owned);
        const exitCode = owned.exitCode;
        const timedOut = owned.failure === 'TIMED_OUT' || owned.cancellationCode === 'deadline';
        const failure = timedOut ? 'timeout' : (exitCode !== 0 ? 'nonzero' : (owned.failure ? 'spawn-error' : null));
        const ok = exitCode === 0 && !failure;
        const stdout = owned.stdoutSummary || '';
        const stderr = owned.stderrSummary || '';

        const diagnostics = commandResult(command, started, {
            exit_code: exitCode ?? (timedOut ? 124 : 1),
            ok,
            failure,
            error: failure ? (timedOut ? 'command timed out' : `command exited ${exitCode}`) : null,
            stdout,
            stderr,
        }, nowImpl);

        diagnostics._ownedResult = owned;
        diagnostics._proof = proof;
        return diagnostics;
    } catch (error) {
        return commandResult(command, started, {
            exit_code: 1,
            ok: false,
            failure: 'spawn-error',
            error: error.message || 'owned validator spawn failed',
        }, nowImpl);
    }
}

async function executeQualityPlanAsync(plan, options = {}) {
    const workspaceRoot = options.workspaceRoot || options.cwd || process.cwd();
    const results = [];
    for (let index = 0; index < plan.commands.length; index++) {
        const spec = plan.commands[index];
        if (!spec.available) {
            const started = (options.nowImpl || Date.now)();
            const diagnostics = commandResult(`${spec.program} ${spec.args.join(' ')}`, started, {
                exit_code: 1,
                ok: false,
                failure: 'unavailable',
                error: `Required command is unavailable${spec.script ? `: npm script '${spec.script}'` : ''}`,
            }, options.nowImpl || Date.now);
            results.push(transferTrustedCommandDigests(diagnostics, {
                ...spec,
                args: redactArgv(spec.args),
                name: redactDiagnostic(spec.name, { maxLength: 256 }),
                ...diagnostics,
            }));
            continue;
        }
        const commandCwd = path.resolve(workspaceRoot, spec.cwd || '.');
        const diagnostics = await runBoundedCommandAsync(spec, {
            ...options,
            cwd: commandCwd,
            workspaceRoot,
            commandIndex: index,
        });
        results.push(transferTrustedCommandDigests(diagnostics, {
            ...spec,
            args: redactArgv(spec.args),
            name: redactDiagnostic(spec.name, { maxLength: 256 }),
            ...diagnostics,
        }));
    }
    return results;
}

function qualityGateResults(results) {
    return results.map((result) => ({
        id: result.id,
        required: true,
        status: result.ok ? 'PASSED' : result.failure === 'unavailable' ? 'UNAVAILABLE' : 'FAILED',
        reason: redactDiagnostic(
            result.ok ? `${result.name} exited 0` : (result.error || `${result.name} failed (${result.failure || 'unknown'})`),
            { maxLength: 256 }
        ),
    }));
}

function canonicalOutput(result) {
    const stdout = String(result.stdout || '');
    const stderr = String(result.stderr || '');
    return (stdout || stderr)
        ? `${stdout}${stderr ? `\n${stderr}` : ''}`
        : String(result.output || '');
}

function qualityOutcomeIdentity(results, gates, options = {}) {
    return {
        commands: results.map((result) => {
            const digests = qualityResultDigests(result, options);
            return {
                id: result.id,
                program: result.program,
                args: redactArgv(result.args),
                cwd: result.cwd || '.',
                exit_code: result.exit_code,
                failure: result.failure || null,
                signal: result.signal || null,
                stdout_sha256: digests.stdout_sha256,
                stderr_sha256: digests.stderr_sha256,
                output_sha256: digests.output_sha256,
            };
        }),
        gates: gates.map((gate) => ({
            id: gate.id,
            required: gate.required,
            status: gate.status,
        })),
    };
}

function readIdentityFile(workspaceRoot, relativePath, fsImpl = fs) {
    const target = path.join(workspaceRoot, relativePath);
    if (!fsImpl.existsSync(target)) return null;
    const stat = fsImpl.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new DualQualityArtifactError('DUAL_QUALITY_DEPENDENCY_IDENTITY', `${relativePath} must be a regular file`);
    }
    return sha256(fsImpl.readFileSync(target));
}

function buildDependencyIdentity(workspaceRoot, fsImpl = fs) {
    const packageJsonSha256 = readIdentityFile(workspaceRoot, 'package.json', fsImpl);
    const lockfiles = [];
    for (const relativePath of ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb']) {
        const digest = readIdentityFile(workspaceRoot, relativePath, fsImpl);
        if (digest) lockfiles.push({ path: relativePath, sha256: digest });
    }
    return { package_json_sha256: packageJsonSha256, lockfiles };
}

function deriveQualityExecutionId(input, options = {}) {
    const fsImpl = options.fsImpl || fs;
    const commandPlan = (input.commandPlan || []).map(({ program, args, cwd }) => ({
        program,
        args: [...args],
        cwd: cwd || '.',
    }));
    const identity = {
        schema_version: 1,
        session_id: input.sessionId,
        workspace_id: input.workspaceId,
        baseline: input.baseline,
        plan_revision: input.planRevision,
        policy_sha256: input.policySha256,
        diff_fingerprint: input.diffFingerprint,
        cycle_index: input.cycleIndex,
        attempt: input.attempt,
        total_tasks: input.totalTasks,
        completed_task_ids: [...input.completedTaskIds],
        commands: commandPlan,
        dependencies: buildDependencyIdentity(input.workspaceRoot, fsImpl),
        runner: {
            implementation: 'omni-dual-quality-runner',
            implementation_version: 1,
            node_version: options.nodeVersion || process.version,
            platform: options.platform || process.platform,
            arch: options.arch || process.arch,
        },
    };
    return sha256(JSON.stringify(identity));
}

function buildQualityExecutionArtifact(input, options = {}) {
    const fsImpl = options.fsImpl || fs;
    const packageInfo = readPackage(input.workspaceRoot, fsImpl);
    const startedMs = Date.parse(input.startedAt);
    const endedMs = Date.parse(input.endedAt);
    const commands = input.results.map((result) => {
        const stdout = String(result.stdout || '');
        const stderr = String(result.stderr || '');
        const fallbackOutput = String(result.output || '');
        const combined = (stdout || stderr) ? `${stdout}${stderr ? `\n${stderr}` : ''}` : fallbackOutput;
        const digests = qualityResultDigests(result);
        const safeArgs = redactArgv(result.args);
        return {
            id: result.id,
            name: result.name,
            program: result.program,
            args: safeArgs,
            cwd: result.cwd || '.',
            command: redactSecrets(`${result.program} ${safeArgs.join(' ')}`.trim()),
            exit_code: result.exit_code,
            duration_ms: result.duration_ms,
            started_at: result.started_at || input.startedAt,
            ended_at: result.ended_at || input.endedAt,
            failure: result.failure || null,
            signal: result.signal || null,
            stdout_sha256: digests.stdout_sha256,
            stderr_sha256: digests.stderr_sha256,
            output_sha256: digests.output_sha256,
            output_summary: redactDiagnostic(fallbackOutput || combined, { maxLength: 4096 }),
        };
    });
    const artifact = {
        schema_version: 1,
        kind: 'dual.quality.execution',
        origin: 'omni-dual-quality-runner',
        session_id: input.sessionId,
        workspace_id: input.workspaceId,
        baseline: input.baseline,
        plan_revision: input.planRevision,
        policy_sha256: input.policySha256,
        diff_fingerprint: input.diffFingerprint,
        cycle_index: input.cycleIndex,
        attempt: input.attempt,
        execution_id: input.executionId,
        total_tasks: input.totalTasks || input.completedTaskIds.length,
        completed_task_ids: [...input.completedTaskIds],
        started_at: input.startedAt,
        ended_at: input.endedAt,
        duration_ms: Math.max(0, endedMs - startedMs),
        runner: {
            implementation: 'omni-dual-quality-runner',
            implementation_version: 1,
            node_version: options.nodeVersion || process.version,
            platform: options.platform || process.platform,
            arch: options.arch || process.arch,
            kit_version: typeof packageInfo.packageJson?.version === 'string' ? packageInfo.packageJson.version : null,
        },
        dependencies: buildDependencyIdentity(input.workspaceRoot, fsImpl),
        commands,
        gate_results: input.gateResults.map((gate) => ({ ...gate })),
    };
    try {
        return parseContract(QualityExecutionArtifactSchema, artifact, 'quality_execution_artifact');
    } catch (error) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_INVALID', error.message);
    }
}

function qualityArtifactRelativePath(executionId) {
    if (!SHA256_PATTERN.test(executionId || '')) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_INVALID', 'executionId must be a lowercase SHA-256 digest');
    }
    return `quality/${executionId}.json`;
}

function readQualityExecutionArtifact(input) {
    const fsImpl = input.fsImpl || fs;
    const relativePath = qualityArtifactRelativePath(input.executionId);
    let authorityRoot;
    try {
        authorityRoot = fsImpl.realpathSync?.native
            ? fsImpl.realpathSync.native(input.authorityDir)
            : fsImpl.realpathSync(input.authorityDir);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_MISSING', `Quality authority directory is unavailable: ${error.message}`);
        }
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_PATH', `Quality authority directory cannot be resolved: ${error.message}`);
    }
    const qualityDir = path.join(authorityRoot, 'quality');
    let qualityDirStat;
    try {
        qualityDirStat = fsImpl.lstatSync(qualityDir);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_MISSING', `Quality artifact is missing for execution ${input.executionId}`);
        }
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_PATH', `Quality artifact directory cannot be inspected: ${error.message}`);
    }
    if (!qualityDirStat.isDirectory() || qualityDirStat.isSymbolicLink()) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_PATH', 'Quality artifact directory must be a real directory');
    }
    let canonicalQualityDir;
    try {
        canonicalQualityDir = fsImpl.realpathSync?.native
            ? fsImpl.realpathSync.native(qualityDir)
            : fsImpl.realpathSync(qualityDir);
    } catch (error) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_PATH', `Quality artifact directory cannot be resolved: ${error.message}`);
    }
    const qualityRelative = path.relative(authorityRoot, canonicalQualityDir);
    if (qualityRelative.startsWith(`..${path.sep}`) || qualityRelative === '..' || path.isAbsolute(qualityRelative)) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_PATH', 'Quality artifact directory escapes the authority directory');
    }
    const target = path.join(canonicalQualityDir, path.basename(relativePath));
    let stat;
    try {
        stat = fsImpl.lstatSync(target);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_MISSING', `Quality artifact is missing for execution ${input.executionId}`);
        }
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_INVALID', `Quality artifact cannot be inspected: ${error.message}`);
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_QUALITY_ARTIFACT_BYTES) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_INVALID', 'Quality artifact must be a bounded regular file');
    }
    let canonicalTarget;
    try {
        canonicalTarget = fsImpl.realpathSync?.native
            ? fsImpl.realpathSync.native(target)
            : fsImpl.realpathSync(target);
    } catch (error) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_INVALID', `Quality artifact cannot be resolved: ${error.message}`);
    }
    const relative = path.relative(authorityRoot, canonicalTarget);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_PATH', 'Quality artifact escapes the authority directory');
    }
    let bytes;
    try {
        bytes = fsImpl.readFileSync(canonicalTarget);
    } catch (error) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_INVALID', `Quality artifact cannot be read: ${error.message}`);
    }
    const digest = sha256(bytes);
    let artifact;
    try {
        artifact = parseContract(QualityExecutionArtifactSchema, JSON.parse(bytes.toString('utf8')), 'quality_execution_artifact');
    } catch (error) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_INVALID', error.message);
    }
    if (artifact.execution_id !== input.executionId) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_BINDING', 'Quality artifact execution_id does not match its path');
    }
    return { path: canonicalTarget, relative_path: relativePath, sha256: digest, artifact };
}

function flushQualityDirectories(fsImpl, directories) {
    for (const directory of directories) {
        const fd = fsImpl.openSync(directory, 'r');
        try {
            fsImpl.fsyncSync(fd);
        } catch (error) {
            // Node permits opening directories on this Windows host, but fsync
            // reports EPERM. File contents remain fsynced; Windows replay is
            // protected across process restarts, without a universal power-loss
            // guarantee for directory entries.
            if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
        } finally {
            fsImpl.closeSync(fd);
        }
    }
}

function persistQualityExecutionArtifact(input, options = {}) {
    const fsImpl = options.fsImpl || fs;
    const artifact = buildQualityExecutionArtifact(input, options);
    const relativePath = qualityArtifactRelativePath(artifact.execution_id);
    const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    if (bytes.length > MAX_QUALITY_ARTIFACT_BYTES) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_INVALID', 'Quality execution artifact exceeds 1 MiB');
    }
    const digest = sha256(bytes);
    try {
        fsImpl.mkdirSync(input.authorityDir, { recursive: true });
    } catch (error) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_PATH', `Quality authority directory cannot be created: ${error.message}`);
    }
    let authorityRoot;
    try {
        authorityRoot = fsImpl.realpathSync?.native
            ? fsImpl.realpathSync.native(input.authorityDir)
            : fsImpl.realpathSync(input.authorityDir);
    } catch (error) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_PATH', `Quality authority directory cannot be resolved: ${error.message}`);
    }
    const qualityDir = path.join(authorityRoot, 'quality');
    try {
        fsImpl.mkdirSync(qualityDir, { recursive: true });
    } catch (error) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_PATH', `Quality artifact directory cannot be created: ${error.message}`);
    }
    let qualityStat;
    try {
        qualityStat = fsImpl.lstatSync(qualityDir);
    } catch (error) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_PATH', `Quality artifact directory cannot be inspected: ${error.message}`);
    }
    if (!qualityStat.isDirectory() || qualityStat.isSymbolicLink()) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_PATH', 'Quality artifact directory must be a real directory');
    }
    const canonicalQualityDir = fsImpl.realpathSync?.native
        ? fsImpl.realpathSync.native(qualityDir)
        : fsImpl.realpathSync(qualityDir);
    const qualityRelative = path.relative(authorityRoot, canonicalQualityDir);
    if (qualityRelative.startsWith(`..${path.sep}`) || qualityRelative === '..' || path.isAbsolute(qualityRelative)) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_PATH', 'Quality artifact directory escapes the authority directory');
    }
    const target = path.join(canonicalQualityDir, path.basename(relativePath));
    try {
        fsImpl.lstatSync(target);
        const stat = fsImpl.lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_QUALITY_ARTIFACT_BYTES) {
            throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_INVALID', 'Existing quality artifact is not a bounded regular file');
        }
        const existing = fsImpl.readFileSync(target);
        if (sha256(existing) !== digest) {
            throw new DualQualityArtifactError('DUAL_QUALITY_EXECUTION_CONFLICT', `Execution ${artifact.execution_id} already has different artifact bytes`);
        }
        return { path: target, relative_path: relativePath, sha256: digest, artifact, idempotent: true };
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
    let fd;
    try {
        fd = fsImpl.openSync(target, 'wx');
        let offset = 0;
        while (offset < bytes.length) {
            const written = fsImpl.writeSync(fd, bytes, offset, bytes.length - offset, null);
            if (typeof written !== 'number' || written <= 0) {
                throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_INVALID', 'Quality artifact write failed');
            }
            offset += written;
        }
        fsImpl.fsyncSync(fd);
    } catch (error) {
        if (error?.code === 'EEXIST') {
            throw new DualQualityArtifactError('DUAL_QUALITY_EXECUTION_CONFLICT', `Execution ${artifact.execution_id} already has an artifact without a matching durable attestation`);
        }
        throw error;
    } finally {
        if (fd !== undefined) fsImpl.closeSync(fd);
    }
    flushQualityDirectories(fsImpl, [canonicalQualityDir, authorityRoot]);
    return { path: target, relative_path: relativePath, sha256: digest, artifact, idempotent: false };
}

function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function qualityEvidenceFromArtifact(artifact, digest) {
    return parseContract(QualityEvidenceSchema, {
        cycle_index: artifact.cycle_index,
        attempt: artifact.attempt,
        total_tasks: artifact.total_tasks,
        completed_task_ids: [...artifact.completed_task_ids],
        plan_revision: artifact.plan_revision,
        diff_fingerprint: artifact.diff_fingerprint,
        gate_results: artifact.gate_results.map((gate) => ({ ...gate })),
        commands: artifact.commands.map(({ command, exit_code, duration_ms }) => ({ command, exit_code, duration_ms })),
        evidence_sha256: digest,
        provenance: {
            execution_id: artifact.execution_id,
            input_fingerprint: artifact.diff_fingerprint,
            mode: 'fresh',
        },
    }, 'quality_evidence');
}

function assertQualityExecutionAnchor(anchor, expected, executionId, qualityEvidence) {
    if (!anchor || anchor.execution_id !== executionId
        || anchor.artifact_sha256 !== qualityEvidence?.evidence_sha256
        || anchor.policy_sha256 !== expected.policySha256
        || anchor.diff_fingerprint !== expected.diffFingerprint
        || anchor.cycle_index !== expected.cycleIndex
        || anchor.attempt !== expected.attempt
        || anchor.total_tasks !== expected.totalTasks
        || !sameJson(anchor.completed_task_ids, expected.completedTaskIds)
        || anchor.session_id !== expected.sessionId
        || anchor.workspace_id !== expected.workspaceId
        || anchor.plan_revision !== expected.planRevision
        || !sameJson(anchor.expected_baseline, expected.baseline)
        || qualityEvidence && (qualityEvidence.provenance?.execution_id !== anchor.execution_id
            || qualityEvidence.evidence_sha256 !== anchor.artifact_sha256
            || qualityEvidence.cycle_index !== anchor.cycle_index
            || qualityEvidence.attempt !== anchor.attempt
            || qualityEvidence.total_tasks !== anchor.total_tasks
            || !sameJson(qualityEvidence.completed_task_ids, anchor.completed_task_ids)
            || qualityEvidence.plan_revision !== anchor.plan_revision
            || qualityEvidence.diff_fingerprint !== anchor.diff_fingerprint)) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ATTESTATION_INVALID',
            'Durable quality execution attestation does not match the current complete execution identity');
    }
}

function verifyQualityExecutionArtifact(input) {
    const fsImpl = input.fsImpl || fs;
    let qualityEvidence;
    try {
        qualityEvidence = parseContract(QualityEvidenceSchema, input.qualityEvidence, 'quality_evidence');
    } catch (error) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_INVALID', error.message);
    }
    const loaded = readQualityExecutionArtifact({
        authorityDir: input.authorityDir,
        executionId: qualityEvidence.provenance.execution_id,
        fsImpl,
    });
    const digest = loaded.sha256;
    if (digest !== qualityEvidence.evidence_sha256) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_HASH', 'Quality artifact hash does not match evidence_sha256');
    }
    const artifact = loaded.artifact;
    const expected = input.expected || {};
    const compactCommands = artifact.commands.map(({ command, exit_code, duration_ms }) => ({ command, exit_code, duration_ms }));
    const artifactCommandPlan = artifact.commands.map(({ program, args, cwd }) => ({ program, args, cwd }));
    const expectedCommandPlan = Array.isArray(expected.commandPlan)
        ? expected.commandPlan.map(({ program, args, cwd }) => ({ program, args: redactArgv(args), cwd: cwd || '.' }))
        : artifactCommandPlan;
    const expectedExecutionId = Array.isArray(expected.commandPlan) && expected.workspaceRoot
        ? deriveQualityExecutionId({
            workspaceRoot: expected.workspaceRoot,
            sessionId: expected.sessionId,
            workspaceId: expected.workspaceId,
            baseline: expected.baseline,
            planRevision: expected.planRevision,
            policySha256: expected.policySha256,
            diffFingerprint: qualityEvidence.diff_fingerprint,
            cycleIndex: qualityEvidence.cycle_index,
            attempt: qualityEvidence.attempt,
            totalTasks: qualityEvidence.total_tasks,
            completedTaskIds: qualityEvidence.completed_task_ids,
            commandPlan: expected.commandPlan,
        }, { fsImpl })
        : artifact.execution_id;
    const currentDependencies = expected.workspaceRoot
        ? buildDependencyIdentity(expected.workspaceRoot, fsImpl)
        : artifact.dependencies;
    if (artifact.session_id !== expected.sessionId
        || artifact.workspace_id !== expected.workspaceId
        || !sameJson(artifact.baseline, expected.baseline)
        || artifact.plan_revision !== expected.planRevision
        || artifact.policy_sha256 !== expected.policySha256
        || artifact.diff_fingerprint !== qualityEvidence.diff_fingerprint
        || (expected.diffFingerprint !== undefined && artifact.diff_fingerprint !== expected.diffFingerprint)
        || artifact.cycle_index !== qualityEvidence.cycle_index
        || (expected.cycleIndex !== undefined && artifact.cycle_index !== expected.cycleIndex)
        || artifact.attempt !== qualityEvidence.attempt
        || (expected.attempt !== undefined && artifact.attempt !== expected.attempt)
        || artifact.execution_id !== qualityEvidence.provenance.execution_id
        || artifact.execution_id !== expectedExecutionId
        || artifact.total_tasks !== qualityEvidence.total_tasks
        || (expected.totalTasks !== undefined && artifact.total_tasks !== expected.totalTasks)
        || !sameJson(artifact.completed_task_ids, qualityEvidence.completed_task_ids)
        || (expected.completedTaskIds !== undefined && !sameJson(artifact.completed_task_ids, expected.completedTaskIds))
        || !sameJson(artifact.gate_results, qualityEvidence.gate_results)
        || !sameJson(compactCommands, qualityEvidence.commands)
        || !sameJson(artifactCommandPlan, expectedCommandPlan)
        || !sameJson(artifact.dependencies, currentDependencies)
        || artifact.runner.node_version !== process.version
        || artifact.runner.platform !== process.platform
        || artifact.runner.arch !== process.arch) {
        throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_BINDING', 'Quality artifact identity or results do not match submitted evidence');
    }
    return loaded;
}

function createTrustedQualityRunner(options = {}) {
    const fsImpl = options.fsImpl || fs;
    const executeQualityPlanImpl = options.executeQualityPlanImpl || executeQualityPlanAsync;
    return async function runTrustedQualityExecution(input = {}) {
        const expected = input.expected || {};
        if (!Array.isArray(expected.commandPlan) || expected.commandPlan.length === 0) {
            throw new DualQualityArtifactError('DUAL_QUALITY_ATTESTATION_INVALID', 'Trusted quality execution requires the daemon-derived command plan');
        }
        if (input.mode === 'execute') {
            const executionId = deriveQualityExecutionId({
                workspaceRoot: input.workspaceRoot,
                sessionId: expected.sessionId,
                workspaceId: expected.workspaceId,
                baseline: expected.baseline,
                planRevision: expected.planRevision,
                policySha256: expected.policySha256,
                diffFingerprint: expected.diffFingerprint,
                cycleIndex: expected.cycleIndex,
                attempt: expected.attempt,
                totalTasks: expected.totalTasks,
                completedTaskIds: expected.completedTaskIds,
                commandPlan: expected.commandPlan,
            }, { fsImpl });
            if (input.executionAttestation) {
                const anchor = input.executionAttestation;
                assertQualityExecutionAnchor(anchor, expected, executionId, {
                    provenance: { execution_id: executionId },
                    evidence_sha256: anchor.artifact_sha256,
                    cycle_index: expected.cycleIndex,
                    attempt: expected.attempt,
                    total_tasks: expected.totalTasks,
                    completed_task_ids: expected.completedTaskIds,
                    plan_revision: expected.planRevision,
                    diff_fingerprint: expected.diffFingerprint,
                });
                const loaded = readQualityExecutionArtifact({ authorityDir: input.authorityDir, executionId, fsImpl });
                if (loaded.sha256 !== anchor.artifact_sha256) {
                    throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_HASH',
                        'Quality artifact bytes do not match the durable execution attestation');
                }
                const qualityEvidence = qualityEvidenceFromArtifact(loaded.artifact, loaded.sha256);
                const verified = verifyQualityExecutionArtifact({
                    authorityDir: input.authorityDir,
                    qualityEvidence,
                    fsImpl,
                    expected,
                });
                return { execution_id: executionId, artifact_sha256: verified.sha256, quality_evidence: qualityEvidence };
            }
            try {
                readQualityExecutionArtifact({ authorityDir: input.authorityDir, executionId, fsImpl });
                throw new DualQualityArtifactError('DUAL_QUALITY_ORPHAN_ARTIFACT',
                    `Execution ${executionId} already has an artifact but no durable attestation. Preserve the existing session and orphan artifact while investigating; create a new run after resolving the orphan. This attempt cannot be retried safely.`);
            } catch (error) {
                if (error?.code !== 'DUAL_QUALITY_ARTIFACT_MISSING') throw error;
            }

            const store = input.authorityStore || options.authorityStore;
            let lifecycleHandle = null;
            let lifecycleWriter = null;
            const runId = crypto.randomUUID();
            if (store) {
                try {
                    lifecycleWriter = createValidatorLifecycleWriter(store);
                    lifecycleHandle = lifecycleWriter.begin({
                        runId,
                        sessionId: expected.sessionId,
                        workspaceId: expected.workspaceId,
                        planRevision: expected.planRevision,
                        baselineId: expected.baseline?.id || '0'.repeat(64),
                        baselineKind: expected.baseline?.kind || 'snapshot',
                        sourceFingerprint: expected.diffFingerprint,
                        purpose: 'quality',
                        commandPolicyDigest: expected.policySha256,
                        cycle: expected.cycleIndex,
                        attempt: expected.attempt,
                    });
                } catch (err) {
                    throw err;
                }
            }

            const startedAt = new Date().toISOString();
            let results;
            try {
                results = await executeQualityPlanImpl(
                    { commands: expected.commandPlan.map((command) => ({ ...command, args: [...command.args] })) },
                    { workspaceRoot: input.workspaceRoot, cwd: input.workspaceRoot, fsImpl, runId, purpose: 'quality' }
                );
            } catch (err) {
                if (lifecycleWriter && lifecycleHandle) {
                    try {
                        lifecycleWriter.settle({
                            capability: lifecycleHandle.capability,
                            ownedResult: {
                                runId,
                                purpose: 'quality',
                                commandIndex: 0,
                                exitCode: 1,
                                signal: null,
                                failure: err.message || 'execution-error',
                                durationMs: 1,
                                stdoutBytes: 0,
                                stderrBytes: 0,
                                stdoutSha256: '0'.repeat(64),
                                stderrSha256: '0'.repeat(64),
                                outputSha256: '0'.repeat(64),
                                stdoutSummary: '',
                                stderrSummary: err.message || '',
                                stdoutSummaryTruncated: false,
                                stderrSummaryTruncated: false,
                                outputTruncated: false,
                                stdoutComplete: false,
                                stderrComplete: true,
                                outputComplete: false,
                                cancellationCode: null,
                                cleanupVerified: true,
                                activeOwnedProcesses: 0,
                                ownership: process.platform === 'win32' ? 'windows-job' : 'posix-process-group',
                            },
                            resultAnchor: { digest: '0'.repeat(64) },
                        });
                    } catch {}
                }
                throw err;
            }

            if (!Array.isArray(results) || results.length !== expected.commandPlan.length) {
                throw new DualQualityArtifactError('DUAL_QUALITY_ATTESTATION_INVALID', 'Daemon-owned quality runner returned an incomplete command result set');
            }
            const endedAt = new Date().toISOString();
            const gateResults = qualityGateResults(results);
            const persisted = persistQualityExecutionArtifact({
                authorityDir: input.authorityDir,
                workspaceRoot: input.workspaceRoot,
                sessionId: expected.sessionId,
                workspaceId: expected.workspaceId,
                baseline: expected.baseline,
                planRevision: expected.planRevision,
                policySha256: expected.policySha256,
                diffFingerprint: expected.diffFingerprint,
                cycleIndex: expected.cycleIndex,
                attempt: expected.attempt,
                executionId,
                totalTasks: expected.totalTasks,
                completedTaskIds: expected.completedTaskIds,
                gateResults,
                startedAt,
                endedAt,
                results,
            }, { fsImpl });

            if (lifecycleWriter && lifecycleHandle) {
                const allOk = results.every((r) => r.ok);
                const firstFailure = results.find((r) => !r.ok);
                const ownedResult = {
                    runId,
                    purpose: 'quality',
                    commandIndex: 0,
                    exitCode: allOk ? 0 : (firstFailure?.exit_code ?? 1),
                    signal: null,
                    failure: allOk ? null : (firstFailure?.failure || 'command-failed'),
                    durationMs: Math.max(1, new Date(endedAt).getTime() - new Date(startedAt).getTime()),
                    stdoutBytes: results.reduce((acc, r) => acc + (r.stdout ? Buffer.byteLength(r.stdout) : 0), 0),
                    stderrBytes: results.reduce((acc, r) => acc + (r.stderr ? Buffer.byteLength(r.stderr) : 0), 0),
                    stdoutSha256: sha256(results.map(r => r.stdout || '').join('\n')),
                    stderrSha256: sha256(results.map(r => r.stderr || '').join('\n')),
                    outputSha256: sha256(results.map(r => canonicalOutput(r)).join('\n')),
                    stdoutSummary: results.map(r => r.stdout || '').join('\n').slice(0, 4096),
                    stderrSummary: results.map(r => r.stderr || '').join('\n').slice(0, 4096),
                    stdoutSummaryTruncated: false,
                    stderrSummaryTruncated: false,
                    outputTruncated: false,
                    stdoutComplete: true,
                    stderrComplete: true,
                    outputComplete: true,
                    cancellationCode: null,
                    cleanupVerified: true,
                    activeOwnedProcesses: 0,
                    ownership: process.platform === 'win32' ? 'windows-job' : 'posix-process-group',
                };
                lifecycleWriter.settle({
                    capability: lifecycleHandle.capability,
                    ownedResult,
                    resultAnchor: { digest: persisted.sha256 },
                });
            }

            return {
                execution_id: executionId,
                artifact_sha256: persisted.sha256,
                quality_evidence: qualityEvidenceFromArtifact(persisted.artifact, persisted.sha256),
            };
        }
        if (input.executionId !== input.qualityEvidence?.provenance?.execution_id) {
            throw new DualQualityArtifactError('DUAL_QUALITY_ATTESTATION_INVALID', 'Trusted quality execution ID must match submitted provenance');
        }
        const anchor = input.executionAttestation;
        if (anchor) {
            assertQualityExecutionAnchor(anchor, expected, input.executionId, input.qualityEvidence);
        }
        const loaded = verifyQualityExecutionArtifact({
            authorityDir: input.authorityDir,
            qualityEvidence: input.qualityEvidence,
            fsImpl,
            expected,
        });
        if (anchor) {
            if (loaded.sha256 !== anchor.artifact_sha256) {
                throw new DualQualityArtifactError('DUAL_QUALITY_ARTIFACT_HASH',
                    'Quality artifact bytes do not match the durable execution attestation');
            }
            return { execution_id: input.executionId, artifact_sha256: loaded.sha256 };
        }
        const actualResults = await executeQualityPlanImpl(
            { commands: expected.commandPlan.map((command) => ({ ...command, args: [...command.args] })) },
            { workspaceRoot: input.workspaceRoot, cwd: input.workspaceRoot, fsImpl }
        );
        if (!Array.isArray(actualResults) || actualResults.length !== expected.commandPlan.length) {
            throw new DualQualityArtifactError('DUAL_QUALITY_ATTESTATION_INVALID', 'Daemon-owned quality runner returned an incomplete command result set');
        }
        const actualGates = qualityGateResults(actualResults);
        const claimedIdentity = qualityOutcomeIdentity(
            loaded.artifact.commands,
            loaded.artifact.gate_results,
            { trustPersistedDigests: true }
        );
        const actualIdentity = qualityOutcomeIdentity(actualResults, actualGates);
        if (!sameJson(claimedIdentity, actualIdentity)) {
            throw new DualQualityArtifactError('DUAL_QUALITY_ATTESTATION_MISMATCH', 'Submitted quality artifact outcomes do not match the daemon-owned execution');
        }
        return {
            execution_id: input.executionId,
            artifact_sha256: loaded.sha256,
        };
    };
}

module.exports = {
    DualQualityArtifactError,
    buildDependencyIdentity,
    buildQualityExecutionArtifact,
    buildQualityPlan,
    createTrustedQualityRunner,
    deriveQualityExecutionId,
    executeQualityPlan,
    executeQualityPlanAsync,
    persistQualityExecutionArtifact,
    qualityGateResults,
    readQualityExecutionArtifact,
    readPackage,
    redactArgv,
    redactSecrets,
    resolveCommand,
    runBoundedCommand,
    runBoundedCommandAsync,
    verifyQualityExecutionArtifact,
};
