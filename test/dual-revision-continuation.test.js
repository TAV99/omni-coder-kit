'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { continuationCheckpoint } = require('../lib/dual/task-continuation');
const state = (revision = {}) => ({ sessionState: 'ACCEPTANCE', tasks: { t: {
    state: 'TASK_VERIFIED', active_revision: { revision_id: 'r', attempt: 1,
        contract_sha256: 'a'.repeat(64), state: 'EXECUTING', ...revision },
} }, leases: {}, gates: {} });
test('revision checkpoint chooses candidate before verified parent and preserves untargeted behavior', () => {
    assert.equal(continuationCheckpoint(state(), 't', { revision_id: 'r' }).status, 'START');
    assert.equal(continuationCheckpoint(state(), 't').status, 'RECONCILIATION_REQUIRED');
    assert.equal(continuationCheckpoint(state(), 't', { revision_id: 'wrong' }).status, 'RECONCILIATION_REQUIRED');
});
test('revision checkpoint correlates lease, waiting questions and amendment to candidate', () => {
    const current = state({ state: 'WAITING_CONTEXT', waitingContext: { revision_id: 'r', attempt: 1,
        contract_sha256: 'a'.repeat(64), question_ids: ['q'] }, messages: [
        { kind: 'reply', message_id: 'm', reply_to: 'q', revision_id: 'other', attempt: 1 },
    ] });
    assert.equal(continuationCheckpoint(current, 't', { revision_id: 'r' }).status, 'WAITING_CONTEXT');
    current.tasks.t.active_revision.messages.push({ kind: 'reply', message_id: 'ok', reply_to: 'q', revision_id: 'r', attempt: 1 });
    assert.equal(continuationCheckpoint(current, 't', { revision_id: 'r' }).status, 'EVALUATE_CONTEXT');
    current.tasks.t.active_revision.amendment_required = true;
    assert.equal(continuationCheckpoint(current, 't', { revision_id: 'r' }).status, 'AMENDMENT_REQUIRED');
});
test('revision phase prevents execution of ready and promoting candidates', () => {
    for (const phase of ['QC', 'READY', 'PROMOTING', 'FAILED', 'CANCELLED']) {
        assert.notEqual(continuationCheckpoint(state({state: phase}), 't', { revision_id: 'r' }).status, 'START');
    }
});
