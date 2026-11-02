'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { computeWorkspaceId } = require('../lib/dual/daemon-lock');
const { confirmationCode, requireApproval, decideGate, pendingGates } = require('../lib/dual/approval-gates');
const { runSquadApprove } = require('../lib/commands/squad');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const quiet = () => {};
const typedCode = async (message) => {
    const code = /\b[0-9a-f]{6}\b/.exec(message.replace(/\u001b\[[0-9;]*m/g, ''));
    assert.ok(code, 'the prompt must show the code');
    return code[0];
};

function fixture(t, count = 3) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-approve-all-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createAuthorityStore(path.join(root, '.omni/runs/dual-authority'));
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED',
        workspace_id: computeWorkspaceId(root), session_id: 'session-batch', plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'c'.repeat(40) }, workspace_root: root, mode: 'auto' });
    for (let index = 0; index < count; index++) {
        const taskId = `T-${String(index + 1).padStart(2, '0')}`;
        requireApproval(store, { phase: 'integrate', taskId, digest: digest(taskId), summary: `Merge ${taskId}` });
    }
    return { root, store };
}

function backend(store, overrides = {}) {
    return { approvals: async () => store.derive().approvals,
        decide: async ({ gate_id: gateId, approve, code, reason }) => ({ gate: decideGate(store, { gateId, approve, code, reason }) }),
        ...overrides };
}

const decisions = (store) => store.readEvents().filter((event) => ['gate.approved', 'gate.rejected'].includes(event.type));

function registerLargePlan(store) {
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE', status: 'PASSED', checks: [{ name: 'hooks', status: 'PASSED' }] });
    const tasks = Array.from({ length: 100 }, (_, index) => ({ task_id: `large-${index}`,
        title: `Task ${index}`, goal: 'g'.repeat(1024), owner: 'agy', allowed_files: [`lib/${index}.js`] }));
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING',
        to_state: 'PLANNED', plan_path: 'plans/plan.md', plan_sha256: digest('large-plan'),
        total_tasks: tasks.length, tasks });
}

test('approvals projection stays small without weakening the full-status response cap or session checks', async (t) => {
    const { root, store } = fixture(t);
    registerLargePlan(store);
    const { startDaemonServer } = require('../lib/dual/daemon-server');
    const { createDaemonClient } = require('../lib/dual/daemon-client');
    const daemon = await startDaemonServer({ workspaceRoot: root, authorityStore: store });
    try {
        const client = createDaemonClient({ workspaceRoot: root });
        const before = store.readEvents().length;
        const projected = await client.status({ session_id: 'session-batch', projection: 'approvals' });
        assert.deepEqual(projected, { session_id: 'session-batch', approvals: store.derive().approvals });
        await assert.rejects(client.status('session-batch'), { code: 'DUAL_CLIENT_RESPONSE_TOO_LARGE' });
        await assert.rejects(client.status({ projection: 'approvals' }), { code: 'DUAL_SESSION_REQUIRED' });
        await assert.rejects(client.status({ session_id: 'other', projection: 'approvals' }), { code: 'DUAL_SESSION_MISMATCH' });
        assert.equal(store.readEvents().length, before, 'status reads must not append events');
    } finally { await daemon.close(); }
});

test('--all approves through the daemon when unrelated task history exceeds 64 KiB', async (t) => {
    const { root, store } = fixture(t);
    registerLargePlan(store);
    const { startDaemonServer } = require('../lib/dual/daemon-server');
    const daemon = await startDaemonServer({ workspaceRoot: root, authorityStore: store });
    try {
        let prompts = 0;
        const result = await runSquadApprove({ root, all: true, isTTY: true, log: quiet,
            ask: async (message) => { prompts++; return typedCode(message); } });
        assert.equal(prompts, 1);
        assert.equal(result.gates.length, 3);
        assert.equal(decisions(store).length, 3);
        assert.ok(decisions(store).every(event => event.actor === 'human' && event.via === 'cli-tty'));
    } finally { await daemon.close(); }
});

test('batch code is deterministic, includes gate identity, and leaves single-gate codes unchanged', () => {
    const a = { gate_id: 'integrate-A', digest: digest('a') };
    const b = { gate_id: 'integrate-B', digest: digest('b') };
    assert.equal(confirmationCode([a, b]), digest([`${a.gate_id}:${a.digest}`, `${b.gate_id}:${b.digest}`].sort().join(',')).slice(0, 6));
    assert.equal(confirmationCode([b, a]), confirmationCode([a, b]));
    assert.notEqual(confirmationCode([a, b]), confirmationCode([a]));
    assert.notEqual(confirmationCode([a]), confirmationCode([{ ...a, gate_id: 'integrate-OTHER' }]));
    assert.notEqual(confirmationCode([a]), confirmationCode([{ ...a, digest: digest('changed') }]));
    assert.equal(confirmationCode(a), digest(`${a.gate_id}:${a.digest}`).slice(0, 6));
});

