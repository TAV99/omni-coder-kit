'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

const {
    SetupActionSchema,
    Sha256Schema,
    parseContract,
    DualContractError,
} = require('./contracts');

const {
    runSetupActions,
    DualSetupError,
    SetupRunnerError,
} = require('./setup-runner');

const MAX_MANIFEST_BYTES = 64 * 1024; // 64 KiB
const MAX_RECEIPT_BYTES = 16 * 1024;  // 16 KiB
const MAX_LOCK_BYTES = 16 * 1024;     // 16 KiB
const MAX_PACKAGE_JSON_BYTES = 64 * 1024; // 64 KiB
const PROGRAM_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const PACKAGE_MANAGER_PROGRAMS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

class DualSetupCommandError extends DualSetupError {
    constructor(code, message, details = {}) {
        super(code, message, details);
        this.name = 'DualSetupCommandError';
    }
}

const SetupReceiptSchema = z.object({
    schema_version: z.literal(1),
    workspace_root: z.string().min(1),
    manifest_sha256: Sha256Schema,
    action_count: z.number().int().nonnegative(),
    status: z.literal('SUCCESS'),
    completed_at: z.string().datetime({ offset: true }),
    results_digest: Sha256Schema,
}).strict();

const SetupLockSchema = z.object({
    schema_version: z.literal(1),
    workspace_root: z.string().min(1),
    pid: z.number().int().positive(),
    nonce: z.string().uuid(),
    started_at: z.string().datetime({ offset: true }),
    manifest_sha256: Sha256Schema,
}).strict();

function ensureInside(root, target, candidate) {
    const relative = path.relative(root, target);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        return;
    }
    throw new DualSetupCommandError(
        'DUAL_PATH_ESCAPE',
        `Path escapes workspace root: ${candidate}`,
        { candidate, root, target }
    );
}

function resolveManagedPath(canonicalWorkspace, relativeSegments, {
    createDir = false,
    requiredType = null,
    fsImpl = fs,
} = {}) {
    const segments = Array.isArray(relativeSegments)
        ? relativeSegments
        : relativeSegments.split(/[\\/]/).filter(Boolean);

    let currentPath = canonicalWorkspace;
    ensureInside(canonicalWorkspace, currentPath, '.');

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg === '..' || seg === '.' || seg.includes('/') || seg.includes('\\')) {
            throw new DualSetupCommandError(
                'DUAL_PATH_ESCAPE',
                `Invalid segment in managed path: ${seg}`
            );
        }

        const isLast = (i === segments.length - 1);
        const nextCandidate = path.join(currentPath, seg);
        const relFromRoot = path.relative(canonicalWorkspace, nextCandidate);

        if (fsImpl.existsSync(nextCandidate)) {
            let canonicalNext;
            try {
                canonicalNext = fsImpl.realpathSync?.native
                    ? fsImpl.realpathSync.native(nextCandidate)
                    : (fsImpl.realpathSync ? fsImpl.realpathSync(nextCandidate) : nextCandidate);
            } catch (err) {
                throw new DualSetupCommandError(
                    'DUAL_PATH_ESCAPE',
                    `Cannot canonicalize managed path component ${nextCandidate}: ${err.message}`,
                    { cause: err }
                );
            }

            ensureInside(canonicalWorkspace, canonicalNext, relFromRoot);

            const stat = fsImpl.statSync(canonicalNext);
            if (!isLast) {
                if (!stat.isDirectory()) {
                    throw new DualSetupCommandError(
                        'DUAL_PATH_ESCAPE',
                        `Expected directory along managed path at ${canonicalNext}, found non-directory`
                    );
                }
            } else {
                if (requiredType === 'file' && !stat.isFile()) {
                    throw new DualSetupCommandError(
                        'DUAL_SETUP_MANIFEST_INVALID',
                        `Managed target is not a regular file: ${canonicalNext}`
                    );
                }
                if (requiredType === 'dir' && !stat.isDirectory()) {
                    throw new DualSetupCommandError(
                        'DUAL_PATH_ESCAPE',
                        `Managed target is not a directory: ${canonicalNext}`
                    );
                }
            }
            currentPath = canonicalNext;
        } else {
            if (createDir) {
                try {
                    fsImpl.mkdirSync(nextCandidate, { recursive: true });
                } catch (err) {
                    throw new DualSetupCommandError(
                        'DUAL_PATH_ESCAPE',
                        `Failed to create managed directory ${nextCandidate}: ${err.message}`,
                        { cause: err }
                    );
                }
                let canonicalNext;
                try {
                    canonicalNext = fsImpl.realpathSync?.native
                        ? fsImpl.realpathSync.native(nextCandidate)
                        : (fsImpl.realpathSync ? fsImpl.realpathSync(nextCandidate) : nextCandidate);
                } catch (err) {
                    throw new DualSetupCommandError(
                        'DUAL_PATH_ESCAPE',
                        `Cannot canonicalize newly created directory ${nextCandidate}: ${err.message}`,
                        { cause: err }
                    );
                }
                ensureInside(canonicalWorkspace, canonicalNext, relFromRoot);
                const stat = fsImpl.statSync(canonicalNext);
                if (!stat.isDirectory()) {
                    throw new DualSetupCommandError(
                        'DUAL_PATH_ESCAPE',
                        `Created path is not a directory: ${canonicalNext}`
                    );
                }
                currentPath = canonicalNext;
            } else {
                currentPath = nextCandidate;
                ensureInside(canonicalWorkspace, currentPath, relFromRoot);
            }
        }
    }

    return currentPath;
}

