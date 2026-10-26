'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    classifyFailure, failureEvidence, recoveryUsage, authorizeCorrection, reduceRecoveryEvent,
} = require('../lib/dual/task-correction');

const outcome = (code = 'RESULT_MALFORMED', attempt = 1) => ({ attempt, status: 'FAILED', code, summary: 'Recorded controller failure' });
const task = (code) => ({ task_id: 'T1', state: 'ROUTED', owner: 'agy', execution_mode: 'isolated', lastOutcome: outcome(code) });
const context = { sessionId: 'session-1', planRevision: 1, sessionState: 'EXECUTING', leases: {}, gates: {} };
const event = (type, extra = {}) => ({ type, session_id: context.sessionId, plan_revision: 1, task_id: 'T1', ...extra });
const policy = { policy_version: 1, worker_limit: 2, harness_limit: 1, total_limit: 3 };
function configure(t) { reduceRecoveryEvent(t, event('task.recovery.policy', policy), context); return t; }
function classify(t) {
    const result = classifyFailure(t);
    reduceRecoveryEvent(t, event('task.failure.classified', { attempt: t.lastOutcome.attempt,
        failure_sha256: failureEvidence(t, context), ...result, harness_version: '3.1.2', policy_version: 1 }), context);
    return t;
}
function grant(t, id = 'grant-1') {
    reduceRecoveryEvent(t, event('task.recovery.granted', { grant_id: id, attempt: t.lastOutcome.attempt + 1,
        failure_sha256: failureEvidence(t, context), policy_version: 1 }), context);
    return t;
}

test('malformed worker JSON is worker failure, LIMIT_EXCEEDED alone stays unknown', () => {
    assert.deepEqual(classifyFailure(task()), { category: 'worker', phase: 'worker_result' });
    assert.deepEqual(classifyFailure(task('LIMIT_EXCEEDED')), { category: 'unknown', phase: 'unclassified' });
});

test('harness classification requires persisted settled finalization evidence', () => {
    const t = task('DUAL_LEASE_EXPIRED');
    assert.equal(classifyFailure(t).category, 'unknown');
    t.finalization = { stage: 'outer_handoff', settled: false };
    assert.equal(classifyFailure(t).category, 'unknown');
    t.finalization.settled = true;
    assert.deepEqual(classifyFailure(t), { category: 'harness', phase: 'outer_handoff' });
    t.lastOutcome.code = 'RESULT_MALFORMED';
    assert.equal(classifyFailure(t).category, 'worker');
});

test('classification evidence binds session, revision, task, attempt and failure contents', () => {
    const t = task();
    const digest = failureEvidence(t, context);
    for (const changed of [{ ...context, sessionId: 'other' }, { ...context, planRevision: 2 }])
        assert.notEqual(failureEvidence(t, changed), digest);
    for (const changed of [{ ...t, task_id: 'T2' }, { ...t, lastOutcome: outcome('RESULT_MALFORMED', 2) },
        { ...t, lastOutcome: { ...t.lastOutcome, summary: 'other evidence' } }])
        assert.notEqual(failureEvidence(changed, context), digest);
});

test('caller cannot turn unknown evidence into a harness classification', () => {
    const t = configure(task('LIMIT_EXCEEDED'));
    assert.throws(() => reduceRecoveryEvent(t, event('task.failure.classified', {
        attempt: 1, failure_sha256: failureEvidence(t, context), category: 'harness', phase: 'relay',
        harness_version: '3.1.2', policy_version: 1,
    }), context), { code: 'DUAL_CORRECTION_CLASSIFICATION_REQUIRED' });
});

test('unknown failures park for classification instead of receiving a free recovery', () => {
    const t = classify(configure(task('LIMIT_EXCEEDED')));
    assert.throws(() => authorizeCorrection(t, { expectedAttempt: 1 }), { code: 'DUAL_CORRECTION_CLASSIFICATION_REQUIRED' });
    assert.throws(() => grant(t), { code: 'DUAL_CORRECTION_CLASSIFICATION_REQUIRED' });
});

