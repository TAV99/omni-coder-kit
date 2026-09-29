'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

function createTempWorkspace(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-flow-mcp-'));
    const canonical = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
    t.after(() => fs.rmSync(canonical, { recursive: true, force: true }));
    return canonical;
}

function qualityEvidence(cycleIndex = 1) {
    const fingerprint = 'a'.repeat(64);
    return {
        cycle_index: cycleIndex,
        attempt: 1,
        total_tasks: 1,
        completed_task_ids: ['TASK-1'],
        plan_revision: 1,
        diff_fingerprint: fingerprint,
        gate_results: [{ id: 'unit-tests', required: true, status: 'PASSED' }],
        commands: [{ command: 'npm test', exit_code: 0, duration_ms: 10 }],
        evidence_sha256: 'b'.repeat(64),
        provenance: {
            execution_id: 'c'.repeat(64),
            input_fingerprint: fingerprint,
            mode: 'fresh',
        },
    };
}

async function connectMcp(t, workspaceRoot, fakeClient) {
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');
    const server = createOmniDualMcpServer({ workspaceRoot, createClient: () => fakeClient });
    const client = new Client({ name: 'dual-flow-mcp-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    t.after(async () => {
        await client.close();
        await server.close();
    });
    return client;
}

function createFakeClient(workspaceRoot, overrides = {}) {
    const calls = { health: 0, quality: [], completion: [], isolatedQc: [] };
    const client = {
        async health() {
            calls.health += 1;
            return { status: 'healthy', workspace_root: workspaceRoot, session_id: SESSION_ID };
        },
        async executeQualityCycle(sessionId, cycleIndex) {
            calls.quality.push({ sessionId, cycleIndex });
            return { quality_evidence: qualityEvidence(cycleIndex) };
        },
        async evaluateCompletion(sessionId, evidence) {
            calls.completion.push({ sessionId, evidence });
            return { verified: false, session_state: 'EXECUTING', blockers: [] };
        },
        async completeIsolatedTask(sessionId, taskId, planRevision) {
            calls.isolatedQc.push({ sessionId, taskId, planRevision });
            return {
                session_id: sessionId,
                verified: false,
                session_state: 'EXECUTING',
                status: 'TASK_VERIFIED',
            };
        },
    };
    return { calls, client: Object.assign(client, overrides) };
}

test('MCP registers strict omni_dual_quality input and rejects invalid cycles before daemon calls', async (t) => {
    const workspaceRoot = createTempWorkspace(t);
    const { calls, client: fakeClient } = createFakeClient(workspaceRoot);
    const client = await connectMcp(t, workspaceRoot, fakeClient);

    const tools = await client.listTools();
    const qualityTool = tools.tools.find((tool) => tool.name === 'omni_dual_quality');
    assert.ok(qualityTool, 'quality checkpoint tool must be registered');
    assert.equal(qualityTool.inputSchema.additionalProperties, false);
    assert.deepEqual(Object.keys(qualityTool.inputSchema.properties).sort(),
        ['cycle_index', 'session_id', 'workspace_root']);
    assert.deepEqual([...qualityTool.inputSchema.required].sort(),
        ['cycle_index', 'session_id', 'workspace_root']);

    const base = { workspace_root: workspaceRoot, session_id: SESSION_ID };
    for (const args of [
        base,
        { ...base, cycle_index: 0 },
        { ...base, cycle_index: 4 },
        { ...base, cycle_index: 1.5 },
        { ...base, cycle_index: 1, unrecognized: true },
    ]) {
        const result = await client.callTool({ name: 'omni_dual_quality', arguments: args });
        assert.equal(result.isError, true);
    }
    assert.equal(calls.health, 0, 'strict input failures must precede daemon health checks');
    assert.equal(calls.quality.length, 0, 'invalid input must not execute a quality cycle');
});

test('omni_dual_quality binds the healthy workspace/session and delegates exactly once', async (t) => {
    const workspaceRoot = createTempWorkspace(t);
    const { calls, client: fakeClient } = createFakeClient(workspaceRoot);
    const client = await connectMcp(t, workspaceRoot, fakeClient);

    const result = await client.callTool({
        name: 'omni_dual_quality',
        arguments: { workspace_root: workspaceRoot, session_id: SESSION_ID, cycle_index: 2 },
    });
    assert.equal(result.isError, undefined);
    assert.equal(calls.health, 1);
    assert.deepEqual(calls.quality, [{ sessionId: SESSION_ID, cycleIndex: 2 }]);
    assert.equal(result.structuredContent.session_id, SESSION_ID);
    assert.deepEqual(result.structuredContent.quality_evidence, qualityEvidence(2));
});