function isPidAlive(pid) {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        if (err && err.code === 'ESRCH') {
            return false;
        }
        if (err && err.code === 'EPERM') {
            return true;
        }
        return true; // fail-closed if unknown
    }
}

function computeResultsDigest(results = []) {
    const sanitized = results.map((r) => ({
        index: r.index,
        program: r.program,
        kind: r.kind,
        command: r.command,
        args: r.args,
        cwd: r.cwd,
        status: r.status,
    }));
    return crypto.createHash('sha256').update(JSON.stringify(sanitized)).digest('hex');
}

function createCliResolver(canonicalRoot, {
    platform = process.platform,
    env = process.env,
    fsImpl = fs,
    processExecPath = process.execPath,
} = {}) {
    return function resolveCliExecutable(program, { cwd, kind }) {
        if (typeof program !== 'string' || !PROGRAM_IDENTIFIER_PATTERN.test(program)) {
            throw new DualSetupCommandError(
                'DUAL_SETUP_PROGRAM_INVALID',
                `Program identifier is invalid: ${JSON.stringify(program)}`
            );
        }

        const rawPath = env.PATH || env.Path || env.path || '';
        const delimiter = platform === 'win32' ? ';' : ':';
        const dirs = rawPath.split(delimiter).filter(Boolean);

        if (kind === 'native') {
            if (platform === 'win32') {
                for (const dir of dirs) {
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
                for (const dir of dirs) {
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
                            // continue
                        }
                    }
                }
            }
            return null;
        }

        if (kind === 'package-manager') {
            const nodeDir = path.dirname(processExecPath);
            const nodeCandidates = [];
            if (program === 'npm') {
                nodeCandidates.push(
                    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
                    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
                    path.join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')
                );
            } else if (program === 'pnpm') {
                nodeCandidates.push(
                    path.join(nodeDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
                    path.join(nodeDir, '..', 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
                    path.join(nodeDir, '..', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
                    path.join(nodeDir, 'node_modules', 'pnpm', 'dist', 'pnpm.cjs')
                );
            } else if (program === 'yarn') {
                nodeCandidates.push(
                    path.join(nodeDir, 'node_modules', 'yarn', 'bin', 'yarn.js'),
                    path.join(nodeDir, '..', 'lib', 'node_modules', 'yarn', 'bin', 'yarn.js'),
                    path.join(nodeDir, '..', 'node_modules', 'yarn', 'bin', 'yarn.js')
                );
            }

            for (const candidate of nodeCandidates) {
                if (fsImpl.existsSync(candidate)) {
                    try {
                        const stat = fsImpl.statSync(candidate);
                        if (stat.isFile()) {
                            return { kind: 'node-cli', path: candidate };
                        }
                    } catch {
                        // continue
                    }
                }
            }

            // Search bounded manager-specific JS/CJS/MJS candidates across PATH directories
            for (const dir of dirs) {
                const pathCandidates = [];
                if (program === 'npm') {
                    pathCandidates.push(
                        path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
                        path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.cjs'),
                        path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
                        path.join(dir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js')
                    );
                } else if (program === 'pnpm') {
                    pathCandidates.push(
                        path.join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
                        path.join(dir, 'node_modules', 'pnpm', 'dist', 'pnpm.cjs'),
                        path.join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.js'),
                        path.join(dir, '..', 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
                        path.join(dir, '..', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
                        path.join(dir, 'pnpm.cjs'),
                        path.join(dir, 'pnpm.js')
                    );
                } else if (program === 'yarn') {
                    pathCandidates.push(
                        path.join(dir, 'node_modules', 'yarn', 'bin', 'yarn.js'),
                        path.join(dir, 'node_modules', 'yarn', 'bin', 'yarn.cjs'),
                        path.join(dir, '..', 'lib', 'node_modules', 'yarn', 'bin', 'yarn.js'),
                        path.join(dir, '..', 'node_modules', 'yarn', 'bin', 'yarn.js'),
                        path.join(dir, 'yarn.js'),
                        path.join(dir, 'yarn.cjs')
                    );
                }

                for (const candidate of pathCandidates) {
                    if (fsImpl.existsSync(candidate)) {
                        try {
                            const stat = fsImpl.statSync(candidate);
                            if (stat.isFile()) {
                                const ext = path.extname(candidate).toLowerCase();
                                if (['.js', '.cjs', '.mjs'].includes(ext)) {
                                    return { kind: 'node-cli', path: candidate };
                                }
                            }
                        } catch {
                            // continue
                        }
                    }
                }
            }

            // Search for native binaries in PATH
            if (platform === 'win32') {
                for (const dir of dirs) {
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
                for (const dir of dirs) {
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
                            // continue
                        }
                    }
                }
            }
            return null;
        }

        if (kind === 'node-cli') {
            let curr = cwd || canonicalRoot;
            let pkgDir = null;
            while (true) {
                const candidate = path.join(curr, 'node_modules', program);
                if (fsImpl.existsSync(candidate) && fsImpl.existsSync(path.join(candidate, 'package.json'))) {
                    pkgDir = candidate;
                    break;
                }
                if (curr === canonicalRoot || path.dirname(curr) === curr) {
                    break;
                }
                curr = path.dirname(curr);
            }

            if (!pkgDir) {
                return null;
            }

            let canonicalPkgDir;
            try {
                canonicalPkgDir = fsImpl.realpathSync?.native
                    ? fsImpl.realpathSync.native(pkgDir)
                    : (fsImpl.realpathSync ? fsImpl.realpathSync(pkgDir) : pkgDir);
                ensureInside(canonicalRoot, canonicalPkgDir, pkgDir);
            } catch {
                return null;
            }

            const pkgJsonPath = path.join(canonicalPkgDir, 'package.json');
            let pkgStat;
            try {
                pkgStat = fsImpl.lstatSync ? fsImpl.lstatSync(pkgJsonPath) : fsImpl.statSync(pkgJsonPath);
            } catch {
                return null;
            }

            if (!pkgStat || (typeof pkgStat.isFile === 'function' && !pkgStat.isFile()) || (typeof pkgStat.isSymbolicLink === 'function' && pkgStat.isSymbolicLink())) {
                return null;
            }

            if (typeof pkgStat.size === 'number' && pkgStat.size > MAX_PACKAGE_JSON_BYTES) {
                return null;
            }

            let pkgBytes;
            try {
                pkgBytes = fsImpl.readFileSync(pkgJsonPath);
            } catch {
                return null;
            }

            const pkgByteLen = Buffer.isBuffer(pkgBytes) ? pkgBytes.length : Buffer.byteLength(String(pkgBytes), 'utf8');
            if (pkgByteLen > MAX_PACKAGE_JSON_BYTES) {
                return null;
            }

            let pkgJson;
            try {
                pkgJson = JSON.parse(Buffer.isBuffer(pkgBytes) ? pkgBytes.toString('utf8') : String(pkgBytes));
            } catch {
                return null;
            }

            let binRelative = null;
            if (typeof pkgJson.bin === 'string') {
                binRelative = pkgJson.bin;
            } else if (pkgJson.bin && typeof pkgJson.bin === 'object' && !Array.isArray(pkgJson.bin)) {
                if (typeof pkgJson.bin[program] === 'string') {
                    binRelative = pkgJson.bin[program];
                }
            }

            if (!binRelative || typeof binRelative !== 'string') {
                return null;
            }

            const target = path.resolve(canonicalPkgDir, binRelative);
            try {
                ensureInside(canonicalPkgDir, target, binRelative);
                if (!fsImpl.existsSync(target)) {
                    return null;
                }
                const stat = fsImpl.statSync(target);
                if (!stat.isFile()) {
                    return null;
                }
                const canonicalTarget = fsImpl.realpathSync?.native
                    ? fsImpl.realpathSync.native(target)
                    : (fsImpl.realpathSync ? fsImpl.realpathSync(target) : target);
                ensureInside(canonicalPkgDir, canonicalTarget, binRelative);

                const ext = path.extname(canonicalTarget).toLowerCase();
                if (!['.js', '.cjs', '.mjs'].includes(ext)) {
                    return null;
                }
                return { kind: 'node-cli', path: canonicalTarget };
            } catch {
                return null;
            }
        }

        return null;
    };
}

function writeCanonicalSetupManifest(manifestPath, manifest, fsImpl = fs) {
    const manifestDir = path.dirname(manifestPath);
    const nonce = crypto.randomUUID();
    const tmpPath = path.join(manifestDir, `setup.json.tmp.${nonce}`);
    const payload = `${JSON.stringify(manifest, null, 2)}\n`;
    let fd = null;

    try {
        fd = fsImpl.openSync(tmpPath, 'wx', 0o600);
        fsImpl.writeFileSync(fd, payload, 'utf8');
        if (typeof fsImpl.fsyncSync === 'function') fsImpl.fsyncSync(fd);
        fsImpl.closeSync(fd);
        fd = null;
        atomicRename(tmpPath, manifestPath, fsImpl);
        if (typeof fsImpl.openSync === 'function' && typeof fsImpl.fsyncSync === 'function') {
            let dirFd = null;
            try {
                dirFd = fsImpl.openSync(manifestDir, 'r');
                fsImpl.fsyncSync(dirFd);
            } catch {
                // Directory fsync is not supported on every platform/filesystem.
            } finally {
                if (dirFd !== null) {
                    try { fsImpl.closeSync(dirFd); } catch { /* ignore */ }
                }
            }
        }
    } catch (err) {
        if (fd !== null) {
            try { fsImpl.closeSync(fd); } catch { /* ignore */ }
        }
        try {
            if (fsImpl.existsSync(tmpPath)) fsImpl.unlinkSync(tmpPath);
        } catch { /* ignore */ }
        throw new DualSetupCommandError(
            'DUAL_SETUP_REPAIR_FAILED',
            `Failed to atomically repair setup manifest: ${err.message}`,
            { manifestPath, cause: err }
        );
    }

    return Buffer.from(payload, 'utf8');
}

function readAndValidateManifest(canonicalRoot, fsImpl = fs, options = {}) {
    const manifestPath = resolveManagedPath(canonicalRoot, ['.omni', 'sdlc', 'setup.json'], { fsImpl });

    if (!fsImpl.existsSync(manifestPath)) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_MANIFEST_MISSING',
            `Setup manifest file .omni/sdlc/setup.json does not exist in ${canonicalRoot}`,
            { manifestPath }
        );
    }

    const verifiedManifestPath = resolveManagedPath(canonicalRoot, ['.omni', 'sdlc', 'setup.json'], {
        requiredType: 'file',
        fsImpl,
    });

    const manifestStat = fsImpl.statSync(verifiedManifestPath);
    if (typeof manifestStat.size === 'number' && manifestStat.size > MAX_MANIFEST_BYTES) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_MANIFEST_INVALID',
            `Setup manifest exceeds maximum allowed size of 64 KiB (${manifestStat.size} bytes)`
        );
    }

    let rawBytes = fsImpl.readFileSync(verifiedManifestPath);
    if (rawBytes.length > MAX_MANIFEST_BYTES) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_MANIFEST_INVALID',
            `Setup manifest exceeds maximum allowed size of 64 KiB (${rawBytes.length} bytes)`
        );
    }

    if (
        (rawBytes.length >= 3 && rawBytes[0] === 0xEF && rawBytes[1] === 0xBB && rawBytes[2] === 0xBF) ||
        (rawBytes.length >= 2 && ((rawBytes[0] === 0xFE && rawBytes[1] === 0xFF) || (rawBytes[0] === 0xFF && rawBytes[1] === 0xFE)))
    ) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_MANIFEST_INVALID',
            'Setup manifest contains forbidden byte-order mark (BOM)'
        );
    }

    const text = rawBytes.toString('utf8');
    if (text.startsWith('\uFEFF')) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_MANIFEST_INVALID',
            'Setup manifest contains forbidden byte-order mark (BOM)'
        );
    }

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (err) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_MANIFEST_INVALID',
            `Setup manifest contains malformed JSON: ${err.message}`,
            { cause: err }
        );
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_MANIFEST_INVALID',
            'Setup manifest must be a JSON object'
        );
    }

    const proto = Object.getPrototypeOf(parsed);
    if (proto !== Object.prototype && proto !== null) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_MANIFEST_INVALID',
            'Setup manifest must be a plain object'
        );
    }

    const ownKeys = Reflect.ownKeys(parsed);
    if (
        ownKeys.length !== 2 ||
        !Object.prototype.hasOwnProperty.call(parsed, 'schema_version') ||
        !Object.prototype.hasOwnProperty.call(parsed, 'actions')
    ) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_MANIFEST_INVALID',
            `Setup manifest envelope must contain exactly { schema_version: 1, actions: [...] }, received keys: ${JSON.stringify(ownKeys.map(String))}`
        );
    }

    if (parsed.schema_version !== 1) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_MANIFEST_INVALID',
            `Setup manifest schema_version must be 1, received: ${parsed.schema_version}`
        );
    }

    if (!Array.isArray(parsed.actions)) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_MANIFEST_INVALID',
            'Setup manifest actions must be an array'
        );
    }

    const repairedActions = [];
    for (let i = 0; i < parsed.actions.length; i++) {
        const action = parsed.actions[i];
        const normalizedProgram = typeof action?.program === 'string'
            ? action.program.toLowerCase()
            : null;
        if (
            options.repairLegacyPackageManagers === true &&
            action &&
            action.kind === 'native' &&
            PACKAGE_MANAGER_PROGRAMS.has(normalizedProgram)
        ) {
            parsed.actions[i] = {
                ...action,
                kind: 'package-manager',
                program: normalizedProgram,
            };
            repairedActions.push({
                index: i,
                from_kind: 'native',
                to_kind: 'package-manager',
                program: normalizedProgram,
            });
        }

        try {
            parseContract(SetupActionSchema, parsed.actions[i], `action[${i}]`);
        } catch (err) {
            throw new DualSetupCommandError(
                'DUAL_SETUP_ACTIONS_INVALID',
                `Setup action [${i}] failed schema validation: ${err.message}`,
                { failedIndex: i, cause: err }
            );
        }
    }

    if (repairedActions.length > 0 && options.persistRepairs !== false) {
        rawBytes = writeCanonicalSetupManifest(verifiedManifestPath, parsed, fsImpl);
    } else if (repairedActions.length > 0) {
        rawBytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    }

    const manifestSha256 = crypto.createHash('sha256').update(rawBytes).digest('hex');

    return {
        manifestSha256,
        actions: parsed.actions,
        manifestPath: verifiedManifestPath,
        repairedActions,
    };
}

