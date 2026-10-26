'use strict';

// RED-REPRO for the dual daemon crash-recovery gap (coordinator brief, 2026-10-25).
//
// BUG 1 (this worker's fix): the daemon is killed mid-implement. The AGY lease
// expires, the controller operation is never settled, and no handoff or
// lastOutcome exists. On the next session.resume the authority layer answers
// NEEDS_LEASE_RECOVERY forever instead of re-dispatching implement in the
// SAME authority attempt with the SAME binding/baseline/allowed_files.
//
// BUG 2: orphan settlement records a failed outcome; unknown causes require
// classification before a correction can start a new authority attempt.
//
// Safety invariants (must hold on base AND after the fix):
//   - a lease that has NOT expired still means AGY_IN_PROGRESS: no re-dispatch.
//   - an expired lease with a provably LIVE tracked worker process must NOT
//     re-dispatch (duplicate workers writing one workspace is forbidden).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { runIsolatedTask: runRealIsolatedTask } = require('../lib/dual/isolated-runner');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { createOrchestratorAdapter: createRealOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
const { createOperationLifecycleWriter } = require('../lib/dual/operation-lifecycle-writer');
const { tryReclaimOrphanedTaskLease } = require('../lib/dual/isolated-authority');
const { requestTaskCorrection, recordTaskOutcome, authorizeCorrection } = require('../lib/dual/task-correction');
const { listOperations } = require('../lib/dual/operation-lifecycle');
const { confirmedDead, confirmedProcessGroupDead } = require('../lib/dual/task-processes');

const { createDiscussionStub } = require('./helpers/dual-discussion-stub');

function discussionForWorker(worker, hooks = {}) {
    return createDiscussionStub({
        ...hooks,
        async turn({ workerRoot, phase, taskId, env, spawnImpl }) {
            const runDir = path.join(workerRoot, '.omni/codex-gemini/runs', taskId);
            const prompt = fs.readFileSync(path.join(runDir, `raw/${phase}.1.input.md`), 'utf8');
            const result = await worker({ cwd: workerRoot, transport: 'discussion', args: [`-p=Execute the ${phase} phase. Read .omni/codex-gemini/runs/${taskId}/raw/${phase}.1.input.md\n${prompt}`] }, { env, spawn: spawnImpl });
            return JSON.parse(result.stdout).structured_output;
        },
    });
}

function withDiscussionWorker(options) {
    const { worker = fakeWorker([]), ...rest } = options;
    const discussion = options.discussion ?? discussionForWorker(worker);
    return { ...rest, discussion,
        processRunner: async (invocation, deps) => {
            assert.ok(invocation.args.some((arg) => arg.startsWith('-p=') && arg.includes('implement phase')),
                'Only implement may call processRunner; scout/review must use discussion');
            return worker(invocation, deps);
        },
    };
}
function runIsolatedTask(options) { return runRealIsolatedTask(withDiscussionWorker(options)); }
function createOrchestratorAdapter(options) { return createRealOrchestratorAdapter(withDiscussionWorker(options)); }

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-resume-orphan-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Return the number two.\n');
    return { workspaceRoot: root, sessionId: 'session-1', attempt: 1, planRevision: 1,
        task: { task_id: 'TASK-1', model: 'gemini-3.8-flash-high', effort: 'high', goal: 'Return two', allowed_files: ['index.js'], context_files: ['spec.md'],
            deny_patterns: [], validation_commands: [{ program: 'node', args: ['--check', 'index.js'], cwd: '.' }] },
        capability: { version: '1.1.27-test', model: 'gemini-3.8-flash-high' }, authorize: () => true };
}

