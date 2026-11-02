'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const telemetry = require('../lib/squad/acceptance-telemetry');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-telemetry-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const env = { OMNI_SQUAD_ACCEPTANCE_EVIDENCE: path.join(root, 'private') };
    const turn = (extra = {}) => telemetry.createTurn({ runtime: 'codex', model: 'model', role: 'worker', kind: 'implement', ...extra }, { env });
    const records = () => fs.readdirSync(path.join(env.OMNI_SQUAD_ACCEPTANCE_EVIDENCE, 'turns')).map(name => JSON.parse(fs.readFileSync(path.join(env.OMNI_SQUAD_ACCEPTANCE_EVIDENCE, 'turns', name))));
    return { root, env, turn, records };
}
function child(pid = 123) { const c = new EventEmitter(); c.pid = pid; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); return c; }
test('acceptance telemetry is an identity no-op without opt-in', () => {
    const env = { PATH: 'unchanged' };
    assert.equal(telemetry.createTurn({ runtime: 'codex' }, { env }), null);
    assert.equal(telemetry.childEnv(env), env);
    const result = { stdout: 'x' };
    assert.equal(telemetry.linkResult(result, null), result);
});
test('acceptance telemetry counts overlapping real runtime processes across roles and retains byte tail', t => {
    const f = fixture(t), first = f.turn(), second = f.turn({ role: 'discussion' });
    const a = child(1), b = child(2); let passed;
    first.wrapSpawn((_cmd, _args, options) => { passed = options.env; return a; })('x', [], { env: { ...f.env, PATH: 'ok' } });
    second.wrapSpawn(() => b)('x', [], {});
    assert.equal(passed.OMNI_SQUAD_ACCEPTANCE_EVIDENCE, undefined);
    a.stderr.emit('data', Buffer.from('start' + 'é'.repeat(2000)));
    a.emit('close', 1);
    first.complete({ exitCode: 1 }); first.contract({ status: 'failed', code: 'EXIT', layer: 'process' }); first.retry({ policy: 'technical', applied: true });
    b.emit('close', 0); second.complete({ exitCode: 0 }); second.contract({ status: 'succeeded', layer: 'contract' });
    const record = f.records().find(r => r.turnId === first.turnId);
    assert.equal(record.sameRuntimeCountAtEnd, 2);
    assert.equal(Buffer.from(record.stderrTailBase64, 'base64').length, 2048);
    assert.equal(record.processStarted, true);
    assert.equal(record.retry.applied, true);
    assert.equal(fs.statSync(f.env.OMNI_SQUAD_ACCEPTANCE_EVIDENCE).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(f.env.OMNI_SQUAD_ACCEPTANCE_EVIDENCE, 'turns', first.turnId + '.json')).mode & 0o777, 0o600);
});
test('acceptance telemetry records no-start spawn errors without counting a process', t => {
    const f = fixture(t), turn = f.turn(); const error = Object.assign(new Error('spawn failed'), { code: 'EAGAIN' });
    assert.throws(() => turn.wrapSpawn(() => { throw error; })('x', [], {}), e => e === error);
    turn.complete(null, error); turn.contract({ status: 'failed', code: 'SPAWN', layer: 'process' });
    const record = f.records()[0];
    assert.equal(record.processStarted, false); assert.equal(record.sameRuntimeCountAtEnd, 0); assert.equal(record.exitCode, null); assert.equal(record.spawnError.code, 'EAGAIN');
});
test('acceptance telemetry links results and preserves exit-zero contract failures, JSON errors and usage', t => {
    const f = fixture(t), turn = f.turn(), c = child(); turn.wrapSpawn(() => c)('x', [], {});
    const stdout = '{"type":"thread.started","thread_id":"owned-session"}\n{"type":"error","error":{"code":"quota","message":"raw private"}}\n{"type":"turn.completed","usage":{"input_tokens":4,"output_tokens":2}}\n';
    c.stdout.emit('data', Buffer.from(stdout)); c.emit('close', 0);
    const result = telemetry.linkResult({ exitCode: 0, stdout }, turn); turn.complete(result);
    assert.equal(telemetry.turnFor({ ...result }), turn);
    turn.contract({ status: 'failed', code: 'CONTRACT', layer: 'contract' });
    const r = f.records()[0]; assert.equal(r.contract.status, 'failed'); assert.equal(r.sessionRef, 'owned-session'); assert.equal(r.usage.inputTokens, 4); assert.equal(r.jsonErrors[0].error.code, 'quota');
});
test('acceptance telemetry tracks an error event with no started child and timeout overflow source tails', t => {
    const f = fixture(t), turn = f.turn(), c = child(undefined); delete c.pid; turn.wrapSpawn(() => c)('x', [], {});
    c.stderr.emit('data', Buffer.from('z'.repeat(3000))); c.emit('error', Object.assign(new Error('failed'), { code: 'ENOENT' }));
    turn.complete({ code: null, stdout: '', stderr: '', timedOut: true, overflow: true }); turn.contract({ status: 'failed', code: 'TIMEOUT', layer: 'process' });
    const r = f.records()[0]; assert.equal(r.processStarted, false); assert.equal(r.timedOut, true); assert.equal(r.overflowed, true); assert.equal(r.stderrTail, 'z'.repeat(2048));
});
test('acceptance telemetry capture failure never changes execution and marks incompleteness', t => {
    const f = fixture(t), turn = f.turn();
    fs.rmSync(path.join(f.env.OMNI_SQUAD_ACCEPTANCE_EVIDENCE, 'turns'), { recursive: true });
    fs.writeFileSync(path.join(f.env.OMNI_SQUAD_ACCEPTANCE_EVIDENCE, 'turns'), 'blocked');
    assert.doesNotThrow(() => turn.complete({ exitCode: 1 }));
    const status = JSON.parse(fs.readFileSync(path.join(f.env.OMNI_SQUAD_ACCEPTANCE_EVIDENCE, 'capture-status.json')));
    assert.equal(status.complete, false); assert.ok(status.errors.length);
});

