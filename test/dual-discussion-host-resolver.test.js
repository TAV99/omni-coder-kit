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

test('daemon wiring uses strict env opt-in and converts validated store events to authority envelopes', async () => {
    const vm = require('node:vm');
    const { createRequire } = require('node:module');
    const serverPath = require.resolve('../lib/dual/daemon-server');
    const source = await fs.readFile(serverPath, 'utf8');
    const localRequire = createRequire(serverPath);
    for (const flag of [undefined, '', '0', 'true', '01', '1']) {
        const history = events();
        let revision = 1;
        let hostOptions;
        let adapterOptions;
        const sentinel = new Error('adapter construction reached');
        const module = { exports: {} };
        const wrapped = vm.runInNewContext('(function(require, module, exports) {\n' + source + '\n})', {
            process: { env: { OMNI_DUAL_DISCUSSION_ENABLED: flag }, cwd: () => process.cwd() },
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
        if (flag !== '1') {
            assert.equal(hostOptions, undefined);
            assert.equal(Object.hasOwn(adapterOptions, 'discussion'), false);
            continue;
        }
        assert.equal(adapterOptions.discussion.enabled, true);
        assert.equal(adapterOptions.discussion.sessionResolver, resolver);
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