function fakeWorker(calls) {
    return async (invocation, options) => {
        calls.push(invocation);
        assert.ok(options.env.GIT_CEILING_DIRECTORIES);
        const taskId = fs.readdirSync(path.join(invocation.cwd, '.omni/codex-gemini/runs'))[0];
        const taskRun = path.join(invocation.cwd, '.omni/codex-gemini/runs', taskId);
        const spec = JSON.parse(fs.readFileSync(path.join(taskRun, 'spec.json'), 'utf8'));
        const common = { schema_version: 1, task_id: taskId, expected_baseline: spec.expected_baseline };
        const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
        let payload;
        if (prompt.includes('scout phase')) payload = { ...common, summary: 'Read index and spec',
            relevant_files: [{ path: 'index.js', description: 'return value' }], exact_symbols: [],
            validation_commands: ['node --check index.js'], constraints: ['scope only'], risks: [], open_questions: [],
            research_trace: ['index.js', 'spec.md'].map((source) => ({ question: 'What to change?', source,
                source_type: 'REPOSITORY', conclusion: 'Return two' })),
            alternatives_considered: [{ option: 'Edit existing', tradeoff: 'small' }, { option: 'New file', tradeoff: 'unnecessary' }],
            failure_modes: ['wrong return value'] };
        else if (prompt.includes('implement phase')) {
            const target = spec.allowed_files[0];
            fs.writeFileSync(path.join(invocation.cwd, target), 'module.exports = 2;\n');
            payload = { ...common, status: 'SUCCESS', modified_files: [target],
                command_outputs: [{ command: 'node --check index.js', exit_code: 0, output: '' }], unverified_items: [],
                self_review: { checks: ['scope', 'syntax', 'value'], remaining_risks: [] } };
        } else payload = { ...common, recommendation: 'APPROVE', risk_level: 'LOW', findings: [],
            review_checks: ['scope', 'syntax', 'value'], challenge_summary: 'Compared original and changed return.' };
        return { exitCode: 0, stdout: JSON.stringify({ status: 'success', structured_output: payload }), stderr: '',
            timedOut: false, startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
    };
}

// Simulates the daemon dying mid-implement: the implement call never resolves
// (no phase.failed, no handoff, no outcome, operation never settled).
function hangImplementWorker(calls) {
    const base = fakeWorker(calls);
    return async (invocation, options) => {
        const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
        if (prompt && prompt.includes('implement phase')) {
            calls.push(invocation);
            return new Promise(() => {});
        }
        return base(invocation, options);
    };
}

function seedAuthority(input) {
    const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
    const { writeInitialSnapshot } = require('../lib/dual/snapshot-store');
    const dir = path.join(input.workspaceRoot, '.omni/runs/dual-authority');
    const workspaceId = 'workspace-test';
    const snapshot = createConfiguredSnapshotBaseline({ root: input.workspaceRoot }).baseline.capture();
    const store = createAuthorityStore(dir);
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: input.workspaceRoot,
        workspace_id: workspaceId, session_id: input.sessionId, plan_revision: 1,
        expected_baseline: snapshot.identity, mode: 'auto' });
    writeInitialSnapshot({ authorityDir: dir, sessionId: input.sessionId, workspaceId,
        workspaceRoot: input.workspaceRoot, identity: snapshot.identity, manifest: snapshot.manifest });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: { agy_version: input.capability.version, agy_model: input.capability.model } });
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'spec.md', plan_sha256: 'b'.repeat(64), total_tasks: 1,
        tasks: [{ ...input.task, title: 'Task one', owner: 'agy', risk: 'low', execution_mode: 'isolated' }] });
    store.append({ schema_version: 2, type: 'task.routed', task_id: 'TASK-1', owner: 'agy', authority_state: 'ROUTED',
        allowed_files: input.task.allowed_files, model: input.capability.model, effort: 'high', reason: 'Private task' });
    return { store, dir, snapshot };
}

function deadPid() {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
        const pid = child.pid;
        child.once('close', () => resolve(pid));
    });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(condition, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await condition()) return;
        await sleep(100);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

