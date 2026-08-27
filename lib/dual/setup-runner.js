'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const { SetupActionSchema, parseContract } = require('./contracts');

const DEFAULT_MAX_OUTPUT_LENGTH = 64 * 1024; // 64 KiB
const PROGRAM_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const LOCKFILE_MAP = {
    npm: ['package-lock.json', 'npm-shrinkwrap.json'],
    pnpm: ['pnpm-lock.yaml'],
    yarn: ['yarn.lock'],
    bun: ['bun.lock', 'bun.lockb'],
};

class DualSetupError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DualSetupError';
        this.code = code;
        this.details = details;
        if (details && details.results !== undefined) {
            this.results = details.results;
        }
        if (details && typeof details.failedIndex === 'number') {
            this.failedIndex = details.failedIndex;
        }
        if (details && details.failedAction !== undefined) {
            this.failedAction = details.failedAction;
        }
        if (details && details.cause !== undefined) {
            this.cause = details.cause;
        }
    }
}

class SetupRunnerError extends DualSetupError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'SetupRunnerError';
    }
}

function boundOutput(str, maxLength = DEFAULT_MAX_OUTPUT_LENGTH) {
    if (typeof str !== 'string') {
        if (str === null || str === undefined) return '';
        str = String(str);
    }
    if (str.length <= maxLength) {
        return str;
    }
    const truncatedNotice = '\n... [truncated]';
    const keepLength = Math.max(0, maxLength - truncatedNotice.length);
    return str.slice(0, keepLength) + truncatedNotice;
}

function isAbsolutePath(filePath, platform = process.platform) {
    if (typeof filePath !== 'string' || filePath.length === 0) return false;
    if (platform === 'win32') {
        return path.win32.isAbsolute(filePath);
    }
    return path.posix.isAbsolute(filePath);
}

function ensureInside(root, target, candidate) {
    const relative = path.relative(root, target);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        return;
    }
    throw new DualSetupError(
        'DUAL_PATH_ESCAPE',
        `Path escapes workspace root: ${candidate}`,
        { candidate }
    );
}

function detectPackageManager(dir, fsImpl = fs) {
    if (typeof dir !== 'string' || !dir) {
        throw new DualSetupError('DUAL_PATH_ESCAPE', 'Directory path must be a non-empty string');
    }

    const detected = [];
    for (const [manager, lockfiles] of Object.entries(LOCKFILE_MAP)) {
        for (const lockfile of lockfiles) {
            const lockfilePath = path.join(dir, lockfile);
            if (fsImpl.existsSync(lockfilePath)) {
                detected.push(manager);
                break;
            }
        }
    }

    if (detected.length === 0) {
        return null;
    }
    if (detected.length === 1) {
        return detected[0];
    }

    throw new DualSetupError(
        'DUAL_SETUP_LOCKFILE_CONFLICT',
        `Conflicting package manager lockfiles detected in ${dir}: ${detected.join(', ')}`,
        { detected, dir }
    );
}

function validateResolverResult(res, platform, program) {
    if (res === null || res === undefined) {
        throw new DualSetupError(
            'DUAL_SETUP_RESOLVE_FAILED',
            `Could not resolve executable for: ${program}`
        );
    }
    if (typeof res !== 'object' || Array.isArray(res)) {
        throw new DualSetupError(
            'DUAL_SETUP_RESOLVE_FAILED',
            `Resolver must return a plain object with { kind, path }, received: ${typeof res === 'object' ? 'array' : typeof res}`
        );
    }
    const proto = Object.getPrototypeOf(res);
    if (proto !== Object.prototype && proto !== null) {
        throw new DualSetupError(
            'DUAL_SETUP_RESOLVE_FAILED',
            `Resolver must return an ordinary plain record, received instance of ${res.constructor ? res.constructor.name : 'exotic prototype'}`
        );
    }
    const ownKeys = Reflect.ownKeys(res);
    if (
        ownKeys.length !== 2 ||
        !Object.prototype.hasOwnProperty.call(res, 'kind') ||
        !Object.prototype.hasOwnProperty.call(res, 'path')
    ) {
        throw new DualSetupError(
            'DUAL_SETUP_RESOLVE_FAILED',
            `Resolver result must contain exactly own { kind, path } properties without extra or missing keys: ${JSON.stringify(ownKeys.map(String))}`
        );
    }
    if (res.kind !== 'native' && res.kind !== 'node-cli') {
        throw new DualSetupError(
            'DUAL_SETUP_RESOLVE_FAILED',
            `Resolver result kind must be 'native' or 'node-cli', received: ${JSON.stringify(res.kind)}`
        );
    }
    if (typeof res.path !== 'string' || res.path.trim().length === 0) {
        throw new DualSetupError(
            'DUAL_SETUP_RESOLVE_FAILED',
            `Resolver result path must be a non-empty string`
        );
    }
    if (!isAbsolutePath(res.path, platform)) {
        throw new DualSetupError(
            'DUAL_SETUP_RESOLVE_FAILED',
            `Resolver result path must be absolute: ${res.path}`
        );
    }
    return res;
}

