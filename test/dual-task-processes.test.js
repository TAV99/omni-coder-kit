'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { createTrackedSpawn, recoverTaskLease, releaseSettledTaskLease } = require('../lib/dual/task-processes');
const { startDaemonServer } = require('../lib/dual/daemon-server');
const { createDaemonClient } = require('../lib/dual/daemon-client');

function fixture(t, ownerPid = process.pid) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-process-recovery-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createAuthorityStore(path.join(root, '.omni/runs/dual-authority'));
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'ws', session_id: 'session', plan_revision: 1, expected_baseline: { kind: 'snapshot', id: 'a'.repeat(64) }, mode: 'auto' });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'fixture', status: 'PASSED' }] });
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'plan.md', plan_sha256: 'b'.repeat(64), total_tasks: 1,
        tasks: [{ task_id: 'TASK-1', title: 'task', owner: 'agy', execution_mode: 'isolated', allowed_files: ['a.js'] }] });
    store.append({ schema_version: 2, type: 'task.routed', task_id: 'TASK-1', owner: 'agy', authority_state: 'ROUTED',
        allowed_files: ['a.js'], reason: 'fixture' });
    const lease = store.acquireLease('TASK-1', 'agy');
    if (ownerPid !== null) store.append({ schema_version: 2, type: 'task.execution.started', task_id: 'TASK-1', lease_id: lease.lease_id, controller_pid: ownerPid });
    return { root, store, lease };
}

test('tracked native child records start and exit while keeping argv out of ledger', async (t) => {
    const { root, store, lease } = fixture(t);
    const tracked = createTrackedSpawn({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id });
    const child = tracked(process.execPath, ['-e', 'process.stdout.write("PRIVATE_ARGUMENT_MARKER")'],
        { cwd: root, shell: false, windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve) => child.once('close', resolve));
    const events = store.readEvents();
    assert.equal(events.filter((event) => event.type === 'task.process.intent').length, 1);
    assert.equal(events.filter((event) => event.type === 'task.process.started')[0].pid, child.pid);
    assert.equal(events.filter((event) => event.type === 'task.process.exited')[0].exit_code, 0);
    assert.equal(JSON.stringify(events).includes('PRIVATE_ARGUMENT_MARKER'), false);
});

test('lease recovery refuses a live controller regardless of expiry assumptions', (t) => {
    const { root, store, lease } = fixture(t);
    assert.equal(recoverTaskLease({ workspaceRoot: root, authorityStore: store, sessionId: 'session', taskId: 'TASK-1', planRevision: 1 }).status,
        'WAITING_FOR_PROCESS');
    assert.equal(store.derive().leases[lease.lease_id].status, 'active');
});

test('dead direct worker does not prove detached descendants are gone', (t) => {
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { shell: false, windowsHide: true });
    assert.equal(dead.status, 0);
    const { root, store, lease } = fixture(t, dead.pid);
    store.append({ schema_version: 2, type: 'task.process.intent', task_id: 'TASK-1', lease_id: lease.lease_id, process_id: 'proc-1' });
    store.append({ schema_version: 2, type: 'task.process.started', task_id: 'TASK-1', lease_id: lease.lease_id, process_id: 'proc-1', pid: dead.pid });
    const result = recoverTaskLease({ workspaceRoot: root, authorityStore: store, sessionId: 'session', taskId: 'TASK-1', planRevision: 1 });
    assert.equal(result.status, 'NEEDS_PROCESS_TREE_EVIDENCE');
    assert.equal(store.derive().leases[lease.lease_id].status, 'active');
    assert.notEqual(store.derive().tasks['TASK-1'].state, 'TASK_VERIFIED');
});

test('recovery never releases a lease with a live worker or an uncorrelated spawn intent', async (t) => {
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { shell: false, windowsHide: true });
    const { root, store, lease } = fixture(t, dead.pid);
    const request = { workspaceRoot: root, authorityStore: store, sessionId: 'session', taskId: 'TASK-1', planRevision: 1 };
    store.append({ schema_version: 2, type: 'task.process.intent', task_id: 'TASK-1', lease_id: lease.lease_id, process_id: 'proc-1' });
    assert.equal(recoverTaskLease(request).status, 'NEEDS_PROCESS_EVIDENCE');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { shell: false, windowsHide: true, stdio: 'ignore' });
    t.after(() => child.kill());
    store.append({ schema_version: 2, type: 'task.process.started', task_id: 'TASK-1', lease_id: lease.lease_id, process_id: 'proc-1', pid: child.pid });
    assert.equal(recoverTaskLease(request).status, 'WAITING_FOR_PROCESS');
    assert.equal(store.derive().leases[lease.lease_id].status, 'active');
    child.kill();
    await new Promise((resolve) => child.once('close', resolve));
    assert.equal(recoverTaskLease(request).status, 'NEEDS_PROCESS_TREE_EVIDENCE');
});