// Builds the exact post-kill authority state: prepared workspace + execution
// owned by a dead controller pid + an active (never settled) operation +
// implement phase.started with no outcome. When `leaseTtlMs` elapses the
// lease reads as expired, which is the orphan resume must recover from.
async function craftOrphan(t, input, store, {
    leaseTtlMs = 5000,
    liveChild = false,
    extraProcessPid = null,
    pendingChild = false,
    withHandoff = false,
    withOutcome = false,
} = {}) {
    const controllerPid = await deadPid();
    const lease = store.acquireLease('TASK-1', 'agy', { ttlMs: leaseTtlMs });
    store.append({ schema_version: 2, type: 'task.execution.started', task_id: 'TASK-1',
        lease_id: lease.lease_id, controller_pid: controllerPid });
    const operationId = crypto.randomUUID();
    createOperationLifecycleWriter(store).begin({ taskId: 'TASK-1', leaseId: lease.lease_id, operationId });
    let reference = null;
    const hangCalls = [];
    const pending = runIsolatedTask({ workspaceRoot: input.workspaceRoot, sessionId: input.sessionId, attempt: 1, planRevision: 1,
        task: store.derive().tasks['TASK-1'], capability: input.capability, worker: hangImplementWorker(hangCalls),
        authorize: () => true,
        onPrepared(ref) {
            reference = ref;
            store.append({ schema_version: 2, type: 'task.workspace.prepared', task_id: 'TASK-1',
                lease_id: lease.lease_id, attempt: 1,
                reference: { bindingPath: ref.bindingPath, bindingSha256: ref.bindingSha256,
                    workerBaselineSha256: ref.workerBaselineSha256, workerContractSha256: ref.workerContractSha256 } });
        } });
    pending.catch(() => {});
    await waitFor(() => {
        if (!reference) return false;
        const eventsPath = path.join(reference.workerRoot, '.omni/codex-gemini/runs/TASK-1/events.ndjson');
        if (!fs.existsSync(eventsPath)) return false;
        const lines = fs.readFileSync(eventsPath, 'utf8');
        return lines.includes('"phase":"implement"') && lines.includes('"type":"phase.started"');
    }, 20000, 'implement phase.started in the orphaned worker run');
    let trackedChild = null;
    if (liveChild) {
        trackedChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
        t.after(() => { try { trackedChild.kill(); } catch {} });
        const processId = crypto.randomUUID();
        store.append({ schema_version: 2, type: 'task.process.intent', task_id: 'TASK-1',
            lease_id: lease.lease_id, process_id: processId });
        store.append({ schema_version: 2, type: 'task.process.started', task_id: 'TASK-1',
            lease_id: lease.lease_id, process_id: processId, pid: trackedChild.pid });
    }
    if (extraProcessPid) {
        const processId = crypto.randomUUID();
        store.append({ schema_version: 2, type: 'task.process.intent', task_id: 'TASK-1',
            lease_id: lease.lease_id, process_id: processId });
        store.append({ schema_version: 2, type: 'task.process.started', task_id: 'TASK-1',
            lease_id: lease.lease_id, process_id: processId, pid: extraProcessPid });
    }
    if (pendingChild) {
        const processId = crypto.randomUUID();
        store.append({ schema_version: 2, type: 'task.process.intent', task_id: 'TASK-1',
            lease_id: lease.lease_id, process_id: processId });
    }
    if (withHandoff) {
        store.append({ schema_version: 2, type: 'task.workspace.handoff', task_id: 'TASK-1',
            lease_id: lease.lease_id, attempt: 1, handoff_path: 'mock/handoff.json',
            handoff_sha256: crypto.createHash('sha256').update('handoff').digest('hex'),
            result_sha256: crypto.createHash('sha256').update('result').digest('hex') });
    }
    if (withOutcome) {
        store.append({ schema_version: 2, type: 'task.execution.outcome', task_id: 'TASK-1',
            lease_id: lease.lease_id, attempt: 1, status: 'FAILED', code: 'DUAL_WORKER_EXECUTION_FAILED',
            summary: 'Prior failure' });
    }
    if (leaseTtlMs < 120000) {
        await waitFor(() => {
            const derived = store.derive();
            return Object.values(derived.leases).find((candidate) => candidate.lease_id === lease.lease_id)?.status === 'expired';
        }, 30000, 'orphan lease to expire');
    }
    const derived = store.derive();
    if (!withHandoff) {
        assert.equal(derived.tasks['TASK-1'].isolatedHandoff, undefined, 'orphan must have no handoff');
    }
    if (!withOutcome) {
        assert.equal(derived.tasks['TASK-1'].lastOutcome, undefined, 'orphan must have no lastOutcome');
    }
    return { lease, operationId, reference, hangCalls, trackedChild, controllerPid };
}