for (const runtime of ['codex', 'claude', 'agy']) {
    test(`acceptance telemetry observes ${runtime} first invalid turn and successful nudge`, async t => {
        const f = fixture(t); let calls = 0;
        const conversation = 'conv-fixture';
        const binding = { schema_version: 1, provider: runtime === 'codex' ? 'codex' : 'agy', model: runtime === 'agy' ? 'gemini-3.8-flash-high' : 'fixture', effort: 'high',
            conversation_id: conversation, role: runtime === 'codex' ? 'astra' : 'argon', session_id: 'session-fixture',
            task_id: 'task-fixture', plan_revision: 1, snapshot_sha256: require('node:crypto').createHash('sha256').update('source').digest('hex') };
        const response = JSON.stringify({ schema_version: 1, kind: 'reply', body: '{"ok":true}' });
        const spawnImpl = () => {
            const c = child(100 + ++calls), body = calls === 1 ? '' : response;
            const output = runtime === 'codex' ? [
                { type: 'thread.started', thread_id: conversation }, { type: 'item.completed', item: { type: 'agent_message', text: body } }, { type: 'turn.completed' },
            ].map(JSON.stringify).join('\n') : runtime === 'claude'
                ? JSON.stringify({ type: 'result', subtype: 'success', session_id: conversation, result: body })
                : JSON.stringify({ status: 'SUCCESS', conversation_id: conversation, response: body });
            process.nextTick(() => { c.stdout.emit('data', Buffer.from(output)); c.stderr.emit('data', Buffer.from('source tail')); c.emit('close', 0); });
            c.kill = () => {}; return c;
        };
        const mod = require(`../lib/dual/discussion/live-${runtime}-invoke`);
        const create = mod[`create${runtime[0].toUpperCase() + runtime.slice(1)}Adapter`];
        const adapter = create({ cwd: f.root, env: f.env, spawnImpl, agyPath: 'fake', codexPath: 'fake', command: 'fake' });
        const raw = await adapter.invoke({ binding, snapshot: { text: 'source', sha256: binding.snapshot_sha256 }, envelope: { kind: 'question', body: 'read source' }, invocationId: 'inv-test' });
        const classified = adapter.classify(raw, binding, 'inv-test');
        assert.equal(classified.schema, 'valid', JSON.stringify(raw));
        const records = f.records().sort((a, b) => a.kind.localeCompare(b.kind));
        assert.equal(records.length, 2); assert.equal(records[0].runtime, runtime);
        const first = records.find(r => r.kind === 'turn'), nudge = records.find(r => r.kind === 'nudge');
        assert.equal(first.contract.status, 'failed'); assert.equal(first.retry.policy, 'discussion-nudge'); assert.equal(first.retry.applied, true);
        assert.equal(nudge.contract.status, 'succeeded'); assert.equal(nudge.stderrTail, 'source tail'); assert.equal(nudge.taskId, 'task-fixture');
    });
}

