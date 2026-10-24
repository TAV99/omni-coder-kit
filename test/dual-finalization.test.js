'use strict';

const { withDiscussion } = require('./helpers/dual-discussion-stub');

function createOrchestratorAdapter(options) {
    return createOrchestratorAdapterImpl(withDiscussion(options));
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

const { createAuthorityStore } = require('../lib/dual/authority-store');
const { createOrchestratorAdapter: createOrchestratorAdapterImpl } = require('../lib/dual/orchestrator-adapter');
const { recoverTaskLease, releaseSettledTaskLease } = require('../lib/dual/task-processes');
const { recordTaskOutcome } = require('../lib/dual/task-correction');
const { inspectOperation } = require('../lib/dual/operation-lifecycle');
const { createOperationLifecycleWriter } = require('../lib/dual/operation-lifecycle-writer');
const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
const { writeInitialSnapshot } = require('../lib/dual/snapshot-store');

function beginOperation({ authorityStore, ...params }) {
    return createOperationLifecycleWriter(authorityStore).begin(params);
}

function fakeClock() {
    let current = Date.parse('2026-09-08T00:00:00.000Z');
    const clock = () => new Date(current);
    clock.advance = (milliseconds) => { current += milliseconds; return clock(); };
    return clock;
}

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-finalization-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Return two.\n');
    return {
        workspaceRoot: root,
        sessionId: 'session-1',
        task: { task_id: 'TASK-1', title: 'finalize', goal: 'Return two', owner: 'agy', model: 'gemini-test', effort: 'high',
            execution_mode: 'isolated', allowed_files: ['index.js'], context_files: ['spec.md'], deny_patterns: [],
            validation_commands: [{ program: 'node', args: ['--check', 'index.js'], cwd: '.' }] },
    };
}

function seedAuthority(input, clock) {
    const dir = path.join(input.workspaceRoot, '.omni/runs/dual-authority');
    const snapshot = createConfiguredSnapshotBaseline({ root: input.workspaceRoot }).baseline.capture();
    const store = createAuthorityStore(dir, { clock });
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: input.workspaceRoot,
        workspace_id: 'workspace-test', session_id: input.sessionId, plan_revision: 1,
        expected_baseline: snapshot.identity, mode: 'auto' });
    writeInitialSnapshot({ authorityDir: dir, sessionId: input.sessionId, workspaceId: 'workspace-test',
        workspaceRoot: input.workspaceRoot, identity: snapshot.identity, manifest: snapshot.manifest });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: { agy_version: '1.1.27-test', agy_model: input.task.model } });
    const { model: _model, ...planTask } = input.task;
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'spec.md', plan_sha256: 'b'.repeat(64), total_tasks: 1,
        tasks: [planTask] });
    store.append({ schema_version: 2, type: 'task.routed', task_id: input.task.task_id, owner: 'agy',
        authority_state: 'ROUTED', allowed_files: input.task.allowed_files, model: input.task.model, effort: input.task.effort, reason: 'test' });
    return { store, dir };
}

