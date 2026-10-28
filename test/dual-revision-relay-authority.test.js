'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { revisionDigest, revisionRequestDigest, currentVerifiedVersion } = require('../lib/dual/revision-policy');
const { revisionSourceFingerprint } = require('../lib/dual/task-revision-integration');
const command = source => ({ program: 'node', args: ['-e', source], cwd: '.' });
const { computeEventHash } = require('../lib/dual/authority-store');
const { createDaemonHostDeps } = require('../lib/dual/discussion/daemon-ports');
const { buildBindings } = require('../lib/dual/discussion/session');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-controller-flow-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 1;\n');
    const store = createAuthorityStore(path.join(root, '.omni/runs/dual-authority'));
    store.append({ type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'workspace', session_id: 'session', plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) }, mode: 'auto' });
    store.append({ type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE', status: 'PASSED',
        checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }], details: { agy_model: 'test-model', agy_version: '1.1.27' } });
    const oldCommand = command("require('node:assert/strict').equal(typeof require('./app.js'), 'number')");
    const acceptanceCommand = command("require('node:assert/strict').ok(require('./app.js') > 0)");
    const newCommand = command("require('node:assert/strict').equal(require('./app.js'), 2)");
    const policy = { protocol_version: 1, checks: [{ id: 'old-session', requirement_id: 'old-req', phase: 'session',
        kind: 'command', required: true, command: acceptanceCommand }] };
    const planTask = { task_id: 'task', title: 'Export number', goal: 'Export number', owner: 'agy', category: 'backend',
        complexity: 'medium', risk: 'low', allowed_files: ['app.js'], context_files: [], deny_patterns: [],
        validation_commands: [oldCommand], decision_ids: [] };
    store.append({ type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED', plan_path: 'plan.json',
        plan_sha256: revisionDigest('plan'), total_tasks: 1, tasks: [planTask], acceptance_policy: policy });
    store.append({ type: 'task.routed', task_id: 'task', owner: 'agy', authority_state: 'ROUTED', model: 'test-model',
        effort: 'high', allowed_files: ['app.js'], reason: 'test' });
    const lease = store.acquireLease('task', 'agy');
    store.append({ type: 'task.completed', task_id: 'task', owner: 'agy', authority_state: 'TASK_VERIFIED',
        modified_files: ['app.js'], diff_fingerprint: revisionDigest('verified-parent'), verdict: 'SUCCESS', verified_by: 'codex' });
    store.releaseLease(lease.lease_id, 'parent completed');
    const parent = store.derive().tasks.task;
    const parentVersion = currentVerifiedVersion(parent);
    const sourceFingerprint = revisionSourceFingerprint(root);
    const candidatePlan = { schema_version: 2, plan_revision: 1,
        coverage: { path: 'coverage.json', sha256: revisionDigest('coverage'), catalog_version: 1 },
        acceptance_policy: policy, tasks: [planTask] };
    const contract = { schema_version: 2, reason: 'Export two', allowed_files: ['app.js'], affected_dimensions: ['content'],
        acceptance_criteria: ['Exports two'], validation_commands: [newCommand], parent_version_id: parentVersion.version_id,
        source_fingerprint: sourceFingerprint, changes: 'files', dependency_contract_changed: false, candidate_plan: candidatePlan };
    const request = { type: 'task.revision.requested', task_id: 'task', revision_id: 'revision', request_id: 'request',
        expected_sequence: store.verifyIntegrity().lastSequence, parent_version_id: parentVersion.version_id,
        source_fingerprint: sourceFingerprint, contract, contract_sha256: revisionDigest(contract) };
    request.approval = { approved_by: 'user', grant_id: 'grant', revision_id: 'revision', parent_version_id: request.parent_version_id,
        contract_sha256: request.contract_sha256, source_fingerprint: sourceFingerprint };
    request.request_sha256 = revisionRequestDigest(request);
    store.append(request);
    store.append({ type: 'task.revision.started', task_id: 'task', revision_id: 'revision', parent_version_id: request.parent_version_id,
        contract_sha256: request.contract_sha256, source_fingerprint: sourceFingerprint, grant_id: 'grant',
        expected_sequence: store.verifyIntegrity().lastSequence });
    const scoped = store.forRevision('task', 'revision');
    const candidateLease = scoped.acquireLease('task', 'agy');
    let previous = '0'.repeat(64);
    const events = store.readEvents().map(event => {
        const envelope = { previous_hash: previous, event_hash: computeEventHash(previous, event), event };
        previous = envelope.event_hash;
        return envelope;
    });
    const snapshot = 'e'.repeat(64);
    const bindings = buildBindings({ sessionId: 'session', taskId: 'task', planRevision: 1,
        snapshotSha256: snapshot, codexConversationId: 'seed-codex', agyConversationId: 'seed-agy',
        models: { agy: 'test-model' }, efforts: { agy: 'high' } });
    const state = { leaseEvents: events, sessionId: 'session', expectedPlanRevision: 1, expectedSnapshotSha256: snapshot };
    const deps = (overrides = {}) => createDaemonHostDeps({ authority: () => state,
        replayAuthority: (records, time) => store.replayDiscussionAuthority(records, time),
        authorize: () => true, leaseId: candidateLease.lease_id, ...overrides });
    return { root, store, scoped, events, bindings, state, deps, candidateLease };
}

