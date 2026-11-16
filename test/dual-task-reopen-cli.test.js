'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runDualTaskReopen } = require('../lib/commands/dual');

function fakeClient(task = { last_outcome: { attempt: 3, status: 'NEEDS_FIX', code: 'DUAL_CONTROLLER_REVIEW_REJECTED' } }) {
    const calls = [];
    return { calls, client: {
        async status() { return { plan_revision: 1, tasks: { 'LANDING-3': task } }; },
        async reopenTask(sessionId, reopen) { calls.push({ sessionId, reopen }); return { acknowledged: true, reused: false }; },
    } };
}
const quiet = () => {};

test('reopen needs a terminal: an agent or pipe cannot reopen a task (O8)', async () => {
    const { client, calls } = fakeClient();
    await assert.rejects(runDualTaskReopen({ taskId: 'LANDING-3', reason: 'r', isTTY: false, ask: async () => 'LANDING-3',
        client, sessionId: 's', log: quiet }), { code: 'DUAL_REOPEN_TTY_REQUIRED' });
    assert.equal(calls.length, 0);
});

test('reopen needs the task id typed back and a reason (O8)', async () => {
    const { client, calls } = fakeClient();
    await assert.rejects(runDualTaskReopen({ taskId: 'LANDING-3', reason: ' ', isTTY: true, ask: async () => 'LANDING-3',
        client, sessionId: 's', log: quiet }), { code: 'DUAL_REOPEN_REASON_REQUIRED' });
    await assert.rejects(runDualTaskReopen({ taskId: 'LANDING-3', reason: 'r', isTTY: true, ask: async () => 'y',
        client, sessionId: 's', log: quiet }), { code: 'DUAL_REOPEN_NOT_CONFIRMED' });
    assert.equal(calls.length, 0);
});

test('a confirmed reopen names the current failed attempt (O8)', async () => {
    const { client, calls } = fakeClient();
    await runDualTaskReopen({ taskId: 'LANDING-3', reason: '  host ran out of battery  ', isTTY: true,
        ask: async () => 'LANDING-3', client, sessionId: 'session-1', log: quiet });
    assert.deepEqual(calls, [{ sessionId: 'session-1', reopen: { task_id: 'LANDING-3', plan_revision: 1, base_attempt: 3,
        reason: 'host ran out of battery' } }]);
});

test('a task without a failed attempt cannot be reopened (O8)', async () => {
    const { client } = fakeClient({});
    await assert.rejects(runDualTaskReopen({ taskId: 'LANDING-3', reason: 'r', isTTY: true, ask: async () => 'LANDING-3',
        client, sessionId: 's', log: quiet }), { code: 'DUAL_REOPEN_NOT_FAILED' });
});