for (const scenario of ['failed-retry', 'schema-nudge', 'format-nudge', 'reconciled-retry']) {
    test(`acceptance telemetry links discussion phase ${scenario} to the original physical turn`, async t => {
        const f = fixture(t); let calls = 0;
        const { createCodexAdapter } = require('../lib/dual/discussion/live-codex-invoke');
        const { createDiscussionSession } = require('../lib/dual/discussion/session');
        const { runDiscussionPhase } = require('../lib/dual/discussion/phase-bridge');
        const { createHostPorts } = require('../lib/dual/discussion/host-ports');
        const { bindingRef, sha256Utf8 } = require('../lib/dual/discussion/contracts');
        const snapshot = { text: 'source', sha256: sha256Utf8('source') };
        const spawnImpl = () => {
            const c = child(1000 + ++calls), failed = scenario === 'failed-retry' && calls === 1;
            const body = calls === 1 ? scenario === 'format-nudge' ? 'invalid' : '{"ok":false}' : '{"ok":true}';
            const output = [{ type: 'thread.started', thread_id: 'conv-worker' },
                { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ schema_version: 1, kind: 'reply', body }) } },
                { type: scenario === 'reconciled-retry' && calls === 1 ? 'no-terminal' : failed ? 'turn.failed' : 'turn.completed' }].map(JSON.stringify).join('\n');
            c.kill = () => {};
            process.nextTick(() => { c.stdout.emit('data', Buffer.from(output)); c.emit('close', failed ? 1 : 0); }); return c;
        };
        const adapter = createCodexAdapter({ provider: 'agy', cwd: f.root, env: f.env, spawnImpl, codexPath: 'fake' });
        const session = await createDiscussionSession({ enabled: true, stateDir: path.join(f.root, 'journal'), sessionId: 'session-test', taskId: 'task-test', planRevision: 1,
            snapshot, models: { agy: 'gemini-3.8-flash-high' }, efforts: { agy: 'high' },
            codex: { conversationId: 'conv-host' }, agy: { conversationId: 'conv-worker' }, adapters: { codex: createCodexAdapter(), agy: adapter },
            hostPorts: createHostPorts({ checkAuthority: async () => true,
                verifyCapability: async args => ({ allowed: true, liveProfileVerified: true, evidenceId: 'cap-test', expiresAt: Date.now() + 100000,
                    bindingRef: args.bindingRef, provider: args.provider, adapterId: args.adapterId, adapterVersion: args.adapterVersion,
                    conversationId: args.binding.conversation_id, snapshotSha256: args.snapshotSha256, stage: args.stage }),
                verifyRecoveryEvidence: async args => ({ allowed: scenario === 'reconciled-retry', processQuiescent: true, providerTerminal: true, providerOutcome: 'failed', evidenceId: 'recover-test', bindingRef: args.bindingRef, invocationId: args.invocationId }) }) });
        const outcome = await runDiscussionPhase({ session, phase: 'scout', promptBody: 'return phase',
            senderRef: bindingRef(session.bindings[0]), recipientRef: bindingRef(session.bindings[1]), messageId: 'message-test', now: Date.now(),
            validate: value => ({ ok: value.ok === true, issues: 'ok must be true' }) });
        await session.close();
        assert.equal(outcome.result.ok, true);
        const records = f.records(); assert.equal(records.length, 2);
        const first = records.find(r => r.messageId === 'message-test');
        assert.ok(first); assert.equal(first.phase, 'scout'); assert.equal(first.contract.status, 'failed'); assert.equal(first.retry.applied, true);
        assert.equal(first.retry.policy, `discussion-${scenario}`);
        assert.equal(records.find(r => r.turnId !== first.turnId).contract.status, 'succeeded');
        const status = JSON.parse(fs.readFileSync(path.join(f.env.OMNI_SQUAD_ACCEPTANCE_EVIDENCE, 'capture-status.json')));
        assert.deepEqual(status.pendingTurnIds, []);
    });
}