function defaultResolveExecutable(program, {
    platform = process.platform,
    kind,
    env = process.env,
    fsImpl = fs,
    processExecPath = process.execPath,
} = {}) {
    if (isAbsolutePath(program, platform) && fsImpl.existsSync(program)) {
        const ext = path.extname(program).toLowerCase();
        if (['.js', '.cjs', '.mjs'].includes(ext)) {
            try {
                const stat = fsImpl.statSync(program);
                if (stat.isFile()) {
                    return { kind: 'node-cli', path: program };
                }
            } catch {
                // not a regular file
            }
            return null;
        }
        if (platform === 'win32') {
            if (ext === '.exe' || ext === '.com') {
                try {
                    const stat = fsImpl.statSync(program);
                    if (stat.isFile()) {
                        return { kind: 'native', path: program };
                    }
                } catch {
                    // not a regular file
                }
            }
            return null;
        }
        if (platform !== 'win32') {
            try {
                const stat = fsImpl.statSync(program);
                if (stat.isFile()) {
                    if (typeof fsImpl.accessSync === 'function') {
                        const xOk = (fsImpl.constants && typeof fsImpl.constants.X_OK === 'number')
                            ? fsImpl.constants.X_OK
                            : (fs.constants?.X_OK ?? 1);
                        fsImpl.accessSync(program, xOk);
                    }
                    return { kind: 'native', path: program };
                }
            } catch {
                // non-regular file or not executable (EACCES)
            }
            return null;
        }
    }

    if ((kind === 'package-manager' || kind === 'node-cli') && program === 'npm') {
        const nodeDir = path.dirname(processExecPath);
        const candidates = [
            path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
            path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
            path.join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        ];
        for (const candidate of candidates) {
            if (fsImpl.existsSync(candidate)) {
                return { kind: 'node-cli', path: candidate };
            }
        }
    }

    const rawPath = env.PATH || env.Path || env.path || '';
    const delimiter = platform === 'win32' ? ';' : ':';
    const dirs = rawPath.split(delimiter).filter(Boolean);

    for (const dir of dirs) {
        if (platform === 'win32') {
            if (kind === 'native' || kind === 'package-manager') {
                for (const ext of ['.exe', '.com']) {
                    const full = path.join(dir, `${program}${ext}`);
                    if (fsImpl.existsSync(full)) {
                        try {
                            const stat = fsImpl.statSync(full);
                            if (stat.isFile()) {
                                return { kind: 'native', path: full };
                            }
                        } catch {
                            // continue
                        }
                    }
                }
            }
        } else {
            const full = path.join(dir, program);
            if (fsImpl.existsSync(full)) {
                try {
                    const stat = fsImpl.statSync(full);
                    if (stat.isFile()) {
                        if (typeof fsImpl.accessSync === 'function') {
                            const xOk = (fsImpl.constants && typeof fsImpl.constants.X_OK === 'number')
                                ? fsImpl.constants.X_OK
                                : (fs.constants?.X_OK ?? 1);
                            fsImpl.accessSync(full, xOk);
                        }
                        return { kind: 'native', path: full };
                    }
                } catch {
                    // non-regular file or not executable (EACCES)
                }
            }
        }
    }

    return null;
}

function resolveTarget(targetName, {
    actionKind,
    platform,
    resolvedCwd,
    env,
    fsImpl,
    processExecPath,
    resolveExecutable,
}) {
    let res;
    if (typeof resolveExecutable === 'function') {
        res = resolveExecutable(targetName, { platform, cwd: resolvedCwd, kind: actionKind, env });
        return validateResolverResult(res, platform, targetName);
    }
    res = defaultResolveExecutable(targetName, {
        platform,
        cwd: resolvedCwd,
        kind: actionKind,
        env,
        fsImpl,
        processExecPath,
    });
    return validateResolverResult(res, platform, targetName);
}

