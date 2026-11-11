'use strict';

// O2 (docs/SQUAD-ORCA-ADOPTION.md): one typed next step from authority state.
const test = require('node:test');
const assert = require('node:assert/strict');
const { NEXT_ACTIONS, ISOLATED_QC_ACTIONS, deriveAuthorityTaskState, authorityNextAction,
    sessionNextAction, completionNextAction } = require('../lib/dual/next-action');

const lease = (extra) => ({ lease_id: 'L1', task_id: 'T1', owner: 'agy', status: 'active', ...extra });

test('task state: live lease, usage-limit wait, outcome, handoff, question, expired lease', () => {
    assert.equal(deriveAuthorityTaskState({ task_id: 'T1', state: 'ROUTED' }, { L1: lease() }), 'AGY_IN_PROGRESS');
    assert.equal(deriveAuthorityTaskState({ task_id: 'T1', state: 'ROUTED', runtimeWait: { lease_id: 'L1' } }, { L1: lease() }), 'WAITING_RUNTIME');
    assert.equal(deriveAuthorityTaskState({ task_id: 'T1', lastOutcome: { status: 'NEEDS_FIX' } }, {}), 'NEEDS_FIX');
    assert.equal(deriveAuthorityTaskState({ task_id: 'T1', isolatedHandoff: {} }, {}), 'AWAITING_CODEX_QC');
    assert.equal(deriveAuthorityTaskState({ task_id: 'T1', messages: [{ kind: 'question', message_id: 'q' }] }, {}), 'NEEDS_CONTEXT');
    assert.equal(deriveAuthorityTaskState({ task_id: 'T1', state: 'ROUTED' }, { L1: lease({ status: 'expired' }) }), 'AGY_LEASE_EXPIRED');
    assert.equal(deriveAuthorityTaskState({ task_id: 'T1', state: 'TASK_VERIFIED' }, { L1: lease() }), 'TASK_VERIFIED');
});

test('task action: exhausted attempts beat a correction; every result is in the enum', () => {
    assert.equal(authorityNextAction({ handoffRejection: { attempt: 3 } }, 'EXECUTING', 'NEEDS_FIX'), 'block_exhausted_attempts');
    const cases = [['NEEDS_FIX', 'request_correction'], ['NEEDS_CONTEXT', 'answer_worker_question'],
        ['WAITING_FOR_SCOPE', 'wait_for_dependency'], ['TASK_VERIFIED', 'done'], ['AWAITING_CODEX_QC', 'codex_qc'],
        ['AGY_IN_PROGRESS', 'wait_for_agy'], ['WAITING_RUNTIME', 'wait_for_runtime'], ['AGY_LEASE_EXPIRED', 'inspect_blocker']];
    for (const [state, action] of cases) assert.equal(authorityNextAction({}, 'EXECUTING', state), action, state);
    assert.equal(authorityNextAction({ owner: 'codex' }, 'EXECUTING', 'ROUTED'), 'codex_work');
    assert.equal(authorityNextAction({ owner: 'agy' }, 'BLOCKED', 'ROUTED'), 'inspect_blocker');
    for (const action of [...Object.values(ISOLATED_QC_ACTIONS), completionNextAction({ verified: true }),
        completionNextAction({ verified: false, blockers: ['x'] }), completionNextAction({ verified: false })]) {
        assert.ok(NEXT_ACTIONS.includes(action), action);
    }
});

test('session action: a human gate first, then blocker, then the most urgent task', () => {
    assert.deepEqual(sessionNextAction({ state: 'EXECUTING', awaitingGate: { gate_id: 'g' },
        taskActions: { T1: 'request_correction' } }), { action: 'relay_gate_to_human' });
    assert.deepEqual(sessionNextAction({ state: 'BLOCKED', taskActions: {} }), { action: 'inspect_blocker' });
    assert.deepEqual(sessionNextAction({ state: 'EXECUTING', taskActions: { T1: 'wait_for_agy', T2: 'block_exhausted_attempts' } }),
        { action: 'block_exhausted_attempts', task_id: 'T2' });
    assert.deepEqual(sessionNextAction({ state: 'EXECUTING', taskActions: { T1: 'done', T2: 'done' } }), { action: 'evaluate_completion' });
    assert.deepEqual(sessionNextAction({ state: 'PLANNED', taskActions: {} }), { action: 'inspect_status' });
});