test('--all requires a TTY before reading or prompting', async () => {
    await assert.rejects(runSquadApprove({ all: true, isTTY: false, log: quiet,
        backend: { approvals: () => assert.fail('must not read'), decide: () => assert.fail('must not write') },
        ask: () => assert.fail('must not prompt') }), { code: 'SQUAD_GATE_TTY_REQUIRED' });
});

test('--all conflicts with a gateId before backend access', async () => {
    await assert.rejects(runSquadApprove({ all: true, gateId: 'integrate-A', isTTY: true, log: quiet,
        backend: { approvals: () => assert.fail('must not read') } }), { code: 'SQUAD_GATE_ARGUMENT_CONFLICT' });
});

test('--all with no pending gates neither prompts nor writes', async (t) => {
    const { root, store } = fixture(t, 0);
    const result = await runSquadApprove({ root, all: true, isTTY: true, log: quiet,
        ask: () => assert.fail('empty set must not prompt') });
    assert.deepEqual(result.listed, []);
    assert.equal(decisions(store).length, 0);
});

test('--all shows every gate and prompts once, writing one human event per gate', async (t) => {
    const { root, store } = fixture(t, 12);
    const shown = [];
    let prompts = 0;
    const initial = pendingGates(store.derive());
    const result = await runSquadApprove({ root, all: true, isTTY: true, log: (line) => shown.push(line),
        ask: async (message) => { prompts++; return typedCode(message); } });
    assert.equal(prompts, 1);
    assert.equal(result.gates.length, 12);
    for (const gate of initial) {
        assert.ok(shown.some((line) => line.includes(gate.gate_id) && line.includes(gate.phase) && line.includes(gate.task_id)));
        assert.ok(shown.some((line) => line.includes(gate.summary)));
        assert.ok(shown.some((line) => line.includes(gate.digest.slice(0, 16))));
    }
    assert.deepEqual(decisions(store).map(({ gate_id, actor, via, type }) => ({ gate_id, actor, via, type })),
        initial.map(({ gate_id }) => ({ gate_id, actor: 'human', via: 'cli-tty', type: 'gate.approved' })));
    assert.equal(pendingGates(store.derive()).length, 0);
    assert.equal(store.verifyIntegrity().valid, true);
});

for (const typed of ['wrong-code', undefined, '']) {
    test(`--all rejects a wrong or cancelled confirmation: ${String(typed)}`, async (t) => {
        const { root, store } = fixture(t);
        await assert.rejects(runSquadApprove({ root, all: true, isTTY: true, log: quiet, ask: async () => typed }),
            { code: 'SQUAD_GATE_CODE_MISMATCH' });
        assert.equal(decisions(store).length, 0);
    });
}

for (const change of ['added', 'removed', 'digest', 'identity', 'summary', 'request', 'phase', 'task', 'revision']) {
    test(`--all refuses a pending set ${change} during confirmation before any write`, async (t) => {
        const { root, store } = fixture(t);
        const original = store.derive().approvals;
        let approvals = original;
        const fake = backend(store, { approvals: async () => approvals });
        await assert.rejects(runSquadApprove({ root, all: true, isTTY: true, log: quiet, backend: fake,
            ask: async (message) => {
                approvals = structuredClone(original);
                const id = Object.keys(approvals)[0];
                if (change === 'added') approvals.new = { ...approvals[id], gate_id: 'integrate-new', digest: digest('new') };
                if (change === 'removed') delete approvals[id];
                if (change === 'digest') approvals[id].digest = digest('changed');
                if (change === 'identity') approvals[id].gate_id = 'integrate-renamed';
                if (change === 'summary') approvals[id].summary = 'Different content shown';
                if (change === 'request') approvals[id].requested_at = '2099-01-01T00:00:00.000Z';
                if (change === 'phase') approvals[id].phase = 'plan';
                if (change === 'task') approvals[id].task_id = 'T-other';
                if (change === 'revision') approvals[id].plan_revision = 99;
                return typedCode(message);
            } }), { code: 'SQUAD_GATE_SET_CHANGED' });
        assert.equal(decisions(store).length, 0);
    });
}

test('--all accepts reordering and excludes already decided gates', async (t) => {
    const { root, store } = fixture(t);
    const first = pendingGates(store.derive())[0];
    decideGate(store, { gateId: first.gate_id, approve: true, code: confirmationCode(first) });
    let reads = 0;
    const sent = [];
    const delegate = backend(store);
    const fake = backend(store, { approvals: async () => {
        const entries = Object.entries(store.derive().approvals);
        return Object.fromEntries(++reads % 2 ? entries : entries.reverse());
    }, decide: async (decision) => { sent.push(decision); return delegate.decide(decision); } });
    const result = await runSquadApprove({ root, all: true, isTTY: true, backend: fake, log: quiet, ask: typedCode });
    assert.equal(reads, 2);
    assert.equal(result.gates.length, 2);
    assert.equal(sent.length, 2);
    assert.ok(sent.every((decision) => decision.gate_id !== first.gate_id));
    for (const decision of sent) assert.equal(decision.code, confirmationCode(store.derive().approvals[decision.gate_id]));
});

