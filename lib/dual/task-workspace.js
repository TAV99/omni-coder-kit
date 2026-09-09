'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeRepoPath } = require('./workspace');
const { assertAllowedDiff } = require('./scope-guard');
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
            safePath(root, file);
            if (dependencies && file === 'node_modules') continue;
            if (runtimePath && file === runtimePath) continue;
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
            files.set(file, { path: file, sha256: hash(bytes), size: bytes.length, mode: stat.mode & 0o777, bytes });
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
    allowedFiles, contextFiles = [], denyPatterns = [], managedRuntime = false, dependencyMode = 'none' }) {
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
        || !Array.isArray(contextFiles) || contextFiles.length > 100
        || !Array.isArray(denyPatterns) || denyPatterns.length > 100
        || !denyPatterns.every((item) => typeof item === 'string' && item.length <= 256)) {
        fail('DUAL_TASK_BINDING_INVALID', 'Invalid task file scope');
    }
    for (const file of [...allowedFiles, ...contextFiles]) safePath(root, file);
    for (const file of allowedFiles) {
        if (excluded(file)) fail('DUAL_TASK_SCOPE_INVALID', 'Task cannot own runtime or credential files');
        if (dependencyMode === 'npm-ci' && ['package.json', 'package-lock.json'].includes(file.toLowerCase())) {
            fail('DUAL_TASK_SCOPE_INVALID', 'Private dependency inputs cannot be writable worker scope');
        }
    }
    assertAllowedDiff({ changedFiles: allowedFiles, allowedFiles, denyPatterns });
    const attemptPath = `${STORAGE}/${hash(sessionId).slice(0, 16)}/${hash(taskId).slice(0, 16)}/attempt-${attempt}`;
    safePath(root, attemptPath);
    if (fs.existsSync(path.join(root, attemptPath))) {
        fail('DUAL_TASK_WORKSPACE_EXISTS', 'Task attempt already exists; reuse its binding or choose a new attempt');
    }
    const snapshot = scan(root, { copying: true });
    for (const file of contextFiles) {
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
        sourceRoot: root, workerPath, allowedFiles, contextFiles, denyPatterns, sourceFiles,
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

function collectTaskResult({ workspaceRoot, reference }) {
    const { binding, workerRoot } = readTaskBinding(workspaceRoot, reference);
    if (binding.dependencyMode !== 'npm-ci' && fs.existsSync(path.join(workerRoot, 'node_modules'))) {
        fail('DUAL_TASK_DEPENDENCY_MODE_REQUIRED', 'Worker dependency tree requires an approved dependency mode and immutable setup receipt');
    }
    if (binding.dependencyMode === 'npm-ci') {
        const { verifyPrivateDependencies } = require('./private-dependencies');
        verifyPrivateDependencies({ workerRoot, artifactRoot: path.dirname(path.join(workspaceRoot, reference.bindingPath)),
            reference: reference.workerDependencies });
    }
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

module.exports = { prepareTaskWorkspace, collectTaskResult, readTaskBinding, validateTaskPath: safePath };
