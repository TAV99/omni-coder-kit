'use strict';

const { withDiscussion } = require('./helpers/dual-discussion-stub');

function createOrchestratorAdapter(options) {
    return createOrchestratorAdapterImpl(withDiscussion(options));
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
const { writeInitialSnapshot } = require('../lib/dual/snapshot-store');
const { createOrchestratorAdapter: createOrchestratorAdapterImpl } = require('../lib/dual/orchestrator-adapter');
const { hashAcceptancePolicy } = require('../lib/dual/acceptance-policy');
const { startDaemonServer } = require('../lib/dual/daemon-server');
const { createDaemonClient } = require('../lib/dual/daemon-client');

async function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-reject-transport-')));
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Return three.\n');
    const dir = path.join(root, '.omni/runs/dual-authority');
    const store = createAuthorityStore(dir);
    const snapshot = createConfiguredSnapshotBaseline({ root }).baseline.capture();
    const command = { program: 'node', args: ['--check', 'index.js'], cwd: '.' };
    const policy = { protocol_version: 1, checks: [
        { id: 'syntax', requirement_id: 'R1', task_id: 'TASK-1', phase: 'pre_integration', kind: 'command', required: true, command },
        { id: 'review', requirement_id: 'R2', phase: 'session', kind: 'review', required: true },
    ] };
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'workspace-test', session_id: 'session-1', plan_revision: 1, expected_baseline: snapshot.identity, mode: 'auto' });
    writeInitialSnapshot({ authorityDir: dir, sessionId: 'session-1', workspaceId: 'workspace-test', workspaceRoot: root,
        identity: snapshot.identity, manifest: snapshot.manifest });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE', status: 'PASSED',
        checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }], details: { agy_version: '1.1.27-test', agy_model: 'gemini-3.8-flash-high' } });
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED', plan_path: 'spec.md',
        plan_sha256: 'b'.repeat(64), total_tasks: 1, acceptance_policy: policy, acceptance_policy_sha256: hashAcceptancePolicy(policy),
        tasks: [{ task_id: 'TASK-1', title: 'Return three', goal: 'Return three', owner: 'agy', risk: 'low', execution_mode: 'isolated',
            allowed_files: ['index.js'], context_files: ['spec.md'], deny_patterns: [], validation_commands: [command] }] });
    store.append({ schema_version: 2, type: 'task.routed', task_id: 'TASK-1', owner: 'agy', authority_state: 'ROUTED',
        allowed_files: ['index.js'], model: 'gemini-3.8-flash-high', effort: 'high', reason: 'Private task' });
    const processRunner = async (invocation) => {
        const run = path.join(invocation.cwd, '.omni/codex-gemini/runs/TASK-1');
        const spec = JSON.parse(fs.readFileSync(path.join(run, 'spec.json'), 'utf8'));
        const common = { schema_version: 1, task_id: 'TASK-1', expected_baseline: spec.expected_baseline };
        const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
        let payload;
        if (prompt.includes('scout phase')) payload = { ...common, summary: 'Read source',
            relevant_files: [{ path: 'index.js', description: 'value' }], exact_symbols: [], validation_commands: ['node --check index.js'],
            constraints: ['scope only'], risks: [], open_questions: [],
            research_trace: ['index.js', 'spec.md'].map((source) => ({ question: 'Required value?', source, source_type: 'REPOSITORY', conclusion: 'Three' })),
            alternatives_considered: [{ option: 'Edit source', tradeoff: 'small' }, { option: 'New file', tradeoff: 'unnecessary' }], failure_modes: ['wrong value'] };
        else if (prompt.includes('implement phase')) {
            fs.writeFileSync(path.join(invocation.cwd, 'index.js'), 'module.exports = 2;\n');
            payload = { ...common, status: 'SUCCESS', modified_files: ['index.js'], command_outputs: [{ command: 'node --check index.js', exit_code: 0, output: '' }],
                unverified_items: [], self_review: { checks: ['scope', 'syntax', 'value'], remaining_risks: [] } };
        } else payload = { ...common, recommendation: 'APPROVE', risk_level: 'LOW', findings: [], review_checks: ['scope', 'syntax', 'value'], challenge_summary: 'Compared values.' };
        return { exitCode: 0, stdout: JSON.stringify({ status: 'success', structured_output: payload }), stderr: '', timedOut: false,
            startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
    };
    const adapter = createOrchestratorAdapter({ workspaceRoot: root, authorityStore: store, processRunner });
    assert.equal((await adapter.runTask(store.derive()))[0].status, 'AWAITING_CODEX_QC');
    const task = store.derive().tasks['TASK-1'];
    const input = { session_id: 'session-1', task_id: 'TASK-1', plan_revision: 1, expected_attempt: 1, request_id: 'reject-1',
        expected_handoff_sha256: task.isolatedHandoff.handoff_sha256, expected_result_sha256: task.isolatedHandoff.result_sha256,
        findings: [{ id: 'F1', file: 'index.js', line: 1, requirement_id: 'R1', description: 'Expected three, received two.' }] };
    const daemon = await startDaemonServer({ workspaceRoot: root, authorityStore: store });
    t.after(async () => { await daemon.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { root, store, input, client: createDaemonClient({ workspaceRoot: root }) };
}

function cli(root, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.resolve(__dirname, '../bin/omni.js'), 'dual', ...args],
            { cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', (data) => { stdout += data; });
        child.stderr.on('data', (data) => { stderr += data; });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
}

async function mcp(t, root, createClient) {
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');
    const server = createOmniDualMcpServer({ workspaceRoot: root, ...(createClient ? { createClient } : {}) });
    const client = new Client({ name: 'reject-test', version: '1' }, { capabilities: {} });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    t.after(async () => { await client.close(); await server.close(); });
    return client;
}

function ack(reused = false) { return { acknowledged: true, reused, task_id: 'TASK-1', attempt: 1, status: 'NEEDS_FIX' }; }

test('authenticated rejection RPC uses strict untrusted params, exact lineage and bounded negative acknowledgement', async (t) => {
    const f = await fixture(t), count = f.store.readEvents().length;
    for (const change of [{ workspaceRoot: f.root }, { authorityStore: {} }, { status: 'PASS' }, { validators: [] }, { allowed_files: ['spec.md'] },
        { task_id: 'other' }, { session_id: undefined }, { code: 'PASS' }, { pid: 123 },
        { expected_attempt: 2 }, { expected_result_sha256: 'f'.repeat(64) }, { expected_handoff_sha256: 'f'.repeat(64) },
        { plan_revision: 2 }, { session_id: 'other' }, { findings: [{ ...f.input.findings[0], file: 'spec.md' }] }]) {
        await assert.rejects(f.client.request('task.reject_handoff', { ...f.input, ...change }),
            (error) => /^DUAL_/.test(error.code) && error.code !== 'DUAL_METHOD_NOT_FOUND');
        assert.equal(f.store.readEvents().length, count);
    }
    const discovery = f.client.readDiscovery();
    const unauthorized = await new Promise((resolve, reject) => {
        const body = JSON.stringify({ protocol_version: 1, workspace_id: discovery.workspace_id, method: 'task.reject_handoff', params: f.input });
        const req = require('node:http').request({ host: '127.0.0.1', port: discovery.port, method: 'POST', path: '/rpc',
            headers: { Authorization: 'Bearer invalid', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
            let raw = ''; res.on('data', (chunk) => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        });
        req.once('error', reject); req.end(body);
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.body.error.code, 'DUAL_UNAUTHORIZED');
    assert.equal(typeof f.client.rejectTaskHandoff, 'function');
    assert.deepEqual(await f.client.rejectTaskHandoff(f.input), ack());
    assert.deepEqual(await f.client.rejectTaskHandoff(f.input), ack(true));
    assert.equal(f.store.readEvents().length, count + 1);
    await assert.rejects(f.client.rejectTaskHandoff({ ...f.input, findings: [{ ...f.input.findings[0], description: 'Changed' }] }),
        (error) => error.code === 'DUAL_HANDOFF_REJECTION_CONFLICT');
    assert.equal(fs.readFileSync(path.join(f.root, 'index.js'), 'utf8'), 'module.exports = 1;\n');
});

test('workflow rejects independent semantic review FAIL before correction and documents the event downgrade boundary', async () => {
    const text = fs.readFileSync(path.join(__dirname, '../templates/workflows/dual-controller.md'), 'utf8');
    assert.match(text, /independent semantic review/i);
    assert.match(text, /FAIL[^\n]*omni_dual_reject_handoff/);
    assert.match(text, /PASS[^\n]*normal isolated QC/);
    assert.match(text, /task\.handoff\.rejected/);
    assert.match(text, /downgrade[^\n]*fail closed/i);
    const { RejectHandoffInputSchema } = await import('../lib/dual/mcp-server.mjs');
    const example = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].map((match) => JSON.parse(match[1])).find((value) => value.expected_handoff_sha256);
    assert.ok(example, 'Workflow must include exact rejection submission');
    assert.equal(RejectHandoffInputSchema.safeParse(example).success, true);
});

test('CLI status gives exhausted rejection attempt a blocking action instead of impossible correction', () => {
    const { normalizeAuthorityTaskStatus } = require('../lib/commands/dual');
    const result = normalizeAuthorityTaskStatus({ state: 'EXECUTING', tasks: { 'TASK-1': {
        owner: 'agy', state: 'ROUTED', execution_mode: 'isolated',
        handoffRejection: { attempt: 3, findings: [] }, lastOutcome: { status: 'NEEDS_FIX', attempt: 3 },
    } } }, 'TASK-1');
    assert.equal(result.nextAction, 'block_exhausted_attempts');
});

test('CLI and MCP share durable rejection semantics and expose findings plus correction action', async (t) => {
    const f = await fixture(t), count = f.store.readEvents().length;
    const submission = path.join(f.root, 'reject.json');
    fs.writeFileSync(submission, JSON.stringify(f.input));
    const result = await cli(f.root, ['reject-handoff', '--submission', submission, '--json']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ack());
    const client = await mcp(t, f.root);
    const response = await client.callTool({ name: 'omni_dual_reject_handoff', arguments: { workspace_root: f.root, ...f.input } });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    assert.deepEqual(JSON.parse(response.content[0].text), ack(true));
    assert.equal(f.store.readEvents().length, count + 1);
    const status = await client.callTool({ name: 'omni_dual_status', arguments: { workspace_root: f.root, session_id: f.input.session_id } });
    const task = JSON.parse(status.content[0].text).tasks['TASK-1'];
    assert.equal(task.last_outcome.status, 'NEEDS_FIX');
    assert.deepEqual(task.controller_findings, f.input.findings);
    assert.equal(task.next_action, 'request_correction');
    const rendered = await cli(f.root, ['status', 'TASK-1']);
    assert.match(rendered.stdout, /NEEDS_FIX/);
    assert.match(rendered.stdout, /Expected three, received two/);
    assert.match(rendered.stdout, /correction/);
    const beforeQc = f.store.readEvents().length;
    await assert.rejects(f.client.completeIsolatedTask('session-1', 'TASK-1', 1),
        (error) => error.code === 'DUAL_CONTROLLER_REVIEW_REJECTED');
    assert.equal(f.store.readEvents().length, beforeQc);
    fs.writeFileSync(submission, JSON.stringify({ ...f.input, authorityStore: {} }));
    assert.equal((await cli(f.root, ['reject-handoff', '--submission', submission, '--json'])).code, 1);
    fs.writeFileSync(submission, ' '.repeat(64 * 1024 + 1));
    assert.equal((await cli(f.root, ['reject-handoff', '--submission', submission, '--json'])).code, 1);
    assert.equal(f.store.readEvents().length, count + 1);
    const correction = await f.client.correctTask('session-1', { task_id: 'TASK-1', plan_revision: 1,
        request_id: 'fix-1', expected_attempt: 1, reason: 'Return three as registered.' });
    assert.equal(correction.acknowledged, true);
    assert.equal(correction.attempt, 2);
    fs.writeFileSync(submission, JSON.stringify(f.input));
    const oldReplay = await cli(f.root, ['reject-handoff', '--submission', submission, '--json']);
    assert.equal(oldReplay.code, 0, oldReplay.stdout + oldReplay.stderr);
    assert.deepEqual(JSON.parse(oldReplay.stdout), ack(true));
    assert.equal(f.store.derive().tasks['TASK-1'].correction.attempt, 2);
    assert.equal(f.store.readEvents().length, count + 2);
});

test('MCP rejects dependency spoofing before client creation and refuses forged or overbroad acknowledgements', async (t) => {
    const f = await fixture(t);
    let calls = 0, result = ack();
    const client = await mcp(t, f.root, () => { calls++; return {
        health: async () => ({ status: 'healthy', session_id: 'session-1', workspace_root: f.root }),
        rejectTaskHandoff: async () => result,
    }; });
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'omni_dual_reject_handoff'));
    for (const extra of [{ authorityStore: {} }, { workspaceRoot: f.root }, { validators: [] }, { status: 'PASS' }]) {
        const response = await client.callTool({ name: 'omni_dual_reject_handoff', arguments: { workspace_root: f.root, ...f.input, ...extra } });
        assert.equal(response.isError, true);
    }
    assert.equal(calls, 0);
    for (const invalid of [{ ...ack(), task_id: 'other' }, { ...ack(), attempt: 2 }, { ...ack(), status: 'PASS' }, { ...ack(), token: 'secret' },
        { ...ack(), acknowledged: false }, { ...ack(), reused: 'yes' }]) {
        result = invalid;
        const response = await client.callTool({ name: 'omni_dual_reject_handoff', arguments: { workspace_root: f.root, ...f.input } });
        assert.equal(response.isError, true);
        assert.doesNotMatch(JSON.stringify(response), /secret/);
    }
});

test('MCP status bounds large durable findings and marks truncation without expanding the rejection acknowledgement', async (t) => {
    const f = await fixture(t);
    const findings = Array.from({ length: 24 }, (_, i) => ({ ...f.input.findings[0], id: `F${i}`, description: 'x'.repeat(2048) }));
    assert.deepEqual(await f.client.rejectTaskHandoff({ ...f.input, findings }), ack());
    const client = await mcp(t, f.root);
    const response = await client.callTool({ name: 'omni_dual_status', arguments: { workspace_root: f.root, session_id: 'session-1' } });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    assert.ok(Buffer.byteLength(JSON.stringify(response), 'utf8') <= 16 * 1024);
    const task = JSON.parse(response.content[0].text).tasks['TASK-1'];
    assert.equal(task.controller_findings.length, 8);
    assert.equal(task.findings_truncated, true);
    assert.ok(task.controller_findings.every((finding) => finding.description.length === 512 && finding.description_truncated));
    assert.deepEqual(f.store.derive().tasks['TASK-1'].handoffRejection.findings, findings);
});