test('--all --reject requires a reason before prompting and records a trimmed reason per gate', async (t) => {
    const { root, store } = fixture(t);
    for (const reason of [undefined, '', '   ']) {
        await assert.rejects(runSquadApprove({ root, all: true, reject: true, reason, isTTY: true, log: quiet,
            ask: () => assert.fail('must reject before prompting') }), { code: 'SQUAD_GATE_REASON_REQUIRED' });
    }
    await runSquadApprove({ root, all: true, reject: true, reason: '  Needs changes  ', isTTY: true, log: quiet, ask: typedCode });
    assert.deepEqual(decisions(store).map((event) => [event.type, event.actor, event.via, event.reason]),
        Array.from({ length: 3 }, () => ['gate.rejected', 'human', 'cli-tty', 'Needs changes']));
});

for (const [responseLost, inspectionFails] of [[false, false], [true, false], [true, true]]) {
    test(`--all stops after RPC failure (response lost: ${responseLost}, inspection fails: ${inspectionFails})`, async (t) => {
        const { root, store } = fixture(t);
        const initial = pendingGates(store.derive());
        const delegate = backend(store);
        let calls = 0;
        let reads = 0;
        const fake = backend(store, { approvals: async () => {
            if (++reads > 2 && inspectionFails) throw new Error('Status unavailable');
            return store.derive().approvals;
        }, decide: async (decision) => {
            calls++;
            if (calls === 2) {
                if (responseLost) await delegate.decide(decision);
                throw Object.assign(new Error('Connection lost'), { code: 'DUAL_CLIENT_CONNECTION_RESET' });
            }
            return delegate.decide(decision);
        } });
        await assert.rejects(runSquadApprove({ root, all: true, isTTY: true, log: quiet, ask: typedCode, backend: fake }), (error) => {
            assert.equal(error.code, 'SQUAD_GATE_BATCH_FAILED');
            assert.equal(error.cause.code, 'DUAL_CLIENT_CONNECTION_RESET');
            const confirmed = responseLost && !inspectionFails;
            assert.deepEqual(error.decidedGateIds, initial.slice(0, confirmed ? 2 : 1).map((gate) => gate.gate_id));
            assert.equal(error.uncertainGateId, confirmed ? null : initial[1].gate_id);
            assert.deepEqual(error.remainingGateIds, [initial[2].gate_id]);
            assert.match(error.message, /integrate-T-01/);
            return true;
        });
        assert.equal(calls, 2, 'never retry or start a third decision');
        assert.equal(decisions(store).length, responseLost ? 2 : 1);
        assert.equal(store.derive().approvals[initial[2].gate_id].status, 'pending');
    });
}

test('--all writes nothing when the confirmation recheck cannot read the daemon', async (t) => {
    const { root, store } = fixture(t);
    let reads = 0;
    await assert.rejects(runSquadApprove({ root, all: true, isTTY: true, log: quiet, ask: typedCode,
        backend: backend(store, { approvals: async () => {
            if (++reads === 2) throw Object.assign(new Error('Status unavailable'), { code: 'DUAL_CLIENT_TIMEOUT' });
            return store.derive().approvals;
        } }) }), { code: 'DUAL_CLIENT_TIMEOUT' });
    assert.equal(decisions(store).length, 0);
});

test('--all uses one real gate.decide RPC per gate while the daemon is running', async (t) => {
    const { root, store } = fixture(t);
    const { startDaemonServer } = require('../lib/dual/daemon-server');
    const clientModule = require('../lib/dual/daemon-client');
    const createClient = clientModule.createDaemonClient;
    const calls = [];
    t.mock.method(clientModule, 'createDaemonClient', (options) => {
        const client = createClient(options);
        const request = client.request;
        client.request = (method, params) => { calls.push({ method, params }); return request(method, params); };
        return client;
    });
    const daemon = await startDaemonServer({ workspaceRoot: root, authorityStore: store });
    try {
        const result = await runSquadApprove({ root, all: true, isTTY: true, log: quiet, ask: typedCode });
        assert.equal(result.gates.length, 3);
        assert.deepEqual(calls.map(({ method }) => method), ['gate.decide', 'gate.decide', 'gate.decide']);
        for (const { params } of calls) {
            assert.equal(params.session_id, 'session-batch');
            assert.equal(params.approve, true);
            assert.equal(params.code, confirmationCode(store.derive().approvals[params.gate_id]));
        }
        assert.equal(decisions(store).length, 3);
        assert.ok(decisions(store).every((event) => event.actor === 'human' && event.via === 'cli-tty'));
    } finally { await daemon.close(); }
});

test('CLI advertises the --all option', () => {
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/omni.js'), 'squad', 'approve', '--help'],
        { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--all\b/);
});