for (const runtime of ['codex', 'claude', 'agy']) {
    for (const valid of [true, false]) {
        test(`acceptance telemetry records ${runtime} seed ${valid ? 'success' : 'invalid exit-zero output'}`, async t => {
            const f = fixture(t); let childEnv;
            const ready = JSON.stringify({ schema_version: 1, kind: 'reply', body: 'ready' });
            const stdout = !valid ? '{}' : runtime === 'codex'
                ? [{ type: 'thread.started', thread_id: 'seed-session' }, { type: 'item.completed', item: { type: 'agent_message', text: ready } }, { type: 'turn.completed' }].map(JSON.stringify).join('\n')
                : runtime === 'claude' ? JSON.stringify({ type: 'result', subtype: 'success', session_id: 'seed-session', result: ready })
                    : JSON.stringify({ status: 'SUCCESS', conversation_id: 'seed-session', response: ready });
            const spawnImpl = (_command, _args, options) => {
                childEnv = options.env; const c = child(); c.kill = () => {};
                process.nextTick(() => { c.stdout.emit('data', Buffer.from(stdout)); c.stderr.emit('data', Buffer.from('seed stderr')); c.emit('close', 0); }); return c;
            };
            const mod = require(`../lib/dual/discussion/live-${runtime}-invoke`);
            const seed = mod[`seed${runtime[0].toUpperCase() + runtime.slice(1)}Conversation`];
            const invoke = () => seed({ cwd: f.root, env: f.env, model: runtime === 'agy' ? 'gemini-3.8-flash-high' : 'fixture', effort: 'high', spawnImpl, agyPath: 'fake', codexPath: 'fake', command: 'fake' });
            if (valid) assert.equal((await invoke()).conversationId, 'seed-session'); else await assert.rejects(invoke);
            const record = f.records()[0]; assert.equal(record.runtime, runtime); assert.equal(record.kind, 'seed');
            assert.equal(record.contract.status, valid ? 'succeeded' : 'failed'); assert.equal(record.stderrTail, 'seed stderr');
            assert.equal(record.finalized, true); assert.equal(childEnv.OMNI_SQUAD_ACCEPTANCE_EVIDENCE, undefined);
        });
    }
}
for (const failure of ['timeout', 'overflow', 'spawn']) {
    test(`acceptance telemetry preserves raw codex ${failure} evidence without changing returned result`, async t => {
        const f = fixture(t); const { runCodex } = require('../lib/dual/discussion/live-codex-invoke');
        const spawnImpl = () => {
            if (failure === 'spawn') throw Object.assign(new Error('cannot spawn'), { code: 'ENOENT' });
            const c = child(); let closed = false;
            c.kill = () => { if (!closed) { closed = true; process.nextTick(() => c.emit('close', null)); } return true; };
            process.nextTick(() => c.stderr.emit('data', Buffer.from(failure === 'overflow' ? 'x'.repeat(4000) + 'the-source-tail' : 'timeout tail'))); return c;
        };
        const invoke = () => runCodex({ cwd: f.root, model: 'fixture', codexPath: 'fake' }, [], { env: f.env, spawnImpl, timeoutMs: 10, maxOutputBytes: failure === 'overflow' ? 64 : 2048 });
        if (failure === 'spawn') await assert.rejects(invoke, { code: 'ENOENT' });
        else { const raw = await invoke(); assert.equal(raw[failure === 'timeout' ? 'timedOut' : 'overflowed'], true); }
        const record = f.records()[0]; assert.equal(record.contract.status, 'failed'); assert.equal(record.finalized, true);
        if (failure === 'overflow') { assert.ok(record.stderrTail.endsWith('the-source-tail')); assert.equal(Buffer.from(record.stderrTailBase64, 'base64').length, 2048); }
        if (failure === 'spawn') { assert.equal(record.processStarted, false); assert.equal(record.spawnError.code, 'ENOENT'); }
    });
}
test('acceptance telemetry refuses a symlink evidence root without writing through it', t => {
    const f = fixture(t), target = path.join(f.root, 'target'); fs.mkdirSync(target);
    fs.symlinkSync(target, f.env.OMNI_SQUAD_ACCEPTANCE_EVIDENCE);
    const turn = f.turn(); assert.doesNotThrow(() => turn.complete({ exitCode: 1 }));
    assert.deepEqual(fs.readdirSync(target), []);
});