function checkAndValidateReceipt(canonicalRoot, manifestSha256, actionCount, options = {}) {
    const fsImpl = (options && options.fsImpl) || (typeof options?.openSync === 'function' ? options : fs);
    const force = Boolean(options && options.force);

    const receiptPath = resolveManagedPath(canonicalRoot, ['.omni', 'runs', 'dual-setup', 'receipt.json'], { fsImpl });
    if (!fsImpl.existsSync(receiptPath)) {
        return { exists: false };
    }

    let receiptStat;
    try {
        receiptStat = fsImpl.lstatSync ? fsImpl.lstatSync(receiptPath) : fsImpl.statSync(receiptPath);
    } catch (err) {
        if (!force) {
            throw new DualSetupCommandError(
                'DUAL_SETUP_RECEIPT_CORRUPT',
                `Failed to inspect receipt file at ${receiptPath}: ${err.message}`,
                { receiptPath, cause: err }
            );
        }
        return { exists: true, corrupt: true };
    }

    if (receiptStat.isSymbolicLink && receiptStat.isSymbolicLink()) {
        if (!force) {
            throw new DualSetupCommandError(
                'DUAL_SETUP_RECEIPT_CORRUPT',
                `Receipt at ${receiptPath} is a symbolic link (runtime authority files must be regular files)`,
                { receiptPath }
            );
        }
        return { exists: true, corrupt: true };
    }

    if (receiptStat.isFile && !receiptStat.isFile()) {
        if (!force) {
            throw new DualSetupCommandError(
                'DUAL_SETUP_RECEIPT_CORRUPT',
                `Receipt at ${receiptPath} is not a regular file`,
                { receiptPath }
            );
        }
        return { exists: true, corrupt: true };
    }

    if (typeof receiptStat.size === 'number' && receiptStat.size > MAX_RECEIPT_BYTES) {
        if (!force) {
            throw new DualSetupCommandError(
                'DUAL_SETUP_RECEIPT_CORRUPT',
                `Receipt at ${receiptPath} exceeds maximum allowed size of 16 KiB (${receiptStat.size} bytes)`,
                { receiptPath }
            );
        }
        return { exists: true, corrupt: true };
    }

    let canonicalReceiptPath;
    try {
        canonicalReceiptPath = fsImpl.realpathSync?.native
            ? fsImpl.realpathSync.native(receiptPath)
            : (fsImpl.realpathSync ? fsImpl.realpathSync(receiptPath) : receiptPath);
    } catch (err) {
        if (!force) {
            throw new DualSetupCommandError(
                'DUAL_PATH_ESCAPE',
                `Cannot canonicalize receipt path ${receiptPath}: ${err.message}`,
                { receiptPath, cause: err }
            );
        }
        return { exists: true, corrupt: true };
    }
    ensureInside(canonicalRoot, canonicalReceiptPath, 'receipt.json');

    let rawBytes;
    try {
        rawBytes = fsImpl.readFileSync(receiptPath);
    } catch (err) {
        if (!force) {
            throw new DualSetupCommandError(
                'DUAL_SETUP_RECEIPT_CORRUPT',
                `Failed to read receipt at ${receiptPath}: ${err.message}`,
                { receiptPath, cause: err }
            );
        }
        return { exists: true, corrupt: true };
    }

    const byteLen = Buffer.isBuffer(rawBytes) ? rawBytes.length : Buffer.byteLength(String(rawBytes), 'utf8');
    if (byteLen > MAX_RECEIPT_BYTES) {
        if (!force) {
            throw new DualSetupCommandError(
                'DUAL_SETUP_RECEIPT_CORRUPT',
                `Receipt at ${receiptPath} exceeds maximum allowed size of 16 KiB (${byteLen} bytes)`,
                { receiptPath }
            );
        }
        return { exists: true, corrupt: true };
    }

    let raw;
    try {
        raw = JSON.parse(Buffer.isBuffer(rawBytes) ? rawBytes.toString('utf8') : String(rawBytes));
    } catch (err) {
        if (!force) {
            throw new DualSetupCommandError(
                'DUAL_SETUP_RECEIPT_CORRUPT',
                `Existing receipt at ${receiptPath} is corrupt or unparseable. Use --force to repair and rerun.`,
                { receiptPath, cause: err }
            );
        }
        return { exists: true, corrupt: true };
    }

    const result = SetupReceiptSchema.safeParse(raw);
    if (!result.success || raw.workspace_root !== canonicalRoot) {
        if (!force) {
            throw new DualSetupCommandError(
                'DUAL_SETUP_RECEIPT_CORRUPT',
                `Existing receipt at ${receiptPath} is corrupt, foreign, or invalid schema. Use --force to repair and rerun.`,
                { receiptPath, issues: result.error?.issues }
            );
        }
        return { exists: true, corrupt: true };
    }

    const validReceipt = result.data;
    if (validReceipt.manifest_sha256 === manifestSha256 && validReceipt.action_count === actionCount) {
        return {
            exists: true,
            corrupt: false,
            matching: true,
            receipt: validReceipt,
        };
    }

    return {
        exists: true,
        corrupt: false,
        matching: false,
        receipt: validReceipt,
    };
}

