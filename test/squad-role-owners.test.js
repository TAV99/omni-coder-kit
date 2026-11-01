'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const {
    normalizePlanOwner, normalizeRouteOwner, ownerRole, DualPlanManifestSchema, RouteSchema,
} = require('../lib/dual/contracts');
const { ownerLabel, readDualPlanManifest } = require('../lib/commands/dual');
const { tempDir } = require('./helpers/squad-project');

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const templatePlan = () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'templates', 'workflows', 'task-planning.md'), 'utf8');
    return [...text.matchAll(/```json\s*([\s\S]*?)```/g)].map((m) => JSON.parse(m[1])).find((v) => Array.isArray(v.tasks));
};

test('role names map onto the internal slot ids; legacy ids pass through', () => {
    assert.deepEqual(['worker', 'orchestrator', 'agy', 'codex', 'designer'].map(normalizePlanOwner), ['agy', 'codex', 'agy', 'codex', 'designer']);
    assert.deepEqual(['worker', 'orchestrator', 'agy', 'gemini'].map(normalizeRouteOwner), ['gemini', 'codex', 'gemini', 'gemini']);
    assert.deepEqual(['codex', 'agy', 'gemini', 'root'].map(ownerRole), ['orchestrator', 'worker', 'worker', null]);
    assert.deepEqual([ownerLabel('agy'), ownerLabel('codex'), ownerLabel('root')], ['worker (agy)', 'orchestrator (codex)', 'root']);
});

test('plans may name roles; the parsed manifest carries the slot ids the ledger expects', () => {
    const plan = templatePlan();
    assert.equal(plan.tasks[0].owner, 'worker', 'the shipped template teaches role names');
    assert.equal(DualPlanManifestSchema.parse(plan).tasks[0].owner, 'agy');
    const legacy = { ...plan, tasks: [{ ...plan.tasks[0], owner: 'agy' }] };
    assert.deepEqual(DualPlanManifestSchema.parse(legacy), DualPlanManifestSchema.parse(plan), 'legacy plans parse the same');
    const kept = { ...plan, tasks: [{ ...plan.tasks[0], owner: 'orchestrator' }] };
    assert.equal(DualPlanManifestSchema.parse(kept).tasks[0].owner, 'codex');
    assert.equal(DualPlanManifestSchema.safeParse({ ...plan, tasks: [{ ...plan.tasks[0], owner: 'designer' }] }).success, false);
});

test('bootstrap reads a role-owned plan file and hashes the bytes as written', (t) => {
    const root = tempDir(t, 'squad-owners-');
    const file = path.join(root, '.omni', 'sdlc', 'dual-plan.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = JSON.stringify(templatePlan(), null, 2);
    fs.writeFileSync(file, bytes);
    const read = readDualPlanManifest(root);
    assert.equal(read.manifest.tasks[0].owner, 'agy');
    assert.equal(read.sha256, require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
});

test('routes may name the worker role', () => {
    const route = {
        schema_version: 1, task_id: 'T-1', expected_baseline: { kind: 'snapshot', id: 'a'.repeat(64) },
        owner: 'worker', model: 'gemini-3.8-flash-high', effort: 'high', token_budget: 1000, allowed_files: ['a.js'], reason: 'Bounded',
    };
    assert.equal(RouteSchema.parse(route).owner, 'gemini');
    assert.equal(RouteSchema.parse({ ...route, owner: 'orchestrator' }).owner, 'codex');
    assert.equal(RouteSchema.safeParse({ ...route, owner: 'reviewer' }).success, false);
});

async function connect(t, fakeClient) {
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');
    const server = createOmniDualMcpServer({ workspaceRoot: process.cwd(), createClient: () => fakeClient });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => { await client.close(); await server.close(); });
    return client;
}

test('MCP register_plan advertises role names and forwards slot ids to the daemon', async (t) => {
    const calls = [];
    const client = await connect(t, {
        async health() { return { status: 'healthy', workspace_root: process.cwd(), session_id: SESSION_ID }; },
        async request(method, params) {
            calls.push(params);
            return { session_id: SESSION_ID, state: 'PLANNED', plan_revision: 1, total_tasks: 2, registered: true };
        },
    });
    const { tools } = await client.listTools();
    const owner = tools.find((tool) => tool.name === 'omni_dual_register_plan').inputSchema.properties.tasks.items.properties.owner;
    assert.deepEqual(owner.enum, ['orchestrator', 'worker', 'codex', 'agy']);
    const task = (id, taskOwner) => ({ task_id: id, title: id, owner: taskOwner, allowed_files: ['index.html'], deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }] });
    const result = await client.callTool({ name: 'omni_dual_register_plan', arguments: { workspace_root: process.cwd(), session_id: SESSION_ID,
        plan_revision: 1, plan_path: 'plans/plan.md', plan_sha256: 'a'.repeat(64), tasks: [task('T-1', 'worker'), task('T-2', 'orchestrator')] } });
    assert.notEqual(result.isError, true);
    assert.deepEqual(calls[0].tasks.map((entry) => entry.owner), ['agy', 'codex']);
});

test('MCP status shows the role beside the slot id, and still refuses role names from the daemon', async (t) => {
    let owner = 'agy';
    const client = await connect(t, {
        async health() { return { status: 'healthy', workspace_root: process.cwd(), session_id: 'sess-roles' }; },
        async status() {
            return { session_id: 'sess-roles', workspace_id: 'ws-1', workspace_root: process.cwd(), state: 'EXECUTING', plan_revision: 1,
                current_baseline: { kind: 'git', id: 'a'.repeat(40) }, gates: {}, blocked: false,
                tasks: { 'T-1': { task_id: 'T-1', state: 'ROUTED', owner, title: 'T', allowed_files: ['a.js'] } } };
        },
    });
    const args = { workspace_root: process.cwd(), session_id: 'sess-roles' };
    const ok = await client.callTool({ name: 'omni_dual_status', arguments: args });
    assert.equal(ok.isError, undefined);
    assert.deepEqual([ok.structuredContent.tasks['T-1'].owner, ok.structuredContent.tasks['T-1'].owner_role], ['agy', 'worker']);
    owner = 'worker';
    const strict = await client.callTool({ name: 'omni_dual_status', arguments: args });
    assert.equal(strict.isError, true, 'the daemon speaks slot ids only');
});
