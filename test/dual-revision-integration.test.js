'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectTaskResult, readTaskBinding } = require('../lib/dual/task-workspace');
const revision = require('../lib/dual/task-revision-integration');
const crypto = require('node:crypto');
function evidence(root, phase) {
    const file = `.omni/runs/evidence-${phase}-${crypto.randomUUID()}.json`;
    fs.mkdirSync(path.join(root, '.omni/runs'), { recursive: true });
    const bytes = JSON.stringify({ phase, id: crypto.randomUUID() });
    fs.writeFileSync(path.join(root, file), bytes, { flag: 'wx' });
    return [{ path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }];
}
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-revision-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'a.txt'), 'integrated uncommitted');
    fs.chmodSync(path.join(root, 'a.txt'), 0o640);
    fs.writeFileSync(path.join(root, 'b.txt'), 'restore deleted');
    const fingerprint = revision.revisionSourceFingerprint(root);
    const reference = revision.prepareRevisionWorkspace({ workspaceRoot: root, sessionId: 's', taskId: 't',
        revisionId: 'r', attempt: 1, planRevision: 1, contractDigest: 'a'.repeat(64),
        expectedSourceFingerprint: fingerprint, allowedFiles: ['a.txt', 'b.txt', 'new.txt'] });
    fs.writeFileSync(path.join(reference.workerRoot, 'a.txt'), 'candidate');
    fs.writeFileSync(path.join(reference.workerRoot, 'new.txt'), 'new');
    fs.unlinkSync(path.join(reference.workerRoot, 'b.txt'));
    const result = collectTaskResult({ workspaceRoot: root, reference });
    const phases = [];
    const input = { workspaceRoot: root, reference, result, expectedResultSha256: result.resultSha256,
        authorize: (identity) => identity.revisionId === 'r' && identity.contractDigest === 'a'.repeat(64),
        runChecks: async ({ phase, candidateDigest }) => { phases.push(phase); return { status: 'PASSED', candidateDigest,
            evidence: evidence(root, phase) }; } };
    return { root, reference, result, input, phases };
}
test('revision snapshot preserves integrated uncommitted source and namespace identity', (t) => {
    const { root, reference, result } = fixture(t);
    assert.match(reference.bindingPath, /revision-r\/attempt-1\/binding.json$/);
    const { binding } = readTaskBinding(root, reference);
    assert.equal(binding.revisionId, 'r');
    assert.equal(result.revisionId, 'r');
    assert.equal(Buffer.from(result.changes[0].contentBase64, 'base64').toString(), 'candidate');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'integrated uncommitted');
});
test('promotion checks both phases, keeps durable journal pending authority promotion, rollback restores modes and absence', async (t) => {
    const { root, input, phases } = fixture(t);
    const checked = await revision.promoteRevisionResult(input);
    assert.equal(checked.status, 'CHECKED');
    assert.deepEqual(phases, ['pre_integration', 'post_integration']);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'candidate');
    assert.equal(revision.reconcileRevisionPromotions({ workspaceRoot: root }).status, 'RECONCILIATION_REQUIRED');
    const rolled = revision.rollbackRevisionPromotion({ workspaceRoot: root, journalPath: checked.journalPath, authorize: () => true });
    assert.equal(rolled.status, 'ROLLED_BACK');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'integrated uncommitted');
    assert.equal(fs.statSync(path.join(root, 'a.txt')).mode & 0o777, 0o640);
    assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'restore deleted');
});
test('rollback refuses drift without overwriting any file', async (t) => {
    const { root, input } = fixture(t);
    const checked = await revision.promoteRevisionResult(input);
    fs.writeFileSync(path.join(root, 'new.txt'), 'external edit');
    const rolled = revision.rollbackRevisionPromotion({ workspaceRoot: root, journalPath: checked.journalPath, authorize: () => true });
    assert.equal(rolled.status, 'RECONCILIATION_REQUIRED');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'candidate');
    assert.equal(fs.readFileSync(path.join(root, 'new.txt'), 'utf8'), 'external edit');
});
test('post-check failure rolls back and pre-check failure never writes source', async (t) => {
    const { root, input } = fixture(t);
    const failed = await revision.promoteRevisionResult({ ...input, runChecks: async ({ phase, candidateDigest }) => ({
        status: phase === 'post_integration' ? 'FAILED' : 'PASSED', candidateDigest, evidence: evidence(root, phase) }) });
    assert.equal(failed.status, 'ROLLED_BACK');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'integrated uncommitted');
});
test('fresh check references are anchored and a checked journal does not become promoted on restart', async (t) => {
    const { root, input } = fixture(t);
    await assert.rejects(() => revision.promoteRevisionResult({ ...input,
        runChecks: async ({ candidateDigest }) => ({ status: 'PASSED', candidateDigest,
            evidence: [{ path: '.omni/runs/missing.json', sha256: 'a'.repeat(64) }] }) }),
    (error) => error.code === 'DUAL_REVISION_CHECK_FAILED');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'integrated uncommitted');
    const checked = await revision.promoteRevisionResult(input);
    const pending = revision.reconcileRevisionPromotions({ workspaceRoot: root });
    assert.equal(pending.journals[0].phase, 'CHECKED');
    assert.throws(() => revision.finalizeRevisionPromotion({ workspaceRoot: root,
        journalPath: checked.journalPath, authorize: () => false }), (error) => error.code === 'DUAL_INTEGRATION_UNAUTHORIZED');
    assert.equal(revision.reconcileRevisionPromotions({ workspaceRoot: root }).status, 'RECONCILIATION_REQUIRED');
    assert.equal(revision.finalizeRevisionPromotion({ workspaceRoot: root, journalPath: checked.journalPath,
        authorize: (identity) => identity.phase === 'finalize_promoted' }).status, 'PROMOTED');
    assert.equal(revision.reconcileRevisionPromotions({ workspaceRoot: root }).status, 'CLEAR');
    assert.throws(() => revision.rollbackRevisionPromotion({ workspaceRoot: root, journalPath: checked.journalPath,
        authorize: () => true }), (error) => error.code === 'DUAL_REVISION_ROLLBACK_FORBIDDEN');
});
test('exclusive integration window excludes another writer across asynchronous checks', async (t) => {
    const { root, input } = fixture(t);
    let competing;
    const checked = await revision.promoteRevisionResult({ ...input, runChecks: async (args) => {
        competing = await revision.promoteRevisionResult(input);
        return input.runChecks(args);
    } });
    assert.equal(competing.status, 'WAITING_FOR_INTEGRATION');
    assert.equal(checked.status, 'CHECKED');
});
test('promotion finalization detects source drift outside the candidate file set', async (t) => {
    const { root, input } = fixture(t);
    const checked = await revision.promoteRevisionResult(input);
    fs.writeFileSync(path.join(root, 'external.txt'), 'external source drift');
    const finalized = revision.finalizeRevisionPromotion({ workspaceRoot: root, journalPath: checked.journalPath,
        authorize: () => true });
    assert.equal(finalized.status, 'RECONCILIATION_REQUIRED');
    assert.equal(revision.reconcileRevisionPromotions({ workspaceRoot: root }).status, 'RECONCILIATION_REQUIRED');
});
test('restart reconciliation fences both revision and ordinary integration writers until explicit rollback', async t => {
    const { root, input } = fixture(t);
    const checked = await revision.promoteRevisionResult(input);
    const reopened = require('../lib/dual/task-revision-integration');
    assert.equal(reopened.reconcileRevisionPromotions({ workspaceRoot: root }).journals[0].phase, 'CHECKED');
    assert.throws(() => reopened.prepareRevisionWorkspace({ workspaceRoot: root, sessionId: 's', taskId: 't',
        revisionId: 'next', attempt: 1, planRevision: 1, contractDigest: 'c'.repeat(64), allowedFiles: ['a.txt'],
        expectedSourceFingerprint: reopened.revisionSourceFingerprint(root) }),
    { code: 'DUAL_REVISION_RECONCILIATION_REQUIRED' });
    const { prepareTaskWorkspace } = require('../lib/dual/task-workspace');
    const { integrateTaskResult } = require('../lib/dual/task-integration');
    const other = prepareTaskWorkspace({ workspaceRoot: root, sessionId: 'other-session', taskId: 'other-task',
        attempt: 1, planRevision: 1, allowedFiles: ['a.txt'] });
    fs.writeFileSync(path.join(other.workerRoot, 'a.txt'), 'other writer');
    const otherResult = collectTaskResult({ workspaceRoot: root, reference: other });
    const refused = integrateTaskResult({ workspaceRoot: root, reference: other, result: otherResult,
        expectedResultSha256: otherResult.resultSha256, authorize: () => true });
    assert.equal(refused.status, 'RECONCILIATION_REQUIRED');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'candidate');
    assert.equal(reopened.rollbackRevisionPromotion({ workspaceRoot: root, journalPath: checked.journalPath,
        authorize: () => true }).status, 'ROLLED_BACK');
    assert.equal(reopened.reconcileRevisionPromotions({ workspaceRoot: root }).status, 'CLEAR');
});
test('checked promotion reader requires durable CHECKED phase rather than applied bytes or receipt alone', async t => {
    const { root, input } = fixture(t);
    const checked = await revision.promoteRevisionResult(input);
    const ready = revision.readCheckedRevisionPromotion({ workspaceRoot: root, journalPath: checked.journalPath });
    assert.equal(ready.status, 'CHECKED');
    assert.equal(ready.receiptSha256, checked.receiptSha256);
    assert.equal(ready.identity.revisionId, 'r');
    const prefix = path.basename(checked.journalPath).replace(/\.json$/, '-phase-');
    const directory = path.dirname(path.join(root, checked.journalPath));
    const phases = fs.readdirSync(directory).filter(file => file.startsWith(prefix)).sort();
    fs.unlinkSync(path.join(directory, phases.at(-1)));
    assert.equal(revision.reconcileRevisionPromotions({ workspaceRoot: root }).journals[0].phase, 'APPLIED');
    assert.equal(revision.readCheckedRevisionPromotion({ workspaceRoot: root, journalPath: checked.journalPath }).status,
        'RECONCILIATION_REQUIRED');
});
