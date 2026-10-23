'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const { sha256Utf8 } = require('../lib/dual/discussion/contracts');

for (const provider of ['agy', 'codex']) {
    test(`${provider}: recovery probes track child lifetime and terminal evidence`, async (t) => {
        const children = [];
        t.mock.method(childProcess, 'spawn', () => {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.pid = 100 + children.length;
            child.kill = () => { child.killed = true; };
            children.push(child);
            return child;
        });
        const modulePath = require.resolve(`../lib/dual/discussion/live-${provider}-invoke`);
        delete require.cache[modulePath];
        t.after(() => { delete require.cache[modulePath]; });
        const module = require(modulePath);
        const adapter = provider === 'agy' ? module.createAgyAdapter() : module.createCodexAdapter();
        const probe = (conversationId) => adapter.probeRecovery({ conversationId });
        assert.equal(typeof module.probeRecovery, 'function');
        assert.deepEqual(await probe('unknown'), {
            processQuiescent: false, providerTerminal: false, providerOutcome: 'unknown',
        });
        const snapshot = { text: 'source', sha256: sha256Utf8('source') };
        const invoke = (conversationId, timeoutMs = 1000) => adapter.invoke({
            binding: { schema_version: 1, provider, model: 'fixture', effort: 'medium',
                conversation_id: conversationId, role: 'astra', session_id: 'session-probe',
                task_id: 'task-probe', plan_revision: 1, snapshot_sha256: snapshot.sha256 },
            snapshot, envelope: { kind: 'question', body: 'scout' },
            invocationId: `inv-${conversationId}`, timeoutMs,
        });
        const success = invoke('success');
        assert.deepEqual(await Promise.race([probe('success'), new Promise((_, reject) =>
            setImmediate(() => reject(new Error('Running child probe must not wait'))))]), {
            processQuiescent: false, providerTerminal: false, providerOutcome: 'unknown',
        });
        const payload = JSON.stringify({ schema_version: 1, kind: 'reply', body: 'answer' });
        const stdout = provider === 'agy'
            ? JSON.stringify({ status: 'SUCCESS', conversation_id: 'success', response: payload })
            : [{ type: 'thread.started', thread_id: 'success' },
                { type: 'item.completed', item: { type: 'agent_message', text: payload } },
                { type: 'turn.completed' }].map(JSON.stringify).join('\n');
        children[0].stdout.emit('data', Buffer.from(stdout));
        children[0].emit('close', 0);
        await success;
        assert.deepEqual(await probe('success'), {
            processQuiescent: true, providerTerminal: true, providerOutcome: 'succeeded',
        });
        assert.deepEqual(await module.probeRecovery({ conversationId: 'success' }), await probe('success'));

        const timeout = invoke('timeout', 10);
        await timeout;
        assert.equal(children[1].killed, true);
        const waiting = probe('timeout');
        let answered = false;
        waiting.then(() => { answered = true; });
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(answered, false);
        children[1].emit('close', null);
        assert.deepEqual(await waiting, {
            processQuiescent: true, providerTerminal: true, providerOutcome: 'failed',
        });

        const failure = invoke('error');
        children[2].emit('error', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }));
        await failure;
        assert.deepEqual(await probe('error'), {
            processQuiescent: true, providerTerminal: true, providerOutcome: 'failed',
        });
        children[2].emit('close', null);
        assert.equal((await probe('error')).providerOutcome, 'failed');

        const unproven = invoke('unproven');
        children[3].emit('close', 0);
        await unproven;
        assert.deepEqual(await probe('unproven'), {
            processQuiescent: true, providerTerminal: false, providerOutcome: 'unknown',
        });

        const invalid = invoke('invalid');
        const invalidStdout = stdout.replaceAll('success', 'invalid')
            .replaceAll('answer', '');
        children[4].stdout.emit('data', Buffer.from(invalidStdout));
        children[4].emit('close', 0);
        await invalid;
        assert.deepEqual(await probe('invalid'), {
            processQuiescent: true, providerTerminal: true, providerOutcome: 'unknown',
        });

        const older = invoke('overlap');
        const newer = invoke('overlap');
        children[6].stdout.emit('data', Buffer.from(stdout.replaceAll('success', 'overlap')));
        children[6].emit('close', 0);
        await newer;
        assert.deepEqual(await probe('overlap'), {
            processQuiescent: false, providerTerminal: true, providerOutcome: 'succeeded',
        });
        children[5].emit('close', 7);
        await older;
        assert.deepEqual(await probe('overlap'), {
            processQuiescent: true, providerTerminal: true, providerOutcome: 'succeeded',
        });

        for (const scenario of ['completed-timeout', 'provider-failed', 'wrong-conversation',
            'wrong-kind', 'wrong-schema']) {
            const result = invoke(scenario, 10);
            const child = children[children.length - 1];
            let captured = stdout.replaceAll('success', scenario);
            if (scenario === 'provider-failed') {
                captured = provider === 'agy' ? captured.replace('SUCCESS', 'ERROR')
                    : captured + '\n' + JSON.stringify({ type: 'turn.failed' });
            }
            if (scenario === 'wrong-conversation') captured = stdout;
            if (scenario === 'wrong-kind') captured = captured.replace('reply', 'question');
            if (scenario === 'wrong-schema') captured = captured.replace('answer', '');
            child.stdout.emit('data', Buffer.from(captured));
            await result;
            assert.equal(child.killed, true);
            const waiting = probe(scenario);
            child.emit('close', null);
            await new Promise(setImmediate);
            assert.deepEqual(await waiting, {
                processQuiescent: true, providerTerminal: true,
                providerOutcome: scenario === 'completed-timeout' ? 'succeeded' : 'failed',
            }, scenario);
        }
        const exited = invoke('exited');
        const exitedChild = children[children.length - 1];
        exitedChild.exitCode = 7;
        exitedChild.emit('exit', 7);
        let exitProbeSettled = false;
        const exitProbe = probe('exited').then((result) => { exitProbeSettled = true; return result; });
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.equal(exitProbeSettled, false);
        exitedChild.emit('close', 7);
        await exited;
        assert.deepEqual(await exitProbe, {
            processQuiescent: true, providerTerminal: true, providerOutcome: 'failed',
        });

        const unreaped = invoke('unreaped', 10);
        const unreapedChild = children[children.length - 1];
        await unreaped;
        const started = performance.now();
        const unprovenReap = await probe('unreaped');
        assert.ok(performance.now() - started >= 2900);
        assert.ok(performance.now() - started < 5000);
        assert.deepEqual(unprovenReap, {
            processQuiescent: false, providerTerminal: false, providerOutcome: 'unknown',
        });
        unreapedChild.emit('close', null);
    });
}