function evaluateSetupReadiness(workspaceRoot, options = {}) {
    const fsImpl = options.fsImpl || fs;
    let canonicalRoot;
    try {
        canonicalRoot = fsImpl.realpathSync?.native
            ? fsImpl.realpathSync.native(workspaceRoot)
            : (fsImpl.realpathSync ? fsImpl.realpathSync(workspaceRoot) : path.resolve(workspaceRoot));
    } catch (err) {
        return {
            ready: false,
            code: 'DUAL_WORKSPACE_ROOT_INVALID',
            reason: `Workspace root is invalid: ${err.message}`,
        };
    }

    const manifestPath = path.join(canonicalRoot, '.omni', 'sdlc', 'setup.json');
    if (!fsImpl.existsSync(manifestPath)) {
        return { ready: true, required: false, workspace_root: canonicalRoot };
    }

    try {
        const { manifestSha256, actions } = readAndValidateManifest(canonicalRoot, fsImpl);
        const receiptStatus = checkAndValidateReceipt(canonicalRoot, manifestSha256, actions.length, {
            fsImpl,
            force: false,
        });
        if (receiptStatus.matching) {
            return {
                ready: true,
                required: true,
                workspace_root: canonicalRoot,
                manifest_sha256: manifestSha256,
                action_count: actions.length,
                receipt: receiptStatus.receipt,
            };
        }
        return {
            ready: false,
            required: true,
            code: receiptStatus.exists ? 'DUAL_SETUP_RECEIPT_STALE' : 'DUAL_SETUP_RECEIPT_MISSING',
            reason: receiptStatus.exists
                ? 'Setup receipt does not match the current setup manifest'
                : 'Setup SUCCESS receipt is missing',
            manifest_sha256: manifestSha256,
            action_count: actions.length,
        };
    } catch (err) {
        return {
            ready: false,
            required: true,
            code: err.code || 'DUAL_SETUP_INVALID',
            reason: err.message,
        };
    }
}