test('candidate relay authority accepts verified candidate history', async t => {
    const f = fixture(t);
    assert.equal(f.store.derive().sessionState, 'ACCEPTANCE');
    assert.equal(f.scoped.derive().sessionState, 'EXECUTING');
    assert.equal(await f.deps().checkAuthority({ bindings: f.bindings, stage: 'dispatch' }), true);
});

test('candidate history cannot pass without source evidence verifier', async t => {
    const f = fixture(t);
    assert.equal(await f.deps({ replayAuthority: undefined }).checkAuthority({ bindings: f.bindings }), false);
});

test('candidate source evidence missing or tampered still fails closed', async t => {
    const f = fixture(t);
    const source = f.events.find(e => e.event.type === 'task.revision.requested').event.source_evidence.reference;
    const file = path.join(f.root, '.omni/runs/dual-authority', source);
    fs.writeFileSync(file, '{}');
    assert.equal(await f.deps().checkAuthority({ bindings: f.bindings }), false);
    fs.unlinkSync(file);
    assert.equal(await f.deps().checkAuthority({ bindings: f.bindings }), false);
});

for (const [name, changed, options] of [
    ['session', { session_id: 'foreign' }, {}],
    ['plan', { plan_revision: 2 }, {}],
    ['snapshot', { snapshot_sha256: 'f'.repeat(64) }, {}],
    ['lease', {}, { leaseId: 'foreign' }],
    ['authorize', {}, { authorize: () => false }],
]) {
    test(`candidate authority rejects wrong ${name}`, async t => {
        const f = fixture(t);
        assert.equal(await f.deps(options).checkAuthority({ bindings: [f.bindings[0], { ...f.bindings[1], ...changed }] }), false);
    });
}

test('candidate authority rejects corrupt history and expired candidate lease', async t => {
    const f = fixture(t);
    const corrupt = structuredClone(f.state);
    corrupt.leaseEvents.at(-1).event_hash = 'f'.repeat(64);
    assert.equal(await f.deps({ authority: () => corrupt }).checkAuthority({ bindings: f.bindings }), false);
    assert.equal(await f.deps({ now: () => Date.parse(f.candidateLease.expires_at) + 1 })
        .checkAuthority({ bindings: f.bindings }), false);
});

test('diagnostics identify failed conditions and never expose authority values', async t => {
    const f = fixture(t);
    const entries = [];
    const write = fs.writeSync;
    t.mock.method(fs, 'writeSync', (fd, value, ...rest) => {
        if (fd === 2) { entries.push(JSON.parse(value)); return Buffer.byteLength(value); }
        return write(fd, value, ...rest);
    });
    assert.equal(await f.deps().checkAuthority({ bindings: [{ ...f.bindings[0], snapshot_sha256: 'f'.repeat(64) }] }), false);
    assert.ok(entries.some(e => e.message === 'binding_snapshot_match fail'));
    entries.length = 0;
    assert.equal(await f.deps({ replayAuthority: undefined }).checkAuthority({ bindings: f.bindings }), false);
    assert.deepEqual(entries.map(e => e.message), ['authorize pass', 'revision_source_evidence fail', 'authority_read fail']);
    for (const entry of entries) {
        assert.deepEqual(Object.keys(entry).sort(), ['event', 'message', 'pid', 'timestamp']);
        assert.match(entry.message, /^[a-z_]+ (pass|fail)$/);
    }
});

test('diagnostic stderr failures do not change successful or denied authority', async t => {
    const f = fixture(t);
    const write = fs.writeSync;
    t.mock.method(fs, 'writeSync', (fd, ...args) => {
        if (fd === 2) throw new Error('stderr unavailable');
        return write(fd, ...args);
    });
    assert.equal(await f.deps().checkAuthority({ bindings: f.bindings }), true);
    assert.equal(await f.deps({ authorize: () => false }).checkAuthority({ bindings: f.bindings }), false);
});

test('shared live authority retains checks with the daemon replay port', async t => {
    const f = fixture(t);
    // Before task completion/revision, the original live lease is active.
    const prefix = f.events.slice(0, f.events.findIndex(e => e.event.type === 'task.completed'));
    const liveLease = prefix.find(e => e.event.type === 'lease.acquired').event;
    const live = f.deps({ authority: () => ({ ...f.state, leaseEvents: prefix }), leaseId: liveLease.lease_id,
        now: () => Date.parse(liveLease.acquired_at) + 1 });
    assert.equal(await live.checkAuthority({ bindings: f.bindings }), true);
    assert.equal(await live.checkAuthority({ bindings: [{ ...f.bindings[0], session_id: 'foreign' }] }), false);
    assert.equal(await live.checkAuthority({ bindings: [{ ...f.bindings[0], plan_revision: 2 }] }), false);
    assert.equal(await live.checkAuthority({ bindings: [{ ...f.bindings[0], snapshot_sha256: 'f'.repeat(64) }] }), false);
});

