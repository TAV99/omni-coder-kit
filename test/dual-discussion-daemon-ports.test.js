'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { canonicalizeEvent, computeEventHash, replayAuthorityEvents, computeLeaseStatus } = require('../lib/dual/authority-store');
const { validateCapabilityResult } = require('../lib/dual/capability-preflight');
const { createDaemonHostDeps } = require('../lib/dual/discussion/daemon-ports');
const { createHostPorts } = require('../lib/dual/discussion/host-ports');
const { createDiscussionSession, buildBindings } = require('../lib/dual/discussion/session');
const { createDiscussionAdapter } = require('../lib/dual/discussion/adapter');
const { bindingRef, sha256Utf8 } = require('../lib/dual/discussion/contracts');

const start = Date.parse('2026-08-25T00:00:00.000Z');
const now = start + 10_000;
const snapshot = { text: 'Daemon discussion', sha256: sha256Utf8('Daemon discussion') };
const preflightCheckIds = ['authority_ledger_integrity', 'baseline_backend',
    'project_configuration', 'agy_cli_and_model', 'mcp_and_hook_setup'];
const preflightChecks = () => preflightCheckIds.map((name) => ({ name, status: 'PASSED' }));
const sessionId = 'daemon-session';
const leaseId = '20000000-0000-4000-8000-000000000001';
const bindings = buildBindings({ sessionId, taskId: 'TASK-1', planRevision: 1,
    snapshotSha256: snapshot.sha256, codexConversationId: 'seed-codex', agyConversationId: 'seed-agy' });

// Full authority envelopes, including the prerequisite session/plan/routing history.
function events(released = false) {
    const payloads = [
        { type: 'session.created', state: 'DISCOVERED', workspace_root: process.cwd(), mode: 'auto' },
        { type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
            status: 'PASSED', checks: preflightChecks() },
        { type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
            plan_path: 'plans/plan.md', plan_sha256: 'd'.repeat(64), total_tasks: 1,
            tasks: [{ task_id: 'TASK-1', title: 'Discussion', owner: 'agy', allowed_files: ['lib/a.js'] }] },
        { type: 'task.routed', task_id: 'TASK-1', owner: 'agy', authority_state: 'ROUTED',
            model: bindings[1].model, effort: 'high', token_budget: 10000,
            allowed_files: ['lib/a.js'], reason: 'Discussion fixture' },
        { type: 'lease.acquired', lease_id: leaseId, task_id: 'TASK-1', owner: 'agy',
            acquired_at: new Date(start + 4000).toISOString(),
            expires_at: new Date(start + 34000).toISOString(), ttl_ms: 30000 },
    ];
    if (released) payloads.push({ type: 'lease.released', lease_id: leaseId, task_id: 'TASK-1',
        released_at: new Date(start + 5000).toISOString(), reason: 'settled' });
    let previousHash = '0'.repeat(64);
    return payloads.map((payload, index) => {
        const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        const event = JSON.parse(canonicalizeEvent({ schema_version: 2, sequence: index + 1,
            event_id: id(index + 1), causation_id: id(Math.max(1, index)),
            workspace_id: 'ws-daemon', session_id: sessionId, plan_revision: 1,
            expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
            timestamp: new Date(start + index * 1000).toISOString(), ...payload }));
        const envelope = { previous_hash: previousHash, event_hash: computeEventHash(previousHash, event), event };
        previousHash = envelope.event_hash;
        return envelope;
    });
}

function state(overrides = {}) {
    return { leaseEvents: events(), expectedPlanRevision: 1,
        expectedSnapshotSha256: snapshot.sha256, sessionId, ...overrides };
}

function passing(model = bindings[1].model) {
    return { status: 'PASSED', to_state: 'CAPABILITY_SAFE',
        checks: preflightChecks(),
        details: { agy_version: '1.2.3', agy_model: model,
            agy_evidence: { version: '1.2.3', model } } };
}

const capArgs = { binding: bindings[1], bindingRef: bindingRef(bindings[1]),
    snapshotSha256: snapshot.sha256, provider: 'agy', adapterId: 'fake-agy',
    adapterVersion: '1', mode: 'fake', stage: 'dispatch' };

test('authority allows a real replayed live lease and matching bindings', async () => {
    const derived = replayAuthorityEvents(events(), { clock: () => new Date(now) });
    assert.equal(computeLeaseStatus(derived.leases[leaseId], now), 'active');
    const deps = createDaemonHostDeps({ authority: async () => state(), now: () => now });
    assert.equal(await deps.checkAuthority({ bindings, stage: 'dispatch' }), true);
    assert.equal(await deps.checkAuthority({ binding: bindings[0] }), true);
});

