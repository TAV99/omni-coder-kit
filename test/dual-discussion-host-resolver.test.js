'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { canonicalizeEvent, computeEventHash } = require('../lib/dual/authority-store');
const { createDiscussionHost } = require('../lib/dual/discussion/host-resolver');
const { createDaemonHostDeps } = require('../lib/dual/discussion/daemon-ports');
const { createDiscussionAdapter } = require('../lib/dual/discussion/adapter');
const { bindingRef, sha256Utf8 } = require('../lib/dual/discussion/contracts');

const preflightCheckIds = ['authority_ledger_integrity', 'baseline_backend',
    'project_configuration', 'agy_cli_and_model', 'mcp_and_hook_setup'];
const preflightChecks = () => preflightCheckIds.map((name) => ({ name, status: 'PASSED' }));
const sessionId = 'daemon-session';
const leaseId = '20000000-0000-4000-8000-000000000001';
const bindings = [{}, { model: 'gemini-3.8-flash-high' }];

// Full authority envelopes, including the prerequisite session/plan/routing history.
function events(released = false) {
    const start = Date.now() - 10_000;
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


async function fixture(t, overrides = {}) {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-discussion-resolver-'));
    let revision = 1;
    const calls = [];
    const host = createDiscussionHost({
        enabled: true, stateDir,
        models: { agy: 'gemini-3.8-flash-high' }, efforts: { agy: 'high' },
        daemon: { sessionId, getPlanRevision: () => revision,
            readLeaseEvents: async () => events(), workspaceRoot: process.cwd() },
        seeds: Object.fromEntries(['codex', 'agy'].map((provider) => [provider, async (options) => {
            calls.push({ provider, options });
            return { conversationId: `seed-${provider}-${calls.length}` };
        }])),
        adapters: { codex: fakeAdapter('codex'), agy: fakeAdapter('agy') },
        preflight: { run: async (_root, { workerModel }) => ({
            status: 'PASSED', to_state: 'CAPABILITY_SAFE', checks: preflightChecks(),
            details: { agy_version: '1.2.3', agy_model: workerModel,
                agy_evidence: { version: '1.2.3', model: workerModel } },
        }), codexProbe: async () => true },
        ...overrides,
    });
    t.after(async () => {
        try { await host.closeAll(); }
        finally { await fs.rm(stateDir, { recursive: true, force: true }); }
    });
    return { host, calls, stateDir, setRevision(value) { revision = value; } };
}
const context = { taskId: 'TASK-1', snapshotSha256: 'a'.repeat(40), phase: 'scout', workspaceRoot: process.cwd() };

async function question(session) {
    const now = Date.now();
    await session.relay.receive({ schema_version: 1, message_id: 'question-1',
        sender_ref: bindingRef(session.bindings[0]), recipient_ref: bindingRef(session.bindings[1]),
        sequence: 1, kind: 'question', body: 'Question?', created_at: now, expires_at: now + 300_000 });
}

test('resolver caches the same task/baseline/revision and seeds each provider once', async (t) => {
    const { host, calls } = await fixture(t);
    const [session, same] = await Promise.all([host.sessionResolver(context), host.sessionResolver(context)]);
    assert.equal(session.enabled, true);
    assert.equal(same, session);
    assert.equal(await host.sessionResolver({ ...context, phase: 'review' }), session);
    assert.deepEqual(calls.map((c) => c.provider), ['codex', 'agy']);
    assert.ok(calls.every((c) => c.options.cwd === process.cwd()));
    const state = await host.authorityReader({ bindings: session.bindings });
    assert.equal(state.expectedSnapshotSha256, session.bindings[0].snapshot_sha256);
    assert.notEqual(state.expectedSnapshotSha256, context.snapshotSha256);
});

test('baseline change replaces registry and old dispatch fails real authority', async (t) => {
    const { host } = await fixture(t);
    const old = await host.sessionResolver(context);
    await question(old);
    const current = await host.sessionResolver({ ...context, snapshotSha256: 'b'.repeat(40) });
    assert.notEqual(current, old);
    assert.notEqual(current.bindings[0].snapshot_sha256, old.bindings[0].snapshot_sha256);
    assert.equal((await host.authorityReader({ binding: old.bindings[0] })).expectedSnapshotSha256,
        current.bindings[0].snapshot_sha256);
    await assert.rejects(old.relay.dispatch('question-1'), { code: 'AUTHORITY_STALE' });
    await question(current);
    assert.equal((await current.relay.dispatch('question-1')).provider, 'succeeded');
});

test('plan revision change creates a new session and supersedes old authority', async (t) => {
    const { host, setRevision, calls } = await fixture(t);
    const old = await host.sessionResolver(context);
    await question(old);
    setRevision(2);
    const current = await host.sessionResolver(context);
    assert.notEqual(old, current);
    assert.equal(current.bindings[0].plan_revision, 2);
    assert.equal(calls.length, 4);
    assert.equal((await host.authorityReader({ binding: old.bindings[0] })).expectedPlanRevision, 2);
    await assert.rejects(old.relay.dispatch('question-1'), { code: 'AUTHORITY_STALE' });
});

test('end-to-end dispatch succeeds with real lease replay and capability ports', async (t) => {
    const { host } = await fixture(t);
    const session = await host.sessionResolver(context);
    await question(session);
    const result = await session.relay.dispatch('question-1');
    assert.equal(result.provider, 'succeeded');
    assert.equal(result.schema, 'valid');
    assert.equal(result.discussion_result, 'available');
    const reply = (await session.relay.inspect()).messages.find((m) => m.message_id === result.response_message_id);
    assert.equal(reply.body, 'Stored answer');
});

test('missing registry entry returns empty expectation and authority denies', async (t) => {
    const { host } = await fixture(t);
    const binding = { session_id: sessionId, task_id: 'TASK-1', plan_revision: 1,
        snapshot_sha256: sha256Utf8('unregistered') };
    assert.equal((await host.authorityReader({ binding })).expectedSnapshotSha256, '');
    assert.equal(await createDaemonHostDeps({ authority: host.authorityReader }).checkAuthority({ binding }), false);
});

test('only literal enabled true seeds sessions', async () => {
    for (const enabled of [undefined, false, null, 0, 1, 'true', '1']) {
        const host = createDiscussionHost({ enabled,
            seeds: { codex: () => assert.fail('disabled resolver seeded') },
            get daemon() { return { getPlanRevision() { assert.fail('disabled resolver read state'); } }; },
        });
        assert.deepEqual(await host.sessionResolver(context), { enabled: false });
        await host.closeAll();
    }
});

test('closeAll closes every cached relay and clears registry', async (t) => {
    const { host, stateDir } = await fixture(t);
    const sessions = [await host.sessionResolver(context),
        await host.sessionResolver({ ...context, snapshotSha256: undefined })];
    await host.closeAll();
    const { inspectJournal } = require('../lib/dual/discussion/journal');
    for (const name of await fs.readdir(stateDir)) {
        assert.equal((await inspectJournal({ stateDir: path.join(stateDir, name) })).locked, false);
    }
    assert.equal((await host.authorityReader({ bindings: sessions[0].bindings })).expectedSnapshotSha256, '');
    await host.closeAll();
});

test('daemon wiring defaults on with strict env opt-out and converts validated store events to authority envelopes', async () => {
    const vm = require('node:vm');
    const { createRequire } = require('node:module');
    const serverPath = require.resolve('../lib/dual/daemon-server');
    const source = await fs.readFile(serverPath, 'utf8');
    const localRequire = createRequire(serverPath);
    const cases = [
        [undefined, true], ['', true], ['   ', true],
        ['0', false], ['false', false], ['off', false], ['no', false],
        ['1', true], ['true', true], ['on', true], ['yes', true],
        ['banana', false], ['01', false],
        [' 0 ', false], [' FALSE ', false], [' Off ', false], [' NO ', false],
        [' 1 ', true], [' TRUE ', true], [' On ', true], [' YES ', true],
    ];
    for (const [flag, enabled] of cases) {
        const history = events();
        let revision = 1;
        let hostOptions;
        let adapterOptions;
        const sentinel = new Error('adapter construction reached');
        const module = { exports: {} };
        const wrapped = vm.runInNewContext('(function(require, module, exports) {\n' + source + '\n})', {
            process: { env: flag === undefined ? {} : { OMNI_DUAL_DISCUSSION_ENABLED: flag }, cwd: () => process.cwd() },
        }, { filename: serverPath });
        wrapped((name) => {
            if (name === './discussion/host-resolver') return { createDiscussionHost(options) {
                hostOptions = options;
                return { sessionResolver: resolver, closeAll: async () => {} };
            } };
            if (name === './orchestrator-adapter') return { createOrchestratorAdapter(options) {
                adapterOptions = options;
                throw sentinel;
            } };
            return localRequire(name);
        }, module, module.exports);
        const resolver = async () => {};
        await assert.rejects(module.exports.startDaemonServer({ workspaceRoot: process.cwd(),
            authorityStore: { derive: () => ({ sessionId, planRevision: revision }),
                readEvents: () => history.map((record) => record.event) },
        }), (err) => err === sentinel);
        if (!enabled) {
            assert.equal(hostOptions, undefined, `flag=${JSON.stringify(flag)}`);
            assert.equal(Object.hasOwn(adapterOptions, 'discussion'), false);
            continue;
        }
        assert.equal(adapterOptions.discussion.enabled, true);
        assert.equal(adapterOptions.discussion.sessionResolver, resolver);
        assert.equal(typeof hostOptions.adapters.codex.probeRecovery, 'function');
        assert.equal(typeof hostOptions.adapters.agy.probeRecovery, 'function');
        assert.equal(hostOptions.daemon.sessionId, sessionId);
        assert.equal(hostOptions.daemon.workspaceRoot, process.cwd());
        assert.deepEqual(JSON.parse(JSON.stringify(hostOptions.daemon.readLeaseEvents())), history);
        const binding = { session_id: sessionId, task_id: 'TASK-1', plan_revision: 1,
            snapshot_sha256: 'f'.repeat(64) };
        const deps = createDaemonHostDeps({ authority: async () => ({
            leaseEvents: hostOptions.daemon.readLeaseEvents(),
            sessionId: hostOptions.daemon.sessionId,
            expectedPlanRevision: hostOptions.daemon.getPlanRevision(),
            expectedSnapshotSha256: binding.snapshot_sha256,
        }) });
        assert.equal(await deps.checkAuthority({ binding }), true);
        revision = 2;
        assert.equal(hostOptions.daemon.getPlanRevision(), 2);
        assert.equal(await deps.checkAuthority({ binding }), false);
    }
});


test('a slow superseded seed cannot overwrite the current task registry', async (t) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let seedCount = 0;
    const { host } = await fixture(t, { seeds: {
        codex: async () => {
            const n = ++seedCount;
            if (n === 1) await gate;
            return { conversationId: `seed-codex-${n}` };
        },
        agy: async () => ({ conversationId: 'seed-agy' }),
    } });
    const pendingOld = host.sessionResolver(context);
    let current;
    try {
        current = await host.sessionResolver({ ...context, snapshotSha256: 'c'.repeat(40) });
    } finally {
        release();
    }
    const old = await pendingOld;
    assert.equal((await host.authorityReader({ bindings: old.bindings })).expectedSnapshotSha256,
        current.bindings[0].snapshot_sha256);
    await question(old);
    await assert.rejects(old.relay.dispatch('question-1'), { code: 'AUTHORITY_STALE' });
    await question(current);
    assert.equal((await current.relay.dispatch('question-1')).provider, 'succeeded');
});

