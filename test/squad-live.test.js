'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const live = require('./helpers/squad-live');
const quiet = () => {};

test('acceptance context budget admits six questions in one round, is idempotent, and stops before a fourth round', async () => {
    const answered=new Set(),roundState={count:0,history:[]},replies=[],resumes=[];
    const client={replyToTask:async(_session,p)=>{replies.push(p);return {acknowledged:true};},request:async(...args)=>resumes.push(args)};
    const opts={answered,roundState,maxRounds:3,maxQuestionsPerRound:20,client,sessionId:'s',taskId:'T08',report:{contextReplies:[]},log:quiet,
        body:({questionId})=>`Source: finance contract; Question ID: ${questionId}; Plan revision: 1`};
    const first=Array.from({length:6},(_,i)=>'q'+i);
    await live.answerContext({...opts,waitingQuestionIds:first});
    assert.equal(roundState.count,1);assert.equal(replies.length,6);assert.equal(resumes.length,1);
    assert.deepEqual(replies.map(r=>r.reply_to),first);
    assert.ok(replies.every(r=>r.body.includes(r.reply_to)));
    await live.answerContext({...opts,waitingQuestionIds:first});assert.equal(roundState.count,1);assert.equal(replies.length,6);
    await live.answerContext({...opts,waitingQuestionIds:['q6']});
    await live.answerContext({...opts,waitingQuestionIds:['q7']});
    assert.equal(roundState.count,3);assert.equal(replies.length,8);
    await assert.rejects(live.answerContext({...opts,waitingQuestionIds:['q8']}),{code:'ISOLATED_CONTROLLER_REQUIRED'});
    assert.equal(replies.length,8);assert.equal(roundState.history.length,3);
    assert.ok(roundState.history.every(r=>r.complete));
});

test('acceptance context round admits twenty questions and rejects twenty-one before any reply', async () => {
    const answered=new Set(),accepted={count:0,history:[]};
    await live.answerContext({waitingQuestionIds:Array.from({length:20},(_,i)=>'q'+i),answered,roundState:accepted,
        client:{replyToTask:async()=>({acknowledged:true}),request:async()=>({})},sessionId:'s',taskId:'T08',report:{},body:()=>'',log:quiet});
    assert.equal(answered.size,20);assert.equal(accepted.count,1);
    const state={count:0,history:[]};
    await assert.rejects(live.answerContext({waitingQuestionIds:Array.from({length:21},(_,i)=>'q'+i),answered:new Set(),roundState:state,
        client:{replyToTask:()=>assert.fail('must not write')},sessionId:'s',taskId:'T08',report:{},body:()=>'',log:quiet}),
        {code:'ISOLATED_CONTROLLER_REQUIRED'});
    assert.equal(state.count,0);
});

test('a rejected reply preserves the partial context-round history and never resumes', async () => {
    const answered=new Set(),roundState={count:0,history:[]};let calls=0;
    await assert.rejects(live.answerContext({waitingQuestionIds:['q1','q2'],answered,roundState,
        client:{replyToTask:async()=>({acknowledged:++calls===1}),request:()=>assert.fail('must not resume')},
        sessionId:'s',taskId:'T08',report:{},body:({questionId})=>questionId,log:quiet}),{code:'CONTEXT_REPLY_REJECTED'});
    assert.deepEqual([...answered],['q1']);assert.equal(roundState.count,1);
    assert.deepEqual(roundState.history[0].acknowledgedQuestionIds,['q1']);assert.equal(roundState.history[0].complete,false);
});