function workerThatExpiresBeforeFinalValidation(clock) {
    return async (invocation) => {
        const taskId = fs.readdirSync(path.join(invocation.cwd, '.omni/codex-gemini/runs'))[0];
        const runDir = path.join(invocation.cwd, '.omni/codex-gemini/runs', taskId);
        const spec = JSON.parse(fs.readFileSync(path.join(runDir, 'spec.json'), 'utf8'));
        const common = { schema_version: 1, task_id: taskId, expected_baseline: spec.expected_baseline };
        const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
        let payload;
        if (prompt.includes('scout phase')) payload = { ...common, summary: 'Read files', relevant_files: [], exact_symbols: [],
            validation_commands: ['node --check index.js'], constraints: [], risks: [], open_questions: [],
            research_trace: [{ question: 'What changes?', source: 'index.js', source_type: 'REPOSITORY', conclusion: 'Return two' },
                { question: 'What is expected?', source: 'spec.md', source_type: 'REPOSITORY', conclusion: 'Return two' }],
            alternatives_considered: [{ option: 'edit', tradeoff: 'small' }, { option: 'new', tradeoff: 'large' }],
            failure_modes: ['wrong result'] };
        else if (prompt.includes('implement phase')) {
            fs.writeFileSync(path.join(invocation.cwd, 'index.js'), 'module.exports = 2;\n');
            payload = { ...common, status: 'SUCCESS', modified_files: ['index.js'],
                command_outputs: [{ command: 'node --check index.js', exit_code: 0, output: '' }], unverified_items: [],
                self_review: { checks: ['scope', 'syntax', 'result'], remaining_risks: [] } };
        } else {
            payload = { ...common, recommendation: 'APPROVE', risk_level: 'LOW', findings: [], review_checks: ['scope', 'syntax', 'result'],
                challenge_summary: 'Compared the change.' };
            clock.advance(121_000);
        }
        return { exitCode: 0, stdout: JSON.stringify({ status: 'success', structured_output: payload }), stderr: '',
            timedOut: false, startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
    };
}

function startTrackedExecution(store, taskId) {
    const lease = store.acquireLease(taskId, 'agy');
    store.append({ schema_version: 2, type: 'task.execution.started', task_id: taskId,
        lease_id: lease.lease_id, controller_pid: process.pid });
    return lease;
}

function appendTrackedChild(store, taskId, lease, state = 'exited', exitCode = 0) {
    const processId = 'child-1';
    store.append({ schema_version: 2, type: 'task.process.intent', task_id: taskId, lease_id: lease.lease_id, process_id: processId });
    if (state !== 'pending') {
        store.append({ schema_version: 2, type: 'task.process.started', task_id: taskId, lease_id: lease.lease_id,
            process_id: processId, pid: process.pid });
    }
    if (state === 'exited') {
        store.append({ schema_version: 2, type: 'task.process.exited', task_id: taskId, lease_id: lease.lease_id,
            process_id: processId, exit_code: exitCode });
    }
    return processId;
}

test('expired final validation records a durable failure and exposes recovery when no tracked close exists', async (t) => {
    const input = fixture(t);
    const clock = fakeClock();
    const { store } = seedAuthority(input, clock);
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        processRunner: workerThatExpiresBeforeFinalValidation(clock) });

    await assert.rejects(() => adapter.runTask(store.derive()), (error) => error.code === 'DUAL_ISOLATED_UNAUTHORIZED');

    const derived = store.derive();
    assert.equal(derived.tasks[input.task.task_id].lastOutcome.status, 'FAILED');
    assert.equal(derived.tasks[input.task.task_id].lastOutcome.code, 'DUAL_ISOLATED_UNAUTHORIZED');
    const leases = Object.values(derived.leases).filter((lease) => lease.task_id === input.task.task_id);
    assert.equal(leases.length, 1);
    assert.equal(leases[0].status, 'expired');
    assert.match(derived.tasks[input.task.task_id].lastOutcome.summary, /NEEDS_PROCESS_EVIDENCE/);
    assert.equal(derived.tasks[input.task.task_id].state, 'ROUTED');
    assert.equal(derived.tasks[input.task.task_id].isolatedHandoff, undefined);
});

test('expired finalization settles only after a tracked child has a numeric close and is idempotent', (t) => {
    const input = fixture(t);
    const clock = fakeClock();
    const { store, dir } = seedAuthority(input, clock);
    const lease = startTrackedExecution(store, input.task.task_id);
    appendTrackedChild(store, input.task.task_id, lease);
    clock.advance(31_000);

    const recorded = store.recordFinalizationFailure({ taskId: input.task.task_id, leaseId: lease.lease_id,
        attempt: 1, code: 'DUAL_ISOLATED_EVIDENCE_INVALID', stage: 'post_worker_collection' });
    assert.equal(recorded.settled, true);
    assert.equal(recorded.recovery, 'NONE');
    assert.equal(store.derive().leases[lease.lease_id].status, 'released');
    assert.equal(store.derive().tasks[input.task.task_id].lastOutcome.status, 'FAILED');
    const reopened = createAuthorityStore(dir, { clock });
    const replayed = reopened.recordFinalizationFailure({ taskId: input.task.task_id, leaseId: lease.lease_id,
        attempt: 1, code: 'DUAL_ISOLATED_EVIDENCE_INVALID', stage: 'post_worker_collection' });
    assert.equal(replayed.idempotent, true);
    assert.equal(reopened.readEvents().filter((event) => event.type === 'task.execution.finalization_failed').length, 1);
    assert.equal(reopened.verifyIntegrity().valid, true);
});