test('normal cleanup does not release a task while a child has not closed', (t) => {
    const { store, lease } = fixture(t);
    store.append({ schema_version: 2, type: 'task.process.intent', task_id: 'TASK-1', lease_id: lease.lease_id, process_id: 'proc-1' });
    assert.equal(releaseSettledTaskLease({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, reason: 'finished' }), false);
    assert.equal(store.derive().leases[lease.lease_id].status, 'active');
    store.append({ schema_version: 2, type: 'task.process.exited', task_id: 'TASK-1', lease_id: lease.lease_id, process_id: 'proc-1', exit_code: null });
    assert.equal(releaseSettledTaskLease({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, reason: 'finished' }), true);
});

test('deferred cleanup releases the lease when the tracked child finally closes', async (t) => {
    const { root, store, lease } = fixture(t);
    const child = createTrackedSpawn({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id })(
        process.execPath, ['-e', 'setTimeout(()=>{},80)'], { cwd: root, shell: false, windowsHide: true, stdio: 'ignore' });
    assert.equal(releaseSettledTaskLease({ authorityStore: store, taskId: 'TASK-1', leaseId: lease.lease_id, reason: 'waiting_for_close' }), false);
    await new Promise((resolve) => child.once('close', resolve));
    assert.equal(store.derive().leases[lease.lease_id].status, 'released');
    assert.equal(store.derive().leases[lease.lease_id].release_reason, 'waiting_for_close');
});

test('daemon recovery verifies process death and preserves idempotent released state', async (t) => {
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { shell: false, windowsHide: true });
    const { root, store, lease } = fixture(t, dead.pid);
    const daemon = await startDaemonServer({ workspaceRoot: root, authorityStore: store });
    t.after(() => daemon.close());
    const client = createDaemonClient({ workspaceRoot: root });
    assert.equal((await client.recoverTask('session', 'TASK-1', 1)).status, 'RECOVERED');
    assert.equal(store.derive().leases[lease.lease_id].status, 'released');
    assert.equal((await client.recoverTask('session', 'TASK-1', 1)).status, 'NO_RECOVERY_NEEDED');
});

test('real controller kill before worker spawn recovers from reopened durable execution evidence', async (t) => {
    const { root, store, lease } = fixture(t, null);
    const modulePath = path.resolve(__dirname, '../lib/dual/authority-store.js');
    const directory = path.join(root, '.omni/runs/dual-authority');
    const script = `const {createAuthorityStore}=require(${JSON.stringify(modulePath)});
const s=createAuthorityStore(${JSON.stringify(directory)});
s.append({schema_version:2,type:'task.execution.started',task_id:'TASK-1',lease_id:${JSON.stringify(lease.lease_id)},controller_pid:process.pid});
process.stdout.write('OWNER_READY'); setInterval(()=>{},1000);`;
    const controller = spawn(process.execPath, ['-e', script], { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => controller.kill());
    await new Promise((resolve, reject) => {
        let output = '';
        controller.stdout.on('data', (bytes) => { output += bytes; if (output.includes('OWNER_READY')) resolve(); });
        controller.once('error', reject);
    });
    const request = { workspaceRoot: root, authorityStore: store, sessionId: 'session', taskId: 'TASK-1', planRevision: 1 };
    assert.equal(recoverTaskLease(request).status, 'WAITING_FOR_PROCESS');
    const closed = new Promise((resolve) => controller.once('close', resolve));
    controller.kill();
    await closed;
    const reopened = createAuthorityStore(directory);
    assert.equal(recoverTaskLease({ ...request, authorityStore: reopened }).status, 'RECOVERED');
    assert.equal(reopened.derive().leases[lease.lease_id].status, 'released');
    assert.notEqual(reopened.derive().tasks['TASK-1'].state, 'TASK_VERIFIED');
});
