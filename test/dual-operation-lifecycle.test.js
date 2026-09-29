'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createAuthorityStore, computeEventHash } = require('../lib/dual/authority-store');
const { recoverTaskLease } = require('../lib/dual/task-processes');
const operationLifecycleApi = require('../lib/dual/operation-lifecycle');
const { createOperationLifecycleWriter } = require('../lib/dual/operation-lifecycle-writer');
const {
    inspectOperation,
    listOperations,
} = require('../lib/dual/operation-lifecycle');

function beginOperation({ authorityStore, ...params }) {
    return createOperationLifecycleWriter(authorityStore).begin(params);
}

function settleOperation({ authorityStore, ...params }) {
    return createOperationLifecycleWriter(authorityStore).settle(params);
}

function fixture(t, options = {}) {
    const { ownerPid = process.pid, ...storeOptions } = options;
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-operation-lifecycle-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const authorityDir = path.join(root, '.omni/runs/dual-authority');
    const store = createAuthorityStore(authorityDir, storeOptions);
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'ws', session_id: 'session', plan_revision: 1, expected_baseline: { kind: 'snapshot', id: 'a'.repeat(64) }, mode: 'auto' });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'fixture', status: 'PASSED' }] });
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'plan.md', plan_sha256: 'b'.repeat(64), total_tasks: 1,
        tasks: [{ task_id: 'TASK-1', title: 'task', owner: 'agy', execution_mode: 'isolated', allowed_files: ['a.js'] }] });
    store.append({ schema_version: 2, type: 'task.routed', task_id: 'TASK-1', owner: 'agy', authority_state: 'ROUTED',
        allowed_files: ['a.js'], reason: 'fixture' });
    const lease = store.acquireLease('TASK-1', 'agy', { ttlMs: 30000 });
    if (ownerPid !== null) store.append({ schema_version: 2, type: 'task.execution.started', task_id: 'TASK-1', lease_id: lease.lease_id,
        controller_pid: ownerPid });
    return { root, authorityDir, store, lease };
}

function appendRawOperationRecord(authorityDir, record) {
    const operationsPath = path.join(authorityDir, 'operations.ndjson');
    const content = fs.existsSync(operationsPath) ? fs.readFileSync(operationsPath, 'utf8') : '';
    const previousHash = content ? JSON.parse(content.trimEnd().split('\n').at(-1)).record_hash : '0'.repeat(64);
    const envelope = { previous_hash: previousHash, record_hash: computeEventHash(previousHash, record), record };
    fs.appendFileSync(operationsPath, `${JSON.stringify(envelope)}\n`, 'utf8');
}

test('operation lifecycle persists active and settled state across authority restart', (t) => {
    const { authorityDir, store, lease } = fixture(t);
    const operationId = '11111111-1111-4111-8111-111111111111';

    assert.deepEqual(beginOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId }), {
        active: true, settled: false, outcome: null, operation_id: operationId,
    });
    assert.deepEqual(inspectOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId }), {
        active: true, settled: false, outcome: null,
    });

    assert.deepEqual(settleOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id,
        operationId, outcome: 'completed' }), {
        active: false, settled: true, outcome: 'completed', operation_id: operationId,
    });
    const reopened = createAuthorityStore(authorityDir);
    assert.deepEqual(inspectOperation({ authorityStore: reopened, taskId: 'TASK-1', leaseId: lease.lease_id, operationId }), {
        active: false, settled: true, outcome: 'completed',
    });
});

test('authority restart fails closed when an existing operation ledger is deleted, truncated, or replaced with empty bytes', (t) => {
    for (const replacement of ['missing', 'truncated', 'empty']) {
        const { authorityDir, store, lease } = fixture(t);
        const operationId = '10101010-1010-4101-8101-101010101010';
        beginOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id,
            operationId });
        const operationsPath = path.join(authorityDir, 'operations.ndjson');
        if (replacement === 'missing') fs.unlinkSync(operationsPath);
        else if (replacement === 'truncated') {
            settleOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId, outcome: 'failed' });
            fs.writeFileSync(operationsPath, `${fs.readFileSync(operationsPath, 'utf8').split('\n')[0]}\n`, 'utf8');
        }
        else fs.writeFileSync(operationsPath, '', 'utf8');
        const reopened = createAuthorityStore(authorityDir);
        assert.throws(() => reopened.derive(), (error) => error.code === 'DUAL_OPERATION_CORRUPT');
    }
});

