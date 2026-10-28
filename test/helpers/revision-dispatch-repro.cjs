'use strict';
// Manual evidence repro: node test/helpers/revision-dispatch-repro.cjs <evidence-directory>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createAuthorityStore } = require('../../lib/dual/authority-store');
const { createOperationLifecycleWriter } = require('../../lib/dual/operation-lifecycle-writer');

assert.ok(process.argv[2], 'Provide the read-only trial-12 evidence directory');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-dispatch-repro-'));
try {
    fs.cpSync(path.resolve(process.argv[2]), root, { recursive: true });
    const directory = path.join(root, 'runs/dual-authority');
    const store = createAuthorityStore(directory, { clock: () => new Date('2026-10-28T05:07:52.000Z') });
    assert.throws(() => store.derive(), { code: 'DUAL_OPERATION_CORRUPT' });
    const operations = path.join(directory, 'operations.ndjson');
    const before = fs.readFileSync(operations, 'utf8').trimEnd().split('\n');
    assert.equal(before.length, 3);
    fs.writeFileSync(operations, before.slice(0, 2).join('\n') + '\n');
    const scoped = store.forRevision('TASK-REVISION-TRIAL-1', 'revision-trial-1');
    const writer = createOperationLifecycleWriter(scoped);
    const identity = { taskId: 'TASK-REVISION-TRIAL-1',
        leaseId: '65c1130e-668d-4e45-a1f8-6656cea36f8d', operationId: randomUUID() };
    assert.equal(writer.begin(identity).active, true);
    assert.equal(writer.settle({ ...identity, outcome: 'completed' }).settled, true);
    const records = store.readOperationRecords();
    const commitments = store.readEvents().filter(event => event.type === 'task.operation.ledger.committed');
    assert.equal(records.length, 4);
    assert.equal(commitments.length, records.length);
    assert.equal(store.derive().tasks[identity.taskId].active_revision.state, 'EXECUTING');
    console.log('PASS: original gap rejected; pre-begin succeeds; settle succeeds; records=commitments=4; derive succeeds');
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