for (const provider of ['codex', 'agy']) {
    test(`resolver derives recovery probes from the ${provider} adapter`, async (t) => {
        const calls = [];
        const adapters = Object.fromEntries(['codex', 'agy'].map((name) => [name, {
            ...fakeAdapter(name, async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true })),
            probeRecovery(args) {
                calls.push({ provider: name, ...args });
                return { processQuiescent: true, providerTerminal: true, providerOutcome: 'failed' };
            },
        }]));
        const { host } = await fixture(t, { adapters });
        const session = await host.sessionResolver(context);
        const recipient = session.bindings.find((binding) => binding.provider === provider);
        const sender = session.bindings.find((binding) => binding.provider !== provider);
        const now = Date.now();
        await session.relay.receive({ schema_version: 1, message_id: 'recovery-question',
            sender_ref: bindingRef(sender), recipient_ref: bindingRef(recipient), sequence: 1,
            kind: 'question', body: 'Question?', created_at: now, expires_at: now + 300_000 });
        await assert.rejects(session.relay.dispatch('recovery-question'), { code: 'OUTCOME_UNKNOWN' });
        const turn = await session.relay.reconcile('recovery-question');
        assert.equal(turn.reconciled_outcome, 'failed');
        assert.equal(calls.length, 3);
        assert.ok(calls.every((call) => call.provider === provider && call.conversationId === recipient.conversation_id));
    });
}