function atomicRename(src, dst, fsImpl = fs) {
    fsImpl.renameSync(src, dst);
}

function writeSuccessReceipt(canonicalRoot, manifestSha256, actionCount, results, fsImpl = fs) {
    const receiptDir = resolveManagedPath(canonicalRoot, ['.omni', 'runs', 'dual-setup'], {
        createDir: true,
        requiredType: 'dir',
        fsImpl,
    });

    const nonce = crypto.randomUUID();
    const tmpPath = path.join(receiptDir, `receipt.json.tmp.${nonce}`);
    const receiptPath = path.join(receiptDir, 'receipt.json');

    const completedAt = new Date().toISOString();
    const resultsDigest = computeResultsDigest(results);

    const payload = {
        schema_version: 1,
        workspace_root: canonicalRoot,
        manifest_sha256: manifestSha256,
        action_count: actionCount,
        status: 'SUCCESS',
        completed_at: completedAt,
        results_digest: resultsDigest,
    };

    const content = JSON.stringify(payload, null, 2) + '\n';
    let fd = null;
    try {
        fd = fsImpl.openSync(tmpPath, 'w', 0o600);
        fsImpl.writeFileSync(fd, content, 'utf8');
        fsImpl.fsyncSync(fd);
        fsImpl.closeSync(fd);
        fd = null;

        atomicRename(tmpPath, receiptPath, fsImpl);

        try {
            if (typeof fsImpl.openSync === 'function' && typeof fsImpl.fsyncSync === 'function') {
                const dirFd = fsImpl.openSync(receiptDir, 'r');
                try {
                    fsImpl.fsyncSync(dirFd);
                } finally {
                    fsImpl.closeSync(dirFd);
                }
            }
        } catch {
            // Directory fsync is unsupported on some platforms
        }
    } finally {
        if (fd !== null) {
            try {
                fsImpl.closeSync(fd);
            } catch {
                // ignore
            }
            fd = null;
        }
        if (fsImpl.existsSync(tmpPath)) {
            try {
                fsImpl.unlinkSync(tmpPath);
            } catch {
                // ignore
            }
        }
    }

    return payload;
}

