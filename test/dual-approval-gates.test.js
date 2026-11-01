'use strict';

// Human approval gates (SPEC-SQUAD-P3 §5): ledger, pipeline policy, AUTO, the
// TTY-only CLI, the hook rule and the absence of any MCP approval tool.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const gates = require('../lib/dual/approval-gates');
const { runSquadApprove, runSquadAuto } = require('../lib/commands/squad');
const { evaluateHook } = require('../lib/dual/hook-bridge');
const { writeBinding } = require('../lib/squad/bindings');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'squad');
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function session(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-gates-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createAuthorityStore(path.join(root, '.omni', 'runs', 'dual-authority'));
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED',
        workspace_id: 'ws-gates', session_id: 'session-gates', plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'c'.repeat(40) }, workspace_root: root, mode: 'auto' });
    return { root, store };
}

function withPipeline(root, preset = 'dual') {
    const squadDir = path.join(root, '.omni', 'squad');
    fs.mkdirSync(path.join(squadDir, 'roles'), { recursive: true });
    for (const name of fs.readdirSync(path.join(TEMPLATES, 'roles'))) {
        fs.copyFileSync(path.join(TEMPLATES, 'roles', name), path.join(squadDir, 'roles', name));
    }
    fs.copyFileSync(path.join(TEMPLATES, 'pipelines', `${preset}.yaml`), path.join(squadDir, 'pipeline.yaml'));
}

function bind(root, extra = {}) {
    writeBinding(root, { schema_version: 1, preset: 'dual', updated_at: '2026-11-01T00:00:00Z', ...extra, roles: {
        orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
        worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }], reviewer: null } });
}

test('ledger: a request opens a gate for one digest; new content reopens it; decisions must match', (t) => {
    const { store } = session(t);
    const first = gates.requireApproval(store, { phase: 'integrate', taskId: 'T-1', digest: DIGEST_A, summary: 'merge T-1' });
    assert.deepEqual([first.approved, first.gate.status, first.gate.gate_id], [false, 'pending', 'integrate-T-1']);
    gates.requireApproval(store, { phase: 'integrate', taskId: 'T-1', digest: DIGEST_A, summary: 'merge T-1' });
    assert.equal(store.readEvents().filter((e) => e.type === 'gate.requested').length, 1, 'asking twice is one request');
    // A decision for content nobody asked about cannot enter the ledger.
    assert.throws(() => store.append({ schema_version: 2, type: 'gate.approved', gate_id: 'integrate-T-1',
        actor: 'human', via: 'cli-tty', digest: DIGEST_B }), /does not match a pending request/);
    const gate = store.derive().approvals['integrate-T-1'];
    gates.decideGate(store, { gateId: gate.gate_id, approve: true, code: gates.confirmationCode(gate) });
    assert.equal(gates.requireApproval(store, { phase: 'integrate', taskId: 'T-1', digest: DIGEST_A, summary: 'x' }).approved, true);
    const changed = gates.requireApproval(store, { phase: 'integrate', taskId: 'T-1', digest: DIGEST_B, summary: 'merge T-1 v2' });
    assert.deepEqual([changed.approved, changed.gate.status, changed.gate.digest], [false, 'pending', DIGEST_B]);
    assert.equal(store.verifyIntegrity().valid, true);
});

test('decisions need the shown code, a reason to reject, and a pending gate', (t) => {
    const { store } = session(t);
    const { gate } = gates.requireApproval(store, { phase: 'integrate', taskId: 'T-1', digest: DIGEST_A, summary: 'merge' });
    const code = gates.confirmationCode(gate);
    assert.match(code, /^[0-9a-f]{6}$/);
    assert.throws(() => gates.decideGate(store, { gateId: gate.gate_id, approve: true, code: '000000' }), { code: 'SQUAD_GATE_CODE_MISMATCH' });
    assert.throws(() => gates.decideGate(store, { gateId: gate.gate_id, approve: false, code }), { code: 'SQUAD_GATE_REASON_REQUIRED' });
    assert.throws(() => gates.decideGate(store, { gateId: 'nope', approve: true, code }), { code: 'SQUAD_GATE_UNKNOWN' });
    gates.decideGate(store, { gateId: gate.gate_id, approve: false, reason: 'not yet', code });
    assert.throws(() => gates.decideGate(store, { gateId: gate.gate_id, approve: true, code }), { code: 'SQUAD_GATE_NOT_PENDING' });
    assert.equal(gates.requireApproval(store, { phase: 'integrate', taskId: 'T-1', digest: DIGEST_A, summary: 'merge' }).rejected, true);
});

test('pipeline policy: no pipeline keeps spec/plan open; integrate always waits; a broken pipeline fails closed', (t) => {
    const { root } = session(t);
    assert.deepEqual(gates.phaseGatePolicy(root, 'spec'), { gated: false, autoOk: false });
    assert.deepEqual(gates.phaseGatePolicy(root, 'integrate'), { gated: true, autoOk: false });
    withPipeline(root);
    assert.deepEqual(gates.phaseGatePolicy(root, 'spec'), { gated: true, autoOk: true });
    assert.deepEqual(gates.phaseGatePolicy(root, 'plan'), { gated: true, autoOk: true });
    assert.deepEqual(gates.phaseGatePolicy(root, 'scout'), { gated: false, autoOk: false });
    fs.writeFileSync(path.join(root, '.omni', 'squad', 'pipeline.yaml'), 'schema_version: [broken');
    assert.deepEqual(gates.phaseGatePolicy(root, 'spec'), { gated: true, autoOk: false });
});