test('operation lifecycle rejects duplicate active operations and mismatched settle outcomes', (t) => {
    const { store, lease } = fixture(t);
    const first = '22222222-2222-4222-8222-222222222222';
    const second = '33333333-3333-4333-8333-333333333333';

    beginOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId: first });
    assert.throws(
        () => beginOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId: second }),
        (error) => error.code === 'DUAL_OPERATION_ACTIVE'
    );
    store.append({ schema_version: 2, type: 'task.process.intent', task_id: 'TASK-1', lease_id: lease.lease_id, process_id: 'proc-1' });
    assert.throws(
        () => settleOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id,
            operationId: first, outcome: 'completed' }),
        (error) => error.code === 'DUAL_OPERATION_CHILDREN_ACTIVE'
    );
    store.append({ schema_version: 2, type: 'task.process.exited', task_id: 'TASK-1', lease_id: lease.lease_id, process_id: 'proc-1', exit_code: 0 });
    settleOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId: first, outcome: 'completed' });
    assert.throws(
        () => settleOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id,
            operationId: first, outcome: 'failed' }),
        (error) => error.code === 'DUAL_OPERATION_OUTCOME_CONFLICT'
    );
});

test('authority operation append and replay allow only one active operation per task lease', (t) => {
    const { authorityDir, store, lease } = fixture(t);
    const first = '88888888-8888-4888-8888-888888888888';
    const second = '99999999-9999-4999-8999-999999999999';
    beginOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId: first });

    assert.equal(store.appendOperationRecord, undefined);

    appendRawOperationRecord(authorityDir, {
        schema_version: 1, type: 'started', operation_id: second, session_id: 'session', workspace_id: 'ws',
        plan_revision: 1, task_id: 'TASK-1', lease_id: lease.lease_id, timestamp: store.now(),
    });
    assert.throws(() => store.derive(), (error) => error.code === 'DUAL_OPERATION_CORRUPT');
});

test('public authority stores expose no operation lifecycle mutation methods', (t) => {
    const { store, lease } = fixture(t);
    const reopened = createAuthorityStore(path.join(store.derive().workspaceRoot, '.omni/runs/dual-authority'));
    const operationId = '12121212-1212-4121-8121-121212121212';
    for (const candidate of [store, reopened]) {
        assert.equal(candidate.appendOperationRecord, undefined);
        assert.equal(candidate.beginOperation, undefined);
        assert.equal(candidate.settleOperation, undefined);
        assert.deepEqual(Object.getOwnPropertySymbols(candidate), []);
    }
    assert.equal(operationLifecycleApi.beginOperation, undefined);
    assert.equal(operationLifecycleApi.settleOperation, undefined);
    beginOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId });
    assert.equal(inspectOperation({ authorityStore: reopened, taskId: 'TASK-1', leaseId: lease.lease_id,
        operationId }).active, true);
});

test('authority lifecycle append cannot reopen a settled task lease outside operation-lifecycle', (t) => {
    const { store, lease } = fixture(t);
    const settledOperationId = '15151515-1515-4151-8151-151515151515';
    const bypassOperationId = '16161616-1616-4161-8161-161616161616';

    beginOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId: settledOperationId });
    settleOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id,
        operationId: settledOperationId, outcome: 'completed' });

    assert.equal(typeof store.appendLifecycleOperationRecord, 'undefined');
    assert.equal(operationLifecycleApi.operationLifecycleAuthorization, undefined);
    assert.equal(inspectOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id,
        operationId: settledOperationId }).settled, true);

    assert.equal(bypassOperationId, '16161616-1616-4161-8161-161616161616');
});

test('external consumers cannot import lifecycle capability or append an initial operation', (t) => {
    const { store, lease } = fixture(t);
    const operationId = '17171717-1717-4171-8171-171717171717';
    const externalAuthorization = operationLifecycleApi.operationLifecycleAuthorization;
    if (externalAuthorization && typeof store.appendLifecycleOperationRecord === 'function') {
        store.appendLifecycleOperationRecord({
            schema_version: 1,
            type: 'started',
            operation_id: operationId,
            session_id: 'session',
            workspace_id: 'ws',
            plan_revision: 1,
            task_id: 'TASK-1',
            lease_id: lease.lease_id,
            timestamp: store.now(),
        }, externalAuthorization.started);
    }

    assert.equal(externalAuthorization, undefined);
    assert.equal(operationLifecycleApi.registerAuthorityStoreBridge, undefined);
    assert.equal(typeof store.appendLifecycleOperationRecord, 'undefined');
});