for (const [name, overrides, time] of [
    ['expired lease', {}, start + 34000],
    ['released lease', { leaseEvents: events(true) }, now],
    ['revision mismatch', { expectedPlanRevision: 2 }, now],
    ['snapshot mismatch', { expectedSnapshotSha256: 'f'.repeat(64) }, now],
    ['session mismatch', { sessionId: 'other-session' }, now],
    ['missing events', { leaseEvents: undefined }, now],
    ['truncated history', { leaseEvents: events().slice(0, -1) }, now],
    ['missing revision', { expectedPlanRevision: undefined }, now],
    ['missing snapshot', { expectedSnapshotSha256: undefined }, now],
]) {
    test(`authority denies ${name}`, async () => {
        const deps = createDaemonHostDeps({ authority: () => state(overrides), now: () => time });
        assert.equal(await deps.checkAuthority({ bindings, stage: 'dispatch' }), false);
    });
}

test('authority fails closed on reader exceptions, corrupt history and missing binding', async () => {
    const throwing = createDaemonHostDeps({ authority: async () => { throw new Error('reader failed'); } });
    assert.equal(await throwing.checkAuthority({ bindings }), false);
    const corrupt = events();
    corrupt[4].event_hash = 'f'.repeat(64);
    const deps = createDaemonHostDeps({ authority: () => state({ leaseEvents: corrupt }), now: () => now });
    assert.equal(await deps.checkAuthority({ bindings }), false);
    assert.equal(await createDaemonHostDeps({ authority: () => state() }).checkAuthority({}), false);
});

test('authority checks every binding in the relay pair', async () => {
    const deps = createDaemonHostDeps({ authority: () => state(), now: () => now });
    assert.equal(await deps.checkAuthority({ bindings: [bindings[0], { ...bindings[1], plan_revision: 2 }] }), false);
});

test('capability validates real preflight output and maps all evidence identities', async () => {
    assert.deepEqual(passing().checks.map(({ name }) => name), preflightCheckIds);
    assert.deepEqual(events()[1].event.checks.map(({ name }) => name), preflightCheckIds);
    assert.equal(validateCapabilityResult(passing(), bindings[1].model).valid, true);
    let called = 0;
    const deps = createDaemonHostDeps({ authority: () => state(), now: () => now,
        preflight: { ttlMs: 1234, run: async (root, options) => {
            called += 1;
            assert.equal(root, process.cwd());
            assert.equal(options.provider, 'agy');
            assert.equal(options.workerModel, bindings[1].model);
            assert.equal(options.authorityStore.verifyIntegrity().valid, true);
            return passing();
        } } });
    const evidence = await deps.verifyCapability(capArgs);
    assert.equal(called, 1);
    assert.equal(typeof evidence.evidenceId, 'string');
    assert.ok(evidence.evidenceId.length > 0);
    assert.deepEqual(evidence, { allowed: true, liveProfileVerified: true, evidenceId: evidence.evidenceId,
        expiresAt: now + 1234, bindingRef: capArgs.bindingRef, provider: 'agy', adapterId: 'fake-agy',
        adapterVersion: '1', conversationId: bindings[1].conversation_id,
        snapshotSha256: snapshot.sha256, stage: 'dispatch' });
});

const codexArgs = { ...capArgs, binding: bindings[0], bindingRef: bindingRef(bindings[0]),
    provider: 'codex', adapterId: 'fake-codex' };

for (const result of [true, false, 'yes', undefined, new Error('probe failed')]) {
    test(`Codex live evidence requires its own successful probe: ${String(result)}`, async () => {
        let calls = 0;
        const deps = createDaemonHostDeps({ authority: () => state(), now: () => now,
            preflight: { run: async (_root, { workerModel }) => passing(workerModel), codexProbe: async (args) => {
                calls += 1;
                assert.equal(args, codexArgs);
                if (result instanceof Error) throw result;
                return result;
            } } });
        const evidence = await deps.verifyCapability(codexArgs);
        assert.equal(calls, 1);
        assert.equal(evidence.allowed, true);
        assert.equal(evidence.liveProfileVerified, result === true);
    });
}

test('Codex probe does not run when session preflight fails; AGY never runs it', async () => {
    let calls = 0;
    for (const [args, result] of [[codexArgs, undefined], [capArgs, passing()]]) {
        const deps = createDaemonHostDeps({ authority: () => state(), now: () => now,
            preflight: { run: async (_root, { workerModel }) => result && passing(workerModel), codexProbe: async () => { calls += 1; return true; } } });
        const evidence = await deps.verifyCapability(args);
        assert.equal(evidence.allowed, args.provider === 'agy');
        assert.equal(evidence.liveProfileVerified, args.provider === 'agy');
    }
    assert.equal(calls, 0);
});

