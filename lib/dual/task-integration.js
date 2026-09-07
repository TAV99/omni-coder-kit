'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readTaskBinding, collectTaskResult, validateTaskPath } = require('./task-workspace');
const { canonicalizeEvent } = require('./authority-store');

const LOCK_PATH = '.omni/runs/dual-workspaces/integration.lock';
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function durableWrite(file, bytes) {
    const fd = fs.openSync(file, 'wx');
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readJson(root, file) {
    validateTaskPath(root, file);
    const stat = fs.lstatSync(path.join(root, file));
    if (!stat.isFile() || stat.size > 384 * 1024 * 1024) fail('DUAL_INTEGRATION_JOURNAL_INVALID', 'Invalid integration metadata file');
    return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}
function readSource(root, file) {
    validateTaskPath(root, file);
    const absolute = path.join(root, file);
    let stat;
    try { stat = fs.lstatSync(absolute); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) fail('DUAL_INTEGRATION_FILE_INVALID', 'Integration requires bounded regular files');
    const bytes = fs.readFileSync(absolute);
    return { sha256: hash(bytes), mode: stat.mode & 0o777, contentBase64: bytes.toString('base64') };
}
function same(actual, sha256, mode) {
    return sha256 === null ? actual === null : actual?.sha256 === sha256 && actual.mode === mode;
}

function validateOriginals(journal, changes) {
    const originals = journal.originals;
    if (journal.schema_version !== 1 || !originals || typeof originals !== 'object' || Array.isArray(originals)
        || canonicalizeEvent(Object.keys(originals).sort()) !== canonicalizeEvent(changes.map((change) => change.path).sort())) {
        fail('DUAL_INTEGRATION_JOURNAL_INVALID', 'Integration journal must retain every original file');
    }
    for (const change of changes) {
        const original = originals[change.path];
        if (change.beforeSha256 === null) {
            if (original !== null) fail('DUAL_INTEGRATION_JOURNAL_INVALID', 'Created file has an invalid original');
            continue;
        }
        if (!original || original.sha256 !== change.beforeSha256 || original.mode !== change.beforeMode
            || typeof original.contentBase64 !== 'string') {
            fail('DUAL_INTEGRATION_JOURNAL_INVALID', 'Original file metadata does not match bound before-state');
        }
        const bytes = Buffer.from(original.contentBase64, 'base64');
        if (bytes.toString('base64') !== original.contentBase64 || hash(bytes) !== change.beforeSha256) {
            fail('DUAL_INTEGRATION_JOURNAL_INVALID', 'Original backup bytes do not match bound before-state');
        }
    }
}

function acquireLock(root, lockFile, token) {
    for (let attempt = 0; attempt < 2; attempt++) {
        validateTaskPath(root, LOCK_PATH);
        try { durableWrite(lockFile, JSON.stringify({ pid: process.pid, token })); return true; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        const stat = fs.lstatSync(lockFile);
        if (!stat.isFile() || stat.size > 4096) fail('DUAL_INTEGRATION_LOCK_INVALID', 'Integration lock is not a bounded regular file');
        const bytes = fs.readFileSync(lockFile, 'utf8');
        let lock;
        try { lock = JSON.parse(bytes); } catch { fail('DUAL_INTEGRATION_LOCK_INVALID', 'Integration lock is malformed'); }
        if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || typeof lock.token !== 'string' || !lock.token) {
            fail('DUAL_INTEGRATION_LOCK_INVALID', 'Integration lock owner is invalid');
        }
        try { process.kill(lock.pid, 0); return false; }
        catch (error) { if (error.code !== 'ESRCH') return false; }
        validateTaskPath(root, LOCK_PATH);
        if (fs.readFileSync(lockFile, 'utf8') !== bytes) return false;
        fs.unlinkSync(lockFile);
    }
    return false;
}

// Only the controller may call this primitive. The supplied guard must consult
// current authority on every call; a worker-provided "approved" flag is not a guard.
function integrateTaskResult({ workspaceRoot, reference, result, expectedResultSha256, authorize, onProgress }) {
    const root = fs.realpathSync.native(workspaceRoot);
    const { binding } = readTaskBinding(root, reference);
    const guard = () => {
        if (typeof authorize !== 'function' || authorize({
            sessionId: binding.sessionId, taskId: binding.taskId, planRevision: binding.planRevision,
            bindingSha256: reference.bindingSha256, resultSha256: expectedResultSha256,
        }) !== true) fail('DUAL_INTEGRATION_UNAUTHORIZED', 'Current controller integration authority is required');
    };
    guard();
    if (!result || !/^[0-9a-f]{64}$/.test(expectedResultSha256 || '') || result.resultSha256 !== expectedResultSha256) {
        fail('DUAL_INTEGRATION_RESULT_INVALID', 'Expected an anchored worker result');
    }
    const measured = collectTaskResult({ workspaceRoot: root, reference });
    if (measured.resultSha256 !== expectedResultSha256 || canonicalizeEvent(measured) !== canonicalizeEvent(result)) {
        fail('DUAL_INTEGRATION_RESULT_INVALID', 'Worker result no longer matches measured scoped bytes');
    }
    validateTaskPath(root, LOCK_PATH);
    const lockFile = path.join(root, LOCK_PATH);
    const token = crypto.randomUUID();
    if (!acquireLock(root, lockFile, token)) {
        return { status: 'WAITING_FOR_INTEGRATION' };
    }

    try {
        const attemptPath = path.posix.dirname(reference.bindingPath);
        const journalPath = `${attemptPath}/integration-${expectedResultSha256}.json`;
        const receiptPath = `${attemptPath}/integrated-${expectedResultSha256}.json`;
        validateTaskPath(root, journalPath);
        validateTaskPath(root, receiptPath);
        const journalExists = fs.existsSync(path.join(root, journalPath));
        const journal = journalExists ? readJson(root, journalPath) : null;
        if (journalExists && (!journal || typeof journal !== 'object' || Array.isArray(journal))) {
            fail('DUAL_INTEGRATION_JOURNAL_INVALID', 'Integration journal must be a JSON object');
        }
        if (journal && (journal.bindingSha256 !== reference.bindingSha256 || journal.resultSha256 !== expectedResultSha256)) {
            fail('DUAL_INTEGRATION_JOURNAL_INVALID', 'Integration journal belongs to another result');
        }
        if (journal) validateOriginals(journal, measured.changes);
        const conflicts = [];
        const notApplied = [];
        const originals = Object.create(null);
        for (const change of measured.changes) {
            const actual = readSource(root, change.path);
            const before = same(actual, change.beforeSha256, change.beforeMode);
            const after = same(actual, change.afterSha256, change.afterMode);
            if (!after) notApplied.push(change.path);
            if (!before && !(journalExists && after)) conflicts.push(change.path);
            originals[change.path] = actual;
        }
        const baseline = new Map(binding.sourceFiles.map((entry) => [entry.path, entry]));
        for (const file of binding.contextFiles) {
            if (measured.changes.some((change) => change.path === file)) continue;
            const original = baseline.get(file);
            if (!same(readSource(root, file), original.sha256, original.mode)) conflicts.push(file);
        }
        if (conflicts.length) return { status: 'CONFLICT', files: [...new Set(conflicts)].sort(), journalPath: journalExists ? journalPath : null };
        if (fs.existsSync(path.join(root, receiptPath))) {
            const receipt = readJson(root, receiptPath);
            if (receipt.bindingSha256 !== reference.bindingSha256 || receipt.resultSha256 !== expectedResultSha256) {
                fail('DUAL_INTEGRATION_JOURNAL_INVALID', 'Integration receipt does not match result');
            }
            if (notApplied.length) return { status: 'CONFLICT', files: notApplied, journalPath };
            return { status: 'ALREADY_INTEGRATED', journalPath, receiptPath };
        }
        guard();
        if (!journalExists) {
            validateOriginals({ schema_version: 1, originals }, measured.changes);
            durableWrite(path.join(root, journalPath), canonicalizeEvent({ schema_version: 1,
                bindingSha256: reference.bindingSha256, resultSha256: expectedResultSha256, originals }));
        }
        for (const change of measured.changes) {
            guard();
            const current = readSource(root, change.path);
            if (same(current, change.afterSha256, change.afterMode)) continue;
            if (!same(current, change.beforeSha256, change.beforeMode)) {
                return { status: 'CONFLICT', files: [change.path], journalPath };
            }
            const target = path.join(root, change.path);
            if (change.kind === 'deleted') {
                fs.unlinkSync(target);
            } else {
                const stagedPath = `${attemptPath}/apply-${crypto.randomUUID()}.tmp`;
                validateTaskPath(root, stagedPath);
                const staged = path.join(root, stagedPath);
                durableWrite(staged, Buffer.from(change.contentBase64, 'base64'));
                fs.chmodSync(staged, change.afterMode);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                validateTaskPath(root, change.path);
                // Exclusive create protects a concurrently created destination.
                // Existing-file replacement relies on the controller's write lease.
                if (change.kind === 'created') { fs.linkSync(staged, target); fs.unlinkSync(staged); }
                else fs.renameSync(staged, target);
            }
            if (onProgress) onProgress({ path: change.path, kind: change.kind });
        }
        guard();
        const drift = measured.changes.filter((change) => !same(readSource(root, change.path), change.afterSha256, change.afterMode));
        const driftFiles = drift.map((change) => change.path);
        for (const file of binding.contextFiles) {
            if (measured.changes.some((change) => change.path === file)) continue;
            const original = baseline.get(file);
            if (!same(readSource(root, file), original.sha256, original.mode)) driftFiles.push(file);
        }
        if (driftFiles.length) return { status: 'CONFLICT', files: [...new Set(driftFiles)].sort(), journalPath };
        durableWrite(path.join(root, receiptPath), canonicalizeEvent({ schema_version: 1,
            bindingSha256: reference.bindingSha256, resultSha256: expectedResultSha256 }));
        return { status: 'INTEGRATED', journalPath, receiptPath };
    } finally {
        validateTaskPath(root, LOCK_PATH);
        if (fs.existsSync(lockFile) && readJson(root, LOCK_PATH).token === token) fs.unlinkSync(lockFile);
    }
}

module.exports = { integrateTaskResult };