test('grant is bound to exact failure, next attempt and policy version', () => {
    const t = task('DUAL_LEASE_EXPIRED');
    t.finalization = { stage: 'post_worker_collection', settled: true };
    classify(configure(t));
    for (const override of [{ attempt: 3 }, { failure_sha256: 'f'.repeat(64) }, { policy_version: 2 }]) {
        assert.throws(() => reduceRecoveryEvent(t, event('task.recovery.granted', { grant_id: 'bad', attempt: 2,
            failure_sha256: failureEvidence(t, context), policy_version: 1, ...override }), context));
    }
    grant(t);
    assert.equal(authorizeCorrection(t, { expectedAttempt: 1, grantId: 'grant-1' }).budget_class, 'harness');
    assert.throws(() => authorizeCorrection(t, { expectedAttempt: 2, grantId: 'grant-1' }));
});

test('grant reuse is rejected after the original correction consumes it', () => {
    const t = task('DUAL_LEASE_EXPIRED');
    t.finalization = { stage: 'outer_handoff', settled: true };
    grant(classify(configure(t)));
    t.recoveryGrants[0].consumed = true;
    assert.throws(() => authorizeCorrection(t, { expectedAttempt: 1, grantId: 'grant-1' }), { code: 'DUAL_CORRECTION_GRANT_INVALID' });
});

test('harness recovery preserves both worker correction opportunities and monotonic ordinal', () => {
    const t = classify(configure(task()));
    t.previousAttempts = [{ correction: null }, { correction: { budget_class: 'harness' } }];
    t.correction = { attempt: 3, budget_class: 'worker' };
    t.lastOutcome.attempt = 3;
    classify(t);
    assert.deepEqual(recoveryUsage(t), { worker: 1, harness: 1, total: 2 });
    const authorized = authorizeCorrection(t, { expectedAttempt: 3 });
    assert.equal(authorized.budget_class, 'worker');
    t.previousAttempts.push({ correction: t.correction });
    t.correction = { attempt: 4, budget_class: 'worker' };
    t.lastOutcome.attempt = 4;
    classify(t);
    assert.throws(() => authorizeCorrection(t, { expectedAttempt: 4 }), { code: 'DUAL_CORRECTION_LIMIT' });
});

test('legacy authority counts all historical corrections as worker and never grants free harness recovery', () => {
    const t = task();
    t.correction = { attempt: 3 };
    t.previousAttempts = [{ correction: null }, { correction: { attempt: 2 } }];
    t.lastOutcome.attempt = 3;
    assert.deepEqual(recoveryUsage(t), { worker: 2, harness: 0, total: 2 });
    assert.throws(() => authorizeCorrection(t, { expectedAttempt: 3 }), { code: 'DUAL_CORRECTION_LIMIT' });
    assert.throws(() => grant(t), { code: 'DUAL_CORRECTION_POLICY_REQUIRED' });
});

test('recovery policy requires finite explicit harness and total bounds and worker stays two', () => {
    for (const override of [{ harness_limit: undefined }, { total_limit: undefined }, { harness_limit: Infinity },
        { harness_limit: -1 }, { worker_limit: 3 }, { total_limit: 0 }]) {
        assert.throws(() => reduceRecoveryEvent(task(), event('task.recovery.policy', { ...policy, ...override }), context), { code: 'DUAL_CORRECTION_POLICY_REQUIRED' });
    }
});

test('classification and grant cannot bypass a live lease, integration, stale lineage or verified task', () => {
    for (const changed of [{ ...context, sessionId: 'stale' }, { ...context, planRevision: 2 },
        { ...context, leases: { lease: { task_id: 'T1' } } },
        { ...context, gates: { qc: { task_id: 'T1', details: { integration_receipt: {} } } } }]) {
        assert.throws(() => reduceRecoveryEvent(task(), event('task.recovery.policy', policy), changed), { code: 'DUAL_CORRECTION_STALE' });
    }
    assert.throws(() => reduceRecoveryEvent({ ...task(), state: 'TASK_VERIFIED' }, event('task.recovery.policy', policy), context), { code: 'DUAL_CORRECTION_STALE' });
});