test('isolated host routes candidate scout through verified replay and fences later revocation', async t => {
    const f = fixture(t);
    const { createDiscussionHost } = require('../lib/dual/discussion/host-resolver');
    const { createDiscussionAdapter } = require('../lib/dual/discussion/adapter');
    const { bindingRef } = require('../lib/dual/discussion/contracts');
    const workerRoot = path.join(f.root, 'worker');
    fs.mkdirSync(workerRoot);
    let authorized = true;
    let seedCount = 0;
    let invocationCount = 0;
    const host = createDiscussionHost({ enabled: true, stateDir: path.join(f.root, 'discussion'),
        daemon: { sessionId: 'session', getPlanRevision: () => 1, workspaceRoot: f.root,
            readLeaseEvents: () => f.events,
            replayAuthority: (records, time) => f.store.replayDiscussionAuthority(records, time) },
        createExecutionOptions: async () => ({
            trustedExecutionContext: { workerRoot, spawnImpl: () => assert.fail('offline host spawned'),
                env: { GIT_CEILING_DIRECTORIES: f.root } },
            seeds: Object.fromEntries(['codex', 'agy'].map(provider => [provider, async () => {
                seedCount++;
                return { conversationId: 'seed-' + provider };
            }])),
            adapters: Object.fromEntries(['codex', 'agy'].map(provider => [provider, createDiscussionAdapter({
                id: 'fixture-' + provider, provider, version: '1', mode: 'fake',
                profile: { format: 'json', requireConversationMatch: true, allowlistedTerminalMarkers: ['fixture.completed'] },
                invoke: async ({ binding, invocationId }) => {
                    invocationCount++;
                    return { exitCode: 0, stdout: JSON.stringify({ conversationId: binding.conversation_id, invocationId }), stderr: '' };
                },
                classify: raw => ({ completion: 'succeeded', payload: { schema_version: 1, kind: 'reply', body: 'Answer' },
                    observedConversationId: JSON.parse(raw.stdout).conversationId,
                    observedInvocationId: JSON.parse(raw.stdout).invocationId, terminalMarker: 'fixture.completed',
                    evidenceRef: 'fixture', hasTerminalError: false }),
            })])),
            preflight: { run: async (_root, { workerModel }) => ({ status: 'PASSED', to_state: 'CAPABILITY_SAFE',
                checks: ['authority_ledger_integrity', 'baseline_backend', 'project_configuration', 'agy_cli_and_model', 'mcp_and_hook_setup']
                    .map(name => ({ name, status: 'PASSED' })),
                details: { agy_version: '1.2.3', agy_model: workerModel, agy_evidence: { version: '1.2.3', model: workerModel } },
            }), codexProbe: async () => true },
        }),
    });
    t.after(() => host.closeAll());
    const child = await host.createIsolatedDiscussion({ workerRoot, sessionId: 'session', planRevision: 1, taskId: 'task',
        attempt: 1, leaseId: f.candidateLease.lease_id, operationId: 'operation', workerModel: 'test-model', workerEffort: 'high',
        workerBaselineId: 'b'.repeat(64), workerContractSha256: 'c'.repeat(64),
        reference: { workerRoot, bindingSha256: 'd'.repeat(64), workerContractSha256: 'c'.repeat(64) },
        authorize: () => authorized && f.scoped.derive().sessionState === 'EXECUTING' });
    const session = await child.sessionResolver({ taskId: 'task', workspaceRoot: workerRoot, snapshotSha256: 'b'.repeat(64) });
    assert.equal(seedCount, 2);
    const now = Date.now();
    await session.relay.receive({ schema_version: 1, message_id: 'scout', kind: 'question', body: 'Scout?', sequence: 1,
        sender_ref: bindingRef(session.bindings[0]), recipient_ref: bindingRef(session.bindings[1]), created_at: now, expires_at: now + 300000 });
    assert.equal((await session.relay.dispatch('scout')).provider, 'succeeded');
    assert.equal(invocationCount, 1);
    authorized = false;
    const view = await session.relay.inspect();
    await session.relay.receive({ schema_version: 1, message_id: 'later', kind: 'question', body: 'Later?', sequence: view.messages.length + 1,
        sender_ref: bindingRef(session.bindings[0]), recipient_ref: bindingRef(session.bindings[1]), created_at: now, expires_at: now + 300000 });
    await assert.rejects(session.relay.dispatch('later'), { code: 'AUTHORITY_STALE' });
    assert.equal(invocationCount, 1);
    await child.close();
});
