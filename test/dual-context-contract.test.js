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