test('delegated gate waits accept explicit test provenance and never print a terminal command', async () => {
    const digest='a'.repeat(64),now=new Date().toISOString();
    const gate={gate_id:'integrate-T01',task_id:'T01',phase:'integrate',digest,status:'approved',actor:'test',via:'test-harness',decided_at:now};
    const delegation={protocol:'benchmark-delegation-v1',id:'unit',artifactSha256:'b'.repeat(64),taskIds:['T01'],planRevision:1,
        createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
    const opts={authority:{derive:()=>({approvals:{'integrate-T01':gate}})},report:{},save:()=>{},poll:async()=>{},limit:100,
        gateIds:['integrate-T01'],command:'do not print',delegation,log:()=>assert.fail('delegated flow must not ask for a TTY')};
    await live.waitForApproval(opts);
    gate.status='pending';
    await assert.rejects(live.waitForApproval(opts),{code:'ACCEPTANCE_DELEGATED_GATE_PENDING'});
});

function temporary(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-live-unit-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('basic helpers preserve codes and completed NDJSON records', (t) => {
    assert.equal(live.failure('CODE').message, 'CODE');
    assert.throws(() => live.check(false, 'BAD', 'details'), { code: 'BAD', message: 'details' });
    live.check(true, 'BAD');
    const file = path.join(temporary(t), 'events.ndjson');
    assert.deepEqual(live.records(file), []);
    fs.writeFileSync(file, '{"a":1}\n\n{"partial":');
    assert.deepEqual(live.records(file), [{ a: 1 }]);
    live.stopTree(null);
});

test('owned tree cleanup tries the group then its child even when signals fail', (t) => {
    const calls = [];
    t.mock.method(process, 'kill', (pid, signal) => { calls.push([pid, signal]); throw new Error('gone'); });
    live.stopTree({ pid: 123456789 });
    assert.deepEqual(calls, [[-123456789, 'SIGKILL'], [123456789, 'SIGKILL']]);
});

test('pause resolves asynchronously', async () => {
    let resolved = false;
    const pending = live.pause(1).then(() => { resolved = true; });
    assert.equal(resolved, false);
    await pending;
    assert.equal(resolved, true);
});

test('report save atomically replaces content with private permissions', (t) => {
    const root = temporary(t);
    const file = path.join(root, 'report.json');
    fs.writeFileSync(file, 'original', { mode: 0o600 });
    const original = fs.openSync(file, 'r');
    t.after(() => fs.closeSync(original));
    live.saveReport(file, { ok: true });
    assert.equal(fs.readFileSync(original, 'utf8'), 'original');
    assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "ok": true\n}\n');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(root), ['report.json']);
});

test('report save keeps private permissions when reusing an interrupted temporary file', (t) => {
    const file = path.join(temporary(t), 'report.json');
    fs.writeFileSync(`${file}.${process.pid}.tmp`, 'interrupted', { mode: 0o644 });
    live.saveReport(file, { ok: false });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('stage succeeds, clips its deadline and saves', async () => {
    const report = { stages: {} };
    let clock = 100, saves = 0;
    const stage = live.createStageRunner({ report, save: () => saves++, deadline: 120, now: () => clock, log: quiet });
    assert.equal(await stage('one', 1000, async (limit) => { assert.equal(limit, 20); clock += 3; return 42; }), 42);
    assert.deepEqual(report.stages.one, { ok: true, wallMs: 3 });
    assert.equal(saves, 1);
});

test('stage records failures, redacts messages and preserves the first failure', async () => {
    const report = { stages: {} };
    let saves = 0;
    const stage = live.createStageRunner({ report, save: () => saves++, deadline: Date.now() + 1000,
        log: quiet, redact: () => 'redacted' });
    await assert.rejects(stage('first', 100, async () => { throw live.failure('FIRST', 'secret'); }), { code: 'FIRST' });
    await assert.rejects(stage('second', 100, async () => { throw new Error('secret'); }), /secret/);
    assert.equal(report.failedStage, 'first');
    assert.equal(report.errorCode, 'FIRST');
    assert.equal(report.stages.second.errorCode, 'LIVE_ERROR');
    assert.equal(report.stages.first.errorMessage, 'redacted');
    assert.equal(saves, 2);
});

test('stage uses the legacy diagnostic redactor by default', async () => {
    const report = { stages: {} };
    const stage = live.createStageRunner({ report, save: quiet, deadline: Date.now() + 1000, log: quiet });
    await assert.rejects(stage('secret', 100, async () => { throw new Error('Bearer private-token'); }));
    assert.equal(report.stages.secret.errorMessage, 'Bearer [REDACTED]');
});

test('stage times out even when its action never finishes', async () => {
    const report = { stages: {} };
    const stage = live.createStageRunner({ report, save: quiet, deadline: 0, log: quiet });
    await assert.rejects(stage('hung', 100, () => new Promise(() => {})), { code: 'STAGE_TIMEOUT', message: 'hung exceeded 1ms' });
    assert.equal(report.stages.hung.ok, false);
});

test('poll preserves before/predicate/after/pause order and stops early', async () => {
    const calls = [];
    let clock = 0, checks = 0;
    const poll = live.createPoller({ beforeCheck: () => calls.push('before'), afterCheck: () => calls.push('after'),
        now: () => clock, intervalMs: 7, pauseImpl: async (ms) => { calls.push(`pause:${ms}`); clock += ms; } });
    await poll(async () => { calls.push('predicate'); return ++checks === 2; }, 30, 'ready');
    assert.deepEqual(calls, ['before', 'predicate', 'after', 'pause:7', 'before', 'predicate']);
});

test('poll propagates child and task failures before sleeping', async () => {
    for (const hook of ['beforeCheck', 'afterCheck']) {
        let checked = false;
        const poll = live.createPoller({ [hook]: () => { throw live.failure('FAILED'); }, pauseImpl: () => assert.fail('must not sleep') });
        await assert.rejects(poll(() => { checked = true; return false; }, 100, 'ready'), { code: 'FAILED' });
        assert.equal(checked, hook === 'afterCheck');
    }
});

test('poll times out with its label', async () => {
    let clock = 0;
    const poll = live.createPoller({ now: () => clock, pauseImpl: async () => { clock += 10; } });
    await assert.rejects(poll(() => false, 5, 'worker'), { code: 'STAGE_TIMEOUT', message: 'Timed out waiting for worker' });
});

function daemonFixture(t, { graceful = true, health = 'healthy' } = {}) {
    const root = temporary(t), child = new EventEmitter(), calls = [];
    child.pid = 123456789;
    const client = { readDiscovery: () => {}, health: async () => ({ status: health }),
        stop: async (options) => { calls.push(['stop', options]); if (graceful) child.emit('close', 0, null); } };
    const authority = { derive: () => ({}) };
    const handle = live.spawnDaemon({ root, logFile: path.join(root, 'daemon.log'), env: { KEEP: 'yes',
        OMNI_DUAL_WORKER_MODEL: 'bad', OMNI_DUAL_WORKER_EFFORT: 'bad', OMNI_DUAL_WORKER_RUNTIME: 'bad', OMNI_DUAL_DISCUSSION_ENABLED: 'bad' },
    envOverrides: { OMNI_CLAUDE_PATH: '/fake/claude' },
    spawnImpl: (...args) => { calls.push(['spawn', ...args]); return child; },
    createClient: (options) => { calls.push(['client', options]); return client; },
    createAuthority: (directory) => { calls.push(['authority', directory]); return authority; },
    pauseImpl: async (ms) => { calls.push(['pause', ms]); }, stopTreeImpl: (owned) => calls.push(['kill', owned]) });
    return { root, child, calls, client, authority, handle };
}

test('daemon uses the legacy command, clean env and a private closed log descriptor', async (t) => {
    const { root, handle, calls, client, authority } = daemonFixture(t);
    const [, command, args, options] = calls[0];
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [path.resolve(__dirname, '../bin/omni-daemon.js'), '--workspace', root]);
    assert.deepEqual(options.env, { KEEP: 'yes', OMNI_CLAUDE_PATH: '/fake/claude' });
    assert.equal(options.detached, true);
    assert.equal(options.stdio[0], 'ignore');
    assert.equal(options.stdio[1], options.stdio[2]);
    assert.throws(() => fs.fstatSync(options.stdio[1]), { code: 'EBADF' });
    assert.equal(fs.statSync(path.join(root, 'daemon.log')).mode & 0o777, 0o600);
    assert.equal(handle.client, client);
    await handle.waitUntilReady(live.createPoller(), 100);
    assert.equal(handle.authority, authority);
    assert.deepEqual(calls.find(([kind]) => kind === 'authority'), ['authority', path.join(root, '.omni/runs/dual-authority')]);
    await handle.stop();
    assert.deepEqual(await handle.exited, { code: 0, signal: null });
    assert.deepEqual(handle.exitResult, { code: 0, signal: null });
    assert.equal(calls.some(([kind]) => kind === 'kill'), false);
});

test('daemon waits for discovery and refuses unhealthy service', async (t) => {
    const { handle, client } = daemonFixture(t, { health: 'bad' });
    let attempts = 0;
    client.readDiscovery = () => { if (++attempts === 1) throw live.failure('DUAL_DISCOVERY_MISSING'); };
    await assert.rejects(handle.waitUntilReady(live.createPoller({ pauseImpl: async () => {} }), 100), { code: 'DAEMON_UNHEALTHY' });
    assert.equal(attempts, 2);
    await handle.stop();
});

test('daemon records errors and force kills only its own child after graceful timeout', async (t) => {
    const { child, handle, calls } = daemonFixture(t, { graceful: false });
    const error = live.failure('SPAWN_FAILED');
    child.emit('error', error);
    assert.equal(handle.childError, error);
    await handle.stop();
    assert.deepEqual(calls.filter(([kind]) => kind === 'stop' || kind === 'pause' || kind === 'kill'),
        [['stop', { timeoutMs: 5000 }], ['pause', 10000], ['kill', child]]);
});

test('daemon cleanup skips a process that already exited', async (t) => {
    const { child, handle, calls } = daemonFixture(t);
    child.emit('close', 1, 'SIGTERM');
    await handle.stop();
    assert.deepEqual(handle.exitResult, { code: 1, signal: 'SIGTERM' });
    assert.equal(calls.some(([kind]) => kind === 'stop' || kind === 'kill'), false);
});

test('daemon discovery propagates unexpected failures and still cleans up', async (t) => {
    const { handle, client } = daemonFixture(t);
    client.readDiscovery = () => { throw live.failure('CORRUPT_DISCOVERY'); };
    await assert.rejects(handle.waitUntilReady(live.createPoller(), 100), { code: 'CORRUPT_DISCOVERY' });
    await handle.stop();
});

test('daemon hard stops its owned tree if graceful stop fails', async (t) => {
    const { handle, client, calls, child } = daemonFixture(t);
    client.stop = async () => { throw live.failure('RPC_FAILED'); };
    await handle.stop();
    assert.deepEqual(calls.filter(([kind]) => kind === 'pause' || kind === 'kill'), [['kill', child]]);
});

function approvalOptions(gates, extra = {}) {
    let writes = 0;
    const report = {};
    return { authority: { derive: () => ({ approvals: gates }), append: () => writes++ }, report, save: quiet,
        poll: live.createPoller({ pauseImpl: async () => {} }), limit: 100, command: 'explicit approve command',
        gateIds: 'plan-r1', log: quiet, getWrites: () => writes, ...extra };
}

test('approval wait remains read-only and preserves the single-gate awaiting shape', async () => {
    const gates = {};
    const options = approvalOptions(gates);
    let saved = 0;
    options.save = () => { saved++; assert.deepEqual(options.report.awaiting, { gateId: 'plan-r1', command: options.command }); };
    options.poll = async (predicate, limit, label) => {
        assert.equal(limit, 100);
        assert.equal(label, 'approval of plan-r1');
        assert.equal(await predicate(), false, 'a missing gate is not an approval');
        gates['plan-r1'] = { status: 'pending' };
        assert.equal(await predicate(), false);
        gates['plan-r1'] = { status: 'approved', actor: 'human', via: 'cli-tty' };
        assert.equal(await predicate(), true);
    };
    await live.waitForApproval(options);
    assert.equal(saved, 1);
    assert.equal(options.report.awaiting, undefined);
    assert.deepEqual(options.report.decisions, [gates['plan-r1']]);
    assert.equal(options.getWrites(), 0);
});

test('approval supports several gates without deciding them', async () => {
    const approved = { status: 'approved', actor: 'human', via: 'cli-tty' };
    const options = approvalOptions({ a: approved, b: approved }, { gateIds: ['a', 'b'] });
    options.save = () => assert.deepEqual(options.report.awaiting, { gateIds: ['a', 'b'], command: options.command });
    await live.waitForApproval(options);
    assert.equal(options.report.decisions.length, 2);
    assert.equal(options.getWrites(), 0);
});

test('approval rejects rejected gates and approvals from nonhuman sources', async () => {
    for (const [gate, code] of [[{ status: 'rejected', reason: 'no' }, 'GATE_REJECTED'],
        [{ status: 'approved', actor: 'test', via: 'test-harness' }, 'GATE_NOT_HUMAN']]) {
        const options = approvalOptions({ 'plan-r1': gate });
        await assert.rejects(live.waitForApproval(options), { code });
        assert.equal(options.getWrites(), 0);
        assert.ok(options.report.awaiting);
    }
});

test('AUTO plan approval requires explicit opt-in and never permits integrate', async () => {
    for (const [gateId, phase, allowed, accepted] of [['plan-r1', 'plan', false, false], ['plan-r1', 'plan', true, true],
        ['integrate-T01', 'integrate', true, false], ['integrate-T01', 'plan', true, false]]) {
        const options = approvalOptions({ [gateId]: { status: 'approved', actor: 'auto', via: 'pipeline-auto', phase } },
            { gateIds: gateId, allowAutoPlan: allowed });
        if (accepted) await live.waitForApproval(options);
        else await assert.rejects(live.waitForApproval(options), { code: 'GATE_NOT_HUMAN' });
        assert.equal(options.getWrites(), 0);
    }
});

function contextOptions(extra = {}) {
    const calls = [];
    return { waitingQuestionIds: ['q1', 'q2'], answered: new Set(), sessionId: 's', taskId: 'T01', planRevision: 1,
        body: ({ questionId, planRevision }) => `Source: plans/plan.md; ${questionId}; revision ${planRevision}`,
        report: {}, log: quiet, calls,
        client: { replyToTask: async (...args) => { calls.push(['reply', ...args]); return { acknowledged: true }; },
            request: async (...args) => calls.push(['request', ...args]) }, ...extra };
}

test('context replies preserve IDs, body callback, report and task resume semantics', async () => {
    const options = contextOptions();
    await live.answerContext(options);
    assert.deepEqual(options.calls, [
        ['reply', 's', { task_id: 'T01', plan_revision: 1, message_id: 'T01-reply-1', reply_to: 'q1', body: 'Source: plans/plan.md; q1; revision 1' }],
        ['reply', 's', { task_id: 'T01', plan_revision: 1, message_id: 'T01-reply-2', reply_to: 'q2', body: 'Source: plans/plan.md; q2; revision 1' }],
        ['request', 'session.resume', { session_id: 's', task_id: 'T01', plan_revision: 1, projection: 'ack' }],
    ]);
    assert.deepEqual(options.report.contextReplies, [{ questionId: 'q1', messageId: 'reply-1' }, { questionId: 'q2', messageId: 'reply-2' }]);
    await live.answerContext(options);
    assert.equal(options.calls.length, 3);
});

test('context budget is checked before any replies across tasks', async () => {
    const options = contextOptions({ answered: new Set(['prior-1', 'prior-2']) });
    await assert.rejects(live.answerContext(options), { code: 'ISOLATED_CONTROLLER_REQUIRED' });
    assert.deepEqual(options.calls, []);
});

test('context reply budget and plan revision are configurable with IDs shared across tasks', async () => {
    const options = contextOptions({ waitingQuestionIds: ['q3'], answered: new Set(['q1', 'q2']),
        maxReplies: 4, taskId: 'T02', planRevision: 7 });
    await live.answerContext(options);
    assert.deepEqual(options.calls[0], ['reply', 's', { task_id: 'T02', plan_revision: 7,
        message_id: 'T02-reply-3', reply_to: 'q3', body: 'Source: plans/plan.md; q3; revision 7' }]);
    assert.deepEqual(options.calls[1], ['request', 'session.resume', { session_id: 's', task_id: 'T02', plan_revision: 7, projection: 'ack' }]);
});

test('rejected context acknowledgement does not mark answered or resume', async () => {
    const options = contextOptions({ client: { replyToTask: async () => ({ acknowledged: false }),
        request: () => assert.fail('must not resume') } });
    await assert.rejects(live.answerContext(options), { code: 'CONTEXT_REPLY_REJECTED' });
    assert.equal(options.answered.size, 0);
    assert.equal(options.report.contextReplies, undefined);
});