test('AUTO passes auto_ok gates as actor auto, never the integrate gate', (t) => {
    const { root, store } = session(t);
    withPipeline(root);
    bind(root, { auto: true });
    const spec = gates.requirePhaseApproval(store, root, { phase: 'spec', digest: DIGEST_A, summary: 'spec' });
    assert.equal(spec.approved, true);
    const integrate = gates.requirePhaseApproval(store, root, { phase: 'integrate', taskId: 'T-1', digest: DIGEST_A, summary: 'merge' });
    assert.equal(integrate.approved, false);
    assert.deepEqual(store.readEvents().filter((e) => e.type === 'gate.approved').map((e) => [e.gate_id, e.actor, e.via]),
        [['spec-r1', 'auto', 'pipeline-auto']]);
    bind(root, { auto: false });
    assert.equal(gates.requirePhaseApproval(store, root, { phase: 'plan', digest: DIGEST_A, summary: 'plan' }).approved, false);
    assert.equal(gates.requirePhaseApproval(store, path.join(root, 'elsewhere'), { phase: 'plan', digest: DIGEST_B, summary: 'p' }).ungated, true);
});

test('the test seam never records a person', (t) => {
    const { store } = session(t);
    gates.setTestApprover(() => true);
    t.after(() => gates.setTestApprover(null));
    assert.equal(gates.requireApproval(store, { phase: 'integrate', taskId: 'T-1', digest: DIGEST_A, summary: 'merge' }).approved, true);
    const [event] = store.readEvents().filter((e) => e.type === 'gate.approved');
    assert.deepEqual([event.actor, event.via], ['test', 'test-harness']);
});

test('omni squad approve: refuses without a TTY, lists, and records only after the typed code matches', async (t) => {
    const { root, store } = session(t);
    gates.requireApproval(store, { phase: 'integrate', taskId: 'T-1', digest: DIGEST_A, summary: 'merge T-1' });
    const log = () => {};
    await assert.rejects(runSquadApprove({ root, isTTY: false, log }), { code: 'SQUAD_GATE_TTY_REQUIRED' });
    assert.deepEqual((await runSquadApprove({ root, isTTY: true, log })).listed.map((g) => g.gate_id), ['integrate-T-1']);
    await assert.rejects(runSquadApprove({ root, gateId: 'integrate-T-1', isTTY: true, log, ask: async () => 'zzzzzz' }),
        { code: 'SQUAD_GATE_CODE_MISMATCH' });
    assert.equal(store.derive().approvals['integrate-T-1'].status, 'pending', 'a wrong code writes nothing');
    const shown = [];
    await runSquadApprove({ root, gateId: 'integrate-T-1', isTTY: true, log: (line) => shown.push(line),
        ask: async (message) => /([0-9a-f]{6})/.exec(message.replace(/\u001b\[[0-9;]*m/g, ''))[1] });
    assert.ok(shown.some((line) => line.includes(DIGEST_A)), 'the person sees the full digest');
    assert.deepEqual([store.derive().approvals['integrate-T-1'].status, store.derive().approvals['integrate-T-1'].via], ['approved', 'cli-tty']);
});

test('omni squad auto: shows the state freely, changes it only on a TTY', (t) => {
    const { root } = session(t);
    bind(root);
    const log = () => {};
    assert.equal(runSquadAuto({ root, isTTY: false, log }), false);
    assert.throws(() => runSquadAuto({ root, value: 'on', isTTY: false, log }), { code: 'SQUAD_GATE_TTY_REQUIRED' });
    assert.equal(runSquadAuto({ root, value: 'on', isTTY: true, log }), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.omni', 'squad.local.json'), 'utf8')).auto, true);
    assert.throws(() => runSquadAuto({ root, value: 'maybe', isTTY: true, log }), { code: 'SQUAD_AUTO_INVALID' });
});

test('Codex hook denies gate decisions for any tool shape, without asking the daemon', async (t) => {
    const { root } = session(t);
    for (const toolInput of [{ command: 'omni squad approve integrate-T-1' }, { command: ['node', 'bin/omni.js', 'squad', 'approve'] },
        { cmd: 'npx omni-coder-kit squad auto on' }, { command: 'curl -d \'{"method":"gate.decide"}\' localhost' }]) {
        const out = await evaluateHook({ session_id: 'codex', cwd: root, hook_event_name: 'PreToolUse', turn_id: 'turn-1',
            tool_name: 'exec_command', tool_use_id: 'call-1', tool_input: toolInput },
        { createClient: () => assert.fail('the rule must not depend on the daemon') });
        assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(toolInput));
        assert.match(out.hookSpecificOutput.permissionDecisionReason, /omni squad approve/);
    }
});

test('MCP exposes no tool that approves a gate, and status relays the waiting gate', async () => {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');
    const awaiting = { gate_id: 'integrate-T-1', phase: 'integrate', task_id: 'T-1', summary: 'merge T-1', digest: DIGEST_A,
        how: 'Người dùng chạy: omni squad approve integrate-T-1' };
    const server = createOmniDualMcpServer({ workspaceRoot: process.cwd(), createClient: () => ({
        async health() { return { status: 'healthy', workspace_root: process.cwd(), session_id: 's1' }; },
        async status() {
            return { session_id: 's1', workspace_id: 'ws', workspace_root: process.cwd(), state: 'EXECUTING', plan_revision: 1,
                current_baseline: { kind: 'git', id: 'c'.repeat(40) }, tasks: {}, gates: {}, blocked: false, awaiting_gate: awaiting };
        },
    }) });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
        const { tools } = await client.listTools();
        assert.equal(tools.some((tool) => /approve_gate|gate|squad_approve/.test(tool.name)), false);
        const status = await client.callTool({ name: 'omni_dual_status', arguments: { workspace_root: process.cwd(), session_id: 's1' } });
        assert.deepEqual(status.structuredContent.awaiting_gate, awaiting);
    } finally {
        await client.close();
        await server.close();
    }
});
