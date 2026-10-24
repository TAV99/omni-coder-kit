'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAgyAdapter, classify: classifyAgy } = require('../lib/dual/discussion/live-agy-invoke');
const { createCodexAdapter } = require('../lib/dual/discussion/live-codex-invoke');
const { sha256Utf8, validatePayload } = require('../lib/dual/discussion/contracts');

// Synthetic provider outputs only: no live CLI or network calls.
const snapshot = { text: 'read-only source', sha256: sha256Utf8('read-only source') };
function binding(provider) {
    return {
        schema_version: 1, provider, model: 'fixture', effort: 'medium',
        conversation_id: 'conv-fixture', role: 'astra', session_id: 'session-fixture',
        task_id: 'task-fixture', plan_revision: 1, snapshot_sha256: snapshot.sha256,
    };
}
function output(provider, response, expectedKind) {
    const stdout = provider === 'agy'
        ? JSON.stringify({ status: 'SUCCESS', conversation_id: 'conv-fixture', response })
        : [
            { type: 'thread.started', thread_id: 'conv-fixture' },
            { type: 'item.completed', item: { type: 'agent_message', text: response } },
            { type: 'turn.completed' },
        ].map(JSON.stringify).join('\n');
    return { exitCode: 0, stdout, stderr: '', expectedKind };
}
const content = { phase: 'scout', findings: [{ file: 'index.js' }] };
const envelope = { schema_version: 1, kind: 'reply', body: JSON.stringify(content) };

for (const [provider, create] of [['agy', createAgyAdapter], ['codex', createCodexAdapter]]) {
    const adapter = create();
    const classify = (response, expectedKind = 'reply', limits) => adapter.classify(
        output(provider, response, expectedKind), binding(provider), 'inv-fixture', limits,
    );
    for (const fenced of [false, true]) {
        for (const [name, value, repair] of [
            ['exact envelope', envelope, null],
            ['object body', { ...envelope, body: content }, 'body_object'],
            ['bare object', content, 'bare_object'],
        ]) {
            test(`${provider}: ${fenced ? 'fenced ' : ''}${name}`, () => {
                const json = JSON.stringify(value);
                const result = classify(fenced ? '```json\n' + json + '\n```' : json);
                assert.equal(result.completion, 'succeeded');
                assert.equal(result.schema, 'valid');
                assert.deepEqual(result.payload, envelope);
                const expectedRepair = [fenced ? 'fence' : null, repair].filter(Boolean).join('+');
                const base = provider === 'agy' ? 'agy-json-v1' : 'codex-jsonl-v1';
                assert.equal(result.evidenceRef, base + (expectedRepair ? `;payload-repair=${expectedRepair}` : ''));
            });
        }
    }
    test(`${provider}: bare content uses the expected question kind`, () => {
        assert.equal(classify(JSON.stringify(content), 'question').payload.kind, 'question');
    });
    for (const [name, response] of [
        ['embedded JSON', 'Here is the answer: ' + JSON.stringify(envelope)],
        ['embedded fence', 'Here is the answer:\n```json\n' + JSON.stringify(content) + '\n```'],
        ['array', JSON.stringify([content])], ['empty', ''], ['non-JSON', 'ready'],
        ['null', 'null'], ['scalar', '42'], ['JSON string', '"ready"'],
        ['nested fences', '```json\n```json\n{}\n```\n```'],
        ['partial schema envelope', JSON.stringify({ schema_version: 1, findings: [] })],
        ['partial kind envelope', JSON.stringify({ kind: 'reply', findings: [] })],
        ['wrong version', JSON.stringify({ ...envelope, schema_version: 2 })],
        ['array body', JSON.stringify({ ...envelope, body: [] })],
        ['null body', JSON.stringify({ ...envelope, body: null })],
    ]) {
        test(`${provider}: rejects ${name}`, () => {
            const result = classify(response);
            assert.equal(result.completion, 'succeeded');
            assert.equal(result.schema, 'invalid');
            assert.equal(result.payload, null);
        });
    }
    for (const body of [envelope.body, content]) {
        test(`${provider}: unknown envelope key rejected with ${typeof body} body`, () => {
            const result = classify(JSON.stringify({ ...envelope, body, extra: true }));
            assert.equal(result.schema, 'invalid');
            assert.equal(result.payload, null);
        });
    }
    test(`${provider}: bare content requires a valid expected kind`, () => {
        for (const expected of [undefined, null, 'invalid']) {
            const result = adapter.classify(output(provider, JSON.stringify(content), expected), binding(provider), 'inv-fixture');
            assert.equal(result.payload, null);
            assert.equal(result.schema, 'invalid');
        }
    });
    test(`${provider}: repaired payload still obeys body limits`, () => {
        const result = classify(JSON.stringify(content), 'reply', { maxBodyBytes: 5 });
        assert.equal(result.schema, 'invalid');
        assert.equal(result.payload, null);
    });
    test(`${provider}: repair does not bypass conversation correlation`, () => {
        const result = adapter.classify(output(provider, JSON.stringify(content), 'reply'),
            { ...binding(provider), conversation_id: 'wrong-conversation' }, 'inv-fixture');
        assert.equal(result.completion, 'unknown');
    });
    test(`${provider}: invoke carries per-turn expectation through the wrapper`, async (t) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'discussion-repair-'));
        t.after(() => fs.rm(dir, { recursive: true, force: true }));
        const executable = path.join(dir, 'provider');
        const stdout = output(provider, JSON.stringify(content)).stdout;
        await fs.writeFile(executable, "#!/bin/sh\nprintf '%s' '"
            + stdout.replace(/'/g, "'\"'\"'") + "'\n", { mode: 0o700 });
        const liveAdapter = create({ agyPath: executable, codexPath: executable });
        // Overlap opposite turns: expectation must belong to each invocation.
        const results = await Promise.all(['question', 'reply'].map(async (kind) => {
            const invocationId = `inv-${kind}`;
            const raw = await liveAdapter.invoke({ binding: binding(provider), snapshot,
                envelope: { kind, body: 'scout' }, invocationId });
            assert.equal(raw.exitCode, 0, JSON.stringify(raw));
            assert.equal(raw.expectedKind, kind === 'question' ? 'reply' : 'question');
            const result = liveAdapter.classify(raw, binding(provider), invocationId);
            assert.equal(result.schema, 'valid', JSON.stringify({ raw, result }));
            return result;
        }));
        assert.deepEqual(results.map((result) => result.payload && result.payload.kind), ['reply', 'question']);
        assert.ok(results.every((result) => result.completion === 'succeeded' && result.schema === 'valid'));
    });
}