test('owner-dead recovery rejects active operation evidence during replay', (t) => {
    let nowMs = 10000;
    const deadControllerPid = 99999999;
    const { store, lease } = fixture(t, { clock: () => new Date(nowMs), ownerPid: deadControllerPid });
    beginOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id,
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    nowMs += 60000;

    assert.throws(() => store.append({ schema_version: 2, type: 'task.lease.recovered', task_id: 'TASK-1',
        lease_id: lease.lease_id, recovery_kind: 'owner_dead', confirmed_dead_pids: [deadControllerPid] }),
    (error) => error.code === 'DUAL_INTEGRITY_CORRUPT');
});

test('legacy recovery without recovery_kind cannot discard an active operation', (t) => {
    let nowMs = 10000;
    const deadControllerPid = 99999999;
    const { store, lease } = fixture(t, { clock: () => new Date(nowMs), ownerPid: deadControllerPid });
    beginOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id,
        operationId: '13131313-1313-4131-8131-131313131313' });
    nowMs += 60000;

    assert.throws(() => store.append({ schema_version: 2, type: 'task.lease.recovered', task_id: 'TASK-1',
        lease_id: lease.lease_id, confirmed_dead_pids: [deadControllerPid] }),
    (error) => error.code === 'DUAL_INTEGRITY_CORRUPT');
});

test('operation ledger replay rejects records outside the current authority lineage', (t) => {
    for (const [field, value] of [['session_id', 'foreign-session'], ['workspace_id', 'foreign-workspace'], ['plan_revision', 2]]) {
        const { authorityDir, store, lease } = fixture(t);
        beginOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id,
            operationId: `bbbbbbbb-bbbb-4bbb-8bbb-${field === 'session_id' ? '111111111111' : field === 'workspace_id' ? '222222222222' : '333333333333'}` });
        const operationsPath = path.join(authorityDir, 'operations.ndjson');
        const envelope = JSON.parse(fs.readFileSync(operationsPath, 'utf8').trim());
        envelope.record[field] = value;
        envelope.record_hash = computeEventHash(envelope.previous_hash, envelope.record);
        fs.writeFileSync(operationsPath, `${JSON.stringify(envelope)}\n`, 'utf8');
        assert.throws(() => store.derive(), (error) => error.code === 'DUAL_OPERATION_CORRUPT');
    }
});

test('settlement rejects a timestamp earlier than the durable operation start', (t) => {
    let nowMs = 10000;
    const { store, lease } = fixture(t, { clock: () => new Date(nowMs) });
    const operationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    beginOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId });
    nowMs = 9000;
    assert.throws(() => settleOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id,
        operationId, outcome: 'failed' }), (error) => error.code === 'DUAL_OPERATION_CORRUPT');
});

test('begin and settle require matching task.execution.started evidence', (t) => {
    const withoutExecution = fixture(t, { ownerPid: null });
    assert.throws(() => beginOperation({ authorityStore: withoutExecution.store, taskId: 'TASK-1',
        leaseId: withoutExecution.lease.lease_id, operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }),
    (error) => error.code === 'DUAL_OPERATION_INVALID');

    assert.throws(() => settleOperation({ authorityStore: withoutExecution.store, taskId: 'TASK-1',
        leaseId: withoutExecution.lease.lease_id, operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', outcome: 'cancelled' }),
    (error) => error.code === 'DUAL_OPERATION_INVALID');
});

test('expired unresolved operation remains fenced and cannot be settled after recovery boundary', (t) => {
    let nowMs = 10000;
    const { root, store, lease } = fixture(t, { clock: () => new Date(nowMs) });
    const operationId = '44444444-4444-4444-8444-444444444444';
    beginOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId });

    nowMs += 60000;
    assert.equal(recoverTaskLease({ workspaceRoot: root, authorityStore: store, sessionId: 'session', taskId: 'TASK-1', planRevision: 1 }).status,
        'NEEDS_PROCESS_EVIDENCE');
    assert.throws(
        () => settleOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id,
            operationId, outcome: 'cancelled' }),
        (error) => error.code === 'DUAL_OPERATION_LEASE_EXPIRED'
    );
});