test('explicit recovery probes override adapter probes', async (t) => {
    const calls = [];
    const { host } = await fixture(t, {
        adapters: Object.fromEntries(['codex', 'agy'].map((provider) => [provider, {
            ...fakeAdapter(provider, async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true })),
            probeRecovery() { assert.fail('explicit probes must win'); },
        }])),
        recoveryProbes: {
            isProcessQuiescent: (args) => { calls.push(args); return true; },
            isProviderTerminal: () => true,
            providerOutcome: () => 'succeeded',
        },
    });
    const session = await host.sessionResolver(context);
    await question(session);
    await assert.rejects(session.relay.dispatch('question-1'), { code: 'OUTCOME_UNKNOWN' });
    assert.equal((await session.relay.reconcile('question-1')).reconciled_outcome, 'succeeded');
    assert.equal(calls[0].binding.provider, 'agy');
});

async function isolatedFixture(t, overrides = {}) {
    const workerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-child-worker-'));
    t.after(() => fs.rm(workerRoot, { recursive: true, force: true }));
    let authorized = true;
    const calls = [];
    const executionOptions = {
        seeds: Object.fromEntries(['codex', 'agy'].map((provider) => [provider, async (args) => {
            calls.push({ provider, ...args });
            return { conversationId: `child-${provider}-${calls.length}` };
        }])),
        adapters: { codex: fakeAdapter('codex'), agy: fakeAdapter('agy') },
        preflight: { run: async (_root, { workerModel }) => ({
            status: 'PASSED', to_state: 'CAPABILITY_SAFE', checks: preflightChecks(),
            details: { agy_version: '1.2.3', agy_model: workerModel,
                agy_evidence: { version: '1.2.3', model: workerModel } },
        }), codexProbe: async () => true },
        ...overrides,
    };
    const { host, stateDir } = await fixture(t, {
        createExecutionOptions: async (captured) => ({ ...executionOptions,
            trustedExecutionContext: { workerRoot: captured.workerRoot,
                spawnImpl: () => assert.fail('offline child spawned'), env: { GIT_CEILING_DIRECTORIES: path.dirname(captured.workerRoot) } } }),
    });
    const execution = { workerModel: 'gemini-3.8-flash-high', workerEffort: 'high', workerRoot, sessionId, taskId: context.taskId, planRevision: 1,
        attempt: 1, leaseId, operationId: 'child-operation-1', workerBaselineId: 'b'.repeat(64),
        workerContractSha256: 'c'.repeat(64), reference: { workerRoot,
            bindingSha256: 'd'.repeat(64), workerContractSha256: 'c'.repeat(64) },
        authorize: () => authorized, guards: { check: async () => {} } };
    const request = { taskId: context.taskId, workspaceRoot: workerRoot, snapshotSha256: execution.workerBaselineId };
    return { host, stateDir, execution, request, calls, revoke() { authorized = false; } };
}