test('default Codex probe requires exit zero and checks known models against cache when present', async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-codex-probe-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    t.mock.method(os, 'homedir', () => dir);
    await fs.mkdir(path.join(dir, '.codex'));
    const cachePath = path.join(dir, '.codex', 'models_cache.json');
    const codexPath = path.join(dir, 'codex');
    await fs.writeFile(codexPath, '#!/bin/sh\n[ "$1" = "--version" ] && [ "$#" = 1 ]\n', { mode: 0o700 });
    const verify = (cli = codexPath) => createDaemonHostDeps({ authority: () => state(), now: () => now,
        preflight: { run: async (_root, { workerModel }) => passing(workerModel), codexPath: cli } }).verifyCapability(codexArgs);
    assert.equal((await verify()).liveProfileVerified, true); // Cache absent: version alone suffices.
    await fs.writeFile(cachePath, JSON.stringify({ models: [{ slug: bindings[0].model }] }));
    assert.equal((await verify()).liveProfileVerified, true);
    await fs.writeFile(cachePath, JSON.stringify({ models: [{ slug: 'other-model' }] }));
    assert.equal((await verify()).liveProfileVerified, false);
    await fs.writeFile(cachePath, '{malformed');
    assert.equal((await verify()).liveProfileVerified, false);
    await fs.writeFile(cachePath, JSON.stringify({ models: [{ slug: bindings[0].model }] }));
    await fs.writeFile(codexPath, '#!/bin/sh\nexit 1\n');
    for (const cli of [codexPath, path.join(dir, 'missing-codex')]) {
        const evidence = await verify(cli);
        assert.equal(evidence.allowed, true);
        assert.equal(evidence.liveProfileVerified, false);
    }
});

for (const mismatch of [{ bindingRef: 'wrong-ref' }, { snapshotSha256: 'f'.repeat(64) }]) {
    test(`capability rejects inconsistent binding identity: ${Object.keys(mismatch)[0]}`, async () => {
        let calls = 0;
        const deps = createDaemonHostDeps({ authority: () => state(), now: () => now,
            preflight: { run: async () => { calls += 1; return passing(); } } });
        const evidence = await deps.verifyCapability({ ...capArgs, ...mismatch });
        assert.equal(evidence.allowed, false);
        assert.equal(evidence.liveProfileVerified, false);
        assert.equal(calls, 0);
    });
}

for (const [name, result] of [
    ['blocked', { status: 'BLOCKED', to_state: 'BLOCKED', checks: [], details: {} }],
    ['absent', undefined], ['unproven pass', { status: 'PASSED', to_state: 'CAPABILITY_SAFE' }],
    ['wrong model', passing('different-model')],
]) {
    test(`capability denies ${name} preflight output`, async () => {
        const deps = createDaemonHostDeps({ authority: () => state(), now: () => now,
            preflight: { run: async () => result } });
        const evidence = await deps.verifyCapability(capArgs);
        assert.equal(evidence.allowed, false);
        assert.equal(evidence.liveProfileVerified, false);
        assert.equal(evidence.bindingRef, capArgs.bindingRef);
        assert.equal(evidence.conversationId, bindings[1].conversation_id);
        assert.equal(evidence.expiresAt, now + 900000);
    });
}

test('capability probe errors fail closed', async () => {
    const deps = createDaemonHostDeps({ authority: () => state(), preflight: {
        run: async () => { throw new Error('probe failed'); } } });
    assert.equal((await deps.verifyCapability(capArgs)).allowed, false);
});

for (const [quiescent, terminal] of [[true, true], [true, false], [false, true], [false, false]]) {
    test(`recovery requires both probes: ${quiescent}/${terminal}`, async () => {
        const args = { binding: bindings[1], bindingRef: capArgs.bindingRef, invocationId: 'inv-1' };
        const probe = (value) => async (input) => { assert.equal(input, args); return value; };
        const deps = createDaemonHostDeps({ recoveryProbes: {
            isProcessQuiescent: probe(quiescent), isProviderTerminal: probe(terminal), providerOutcome: probe('failed'),
        } });
        const evidence = await deps.verifyRecoveryEvidence(args);
        assert.deepEqual(evidence, { allowed: quiescent && terminal, processQuiescent: quiescent,
            providerTerminal: quiescent && terminal, providerOutcome: quiescent ? 'failed' : 'unknown', evidenceId: evidence.evidenceId,
            bindingRef: args.bindingRef, invocationId: args.invocationId });
        assert.ok(evidence.evidenceId);
    });
}