test('AGY: object responses follow the same repairs and preserve unknown envelope keys', () => {
    for (const [response, expectedBody] of [[content, envelope.body], [{ ...envelope, body: content }, envelope.body]]) {
        const result = classifyAgy(output('agy', response, 'reply'));
        assert.equal(result.payload.body, expectedBody);
    }
    const result = classifyAgy(output('agy', { ...envelope, body: content, extra: true }, 'reply'));
    assert.equal(result.payload.extra, true);
    assert.throws(() => validatePayload(result.payload), /unknown field/);
});

for (const [provider, create] of [['agy', createAgyAdapter], ['codex', createCodexAdapter]]) {
    for (const [name, first, second, calls] of [
        ['denied actions recovers', 'invalid', JSON.stringify(envelope), 2],
        ['empty reply recovers', '', JSON.stringify(envelope), 2],
        ['valid reply needs no nudge', JSON.stringify(envelope), '', 1],
        ['repaired reply needs no nudge', JSON.stringify(content), '', 1],
        ['schema-invalid reply recovers', JSON.stringify({ ...envelope, extra: true }), JSON.stringify(envelope), 2],
        ['invalid nudge stops recovery', 'invalid', 'still invalid', 2],
        ['nudge applies repairs', '', '```json\n' + JSON.stringify(content) + '\n```', 2],
        ['nudge failure keeps marker', '', '', 2],
        ['provider failure is untouched', '', '', 1],
        ['nonzero exit is untouched', '', '', 1],
        ['timeout is untouched', '', '', 1],
        ['overflow is untouched', '', '', 1],
        ['budget exhausted skips nudge', '', '', 1],
    ]) {
        test(`${provider}: ${name}`, async (t) => {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'discussion-nudge-'));
            t.after(() => fs.rm(dir, { recursive: true, force: true }));
            const executable = path.join(dir, 'provider');
            const log = path.join(dir, 'calls.jsonl');
            const failed = name === 'provider failure is untouched';
            const stdout = (response, nudgeFailure = false) => {
                const raw = output(provider, response);
                if (name === 'denied actions recovers') {
                    if (provider === 'agy') return JSON.stringify({ ...JSON.parse(raw.stdout), usage: { denied_actions: ['RunCommand'] } });
                    return raw.stdout + '\n' + JSON.stringify({ type: 'usage', usage: { denied_actions: ['RunCommand'] } });
                }
                if (!failed && !nudgeFailure) return raw.stdout;
                return provider === 'agy'
                    ? JSON.stringify({ status: 'ERROR', conversation_id: 'conv-fixture', response })
                    : raw.stdout.replace('turn.completed', 'turn.failed');
            };
            const quote = (value) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
            await fs.writeFile(executable, '#!/bin/sh\n'
                + `printf x >> ${quote(log + '.count')}\n`
                + `if [ -f ${quote(log)} ]; then\n`
                + `printf '%s\\0' "$@" > ${quote(log + '.second')}\n`
                + `printf '%s' ${quote(stdout(second, name === 'nudge failure keeps marker'))}\nelse\n`
                + `printf '%s\\0' "$@" > ${quote(log)}\n`
                + (name === 'budget exhausted skips nudge' || name === 'timeout is untouched' ? 'sleep 0.1\n' : '')
                + `printf '%s' ${quote(stdout(first))}\n`
                + (name === 'nonzero exit is untouched' ? 'exit 7\n' : '')
                + 'fi\n', { mode: 0o700 });
            const adapter = create({ agyPath: executable, codexPath: executable });
            const raw = await adapter.invoke({ binding: binding(provider), snapshot,
                envelope: { kind: 'question', body: 'scout' }, invocationId: 'inv-nudge',
                timeoutMs: name === 'budget exhausted skips nudge' ? 5050
                    : name === 'timeout is untouched' ? 50 : 15000,
                maxOutputBytes: name === 'overflow is untouched' ? 32 : undefined });
            const result = adapter.classify(raw, binding(provider), 'inv-nudge');
            const recorded = [(await fs.readFile(log, 'utf8')).split('\0').slice(0, -1)];
            try { recorded.push((await fs.readFile(log + '.second', 'utf8')).split('\0').slice(0, -1)); }
            catch (err) { if (err.code !== 'ENOENT') throw err; }
            assert.equal((await fs.readFile(log + '.count', 'utf8')).length, calls);
            assert.equal(recorded.length, calls);
            assert.equal(result.evidenceRef.includes('+nudge'), calls === 2);
            if (name === 'valid reply needs no nudge') {
                assert.equal(result.evidenceRef, provider === 'agy' ? 'agy-json-v1' : 'codex-jsonl-v1');
            }
            if (name === 'nudge applies repairs') {
                assert.match(result.evidenceRef, /;payload-repair=fence\+bare_object\+nudge\+nudge-denied$/);
            }
            if (calls === 2) {
                assert.ok(recorded[1].includes('conv-fixture'));
                const prompt = provider === 'agy' ? recorded[1][1] : recorded[1][4];
                assert.match(prompt, /previous reply was empty\/invalid/i);
                assert.match(prompt, /"schema_version":1,"kind":"reply","body"/);
                assert.match(prompt, /serialized string/i);
                const denialAware = first === '' || name === 'denied actions recovers';
                assert.equal(result.evidenceRef.includes('+nudge-denied'), denialAware);
                if (denialAware) {
                    assert.match(prompt, /some tool actions were denied/i);
                    assert.match(prompt, /do NOT call tools/i);
                    assert.match(prompt, /ONLY from the prompt contents already provided/i);
                } else assert.doesNotMatch(prompt, /denied/i);
                if (provider === 'agy') {
                    const seconds = Number.parseInt(recorded[1][recorded[1].indexOf('--print-timeout') + 1]);
                    assert.ok(seconds >= 5 && seconds <= 15);
                }
            }
            if (['nonzero exit is untouched', 'timeout is untouched', 'overflow is untouched'].includes(name)) {
                assert.equal(result.completion, name === 'nonzero exit is untouched' ? 'failed' : 'unknown');
                if (name === 'nonzero exit is untouched') assert.equal(raw.exitCode, 7);
                if (name === 'timeout is untouched') assert.equal(raw.timedOut, true);
                if (name === 'overflow is untouched') assert.equal(raw.overflowed, true);
            } else if (name === 'invalid nudge stops recovery' || name === 'budget exhausted skips nudge') {
                assert.equal(result.payload, null);
            } else if (name === 'nudge failure keeps marker') {
                assert.equal(result.completion, 'failed');
                assert.equal(result.payload, null);
            } else if (failed) {
                assert.equal(result.completion, 'failed');
                assert.equal(raw.stdout, stdout(first));
            } else {
                assert.equal(result.schema, 'valid', JSON.stringify(raw));
                assert.deepEqual(result.payload, envelope);
            }
        });
    }
}