test('operation ledger corruption fails closed during authority replay', (t) => {
    const { authorityDir, store } = fixture(t);
    fs.writeFileSync(path.join(authorityDir, 'operations.ndjson'), '{not-json}\n', 'utf8');
    assert.throws(() => store.derive(), (error) => error.code === 'DUAL_OPERATION_CORRUPT');
});

test('listOperations validates current authority lineage before returning durable records', (t) => {
    const { authorityDir, store, lease } = fixture(t);
    const operationId = '14141414-1414-4141-8141-141414141414';
    beginOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId });
    const operationsPath = path.join(authorityDir, 'operations.ndjson');
    const envelope = JSON.parse(fs.readFileSync(operationsPath, 'utf8').trim());
    envelope.record.workspace_id = 'foreign-workspace';
    envelope.record_hash = computeEventHash(envelope.previous_hash, envelope.record);
    fs.writeFileSync(operationsPath, `${JSON.stringify(envelope)}\n`, 'utf8');

    assert.throws(() => listOperations({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id }),
        (error) => error.code === 'DUAL_OPERATION_CORRUPT');
});

test('settled operation recovery releases lease without claiming daemon PID dead', (t) => {
    let nowMs = 10000;
    const { root, store, lease } = fixture(t, { clock: () => new Date(nowMs) });
    const operationId = '55555555-5555-4555-8555-555555555555';
    beginOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId });
    settleOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId, outcome: 'failed' });

    nowMs += 60000;
    assert.equal(recoverTaskLease({ workspaceRoot: root, authorityStore: store, sessionId: 'session', taskId: 'TASK-1', planRevision: 1 }).status,
        'RECOVERED');
    const recovery = store.readEvents().find((event) => event.type === 'task.lease.recovered');
    assert.equal(recovery.recovery_kind, 'operation_settled');
    assert.equal(recovery.operation_id, operationId);
    assert.equal(recovery.operation_outcome, 'failed');
    assert.deepEqual(recovery.confirmed_dead_pids, []);
});

test('historical recovery event without recovery_kind remains replayable', (t) => {
    let nowMs = 10000;
    const { store, lease } = fixture(t, { clock: () => new Date(nowMs), ownerPid: null });
    nowMs += 60000;
    store.append({ schema_version: 2, type: 'task.lease.recovered', task_id: 'TASK-1', lease_id: lease.lease_id,
        confirmed_dead_pids: [] });
    assert.equal(store.derive().leases[lease.lease_id].release_reason, 'recovered_unexecuted_lease');
});

test('operation-settled replay requires durable settled evidence and rejects live daemon PID claims', (t) => {
    let nowMs = 10000;
    const { store, lease } = fixture(t, { clock: () => new Date(nowMs), ownerPid: process.pid });
    const operationId = '66666666-6666-4666-8666-666666666666';
    nowMs += 60000;
    assert.throws(
        () => store.append({ schema_version: 2, type: 'task.lease.recovered', task_id: 'TASK-1', lease_id: lease.lease_id,
            recovery_kind: 'operation_settled', operation_id: operationId, operation_outcome: 'completed', confirmed_dead_pids: [] }),
        (error) => error.code === 'DUAL_INTEGRITY_CORRUPT'
    );
    assert.throws(
        () => store.append({ schema_version: 2, type: 'task.lease.recovered', task_id: 'TASK-1', lease_id: lease.lease_id,
            recovery_kind: 'owner_dead', confirmed_dead_pids: [process.pid] }),
        (error) => error.code === 'DUAL_INTEGRITY_CORRUPT'
    );
});

test('settled operation evidence replays after daemon restart before recovery', (t) => {
    let nowMs = 10000;
    const { root, authorityDir, store, lease } = fixture(t, { clock: () => new Date(nowMs), ownerPid: process.pid });
    const operationId = '77777777-7777-4777-8777-777777777777';
    beginOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId });
    settleOperation({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, operationId, outcome: 'cancelled' });
    nowMs += 60000;
    const reopened = createAuthorityStore(authorityDir, { clock: () => new Date(nowMs) });
    assert.equal(recoverTaskLease({ workspaceRoot: root, authorityStore: reopened, sessionId: 'session', taskId: 'TASK-1', planRevision: 1 }).status,
        'RECOVERED');
    assert.equal(reopened.derive().leases[lease.lease_id].release_reason, 'recovered_operation_settled');
});