function readAndValidateExistingLock(lockPath, canonicalRoot, fsImpl, context = 'initial') {
    let lst;
    try {
        lst = fsImpl.lstatSync ? fsImpl.lstatSync(lockPath) : fsImpl.statSync(lockPath);
    } catch (err) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_LOCK_CORRUPT',
            `Setup lock file at ${lockPath} cannot be accessed during ${context} check: ${err.message}`,
            { lockPath, cause: err }
        );
    }

    if (lst.isSymbolicLink && lst.isSymbolicLink()) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_LOCK_CORRUPT',
            `Setup lock file at ${lockPath} is a symbolic link (symlinks rejected for runtime authority files)`,
            { lockPath }
        );
    }

    if (lst.isFile && !lst.isFile()) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_LOCK_CORRUPT',
            `Setup lock file at ${lockPath} is not a regular file`,
            { lockPath }
        );
    }

    if (typeof lst.size === 'number' && lst.size > MAX_LOCK_BYTES) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_LOCK_CORRUPT',
            `Setup lock file at ${lockPath} exceeds maximum allowed size of 16 KiB (${lst.size} bytes)`,
            { lockPath }
        );
    }

    let canonicalLock;
    try {
        canonicalLock = fsImpl.realpathSync?.native
            ? fsImpl.realpathSync.native(lockPath)
            : (fsImpl.realpathSync ? fsImpl.realpathSync(lockPath) : lockPath);
    } catch (err) {
        throw new DualSetupCommandError(
            'DUAL_PATH_ESCAPE',
            `Cannot canonicalize setup lock path ${lockPath}: ${err.message}`,
            { lockPath, cause: err }
        );
    }
    ensureInside(canonicalRoot, canonicalLock, 'setup.lock');

    let rawBytes;
    try {
        rawBytes = fsImpl.readFileSync(lockPath);
    } catch (err) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_LOCK_CORRUPT',
            `Setup lock file at ${lockPath} could not be read during ${context} check: ${err.message}`,
            { lockPath, cause: err }
        );
    }

    const byteLen = Buffer.isBuffer(rawBytes) ? rawBytes.length : Buffer.byteLength(String(rawBytes), 'utf8');
    if (byteLen > MAX_LOCK_BYTES) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_LOCK_CORRUPT',
            `Setup lock file at ${lockPath} exceeds maximum allowed size of 16 KiB (${byteLen} bytes)`,
            { lockPath }
        );
    }

    let existingRaw;
    try {
        existingRaw = JSON.parse(Buffer.isBuffer(rawBytes) ? rawBytes.toString('utf8') : String(rawBytes));
    } catch (err) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_LOCK_CORRUPT',
            `Setup lock file at ${lockPath} is corrupt or unparseable`,
            { lockPath, cause: err }
        );
    }

    const parsedLock = SetupLockSchema.safeParse(existingRaw);
    if (!parsedLock.success || existingRaw.workspace_root !== canonicalRoot) {
        throw new DualSetupCommandError(
            'DUAL_SETUP_LOCK_CORRUPT',
            `Setup lock file at ${lockPath} is invalid or belongs to another workspace`,
            { lockPath, issues: parsedLock.error?.issues }
        );
    }

    return parsedLock.data;
}