test('expired finalization stays unsettled while the matching durable operation is active', (t) => {
    const input = fixture(t);
    const clock = fakeClock();
    const { store } = seedAuthority(input, clock);
    const lease = startTrackedExecution(store, input.task.task_id);
    const operationId = crypto.randomUUID();
    beginOperation({ authorityStore: store, taskId: input.task.task_id, leaseId: lease.lease_id, operationId });
    appendTrackedChild(store, input.task.task_id, lease);
    clock.advance(31_000);

    const recorded = store.recordFinalizationFailure({ taskId: input.task.task_id, leaseId: lease.lease_id,
        attempt: 1, code: 'DUAL_ISOLATED_EVIDENCE_INVALID', stage: 'post_worker_collection' });
    assert.equal(recorded.settled, false);
    assert.equal(recorded.recovery, 'NEEDS_PROCESS_EVIDENCE');
    assert.equal(store.derive().leases[lease.lease_id].status, 'expired');
    assert.equal(inspectOperation({ authorityStore: store, taskId: input.task.task_id,
        leaseId: lease.lease_id, operationId }).active, true);
    const recovery = recoverTaskLease({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        sessionId: input.sessionId, taskId: input.task.task_id, planRevision: 1 });
    assert.equal(recovery.status, 'NEEDS_PROCESS_EVIDENCE');
    assert.equal(store.readEvents().some((event) => event.type === 'task.lease.recovered'), false);
});

test('replay rejects settled finalization evidence while the matching durable operation is active', (t) => {
    const input = fixture(t);
    const clock = fakeClock();
    const { store } = seedAuthority(input, clock);
    const lease = startTrackedExecution(store, input.task.task_id);
    beginOperation({ authorityStore: store, taskId: input.task.task_id,
        leaseId: lease.lease_id, operationId: crypto.randomUUID() });
    appendTrackedChild(store, input.task.task_id, lease);
    clock.advance(31_000);

    assert.throws(() => store.append({ schema_version: 2, type: 'task.execution.finalization_failed',
        task_id: input.task.task_id, lease_id: lease.lease_id, attempt: 1, controller_pid: process.pid,
        status: 'FAILED', stage: 'post_worker_collection', code: 'DUAL_ISOLATED_EVIDENCE_INVALID',
        summary: 'Finalization failed at post_worker_collection; code=DUAL_ISOLATED_EVIDENCE_INVALID; recovery=NONE.',
        recovery: 'NONE', settled: true }),
    (error) => error.code === 'DUAL_INTEGRITY_CORRUPT');
});

test('expired finalization records recovery without settlement for pending, running, or unknown child close evidence', (t) => {
    for (const [state, expectedRecovery, exitCode] of [
        ['pending', 'NEEDS_PROCESS_EVIDENCE'],
        ['running', 'NEEDS_PROCESS_TREE_EVIDENCE'],
        ['exited', 'NEEDS_PROCESS_EVIDENCE', null],
    ]) {
        const input = fixture(t);
        const clock = fakeClock();
        const { store } = seedAuthority(input, clock);
        const lease = startTrackedExecution(store, input.task.task_id);
        appendTrackedChild(store, input.task.task_id, lease, state, exitCode);
        clock.advance(31_000);
        const recorded = store.recordFinalizationFailure({ taskId: input.task.task_id, leaseId: lease.lease_id,
            attempt: 1, code: 'DUAL_ISOLATED_EVIDENCE_INVALID', stage: 'post_worker_collection' });
        assert.equal(recorded.settled, false, state);
        assert.equal(recorded.recovery, expectedRecovery, state);
        assert.equal(store.derive().leases[lease.lease_id].status, 'expired', state);
        assert.match(store.derive().tasks[input.task.task_id].lastOutcome.summary, new RegExp(expectedRecovery));
    }
});

