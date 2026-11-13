'use strict';

// A host sleep (lid close on battery) froze the daemon past the 120 s worker
// lease (omni-p8-test 2026-11-13). The run then failed its authority check and
// its operation could never settle, stranding the task in
// NEEDS_PROCESS_EVIDENCE. These cover the owner settlement, the stranded
// recovery after a daemon restart, and the harness classification.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { createAuthorityStore } = require('../lib/dual/authority-store');
const { recoverTaskLease } = require('../lib/dual/task-processes');
const { inspectOperation } = require('../lib/dual/operation-lifecycle');
const { createOperationLifecycleWriter } = require('../lib/dual/operation-lifecycle-writer');
const { classifyFailure } = require('../lib/dual/correction-policy');
const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
const { writeInitialSnapshot } = require('../lib/dual/snapshot-store');

const TASK = 'TASK-1';

function fakeClock() {
    let current = Date.parse('2026-11-13T08:00:00.000Z');
    const clock = () => new Date(current);
    clock.advance = (milliseconds) => { current += milliseconds; return clock(); };
    return clock;
}

function seed(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-lease-lost-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Return two.\n');
    const clock = fakeClock();
    const dir = path.join(root, '.omni/runs/dual-authority');
    const snapshot = createConfiguredSnapshotBaseline({ root }).baseline.capture();
    const store = createAuthorityStore(dir, { clock });
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'workspace-test', session_id: 'session-1', plan_revision: 1,
        expected_baseline: snapshot.identity, mode: 'auto' });
    writeInitialSnapshot({ authorityDir: dir, sessionId: 'session-1', workspaceId: 'workspace-test',
        workspaceRoot: root, identity: snapshot.identity, manifest: snapshot.manifest });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: { agy_version: '1.1.27-test', agy_model: 'gemini-test' } });
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'spec.md', plan_sha256: 'b'.repeat(64), total_tasks: 1,
        tasks: [{ task_id: TASK, title: 'finalize', goal: 'Return two', owner: 'agy', effort: 'high',
            execution_mode: 'isolated', allowed_files: ['index.js'], context_files: ['spec.md'], deny_patterns: [],
            validation_commands: [{ program: 'node', args: ['--check', 'index.js'], cwd: '.' }] }] });
    store.append({ schema_version: 2, type: 'task.routed', task_id: TASK, owner: 'agy', authority_state: 'ROUTED',
        allowed_files: ['index.js'], model: 'gemini-test', effort: 'high', reason: 'test' });
    return { root, store, dir, clock };
}

function deadPid() {
    const result = spawnSync(process.execPath, ['-e', '']);
    assert.equal(result.status, 0);
    return result.pid;
}

// One execution with one exited child and one active operation, then the
// lease expires under it, as when the host slept through the heartbeat.
function expiredRun({ store, clock }, controllerPid = process.pid) {
    const lease = store.acquireLease(TASK, 'agy');
    store.append({ schema_version: 2, type: 'task.execution.started', task_id: TASK,
        lease_id: lease.lease_id, controller_pid: controllerPid });
    const operationId = crypto.randomUUID();
    createOperationLifecycleWriter(store).begin({ taskId: TASK, leaseId: lease.lease_id, operationId });
    const event = { schema_version: 2, task_id: TASK, lease_id: lease.lease_id, process_id: 'child-1' };
    store.append({ ...event, type: 'task.process.intent' });
    store.append({ ...event, type: 'task.process.started', pid: controllerPid });
    store.append({ ...event, type: 'task.process.exited', exit_code: 0 });
    clock.advance(135_000);
    return { lease, operationId };
}

test('the live controller settles its own run after the lease expired, so finalization releases the lease', (t) => {
    const ctx = seed(t);
    const { lease, operationId } = expiredRun(ctx);
    assert.equal(ctx.store.derive().leases[lease.lease_id].status, 'expired');

    createOperationLifecycleWriter(ctx.store).settle({ taskId: TASK, leaseId: lease.lease_id, operationId,
        outcome: 'failed', owner: true });
    const finalization = ctx.store.recordFinalizationFailure({ taskId: TASK, leaseId: lease.lease_id,
        attempt: 1, code: 'CAPABILITY_BLOCKED', stage: 'unknown' });

    assert.equal(finalization.settled, true);
    const derived = ctx.store.derive();
    assert.equal(derived.leases[lease.lease_id].status, 'released');
    assert.equal(derived.tasks[TASK].lastOutcome.code, 'CAPABILITY_BLOCKED');
    assert.deepEqual(classifyFailure(derived.tasks[TASK]), { category: 'harness', phase: 'lease_lost' });
    assert.equal(createAuthorityStore(ctx.dir, { clock: ctx.clock }).verifyIntegrity().valid, true);
});