function acquireSetupLock(canonicalRoot, manifestSha256, options = {}) {
    let fsImpl = fs;
    let isProcessAlive = isPidAlive;

    if (options && typeof options === 'object') {
        if (options.fsImpl) fsImpl = options.fsImpl;
        else if (typeof options.openSync === 'function') fsImpl = options;
        if (typeof options.isProcessAlive === 'function') isProcessAlive = options.isProcessAlive;
        if (typeof options.isPidAlive === 'function') isProcessAlive = options.isPidAlive;
    } else if (options && typeof options.openSync === 'function') {
        fsImpl = options;
    }

    const runtimeDir = resolveManagedPath(canonicalRoot, ['.omni', 'runtime', 'dual'], {
        createDir: true,
        requiredType: 'dir',
        fsImpl,
    });
    const lockPath = path.join(runtimeDir, 'setup.lock');

    const nonce = crypto.randomUUID();
    const lockPayload = {
        schema_version: 1,
        workspace_root: canonicalRoot,
        pid: process.pid,
        nonce,
        started_at: new Date().toISOString(),
        manifest_sha256: manifestSha256,
    };

    const content = JSON.stringify(lockPayload, null, 2) + '\n';

    function tryAcquire() {
        let openedFd = null;
        let openedIdentity = null;
        try {
            openedFd = fsImpl.openSync(lockPath, 'wx', 0o600);
            try {
                if (typeof fsImpl.fstatSync === 'function') {
                    const fst = fsImpl.fstatSync(openedFd);
                    if (fst) {
                        openedIdentity = {
                            dev: fst.dev,
                            ino: fst.ino,
                        };
                    }
                }
            } catch {
                openedIdentity = null;
            }
            fsImpl.writeFileSync(openedFd, content, 'utf8');
            fsImpl.fsyncSync(openedFd);
            fsImpl.closeSync(openedFd);
            openedFd = null;
            return true;
        } catch (err) {
            if (openedFd !== null) {
                try {
                    fsImpl.closeSync(openedFd);
                } catch {
                    // ignore
                }
                openedFd = null;

                // Remove only our OWN partial lock file if identity still matches and is not a symlink
                try {
                    if (openedIdentity && typeof fsImpl.lstatSync === 'function') {
                        const currentLstat = fsImpl.lstatSync(lockPath);
                        if (
                            currentLstat &&
                            typeof currentLstat.isFile === 'function' &&
                            currentLstat.isFile() &&
                            (!currentLstat.isSymbolicLink || !currentLstat.isSymbolicLink()) &&
                            currentLstat.dev === openedIdentity.dev &&
                            currentLstat.ino === openedIdentity.ino
                        ) {
                            fsImpl.unlinkSync(lockPath);
                        }
                    }
                } catch {
                    // Preserve and fail closed if identity cannot be verified or unlink fails
                }
            }
            if (err && err.code === 'EEXIST') {
                return false;
            }
            throw err;
        }
    }

    if (!tryAcquire()) {
        const staleCandidate = readAndValidateExistingLock(lockPath, canonicalRoot, fsImpl, 'initial');

        if (isProcessAlive(staleCandidate.pid)) {
            throw new DualSetupCommandError(
                'DUAL_SETUP_LOCKED',
                `Setup runner is already active on workspace (PID: ${staleCandidate.pid})`,
                { lockPid: staleCandidate.pid, startedAt: staleCandidate.started_at }
            );
        }

        // Stale lock candidate detected - strictly verify on-disk lock before unlinking
        const recheck = readAndValidateExistingLock(lockPath, canonicalRoot, fsImpl, 'reclaim verification');

        if (
            recheck.nonce !== staleCandidate.nonce ||
            recheck.pid !== staleCandidate.pid ||
            recheck.workspace_root !== staleCandidate.workspace_root ||
            recheck.manifest_sha256 !== staleCandidate.manifest_sha256 ||
            recheck.started_at !== staleCandidate.started_at
        ) {
            throw new DualSetupCommandError(
                'DUAL_SETUP_LOCKED',
                `Setup lock was modified or replaced during reclaim verification at ${lockPath}`,
                { lockPid: recheck.pid, startedAt: recheck.started_at }
            );
        }

        if (isProcessAlive(recheck.pid)) {
            throw new DualSetupCommandError(
                'DUAL_SETUP_LOCKED',
                `Setup runner is active on workspace (PID: ${recheck.pid})`,
                { lockPid: recheck.pid, startedAt: recheck.started_at }
            );
        }

        try {
            fsImpl.unlinkSync(lockPath);
        } catch (err) {
            if (err && (err.code === 'ENOENT' || !fsImpl.existsSync(lockPath))) {
                // already unlinked
            } else {
                throw new DualSetupCommandError(
                    'DUAL_SETUP_LOCK_CORRUPT',
                    `Failed to unlink verified stale setup lock at ${lockPath}: ${err.message}`,
                    { lockPath, cause: err }
                );
            }
        }

        if (!tryAcquire()) {
            throw new DualSetupCommandError(
                'DUAL_SETUP_LOCKED',
                `Failed to acquire setup lock after reclaiming stale lock at ${lockPath}`
            );
        }
    }

    return {
        lockPath,
        nonce,
        release() {
            try {
                if (fsImpl.existsSync(lockPath)) {
                    if (typeof fsImpl.lstatSync === 'function') {
                        const lst = fsImpl.lstatSync(lockPath);
                        if (
                            !lst ||
                            (typeof lst.isFile === 'function' && !lst.isFile()) ||
                            (typeof lst.isSymbolicLink === 'function' && lst.isSymbolicLink()) ||
                            (typeof lst.size === 'number' && lst.size > MAX_LOCK_BYTES)
                        ) {
                            return;
                        }
                    }
                    let canonicalLock;
                    try {
                        canonicalLock = fsImpl.realpathSync?.native
                            ? fsImpl.realpathSync.native(lockPath)
                            : (fsImpl.realpathSync ? fsImpl.realpathSync(lockPath) : lockPath);
                        ensureInside(canonicalRoot, canonicalLock, 'setup.lock');
                    } catch {
                        return;
                    }
                    const rawBytes = fsImpl.readFileSync(lockPath);
                    const byteLen = Buffer.isBuffer(rawBytes) ? rawBytes.length : Buffer.byteLength(String(rawBytes), 'utf8');
                    if (byteLen > MAX_LOCK_BYTES) {
                        return;
                    }
                    const current = JSON.parse(Buffer.isBuffer(rawBytes) ? rawBytes.toString('utf8') : String(rawBytes));
                    if (
                        current &&
                        current.nonce === nonce &&
                        current.pid === process.pid &&
                        current.workspace_root === canonicalRoot
                    ) {
                        fsImpl.unlinkSync(lockPath);
                    }
                }
            } catch {
                // ignore
            }
        },
    };
}