test('active failure with a deferred child settles after expiry when its normal close is recorded', (t) => {
    const input = fixture(t);
    const clock = fakeClock();
    const { store } = seedAuthority(input, clock);
    const lease = startTrackedExecution(store, input.task.task_id);
    appendTrackedChild(store, input.task.task_id, lease, 'running');
    recordTaskOutcome({ authorityStore: store, taskId: input.task.task_id, leaseId: lease.lease_id,
        status: 'FAILED', code: 'DUAL_ISOLATED_EVIDENCE_INVALID', summary: 'Validation failed during collection.' });
    assert.equal(releaseSettledTaskLease({ authorityStore: store, taskId: input.task.task_id,
        leaseId: lease.lease_id, reason: 'isolated_failed:DUAL_ISOLATED_EVIDENCE_INVALID' }), false);
    clock.advance(31_000);
    store.append({ schema_version: 2, type: 'task.process.exited', task_id: input.task.task_id,
        lease_id: lease.lease_id, process_id: 'child-1', exit_code: 0 });
    assert.equal(releaseSettledTaskLease({ authorityStore: store, taskId: input.task.task_id,
        leaseId: lease.lease_id, reason: 'isolated_failed:DUAL_ISOLATED_EVIDENCE_INVALID' }), true);
    assert.equal(store.derive().leases[lease.lease_id].status, 'released');
    assert.equal(store.derive().tasks[input.task.task_id].lastOutcome.code, 'DUAL_ISOLATED_EVIDENCE_INVALID');
});

test('delayed normal close upgrades the same unknown-stage finalization failure exactly once', (t) => {
    const input = fixture(t);
    const clock = fakeClock();
    const { store } = seedAuthority(input, clock);
    const lease = startTrackedExecution(store, input.task.task_id);
    appendTrackedChild(store, input.task.task_id, lease, 'running');
    clock.advance(31_000);
    const first = store.recordFinalizationFailure({ taskId: input.task.task_id, leaseId: lease.lease_id,
        attempt: 1, code: 'DUAL_ISOLATED_EVIDENCE_INVALID', stage: 'unknown' });
    assert.equal(first.settled, false);
    assert.equal(first.recovery, 'NEEDS_PROCESS_TREE_EVIDENCE');
    assert.throws(() => store.append({ type: 'task.execution.finalization_failed', task_id: input.task.task_id,
        lease_id: lease.lease_id, attempt: 1, controller_pid: process.pid, status: 'FAILED', stage: 'unknown',
        code: 'DUAL_ISOLATED_EVIDENCE_INVALID',
        summary: 'Finalization failed at unknown; code=DUAL_ISOLATED_EVIDENCE_INVALID; recovery=NEEDS_PROCESS_TREE_EVIDENCE.',
        recovery: 'NEEDS_PROCESS_TREE_EVIDENCE', settled: false }),
    (error) => error.code === 'DUAL_INTEGRITY_CORRUPT');
    assert.equal(releaseSettledTaskLease({ authorityStore: store, taskId: input.task.task_id,
        leaseId: lease.lease_id, reason: 'isolated_failed:DUAL_ISOLATED_EVIDENCE_INVALID' }), false);
    assert.equal(store.derive().tasks[input.task.task_id].executions[lease.lease_id].release_reason,
        'isolated_failed:DUAL_ISOLATED_EVIDENCE_INVALID');
    store.append({ schema_version: 2, type: 'task.process.exited', task_id: input.task.task_id,
        lease_id: lease.lease_id, process_id: 'child-1', exit_code: 0 });
    assert.equal(releaseSettledTaskLease({ authorityStore: store, taskId: input.task.task_id,
        leaseId: lease.lease_id, reason: 'isolated_failed:DUAL_ISOLATED_EVIDENCE_INVALID' }), true);
    assert.equal(store.derive().leases[lease.lease_id].status, 'released');
    const replayed = store.recordFinalizationFailure({ taskId: input.task.task_id, leaseId: lease.lease_id,
        attempt: 1, code: 'DUAL_ISOLATED_EVIDENCE_INVALID', stage: 'unknown' });
    assert.equal(replayed.idempotent, true);
    assert.equal(store.readEvents().filter((event) => event.type === 'task.execution.finalization_failed').length, 2);
});

