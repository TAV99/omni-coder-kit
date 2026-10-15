'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeRepoPath, repoPathKey, repoPathsOverlap } = require('./workspace');
const { assertAllowedDiff, matchesDenyPattern } = require('./scope-guard');
const { canonicalizeEvent } = require('./authority-store');

const { CANONICAL_CONTROL_PLANE_EXCLUDES } = require('./snapshot-policy');

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 10000;
const STORAGE = '.omni/runs/dual-workspaces';
const PRIVATE_PREFIXES = CANONICAL_CONTROL_PLANE_EXCLUDES;


function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}

function hash(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function excluded(file) {
    const value = file.toLowerCase();
    const parts = value.split('/');
    const name = parts.at(-1);
    return parts.some((part) => ['.git', 'node_modules', '.ssh'].includes(part))
        || PRIVATE_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix}/`))
        || ['.npmrc', '.netrc', '.pypirc', '.ds_store', 'thumbs.db'].includes(name)
        || (name === '.env' || (name.startsWith('.env.') && name !== '.env.example'))
        || /\.(pem|key|pfx|p12)$/i.test(name);
}

function safePath(root, file) {
    if (typeof file !== 'string' || file.includes('\\') || file.includes(':')
        || /[\x00-\x1f\x7f]/.test(file)
        || file.split('/').some((part) => !part || /[. ]$/.test(part)
            || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
        fail('DUAL_PATH_ESCAPE', 'Task paths must be canonical portable repository-relative paths');
    }
    const normalized = normalizeRepoPath(root, file);
    let current = root;
    for (const part of normalized.split('/')) {
        current = path.join(current, part);
        try {
            if (fs.lstatSync(current).isSymbolicLink()) fail('DUAL_PATH_ESCAPE', 'Task paths cannot use symbolic links');
        } catch (error) {
            if (error.code === 'ENOENT') break;
            throw error;
        }
    }
    return normalized;
}

function scan(root, { copying = false, runtimePath = null, dependencies = false } = {}) {
    const files = new Map();
    let total = 0;
    function visit(relative, depth) {
        if (depth > 64) fail('DUAL_TASK_WORKSPACE_LIMIT', 'Task snapshot exceeds directory depth limit');
        const directory = relative ? path.join(root, relative) : root;
        for (const name of fs.readdirSync(directory).sort()) {
            const file = relative ? `${relative}/${name}` : name;
            if (copying && excluded(file)) continue;
            const canonicalFile = safePath(root, file);
            if (dependencies && repoPathKey(canonicalFile) === 'node_modules') continue;
            if (runtimePath && repoPathKey(canonicalFile) === repoPathKey(runtimePath)) continue;
            const absolute = path.join(root, file);
            const stat = fs.lstatSync(absolute);
            if (stat.isSymbolicLink()) fail('DUAL_PATH_ESCAPE', 'Task snapshots do not copy symbolic links');
            if (stat.isDirectory()) { visit(file, depth + 1); continue; }
            if (!stat.isFile()) fail('DUAL_TASK_FILE_INVALID', 'Task snapshots require regular files');
            if (stat.size > MAX_FILE_BYTES || total + stat.size > MAX_TOTAL_BYTES || files.size >= MAX_FILES) {
                fail('DUAL_TASK_WORKSPACE_LIMIT', 'Task snapshot exceeds file or total byte limit');
            }
            const bytes = fs.readFileSync(absolute);
            if (bytes.length !== stat.size) fail('DUAL_TASK_SOURCE_CHANGED', 'Source changed during snapshot capture');
            total += bytes.length;
            files.set(canonicalFile, { path: canonicalFile, sha256: hash(bytes), size: bytes.length, mode: stat.mode & 0o777, bytes });
        }
    }
    visit('', 0);
    return files;
}

function durableWrite(file, bytes) {
    const fd = fs.openSync(file, 'wx');
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
}

function prepareTaskWorkspace({ workspaceRoot, sessionId, taskId, attempt, planRevision,
    allowedFiles, generatedOutputs = [], contextFiles = [], denyPatterns = [], managedRuntime = false, dependencyMode = 'none' }) {
    const root = fs.realpathSync.native(workspaceRoot);
    for (const id of [sessionId, taskId]) {
        if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
            fail('DUAL_TASK_BINDING_INVALID', 'Task and session IDs must be bounded identifiers');
        }
    }
    if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(planRevision) || planRevision < 1) {
        fail('DUAL_TASK_BINDING_INVALID', 'Attempt and plan revision must be positive integers');
    }
    if (!Array.isArray(allowedFiles) || allowedFiles.length === 0 || allowedFiles.length > 100
        || !Array.isArray(generatedOutputs) || generatedOutputs.length > 32
        || !Array.isArray(contextFiles) || contextFiles.length > 100
        || !Array.isArray(denyPatterns) || denyPatterns.length > 100
        || !denyPatterns.every((item) => typeof item === 'string' && item.length <= 256)) {
        fail('DUAL_TASK_BINDING_INVALID', 'Invalid task file scope');
    }
    const seenRaw = new Map();
    for (const file of [...allowedFiles, ...generatedOutputs]) {
        const key = repoPathKey(file);
        if (seenRaw.has(key)) {
            if (seenRaw.get(key) !== file) {
                fail('DUAL_TASK_SCOPE_INVALID', `Case-colliding task paths detected: ${file} and ${seenRaw.get(key)}`);
            } else {
                fail('DUAL_TASK_SCOPE_INVALID', `Duplicate task path detected: ${file}`);
            }
        }
        seenRaw.set(key, file);
    }
    const normalizedAllowedFiles = allowedFiles.map((file) => safePath(root, file));
    const normalizedGeneratedOutputs = generatedOutputs.map((file) => safePath(root, file));
    const normalizedContextFiles = contextFiles.map((file) => safePath(root, file));
    for (const file of normalizedAllowedFiles) {
        if (excluded(file)) fail('DUAL_TASK_SCOPE_INVALID', 'Task cannot own runtime or credential files');
        if (dependencyMode === 'npm-ci' && ['package.json', 'package-lock.json'].includes(file.toLowerCase())) {
            fail('DUAL_TASK_SCOPE_INVALID', 'Private dependency inputs cannot be writable worker scope');
        }
    }
    for (const generated of normalizedGeneratedOutputs) {
        if (excluded(generated) || repoPathsOverlap(generated, 'node_modules') || repoPathsOverlap(generated, '.omni')) {
            fail('DUAL_TASK_SCOPE_INVALID', 'Generated outputs cannot overlap dependencies or control-plane files');
        }
        if (normalizedAllowedFiles.some((source) => repoPathsOverlap(generated, source))) {
            fail('DUAL_TASK_SCOPE_INVALID', `Generated output overlaps source scope: ${generated}`);
        }
    }
    assertAllowedDiff({ changedFiles: normalizedAllowedFiles, allowedFiles: normalizedAllowedFiles, denyPatterns });
    const attemptPath = `${STORAGE}/${hash(sessionId).slice(0, 16)}/${hash(taskId).slice(0, 16)}/attempt-${attempt}`;
    safePath(root, attemptPath);
    if (fs.existsSync(path.join(root, attemptPath))) {
        fail('DUAL_TASK_WORKSPACE_EXISTS', 'Task attempt already exists; reuse its binding or choose a new attempt');
    }
    const snapshot = scan(root, { copying: true });
    for (const generated of normalizedGeneratedOutputs) {
        for (const existingFile of snapshot.keys()) {
            if (repoPathsOverlap(generated, existingFile)) {
                fail('DUAL_TASK_SCOPE_INVALID', `Generated output overlaps repository source file: ${generated}`);
            }
        }
    }
    const seenCasedPaths = new Map();
    for (const file of [...normalizedAllowedFiles, ...normalizedGeneratedOutputs]) {
        const key = repoPathKey(file);
        if (seenCasedPaths.has(key) && seenCasedPaths.get(key) !== file) {
            fail('DUAL_TASK_SCOPE_INVALID', `Case-colliding task paths detected: ${file} and ${seenCasedPaths.get(key)}`);
        }
        seenCasedPaths.set(key, file);
    }
    for (const existingFile of snapshot.keys()) {
        const existingKey = repoPathKey(existingFile);
        for (const file of [...normalizedAllowedFiles, ...normalizedGeneratedOutputs]) {
            if (repoPathKey(file) === existingKey && file !== existingFile) {
                fail('DUAL_TASK_SCOPE_INVALID', `Task path case-collides with existing repository file: ${file} vs ${existingFile}`);
            }
        }
    }
    for (const file of normalizedContextFiles) {
        if (!snapshot.has(file)) fail('DUAL_TASK_CONTEXT_UNAVAILABLE', 'Registered context is missing or excluded from worker snapshot');
    }
    const workerPath = `${attemptPath}/workspace`;
    const workerRoot = path.join(root, workerPath);
    fs.mkdirSync(path.dirname(path.join(root, attemptPath)), { recursive: true });
    safePath(root, attemptPath);
    fs.mkdirSync(path.join(root, attemptPath)); // exclusive attempt claim
    fs.mkdirSync(workerRoot);
    for (const [file, entry] of snapshot) {
        safePath(workerRoot, file);
        const target = path.join(workerRoot, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        durableWrite(target, entry.bytes);
        fs.chmodSync(target, entry.mode);
    }
    const sourceFiles = [...snapshot.values()].map(({ bytes, ...entry }) => entry);
    const binding = {
        schema_version: 1, sessionId, taskId, attempt, planRevision,
        sourceRoot: root, workerPath, allowedFiles: normalizedAllowedFiles, generated_outputs: normalizedGeneratedOutputs,
        contextFiles: normalizedContextFiles, denyPatterns, sourceFiles,
        snapshotSha256: hash(canonicalizeEvent(sourceFiles)),
        ...(managedRuntime === true ? { runtimePath: `.omni/codex-gemini/runs/${taskId}` } : {}),
        ...(dependencyMode === 'npm-ci' ? { dependencyMode } : {}),
    };
    const bytes = `${canonicalizeEvent(binding)}\n`;
    const bindingPath = `${attemptPath}/binding.json`;
    durableWrite(path.join(root, bindingPath), bytes);
    return { workerRoot, bindingPath, bindingSha256: hash(bytes),
        workerEnv: { GIT_CEILING_DIRECTORIES: path.dirname(workerRoot).replace(/\\/g, '/') },
        workerEnvUnset: ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'] };
}

function readTaskBinding(workspaceRoot, reference) {
    const root = fs.realpathSync.native(workspaceRoot);
    if (!reference || typeof reference.bindingPath !== 'string' || !reference.bindingPath.startsWith(`${STORAGE}/`)
        || !/^[0-9a-f]{64}$/.test(reference.bindingSha256 || '')) {
        fail('DUAL_TASK_BINDING_INVALID', 'Expected an anchored task binding');
    }
    safePath(root, reference.bindingPath);
    const absolute = path.join(root, reference.bindingPath);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) fail('DUAL_TASK_BINDING_INVALID', 'Invalid task binding file');
    const bytes = fs.readFileSync(absolute);
    if (hash(bytes) !== reference.bindingSha256) fail('DUAL_TASK_BINDING_INVALID', 'Task binding hash mismatch');
    const binding = JSON.parse(bytes.toString('utf8'));
    const expectedPath = `${STORAGE}/${hash(binding.sessionId).slice(0, 16)}/${hash(binding.taskId).slice(0, 16)}/attempt-${binding.attempt}`;
    if (binding.schema_version !== 1 || binding.sourceRoot !== root
        || reference.bindingPath !== `${expectedPath}/binding.json` || binding.workerPath !== `${expectedPath}/workspace`
        || hash(canonicalizeEvent(binding.sourceFiles)) !== binding.snapshotSha256) {
        fail('DUAL_TASK_BINDING_INVALID', 'Task binding does not match its workspace or snapshot');
    }
    safePath(root, binding.workerPath);
    return { binding, workerRoot: path.join(root, binding.workerPath) };
}

const EPHEMERAL_FILE_PATTERNS = [
    /(?:^|\/)tsconfig(?:\.[a-z0-9_-]+)?\.tsbuildinfo$/i,
    /(?:^|\/)\.(?:eslintcache|prettiercache|stylelintcache)$/i,
    /(?:^|\/)\.vitest-reports(?:\/|$)/i,
    /(?:^|\/)coverage(?:\/|$)/i,
    /(?:^|\/)\.(?:turbo|parcel-cache|svelte-kit|nuxt|astro)(?:\/|$)/i,
];

function isEphemeralWorkspaceArtifact(file) {
    const norm = String(file || '').replace(/\\/g, '/');
    return EPHEMERAL_FILE_PATTERNS.some((re) => re.test(norm));
}

function scrubEphemeralAndDeniedUntrackedArtifacts(workerRoot, binding) {
    if (!workerRoot || !binding || !fs.existsSync(workerRoot)) return;
    const originalPaths = new Set((binding.sourceFiles || []).map((e) => repoPathKey(typeof e === 'string' ? e : e.path)));
    const allowedPaths = new Set((binding.allowedFiles || []).map((f) => repoPathKey(f)));
    const generatedOutputs = (binding.generated_outputs || binding.generatedOutputs || []).map((f) => String(f).replace(/\\/g, '/'));
    const denyPatterns = binding.denyPatterns || [];

    function walkDir(dir) {
        let entries = [];
        try {
            entries = fs.readdirSync(dir);
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry);
            let stat;
            try {
                stat = fs.lstatSync(fullPath);
            } catch {
                continue;
            }

            if (stat.isSymbolicLink()) continue;

            const relPath = path.relative(workerRoot, fullPath).replace(/\\/g, '/');
            if (!relPath || relPath.startsWith('..')) continue;

            if (relPath === '.omni' || relPath.startsWith('.omni/') || relPath === 'node_modules' || relPath.startsWith('node_modules/')) {
                continue;
            }
            if (binding.runtimePath && (relPath === binding.runtimePath || relPath.startsWith(`${binding.runtimePath}/`))) {
                continue;
            }

            if (stat.isDirectory()) {
                walkDir(fullPath);
                try {
                    if (fs.existsSync(fullPath) && fs.readdirSync(fullPath).length === 0) {
                        fs.rmdirSync(fullPath);
                    }
                } catch {}
            } else if (stat.isFile()) {
                const key = repoPathKey(relPath);
                if (originalPaths.has(key)) {
                    continue;
                }
                if (allowedPaths.has(key)) {
                    continue;
                }
                if (generatedOutputs.some((prefix) => repoPathsOverlap(relPath, prefix))) {
                    continue;
                }

                const isEphemeral = isEphemeralWorkspaceArtifact(relPath);
                const isDenied = denyPatterns.some((pattern) => matchesDenyPattern(relPath, pattern));

                if (isEphemeral || isDenied) {
                    try {
                        fs.unlinkSync(fullPath);
                    } catch {}
                }
            }
        }
    }

    walkDir(workerRoot);
}

function collectTaskResult({ workspaceRoot, reference, skipDependencyVerification = false }) {
    const { binding, workerRoot } = readTaskBinding(workspaceRoot, reference);
    if (binding.dependencyMode !== 'npm-ci' && fs.existsSync(path.join(workerRoot, 'node_modules'))) {
        fail('DUAL_TASK_DEPENDENCY_MODE_REQUIRED', 'Worker dependency tree requires an approved dependency mode and immutable setup receipt');
    }
    if (binding.dependencyMode === 'npm-ci' && !skipDependencyVerification) {
        const { verifyPrivateDependencies } = require('./private-dependencies');
        verifyPrivateDependencies({ workerRoot, artifactRoot: path.dirname(path.join(workspaceRoot, reference.bindingPath)),
            reference: reference.workerDependencies });
    }
    scrubEphemeralAndDeniedUntrackedArtifacts(workerRoot, binding);
    const current = scan(workerRoot, { runtimePath: binding.runtimePath || null, dependencies: binding.dependencyMode === 'npm-ci' });
    const original = new Map(binding.sourceFiles.map((entry) => [entry.path, entry]));
    const changes = [];
    for (const file of [...new Set([...original.keys(), ...current.keys()])].sort()) {
        const before = original.get(file), after = current.get(file);
        if (before && after && before.sha256 === after.sha256 && before.mode === after.mode) continue;
        changes.push({ path: file, kind: !before ? 'created' : !after ? 'deleted' : 'modified',
            beforeSha256: before?.sha256 || null, afterSha256: after?.sha256 || null,
            beforeMode: before?.mode ?? null, afterMode: after?.mode ?? null,
            contentBase64: after ? after.bytes.toString('base64') : null });
    }
    assertAllowedDiff({ changedFiles: changes.map((entry) => entry.path), allowedFiles: binding.allowedFiles,
        denyPatterns: binding.denyPatterns });
    const payload = { schema_version: 1, bindingSha256: reference.bindingSha256,
        sessionId: binding.sessionId, taskId: binding.taskId, attempt: binding.attempt,
        planRevision: binding.planRevision, changes };
    return { ...payload, resultSha256: hash(canonicalizeEvent(payload)) };
}

async function collectTaskResultAsync({ workspaceRoot, reference, onTick, signal } = {}) {
    const { binding, workerRoot } = readTaskBinding(workspaceRoot, reference);
    if (binding.dependencyMode === 'npm-ci') {
        const { verifyPrivateDependenciesAsync } = require('./private-dependencies');
        await verifyPrivateDependenciesAsync({
            workerRoot,
            artifactRoot: path.dirname(path.join(workspaceRoot, reference.bindingPath)),
            reference: reference.workerDependencies,
            onTick,
            signal,
        });
    }
    return collectTaskResult({ workspaceRoot, reference, skipDependencyVerification: true });
}

module.exports = {
    prepareTaskWorkspace,
    collectTaskResult,
    collectTaskResultAsync,
    readTaskBinding,
    validateTaskPath: safePath,
    isExcludedTaskPath: excluded,
    isEphemeralWorkspaceArtifact,
    scrubEphemeralAndDeniedUntrackedArtifacts,
};