// Execution hooks use synthetic children so these cases cannot invoke provider CLIs.
function hookChild(stdout, onKill) {
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    const child = new EventEmitter();
    child.pid = 12345;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
        onKill?.(signal);
        setImmediate(() => {
            child.stdout.write('drained');
            child.emit('close', 137, signal);
        });
        return true;
    };
    if (stdout !== undefined) setImmediate(() => {
        child.stdout.write(stdout);
        child.emit('close', 0);
    });
    return child;
}
function hookParams(provider) {
    return { binding: binding(provider), snapshot, envelope: { kind: 'question', body: 'ready?' },
        invocationId: 'hooks-invocation', timeoutMs: 15000 };
}
for (const [provider, create, seed] of [
    ['agy', createAgyAdapter, require('../lib/dual/discussion/live-agy-invoke').seedAgyConversation],
    ['codex', createCodexAdapter, require('../lib/dual/discussion/live-codex-invoke').seedCodexConversation],
]) {
    test(`${provider}: hooks preserve env identity and await guard for turn, nudge and seed`, async () => {
        const env = { HOOK_ONLY: 'yes' };
        const phases = [];
        let calls = 0;
        let guarded = 0;
        const hooks = { model: 'fixture', effort: 'medium', cwd: process.cwd(), env,
            prespawnGuard: async (context) => {
                assert.equal(Object.isFrozen(context), true);
                assert.equal(context.cwd, process.cwd());
                assert.equal(context.env, env);
                await Promise.resolve();
                phases.push(context.phase);
                guarded++;
            },
            spawnImpl(command, args, opts) {
                calls++;
                assert.equal(guarded, calls);
                assert.equal(opts.env, env);
                assert.equal(opts.cwd, process.cwd());
                assert.equal(opts.shell, false);
                assert.ok(opts.signal || phases.at(-1) === 'seed');
                return hookChild(output(provider, calls === 1 ? '' : JSON.stringify({
                    schema_version: 1, kind: 'reply', body: 'ready',
                })).stdout);
            } };
        const raw = await create(hooks).invoke(hookParams(provider));
        assert.equal(raw.nudged, true);
        assert.equal(raw.exitCode, 0);
        assert.equal((await seed(hooks)).conversationId, 'conv-fixture');
        assert.deepEqual(phases, ['turn', 'nudge', 'seed']);
        assert.equal(calls, 3);
    });
    test(`${provider}: guard rejection preserves identity with zero spawns for adapter and seed`, async () => {
        const denied = new Error('authority denied');
        let calls = 0;
        const hooks = { model: 'fixture', effort: 'medium', prespawnGuard: async () => { throw denied; }, spawnImpl: () => { calls++; } };
        await assert.rejects(create(hooks).invoke(hookParams(provider)), (err) => err === denied);
        await assert.rejects(seed(hooks), (err) => err === denied);
        assert.equal(calls, 0);
    });
    test(`${provider}: nudge guard denial preserves identity and prevents second spawn`, async () => {
        const denied = new Error('lease revoked');
        let calls = 0;
        const adapter = create({ prespawnGuard: ({ phase }) => { if (phase === 'nudge') throw denied; },
            spawnImpl: () => { calls++; return hookChild(output(provider, '').stdout); } });
        await assert.rejects(adapter.invoke(hookParams(provider)), (err) => err === denied);
        assert.equal(calls, 1);
    });
    test(`${provider}: abort during guard prevents spawn`, async () => {
        const controller = new AbortController();
        let calls = 0;
        const adapter = create({ signal: controller.signal,
            prespawnGuard: async () => { controller.abort(); }, spawnImpl: () => { calls++; } });
        const raw = await adapter.invoke(hookParams(provider));
        assert.equal(raw.transportError, true);
        assert.equal(calls, 0);
    });
    for (const source of ['factory', 'invoke']) {
        test(`${provider}: ${source} signal abort kills and drains child with exit evidence`, async () => {
            const controller = new AbortController();
            let killed;
            let spawned;
            const started = new Promise((resolve) => { spawned = resolve; });
            const adapter = create({ ...(source === 'factory' ? { signal: controller.signal } : {}),
                spawnImpl: () => { spawned(); return hookChild(undefined, (signal) => { killed = signal; }); } });
            const pending = adapter.invoke({ ...hookParams(provider),
                ...(source === 'invoke' ? { signal: controller.signal } : {}) });
            await started;
            controller.abort();
            const raw = await pending;
            assert.equal(killed, 'SIGKILL');
            assert.equal(raw.exitCode, 137);
            assert.equal(raw.stdout, 'drained');
            assert.equal(raw.timedOut, true);
            assert.equal((await adapter.probeRecovery({ conversationId: 'conv-fixture' })).processQuiescent, true);
        });
    }
}