test('isolated child has its own bindings, journal, authority reader and idempotent close', async (t) => {
    const { host, stateDir, execution, request, calls } = await isolatedFixture(t);
    const shared = await host.sessionResolver(context);
    const child = await host.createIsolatedDiscussion(execution);
    assert.equal(child.executionKey, sha256Utf8(JSON.stringify(['isolated', sessionId, context.taskId,
        1, execution.workerRoot, 1, execution.reference.bindingSha256, execution.workerBaselineId,
        execution.operationId])));
    const [session, same] = await Promise.all([child.sessionResolver(request), child.sessionResolver(request)]);
    assert.equal(session, same);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.cwd === execution.workerRoot));
    assert.deepEqual(session.bindings[0].execution, { attempt: 1, workspace_binding_sha256: execution.reference.bindingSha256 });
    assert.notEqual(session.bindings[0].snapshot_sha256, execution.workerBaselineId);
    assert.equal((await host.authorityReader({ bindings: shared.bindings })).expectedSnapshotSha256, shared.bindings[0].snapshot_sha256);
    assert.equal((await child.authorityReader({ bindings: shared.bindings })).expectedSnapshotSha256, '');
    await question(session);
    assert.equal((await session.relay.dispatch('question-1')).provider, 'succeeded');
    const manifest = JSON.parse(await fs.readFile(path.join(stateDir, 'isolated', child.executionKey + '.manifest.json')));
    assert.equal(manifest.worker_root, execution.workerRoot);
    assert.equal(manifest.discussion_snapshot_sha256, session.bindings[0].snapshot_sha256);
    assert.equal(child.close(), child.close());
    await child.close();
    await host.closeAll();
    await host.closeAll();
});