function correctionAuthority(t, clock) {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { createAuthorityStore } = require('../lib/dual/authority-store');
    const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-correction-recovery-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    const dir = path.join(root, '.omni/authority');
    const store = createAuthorityStore(dir, clock ? { clock } : {});
    const baseline = createConfiguredSnapshotBaseline({ root }).baseline.capture().identity;
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'workspace-test', session_id: 'session-1', plan_revision: 1, expected_baseline: baseline, mode: 'auto' });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: { agy_version: '1-test', agy_model: 'gemini-3.8-flash-high' } });
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'spec.md', plan_sha256: 'b'.repeat(64), total_tasks: 1,
        tasks: [{ task_id: 'T1', title: 'Task one', goal: 'Test correction', owner: 'agy', risk: 'low', execution_mode: 'isolated',
            allowed_files: ['index.js'], model: 'gemini-3.8-flash-high', effort: 'high' }] });
    store.append({ schema_version: 2, type: 'task.routed', task_id: 'T1', owner: 'agy', authority_state: 'ROUTED',
        allowed_files: ['index.js'], model: 'gemini-3.8-flash-high', effort: 'high', reason: 'Private task' });
    const args = { workspaceRoot: root, authorityStore: store, sessionId: 'session-1', planRevision: 1, taskId: 'T1' };
    return { args, store, dir };
}

test('journal replay preserves classification, worker charges and append-only previous outcomes', (t) => {
    const { createAuthorityStore } = require('../lib/dual/authority-store');
    const { configureTaskRecovery, classifyTaskFailure, requestTaskCorrection, recordTaskOutcome } = require('../lib/dual/task-correction');
    const { args, store, dir } = correctionAuthority(t);
    for (let attempt = 1; attempt <= 3; attempt++) {
        const lease = store.acquireLease('T1', 'agy');
        recordTaskOutcome({ authorityStore: store, taskId: 'T1', leaseId: lease.lease_id,
            status: 'FAILED', code: 'RESULT_MALFORMED', summary: 'Worker result is malformed JSON' });
        store.releaseLease(lease.lease_id, 'test_failure');
        if (attempt === 1) configureTaskRecovery({ ...args, harnessLimit: 1, totalLimit: 3 });
        classifyTaskFailure(args);
        const correction = { ...args, expectedAttempt: attempt, requestId: `fix-${attempt}`, reason: 'Repair JSON output' };
        if (attempt < 3) assert.equal(requestTaskCorrection(correction).attempt, attempt + 1);
        else assert.throws(() => requestTaskCorrection(correction), { code: 'DUAL_CORRECTION_LIMIT' });
    }
    const reopened = createAuthorityStore(dir).derive().tasks.T1;
    assert.deepEqual(recoveryUsage(reopened), { worker: 2, harness: 0, total: 2 });
    assert.equal(reopened.previousAttempts.length, 2);
    assert.equal(reopened.lastOutcome.attempt, 3);
    assert.equal(store.readEvents().filter((item) => item.type === 'task.failure.classified').length, 3);
    assert.equal(store.readEvents().filter((item) => item.type === 'task.execution.outcome').length, 3);
});

