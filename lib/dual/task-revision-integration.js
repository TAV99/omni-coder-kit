'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalizeEvent } = require('./authority-store');
const { prepareTaskWorkspace, readTaskBinding, collectTaskResult, validateTaskPath,
    sourceSnapshotFingerprint, sourceSnapshotManifest } = require('./task-workspace');

const STORAGE = '.omni/runs/dual-workspaces';
const LOCK = `${STORAGE}/integration.lock`;
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function durableWrite(file, bytes) {
    const fd = fs.openSync(file, 'wx');
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function readJson(root, relative) {
    validateTaskPath(root, relative);
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.size > 384 * 1024 * 1024) fail('DUAL_REVISION_JOURNAL_INVALID', 'Expected bounded regular journal');
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
}
function source(root, relative) {
    validateTaskPath(root, relative);
    const file = path.join(root, relative);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) fail('DUAL_REVISION_FILE_INVALID', 'Revision requires bounded regular files');
    const bytes = fs.readFileSync(file);
    return { sha256: hash(bytes), mode: stat.mode & 0o777, contentBase64: bytes.toString('base64') };
}
function same(current, digest, mode) { return digest === null ? current === null : current?.sha256 === digest && current.mode === mode; }
function identity(binding, reference, digest, phase) {
    return { sessionId: binding.sessionId, taskId: binding.taskId, revisionId: binding.revisionId,
        attempt: binding.attempt, planRevision: binding.planRevision, contractDigest: binding.contractDigest,
        bindingSha256: reference.bindingSha256, resultSha256: digest, candidateDigest: digest, phase };
}
function guard(authorize, details) {
    if (typeof authorize !== 'function' || authorize(details) !== true) fail('DUAL_INTEGRATION_UNAUTHORIZED', 'Current candidate controller authority is required');
}
function withLock(root, work) {
    validateTaskPath(root, LOCK);
    const file = path.join(root, LOCK);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const token = crypto.randomUUID();
    for (let trial = 0; trial < 2; trial++) {
        try { durableWrite(file, canonicalizeEvent({ pid: process.pid, token })); break; }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const prior = readJson(root, LOCK);
            if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0 || typeof prior.token !== 'string') fail('DUAL_INTEGRATION_LOCK_INVALID', 'Invalid integration lock');
            try { process.kill(prior.pid, 0); return { status: 'WAITING_FOR_INTEGRATION' }; }
            catch (probe) { if (probe.code !== 'ESRCH') return { status: 'WAITING_FOR_INTEGRATION' }; }
            if (trial || readJson(root, LOCK).token !== prior.token) return { status: 'WAITING_FOR_INTEGRATION' };
            fs.unlinkSync(file);
        }
    }
    const release = () => { if (fs.existsSync(file) && readJson(root, LOCK).token === token) fs.unlinkSync(file); };
    try {
        const result = work();
        if (result && typeof result.then === 'function') return result.finally(release);
        release(); return result;
    } catch (error) { release(); throw error; }
}
function phasePrefix(journalPath) { return `${journalPath.slice(0, -5)}-phase-`; }
function phases(root, journalPath) {
    const directory = path.posix.dirname(journalPath);
    const prefix = path.posix.basename(phasePrefix(journalPath));
    let previous = hash(fs.readFileSync(path.join(root, journalPath)));
    const list = fs.readdirSync(path.join(root, directory)).filter((name) => name.startsWith(prefix) && name.endsWith('.json')).sort();
    const result = [];
    for (const [index, name] of list.entries()) {
        const relative = `${directory}/${name}`;
        const record = readJson(root, relative);
        if (record.previous_sha256 !== previous || record.sequence !== index + 1) fail('DUAL_REVISION_JOURNAL_INVALID', 'Promotion phase hash chain is invalid');
        previous = hash(fs.readFileSync(path.join(root, relative)));
        result.push(record);
    }
    return { records: result, previous };
}
function appendPhase(root, journalPath, phase, details = {}) {
    const prior = phases(root, journalPath);
    const journal = readJson(root, journalPath);
    const boundIdentity = { session_id: journal.session_id, task_id: journal.task_id, revision_id: journal.revision_id,
        attempt: journal.attempt, candidate_sha256: journal.candidate_sha256, contract_digest: journal.contract_digest };
    const sequence = prior.records.length + 1;
    const relative = `${phasePrefix(journalPath)}${String(sequence).padStart(5, '0')}.json`;
    durableWrite(path.join(root, relative), canonicalizeEvent({ sequence, previous_sha256: prior.previous,
        ...boundIdentity, phase, ...details }));
    return relative;
}
function readJournal(root, journalPath) {
    if (typeof journalPath !== 'string' || !journalPath.startsWith(`${STORAGE}/`) || !/\/promotion-[0-9a-f]{64}\.json$/.test(journalPath)) {
        fail('DUAL_REVISION_JOURNAL_INVALID', 'Expected revision promotion journal');
    }
    const journal = readJson(root, journalPath);
    if (journal.schema_version !== 1 || !journal.identity?.revisionId || !Array.isArray(journal.changes)
        || !journal.originals || journal.identity.resultSha256 !== journalPath.match(/promotion-([0-9a-f]{64})\.json$/)[1]) {
        fail('DUAL_REVISION_JOURNAL_INVALID', 'Invalid revision journal identity');
    }
    for (const change of journal.changes) {
        validateTaskPath(root, change.path);
        const original = journal.originals[change.path];
        if (change.beforeSha256 === null ? original !== null
            : !original || original.sha256 !== change.beforeSha256 || original.mode !== change.beforeMode
                || hash(Buffer.from(original.contentBase64, 'base64')) !== change.beforeSha256) {
            fail('DUAL_REVISION_JOURNAL_INVALID', 'Invalid rollback preimage');
        }
        if (change.afterSha256 !== null && hash(Buffer.from(change.contentBase64, 'base64')) !== change.afterSha256) {
            fail('DUAL_REVISION_JOURNAL_INVALID', 'Invalid candidate bytes');
        }
    }
    return journal;
}
function reconcileRevisionPromotions({ workspaceRoot }) {
    const root = fs.realpathSync.native(workspaceRoot);
    const journals = [];
    function walk(relative) {
        if (!fs.existsSync(path.join(root, relative))) return;
        validateTaskPath(root, relative);
        for (const name of fs.readdirSync(path.join(root, relative))) {
            const file = `${relative}/${name}`;
            validateTaskPath(root, file);
            const stat = fs.lstatSync(path.join(root, file));
            if (stat.isDirectory() && name !== 'workspace') walk(file);
            else if (/^promotion-[0-9a-f]{64}\.json$/.test(name)) {
                const journal = readJournal(root, file);
                const phase = phases(root, file).records.at(-1)?.phase || 'PREPARED';
                if (!['PROMOTED', 'ROLLED_BACK'].includes(phase)) journals.push({ journalPath: file, phase, identity: journal.identity });
            }
        }
    }
    walk(STORAGE);
    return { status: journals.length ? 'RECONCILIATION_REQUIRED' : 'CLEAR', journals };
}
function prepareRevisionWorkspace(options) {
    if (!options.revisionId || !/^[0-9a-f]{64}$/.test(options.expectedSourceFingerprint || '')) fail('DUAL_REVISION_BINDING_INVALID', 'Revision and pinned source fingerprint required');
    if (sourceSnapshotFingerprint(options.workspaceRoot) !== options.expectedSourceFingerprint) fail('DUAL_REVISION_SOURCE_STALE', 'Integrated source fingerprint changed');
    if (reconcileRevisionPromotions(options).status !== 'CLEAR') fail('DUAL_REVISION_RECONCILIATION_REQUIRED', 'Pending promotion must be reconciled before a new writer');
    const reference = prepareTaskWorkspace(options);
    const { binding } = readTaskBinding(options.workspaceRoot, reference);
    if (binding.snapshotSha256 !== options.expectedSourceFingerprint || sourceSnapshotFingerprint(options.workspaceRoot) !== binding.snapshotSha256) {
        fail('DUAL_REVISION_SOURCE_STALE', 'Integrated source changed during snapshot capture');
    }
    return { ...reference, revisionId: binding.revisionId, contractDigest: binding.contractDigest, sourceFingerprint: binding.snapshotSha256 };
}
function restore(root, journalPath, authorize) {
    const journal = readJournal(root, journalPath);
    guard(authorize, { ...journal.identity, phase: 'rollback' });
    const last = phases(root, journalPath).records.at(-1)?.phase;
    if (last === 'PROMOTED') fail('DUAL_REVISION_ROLLBACK_FORBIDDEN', 'A promoted version cannot be rolled back as an unpromoted candidate');
    if (last === 'ROLLED_BACK') return { status: 'ROLLED_BACK', journalPath };
    const drift = journal.changes.filter((change) => {
        const current = source(root, change.path);
        return !same(current, change.afterSha256, change.afterMode) && !same(current, change.beforeSha256, change.beforeMode);
    }).map((change) => change.path);
    if (drift.length) { appendPhase(root, journalPath, 'RECONCILIATION_REQUIRED', { files: drift }); return { status: 'RECONCILIATION_REQUIRED', files: drift, journalPath }; }
    appendPhase(root, journalPath, 'ROLLING_BACK');
    for (const change of journal.changes) {
        const current = source(root, change.path);
        if (same(current, change.beforeSha256, change.beforeMode)) continue;
        if (!same(current, change.afterSha256, change.afterMode)) {
            appendPhase(root, journalPath, 'RECONCILIATION_REQUIRED', { files: [change.path] });
            return { status: 'RECONCILIATION_REQUIRED', files: [change.path], journalPath };
        }
        const original = journal.originals[change.path];
        writeSource(root, change.path, original, path.posix.dirname(journalPath), change.afterSha256 === null);
    }
    const rollbackPhasePath = appendPhase(root, journalPath, 'ROLLED_BACK');
    return { status: 'ROLLED_BACK', journalPath, rollbackComplete: true, rollbackPhasePath,
        rollbackPhaseSha256: hash(fs.readFileSync(path.join(root, rollbackPhasePath))) };
}
function writeSource(root, relative, entry, stagingDirectory, expectedMissing = false) {
    validateTaskPath(root, relative);
    const target = path.join(root, relative);
    if (entry === null) {
        if (fs.existsSync(target)) {
            fs.unlinkSync(target);
            const dir = fs.openSync(path.dirname(target), 'r');
            try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
        }
        return;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${stagingDirectory}/write-${crypto.randomUUID()}.tmp`;
    validateTaskPath(root, temporary);
    durableWrite(path.join(root, temporary), Buffer.from(entry.contentBase64, 'base64'));
    fs.chmodSync(path.join(root, temporary), entry.mode);
    const staged = fs.openSync(path.join(root, temporary), 'r');
    try { fs.fsyncSync(staged); } finally { fs.closeSync(staged); }
    if (expectedMissing) { fs.linkSync(path.join(root, temporary), target); fs.unlinkSync(path.join(root, temporary)); }
    else fs.renameSync(path.join(root, temporary), target);
    const dir = fs.openSync(path.dirname(target), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function rollbackRevisionPromotion({ workspaceRoot, journalPath, authorize }) {
    const root = fs.realpathSync.native(workspaceRoot);
    return withLock(root, () => restore(root, journalPath, authorize));
}
async function promoteRevisionResult({ workspaceRoot, reference, result, expectedResultSha256, authorize, runChecks, onProgress, onPrepared }) {
    const root = fs.realpathSync.native(workspaceRoot);
    const { binding, workerRoot } = readTaskBinding(root, reference);
    if (!binding.revisionId) fail('DUAL_REVISION_BINDING_INVALID', 'Candidate-specific binding required');
    const details = identity(binding, reference, expectedResultSha256, 'pre_integration');
    const eventIdentity = { session_id: binding.sessionId, task_id: binding.taskId, revision_id: binding.revisionId,
        attempt: binding.attempt, candidate_sha256: expectedResultSha256, contract_digest: binding.contractDigest };
    guard(authorize, details);
    const measured = collectTaskResult({ workspaceRoot: root, reference, readOnly: true });
    if (measured.resultSha256 !== expectedResultSha256 || canonicalizeEvent(measured) !== canonicalizeEvent(result)) fail('DUAL_INTEGRATION_RESULT_INVALID', 'Candidate result changed');
    if (typeof runChecks !== 'function') fail('DUAL_REVISION_EVIDENCE_REQUIRED', 'Controller-owned full contract checks are required');
    return withLock(root, async () => {
        const pending = reconcileRevisionPromotions({ workspaceRoot: root });
        if (pending.status !== 'CLEAR') return pending;
        if (sourceSnapshotFingerprint(root) !== binding.snapshotSha256) return { status: 'RECONCILIATION_REQUIRED', reason: 'SOURCE_DRIFT' };
        async function check(phase) {
            guard(authorize, { ...details, phase });
            const checked = await runChecks({ phase, candidateDigest: expectedResultSha256, workerRoot, workspaceRoot: root,
                revisionId: binding.revisionId, attempt: binding.attempt, executionId: crypto.randomUUID() });
            if (!checked || checked.status !== 'PASSED' || checked.candidateDigest !== expectedResultSha256
                || !Array.isArray(checked.evidence) || !checked.evidence.length
                || !checked.evidence.every((ref) => typeof ref.path === 'string' && /^[0-9a-f]{64}$/.test(ref.sha256 || ''))) {
                fail('DUAL_REVISION_CHECK_FAILED', 'Fresh full-contract check and independent review evidence required');
            }
            for (const ref of checked.evidence) {
                validateTaskPath(root, ref.path);
                const evidence = source(root, ref.path);
                if (!evidence || evidence.sha256 !== ref.sha256) fail('DUAL_REVISION_CHECK_FAILED', 'Check evidence reference is missing or has changed');
            }
            return checked;
        }
        const pre = await check('pre_integration');
        if (collectTaskResult({ workspaceRoot: root, reference, readOnly: true }).resultSha256 !== expectedResultSha256
            || sourceSnapshotFingerprint(root) !== binding.snapshotSha256) return { status: 'RECONCILIATION_REQUIRED', reason: 'CHECK_SOURCE_DRIFT' };
        const attemptPath = path.posix.dirname(reference.bindingPath);
        const journalPath = `${attemptPath}/promotion-${expectedResultSha256}.json`;
        const originals = Object.fromEntries(measured.changes.map((change) => [change.path, source(root, change.path)]));
        durableWrite(path.join(root, journalPath), canonicalizeEvent({ schema_version: 1, ...eventIdentity,
            phase: 'PREPARED', identity: details,
            sourceFingerprint: binding.snapshotSha256, changes: measured.changes, originals }));
        appendPhase(root, journalPath, 'PREPARED', { evidence: pre.evidence });
        try {
            if (onPrepared) await onPrepared({ journalPath, journalSha256: hash(fs.readFileSync(path.join(root, journalPath))),
                candidateDigest: expectedResultSha256 });
            appendPhase(root, journalPath, 'APPLYING');
            for (const change of measured.changes) {
                guard(authorize, { ...details, phase: 'apply' });
                if (!same(source(root, change.path), change.beforeSha256, change.beforeMode)) fail('DUAL_REVISION_SOURCE_STALE', 'Source drift during exclusive integration');
                writeSource(root, change.path, change.afterSha256 === null ? null : { contentBase64: change.contentBase64, mode: change.afterMode },
                    attemptPath, change.beforeSha256 === null);
                if (onProgress) onProgress({ path: change.path, kind: change.kind, journalPath });
            }
            appendPhase(root, journalPath, 'APPLIED');
            const post = await check('post_integration');
            if (post.evidence.some((ref) => pre.evidence.some((old) => old.path === ref.path))) {
                fail('DUAL_REVISION_CHECK_FAILED', 'Post-integration checks require fresh evidence');
            }
            const drift = measured.changes.filter((change) => !same(source(root, change.path), change.afterSha256, change.afterMode));
            if (drift.length) fail('DUAL_REVISION_SOURCE_STALE', 'Integrated bytes changed during post-check');
            const expectedManifest = Object.fromEntries(binding.sourceFiles.map((entry) => [entry.path, entry]));
            for (const change of measured.changes) {
                if (change.afterSha256 === null) delete expectedManifest[change.path];
                else expectedManifest[change.path] = { path: change.path, sha256: change.afterSha256, mode: change.afterMode,
                    size: Buffer.from(change.contentBase64, 'base64').length };
            }
            const currentManifest = Object.fromEntries(sourceSnapshotManifest(root).map((entry) => [entry.path, entry]));
            if (canonicalizeEvent(currentManifest) !== canonicalizeEvent(expectedManifest)) {
                fail('DUAL_REVISION_SOURCE_STALE', 'Source fingerprint changed outside candidate files during integration');
            }
            const receiptPath = `${attemptPath}/revision-integrated-${expectedResultSha256}.json`;
            const receiptBytes = canonicalizeEvent({ schema_version: 1, ...details, ...eventIdentity, phase: 'CHECKED',
                commands: [...(pre.commands || []), ...(post.commands || [])],
                review_evidence: [...(pre.review_evidence || []), ...(post.review_evidence || [])],
                pre_evidence: pre.evidence, post_evidence: post.evidence, integratedFingerprint: sourceSnapshotFingerprint(root) });
            durableWrite(path.join(root, receiptPath), receiptBytes);
            appendPhase(root, journalPath, 'CHECKED', { receiptPath, receiptSha256: hash(receiptBytes) });
            return { status: 'CHECKED', journalPath, receiptPath, receiptSha256: hash(receiptBytes), candidateDigest: expectedResultSha256 };
        } catch (error) {
            const rollback = restore(root, journalPath, authorize);
            return { ...rollback, error: { code: error.code || 'DUAL_REVISION_PROMOTION_FAILED', message: error.message } };
        }
    });
}
function readCheckedRevisionPromotion({ workspaceRoot, journalPath }) {
    const root = fs.realpathSync.native(workspaceRoot);
    const journal = readJournal(root, journalPath);
    const state = phases(root, journalPath).records.at(-1);
    if (state?.phase !== 'CHECKED') return { status: 'RECONCILIATION_REQUIRED', journalPath,
        phase: state?.phase || 'PREPARED' };
    const receiptPath = validateTaskPath(root, state.receiptPath);
    const receipt = readJson(root, receiptPath);
    const receiptSha256 = hash(fs.readFileSync(path.join(root, receiptPath)));
    if (receiptSha256 !== state.receiptSha256 || receipt.phase !== 'CHECKED'
        || ['session_id', 'task_id', 'revision_id', 'attempt', 'candidate_sha256', 'contract_digest']
            .some((key) => receipt[key] !== journal[key])) {
        fail('DUAL_REVISION_JOURNAL_INVALID', 'Checked receipt identity or hash does not match promotion journal');
    }
    for (const reference of [...(receipt.pre_evidence || []), ...(receipt.post_evidence || [])]) {
        const artifact = source(root, reference.path);
        if (!artifact || artifact.sha256 !== reference.sha256) fail('DUAL_REVISION_JOURNAL_INVALID', 'Promotion check evidence changed');
    }
    if (sourceSnapshotFingerprint(root) !== receipt.integratedFingerprint
        || journal.changes.some((change) => !same(source(root, change.path), change.afterSha256, change.afterMode))) {
        return { status: 'RECONCILIATION_REQUIRED', journalPath, phase: 'CHECKED', reason: 'SOURCE_DRIFT' };
    }
    return { status: 'CHECKED', journalPath, receiptPath, receiptSha256, candidateDigest: journal.candidate_sha256,
        identity: journal.identity, receipt };
}
function finalizeRevisionPromotion({ workspaceRoot, journalPath, authorize }) {
    const root = fs.realpathSync.native(workspaceRoot);
    return withLock(root, () => {
        const journal = readJournal(root, journalPath);
        guard(authorize, { ...journal.identity, phase: 'finalize_promoted' });
        const state = phases(root, journalPath).records.at(-1);
        if (state?.phase === 'PROMOTED') return { status: 'PROMOTED', journalPath };
        if (state?.phase !== 'CHECKED') fail('DUAL_REVISION_RECONCILIATION_REQUIRED', 'Promotion requires checked durable receipt and authority event');
        const receipt = fs.readFileSync(path.join(root, validateTaskPath(root, state.receiptPath)));
        if (hash(receipt) !== state.receiptSha256) fail('DUAL_REVISION_JOURNAL_INVALID', 'Promotion receipt changed');
        if (sourceSnapshotFingerprint(root) !== JSON.parse(receipt.toString('utf8')).integratedFingerprint
            || journal.changes.some((change) => !same(source(root, change.path), change.afterSha256, change.afterMode))) {
            return { status: 'RECONCILIATION_REQUIRED', journalPath };
        }
        appendPhase(root, journalPath, 'PROMOTED');
        return { status: 'PROMOTED', journalPath };
    });
}
module.exports = { revisionSourceFingerprint: sourceSnapshotFingerprint, prepareRevisionWorkspace,
    promoteRevisionResult, rollbackRevisionPromotion, reconcileRevisionPromotions, finalizeRevisionPromotion,
    readCheckedRevisionPromotion };