test('cleanup failure never replaces the original finalization error', async (t) => {
    const input = fixture(t);
    const clock = fakeClock();
    const { store } = seedAuthority(input, clock);
    const originalRecord = store.recordFinalizationFailure.bind(store);
    let calls = 0;
    store.recordFinalizationFailure = (...args) => {
        const result = originalRecord(...args);
        calls += 1;
        if (calls === 1) {
            const cleanup = new Error('private cleanup detail must not replace original');
            cleanup.code = 'DUAL_FINALIZATION_CLEANUP_FAILED';
            throw cleanup;
        }
        return result;
    };
    const adapter = createOrchestratorAdapter({ workspaceRoot: input.workspaceRoot, authorityStore: store,
        processRunner: workerThatExpiresBeforeFinalValidation(clock) });
    await assert.rejects(() => adapter.runTask(store.derive()), (error) => {
        assert.equal(error.code, 'DUAL_ISOLATED_UNAUTHORIZED');
        assert.equal(error.finalizationCleanupCode, 'DUAL_FINALIZATION_CLEANUP_FAILED');
        assert.equal(error.finalizationDiagnostic.recovery, 'NEEDS_PROCESS_EVIDENCE');
        return true;
    });
    assert.equal(store.derive().tasks[input.task.task_id].lastOutcome.status, 'FAILED');
});

test('finalization rejects stale attempts, foreign controller ownership, and conflicting duplicates', (t) => {
    const input = fixture(t);
    const clock = fakeClock();
    const { store } = seedAuthority(input, clock);
    const lease = startTrackedExecution(store, input.task.task_id);
    appendTrackedChild(store, input.task.task_id, lease);
    clock.advance(31_000);
    assert.throws(() => store.recordFinalizationFailure({ taskId: input.task.task_id, leaseId: lease.lease_id,
        attempt: 2, code: 'DUAL_ISOLATED_EVIDENCE_INVALID' }),
    (error) => error.code === 'DUAL_FINALIZATION_UNSAFE');
    assert.throws(() => store.append({ type: 'task.execution.finalization_failed', task_id: input.task.task_id,
        lease_id: lease.lease_id, attempt: 1, controller_pid: process.pid + 1, status: 'FAILED',
        stage: 'post_worker_collection', code: 'DUAL_ISOLATED_EVIDENCE_INVALID',
        summary: 'Finalization failed at post_worker_collection; code=DUAL_ISOLATED_EVIDENCE_INVALID; recovery=NONE.',
        recovery: 'NONE', settled: true }),
    (error) => error.code === 'DUAL_INTEGRITY_CORRUPT');
    const first = store.recordFinalizationFailure({ taskId: input.task.task_id, leaseId: lease.lease_id,
        attempt: 1, code: 'DUAL_ISOLATED_EVIDENCE_INVALID' });
    assert.equal(first.settled, true);
    assert.throws(() => store.recordFinalizationFailure({ taskId: input.task.task_id, leaseId: lease.lease_id,
        attempt: 1, code: 'DUAL_OTHER_FINALIZATION_ERROR' }),
    (error) => error.code === 'DUAL_FINALIZATION_CONFLICT');
});

test('finalization rejects an expired AGY execution after the task is rerouted to Codex in both helper and replay', (t) => {
    const input = fixture(t);
    const clock = fakeClock();
    const { store } = seedAuthority(input, clock);
    const lease = startTrackedExecution(store, input.task.task_id);
    appendTrackedChild(store, input.task.task_id, lease);
    clock.advance(31_000);
    store.append({ type: 'task.routed', task_id: input.task.task_id, owner: 'codex', authority_state: 'ROUTED',
        allowed_files: input.task.allowed_files, reason: 'controller reclaimed the task' });

    assert.throws(() => store.recordFinalizationFailure({ taskId: input.task.task_id, leaseId: lease.lease_id,
        attempt: 1, code: 'DUAL_ISOLATED_EVIDENCE_INVALID', stage: 'post_worker_collection' }),
    (error) => error.code === 'DUAL_FINALIZATION_UNSAFE');
    assert.equal(store.readEvents().filter((event) => event.type === 'task.execution.finalization_failed').length, 0);

    assert.throws(() => store.append({ type: 'task.execution.finalization_failed', task_id: input.task.task_id,
        lease_id: lease.lease_id, attempt: 1, controller_pid: process.pid, status: 'FAILED',
        stage: 'post_worker_collection', code: 'DUAL_ISOLATED_EVIDENCE_INVALID',
        summary: 'Finalization failed at post_worker_collection; code=DUAL_ISOLATED_EVIDENCE_INVALID; recovery=NONE.',
        recovery: 'NONE', settled: true }),
    (error) => error.code === 'DUAL_INTEGRITY_CORRUPT');
    const derived = store.derive();
    assert.equal(derived.leases[lease.lease_id].status, 'expired');
    assert.equal(derived.tasks[input.task.task_id].lastOutcome, undefined);
});