test('owner settlement refuses a live lease, a foreign controller, a mixed mode, and a success outcome', (t) => {
    const ctx = seed(t);
    const lease = ctx.store.acquireLease(TASK, 'agy');
    ctx.store.append({ schema_version: 2, type: 'task.execution.started', task_id: TASK,
        lease_id: lease.lease_id, controller_pid: process.pid });
    const operationId = crypto.randomUUID();
    const writer = createOperationLifecycleWriter(ctx.store);
    writer.begin({ taskId: TASK, leaseId: lease.lease_id, operationId });
    const settle = (outcome = 'failed') => writer.settle({ taskId: TASK, leaseId: lease.lease_id, operationId, outcome, owner: true });

    assert.throws(() => settle(), (error) => error.code === 'DUAL_OPERATION_INVALID');
    ctx.clock.advance(135_000);
    assert.throws(() => settle('completed'), (error) => error.code === 'DUAL_OPERATION_INVALID_OUTCOME');
    assert.throws(() => writer.settle({ taskId: TASK, leaseId: lease.lease_id, operationId,
        outcome: 'failed', owner: true, orphan: true }), (error) => error.code === 'DUAL_OPERATION_INVALID');

    const foreign = seed(t);
    const run = expiredRun(foreign, deadPid());
    assert.throws(() => createOperationLifecycleWriter(foreign.store).settle({ taskId: TASK, leaseId: run.lease.lease_id,
        operationId: run.operationId, outcome: 'failed', owner: true }), (error) => error.code === 'DUAL_OPERATION_INVALID');
    assert.equal(inspectOperation({ authorityStore: foreign.store, taskId: TASK,
        leaseId: run.lease.lease_id, operationId: run.operationId }).active, true);
});

test('owner settlement refuses while a tracked child is still running', (t) => {
    const ctx = seed(t);
    const lease = ctx.store.acquireLease(TASK, 'agy');
    ctx.store.append({ schema_version: 2, type: 'task.execution.started', task_id: TASK,
        lease_id: lease.lease_id, controller_pid: process.pid });
    const operationId = crypto.randomUUID();
    const writer = createOperationLifecycleWriter(ctx.store);
    writer.begin({ taskId: TASK, leaseId: lease.lease_id, operationId });
    const event = { schema_version: 2, task_id: TASK, lease_id: lease.lease_id, process_id: 'child-1' };
    ctx.store.append({ ...event, type: 'task.process.intent' });
    ctx.store.append({ ...event, type: 'task.process.started', pid: process.pid });
    ctx.clock.advance(135_000);
    assert.throws(() => writer.settle({ taskId: TASK, leaseId: lease.lease_id, operationId, outcome: 'failed', owner: true }),
        (error) => error.code === 'DUAL_OPERATION_CHILDREN_ACTIVE');
});

test('after a daemon restart a stranded unsettled finalization recovers on the orphaned operation', (t) => {
    const ctx = seed(t);
    const controller = deadPid();
    const { lease, operationId } = expiredRun(ctx, controller);
    // What the pre-fix daemon left behind: finalization recorded, operation still active.
    ctx.store.append({ schema_version: 2, type: 'task.execution.finalization_failed', task_id: TASK,
        lease_id: lease.lease_id, attempt: 1, controller_pid: controller, status: 'FAILED', stage: 'unknown',
        code: 'CAPABILITY_BLOCKED', recovery: 'NEEDS_PROCESS_EVIDENCE', settled: false,
        summary: 'Finalization failed at unknown; code=CAPABILITY_BLOCKED; recovery=NEEDS_PROCESS_EVIDENCE.' });
    assert.deepEqual(classifyFailure(ctx.store.derive().tasks[TASK]), { category: 'unknown', phase: 'unclassified' });
    ctx.clock.advance(60_000);

    const recovery = recoverTaskLease({ workspaceRoot: ctx.root, authorityStore: ctx.store,
        sessionId: 'session-1', taskId: TASK, planRevision: 1 });

    assert.equal(recovery.status, 'RECOVERED');
    const derived = ctx.store.derive();
    assert.equal(derived.leases[lease.lease_id].status, 'released');
    assert.equal(derived.leases[lease.lease_id].release_reason, 'recovered_operation_settled');
    assert.equal(inspectOperation({ authorityStore: ctx.store, taskId: TASK,
        leaseId: lease.lease_id, operationId }).outcome, 'failed');
    assert.deepEqual(classifyFailure(derived.tasks[TASK]), { category: 'harness', phase: 'lease_lost' });
    assert.equal(createAuthorityStore(ctx.dir, { clock: ctx.clock }).verifyIntegrity().valid, true);
});

test('a stranded operation without a recorded finalization still needs process evidence', (t) => {
    const ctx = seed(t);
    expiredRun(ctx, deadPid());
    const recovery = recoverTaskLease({ workspaceRoot: ctx.root, authorityStore: ctx.store,
        sessionId: 'session-1', taskId: TASK, planRevision: 1 });
    assert.equal(recovery.status, 'NEEDS_PROCESS_EVIDENCE');
});

test('an unrelated failure code after a lease loss stays unclassified', () => {
    const task = { task_id: TASK, lastOutcome: { attempt: 1, status: 'FAILED', code: 'DUAL_WORKER_EXECUTION_FAILED' },
        finalization: { stage: 'unknown', recovery: 'NONE', settled: true } };
    assert.deepEqual(classifyFailure(task), { category: 'unknown', phase: 'unclassified' });
    const unsettled = { ...task, lastOutcome: { ...task.lastOutcome, code: 'CAPABILITY_BLOCKED' },
        finalization: { stage: 'unknown', recovery: 'NEEDS_PROCESS_EVIDENCE', settled: false } };
    assert.deepEqual(classifyFailure(unsettled), { category: 'unknown', phase: 'unclassified' });
});