test('isolated resolver rejects missing or foreign roots and baseline before seed', async (t) => {
    const { host, execution, request, calls } = await isolatedFixture(t);
    const child = await host.createIsolatedDiscussion(execution);
    for (const changed of [{ workspaceRoot: undefined }, { workspaceRoot: process.cwd() }, { snapshotSha256: 'x' }]) {
        await assert.rejects(child.sessionResolver({ ...request, ...changed }), { code: 'DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID' });
    }
    assert.equal(calls.length, 0);
    await assert.rejects(host.sessionResolver({ ...context, workspaceRoot: execution.workerRoot }),
        { code: 'DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID' });
});

test('revocation between isolated seeds prevents the second seed', async (t) => {
    let fixtureState;
    const state = await isolatedFixture(t, { seeds: {
        codex: async () => { fixtureState.revoke(); return { conversationId: 'partial-codex' }; },
        agy: async () => assert.fail('revoked child reached second seed'),
    } });
    fixtureState = state;
    const child = await state.host.createIsolatedDiscussion(state.execution);
    await assert.rejects(child.sessionResolver(state.request), { code: 'DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID' });
    const failure = JSON.parse(await fs.readFile(path.join(state.stateDir, 'isolated', child.executionKey + '.seed-failure.json')));
    assert.equal(failure.conversation_ids.codex, 'partial-codex');
    await child.close();
    await state.host.closeAll();
});

test('different isolated roots produce separate identities and a slow stale seed cannot publish', async (t) => {
    let unblock;
    const gate = new Promise((resolve) => { unblock = resolve; });
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    let count = 0;
    const state = await isolatedFixture(t, { seeds: {
        codex: async () => { const n = ++count; if (n === 1) { entered(); await gate; } return { conversationId: `slow-${n}` }; },
        agy: async () => ({ conversationId: 'new-agy' }),
    } });
    const old = await state.host.createIsolatedDiscussion(state.execution);
    const pending = old.sessionResolver(state.request);
    const observed = assert.rejects(pending, { code: 'DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID' });
    await started;
    const newRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-child-second-'));
    t.after(() => fs.rm(newRoot, { recursive: true, force: true }));
    const execution = { ...state.execution, workerRoot: newRoot,
        reference: { ...state.execution.reference, workerRoot: newRoot }, operationId: 'child-operation-2' };
    const currentPending = state.host.createIsolatedDiscussion(execution);
    unblock();
    const current = await currentPending;
    assert.notEqual(old.executionKey, current.executionKey);
    const session = await current.sessionResolver({ ...state.request, workspaceRoot: newRoot });
    unblock();
    await observed;
    assert.equal((await old.authorityReader({ bindings: session.bindings })).expectedSnapshotSha256, '');
    assert.equal((await current.authorityReader({ bindings: session.bindings })).expectedSnapshotSha256, session.bindings[0].snapshot_sha256);
    await old.close();
    await current.close();
});

test('closeAll aborts a child pending seed and concurrent close remains safe', async (t) => {
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    let capturedSignal;
    const state = await isolatedFixture(t);
    const pendingHost = createDiscussionHost({ enabled: true, stateDir: state.stateDir,
        daemon: { sessionId, workspaceRoot: process.cwd(), getPlanRevision: () => 1, readLeaseEvents: async () => events() },
        createExecutionOptions: async ({ signal, workerRoot }) => {
            capturedSignal = signal;
            return { trustedExecutionContext: { workerRoot, spawnImpl: () => assert.fail('offline seed spawned'), env: { GIT_CEILING_DIRECTORIES: path.dirname(workerRoot) } }, adapters: {}, seeds: {
                codex: async () => { entered(); await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })); return { conversationId: 'aborted-seed' }; },
                agy: async () => assert.fail('closing child seeded again'),
            } };
        },
    });
    const child = await pendingHost.createIsolatedDiscussion(state.execution);
    const pending = assert.rejects(child.sessionResolver(state.request));
    await started;
    await Promise.all([pendingHost.closeAll(), child.close()]);
    await pending;
    assert.equal(capturedSignal.aborted, true);
    await pendingHost.closeAll();
});