test('omni_dual_quality rejects malformed, wrong-cycle, and oversized daemon evidence without leaking payloads', async (t) => {
    const workspaceRoot = createTempWorkspace(t);
    let response = { quality_evidence: null };
    const { calls, client: fakeClient } = createFakeClient(workspaceRoot, {
        async executeQualityCycle(sessionId, cycleIndex) {
            calls.quality.push({ sessionId, cycleIndex });
            return response;
        },
    });
    const client = await connectMcp(t, workspaceRoot, fakeClient);
    const args = { workspace_root: workspaceRoot, session_id: SESSION_ID, cycle_index: 2 };

    const malformedResponses = [
        null,
        {},
        { quality_evidence: qualityEvidence(1) },
        { quality_evidence: { ...qualityEvidence(2), unexpected: 'SECRET_DAEMON_PAYLOAD' } },
        { quality_evidence: { ...qualityEvidence(2), commands: [{ command: 'npm test', exit_code: 0, duration_ms: -1 }] } },
    ];
    for (response of malformedResponses) {
        const result = await client.callTool({ name: 'omni_dual_quality', arguments: args });
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent?.error?.code, 'DUAL_MCP_INVALID_DAEMON_RESPONSE');
        assert.doesNotMatch(JSON.stringify(result), /SECRET_DAEMON_PAYLOAD/);
    }
    assert.equal(calls.quality.length, malformedResponses.length, 'each valid request delegates once without retries');

    const oversized = qualityEvidence(2);
    oversized.gate_results = Array.from({ length: 100 }, (_, index) => ({
        id: `gate-${index}`,
        required: true,
        status: 'PASSED',
        reason: 'x'.repeat(256),
    }));
    response = { quality_evidence: oversized };
    const tooLarge = await client.callTool({ name: 'omni_dual_quality', arguments: args });
    assert.equal(tooLarge.isError, true);
    assert.equal(tooLarge.structuredContent.error.code, 'DUAL_MCP_RESPONSE_TOO_LARGE');
    assert.ok(Buffer.byteLength(JSON.stringify(tooLarge), 'utf8') < 16 * 1024);
});

test('omni_dual_completion rejects schema-valid caller quality_evidence before daemon access', async (t) => {
    const workspaceRoot = createTempWorkspace(t);
    const { calls, client: fakeClient } = createFakeClient(workspaceRoot);
    const client = await connectMcp(t, workspaceRoot, fakeClient);

    const result = await client.callTool({
        name: 'omni_dual_completion',
        arguments: {
            workspace_root: workspaceRoot,
            session_id: SESSION_ID,
            quality_evidence: qualityEvidence(1),
        },
    });
    assert.equal(result.isError, true);
    assert.equal(calls.health, 0);
    assert.equal(calls.completion.length, 0);
});

test('isolated QC exposes bounded NEEDS_REVIEW IDs and rejects unknown statuses or malformed IDs', async (t) => {
    const workspaceRoot = createTempWorkspace(t);
    let isolatedResponse = {
        session_id: SESSION_ID,
        verified: false,
        session_state: 'EXECUTING',
        status: 'NEEDS_REVIEW',
        missing: ['CHK-1'],
    };
    const { calls, client: fakeClient } = createFakeClient(workspaceRoot, {
        async completeIsolatedTask(sessionId, taskId, planRevision) {
            calls.isolatedQc.push({ sessionId, taskId, planRevision });
            return isolatedResponse;
        },
    });
    const client = await connectMcp(t, workspaceRoot, fakeClient);
    const args = {
        workspace_root: workspaceRoot,
        session_id: SESSION_ID,
        isolated_qc: { task_id: 'TASK-1', plan_revision: 1 },
    };

    const legitimate = await client.callTool({ name: 'omni_dual_completion', arguments: args });
    assert.equal(legitimate.isError, undefined);
    assert.deepEqual(legitimate.structuredContent.isolated_task, {
        task_id: 'TASK-1', status: 'NEEDS_REVIEW', missing: ['CHK-1'],
    });

    isolatedResponse = { ...isolatedResponse, status: 'UNKNOWN_STATE' };
    const unknownStatus = await client.callTool({ name: 'omni_dual_completion', arguments: args });
    assert.equal(unknownStatus.isError, true);
    assert.equal(unknownStatus.structuredContent.error.code, 'DUAL_MCP_INVALID_DAEMON_RESPONSE');

    isolatedResponse = { ...isolatedResponse, status: 'NEEDS_REVIEW', missing: ['invalid check id'] };
    const invalidId = await client.callTool({ name: 'omni_dual_completion', arguments: args });
    assert.equal(invalidId.isError, true);
    assert.equal(invalidId.structuredContent.error.code, 'DUAL_MCP_INVALID_DAEMON_RESPONSE');

    isolatedResponse = { ...isolatedResponse, missing: Array.from({ length: 1025 }, (_, index) => `CHK-${index}`) };
    const excessiveIds = await client.callTool({ name: 'omni_dual_completion', arguments: args });
    assert.equal(excessiveIds.isError, true);
    assert.equal(excessiveIds.structuredContent.error.code, 'DUAL_MCP_INVALID_DAEMON_RESPONSE');

    isolatedResponse = { ...isolatedResponse, missing: Array.from({ length: 30 }, (_, index) => `CHK-${index + 1}`) };
    const bounded = await client.callTool({ name: 'omni_dual_completion', arguments: args });
    assert.equal(bounded.isError, undefined);
    assert.equal(bounded.structuredContent.isolated_task.missing.length, 25);
    assert.equal(bounded.structuredContent.isolated_task.missing_truncated, true);
    assert.equal(bounded.structuredContent.isolated_task.missing_total, 30);
});