for (const runtime of ['codex', 'claude', 'agy']) {
    test(`acceptance telemetry does not claim ${runtime} nudge applied when its prespawn guard denies it`, async t => {
        const f = fixture(t), guardError = Object.assign(new Error('guard denied'), { code: 'FIXTURE_GUARD' });
        const snapshot = { text: 'source', sha256: require('node:crypto').createHash('sha256').update('source').digest('hex') };
        const binding = { schema_version: 1, provider: runtime === 'codex' ? 'codex' : 'agy', model: runtime === 'agy' ? 'gemini-3.8-flash-high' : 'fixture', effort: 'high',
            conversation_id: 'conv-fixture', role: 'argon', session_id: 'session-fixture', task_id: 'task-fixture', plan_revision: 1, snapshot_sha256: snapshot.sha256 };
        const output = runtime === 'codex' ? [{ type: 'thread.started', thread_id: 'conv-fixture' }, { type: 'item.completed', item: { type: 'agent_message', text: '' } }, { type: 'turn.completed' }].map(JSON.stringify).join('\n')
            : JSON.stringify(runtime === 'claude' ? { type: 'result', subtype: 'success', session_id: 'conv-fixture', result: '' } : { status: 'SUCCESS', conversation_id: 'conv-fixture', response: '' });
        const spawnImpl = () => { const c = child(); c.kill = () => {}; process.nextTick(() => { c.stdout.emit('data', Buffer.from(output)); c.emit('close', 0); }); return c; };
        const mod = require(`../lib/dual/discussion/live-${runtime}-invoke`), create = mod[`create${runtime[0].toUpperCase() + runtime.slice(1)}Adapter`];
        const adapter = create({ cwd: f.root, env: f.env, spawnImpl, agyPath: 'fake', codexPath: 'fake', command: 'fake', prespawnGuard: async ({ phase }) => { if (phase === 'nudge') throw guardError; } });
        await assert.rejects(() => adapter.invoke({ binding, snapshot, envelope: { kind: 'question', body: 'source' }, invocationId: 'inv-fixture' }), error => error === guardError);
        const records = f.records(); assert.equal(records.length, 1); assert.equal(records[0].contract.status, 'failed'); assert.equal(records[0].retry.applied, false);
    });
}

test('acceptance telemetry emits a non-sensitive incompleteness signal when even status writes fail', t => {
    const f = fixture(t), turn = f.turn(); turn.complete({ exitCode: 0 }); turn.contract({ status: 'succeeded', layer: 'contract' });
    const rename = fs.renameSync, write = fs.writeSync; let signal = '';
    fs.renameSync = () => { throw Object.assign(new Error('private filesystem error'), { code: 'EIO' }); };
    fs.writeSync = (fd, value, ...rest) => { if (fd === 2) { signal += value; return String(value).length; } return write(fd, value, ...rest); };
    try { assert.doesNotThrow(() => turn.contract({ status: 'failed', code: 'CONTRACT', layer: 'contract' })); }
    finally { fs.renameSync = rename; fs.writeSync = write; }
    assert.equal(signal, 'OMNI_SQUAD_ACCEPTANCE_CAPTURE_INCOMPLETE\n'); assert.ok(!signal.includes('private filesystem error'));
});

test('acceptance worker observer reaches the final spawn after isolation replaces runner dependencies', async t => {
    const f = fixture(t), turn = f.turn();
    const invocation = telemetry.linkResult({ command: 'fake', args: [], cwd: f.root, timeoutMs: 1000 }, turn);
    const { runProcess } = require('../lib/dual/agy-runner');
    let actualCalls = 0;
    const finalSpawn = () => { actualCalls++; const c = child(99); c.kill = () => {}; process.nextTick(() => { c.stderr.emit('data', Buffer.from('actual child stderr')); c.emit('close', 1); }); return c; };
    const raw = await runProcess(invocation, { env: f.env, spawn: finalSpawn });
    turn.complete(raw); turn.contract({ status: 'failed', code: 'EXIT', layer: 'process' });
    const record = f.records()[0]; assert.equal(actualCalls, 1); assert.equal(record.processStarted, true); assert.equal(record.pid, 99);
    assert.equal(record.sameRuntimeCountAtEnd, 1); assert.equal(record.stderrTail, 'actual child stderr');
});