test('finalization rejects a revision-1 execution after a revision-2 reroute', (t) => {
    const input = fixture(t);
    const clock = fakeClock();
    const { store } = seedAuthority(input, clock);
    const lease = startTrackedExecution(store, input.task.task_id);
    appendTrackedChild(store, input.task.task_id, lease);
    clock.advance(31_000);
    store.append({ plan_revision: 2, type: 'task.routed', task_id: input.task.task_id, owner: 'agy', authority_state: 'ROUTED',
        allowed_files: input.task.allowed_files, reason: 'rerouted under revised plan' });

    assert.throws(() => store.recordFinalizationFailure({ taskId: input.task.task_id, leaseId: lease.lease_id,
        attempt: 1, code: 'DUAL_ISOLATED_EVIDENCE_INVALID', stage: 'post_worker_collection' }),
    (error) => error.code === 'DUAL_FINALIZATION_UNSAFE');
    assert.equal(store.readEvents().filter((event) => event.type === 'task.execution.finalization_failed').length, 0);
    assert.equal(store.derive().tasks[input.task.task_id].lastOutcome, undefined);
});

test('finalization rejects an old expired execution when a newer AGY lease is active', (t) => {
    const input = fixture(t);
    const clock = fakeClock();
    const { store } = seedAuthority(input, clock);
    const oldLease = startTrackedExecution(store, input.task.task_id);
    appendTrackedChild(store, input.task.task_id, oldLease);
    clock.advance(31_000);
    const newLease = startTrackedExecution(store, input.task.task_id);

    assert.throws(() => store.recordFinalizationFailure({ taskId: input.task.task_id, leaseId: oldLease.lease_id,
        attempt: 1, code: 'DUAL_ISOLATED_EVIDENCE_INVALID', stage: 'post_worker_collection' }),
    (error) => error.code === 'DUAL_FINALIZATION_UNSAFE');
    const derived = store.derive();
    assert.equal(derived.leases[oldLease.lease_id].status, 'expired');
    assert.equal(derived.leases[newLease.lease_id].status, 'active');
    assert.equal(derived.tasks[input.task.task_id].lastOutcome, undefined);
});

test('latest correction attempt can finalize after an earlier execution was released', (t) => {
    const input = fixture(t);
    const clock = fakeClock();
    const { store } = seedAuthority(input, clock);
    const firstLease = startTrackedExecution(store, input.task.task_id);
    appendTrackedChild(store, input.task.task_id, firstLease);
    recordTaskOutcome({ authorityStore: store, taskId: input.task.task_id, leaseId: firstLease.lease_id,
        status: 'FAILED', code: 'DUAL_ISOLATED_EVIDENCE_INVALID', summary: 'First attempt failed.' });
    assert.equal(releaseSettledTaskLease({ authorityStore: store, taskId: input.task.task_id,
        leaseId: firstLease.lease_id, reason: 'isolated_failed:DUAL_ISOLATED_EVIDENCE_INVALID' }), true);
    store.append({ type: 'task.correction.requested', task_id: input.task.task_id, request_id: 'FIX-1',
        previous_attempt: 1, attempt: 2, previous_binding_sha256: null, reason: 'Retry the bounded worker attempt.' });
    const latestLease = startTrackedExecution(store, input.task.task_id);
    appendTrackedChild(store, input.task.task_id, latestLease);
    clock.advance(31_000);

    const finalization = store.recordFinalizationFailure({ taskId: input.task.task_id, leaseId: latestLease.lease_id,
        attempt: 2, code: 'DUAL_ISOLATED_EVIDENCE_INVALID', stage: 'post_worker_collection' });
    assert.equal(finalization.settled, true);
    assert.equal(store.derive().tasks[input.task.task_id].lastOutcome.attempt, 2);
    assert.equal(store.derive().leases[latestLease.lease_id].status, 'released');
});

