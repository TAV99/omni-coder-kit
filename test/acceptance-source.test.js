'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { canonicalizeEvent } = require('../lib/dual/authority-store');
const { snapshotSource } = require('./squad-acceptance');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-source-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(path.join(root, '.gitignore'), '.omni/\n');
    fs.writeFileSync(path.join(root, 'report.js'), 'accepted T09');
    fs.chmodSync(path.join(root, 'report.js'), 0o644);
    const state = { sessionId: 's', planRevision: 1, tasks: {}, approvals: {} }, events = [];
    const apiPath = path.join(__dirname, 'helpers/acceptance-source.js');
    assert.ok(fs.existsSync(apiPath), 'whole-run source observer must exist');
    const { createSourceGuard } = require(apiPath);
    const guard = createSourceGuard({ root, capture: () => snapshotSource(root),
        authority: { derive: () => state, readEvents: () => events } });
    const change = { path: 'report.js', kind: 'modified', beforeSha256: sha('accepted T09'),
        afterSha256: sha('new T10'), beforeMode: 0o644, afterMode: 0o644, contentBase64: Buffer.from('new T10').toString('base64') };
    function receipt() {
        const result = { schema_version: 1, bindingSha256: 'b'.repeat(64), sessionId: 's', taskId: 'T10', attempt: 1,
            planRevision: 1, changes: [change] };
        result.resultSha256 = sha(canonicalizeEvent(result));
        const handoff = { reference: { bindingSha256: result.bindingSha256 }, result };
        const bytes = JSON.stringify(handoff), dir = '.omni/attempt-1';
        fs.mkdirSync(path.join(root, dir), { recursive: true });
        fs.writeFileSync(path.join(root, dir, 'handoff.json'), bytes);
        fs.writeFileSync(path.join(root, dir, 'receipt.json'), JSON.stringify({ schema_version: 1,
            bindingSha256: result.bindingSha256, resultSha256: result.resultSha256 }));
        state.tasks.T10 = { task_id: 'T10', allowed_files: ['report.js'],
            isolatedWorkspace: { attempt: 1, reference: handoff.reference },
            isolatedHandoff: { attempt: 1, handoff_path: dir + '/handoff.json', handoff_sha256: sha(bytes), result_sha256: result.resultSha256 } };
        events.push({ sequence: 1, session_id: 's', plan_revision: 1, type: 'gate.result', status: 'PASSED', task_id: 'T10',
            details: { integration_receipt: dir + '/receipt.json', result_sha256: result.resultSha256 } });
        return { task_id: 'T10', attempt: 1, sequence: 1, integration_receipt: dir + '/receipt.json', result_sha256: result.resultSha256 };
    }
    return { root, guard, state, events, receipt, change };
}

test('source reset during a worker turn is detected before QC and remains latched after restoration', t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.root, 'report.js'), 'old baseline');
    assert.throws(() => f.guard.check(), { code: 'ACCEPTANCE_SOURCE_DRIFT' });
    fs.writeFileSync(path.join(f.root, 'report.js'), 'accepted T09');
    assert.throws(() => f.guard.check(), { code: 'ACCEPTANCE_SOURCE_DRIFT' });
    assert.deepEqual(f.guard.summary().violations[0].changed_files, ['report.js']);
});

test('only an anchored receipt with the exact handoff bytes advances expected source', t => {
    const f = fixture(t);
    f.guard.beginQc();
    const record = f.receipt();
    fs.writeFileSync(path.join(f.root, 'report.js'), 'new T10');
    f.guard.acceptIntegration(record);
    f.guard.endQc();
    f.guard.check();
    assert.equal(f.guard.summary().integrations, 1);
    fs.writeFileSync(path.join(f.root, 'report.js'), 'accepted T09');
    assert.throws(() => f.guard.check(), { code: 'ACCEPTANCE_SOURCE_DRIFT' });
});

test('a valid receipt cannot hide an extra write during the same QC call', t => {
    const f = fixture(t);
    f.guard.beginQc();
    const record = f.receipt();
    fs.writeFileSync(path.join(f.root, 'report.js'), 'new T10');
    fs.writeFileSync(path.join(f.root, 'escape.js'), 'unauthorized');
    assert.throws(() => f.guard.acceptIntegration(record), { code: 'ACCEPTANCE_SOURCE_DRIFT' });
});

test('source writes without a receipt fail at the end of QC', t => {
    const f = fixture(t);
    f.guard.beginQc();
    fs.writeFileSync(path.join(f.root, 'report.js'), 'new T10');
    assert.throws(() => f.guard.endQc(), { code: 'ACCEPTANCE_SOURCE_DRIFT' });
});

test('forged receipt identity and a foreign authority anchor cannot bless changed bytes', t => {
    for (const kind of ['receipt', 'lineage', 'handoff']) {
        const f = fixture(t); f.guard.beginQc(); const record = f.receipt();
        fs.writeFileSync(path.join(f.root, 'report.js'), 'new T10');
        if (kind === 'receipt') fs.writeFileSync(path.join(f.root, record.integration_receipt), '{}');
        if (kind === 'lineage') f.events[0].session_id = 'foreign';
        if (kind === 'handoff') fs.appendFileSync(path.join(f.root, f.state.tasks.T10.isolatedHandoff.handoff_path), ' ');
        assert.throws(() => f.guard.acceptIntegration(record), { code: 'ACCEPTANCE_SOURCE_RECEIPT_INVALID' });
    }
});

test('periodic observer detects drift while its caller is awaiting a long operation', async t => {
    const f = fixture(t);
    const detected = new Promise(resolve => f.guard.start({ intervalMs: 5, onFailure: resolve }));
    t.after(() => f.guard.close());
    fs.writeFileSync(path.join(f.root, 'report.js'), 'old baseline');
    const error = await detected;
    assert.equal(error.code, 'ACCEPTANCE_SOURCE_DRIFT');
    assert.equal(fs.readFileSync(path.join(f.root, 'report.js'), 'utf8'), 'old baseline', 'observer must not restore source');
});