for (const quiescent of [false, undefined, 'yes', new Error('quiescence failed')]) {
    test(`recovery skips terminal and outcome probes unless exactly quiescent: ${String(quiescent)}`, async () => {
        const calls = { quiescent: 0, terminal: 0, outcome: 0 };
        const deps = createDaemonHostDeps({ recoveryProbes: {
            isProcessQuiescent: async () => {
                calls.quiescent += 1;
                if (quiescent instanceof Error) throw quiescent;
                return quiescent;
            },
            isProviderTerminal: async () => { calls.terminal += 1; return true; },
            providerOutcome: async () => { calls.outcome += 1; return 'succeeded'; },
        } });
        const evidence = await deps.verifyRecoveryEvidence({});
        assert.equal(evidence.allowed, false);
        assert.equal(evidence.providerTerminal, false);
        assert.equal(evidence.providerOutcome, 'unknown');
        assert.deepEqual(calls, { quiescent: 1, terminal: 0, outcome: 0 });
    });
}

test('recovery denies missing, throwing and nonboolean probes', async () => {
    for (const recoveryProbes of [undefined, {},
        { isProcessQuiescent: () => true, isProviderTerminal: () => true },
        { isProcessQuiescent: () => { throw new Error('unknown'); }, isProviderTerminal: () => true, providerOutcome: () => 'failed' },
        { isProcessQuiescent: () => 'yes', isProviderTerminal: () => true, providerOutcome: () => 'failed' }]) {
        assert.equal((await createDaemonHostDeps({ recoveryProbes }).verifyRecoveryEvidence({})).allowed, false);
    }
});

function fakeAdapter(provider) {
    return createDiscussionAdapter({ id: `fake-${provider}`, provider, version: '1', mode: 'fake',
        profile: { format: 'json', requireConversationMatch: true, allowlistedTerminalMarkers: ['fixture.completed'] },
        invoke: async ({ binding, invocationId }) => ({ exitCode: 0, stderr: '',
            stdout: JSON.stringify({ conversationId: binding.conversation_id, invocationId }) }),
        classify: (raw) => ({ completion: 'succeeded', payload: { schema_version: 1, kind: 'reply', body: 'Answer' },
            observedConversationId: JSON.parse(raw.stdout).conversationId,
            observedInvocationId: JSON.parse(raw.stdout).invocationId,
            terminalMarker: 'fixture.completed', evidenceRef: 'fixture', hasTerminalError: false }),
    });
}

for (const expired of [false, true]) {
    test(`daemon deps integrate with seeded session: ${expired ? 'expired authority rejects dispatch' : 'dispatch succeeds'}`, async (t) => {
        const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-daemon-ports-'));
        let session;
        t.after(async () => {
            try { if (session) await session.close(); }
            finally { await fs.rm(stateDir, { recursive: true, force: true }); }
        });
        // Receive first; advance only the lease clock so the message remains valid.
        let authorityNow = now;
        let runs = 0;
        session = await createDiscussionSession({ enabled: true, stateDir, sessionId, taskId: 'TASK-1',
            planRevision: 1, snapshot, clock: () => now,
            seeds: Object.fromEntries(['codex', 'agy'].map((provider) => [provider, async () => ({ conversationId: `seed-${provider}` })])),
            adapters: { codex: fakeAdapter('codex'), agy: fakeAdapter('agy') },
            hostPorts: createHostPorts(createDaemonHostDeps({ authority: () => state(), now: () => authorityNow,
                preflight: { run: async () => { runs += 1; return passing(); } } })),
        });
        await session.relay.receive({ schema_version: 1, message_id: 'question-1',
            sender_ref: bindingRef(session.bindings[0]), recipient_ref: bindingRef(session.bindings[1]),
            sequence: 1, kind: 'question', body: 'Question?', created_at: now, expires_at: now + 300000 });
        if (expired) {
            authorityNow = start + 34000;
            await assert.rejects(session.relay.dispatch('question-1'), { code: 'AUTHORITY_STALE' });
            assert.equal(runs, 0);
            assert.equal((await session.relay.inspect()).invocation_count, 0);
        } else {
            const outcome = await session.relay.dispatch('question-1');
            assert.equal(outcome.provider, 'succeeded');
            assert.equal(outcome.discussion_result, 'available');
            assert.equal(runs, 1);
        }
    });
}
