'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
    DiscussionError, bindingRef, validateBindingPair, sha256Utf8,
} = require('../lib/dual/discussion/contracts');
const { createDiscussionAdapter } = require('../lib/dual/discussion/adapter');
const { createHostPorts } = require('../lib/dual/discussion/host-ports');
const { createDiscussionSession, buildBindings } = require('../lib/dual/discussion/session');

const snapshot = { text: 'Read-only discussion context', sha256: sha256Utf8('Read-only discussion context') };
const bindingOptions = {
    sessionId: 'host-session', taskId: 'task-1', planRevision: 1,
    models: { agy: 'gemini-3.8-flash-high' }, efforts: { agy: 'high' },
    snapshotSha256: snapshot.sha256,
    codexConversationId: 'seed-codex', agyConversationId: 'seed-agy',
};

function capabilityEvidence({ binding, bindingRef: ref, snapshotSha256, adapterId,
    provider, adapterVersion, stage }) {
    return {
        allowed: true, liveProfileVerified: true, evidenceId: 'host-evidence',
        expiresAt: Date.now() + 600_000, bindingRef: ref, provider, adapterId,
        adapterVersion, conversationId: binding.conversation_id, snapshotSha256, stage,
    };
}

function fakeAdapter(provider, invoke) {
    return createDiscussionAdapter({
        id: `fake-${provider}`, provider, version: '1', mode: 'fake',
        profile: {
            format: 'json', requireConversationMatch: true,
            allowlistedTerminalMarkers: ['fixture.completed'],
        },
        invoke: invoke || (async ({ binding, invocationId }) => ({
            exitCode: 0, stderr: '',
            stdout: JSON.stringify({
                conversationId: binding.conversation_id, invocationId,
                payload: { schema_version: 1, kind: 'reply', body: 'Stored answer' },
            }),
        })),
        classify: (raw) => ({
            completion: 'succeeded', payload: JSON.parse(raw.stdout).payload,
            observedConversationId: JSON.parse(raw.stdout).conversationId,
            observedInvocationId: JSON.parse(raw.stdout).invocationId,
            terminalMarker: 'fixture.completed', evidenceRef: 'fixture', hasTerminalError: false,
        }),
    });
}

async function sessionFixture(t, overrides = {}) {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-host-session-'));
    let session;
    t.after(async () => {
        try {
            if (session) await session.close();
        } finally {
            await fs.rm(stateDir, { recursive: true, force: true });
        }
    });
    const calls = [];
    session = await createDiscussionSession({
        enabled: true, stateDir, sessionId: 'host-session', taskId: 'task-1',
        models: bindingOptions.models, efforts: bindingOptions.efforts,
        planRevision: 1, snapshot,
        codex: { seedOptions: { cwd: '/fake/codex' } },
        agy: { seedOptions: { cwd: '/fake/agy' } },
        seeds: Object.fromEntries(['codex', 'agy'].map((provider) => [provider, async (options) => {
            calls.push({ provider, options });
            return { conversationId: `seed-${provider}` };
        }])),
        adapters: { codex: fakeAdapter('codex'), agy: fakeAdapter('agy') },
        hostPorts: createHostPorts({ checkAuthority: async () => true, verifyCapability: async (args) => capabilityEvidence(args) }),
        ...overrides,
    });
    return { session, calls, stateDir };
}

test('disabled sessions perform no seed, adapter, host-port or relay I/O', async () => {
    const fail = () => assert.fail('disabled session accessed dependencies');
    for (const enabled of [undefined, false, null, 0, 1, 'true']) {
        assert.deepEqual(await createDiscussionSession({
            enabled, seeds: { codex: fail, agy: fail },
            get adapters() { return fail(); }, get hostPorts() { return fail(); },
            get snapshot() { return fail(); }, get stateDir() { return fail(); },
        }), { enabled: false });
    }
});

test('seeded sessions register validated bindings with matching refs and release their lock', async (t) => {
    const { session, calls, stateDir } = await sessionFixture(t);
    assert.equal(session.enabled, true);
    assert.deepEqual(calls, [
        { provider: 'codex', options: { cwd: '/fake/codex' } },
        { provider: 'agy', options: { cwd: '/fake/agy', model: 'gemini-3.8-flash-high', effort: 'high', workerModel: 'gemini-3.8-flash-high', workerEffort: 'high' } },
    ]);
    assert.deepEqual(session.conversationIds, { codex: 'seed-codex', agy: 'seed-agy' });
    assert.deepEqual(session.bindings, buildBindings(bindingOptions));
    const pair = validateBindingPair(session.bindings, snapshot.sha256);
    const view = await session.relay.inspect();
    assert.deepEqual(view.bindings.map((b) => b.binding_ref), pair.bindings.map(bindingRef));
    assert.deepEqual(pair.bindings.map((b) => [b.provider, b.role, b.model, b.effort]), [
        ['codex', 'astra', 'gpt-6.1-sol', 'medium'],
        ['agy', 'argon', 'gemini-3.8-flash-high', 'high'],
    ]);
    await session.close();
    const { inspectJournal } = require('../lib/dual/discussion/journal');
    assert.equal((await inspectJournal({ stateDir })).locked, false);
});