test('child ports bind the exact lease and authorize closure rather than any active lease', async () => {
    const binding = { session_id: sessionId, task_id: 'TASK-1', plan_revision: 1,
        snapshot_sha256: 'e'.repeat(64) };
    const authority = async () => ({ leaseEvents: events(), sessionId,
        expectedPlanRevision: 1, expectedSnapshotSha256: binding.snapshot_sha256 });
    let authorized = true;
    let preflightCalls = 0;
    const deps = createDaemonHostDeps({ authority, leaseId, authorize: () => authorized,
        preflight: { run: () => { preflightCalls++; assert.fail('revoked operation probed'); } } });
    assert.equal(await deps.checkAuthority({ binding }), true);
    assert.equal(await createDaemonHostDeps({ authority, authorize: () => true,
        leaseId: '20000000-0000-4000-8000-000000000099' }).checkAuthority({ binding }), false);
    authorized = false;
    assert.equal(await deps.checkAuthority({ binding }), false);
    assert.equal((await deps.verifyCapability({ binding })).allowed, false);
    assert.equal(preflightCalls, 0);
});

test('a failed child close blocks every later generation until recovery', async (t) => {
    let seedCalls = 0;
    const state = await isolatedFixture(t);
    const cleanupError = Object.assign(new Error('child process still active'), { code: 'DUAL_OPERATION_CHILDREN_ACTIVE', discussionQuiescent: false });
    const host = createDiscussionHost({ enabled: true, stateDir: state.stateDir,
        daemon: { sessionId, workspaceRoot: process.cwd(), getPlanRevision: () => 1, readLeaseEvents: async () => events() },
        createExecutionOptions: async ({ workerRoot }) => ({
            trustedExecutionContext: { workerRoot, spawnImpl: () => assert.fail('unexpected spawn'),
                env: { GIT_CEILING_DIRECTORIES: path.dirname(workerRoot) } },
            assertQuiescent() { throw cleanupError; },
            seeds: { codex: async () => { seedCalls++; return { conversationId: 'never-seeded' }; } },
        }),
    });
    await host.createIsolatedDiscussion(state.execution);
    const concurrent = await Promise.allSettled(['generation-B', 'generation-C'].map((operationId) =>
        host.createIsolatedDiscussion({ ...state.execution, operationId })));
    assert.ok(concurrent.every((result) => result.status === 'rejected' && result.reason === cleanupError));
    for (const operationId of ['generation-2', 'generation-3']) {
        await assert.rejects(host.createIsolatedDiscussion({ ...state.execution, operationId }), (error) => error === cleanupError);
    }
    await assert.rejects(host.closeAll(), (error) => error === cleanupError);
    assert.equal(seedCalls, 0);
});

test('closeAll prevents new isolated factories before any seed', async (t) => {
    const state = await isolatedFixture(t);
    await state.host.closeAll();
    await assert.rejects(state.host.createIsolatedDiscussion(state.execution), { code: 'DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID' });
    assert.equal(state.calls.length, 0);
});

async function writeExecutionMarker(stateDir, key, marker, { young = false, manifest = false } = {}) {
    const directory = path.join(stateDir, 'isolated');
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, key + '.execution.json');
    await fs.writeFile(file, JSON.stringify(marker));
    if (!young) {
        const old = new Date(Date.now() - 6 * 60_000);
        await fs.utimes(file, old, old);
    }
    if (manifest) await fs.writeFile(path.join(directory, key + '.manifest.json'), 'audit manifest');
    return file;
}

for (const marker of [{ status: 'seeding', pid: 2147483647 }, {}]) {
    test(`isolated resolver reclaims old dead orphan (${marker.status ?? 'legacy'}) and completes marker`, async (t) => {
        const state = await isolatedFixture(t);
        const child = await state.host.createIsolatedDiscussion(state.execution);
        const file = await writeExecutionMarker(state.stateDir, child.executionKey, marker);
        await child.sessionResolver(state.request);
        const completed = JSON.parse(await fs.readFile(file, 'utf8'));
        assert.equal(completed.status, 'complete');
        assert.equal(completed.pid, process.pid);
        assert.ok(Number.isFinite(Date.parse(completed.createdAt)));
        assert.equal(completed.operation_id, state.execution.operationId);
        assert.equal(state.calls.length, 2);
    });
}