function resolveSetupInvocation(action, deps = {}) {
    if (
        action &&
        typeof action === 'object' &&
        Object.prototype.hasOwnProperty.call(action, 'program') &&
        (
            typeof action.program !== 'string' ||
            !PROGRAM_IDENTIFIER_PATTERN.test(action.program)
        )
    ) {
        throw new DualSetupError(
            'DUAL_SETUP_PROGRAM_INVALID',
            `Program must be an executable or package-manager identifier matching allowlist pattern ${PROGRAM_IDENTIFIER_PATTERN}`
        );
    }

    const parsedAction = parseContract(SetupActionSchema, action, 'setup action');

    const program = parsedAction.program;
    if (
        typeof program !== 'string' ||
        !PROGRAM_IDENTIFIER_PATTERN.test(program)
    ) {
        throw new DualSetupError(
            'DUAL_SETUP_PROGRAM_INVALID',
            `Program must be an executable or package-manager identifier matching allowlist pattern ${PROGRAM_IDENTIFIER_PATTERN}: ${JSON.stringify(program)}`
        );
    }

    const platform = deps.platform || process.platform;
    const env = deps.env || process.env;
    const fsImpl = deps.fsImpl || fs;
    const processExecPath = deps.processExecPath || process.execPath;
    const resolveExecutable = deps.resolveExecutable;
    const workspaceRoot = deps.workspaceRoot || process.cwd();

    let canonicalRoot;
    try {
        canonicalRoot = fsImpl.realpathSync?.native
            ? fsImpl.realpathSync.native(workspaceRoot)
            : (fsImpl.realpathSync ? fsImpl.realpathSync(workspaceRoot) : path.resolve(workspaceRoot));
        const rootStat = fsImpl.statSync(canonicalRoot);
        if (!rootStat.isDirectory()) {
            throw new DualSetupError('DUAL_PATH_ESCAPE', `Workspace root is not a directory: ${workspaceRoot}`);
        }
    } catch (err) {
        if (err instanceof DualSetupError) {
            throw err;
        }
        throw new DualSetupError('DUAL_PATH_ESCAPE', `Workspace root does not exist: ${workspaceRoot}`);
    }

    const candidateCwd = parsedAction.cwd || '.';
    if (typeof candidateCwd !== 'string' || candidateCwd.includes('\0')) {
        throw new DualSetupError('DUAL_PATH_ESCAPE', 'Cwd must be a string without NUL bytes');
    }

    if (
        path.isAbsolute(candidateCwd) ||
        path.posix.isAbsolute(candidateCwd) ||
        path.win32.isAbsolute(candidateCwd) ||
        candidateCwd.startsWith('//') ||
        candidateCwd.startsWith('\\\\') ||
        candidateCwd.includes(':')
    ) {
        throw new DualSetupError('DUAL_PATH_ESCAPE', `Absolute, drive-qualified, or UNC cwd path is forbidden: ${candidateCwd}`);
    }

    const slashCwd = candidateCwd.replace(/\\/g, '/');
    const segments = slashCwd.split('/');
    if (segments.some((seg) => seg === '..')) {
        throw new DualSetupError('DUAL_PATH_ESCAPE', `Path traversal is forbidden in cwd: ${candidateCwd}`);
    }

    const normalizedCwd = path.posix.normalize(slashCwd).replace(/^\.\//, '');
    let resolvedCwd;

    if (!normalizedCwd || normalizedCwd === '.') {
        resolvedCwd = canonicalRoot;
    } else {
        const target = path.resolve(canonicalRoot, ...normalizedCwd.split('/'));
        ensureInside(canonicalRoot, target, candidateCwd);

        if (!fsImpl.existsSync(target)) {
            throw new DualSetupError('DUAL_PATH_ESCAPE', `Setup cwd directory does not exist: ${candidateCwd}`);
        }
        const stat = fsImpl.statSync(target);
        if (!stat.isDirectory()) {
            throw new DualSetupError('DUAL_PATH_ESCAPE', `Setup cwd is not a directory: ${candidateCwd}`);
        }

        const canonicalTarget = fsImpl.realpathSync?.native
            ? fsImpl.realpathSync.native(target)
            : (fsImpl.realpathSync ? fsImpl.realpathSync(target) : target);
        ensureInside(canonicalRoot, canonicalTarget, candidateCwd);
        resolvedCwd = canonicalTarget;
    }

    if (parsedAction.kind === 'package-manager') {
        let targetManager;
        if (parsedAction.program === 'auto') {
            const detected = detectPackageManager(resolvedCwd, fsImpl);
            if (!detected) {
                throw new DualSetupError(
                    'DUAL_SETUP_NO_LOCKFILE',
                    `No supported package manager lockfile found in ${resolvedCwd} for auto detection`
                );
            }
            targetManager = detected;
        } else {
            if (!['npm', 'pnpm', 'yarn', 'bun'].includes(parsedAction.program)) {
                throw new DualSetupError(
                    'DUAL_SETUP_PROGRAM_INVALID',
                    `Unsupported package manager: ${parsedAction.program}`
                );
            }
            targetManager = parsedAction.program;
        }

        const res = resolveTarget(targetManager, {
            actionKind: 'package-manager',
            platform,
            resolvedCwd,
            env,
            fsImpl,
            processExecPath,
            resolveExecutable,
        });

        const ext = path.extname(res.path).toLowerCase();
        if (res.kind === 'node-cli') {
            if (!['.js', '.cjs', '.mjs'].includes(ext)) {
                throw new DualSetupError(
                    'DUAL_SETUP_EXECUTABLE_UNTRUSTED',
                    `Node CLI package manager entrypoint must be a JS/CJS/MJS file: ${res.path}`
                );
            }
            return {
                command: processExecPath,
                args: [res.path, ...parsedAction.args],
                cwd: resolvedCwd,
                shell: false,
                windowsHide: true,
            };
        }

        if (res.kind === 'native') {
            if (platform === 'win32') {
                if (ext === '.cmd' || ext === '.bat' || ext === '.ps1') {
                    throw new DualSetupError(
                        'DUAL_SETUP_EXECUTABLE_UNTRUSTED',
                        `Windows shell wrappers (.cmd/.bat/.ps1) are forbidden for package manager: ${res.path}`
                    );
                }
                if (ext !== '.exe' && ext !== '.com') {
                    throw new DualSetupError(
                        'DUAL_SETUP_EXECUTABLE_UNTRUSTED',
                        `Untrusted package manager executable on Windows: ${res.path}`
                    );
                }
            }
            return {
                command: res.path,
                args: parsedAction.args,
                cwd: resolvedCwd,
                shell: false,
                windowsHide: true,
            };
        }

        throw new DualSetupError(
            'DUAL_SETUP_EXECUTABLE_UNTRUSTED',
            `Unsupported package manager resolver kind: ${res.kind}`
        );
    }

    if (parsedAction.kind === 'native') {
        const res = resolveTarget(parsedAction.program, {
            actionKind: 'native',
            platform,
            resolvedCwd,
            env,
            fsImpl,
            processExecPath,
            resolveExecutable,
        });

        if (res.kind !== 'native') {
            throw new DualSetupError(
                'DUAL_SETUP_EXECUTABLE_UNTRUSTED',
                `Native action requires resolver kind "native", received: ${res.kind}`
            );
        }

        const ext = path.extname(res.path).toLowerCase();
        if (platform === 'win32') {
            if (ext === '.cmd' || ext === '.bat' || ext === '.ps1') {
                throw new DualSetupError(
                    'DUAL_SETUP_EXECUTABLE_UNTRUSTED',
                    `Windows shell wrappers (.cmd/.bat/.ps1) are forbidden for native execution: ${res.path}`
                );
            }
            if (ext !== '.exe' && ext !== '.com') {
                throw new DualSetupError(
                    'DUAL_SETUP_EXECUTABLE_UNTRUSTED',
                    `Untrusted native executable on Windows: ${res.path}`
                );
            }
        }
        return {
            command: res.path,
            args: parsedAction.args,
            cwd: resolvedCwd,
            shell: false,
            windowsHide: true,
        };
    }

    if (parsedAction.kind === 'node-cli') {
        const res = resolveTarget(parsedAction.program, {
            actionKind: 'node-cli',
            platform,
            resolvedCwd,
            env,
            fsImpl,
            processExecPath,
            resolveExecutable,
        });

        if (res.kind !== 'node-cli') {
            throw new DualSetupError(
                'DUAL_SETUP_EXECUTABLE_UNTRUSTED',
                `Node CLI action requires resolver kind "node-cli", received: ${res.kind}`
            );
        }

        const ext = path.extname(res.path).toLowerCase();
        if (!['.js', '.cjs', '.mjs'].includes(ext)) {
            throw new DualSetupError(
                'DUAL_SETUP_EXECUTABLE_UNTRUSTED',
                `Node CLI entrypoint must be a JS/CJS/MJS file: ${res.path}`
            );
        }

        return {
            command: processExecPath,
            args: [res.path, ...parsedAction.args],
            cwd: resolvedCwd,
            shell: false,
            windowsHide: true,
        };
    }

    throw new DualSetupError('DUAL_SETUP_PROGRAM_INVALID', `Unknown action kind: ${parsedAction.kind}`);
}

function runSetupActions(actions, deps = {}) {
    if (!Array.isArray(actions)) {
        throw new DualSetupError('DUAL_SETUP_ACTIONS_INVALID', 'Actions must be an array');
    }

    // Preflight schema validation of all actions before any resolver or spawn side-effects
    for (let index = 0; index < actions.length; index++) {
        const action = actions[index];
        try {
            parseContract(SetupActionSchema, action, 'setup action');
        } catch (err) {
            const errCode = err.code || 'DUAL_CONTRACT_INVALID';
            const errMsg = `Setup action [${index}] failed schema validation: ${err.message}`;
            const safeDetails = { ...(err.details || {}) };
            const runnerErr = new SetupRunnerError(errCode, errMsg, {
                ...safeDetails,
                results: [],
                failedIndex: index,
                failedAction: action,
                cause: err,
            });
            throw runnerErr;
        }
    }

    const dryRun = Boolean(deps.dryRun);
    const spawnSync = deps.spawnSync || childProcess.spawnSync;
    const childEnv = deps.env || process.env;
    const maxOutputLength = deps.maxOutputLength || DEFAULT_MAX_OUTPUT_LENGTH;
    const results = [];

    for (let index = 0; index < actions.length; index++) {
        const action = actions[index];
        let inv;
        try {
            inv = resolveSetupInvocation(action, deps);
        } catch (err) {
            const errCode = err.code || 'DUAL_SETUP_RESOLVE_FAILED';
            const errMsg = `Setup action [${index}] failed resolution: ${err.message}`;
            const safeDetails = { ...(err.details || {}) };
            const runnerErr = new SetupRunnerError(errCode, errMsg, {
                ...safeDetails,
                results,
                failedIndex: index,
                failedAction: action,
                cause: err,
            });
            throw runnerErr;
        }

        if (dryRun) {
            results.push({
                index,
                program: action.program,
                kind: action.kind,
                command: inv.command,
                args: inv.args,
                cwd: inv.cwd,
                shell: inv.shell,
                windowsHide: inv.windowsHide,
                status: 0,
            });
            continue;
        }

        const startTime = Date.now();
        let spawnResult;
        try {
            spawnResult = spawnSync(inv.command, inv.args, {
                cwd: inv.cwd,
                shell: false,
                windowsHide: true,
                encoding: 'utf8',
                env: childEnv,
                maxBuffer: maxOutputLength * 4,
            });
        } catch (err) {
            spawnResult = {
                status: null,
                signal: null,
                stdout: '',
                stderr: err.message || String(err),
                error: err,
            };
        }

        const durationMs = Date.now() - startTime;
        const stdout = boundOutput(spawnResult.stdout || '', maxOutputLength);
        const stderr = boundOutput(spawnResult.stderr || (spawnResult.error ? spawnResult.error.message : ''), maxOutputLength);
        const status = typeof spawnResult.status === 'number' ? spawnResult.status : (spawnResult.error ? null : (spawnResult.status === null ? null : 0));

        const actionResult = {
            index,
            program: action.program,
            kind: action.kind,
            command: inv.command,
            args: inv.args,
            cwd: inv.cwd,
            status,
            signal: spawnResult.signal || null,
            stdout,
            stderr,
            duration_ms: durationMs,
            error: spawnResult.error ? (spawnResult.error.message || String(spawnResult.error)) : null,
        };
        results.push(actionResult);

        const failed = Boolean(
            spawnResult.error ||
            (typeof spawnResult.status === 'number' && spawnResult.status !== 0) ||
            spawnResult.status === null ||
            spawnResult.signal
        );
        if (failed) {
            const errCode = 'DUAL_SETUP_ACTION_FAILED';
            const errMsg = `Setup action [${index}] failed: ${action.program} (status: ${status}${actionResult.error ? `, error: ${actionResult.error}` : ''})`;
            const err = new SetupRunnerError(errCode, errMsg, {
                results,
                failedAction: actionResult,
                failedIndex: index,
            });
            throw err;
        }
    }

    return {
        ok: true,
        dryRun,
        results,
    };
}

module.exports = {
    resolveSetupInvocation,
    runSetupActions,
    detectPackageManager,
    defaultResolveExecutable,
    boundOutput,
    DualSetupError,
    SetupRunnerError,
    DEFAULT_MAX_OUTPUT_LENGTH,
    LOCKFILE_MAP,
};