for (const [provider, create] of [['agy', createAgyAdapter], ['codex', createCodexAdapter]]) {
    test(`${provider}: native child abort drains through AbortError until close`, { timeout: 5000 }, async () => {
        const { spawn } = require('node:child_process');
        const controller = new AbortController();
        let ready;
        const started = new Promise((resolve) => { ready = resolve; });
        const adapter = create({ signal: controller.signal, spawnImpl(command, args, options) {
            const child = spawn('/bin/sh', ['-c', 'printf ready; exec sleep 10'], options);
            child.stdout.once('data', ready);
            return child;
        } });
        const pending = adapter.invoke(hookParams(provider));
        await Promise.race([started, pending.then(() => { throw new Error('child closed before ready'); })]);
        controller.abort();
        const raw = await pending;
        assert.equal(raw.stdout, 'ready');
        assert.equal(raw.timedOut, true);
        assert.equal(raw.transportError, false);
        assert.equal(raw.exitCode, null);
        assert.ok(raw.pid > 0);
        assert.equal((await adapter.probeRecovery({ conversationId: 'conv-fixture' })).processQuiescent, true);
    });
}

test('AGY seed fails closed before spawn when either profile field is missing', async (t) => {
    const { seedAgyConversation } = require('../lib/dual/discussion/live-agy-invoke');
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-seed-no-profile-'));
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    const saved = [process.env.OMNI_DUAL_WORKER_MODEL, process.env.OMNI_DUAL_WORKER_EFFORT];
    delete process.env.OMNI_DUAL_WORKER_MODEL;
    delete process.env.OMNI_DUAL_WORKER_EFFORT;
    try {
        for (const profile of [{}, { model: 'pinned' }, { effort: 'low' }]) {
            await assert.rejects(seedAgyConversation({ cwd, ...profile,
                spawnImpl() { assert.fail('missing profile spawned'); },
            }), /task\.(model|effort).*\.omni\/manifest\.json.*OMNI_DUAL_WORKER_/);
        }
    } finally {
        for (const [key, value] of [['OMNI_DUAL_WORKER_MODEL', saved[0]], ['OMNI_DUAL_WORKER_EFFORT', saved[1]]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
});

test('AGY invocation pins binding model and effort above adapter settings and passes both CLI flags', async () => {
    let observed;
    const adapter = createAgyAdapter({ model: 'adapter-model', effort: 'high',
        spawnImpl(_command, args) { observed = args; return hookChild(output('agy', JSON.stringify(envelope)).stdout); } });
    const raw = await adapter.invoke(hookParams('agy'));
    assert.equal(raw.exitCode, 0);
    assert.equal(observed[observed.indexOf('--model') + 1], 'fixture');
    assert.equal(observed[observed.indexOf('--effort') + 1], 'medium');
});
