'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { prepareTaskWorkspace, collectTaskResult } = require('../lib/dual/task-workspace');
const { integrateTaskResult } = require('../lib/dual/task-integration');

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-integrate-task-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const [file, content] of Object.entries({ 'a.txt': 'original a', 'b.txt': 'original b', 'context.md': 'requirements' })) {
        fs.writeFileSync(path.join(root, file), content);
    }
    const ref = prepareTaskWorkspace({ workspaceRoot: root, sessionId: 'sess', taskId: 'task', attempt: 1,
        planRevision: 1, allowedFiles: ['a.txt', 'b.txt', 'nested/new.txt'], contextFiles: ['context.md'] });
    fs.writeFileSync(path.join(ref.workerRoot, 'a.txt'), 'worker a');
    fs.unlinkSync(path.join(ref.workerRoot, 'b.txt'));
    fs.mkdirSync(path.join(ref.workerRoot, 'nested'));
    fs.writeFileSync(path.join(ref.workerRoot, 'nested/new.txt'), 'created');
    const result = collectTaskResult({ workspaceRoot: root, reference: ref });
    const input = { workspaceRoot: root, reference: ref, result, expectedResultSha256: result.resultSha256,
        authorize: () => true };
    return { root, ref, result, input };
}

test('integration requires explicit controller authority and exact anchored result', (t) => {
    const { root, input } = fixture(t);
    assert.throws(() => integrateTaskResult({ ...input, authorize: undefined }),
        (error) => error.code === 'DUAL_INTEGRATION_UNAUTHORIZED');
    assert.throws(() => integrateTaskResult({ ...input, authorize: () => false }),
        (error) => error.code === 'DUAL_INTEGRATION_UNAUTHORIZED');
    assert.throws(() => integrateTaskResult({ ...input, expectedResultSha256: 'a'.repeat(64) }),
        (error) => error.code === 'DUAL_INTEGRATION_RESULT_INVALID');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original a');
});

test('controller integrates all scoped changes and replays without duplicate application', (t) => {
    const { root, input } = fixture(t);
    const integrated = integrateTaskResult(input);
    assert.equal(integrated.status, 'INTEGRATED');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'worker a');
    assert.equal(fs.existsSync(path.join(root, 'b.txt')), false);
    assert.equal(fs.readFileSync(path.join(root, 'nested/new.txt'), 'utf8'), 'created');
    assert.equal(fs.readFileSync(path.join(root, 'context.md'), 'utf8'), 'requirements');
    assert.equal(integrateTaskResult(input).status, 'ALREADY_INTEGRATED');
});

test('source or read-context conflicts preserve both versions and do not partially integrate', (t) => {
    const { root, ref, input } = fixture(t);
    fs.writeFileSync(path.join(root, 'b.txt'), 'user changed b');
    const conflict = integrateTaskResult(input);
    assert.equal(conflict.status, 'CONFLICT');
    assert.ok(conflict.files.includes('b.txt'));
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original a');
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'user changed b');
    assert.equal(fs.readFileSync(path.join(ref.workerRoot, 'a.txt'), 'utf8'), 'worker a');
    fs.writeFileSync(path.join(root, 'b.txt'), 'original b');
    fs.writeFileSync(path.join(root, 'context.md'), 'new requirements');
    assert.deepEqual(integrateTaskResult(input).files, ['context.md']);
    assert.equal(fs.existsSync(path.join(root, 'nested/new.txt')), false);
});

test('integration resumes after a post-write interruption without losing original backups', (t) => {
    const { root, input } = fixture(t);
    let progressCalls = 0;
    assert.throws(() => integrateTaskResult({ ...input, onProgress() {
        progressCalls++;
        throw new Error('simulated interruption');
    } }), /simulated interruption/);
    assert.equal(progressCalls, 1);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'worker a');
    const resumed = integrateTaskResult(input);
    assert.equal(resumed.status, 'INTEGRATED');
    assert.equal(fs.existsSync(path.join(root, 'b.txt')), false);
    const journal = JSON.parse(fs.readFileSync(path.join(root, resumed.journalPath), 'utf8'));
    assert.equal(Buffer.from(journal.originals['a.txt'].contentBase64, 'base64').toString(), 'original a');
});

test('live integration lock returns wait and never alters source', (t) => {
    const { root, input } = fixture(t);
    fs.writeFileSync(path.join(root, '.omni/runs/dual-workspaces/integration.lock'), JSON.stringify({
        pid: process.pid, token: 'another-active-operation',
    }));
    assert.equal(integrateTaskResult(input).status, 'WAITING_FOR_INTEGRATION');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original a');
});

