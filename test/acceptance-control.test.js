'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const api = () => { assert.ok(fs.existsSync(path.join(__dirname, 'helpers/acceptance-control.js'))); return require('./helpers/acceptance-control'); };
function scenario(ids = ['T01', 'T02']) {
    const trace = [], events = [], source = new Map(); let clock = 0;
    const state = { sessionId: 's', sessionState: 'EXECUTING', planRevision: 1, tasks: {}, leases: {}, approvals: {}, lastSequence: 0 };
    for (const id of ids) state.tasks[id] = { task_id: id, state: 'ROUTED', allowed_files: ['lib/shared.js'], context_files: [],
        isolatedWorkspace: { attempt: 1 }, ...(id === ids[0] ? { isolatedHandoff: { attempt: 1, result_sha256: id } } : {}) };
    const event = (e) => { events.push({ sequence: events.length + 1, ...e }); state.lastSequence = events.length; };
    const client = {
        resumeSession: async () => { trace.push('resume'); for (let i = 1; i < ids.length; i++) if (state.tasks[ids[i-1]].state === 'TASK_VERIFIED') state.tasks[ids[i]].isolatedHandoff = { attempt: 1, result_sha256: ids[i] }; },
        completeIsolatedTask: async (_s, id) => {
            trace.push('qc:' + id);
            const gateId = 'integrate-' + id;
            if (state.approvals[gateId]?.status !== 'approved') {
                state.approvals[gateId] = { gate_id: gateId, task_id: id, phase: 'integrate', digest: id, status: 'pending' };
                return { status: 'AWAITING_HUMAN_APPROVAL' };
            }
            source.set('lib/shared.js', id);
            event({ type: 'gate.result', task_id: id, status: 'PASSED', details: { integration_receipt: id + '.json', result_sha256: id } });
            event({ type: 'task.completed', task_id: id, diff_fingerprint: id });
            state.tasks[id].state = 'TASK_VERIFIED';
            return { status: 'TASK_VERIFIED' };
        },
    };
    const options = { authority: { derive: () => structuredClone(state), readEvents: () => structuredClone(events) }, client,
        sessionId: 's', taskIds: ids, deadline: 10_000, now: () => clock,
        pauseImpl: async (ms) => { clock += ms; }, pollIntervalMs: 500,
        serviceContext: async () => {},
        waitForGates: async ({ gateIds }) => { trace.push('human:' + gateIds.join(',')); for (const gateId of gateIds) state.approvals[gateId].status = 'approved'; },
        captureSource: async () => new Map(source),
        collectIntegration: async ({ before, after, ...record }) => ({ ...record, changed_files: [...after.keys()].filter(k => before.get(k) !== after.get(k)) }),
        onIntegration: () => {},
    };
    return { state, events, trace, source, client, options, event };
}

test('ready-frontier integration releases a scope-blocked successor without an all-task deadlock', async () => {
    const { driveAcceptance } = api(), s = scenario();
    const result = await driveAcceptance(s.options);
    assert.equal(result.complete, true);
    assert.deepEqual(result.integrations.map(r => [r.task_id,r.sequence,r.changed_files]), [['T01',1,['lib/shared.js']],['T02',3,['lib/shared.js']]]);
    assert.ok(s.trace.indexOf('human:integrate-T01') < s.trace.indexOf('qc:T02'));
    assert.deepEqual(s.trace.filter(x => x.startsWith('human:')), ['human:integrate-T01','human:integrate-T02']);
});

test('frontier resume uses a compact ACK when accumulated task history exceeds the client cap', async () => {
    const { driveAcceptance } = api(), s = scenario();
    const resume = s.client.resumeSession;
    let calls = 0;
    s.client.resumeSession = async (params, options) => {
        calls++;
        if (params.projection !== 'ack') throw Object.assign(new Error('large task history'), { code: 'DUAL_CLIENT_RESPONSE_TOO_LARGE' });
        assert.equal(params.session_id, 's');
        return resume(params, options);
    };
    assert.equal((await driveAcceptance(s.options)).complete, true);
    assert.ok(calls > 0);
});

test('a lost resume response is propagated without replaying a possibly dispatched operation', async () => {
    const { driveAcceptance } = api(), s = scenario();
    let calls = 0;
    s.client.resumeSession = async () => { calls++; throw Object.assign(new Error('lost response'), { code: 'DUAL_CLIENT_RESPONSE_TOO_LARGE' }); };
    await assert.rejects(driveAcceptance(s.options), { code: 'DUAL_CLIENT_RESPONSE_TOO_LARGE' });
    assert.equal(calls, 1);
    assert.equal(s.state.tasks.T01.state, 'TASK_VERIFIED');
});

test('driver services NEEDS_CONTEXT and waits for released leases before QC', async () => {
    const { driveAcceptance } = api(), s = scenario(['T08']);
    s.state.tasks.T08.waitingContext = { question_ids: ['q1'] };
    s.state.leases.l = { task_id: 'T08', status: 'active' };
    let answered = false;
    s.options.serviceContext = async ({ taskId }) => { assert.equal(taskId,'T08'); answered = true; delete s.state.tasks.T08.waitingContext; s.state.leases.l.status = 'released'; s.state.leases.l.released_at = 'now'; };
    await driveAcceptance(s.options);
    assert.equal(answered, true);
});