test('BUG 1: resume after a daemon kill re-dispatches the orphaned implement in the SAME attempt', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    const orphan = await craftOrphan(t, input, store);
    const calls = [];
    const results = await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: fakeWorker(calls) }).runTask(store.derive());
    assert.equal(results[0].status, 'AWAITING_CODEX_QC',
        `resume must re-dispatch the orphaned implement, got ${JSON.stringify(results[0])}`);
    const after = store.derive();
    assert.equal(after.tasks['TASK-1'].lastOutcome, undefined, 'new execution supersedes worker-lost outcome');
    assert.ok(after.tasks['TASK-1'].isolatedHandoff, 're-dispatch records a clean handoff');
    assert.equal(after.tasks['TASK-1'].isolatedWorkspace.attempt, 1, 're-dispatch keeps the same authority attempt');
    assert.equal(after.tasks['TASK-1'].isolatedWorkspace.reference.bindingSha256, orphan.reference.bindingSha256,
        're-dispatch keeps the same binding');
    assert.equal(after.tasks['TASK-1'].isolatedWorkspace.reference.workerBaselineSha256, orphan.reference.workerBaselineSha256,
        're-dispatch keeps the same baseline');
    assert.deepEqual(after.tasks['TASK-1'].allowed_files, ['index.js'], 're-dispatch keeps allowed_files');
    assert.equal(Object.values(after.leases).some((lease) => lease.lease_id === orphan.lease.lease_id && lease.status !== 'released'),
        false, 'the orphaned lease must be settled, not left unreleased');
    assert.equal(after.leases[orphan.lease.lease_id]?.status, 'released', 'the orphaned lease status must directly be released');
    const events = store.readEvents();
    const recoveredEvent = events.find((e) => e.type === 'task.lease.recovered' && e.lease_id === orphan.lease.lease_id);
    assert.ok(recoveredEvent, 'must record task.lease.recovered event');
    assert.equal(recoveredEvent.recovery_kind, 'daemon_reclaimed', 'recovery kind must be daemon_reclaimed');
    const recoveredIndex = events.indexOf(recoveredEvent);
    const nextExecution = events.find((e, idx) => idx > recoveredIndex && e.type === 'task.execution.started' && e.task_id === 'TASK-1');
    assert.ok(nextExecution, 'task.execution.started must follow task.lease.recovered in journal');
    assert.equal(after.tasks['TASK-1'].executions[nextExecution.lease_id].attempt, 1, 'resumed execution must be attempt 1');
    assert.ok(calls.some((invocation) => invocation.args.some((arg) => arg.startsWith('-p=') && arg.includes('implement phase'))),
        'resume must actually invoke implement again');
});

test('safety: resume does NOT re-dispatch while the orphan lease is still active', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    await craftOrphan(t, input, store, { leaseTtlMs: 120000 });
    const calls = [];
    const results = await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: fakeWorker(calls) }).runTask(store.derive());
    assert.equal(results[0].status, 'AGY_IN_PROGRESS');
    assert.equal(calls.length, 0, 'no worker call while the previous worker may still be alive');
});

test('safety: resume does NOT re-dispatch while a tracked worker process is still alive', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    await craftOrphan(t, input, store, { liveChild: true });
    const calls = [];
    const results = await createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        worker: fakeWorker(calls) }).runTask(store.derive());
    assert.equal(results[0].status, 'NEEDS_LEASE_RECOVERY',
        'a live worker process must return NEEDS_LEASE_RECOVERY and never be duplicated');
    assert.equal(calls.length, 0, 'no worker call while the previous worker process is alive');
});

test('BUG 2: settlement after a daemon kill preserves failure and parks for classification', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    const orphan = await craftOrphan(t, input, store);
    createOperationLifecycleWriter(store).settle({ taskId: 'TASK-1', leaseId: orphan.lease.lease_id,
        operationId: orphan.operationId, outcome: 'failed', orphan: true });
    store.append({ schema_version: 2, type: 'task.lease.recovered', task_id: 'TASK-1',
        lease_id: orphan.lease.lease_id, recovery_kind: 'daemon_reclaimed',
        confirmed_dead_pids: [orphan.controllerPid], operation_id: orphan.operationId, operation_outcome: 'failed' });
    const settled = store.derive().tasks['TASK-1'];
    assert.throws(() => requestTaskCorrection({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        sessionId: input.sessionId, planRevision: 1, taskId: 'TASK-1',
        requestId: 'correct-after-kill', expectedAttempt: 1, reason: 'Retry after daemon kill.' }),
    { code: 'DUAL_CORRECTION_CLASSIFICATION_REQUIRED' });
    assert.match(settled.lastOutcome.summary, /\S/);
    assert.deepEqual(settled.lastOutcome, { attempt: 1, status: 'FAILED', code: 'DUAL_WORKER_LOST',
        summary: settled.lastOutcome.summary });
    assert.equal(store.derive().tasks['TASK-1'].previousAttempts, undefined);
    assert.equal(store.derive().tasks['TASK-1'].lastOutcome.code, 'DUAL_WORKER_LOST');
});