test('integration rejects a destination junction escape before modifying any source file', (t) => {
    const { root, input } = fixture(t);
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-integration-outside-')));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.symlinkSync(outside, path.join(root, 'nested'), 'junction');
    assert.throws(() => integrateTaskResult(input), (error) => error.code === 'DUAL_PATH_ESCAPE');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original a');
    assert.deepEqual(fs.readdirSync(outside), []);
});

test('integration reclaims a lock only after its owner process is confirmed dead', (t) => {
    const { root, input } = fixture(t);
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { shell: false, windowsHide: true });
    assert.equal(child.status, 0);
    fs.writeFileSync(path.join(root, '.omni/runs/dual-workspaces/integration.lock'), JSON.stringify({
        pid: child.pid, token: 'dead-operation',
    }));
    assert.equal(integrateTaskResult(input).status, 'INTEGRATED');
});

test('integration refuses a journal missing its original backups before any source write', (t) => {
    const { root, input, ref } = fixture(t);
    const journalPath = path.join(root, path.dirname(ref.bindingPath), `integration-${input.expectedResultSha256}.json`);
    fs.writeFileSync(journalPath, JSON.stringify({ schema_version: 1, bindingSha256: ref.bindingSha256,
        resultSha256: input.expectedResultSha256, originals: {} }));
    assert.throws(() => integrateTaskResult(input), (error) => error.code === 'DUAL_INTEGRATION_JOURNAL_INVALID');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original a');
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'original b');
});

test('prototype-named file keeps its original bytes in the integration journal', (t) => {
    const { root } = fixture(t);
    fs.writeFileSync(path.join(root, '__proto__'), 'unique original');
    const reference = prepareTaskWorkspace({ workspaceRoot: root, sessionId: 'sess', taskId: 'proto', attempt: 1,
        planRevision: 1, allowedFiles: ['__proto__'] });
    fs.unlinkSync(path.join(reference.workerRoot, '__proto__'));
    const result = collectTaskResult({ workspaceRoot: root, reference });
    const applied = integrateTaskResult({ workspaceRoot: root, reference, result,
        expectedResultSha256: result.resultSha256, authorize: () => true });
    const journal = JSON.parse(fs.readFileSync(path.join(root, applied.journalPath), 'utf8'));
    assert.equal(Object.hasOwn(journal.originals, '__proto__'), true);
    assert.equal(Buffer.from(journal.originals.__proto__.contentBase64, 'base64').toString(), 'unique original');
});

test('receipt replay detects user revert and never silently reapplies the worker result', (t) => {
    const { root, input } = fixture(t);
    integrateTaskResult(input);
    fs.writeFileSync(path.join(root, 'b.txt'), 'original b');
    const replay = integrateTaskResult(input);
    assert.equal(replay.status, 'CONFLICT');
    assert.ok(replay.files.includes('b.txt'));
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'original b');
});

test('journal with corrupt backup bytes is rejected during interrupted integration resume', (t) => {
    const { root, input, ref } = fixture(t);
    assert.throws(() => integrateTaskResult({ ...input, onProgress() { throw new Error('cut'); } }), /cut/);
    const journalPath = path.join(root, path.dirname(ref.bindingPath), `integration-${input.expectedResultSha256}.json`);
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    journal.originals['b.txt'].contentBase64 = Buffer.from('wrong backup').toString('base64');
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    assert.throws(() => integrateTaskResult(input), (error) => error.code === 'DUAL_INTEGRATION_JOURNAL_INVALID');
    assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'original b');
});

test('context changed during integration prevents a completion receipt', (t) => {
    const { root, input } = fixture(t);
    const result = integrateTaskResult({ ...input, onProgress() {
        fs.writeFileSync(path.join(root, 'context.md'), 'changed while integrating');
    } });
    assert.equal(result.status, 'CONFLICT');
    assert.ok(result.files.includes('context.md'));
    assert.equal(fs.existsSync(path.join(root, path.dirname(input.reference.bindingPath),
        `integrated-${input.expectedResultSha256}.json`)), false);
});

test('existing scalar or null journals cannot bypass original-backup validation', (t) => {
    const { root, input, ref } = fixture(t);
    const journalPath = path.join(root, path.dirname(ref.bindingPath), `integration-${input.expectedResultSha256}.json`);
    for (const value of [null, false, 0, '', []]) {
        fs.writeFileSync(journalPath, JSON.stringify(value));
        assert.throws(() => integrateTaskResult(input), (error) => error.code === 'DUAL_INTEGRATION_JOURNAL_INVALID');
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'original a');
        assert.equal(fs.readFileSync(path.join(root, 'b.txt'), 'utf8'), 'original b');
    }
});