for (const [name, marker, options] of [
    ['complete', { status: 'complete' }, {}],
    ['manifest sibling', { status: 'seeding' }, { manifest: true }],
    ['legacy manifest sibling', {}, { manifest: true }],
    ['live pid', { status: 'seeding', pid: process.pid }, {}],
    ['young marker', { status: 'seeding' }, { young: true }],
]) {
    test(`isolated resolver preserves ${name} and rejects reseeding`, async (t) => {
        const state = await isolatedFixture(t);
        const child = await state.host.createIsolatedDiscussion(state.execution);
        const file = await writeExecutionMarker(state.stateDir, child.executionKey, marker, options);
        const before = await fs.readFile(file, 'utf8');
        await assert.rejects(child.sessionResolver(state.request), {
            code: 'DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID',
            message: 'Isolated generation already exists; recovery is required before reseeding',
        });
        assert.equal(await fs.readFile(file, 'utf8'), before);
        assert.equal(state.calls.length, 0);
    });
}

test('host creation GC removes only old dead orphan markers and retains audit evidence', async (t) => {
    const { stateDir } = await fixture(t);
    const fixtures = [
        ['orphan', { status: 'seeding', pid: 2147483647 }, {}, false],
        ['legacy-orphan', {}, {}, false],
        ['complete', { status: 'complete' }, {}, true],
        ['manifest', { status: 'seeding' }, { manifest: true }, true],
        ['legacy-manifest', {}, { manifest: true }, true],
        ['alive', { status: 'seeding', pid: process.pid }, {}, true],
        ['young', { status: 'seeding' }, { young: true }, true],
        ['unknown', { status: 'unknown' }, {}, true],
    ];
    for (const [key, marker, options] of fixtures) await writeExecutionMarker(stateDir, key, marker, options);
    const journal = path.join(stateDir, 'isolated', 'orphan', 'journal.jsonl');
    await fs.mkdir(path.dirname(journal), { recursive: true });
    await fs.writeFile(journal, 'audit journal');
    const host = createDiscussionHost({ stateDir });
    await host.closeAll();
    for (const [key, , , retained] of fixtures) {
        const file = path.join(stateDir, 'isolated', key + '.execution.json');
        if (retained) assert.ok(await fs.stat(file));
        else await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    }
    assert.equal(await fs.readFile(journal, 'utf8'), 'audit journal');
    for (const key of ['manifest', 'legacy-manifest']) {
        assert.equal(await fs.readFile(path.join(stateDir, 'isolated', key + '.manifest.json'), 'utf8'), 'audit manifest');
    }
});

test('isolated marker records the creating process while seeding before publishing complete', async (t) => {
    let markerPath;
    const observed = [];
    const state = await isolatedFixture(t, { seeds: Object.fromEntries(['codex', 'agy'].map((provider) =>
        [provider, async () => {
            observed.push(JSON.parse(await fs.readFile(markerPath, 'utf8')));
            return { conversationId: `lifecycle-${provider}` };
        }])) });
    const child = await state.host.createIsolatedDiscussion(state.execution);
    markerPath = path.join(state.stateDir, 'isolated', child.executionKey + '.execution.json');
    await child.sessionResolver(state.request);
    assert.equal(observed.length, 2);
    for (const marker of observed) {
        assert.equal(marker.status, 'seeding');
        assert.equal(marker.pid, process.pid);
        assert.ok(Number.isFinite(Date.parse(marker.createdAt)));
    }
    const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
    assert.deepEqual(marker, { ...observed[0], status: 'complete' });
    assert.ok(await fs.stat(markerPath.replace('.execution.json', '.manifest.json')));
});

test('isolated session preserves task profile for seeds and bindings outside controller root', async (t) => {
    const state = await isolatedFixture(t);
    const child = await state.host.createIsolatedDiscussion({ ...state.execution,
        workerModel: 'task-specific-model', workerEffort: 'low' });
    const session = await child.sessionResolver(state.request);
    assert.equal(session.bindings[1].model, 'task-specific-model');
    assert.equal(session.bindings[1].effort, 'low');
    assert.equal(state.calls[1].model, 'task-specific-model');
    assert.equal(state.calls[1].effort, 'low');
    assert.equal(state.calls[1].cwd, state.execution.workerRoot);
    await child.close();
});