function executeSetupManifest(options = {}) {
    const rawWorkspace = options.workspaceRoot || options.cwd || process.cwd();
    const fsImpl = options.fsImpl || fs;

    if (!fsImpl.existsSync(rawWorkspace)) {
        throw new DualSetupCommandError(
            'DUAL_WORKSPACE_ROOT_INVALID',
            `Workspace root does not exist: ${rawWorkspace}`
        );
    }

    let canonicalRoot;
    try {
        canonicalRoot = fsImpl.realpathSync?.native
            ? fsImpl.realpathSync.native(rawWorkspace)
            : (fsImpl.realpathSync ? fsImpl.realpathSync(rawWorkspace) : path.resolve(rawWorkspace));
        const stat = fsImpl.statSync(canonicalRoot);
        if (!stat.isDirectory()) {
            throw new DualSetupCommandError('DUAL_PATH_ESCAPE', `Workspace root is not a directory: ${rawWorkspace}`);
        }
    } catch (err) {
        if (err instanceof DualSetupCommandError) throw err;
        throw new DualSetupCommandError('DUAL_WORKSPACE_ROOT_INVALID', `Workspace root is invalid: ${err.message}`, { cause: err });
    }

    const dryRun = Boolean(options.dryRun);
    const { manifestSha256, actions, repairedActions } = readAndValidateManifest(
        canonicalRoot,
        fsImpl,
        {
            repairLegacyPackageManagers: true,
            persistRepairs: !dryRun,
        }
    );
    const force = Boolean(options.force);
    const env = options.env || process.env;
    const spawnSync = options.spawnSync;

    const resolver = options.resolveExecutable || createCliResolver(canonicalRoot, {
        platform: options.platform || process.platform,
        env,
        fsImpl,
        processExecPath: options.processExecPath || process.execPath,
    });

    if (dryRun) {
        const runRes = runSetupActions(actions, {
            workspaceRoot: canonicalRoot,
            env,
            spawnSync,
            resolveExecutable: resolver,
            dryRun: true,
            fsImpl,
        });

        const safeResults = runRes.results.map((r) => ({
            index: r.index,
            program: r.program,
            kind: r.kind,
            status: r.status,
        }));

        return {
            ok: true,
            dryRun: true,
            reused: false,
            workspace_root: canonicalRoot,
            manifest_sha256: manifestSha256,
            action_count: actions.length,
            repaired_actions: repairedActions,
            results: safeResults,
        };
    }

    const receiptStatus = checkAndValidateReceipt(canonicalRoot, manifestSha256, actions.length, {
        force,
        fsImpl,
    });

    if (receiptStatus.matching && !force) {
        return {
            ok: true,
            dryRun: false,
            reused: true,
            status: 'SUCCESS',
            workspace_root: canonicalRoot,
            manifest_sha256: manifestSha256,
            action_count: actions.length,
            repaired_actions: repairedActions,
            completed_at: receiptStatus.receipt.completed_at,
            results_digest: receiptStatus.receipt.results_digest,
            results: [],
        };
    }

    const lock = acquireSetupLock(canonicalRoot, manifestSha256, {
        fsImpl,
        isProcessAlive: options.isProcessAlive || options.isPidAlive || isPidAlive,
    });

    try {
        const runRes = runSetupActions(actions, {
            workspaceRoot: canonicalRoot,
            env,
            spawnSync,
            resolveExecutable: resolver,
            dryRun: false,
            fsImpl,
        });

        const receipt = writeSuccessReceipt(canonicalRoot, manifestSha256, actions.length, runRes.results, fsImpl);

        const safeResults = runRes.results.map((r) => {
            const entry = {
                index: r.index,
                program: r.program,
                kind: r.kind,
                status: r.status,
            };
            if (typeof r.duration_ms === 'number') {
                entry.duration_ms = r.duration_ms;
            }
            return entry;
        });

        return {
            ok: true,
            dryRun: false,
            reused: false,
            status: 'SUCCESS',
            workspace_root: canonicalRoot,
            manifest_sha256: manifestSha256,
            action_count: actions.length,
            repaired_actions: repairedActions,
            completed_at: receipt.completed_at,
            results_digest: receipt.results_digest,
            results: safeResults,
        };
    } finally {
        lock.release();
    }
}

module.exports = {
    executeSetupManifest,
    createCliResolver,
    readAndValidateManifest,
    checkAndValidateReceipt,
    evaluateSetupReadiness,
    writeSuccessReceipt,
    acquireSetupLock,
    computeResultsDigest,
    resolveManagedPath,
    DualSetupCommandError,
    MAX_MANIFEST_BYTES,
    MAX_RECEIPT_BYTES,
    MAX_LOCK_BYTES,
    MAX_PACKAGE_JSON_BYTES,
};
