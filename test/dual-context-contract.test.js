'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { continuationCheckpoint, dispatchState } = require('../lib/dual/task-continuation');
const state = (task) => ({ sessionState: 'EXECUTING', tasks: { T: task }, leases: {}, gates: {} });
test('dispatch finished distinguishes waiting, failure, and verified authority', () => {
    assert.equal(dispatchState([{ status: 'NEEDS_CONTEXT' }]), 'waiting_context');
    assert.equal(dispatchState([{ status: 'FAILED' }]), 'failed');
    assert.equal(dispatchState(undefined), 'failed');
    assert.equal(dispatchState([]), 'failed');
    assert.equal(dispatchState([{ status: 'TASK_VERIFIED' }]), 'verified');
    assert.equal(dispatchState([{ status: 'AWAITING_CODEX_QC' }]), 'completed');
});
test('continuation only resumes proven checkpoints and never reimplements handoff or verified task', () => {
    assert.equal(continuationCheckpoint(state({ state: 'TASK_VERIFIED' }), 'T').status, 'VERIFIED');
    assert.equal(continuationCheckpoint(state({ isolatedHandoff: {} }), 'T').status, 'QC');
    assert.equal(continuationCheckpoint(state({ lastOutcome: { status: 'FAILED' } }), 'T').status, 'FAILED');
    assert.equal(continuationCheckpoint(state({ isolatedWorkspace: {} }), 'T').status, 'RECONCILIATION_REQUIRED');
    const waiting = { waitingContext: { question_ids: ['q'] }, messages: [{ kind: 'question', message_id: 'q' }] };
    assert.equal(continuationCheckpoint(state(waiting), 'T').status, 'WAITING_CONTEXT');
    waiting.messages.push({ kind: 'reply', message_id: 'r', reply_to: 'q' });
    assert.equal(continuationCheckpoint(state(waiting), 'T').status, 'EVALUATE_CONTEXT');
});
test('message IDs from old attempts cannot be reused to wake the current lineage', () => {
    const { postTaskMessage } = require('../lib/dual/task-messages');
    const authorityStore = { derive: () => ({ sessionId: 'S', planRevision: 1, tasks: { T: {
        task_id: 'T', messages: [], previousAttempts: [{ messages: [
            { message_id: 'old-reply', kind: 'reply', body: '2', reply_to: 'old-q', plan_revision: 1 },
        ] }],
    } } }), append() { assert.fail('stale reply must not be appended'); } };
    assert.throws(() => postTaskMessage({ authorityStore, sessionId: 'S', planRevision: 1, taskId: 'T',
        messageId: 'old-reply', kind: 'reply', body: '2', replyTo: 'old-q' }), { code: 'DUAL_MESSAGE_STALE' });
});

test('contextUndelivered allows a re-claim only with proof that no worker process saw the context', () => {
    const { contextUndelivered } = require('../lib/dual/task-continuation');
    const base = { contextDispatch: { status: 'failed', claimed_sequence: 10, reply_ids: ['r1'] },
        executions: { before: { started_sequence: 5, processes: { a: {} } }, after: { started_sequence: 12, processes: {} } } };
    assert.equal(contextUndelivered(base), true);
    assert.equal(contextUndelivered({ contextDispatch: { status: 'abandoned', reply_ids: [] } }), true);
    for (const status of ['claimed', 'completed', 'waiting_context', 'verified']) {
        assert.equal(contextUndelivered({ ...base, contextDispatch: { ...base.contextDispatch, status } }), false, status);
    }
    assert.equal(contextUndelivered({ ...base, executions: { ...base.executions,
        after: { started_sequence: 12, processes: { p: { state: 'exited' } } } } }), false, 'a process ran after the claim');
    assert.equal(contextUndelivered({ ...base, executions: { x: { processes: {} } } }), false, 'unknown start sequence');
    assert.equal(contextUndelivered({ ...base, lastOutcome: { status: 'FAILED' } }), false);
    assert.equal(contextUndelivered({ ...base, isolatedHandoff: {} }), false);
    assert.equal(contextUndelivered({ ...base, contextDispatch: { status: 'failed', reply_ids: ['r1'] } }), false, 'legacy claim without sequence');
    assert.equal(contextUndelivered({ contextDispatch: base.contextDispatch }), false, 'no execution record');
});