test('BUG 2: production reclaim records worker loss and requires classification before correction', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    const orphan = await craftOrphan(t, input, store);
    const lease = Object.values(store.derive().leases).find((candidate) => candidate.lease_id === orphan.lease.lease_id);
    assert.equal(lease.status, 'expired');
    assert.equal(tryReclaimOrphanedTaskLease({ authorityStore: store, taskId: 'TASK-1', lease,
        operationWriter: createOperationLifecycleWriter(store) }), true);
    assert.equal(store.derive().tasks['TASK-1'].lastOutcome.code, 'DUAL_WORKER_LOST');
    assert.throws(() => requestTaskCorrection({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        sessionId: input.sessionId, planRevision: 1, taskId: 'TASK-1',
        requestId: 'production-correct-after-kill', expectedAttempt: 1, reason: 'Retry after daemon kill.' }),
    { code: 'DUAL_CORRECTION_CLASSIFICATION_REQUIRED' });
    assert.equal(store.derive().tasks['TASK-1'].previousAttempts, undefined);
    assert.equal(store.derive().tasks['TASK-1'].lastOutcome.code, 'DUAL_WORKER_LOST');
});

test('Regression P1-1: live detached descendant blocks reclaim; reclaim proceeds once group dies', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    const grandchildPidFile = path.join(input.workspaceRoot, 'grandchild.pid');

    const grandchildScript = `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(grandchildPidFile)}, String(process.pid) + '\\n');
setTimeout(() => {}, 60000);
`;
    const parentScript = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });
grandchild.unref();
const pidFile = ${JSON.stringify(grandchildPidFile)};
const check = () => {
    if (fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim().length > 0) {
        process.exit(0);
    }
    setTimeout(check, 20);
};
check();
`;
    const parent = spawn(process.execPath, ['-e', parentScript], {
        detached: true,
        stdio: 'ignore',
    });
    const parentPid = parent.pid;

    await waitFor(() => fs.existsSync(grandchildPidFile) && fs.readFileSync(grandchildPidFile, 'utf8').trim().length > 0,
        15000, 'grandchild pid file');
    const grandchildPid = Number(fs.readFileSync(grandchildPidFile, 'utf8').trim());

    await waitFor(() => confirmedDead(parentPid), 15000, 'parent process to exit');

    t.after(() => {
        try {
            if (grandchildPid && !confirmedDead(grandchildPid)) {
                process.kill(grandchildPid, 'SIGKILL');
            }
        } catch {}
        try {
            if (parentPid && !confirmedProcessGroupDead(parentPid)) {
                process.kill(-parentPid, 'SIGKILL');
            }
        } catch {}
    });

    const orphan = await craftOrphan(t, input, store, { extraProcessPid: parentPid });

    // (i) Confirm parent is ESRCH dead but group is alive
    assert.equal(confirmedDead(parentPid), true, 'parent process must be dead');
    assert.equal(confirmedProcessGroupDead(parentPid), false, 'process group must still be alive via grandchild');

    // (ii) tryReclaimOrphanedTaskLease directly and via orchestrator resume
    const leaseBefore = store.derive().leases[orphan.lease.lease_id];
    const directReclaim = tryReclaimOrphanedTaskLease({
        authorityStore: store,
        taskId: 'TASK-1',
        lease: leaseBefore,
        operationWriter: createOperationLifecycleWriter(store),
    });
    assert.equal(directReclaim, false, 'tryReclaimOrphanedTaskLease must return false while process group is alive');

    const calls = [];
    const resumeResults = await createOrchestratorAdapter({
        workspaceRoot: input.workspaceRoot,
        authorityStore: store,
        worker: fakeWorker(calls),
    }).runTask(store.derive());
    assert.equal(resumeResults[0].status, 'NEEDS_LEASE_RECOVERY', 'resume must answer NEEDS_LEASE_RECOVERY');
    assert.equal(calls.length, 0, 'no worker calls while process group is alive');

    const derivedWhileBlocked = store.derive();
    assert.equal(derivedWhileBlocked.tasks['TASK-1'].lastOutcome, undefined, 'no lastOutcome while process group is alive');
    assert.equal(derivedWhileBlocked.leases[orphan.lease.lease_id].status, 'expired', 'lease must remain expired');
    assert.equal(derivedWhileBlocked.leases[orphan.lease.lease_id].released_at, null, 'lease must not be released');
    const events = store.readEvents();
    assert.equal(events.some((e) => e.type === 'task.lease.recovered'), false, 'no task.lease.recovered event while process group is alive');
    const ops = listOperations({ authorityStore: store, taskId: 'TASK-1', leaseId: orphan.lease.lease_id });
    const op = ops.find((o) => o.operation_id === orphan.operationId);
    assert.ok(op && op.active && !op.settled, 'operation must remain active and unsettled');

    // (iii) kill grandchild, wait for group ESRCH dead, call tryReclaim again
    process.kill(grandchildPid, 'SIGKILL');
    await waitFor(() => confirmedProcessGroupDead(parentPid), 15000, 'process group to die after grandchild kill');

    const leaseExpired = store.derive().leases[orphan.lease.lease_id];
    const secondReclaim = tryReclaimOrphanedTaskLease({
        authorityStore: store,
        taskId: 'TASK-1',
        lease: leaseExpired,
        operationWriter: createOperationLifecycleWriter(store),
    });
    assert.equal(secondReclaim, true, 'tryReclaimOrphanedTaskLease must proceed after process group is dead');
    assert.equal(store.derive().tasks['TASK-1'].lastOutcome?.code, 'DUAL_WORKER_LOST');
});

test('reclaim called a second time returns false', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    const orphan = await craftOrphan(t, input, store);
    const operationWriter = createOperationLifecycleWriter(store);
    const lease = Object.values(store.derive().leases).find((candidate) => candidate.lease_id === orphan.lease.lease_id);
    assert.equal(lease.status, 'expired');
    const firstReclaim = tryReclaimOrphanedTaskLease({ authorityStore: store, taskId: 'TASK-1', lease, operationWriter });
    assert.equal(firstReclaim, true);
    assert.equal(store.derive().tasks['TASK-1'].lastOutcome?.code, 'DUAL_WORKER_LOST');
    assert.equal(store.derive().leases[orphan.lease.lease_id]?.status, 'released');

    // Second call with the newly derived (released) lease
    const leaseAfter = store.derive().leases[orphan.lease.lease_id];
    assert.equal(tryReclaimOrphanedTaskLease({ authorityStore: store, taskId: 'TASK-1', lease: leaseAfter, operationWriter }), false);

    // Second call with the original lease object (now blocked by task outcome)
    assert.equal(tryReclaimOrphanedTaskLease({ authorityStore: store, taskId: 'TASK-1', lease, operationWriter }), false);
});

test('reclaim refused when a tracked child process is pending', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    const orphan = await craftOrphan(t, input, store, { pendingChild: true });
    const operationWriter = createOperationLifecycleWriter(store);
    const lease = store.derive().leases[orphan.lease.lease_id];
    assert.equal(lease.status, 'expired');
    const result = tryReclaimOrphanedTaskLease({ authorityStore: store, taskId: 'TASK-1', lease, operationWriter });
    assert.equal(result, false, 'reclaim must return false when child process intent is pending without started');
    assert.equal(store.derive().tasks['TASK-1'].lastOutcome, undefined);
    assert.equal(store.derive().leases[orphan.lease.lease_id]?.status, 'expired');
});

test('reclaim refused when task already has handoff', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    const orphan = await craftOrphan(t, input, store, { withHandoff: true });
    const operationWriter = createOperationLifecycleWriter(store);
    const lease = store.derive().leases[orphan.lease.lease_id];
    assert.equal(lease.status, 'expired');
    assert.ok(store.derive().tasks['TASK-1'].isolatedHandoff);
    const result = tryReclaimOrphanedTaskLease({ authorityStore: store, taskId: 'TASK-1', lease, operationWriter });
    assert.equal(result, false, 'reclaim must return false when task already has isolated handoff');
    assert.equal(store.derive().leases[orphan.lease.lease_id]?.status, 'expired');
});

test('reclaim refused when task already has outcome', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    const orphan = await craftOrphan(t, input, store, { withOutcome: true });
    const operationWriter = createOperationLifecycleWriter(store);
    const lease = store.derive().leases[orphan.lease.lease_id];
    assert.equal(lease.status, 'expired');
    assert.ok(store.derive().tasks['TASK-1'].lastOutcome);
    const result = tryReclaimOrphanedTaskLease({ authorityStore: store, taskId: 'TASK-1', lease, operationWriter });
    assert.equal(result, false, 'reclaim must return false when task already has outcome');
    assert.equal(store.derive().leases[orphan.lease.lease_id]?.status, 'expired');
});

test('attempt-2 orphan reclaim succeeds and records DUAL_WORKER_LOST for attempt 2', async (t) => {
    const input = fixture(t);
    const { store } = seedAuthority(input);
    // Reach attempt 2 through a known worker failure. Worker loss itself
    // remains unknown and cannot authorize a correction.
    const firstLease = store.acquireLease('TASK-1', 'agy');
    recordTaskOutcome({ authorityStore: store, taskId: 'TASK-1', leaseId: firstLease.lease_id,
        status: 'FAILED', code: 'RESULT_MALFORMED', summary: 'Malformed worker result in attempt 1.' });
    store.releaseLease(firstLease.lease_id, 'test_failure');
    const operationWriter = createOperationLifecycleWriter(store);

    const corrected = requestTaskCorrection({
        workspaceRoot: input.workspaceRoot,
        authorityStore: store,
        sessionId: input.sessionId,
        planRevision: 1,
        taskId: 'TASK-1',
        requestId: 'production-correct-attempt-1',
        expectedAttempt: 1,
        reason: 'Retry after malformed worker result in attempt 1.',
    });
    assert.equal(corrected.attempt, 2);

    // Build attempt 2 orphan state following the craftOrphan journal pattern:
    const controllerPid2 = await deadPid();
    const lease2 = store.acquireLease('TASK-1', 'agy', { ttlMs: 1000 });
    store.append({
        schema_version: 2,
        type: 'task.execution.started',
        task_id: 'TASK-1',
        lease_id: lease2.lease_id,
        controller_pid: controllerPid2,
    });
    const operationId2 = crypto.randomUUID();
    operationWriter.begin({ taskId: 'TASK-1', leaseId: lease2.lease_id, operationId: operationId2 });
    store.append({
        schema_version: 2,
        type: 'task.workspace.prepared',
        task_id: 'TASK-1',
        lease_id: lease2.lease_id,
        attempt: 2,
        reference: {
            bindingPath: '.omni/binding-attempt-2.json',
            bindingSha256: crypto.createHash('sha256').update('binding-2').digest('hex'),
            workerBaselineSha256: crypto.createHash('sha256').update('baseline-2').digest('hex'),
            workerContractSha256: crypto.createHash('sha256').update('contract-2').digest('hex'),
        },
    });

    await waitFor(() => {
        const derived = store.derive();
        return derived.leases[lease2.lease_id]?.status === 'expired';
    }, 10000, 'attempt 2 lease to expire');

    const derivedBeforeReclaim2 = store.derive();
    assert.equal(derivedBeforeReclaim2.tasks['TASK-1'].isolatedHandoff, undefined);
    assert.equal(derivedBeforeReclaim2.tasks['TASK-1'].lastOutcome, undefined);
    assert.equal(derivedBeforeReclaim2.leases[lease2.lease_id]?.status, 'expired');

    const reclaim2 = tryReclaimOrphanedTaskLease({
        authorityStore: store,
        taskId: 'TASK-1',
        lease: derivedBeforeReclaim2.leases[lease2.lease_id],
        operationWriter,
    });
    assert.equal(reclaim2, true, 'reclaim of attempt 2 orphan must succeed');

    const derivedAfter = store.derive();
    assert.equal(derivedAfter.tasks['TASK-1'].lastOutcome?.code, 'DUAL_WORKER_LOST');
    assert.equal(derivedAfter.tasks['TASK-1'].lastOutcome?.attempt, 2);
    assert.equal(derivedAfter.tasks['TASK-1'].lastOutcome?.status, 'FAILED');
    assert.equal(derivedAfter.leases[lease2.lease_id]?.status, 'released');
    // This journal fixture has a synthetic binding; check recovery policy
    // directly without bypassing the production binding validation.
    assert.throws(() => authorizeCorrection(derivedAfter.tasks['TASK-1'], { expectedAttempt: 2 }),
    { code: 'DUAL_CORRECTION_CLASSIFICATION_REQUIRED' });
    assert.equal(derivedAfter.tasks['TASK-1'].previousAttempts.length, 1);
    assert.equal(derivedAfter.tasks['TASK-1'].previousAttempts[0].outcome?.code, 'RESULT_MALFORMED');
    assert.equal(derivedAfter.tasks['TASK-1'].previousAttempts[0].outcome?.attempt, 1);
});