test('digest changes after a human batch require another human wait', async () => {
    const { driveAcceptance } = api(), s = scenario(['T01']);
    const qc = s.client.completeIsolatedTask; let changed = false, approvals = 0;
    s.options.waitForGates = async ({ gateIds }) => { approvals++; s.state.approvals[gateIds[0]].status = 'approved'; };
    s.client.completeIsolatedTask = async (...args) => {
        if (!changed && s.state.approvals['integrate-T01']?.status === 'approved') {
            changed = true; s.state.approvals['integrate-T01'] = { gate_id: 'integrate-T01',task_id:'T01',phase:'integrate',digest:'new',status:'pending' };
            return { status: 'AWAITING_HUMAN_APPROVAL' };
        }
        return qc(...args);
    };
    await driveAcceptance(s.options);
    assert.equal(approvals, 2);
});

test('an integration receipt is captured even when QC throws after writing source', async () => {
    const { driveAcceptance } = api(), s = scenario(['T01']); let captured;
    s.state.approvals['integrate-T01'] = { status: 'approved' };
    s.options.onIntegration = r => { captured = r; };
    const qc = s.client.completeIsolatedTask;
    s.client.completeIsolatedTask = async (...args) => { await qc(...args); throw Object.assign(new Error('late failure'),{code:'LATE'}); };
    await assert.rejects(driveAcceptance(s.options), { code: 'LATE' });
    assert.deepEqual(captured.changed_files, ['lib/shared.js']);
    assert.equal(captured.sequence, 1);
});

test('unanchored source changes are never accepted as a successful capture', async () => {
    const { driveAcceptance } = api(), s = scenario(['T01']);
    s.client.completeIsolatedTask = async () => { s.source.set('escape.txt','bad'); return {status:'TASK_VERIFIED'}; };
    await assert.rejects(driveAcceptance(s.options), { code: 'ACCEPTANCE_UNANCHORED_INTEGRATION' });
});

test('settled matching-attempt failure is terminal, NEEDS_FIX and pending integrate are not', async () => {
    const { taskProjection, driveAcceptance } = api(), s = scenario(['T01']);
    s.state.tasks.T01.lastOutcome = { attempt: 1, status: 'FAILED' };
    assert.equal(taskProjection(s.state,'T01').terminal,true);
    s.state.tasks.T01.lastOutcome.status = 'NEEDS_FIX';
    assert.equal(taskProjection(s.state,'T01').terminal,false);
    s.state.tasks.T01.lastOutcome.status = 'FAILED';
    s.state.approvals['integrate-T01'] = {status:'pending'};
    assert.equal(taskProjection(s.state,'T01').terminal,false);
    delete s.state.approvals['integrate-T01'];
    assert.equal((await driveAcceptance(s.options)).complete,true);
    assert.deepEqual(s.trace,[]);
});

test('waiting is bounded and a foreign authority snapshot aborts without QC', async () => {
    const { driveAcceptance } = api(), s = scenario(['T01']);
    delete s.state.tasks.T01.isolatedHandoff;
    s.options.deadline = 1000;
    await assert.rejects(driveAcceptance(s.options), { code: 'ACCEPTANCE_INCOMPLETE' });
    s.state.sessionId = 'foreign';
    await assert.rejects(driveAcceptance({...s.options,deadline:2000}), {code:'ACCEPTANCE_AUTHORITY_CHANGED'});
    assert.deepEqual(s.trace,[]);
});

test('a claimed context dispatch or unsettled finalization prevents terminal projection', () => {
    const { taskProjection } = api(), s = scenario(['T01']);
    s.state.tasks.T01.state = 'TASK_VERIFIED';
    s.state.tasks.T01.contextDispatch = {status:'claimed'};
    assert.equal(taskProjection(s.state,'T01').terminal,false);
    delete s.state.tasks.T01.contextDispatch;
    s.state.tasks.T01.finalization = {settled:false};
    assert.equal(taskProjection(s.state,'T01').terminal,false);
});

test('a settled context continuation reaches QC with the audit waitingContext retained', async () => {
    const { driveAcceptance } = api(), s = scenario(['T01']);
    const park = { task_id: 'T01', attempt: 1, plan_revision: 1, question_ids: ['q1'], reason: 'NEEDS_CONTEXT' };
    s.state.sessionState = 'EXECUTING';
    s.state.tasks.T01.waitingContext = structuredClone(park);
    s.state.tasks.T01.messages = [{ kind: 'question', message_id: 'q1' }, { kind: 'reply', message_id: 'r1', reply_to: 'q1' }];
    s.state.tasks.T01.contextDispatch = { attempt: 1, status: 'completed', reply_ids: ['r1'] };
    s.state.leases.first = { task_id: 'T01', status: 'released', released_at: 'settled' };
    s.state.leases.continued = { task_id: 'T01', status: 'released', released_at: 'settled' };
    const result = await driveAcceptance(s.options);
    assert.equal(result.complete, true);
    assert.ok(s.trace.includes('qc:T01'));
    assert.deepEqual(s.state.tasks.T01.waitingContext, park, 'controller must preserve the authority audit record');
    assert.equal(s.trace.filter(item => item.startsWith('human:')).length, 1);
});

test('a handoff does not enter QC until its context dispatch claim settles', async () => {
    const { driveAcceptance } = api(), s = scenario(['T01']);
    s.state.tasks.T01.contextDispatch = { status: 'claimed', attempt: 1 };
    const qc = s.client.completeIsolatedTask;
    s.client.completeIsolatedTask = async (...args) => {
        assert.equal(s.state.tasks.T01.contextDispatch.status, 'completed');
        return qc(...args);
    };
    const pause = s.options.pauseImpl;
    s.options.pauseImpl = async ms => { await pause(ms); s.state.tasks.T01.contextDispatch.status = 'completed'; };
    await driveAcceptance(s.options);
});