test('durable harness grant consumes once, survives restart and leaves two worker corrections', (t) => {
    const { createAuthorityStore } = require('../lib/dual/authority-store');
    const { configureTaskRecovery, classifyTaskFailure, grantTaskRecovery, requestTaskCorrection, recordTaskOutcome } = require('../lib/dual/task-correction');
    let current = Date.parse('2026-09-08T00:00:00.000Z');
    const clock = () => new Date(current);
    const { args, store, dir } = correctionAuthority(t, clock);
    const lease = store.acquireLease('T1', 'agy');
    store.append({ schema_version: 2, type: 'task.execution.started', task_id: 'T1',
        lease_id: lease.lease_id, controller_pid: process.pid });
    store.append({ schema_version: 2, type: 'task.process.intent', task_id: 'T1', lease_id: lease.lease_id, process_id: 'child-1' });
    store.append({ schema_version: 2, type: 'task.process.started', task_id: 'T1', lease_id: lease.lease_id, process_id: 'child-1', pid: process.pid });
    store.append({ schema_version: 2, type: 'task.process.exited', task_id: 'T1', lease_id: lease.lease_id, process_id: 'child-1', exit_code: 0 });
    current += 31_000;
    store.recordFinalizationFailure({ taskId: 'T1', leaseId: lease.lease_id, attempt: 1,
        code: 'DUAL_ISOLATED_EVIDENCE_INVALID', stage: 'post_worker_collection' });
    configureTaskRecovery({ ...args, harnessLimit: 1, totalLimit: 3 });
    assert.equal(classifyTaskFailure(args).category, 'harness');
    grantTaskRecovery({ ...args, grantId: 'recovery-1', expectedAttempt: 1 });
    assert.throws(() => grantTaskRecovery({ ...args, grantId: 'recovery-1', expectedAttempt: 1 }));
    assert.equal(requestTaskCorrection({ ...args, requestId: 'harness-fix', grantId: 'recovery-1',
        expectedAttempt: 1, reason: 'Recover recorded controller finalization' }).attempt, 2);
    let reopened = createAuthorityStore(dir, { clock }).derive().tasks.T1;
    assert.equal(reopened.recoveryGrants[0].consumed, true);
    assert.deepEqual(recoveryUsage(reopened), { worker: 0, harness: 1, total: 1 });
    for (let attempt = 2; attempt <= 3; attempt++) {
        const nextLease = store.acquireLease('T1', 'agy');
        recordTaskOutcome({ authorityStore: store, taskId: 'T1', leaseId: nextLease.lease_id,
            status: 'FAILED', code: 'RESULT_MALFORMED', summary: 'Malformed worker result' });
        store.releaseLease(nextLease.lease_id, 'failure');
        classifyTaskFailure(args);
        assert.throws(() => requestTaskCorrection({ ...args, requestId: `stale-grant-${attempt}`, expectedAttempt: attempt,
            grantId: 'recovery-1', reason: 'Reuse grant' }), { code: 'DUAL_CORRECTION_GRANT_INVALID' });
        assert.equal(requestTaskCorrection({ ...args, requestId: `worker-fix-${attempt}`, expectedAttempt: attempt,
            reason: 'Repair worker result' }).attempt, attempt + 1);
    }
    reopened = createAuthorityStore(dir, { clock }).derive().tasks.T1;
    assert.equal(reopened.correction.attempt, 4);
    assert.equal(reopened.previousAttempts.length, 3);
    assert.deepEqual(recoveryUsage(reopened), { worker: 2, harness: 1, total: 3 });
    assert.equal(reopened.previousAttempts[0].outcome.attempt, 1);
    assert.equal(reopened.previousAttempts[0].outcome.code, 'DUAL_ISOLATED_EVIDENCE_INVALID');
});

test('legacy unknown history remains readable while new unknown requests fail closed', () => {
    const { applyCorrectionBudget } = require('../lib/dual/task-correction');
    const t = task('DUAL_WORKER_EXECUTION_FAILED');
    assert.deepEqual(applyCorrectionBudget(t, { previous_attempt: 1, attempt: 2 }, context), { budget_class: 'worker' });
    assert.throws(() => authorizeCorrection(t, { expectedAttempt: 1 }), { code: 'DUAL_CORRECTION_CLASSIFICATION_REQUIRED' });
});