test('old finalization remains rejected after a newer AGY execution acquired and released its lease', (t) => {
    const input = fixture(t);
    const clock = fakeClock();
    const { store } = seedAuthority(input, clock);
    const oldLease = startTrackedExecution(store, input.task.task_id);
    appendTrackedChild(store, input.task.task_id, oldLease);
    clock.advance(31_000);
    const newerLease = startTrackedExecution(store, input.task.task_id);
    appendTrackedChild(store, input.task.task_id, newerLease);
    assert.equal(releaseSettledTaskLease({ authorityStore: store, taskId: input.task.task_id,
        leaseId: newerLease.lease_id, reason: 'newer_execution_finished' }), true);

    assert.throws(() => store.recordFinalizationFailure({ taskId: input.task.task_id, leaseId: oldLease.lease_id,
        attempt: 1, code: 'DUAL_ISOLATED_EVIDENCE_INVALID', stage: 'post_worker_collection' }),
    (error) => error.code === 'DUAL_FINALIZATION_UNSAFE');
    assert.equal(store.derive().tasks[input.task.task_id].lastOutcome, undefined);
});

test('old finalization remains rejected after a newer AGY lease was acquired and released without execution', (t) => {
    const input = fixture(t);
    const clock = fakeClock();
    const { store } = seedAuthority(input, clock);
    const oldLease = startTrackedExecution(store, input.task.task_id);
    appendTrackedChild(store, input.task.task_id, oldLease);
    clock.advance(31_000);
    const newerLease = store.acquireLease(input.task.task_id, 'agy');
    store.releaseLease(newerLease.lease_id, 'newer_route_selected');

    assert.throws(() => store.recordFinalizationFailure({ taskId: input.task.task_id, leaseId: oldLease.lease_id,
        attempt: 1, code: 'DUAL_ISOLATED_EVIDENCE_INVALID', stage: 'post_worker_collection' }),
    (error) => error.code === 'DUAL_FINALIZATION_UNSAFE');
    assert.equal(store.derive().tasks[input.task.task_id].lastOutcome, undefined);
});

test('same-attempt context resume can finalize after the previous execution was released', (t) => {
    const input = fixture(t);
    const clock = fakeClock();
    const { store } = seedAuthority(input, clock);
    const previousLease = startTrackedExecution(store, input.task.task_id);
    appendTrackedChild(store, input.task.task_id, previousLease);
    store.append({ type: 'task.questions', task_id: input.task.task_id, lease_id: previousLease.lease_id,
        questions: [{ message_id: 'QUESTION-1', body: 'Please clarify the expected output.' }] });
    assert.equal(releaseSettledTaskLease({ authorityStore: store, taskId: input.task.task_id,
        leaseId: previousLease.lease_id, reason: 'isolated_awaiting_context' }), true);
    const resumedLease = startTrackedExecution(store, input.task.task_id);
    appendTrackedChild(store, input.task.task_id, resumedLease);
    clock.advance(31_000);

    const finalization = store.recordFinalizationFailure({ taskId: input.task.task_id, leaseId: resumedLease.lease_id,
        attempt: 1, code: 'DUAL_ISOLATED_EVIDENCE_INVALID', stage: 'unknown' });
    assert.equal(finalization.settled, true);
    assert.equal(store.derive().tasks[input.task.task_id].lastOutcome.attempt, 1);
});

test('active pre-worker failure keeps unknown finalization stage after delayed child close', (t) => {
    const input = fixture(t);
    const clock = fakeClock();
    const { store } = seedAuthority(input, clock);
    const lease = startTrackedExecution(store, input.task.task_id);
    appendTrackedChild(store, input.task.task_id, lease, 'running');
    recordTaskOutcome({ authorityStore: store, taskId: input.task.task_id, leaseId: lease.lease_id,
        status: 'FAILED', code: 'DUAL_ISOLATED_EVIDENCE_INVALID', summary: 'Preparation failed before worker collection.' });
    assert.equal(releaseSettledTaskLease({ authorityStore: store, taskId: input.task.task_id,
        leaseId: lease.lease_id, reason: 'isolated_failed:DUAL_ISOLATED_EVIDENCE_INVALID' }), false);
    clock.advance(31_000);
    store.append({ type: 'task.process.exited', task_id: input.task.task_id, lease_id: lease.lease_id,
        process_id: 'child-1', exit_code: 0 });
    assert.equal(releaseSettledTaskLease({ authorityStore: store, taskId: input.task.task_id,
        leaseId: lease.lease_id, reason: 'isolated_failed:DUAL_ISOLATED_EVIDENCE_INVALID' }), true);
    assert.equal(store.derive().tasks[input.task.task_id].finalization.stage, 'unknown');
});