test('provided conversation ids bypass seeds and allow offline construction of live adapters', async (t) => {
    const { session, calls } = await sessionFixture(t, {
        codex: { conversationId: 'existing-codex' }, agy: { conversationId: 'existing-agy' },
        adapters: undefined, adapterOptions: { codex: {}, agy: {} },
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(session.conversationIds, { codex: 'existing-codex', agy: 'existing-agy' });
});

test('receive and dispatch through session stores the correlated reply and forwards limits', async (t) => {
    const { session } = await sessionFixture(t, { limits: { maxInvocations: 1 } });
    const [astra, argon] = session.bindings;
    const now = Date.now();
    await session.relay.receive({
        schema_version: 1, message_id: 'question-1', sender_ref: bindingRef(astra),
        recipient_ref: bindingRef(argon), sequence: 1, kind: 'question', body: 'Question?',
        created_at: now, expires_at: now + 300_000,
    });
    const outcome = await session.relay.dispatch('question-1');
    assert.equal(outcome.provider, 'succeeded');
    assert.equal(outcome.schema, 'valid');
    assert.equal(outcome.discussion_result, 'available');
    const view = await session.relay.inspect();
    const reply = view.messages.find((m) => m.message_id === outcome.response_message_id);
    assert.equal(reply.body, 'Stored answer');
    assert.equal(reply.sender_ref, bindingRef(argon));
    assert.equal(reply.recipient_ref, bindingRef(astra));
    await assert.rejects(session.relay.dispatch(reply.message_id), { code: 'LIMIT_EXCEEDED' });
});

test('host ports fail closed for each missing callback and reject malformed evidence', async () => {
    const ports = createHostPorts();
    for (const [method, dep] of [
        [ports.authority.check, 'checkAuthority'],
        [ports.capabilityVerifier.verify, 'verifyCapability'],
        [ports.capabilityVerifier.verifyRecovery, 'verifyRecoveryEvidence'],
    ]) {
        await assert.rejects(method({}), (err) => err instanceof DiscussionError && err.message.includes(dep));
    }
    for (const value of [undefined, null, true, [], 'allowed']) {
        const invalid = createHostPorts({ verifyCapability: async () => value, verifyRecoveryEvidence: async () => value });
        await assert.rejects(invalid.capabilityVerifier.verify({}), { code: 'CAPABILITY_BLOCKED' });
        await assert.rejects(invalid.capabilityVerifier.verifyRecovery({}), { code: 'OUTCOME_UNKNOWN' });
    }
});

test('host ports forward arguments and evidence without manufacturing permission', async () => {
    const args = { stage: 'dispatch' };
    const evidence = { allowed: false, evidenceId: 'denied' };
    const recovery = { allowed: true, processQuiescent: true, providerTerminal: true,
        providerOutcome: 'failed', evidenceId: 'recovery', bindingRef: 'ref', invocationId: 'inv-1' };
    const ports = createHostPorts({
        checkAuthority: async (value) => { assert.equal(value, args); return true; },
        verifyCapability: async (value) => { assert.equal(value, args); return evidence; },
        verifyRecoveryEvidence: async (value) => { assert.equal(value, args); return recovery; },
    });
    assert.equal(await ports.authority.check(args), true);
    assert.equal(await ports.capabilityVerifier.verify(args), evidence);
    assert.equal(await ports.capabilityVerifier.verifyRecovery(args), recovery);
    assert.equal(await createHostPorts({ checkAuthority: async () => false }).authority.check(args), false);
    const failure = new Error('host unavailable');
    await assert.rejects(createHostPorts({ checkAuthority: async () => { throw failure; } }).authority.check(args), failure);
});

test('binding and snapshot validation reject invalid or mismatched sha before seeding', async () => {
    assert.throws(() => buildBindings({ ...bindingOptions, snapshotSha256: 'invalid' }), { code: 'INVALID_INPUT' });
    const pair = buildBindings(bindingOptions);
    assert.throws(() => validateBindingPair(pair, '0'.repeat(64)), { code: 'CORRELATION_INVALID' });
    assert.throws(() => validateBindingPair([pair[0], { ...pair[1], snapshot_sha256: '0'.repeat(64) }]),
        { code: 'CORRELATION_INVALID' });
    await assert.rejects(createDiscussionSession({
        enabled: true, ...bindingOptions, stateDir: '/unused',
        hostPorts: createHostPorts(), snapshot: { ...snapshot, sha256: '0'.repeat(64) },
        seeds: { codex: () => assert.fail('invalid snapshot seeded') },
    }), { code: 'CORRELATION_INVALID' });
    const custom = buildBindings({ ...bindingOptions, models: { codex: 'custom-codex', agy: 'custom-agy' } });
    assert.deepEqual(custom.map((b) => b.model), ['custom-codex', 'custom-agy']);
});

async function receiveQuestion(session, now = Date.now()) {
    const [astra, argon] = session.bindings;
    await session.relay.receive({
        schema_version: 1, message_id: 'question-1', sender_ref: bindingRef(astra),
        recipient_ref: bindingRef(argon), sequence: 1, kind: 'question', body: 'Question?',
        created_at: now, expires_at: now + 300_000,
    });
}

test('authority allows only literal true, including structured denial regression', async () => {
    for (const value of [false, { valid: false }, { valid: true }, 'true', 1, undefined, null]) {
        const ports = createHostPorts({ checkAuthority: async () => value });
        assert.equal(await ports.authority.check({}), false);
    }
});

test('session dispatch rejects false authority with AUTHORITY_STALE', async (t) => {
    const { session } = await sessionFixture(t, {
        hostPorts: createHostPorts({
            checkAuthority: async () => false,
            verifyCapability: () => assert.fail('authority denial must block capability verification'),
        }),
    });
    await receiveQuestion(session);
    await assert.rejects(session.relay.dispatch('question-1'), { code: 'AUTHORITY_STALE' });
    assert.equal((await session.relay.inspect()).invocation_count, 0);
});

for (const evidence of [{ allowed: false }, { allowed: true }, undefined]) {
    test(`session dispatch blocks capability evidence ${JSON.stringify(evidence)}`, async (t) => {
        const { session } = await sessionFixture(t, {
            hostPorts: createHostPorts({ checkAuthority: async () => true, verifyCapability: async () => evidence }),
        });
        await receiveQuestion(session);
        await assert.rejects(session.relay.dispatch('question-1'), { code: 'CAPABILITY_BLOCKED' });
        assert.equal((await session.relay.inspect()).invocation_count, 0);
    });
}

test('session forwards model overrides and execution identity into both bindings', async (t) => {
    const models = { codex: 'custom-codex', agy: 'custom-agy' };
    const execution = { attempt: 2, workspace_binding_sha256: 'a'.repeat(64) };
    const { session } = await sessionFixture(t, { models, execution });
    assert.deepEqual(session.bindings.map((b) => b.model), Object.values(models));
    assert.deepEqual(session.bindings.map((b) => b.execution), [execution, execution]);
    assert.deepEqual(session.bindings, buildBindings({ ...bindingOptions, models, execution }));
    assert.throws(() => buildBindings({ ...bindingOptions, execution: { ...execution, attempt: -1 } }),
        { code: 'INVALID_INPUT' });
});

test('session validates required inputs and port shapes before any seed call', async () => {
    const valid = {
        enabled: true, ...bindingOptions, snapshot, stateDir: '/unused', hostPorts: createHostPorts(),
    };
    const invalid = [
        ...['sessionId', 'taskId'].flatMap((key) => [undefined, '', 'bad id', 1].map((value) => ({ [key]: value }))),
        ...[undefined, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1].map((planRevision) => ({ planRevision })),
        ...[undefined, '', '   ', 1].map((stateDir) => ({ stateDir })),
        ...[undefined, {}, { authority: { check: true } },
            { authority: { check() {} }, capabilityVerifier: { verify() {} } },
            { authority: { check() {} }, capabilityVerifier: { verify: true, verifyRecovery() {} } },
        ].map((hostPorts) => ({ hostPorts })),
    ];
    for (const overrides of invalid) {
        let seedCalls = 0;
        await assert.rejects(createDiscussionSession({
            ...valid, ...overrides,
            seeds: { codex: async () => { seedCalls += 1; throw new Error('seed must not run'); } },
        }), (err) => err instanceof DiscussionError && err.code === 'INVALID_INPUT');
        assert.equal(seedCalls, 0);
    }
});

test('second provider seed failure preserves error details and first conversation id', async () => {
    const failure = new Error('agy seed failed');
    failure.details = { provider: 'agy' };
    await assert.rejects(createDiscussionSession({
        enabled: true, ...bindingOptions, snapshot, stateDir: '/unused', hostPorts: createHostPorts(),
        seeds: {
            codex: async () => ({ conversationId: 'acquired-codex' }),
            agy: async () => { throw failure; },
        },
    }), (err) => {
        assert.equal(err, failure);
        assert.deepEqual(err.details, { provider: 'agy', conversationIds: { codex: 'acquired-codex' } });
        return true;
    });
});

test('relay creation failure carries both acquired conversation ids', async () => {
    await assert.rejects(createDiscussionSession({
        enabled: true, ...bindingOptions, snapshot, stateDir: '/unused', hostPorts: createHostPorts(),
        codex: { conversationId: 'existing-codex' }, agy: { conversationId: 'existing-agy' },
        adapters: {},
    }), (err) => {
        assert.equal(err.code, 'INVALID_INPUT');
        assert.deepEqual(err.details.conversationIds, { codex: 'existing-codex', agy: 'existing-agy' });
        return true;
    });
});

test('session forwards clock and syncHook to the relay journal', async (t) => {
    let now = 1000;
    const events = [];
    const { session } = await sessionFixture(t, {
        clock: () => now,
        syncHook: async (args) => { if (args) events.push(args.event); },
    });
    await receiveQuestion(session, now);
    assert.ok(events.some((event) => event.type === 'received'));
    now += 300_000;
    await assert.rejects(session.relay.dispatch('question-1'), { code: 'LIMIT_EXCEEDED' });
});

test('session reconciles unknown outcomes through host recovery evidence', async (t) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let recoveryArgs;
    const { session } = await sessionFixture(t, {
        limits: { timeoutMs: 10 },
        adapters: { codex: fakeAdapter('codex'), agy: fakeAdapter('agy', async () => { await gate; throw new Error('stopped'); }) },
        hostPorts: createHostPorts({
            checkAuthority: async () => true,
            verifyCapability: async (args) => capabilityEvidence(args),
            verifyRecoveryEvidence: async (args) => {
                recoveryArgs = args;
                return { allowed: true, processQuiescent: true, providerTerminal: true,
                    providerOutcome: 'failed', evidenceId: 'recovery-proof',
                    bindingRef: args.bindingRef, invocationId: args.invocationId };
            },
        }),
    });
    await receiveQuestion(session);
    try {
        await assert.rejects(session.relay.dispatch('question-1'), { code: 'OUTCOME_UNKNOWN' });
    } finally {
        release();
    }
    const evidence = { operatorNote: 'provider stopped' };
    const turn = await session.relay.reconcile('question-1', evidence);
    assert.deepEqual(recoveryArgs.evidence, evidence);
    assert.equal(recoveryArgs.bindingRef, bindingRef(session.bindings[1]));
    assert.equal(typeof recoveryArgs.invocationId, 'string');
    assert.equal(turn.reconciled, true);
    assert.equal(turn.reconciled_outcome, 'failed');
    assert.equal((await session.relay.inspect()).blocked, false);
});

test('AGY configuration is required before either provider seeds', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discussion-no-profile-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const saved = [process.env.OMNI_DUAL_WORKER_MODEL, process.env.OMNI_DUAL_WORKER_EFFORT];
    delete process.env.OMNI_DUAL_WORKER_MODEL;
    delete process.env.OMNI_DUAL_WORKER_EFFORT;
    try {
        for (const profile of [{}, { models: { agy: 'pinned' } }, { efforts: { agy: 'low' } }]) {
            await assert.rejects(createDiscussionSession({
                enabled: true, ...bindingOptions, models: {}, efforts: {}, ...profile,
                snapshot, stateDir: root, workspaceRoot: root, hostPorts: createHostPorts(),
                seeds: { codex() { assert.fail('missing AGY profile seeded codex'); }, agy() { assert.fail('missing AGY profile seeded AGY'); } },
            }), (error) => error.code === 'DUAL_WORKER_CONFIGURATION_MISSING'
                && /task\.(model|effort)/.test(error.message)
                && /\.omni\/manifest\.json/.test(error.message)
                && /OMNI_DUAL_WORKER_(MODEL|EFFORT)/.test(error.message));
        }
    } finally {
        for (const [key, value] of [['OMNI_DUAL_WORKER_MODEL', saved[0]], ['OMNI_DUAL_WORKER_EFFORT', saved[1]]]) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
});

test('manifest AGY profile is passed to seed and bindings', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'discussion-manifest-profile-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, '.omni'));
    await fs.writeFile(path.join(root, '.omni', 'manifest.json'), JSON.stringify({ workerModel: 'manifest-pinned', workerEffort: 'low' }));
    const { session, calls } = await sessionFixture(t, { models: {}, efforts: {}, workspaceRoot: root });
    assert.equal(session.bindings[1].model, 'manifest-pinned');
    assert.equal(session.bindings[1].effort, 'low');
    assert.equal(calls[1].options.model, 'manifest-pinned');
    assert.equal(calls[1].options.effort, 'low');
});
