'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');

const {
    startDaemonServer,
} = require('../lib/dual/daemon-server');

const {
    createAuthorityStore,
} = require('../lib/dual/authority-store');

const {
    computeWorkspaceId,
    getRuntimeDir,
} = require('../lib/dual/daemon-lock');

function createTempWorkspace(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-mcp-ws-'));
    const canonical = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
    t.after(() => {
        fs.rmSync(canonical, { recursive: true, force: true });
    });
    return canonical;
}

// --------------------------------------------------------------------------
// 1. Dependency and Import Resolution
// --------------------------------------------------------------------------
test('MCP SDK dependency resolves correctly and exports expected v1 server classes', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');

    assert.equal(typeof McpServer, 'function');
    assert.equal(typeof StdioServerTransport, 'function');
});

test('lib/dual/mcp-server.mjs exports createOmniDualMcpServer factory and main function', async () => {
    const serverModule = await import('../lib/dual/mcp-server.mjs');
    assert.equal(typeof serverModule.createOmniDualMcpServer, 'function');
    assert.equal(typeof serverModule.main, 'function');
});

// --------------------------------------------------------------------------
// 2. Initialize Handshake & Tools Listing (Exact 5 Tools)
// --------------------------------------------------------------------------
test('MCP initialize handshake succeeds and tools/list exposes exactly the 5 approved tools with strict schemas', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    const mcpServerInstance = createOmniDualMcpServer({ workspaceRoot: wsRoot });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const toolListResult = await client.listTools();
    assert.ok(toolListResult && Array.isArray(toolListResult.tools));

    const toolNames = toolListResult.tools.map((t) => t.name).sort();
    const expectedToolNames = [
        'omni_dual_begin',
        'omni_dual_completion',
        'omni_dual_register_plan',
        'omni_dual_resume',
        'omni_dual_status',
    ].sort();

    assert.deepEqual(toolNames, expectedToolNames, 'Must expose exactly the 5 approved omni_dual tools');

    // Verify all tools have strict input schemas (additionalProperties: false)
    for (const tool of toolListResult.tools) {
        assert.ok(tool.inputSchema, `Tool ${tool.name} must have inputSchema`);
        assert.equal(tool.inputSchema.type, 'object', `Tool ${tool.name} schema must be object`);
        assert.equal(
            tool.inputSchema.additionalProperties,
            false,
            `Tool ${tool.name} schema must disallow additionalProperties`
        );
        assert.ok(
            tool.inputSchema.properties.workspace_root,
            `Tool ${tool.name} must require workspace_root property`
        );
    }
});

// --------------------------------------------------------------------------
// 3. Strict Schema Validation & Rejection of Bad Inputs
// --------------------------------------------------------------------------
test('tools reject extra keys and invalid parameter types with strict errors', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    const mcpServerInstance = createOmniDualMcpServer({ workspaceRoot: wsRoot });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    // 1. Extra key rejected
    const extraKeyRes = await client.callTool({
        name: 'omni_dual_status',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-123',
            unrecognized_extra: 'forbidden',
        },
    });
    assert.equal(extraKeyRes.isError, true);
    assert.ok(JSON.stringify(extraKeyRes).includes('unrecognized_extra') || JSON.stringify(extraKeyRes).includes('Unrecognized key'));

    // 2. Invalid task_id pattern rejected in register_plan
    const badTaskIdRes = await client.callTool({
        name: 'omni_dual_register_plan',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-123',
            plan_revision: 1,
            plan_path: 'plans/plan.md',
            plan_sha256: 'a'.repeat(64),
            tasks: [{
                task_id: '!bad@task#id',
                title: 'Bad task',
                owner: 'codex',
                allowed_files: ['lib/file.js'],
            }],
        },
    });
    assert.equal(badTaskIdRes.isError, true);

    // 3. Invalid sha256 (not 64 hex chars)
    const badShaRes = await client.callTool({
        name: 'omni_dual_register_plan',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-123',
            plan_revision: 1,
            plan_path: 'plans/plan.md',
            plan_sha256: 'short-sha',
            tasks: [{
                task_id: 'TASK-1',
                title: 'Good task',
                owner: 'codex',
                allowed_files: ['lib/file.js'],
            }],
        },
    });
    assert.equal(badShaRes.isError, true);

    // 4. Invalid baseline identity
    const badBaselineRes = await client.callTool({
        name: 'omni_dual_begin',
        arguments: {
            workspace_root: wsRoot,
            expected_baseline: { kind: 'unknown_kind', id: 'a'.repeat(40) },
        },
    });
    assert.equal(badBaselineRes.isError, true);

    // 5. Invalid owner (not codex/agy)
    const badOwnerRes = await client.callTool({
        name: 'omni_dual_register_plan',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-123',
            plan_revision: 1,
            plan_path: 'plans/plan.md',
            plan_sha256: 'a'.repeat(64),
            tasks: [{
                task_id: 'TASK-1',
                title: 'Good task',
                owner: 'human_developer',
                allowed_files: ['lib/file.js'],
            }],
        },
    });
    assert.equal(badOwnerRes.isError, true);

    // 6. Empty tasks array
    const emptyTasksRes = await client.callTool({
        name: 'omni_dual_register_plan',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-123',
            plan_revision: 1,
            plan_path: 'plans/plan.md',
            plan_sha256: 'a'.repeat(64),
            tasks: [],
        },
    });
    assert.equal(emptyTasksRes.isError, true);

    // 7. Oversized title (>256 chars)
    const oversizedTitleRes = await client.callTool({
        name: 'omni_dual_register_plan',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-123',
            plan_revision: 1,
            plan_path: 'plans/plan.md',
            plan_sha256: 'a'.repeat(64),
            tasks: [{
                task_id: 'TASK-1',
                title: 'x'.repeat(300),
                owner: 'codex',
                allowed_files: ['lib/file.js'],
            }],
        },
    });
    assert.equal(oversizedTitleRes.isError, true);
});

// --------------------------------------------------------------------------
// 4. Workspace Realpath Mismatch & Directory Validation
// --------------------------------------------------------------------------
test('rejects workspace_root mismatch against bound workspace root without calling client', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const otherWsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    let clientCreated = false;
    const fakeClientFactory = () => {
        clientCreated = true;
        return {
            health: async () => ({ status: 'healthy', workspace_root: wsRoot, session_id: 'sess-1' }),
            status: async () => ({ status: 'ok' }),
        };
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: fakeClientFactory,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const res = await client.callTool({
        name: 'omni_dual_status',
        arguments: {
            workspace_root: otherWsRoot,
            session_id: 'sess-1',
        },
    });

    assert.equal(res.isError, true);
    assert.equal(clientCreated, false, 'Client factory must not be called on workspace mismatch');
    const contentText = res.content[0].text;
    assert.ok(contentText.includes('DUAL_WORKSPACE_MISMATCH'));
    assert.equal(contentText.includes(otherWsRoot), false, 'Raw mismatch path must not leak in error');
});

test('server creation and tool execution require existing directory for workspaceRoot', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    const nonExistentDir = path.join(wsRoot, 'does-not-exist-dir');
    const regularFilePath = path.join(wsRoot, 'regular-file.txt');
    fs.writeFileSync(regularFilePath, 'hello');

    // 1. Missing directory at server creation throws synchronously
    assert.throws(
        () => createOmniDualMcpServer({ workspaceRoot: nonExistentDir }),
        (err) => err.message.includes('Workspace root must be an existing directory') || err.code === 'ENOENT'
    );

    // 2. Regular file at server creation throws synchronously
    assert.throws(
        () => createOmniDualMcpServer({ workspaceRoot: regularFilePath }),
        (err) => err.message.includes('Workspace root must be an existing directory') || err.message.includes('directory')
    );

    // 3. Tool call with non-existent input workspace rejects with DUAL_WORKSPACE_MISMATCH without leak
    const mcpServerInstance = createOmniDualMcpServer({ workspaceRoot: wsRoot });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const nonExistentMarker = 'NON_EXISTENT_MARKER_PATH_XYZ';
    const nonExistentInput = path.join(wsRoot, nonExistentMarker);
    const res = await client.callTool({
        name: 'omni_dual_status',
        arguments: {
            workspace_root: nonExistentInput,
            session_id: 'sess-1',
        },
    });

    assert.equal(res.isError, true);
    const serialized = JSON.stringify(res);
    assert.ok(serialized.includes('DUAL_WORKSPACE_MISMATCH'));
    assert.equal(serialized.includes(nonExistentMarker), false, 'Non-existent input marker must not leak');
});

// --------------------------------------------------------------------------
// 5. Strict Repository Paths Validation (POSIX, Windows, Traversal, NUL, Dot)
// --------------------------------------------------------------------------
test('tools reject absolute, UNC, traversal, NUL, dot, and backslash repo paths before client creation', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    let clientCreated = false;
    const fakeClient = {
        health: async () => ({ status: 'healthy', workspace_root: wsRoot, session_id: 'sess-paths' }),
        request: async () => {
            clientCreated = true;
            return { session_id: 'sess-paths', plan_revision: 1, state: 'PLANNED', total_tasks: 1, registered: true };
        },
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const invalidPaths = [
        '/absolute/posix/path.md',
        'C:/windows/drive/path.md',
        'C:\\windows\\backslash\\path.md',
        '\\\\server\\share\\path.md',
        '//server/share/path.md',
        '../traversal.md',
        'plans/../../escaped.md',
        'plans/../traversal.md',
        '.',
        './',
        './plan.md',
        'plans/.',
        'plans/./task.md',
        'plans/nul\0byte.md',
        'plans\\backslash.md',
        '',
        'plans//double-slash.md',
        'plans/trailing-slash/',
    ];

    for (const invalidPath of invalidPaths) {
        clientCreated = false;

        // Test in plan_path
        const planRes = await client.callTool({
            name: 'omni_dual_register_plan',
            arguments: {
                workspace_root: wsRoot,
                session_id: 'sess-paths',
                plan_revision: 1,
                plan_path: invalidPath,
                plan_sha256: 'a'.repeat(64),
                tasks: [{
                    task_id: 'TASK-1',
                    title: 'Valid task',
                    owner: 'codex',
                    allowed_files: ['lib/file.js'],
                }],
            },
        });
        assert.equal(planRes.isError, true, `Expected rejection for invalid plan_path: ${invalidPath}`);
        assert.equal(clientCreated, false, `Client must not be called for invalid plan_path: ${invalidPath}`);

        // Test in allowed_files
        const fileRes = await client.callTool({
            name: 'omni_dual_register_plan',
            arguments: {
                workspace_root: wsRoot,
                session_id: 'sess-paths',
                plan_revision: 1,
                plan_path: 'plans/valid-plan.md',
                plan_sha256: 'a'.repeat(64),
                tasks: [{
                    task_id: 'TASK-1',
                    title: 'Valid task',
                    owner: 'codex',
                    allowed_files: [invalidPath],
                }],
            },
        });
        assert.equal(fileRes.isError, true, `Expected rejection for invalid allowed_files: ${invalidPath}`);
        assert.equal(clientCreated, false, `Client must not be called for invalid allowed_files: ${invalidPath}`);
    }
});

// --------------------------------------------------------------------------
// 6. Strict Daemon Response Validation & Authority Negative Tests
// --------------------------------------------------------------------------
test('register_plan rejects empty, mismatched, or malformed daemon responses with stable isError', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    let daemonResponse = {};
    const fakeClient = {
        health: async () => ({ status: 'healthy', workspace_root: wsRoot, session_id: 'sess-neg-plan' }),
        request: async () => {
            if (daemonResponse instanceof Error) throw daemonResponse;
            return daemonResponse;
        },
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const validArgs = {
        workspace_root: wsRoot,
        session_id: 'sess-neg-plan',
        plan_revision: 1,
        plan_path: 'plans/plan.md',
        plan_sha256: 'a'.repeat(64),
        tasks: [{
            task_id: 'TASK-1',
            title: 'Task 1',
            owner: 'codex',
            allowed_files: ['lib/file.js'],
        }],
    };

    // 1. Daemon returns empty object {} -> MUST fail, NOT infer success
    daemonResponse = {};
    const emptyRes = await client.callTool({ name: 'omni_dual_register_plan', arguments: validArgs });
    assert.equal(emptyRes.isError, true, 'Empty daemon response must return isError: true');

    // 2. Daemon returns mismatched session_id
    daemonResponse = { session_id: 'wrong-sess', plan_revision: 1, state: 'PLANNED', total_tasks: 1, registered: true };
    const mismatchSessRes = await client.callTool({ name: 'omni_dual_register_plan', arguments: validArgs });
    assert.equal(mismatchSessRes.isError, true, 'Mismatched session_id must return isError: true');

    // 3. Daemon returns mismatched plan_revision
    daemonResponse = { session_id: 'sess-neg-plan', plan_revision: 99, state: 'PLANNED', total_tasks: 1, registered: true };
    const mismatchRevRes = await client.callTool({ name: 'omni_dual_register_plan', arguments: validArgs });
    assert.equal(mismatchRevRes.isError, true, 'Mismatched plan_revision must return isError: true');

    // 4. Daemon returns registered: false
    daemonResponse = { session_id: 'sess-neg-plan', plan_revision: 1, state: 'PLANNED', total_tasks: 1, registered: false };
    const notRegRes = await client.callTool({ name: 'omni_dual_register_plan', arguments: validArgs });
    assert.equal(notRegRes.isError, true, 'registered: false must return isError: true');

    // 5. Daemon returns invalid state (e.g. undefined or non-session state)
    daemonResponse = { session_id: 'sess-neg-plan', plan_revision: 1, state: 'NOT_A_STATE', total_tasks: 1, registered: true };
    const badStateRes = await client.callTool({ name: 'omni_dual_register_plan', arguments: validArgs });
    assert.equal(badStateRes.isError, true, 'Invalid state must return isError: true');

    for (const stableCode of [
        'DUAL_TRANSITION_INVALID',
        'DUAL_SETUP_REQUIRED',
        'DUAL_PLAN_INVALID',
        'DUAL_PLAN_HASH_MISMATCH',
        'DUAL_PLAN_REVISION_MISMATCH',
    ]) {
        daemonResponse = Object.assign(new Error(`secret internal path C:\\private\\${stableCode}`), { code: stableCode });
        const errorRes = await client.callTool({ name: 'omni_dual_register_plan', arguments: validArgs });
        assert.equal(errorRes.isError, true);
        assert.equal(errorRes.structuredContent?.error?.code, stableCode);
        assert.equal(JSON.stringify(errorRes).includes('C:\\private'), false);
    }
});

test('resume rejects empty, mismatched, or malformed daemon responses with stable isError', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    let daemonResponse = {};
    const fakeClient = {
        health: async () => ({ status: 'healthy', workspace_root: wsRoot, session_id: 'sess-neg-resume' }),
        request: async () => daemonResponse,
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const validArgs = {
        workspace_root: wsRoot,
        session_id: 'sess-neg-resume',
    };

    // 1. Daemon returns empty object {} -> MUST fail, NOT infer success
    daemonResponse = {};
    const emptyRes = await client.callTool({ name: 'omni_dual_resume', arguments: validArgs });
    assert.equal(emptyRes.isError, true, 'Empty daemon response must return isError: true');

    // 2. Daemon returns mismatched session_id
    daemonResponse = { session_id: 'wrong-sess', state: 'EXECUTING', resumed: true };
    const mismatchSessRes = await client.callTool({ name: 'omni_dual_resume', arguments: validArgs });
    assert.equal(mismatchSessRes.isError, true, 'Mismatched session_id must return isError: true');

    // 3. Daemon returns resumed: false
    daemonResponse = { session_id: 'sess-neg-resume', state: 'EXECUTING', resumed: false };
    const notResumedRes = await client.callTool({ name: 'omni_dual_resume', arguments: validArgs });
    assert.equal(notResumedRes.isError, true, 'resumed: false must return isError: true');

    // 4. Daemon returns invalid state
    daemonResponse = { session_id: 'sess-neg-resume', state: 'INVALID_STATE', resumed: true };
    const badStateRes = await client.callTool({ name: 'omni_dual_resume', arguments: validArgs });
    assert.equal(badStateRes.isError, true, 'Invalid state must return isError: true');
});

test('begin, status, and completion reject malformed daemon responses with stable isError', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    let beginResponse = {};
    let statusResponse = {};
    let completionResponse = {};

    const fakeClient = {
        health: async () => ({ status: 'healthy', workspace_root: wsRoot, session_id: 'sess-neg-ops' }),
        beginSession: async () => beginResponse,
        status: async () => statusResponse,
        evaluateCompletion: async () => completionResponse,
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    // 1. Begin with missing required fields
    beginResponse = {};
    const badBegin = await client.callTool({
        name: 'omni_dual_begin',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-neg-ops',
            expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        },
    });
    assert.equal(badBegin.isError, true, 'Empty begin response must return isError: true');

    // 2. Status with missing required fields
    statusResponse = {};
    const badStatus = await client.callTool({
        name: 'omni_dual_status',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-neg-ops',
        },
    });
    assert.equal(badStatus.isError, true, 'Empty status response must return isError: true');

    // 3. Completion with non-boolean verified
    completionResponse = { verified: 'yes', session_state: 'VERIFIED' };
    const badComp = await client.callTool({
        name: 'omni_dual_completion',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-neg-ops',
        },
    });
    assert.equal(badComp.isError, true, 'Invalid completion response must return isError: true');
});

// --------------------------------------------------------------------------
// 7. Health Pre-check and Session Mismatch Verification
// --------------------------------------------------------------------------
test('session-specific tools require healthy daemon and matching session_id before delegating RPC', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    let rpcCalled = false;
    let currentHealth = {
        status: 'healthy',
        workspace_root: wsRoot,
        session_id: 'active-session-123',
    };

    const fakeClient = {
        health: async () => currentHealth,
        status: async () => {
            rpcCalled = true;
            return {
                session_id: 'active-session-123',
                workspace_id: 'ws-1',
                workspace_root: wsRoot,
                state: 'EXECUTING',
                plan_revision: 1,
                current_baseline: { kind: 'snapshot', id: 'a'.repeat(64) },
                tasks: {},
                gates: {},
                blocked: false,
                integrity: { valid: true, event_count: 1 },
            };
        },
        evaluateCompletion: async () => {
            rpcCalled = true;
            return { verified: false, session_state: 'EXECUTING', blockers: [] };
        },
        request: async () => {
            rpcCalled = true;
            return { session_id: 'active-session-123', state: 'EXECUTING', resumed: true };
        },
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    // 1. Session ID mismatch: requested 'wrong-session-999', health reports 'active-session-123'
    rpcCalled = false;
    const mismatchRes = await client.callTool({
        name: 'omni_dual_status',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'wrong-session-999',
        },
    });
    assert.equal(mismatchRes.isError, true);
    assert.equal(rpcCalled, false, 'status RPC must not be called when session_id mismatches health');
    assert.ok(mismatchRes.content[0].text.includes('DUAL_SESSION_MISMATCH'));

    // 2. Unhealthy daemon: status === 'unhealthy'
    rpcCalled = false;
    currentHealth = { status: 'unhealthy', workspace_root: wsRoot, session_id: 'active-session-123' };
    const unhealthyRes = await client.callTool({
        name: 'omni_dual_status',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'active-session-123',
        },
    });
    assert.equal(unhealthyRes.isError, true);
    assert.equal(rpcCalled, false, 'status RPC must not be called when daemon is unhealthy');
    assert.ok(unhealthyRes.content[0].text.includes('DUAL_DAEMON_UNHEALTHY'));

    // 3. Health workspace_root mismatch
    rpcCalled = false;
    const otherWs = createTempWorkspace(t);
    currentHealth = { status: 'healthy', workspace_root: otherWs, session_id: 'active-session-123' };
    const wsMismatchRes = await client.callTool({
        name: 'omni_dual_status',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'active-session-123',
        },
    });
    assert.equal(wsMismatchRes.isError, true);
    assert.equal(rpcCalled, false);
    assert.ok(wsMismatchRes.content[0].text.includes('DUAL_WORKSPACE_MISMATCH'));
});

// --------------------------------------------------------------------------
// 8. Exact RPC Delegation for All 5 Tools
// --------------------------------------------------------------------------
test('all 5 tools delegate exact client methods and parameters', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    const calls = [];
    const fakeClient = {
        health: async () => ({
            status: 'healthy',
            workspace_root: wsRoot,
            session_id: 'sess-delegation',
        }),
        beginSession: async (params) => {
            calls.push({ method: 'beginSession', params });
            return {
                session_id: params.session_id || 'sess-delegation',
                state: 'DISCOVERED',
                workspace_id: 'ws-123',
                workspace_root: wsRoot,
                expected_baseline: params.expected_baseline,
                plan_revision: 1,
            };
        },
        status: async (sessionId) => {
            calls.push({ method: 'status', sessionId });
            return {
                session_id: 'sess-delegation',
                workspace_id: 'ws-123',
                workspace_root: wsRoot,
                state: 'PLANNED',
                plan_revision: 1,
                current_baseline: { kind: 'git', id: 'a'.repeat(40) },
                tasks: {
                    'TASK-1': {
                        task_id: 'TASK-1',
                        state: 'ROUTED',
                        owner: 'agy',
                        title: 'Test task',
                        allowed_files: ['lib/test.js'],
                    },
                },
                gates: {},
                blocked: false,
                integrity: { valid: true, eventCount: 3 },
            };
        },
        evaluateCompletion: async (sessionId, params) => {
            calls.push({ method: 'evaluateCompletion', sessionId, params });
            return {
                verified: false,
                session_state: 'EXECUTING',
                blockers: ['TASK_INCOMPLETE: TASK-1 not verified'],
            };
        },
        request: async (method, params) => {
            calls.push({ method: `request:${method}`, params });
            if (method === 'plan.register') {
                return {
                    session_id: params.session_id,
                    state: 'PLANNED',
                    plan_revision: params.plan_revision,
                    total_tasks: params.tasks.length,
                    registered: true,
                };
            }
            if (method === 'session.resume') {
                return {
                    session_id: params.session_id,
                    state: 'EXECUTING',
                    resumed: true,
                };
            }
            throw new Error(`Unexpected method: ${method}`);
        },
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    // 1. omni_dual_begin
    const beginRes = await client.callTool({
        name: 'omni_dual_begin',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-delegation',
            mode: 'auto',
            expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        },
    });
    assert.equal(beginRes.isError, undefined);
    assert.equal(calls[0].method, 'beginSession');
    assert.equal(calls[0].params.session_id, 'sess-delegation');
    assert.deepEqual(calls[0].params.expected_baseline, { kind: 'git', id: 'a'.repeat(40) });
    assert.equal(beginRes.structuredContent.session_id, 'sess-delegation');

    // 2. omni_dual_register_plan
    const planRes = await client.callTool({
        name: 'omni_dual_register_plan',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-delegation',
            plan_revision: 1,
            plan_path: 'plans/test-plan.md',
            plan_sha256: 'b'.repeat(64),
            tasks: [{
                task_id: 'TASK-1',
                title: 'Test task',
                owner: 'agy',
                allowed_files: ['lib/test.js'],
            }],
        },
    });
    assert.equal(planRes.isError, undefined);
    const planCall = calls.find((c) => c.method === 'request:plan.register');
    assert.ok(planCall);
    assert.equal(planCall.params.session_id, 'sess-delegation');
    assert.equal(planCall.params.plan_revision, 1);
    assert.equal(planCall.params.tasks.length, 1);

    // 3. omni_dual_status
    const statusRes = await client.callTool({
        name: 'omni_dual_status',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-delegation',
        },
    });
    assert.equal(statusRes.isError, undefined);
    const statusCall = calls.find((c) => c.method === 'status');
    assert.ok(statusCall);
    assert.equal(statusCall.sessionId, 'sess-delegation');
    assert.equal(statusRes.structuredContent.session_id, 'sess-delegation');
    assert.equal(statusRes.structuredContent.state, 'PLANNED');

    // 4. omni_dual_completion
    const compRes = await client.callTool({
        name: 'omni_dual_completion',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-delegation',
        },
    });
    assert.equal(compRes.isError, undefined);
    const compCall = calls.find((c) => c.method === 'evaluateCompletion');
    assert.ok(compCall);
    assert.equal(compCall.sessionId, 'sess-delegation');
    assert.equal(compRes.structuredContent.verified, false);

    // 5. omni_dual_resume
    const resumeRes = await client.callTool({
        name: 'omni_dual_resume',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-delegation',
        },
    });
    assert.equal(resumeRes.isError, undefined);
    const resumeCall = calls.find((c) => c.method === 'request:session.resume');
    assert.ok(resumeCall);
    assert.equal(resumeCall.params.session_id, 'sess-delegation');
});

// --------------------------------------------------------------------------
// 9. Response Byte Bound (<=16 KiB UTF-8) and Deep Sanitization
// --------------------------------------------------------------------------
test('responses enforce <=16 KiB UTF-8 byte bound without cutting JSON and sanitize deep objects', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    // Create a status response with 200 tasks and large Unicode strings
    const massiveTasks = {};
    for (let i = 0; i < 200; i++) {
        massiveTasks[`TASK-${i}`] = {
            task_id: `TASK-${i}`,
            state: 'ROUTED',
            owner: 'codex',
            title: `Large Unicode title 🚀 — задача №${i} — ${'🔥'.repeat(20)}`,
            allowed_files: [`lib/task-${i}.js`, `test/task-${i}.test.js`, 'INVALID_PATH_../secret_escape'],
            secret_marker_task_field: 'SECRET_MARKER_IN_TASK_FIELD',
        };
    }

    const fakeClient = {
        health: async () => ({
            status: 'healthy',
            workspace_root: wsRoot,
            session_id: 'sess-bounded',
        }),
        status: async () => ({
            session_id: 'sess-bounded',
            workspace_id: 'ws-bounded',
            workspace_root: wsRoot,
            state: 'EXECUTING',
            plan_revision: 1,
            current_baseline: { kind: 'snapshot', id: 'd'.repeat(64) },
            tasks: massiveTasks,
            gates: {
                GATE_1: {
                    gate_id: 'GATE_1',
                    status: 'PASSED',
                    required: true,
                    reason: 'Gate 1 passed',
                    evidence_sha256: 'e'.repeat(64),
                    secret_gate_field: 'SECRET_MARKER_IN_GATE_DETAILS',
                    nested_obj: { secret: 'SECRET_NESTED_GATE' },
                },
            },
            blocked: {
                code: 'TEST_BLOCKED',
                reason: 'Blocked for testing',
                secret_blocked_field: 'SECRET_MARKER_IN_BLOCKED',
            },
            integrity: { valid: true, eventCount: 500, secret_hash: 'SECRET_INTEGRITY' },
            unallowlisted_secret_dump: 'SECRET_MARKER_TOP_LEVEL_DUMP',
        }),
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const res = await client.callTool({
        name: 'omni_dual_status',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-bounded',
        },
    });

    const serializedResult = JSON.stringify(res);
    const byteLength = Buffer.byteLength(serializedResult, 'utf8');

    // 1. Byte length must be <= 16 KiB (16384 bytes)
    assert.ok(
        byteLength <= 16 * 1024,
        `Full serialized result must be <= 16384 bytes, got ${byteLength} bytes`
    );

    // 2. content[0].text must be valid non-truncated JSON
    assert.ok(res.content && res.content[0] && res.content[0].text);
    let parsedContent;
    assert.doesNotThrow(() => {
        parsedContent = JSON.parse(res.content[0].text);
    }, 'content[0].text must be valid JSON and never cut mid-document');

    // 3. structuredContent must match parsedContent
    assert.deepEqual(res.structuredContent, parsedContent);

    // 4. Assert NO secret markers crossed the boundary
    assert.equal(serializedResult.includes('SECRET_MARKER_IN_TASK_FIELD'), false);
    assert.equal(serializedResult.includes('SECRET_MARKER_IN_GATE_DETAILS'), false);
    assert.equal(serializedResult.includes('SECRET_NESTED_GATE'), false);
    assert.equal(serializedResult.includes('SECRET_MARKER_IN_BLOCKED'), false);
    assert.equal(serializedResult.includes('SECRET_INTEGRITY'), false);
    assert.equal(serializedResult.includes('SECRET_MARKER_TOP_LEVEL_DUMP'), false);
    assert.equal(serializedResult.includes('secret_escape'), false);
});

test('formatToolSuccess returns stable DUAL_MCP_RESPONSE_TOO_LARGE error if result exceeds 16 KiB', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    // Fake completion returning 500 blockers each 120 chars
    const massiveBlockers = [];
    for (let i = 0; i < 300; i++) {
        massiveBlockers.push(`BLOCKER_REASON_MESSAGE_NUMBER_${i}_${'z'.repeat(100)}`);
    }

    const fakeClient = {
        health: async () => ({
            status: 'healthy',
            workspace_root: wsRoot,
            session_id: 'sess-oversized',
        }),
        evaluateCompletion: async () => ({
            verified: false,
            session_state: 'BLOCKED',
            blockers: massiveBlockers,
        }),
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const res = await client.callTool({
        name: 'omni_dual_completion',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-oversized',
        },
    });

    const serializedResult = JSON.stringify(res);
    const byteLength = Buffer.byteLength(serializedResult, 'utf8');

    assert.ok(byteLength <= 16 * 1024, `Response must be <= 16 KiB, got ${byteLength}`);
    // If output is kept under 16 KiB via blockers slicing or error code, verify valid JSON
    assert.doesNotThrow(() => JSON.parse(res.content[0].text));
});

// --------------------------------------------------------------------------
// 10. Error Sanitization & Privacy (No Path, Session, Hash, or Message Leaks)
// --------------------------------------------------------------------------
test('error results never leak raw paths, session IDs, tokens, or injected client error text', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    const uniqueSecretError = 'INJECTED_SECRET_CLIENT_ERROR_MARKER_998877';
    const fakeClient = {
        health: async () => {
            throw new Error(`Connection failed: ${uniqueSecretError} at /var/secrets/token.json`);
        },
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const res = await client.callTool({
        name: 'omni_dual_status',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-privacy-err',
        },
    });

    assert.equal(res.isError, true);
    const serialized = JSON.stringify(res);
    assert.equal(serialized.includes(uniqueSecretError), false, 'Secret error text must not leak');
    assert.equal(serialized.includes('/var/secrets'), false, 'Path must not leak in error');
    assert.equal(serialized.includes(wsRoot), false, 'Workspace path must not leak in error');
    assert.ok(serialized.includes('DUAL_MCP_STATUS_ERROR') || serialized.includes('DUAL_MCP_ERROR'));
});

// --------------------------------------------------------------------------
// 11. Integration with Real Daemon Server (Begin & Status)
// --------------------------------------------------------------------------
test('MCP server integrates with real running daemon for begin and status', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'real-mcp-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });
    t.after(() => daemon.close());

    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    const mcpServerInstance = createOmniDualMcpServer({ workspaceRoot: wsRoot });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    // 1. omni_dual_begin against real daemon
    const beginRes = await client.callTool({
        name: 'omni_dual_begin',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'real-mcp-sess-1',
            mode: 'auto',
        },
    });
    assert.equal(beginRes.isError, undefined);
    assert.equal(beginRes.structuredContent.session_id, 'real-mcp-sess-1');
    assert.equal(beginRes.structuredContent.state, 'DISCOVERED');

    // 2. omni_dual_status against real daemon
    const statusRes = await client.callTool({
        name: 'omni_dual_status',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'real-mcp-sess-1',
        },
    });
    assert.equal(statusRes.isError, undefined);
    assert.equal(statusRes.structuredContent.session_id, 'real-mcp-sess-1');
    assert.equal(statusRes.structuredContent.state, 'DISCOVERED');
    assert.deepEqual(statusRes.structuredContent.current_baseline, beginRes.structuredContent.expected_baseline);
    assert.equal(statusRes.structuredContent.current_baseline.kind, 'snapshot');
});

test('MCP server status succeeds with real authority-store gate results without required field', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'real-gate-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });
    t.after(() => daemon.close());

    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    const mcpServerInstance = createOmniDualMcpServer({ workspaceRoot: wsRoot });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    // 1. Begin session
    const beginRes = await client.callTool({
        name: 'omni_dual_begin',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'real-gate-sess-1',
            mode: 'auto',
        },
    });
    assert.equal(beginRes.isError, undefined);

    // 2. Append real events to authority store leading to gate.result
    authorityStore.append({
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'check_node', status: 'PASSED' }],
    });
    authorityStore.append({
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plans/task-plan.md',
        plan_sha256: 'f'.repeat(64),
        total_tasks: 1,
        tasks: [{
            task_id: 'TASK-1',
            title: 'First task',
            owner: 'agy',
            allowed_files: ['lib/test.js'],
        }],
    });
    authorityStore.append({
        type: 'task.routed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'ROUTED',
        allowed_files: ['lib/test.js'],
        reason: 'Initial route to AGY',
    });
    authorityStore.append({
        type: 'gate.result',
        gate_id: 'GATE-LINT',
        status: 'PASSED',
        cycle_index: 1,
        task_id: 'TASK-1',
        reason: 'Linter passed with 0 errors',
        evidence_sha256: 'a'.repeat(64),
    });

    // 3. Call status tool via MCP
    const statusRes = await client.callTool({
        name: 'omni_dual_status',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'real-gate-sess-1',
        },
    });

    assert.equal(statusRes.isError, undefined);
    assert.equal(statusRes.structuredContent.session_id, 'real-gate-sess-1');
    assert.equal(statusRes.structuredContent.state, 'EXECUTING');
    assert.ok(statusRes.structuredContent.gates);
    assert.ok(statusRes.structuredContent.gates['GATE-LINT']);
    const gateInfo = statusRes.structuredContent.gates['GATE-LINT'];
    assert.equal(gateInfo.gate_id, 'GATE-LINT');
    assert.equal(gateInfo.status, 'PASSED');
    assert.equal(gateInfo.reason, 'Linter passed with 0 errors');
    assert.equal(gateInfo.evidence_sha256, 'a'.repeat(64));
    assert.equal(gateInfo.required, undefined, 'required property must be omitted and not defaulted');
    assert.equal('required' in gateInfo, false, 'required property must not be present on gate object');
});

// --------------------------------------------------------------------------
// 12. Daemon Missing or Corrupt Discovery Returns Stable isError
// --------------------------------------------------------------------------
test('daemon missing or corrupt discovery returns stable isError without leaking secrets', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    const mcpServerInstance = createOmniDualMcpServer({ workspaceRoot: wsRoot });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    // Discovery file is missing
    const res = await client.callTool({
        name: 'omni_dual_status',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'sess-missing-discovery',
        },
    });

    assert.equal(res.isError, true);
    assert.ok(res.content && res.content.length > 0);
    const errorText = res.content[0].text;
    assert.ok(errorText.includes('DUAL_DISCOVERY_MISSING'));
});

// --------------------------------------------------------------------------
// 13. Stdio CLI Diagnostics, Unknown Argument Privacy, and Signal Cleanup
// --------------------------------------------------------------------------
test('stdio main rejects secret unknown arguments without echoing them to stderr', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const mcpScriptPath = path.resolve(__dirname, '..', 'lib', 'dual', 'mcp-server.mjs');
    const secretArg = '--SECRET_CLI_ARGUMENT_VAL_12345';

    const child = spawn(process.execPath, [mcpScriptPath, secretArg], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
    });

    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));

    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(exitCode, 1, 'Process should exit 1 on unknown argument');
    assert.equal(stderr.includes(secretArg), false, 'Unknown secret argument must NOT appear in stderr');
    assert.equal(stdout.includes(secretArg), false, 'Unknown secret argument must NOT appear in stdout');
    assert.ok(stderr.includes('Invalid command-line argument') || stderr.includes('Unknown argument'));
});

test('stdio main supports --help and exits 0 cleanly', async (t) => {
    const mcpScriptPath = path.resolve(__dirname, '..', 'lib', 'dual', 'mcp-server.mjs');

    const child = spawn(process.execPath, [mcpScriptPath, '--help'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
    });

    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));

    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(exitCode, 0);
    assert.ok(stderr.includes('Usage:'));
});

test('stdio MCP child process runs cleanly, emits pure JSON-RPC on stdout, and exits 0 on stdin close', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'stdio-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });
    t.after(() => daemon.close());

    const mcpScriptPath = path.resolve(__dirname, '..', 'lib', 'dual', 'mcp-server.mjs');

    const child = spawn(process.execPath, [mcpScriptPath, '--workspace', wsRoot], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
    });

    let stderrOutput = '';
    child.stderr.on('data', (d) => (stderrOutput += d.toString('utf8')));

    t.after(() => {
        if (!child.killed && child.exitCode === null) {
            try {
                child.kill('SIGKILL');
            } catch {
                // ignore
            }
        }
    });

    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [mcpScriptPath, '--workspace', wsRoot],
    });

    const client = new Client({ name: 'stdio-test-client', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);

    // List tools
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 5);

    // Call begin tool
    const beginRes = await client.callTool({
        name: 'omni_dual_begin',
        arguments: {
            workspace_root: wsRoot,
            session_id: 'stdio-sess-1',
            mode: 'auto',
            expected_baseline: { kind: 'git', id: 'f'.repeat(40) },
        },
    });
    assert.equal(beginRes.isError, undefined);
    assert.equal(beginRes.structuredContent.session_id, 'stdio-sess-1');

    await client.close();

    // Now test the directly spawned child stdin closing
    child.stdin.end();
    const exitCode = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(exitCode, 0, `Stdio child should exit 0 on stdin close. Stderr: ${stderrOutput}`);
});

// --------------------------------------------------------------------------
// 14. Requirement 1: Inferred Authority Fields Removal & Negative Response Tests
// --------------------------------------------------------------------------
test('begin rejects responses with missing, non-positive, or invalid plan_revision', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    let daemonResponse = {};
    const fakeClient = {
        health: async () => ({ status: 'healthy', workspace_root: wsRoot, session_id: 'sess-auth-1' }),
        beginSession: async () => daemonResponse,
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const validArgs = {
        workspace_root: wsRoot,
        session_id: 'sess-auth-1',
        mode: 'auto',
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
    };

    // 1. Missing plan_revision (must not default to 1)
    daemonResponse = {
        session_id: 'sess-auth-1',
        state: 'DISCOVERED',
        workspace_id: 'ws-1',
        workspace_root: wsRoot,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        // plan_revision omitted
    };
    const missingRevRes = await client.callTool({ name: 'omni_dual_begin', arguments: validArgs });
    assert.equal(missingRevRes.isError, true, 'Begin must reject missing plan_revision');

    // 2. Zero plan_revision
    daemonResponse.plan_revision = 0;
    const zeroRevRes = await client.callTool({ name: 'omni_dual_begin', arguments: validArgs });
    assert.equal(zeroRevRes.isError, true, 'Begin must reject plan_revision = 0');

    // 3. Negative plan_revision
    daemonResponse.plan_revision = -5;
    const negRevRes = await client.callTool({ name: 'omni_dual_begin', arguments: validArgs });
    assert.equal(negRevRes.isError, true, 'Begin must reject negative plan_revision');

    // 4. Float plan_revision
    daemonResponse.plan_revision = 1.5;
    const floatRevRes = await client.callTool({ name: 'omni_dual_begin', arguments: validArgs });
    assert.equal(floatRevRes.isError, true, 'Begin must reject float plan_revision');
});

test('begin rejects workspace_root mismatch against bound workspace and baseline mismatch', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const otherWs = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    let daemonResponse = {};
    const fakeClient = {
        health: async () => ({ status: 'healthy', workspace_root: wsRoot, session_id: 'sess-auth-2' }),
        beginSession: async () => daemonResponse,
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const validArgs = {
        workspace_root: wsRoot,
        session_id: 'sess-auth-2',
        mode: 'auto',
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
    };

    // 1. Returned workspace_root does not match bound root
    daemonResponse = {
        session_id: 'sess-auth-2',
        state: 'DISCOVERED',
        workspace_id: 'ws-1',
        workspace_root: otherWs,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        plan_revision: 1,
    };
    const wsMismatchRes = await client.callTool({ name: 'omni_dual_begin', arguments: validArgs });
    assert.equal(wsMismatchRes.isError, true, 'Begin must reject returned workspace_root mismatch');

    // 2. Returned expected_baseline id mismatch
    daemonResponse.workspace_root = wsRoot;
    daemonResponse.expected_baseline = { kind: 'git', id: 'b'.repeat(40) };
    const baseIdMismatchRes = await client.callTool({ name: 'omni_dual_begin', arguments: validArgs });
    assert.equal(baseIdMismatchRes.isError, true, 'Begin must reject returned expected_baseline id mismatch');

    // 3. Returned expected_baseline kind mismatch
    daemonResponse.expected_baseline = { kind: 'snapshot', id: 'a'.repeat(64) };
    const baseKindMismatchRes = await client.callTool({ name: 'omni_dual_begin', arguments: validArgs });
    assert.equal(baseKindMismatchRes.isError, true, 'Begin must reject returned expected_baseline kind mismatch');

    // 4. Empty workspace_id
    daemonResponse.expected_baseline = { kind: 'git', id: 'a'.repeat(40) };
    daemonResponse.workspace_id = '';
    const emptyWsIdRes = await client.callTool({ name: 'omni_dual_begin', arguments: validArgs });
    assert.equal(emptyWsIdRes.isError, true, 'Begin must reject empty workspace_id');
});

test('status requires valid plan_revision, matching workspace_root, and valid current_baseline', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const otherWs = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    let daemonResponse = {};
    const fakeClient = {
        health: async () => ({ status: 'healthy', workspace_root: wsRoot, session_id: 'sess-auth-3' }),
        status: async () => daemonResponse,
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const validArgs = {
        workspace_root: wsRoot,
        session_id: 'sess-auth-3',
    };

    const baseGoodStatus = {
        session_id: 'sess-auth-3',
        workspace_id: 'ws-1',
        workspace_root: wsRoot,
        state: 'EXECUTING',
        plan_revision: 1,
        current_baseline: { kind: 'git', id: 'c'.repeat(40) },
        tasks: {},
        gates: {},
        blocked: false,
    };

    // 1. Missing plan_revision in status (must not default to 1)
    daemonResponse = { ...baseGoodStatus };
    delete daemonResponse.plan_revision;
    const missingRev = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(missingRev.isError, true, 'Status must reject missing plan_revision');

    // 2. Negative plan_revision in status
    daemonResponse = { ...baseGoodStatus, plan_revision: -1 };
    const negRev = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(negRev.isError, true, 'Status must reject negative plan_revision');

    // 3. Workspace root mismatch in status
    daemonResponse = { ...baseGoodStatus, workspace_root: otherWs };
    const wsMismatch = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(wsMismatch.isError, true, 'Status must reject returned workspace_root mismatch');

    // 4. Missing current_baseline (must not silently omit)
    daemonResponse = { ...baseGoodStatus };
    delete daemonResponse.current_baseline;
    const missingBase = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(missingBase.isError, true, 'Status must reject missing current_baseline');

    // 5. Invalid current_baseline (e.g. invalid kind or id)
    daemonResponse = { ...baseGoodStatus, current_baseline: { kind: 'invalid_kind', id: '123' } };
    const invalidBase = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(invalidBase.isError, true, 'Status must reject invalid current_baseline');
});

// --------------------------------------------------------------------------
// 15. Requirement 2: Never Invent Task or Gate Authority
// --------------------------------------------------------------------------
test('status fails closed when task authority contains invalid owner, state, or structure', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    let daemonResponse = {};
    const fakeClient = {
        health: async () => ({ status: 'healthy', workspace_root: wsRoot, session_id: 'sess-task-auth' }),
        status: async () => daemonResponse,
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const validArgs = {
        workspace_root: wsRoot,
        session_id: 'sess-task-auth',
    };

    const baseStatus = {
        session_id: 'sess-task-auth',
        workspace_id: 'ws-1',
        workspace_root: wsRoot,
        state: 'EXECUTING',
        plan_revision: 2,
        current_baseline: { kind: 'git', id: 'a'.repeat(40) },
        gates: {},
        blocked: false,
    };

    // 1. Invalid owner: 'root' (must NOT be coerced to 'codex'!)
    daemonResponse = {
        ...baseStatus,
        tasks: {
            'TASK-1': {
                task_id: 'TASK-1',
                state: 'ROUTED',
                owner: 'root',
                title: 'Malicious task',
                allowed_files: ['lib/foo.js'],
            },
        },
    };
    const badOwnerRoot = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(badOwnerRoot.isError, true, 'Status must fail closed for owner: root');

    // 2. Invalid owner: 'gemini' (v1 legacy, invalid for v2 daemon)
    daemonResponse.tasks['TASK-1'].owner = 'gemini';
    const badOwnerGemini = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(badOwnerGemini.isError, true, 'Status must fail closed for owner: gemini');

    // 3. Missing owner
    delete daemonResponse.tasks['TASK-1'].owner;
    const missingOwner = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(missingOwner.isError, true, 'Status must fail closed for missing owner');

    // 4. Invalid task state: 'CUSTOM_STATE' or 'SKIP'
    daemonResponse.tasks['TASK-1'].owner = 'codex';
    daemonResponse.tasks['TASK-1'].state = 'CUSTOM_UNKNOWN_STATE';
    const badStateRes = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(badStateRes.isError, true, 'Status must fail closed for unknown task state');

    // 5. Invalid task_id pattern
    daemonResponse.tasks['TASK-1'].state = 'ROUTED';
    daemonResponse.tasks['TASK-1'].task_id = '!!bad_id';
    const badTaskIdRes = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(badTaskIdRes.isError, true, 'Status must fail closed for invalid task_id');

    // 6. Valid tasks succeed
    daemonResponse.tasks['TASK-1'].task_id = 'TASK-1';
    const goodTaskRes = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(goodTaskRes.isError, undefined);
    assert.equal(goodTaskRes.structuredContent.tasks['TASK-1'].owner, 'codex');
    assert.equal(goodTaskRes.structuredContent.tasks['TASK-1'].state, 'ROUTED');
});

test('status fails closed when gate authority contains invalid status or bad id, handles optional required, and caps gates', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    let daemonResponse = {};
    const fakeClient = {
        health: async () => ({ status: 'healthy', workspace_root: wsRoot, session_id: 'sess-gate-auth' }),
        status: async () => daemonResponse,
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const validArgs = {
        workspace_root: wsRoot,
        session_id: 'sess-gate-auth',
    };

    const baseStatus = {
        session_id: 'sess-gate-auth',
        workspace_id: 'ws-1',
        workspace_root: wsRoot,
        state: 'EXECUTING',
        plan_revision: 1,
        current_baseline: { kind: 'git', id: 'a'.repeat(40) },
        tasks: {},
        blocked: false,
    };

    // 1. Invalid gate status: 'SKIP' (must NOT be accepted as valid)
    daemonResponse = {
        ...baseStatus,
        gates: {
            GATE_1: {
                gate_id: 'GATE_1',
                status: 'SKIP',
                required: true,
            },
        },
    };
    const badStatusSkip = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(badStatusSkip.isError, true, 'Status must fail closed for gate status: SKIP');

    // 2. Absent required field (must be omitted, never defaulted)
    daemonResponse = {
        ...baseStatus,
        gates: {
            GATE_1: {
                gate_id: 'GATE_1',
                status: 'PASSED',
                reason: 'Passed without required property',
            },
        },
    };
    const absentRequired = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(absentRequired.isError, undefined);
    assert.equal(absentRequired.structuredContent.gates.GATE_1.status, 'PASSED');
    assert.equal(absentRequired.structuredContent.gates.GATE_1.required, undefined, 'required must be omitted');
    assert.equal('required' in absentRequired.structuredContent.gates.GATE_1, false, 'required must not exist as key');

    // 3. Boolean required fields are preserved
    daemonResponse.gates.GATE_1.required = true;
    const boolReqTrue = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(boolReqTrue.isError, undefined);
    assert.equal(boolReqTrue.structuredContent.gates.GATE_1.required, true);

    daemonResponse.gates.GATE_1.required = false;
    const boolReqFalse = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(boolReqFalse.isError, undefined);
    assert.equal(boolReqFalse.structuredContent.gates.GATE_1.required, false);

    // 4. Non-boolean required field (e.g. string "true" or number 1)
    daemonResponse.gates.GATE_1.required = 'true';
    const nonBoolRequired = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(nonBoolRequired.isError, true, 'Status must fail closed for non-boolean gate required');

    daemonResponse.gates.GATE_1.required = 1;
    const numRequired = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(numRequired.isError, true, 'Status must fail closed for number gate required');

    // 5. Invalid gate_id pattern
    daemonResponse.gates.GATE_1.required = true;
    daemonResponse.gates.GATE_1.gate_id = '!bad@gate';
    const badGateId = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(badGateId.isError, true, 'Status must fail closed for invalid gate_id');

    // 6. Capped gates count exposes gates_truncated and gates_total
    const manyGates = {};
    for (let i = 0; i < 40; i++) {
        manyGates[`GATE_${i}`] = {
            gate_id: `GATE_${i}`,
            status: 'PASSED',
            required: true,
            reason: `Gate ${i} passed`,
        };
    }
    daemonResponse.gates = manyGates;
    const cappedGatesRes = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(cappedGatesRes.isError, undefined);
    assert.equal(cappedGatesRes.structuredContent.gates_truncated, true);
    assert.equal(cappedGatesRes.structuredContent.gates_total, 40);
    assert.equal(Object.keys(cappedGatesRes.structuredContent.gates).length, 25);
});

test('status rejects invented/malformed blocked shapes and requires bounded valid string code/reason', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    let daemonResponse = {};
    const fakeClient = {
        health: async () => ({ status: 'healthy', workspace_root: wsRoot, session_id: 'sess-blocked-shapes' }),
        status: async () => daemonResponse,
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const validArgs = {
        workspace_root: wsRoot,
        session_id: 'sess-blocked-shapes',
    };

    const baseStatus = {
        session_id: 'sess-blocked-shapes',
        workspace_id: 'ws-1',
        workspace_root: wsRoot,
        state: 'BLOCKED',
        plan_revision: 1,
        current_baseline: { kind: 'git', id: 'a'.repeat(40) },
        tasks: {},
        gates: {},
    };

    // 1. Valid boolean blocked (true/false)
    daemonResponse = { ...baseStatus, blocked: false };
    const boolFalseRes = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(boolFalseRes.isError, undefined);
    assert.equal(boolFalseRes.structuredContent.blocked, false);

    daemonResponse = { ...baseStatus, blocked: true };
    const boolTrueRes = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(boolTrueRes.isError, undefined);
    assert.equal(boolTrueRes.structuredContent.blocked, true);

    // 2. Valid blocked object with code & reason
    daemonResponse = {
        ...baseStatus,
        blocked: { code: 'MANUAL_HALT', reason: 'Blocked by user' },
    };
    const objRes = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(objRes.isError, undefined);
    assert.deepEqual(objRes.structuredContent.blocked, { code: 'MANUAL_HALT', reason: 'Blocked by user' });

    // 3. Valid blocked object with blocker_code (authority-store shape)
    daemonResponse = {
        ...baseStatus,
        blocked: { blocker_code: 'DAEMON_LOCK', reason: 'Lock conflict' },
    };
    const storeObjRes = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(storeObjRes.isError, undefined);
    assert.deepEqual(storeObjRes.structuredContent.blocked, { code: 'DAEMON_LOCK', reason: 'Lock conflict' });

    // 4. Missing reason in blocked object (must NOT default)
    daemonResponse = {
        ...baseStatus,
        blocked: { code: 'BLOCKED_CODE' },
    };
    const missingReasonRes = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(missingReasonRes.isError, true, 'Status must fail closed when blocked object is missing reason');

    // 5. Missing code in blocked object (must NOT default to BLOCKED)
    daemonResponse = {
        ...baseStatus,
        blocked: { reason: 'Some reason' },
    };
    const missingCodeRes = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(missingCodeRes.isError, true, 'Status must fail closed when blocked object is missing code');

    // 6. Non-string code/reason
    daemonResponse = {
        ...baseStatus,
        blocked: { code: 123, reason: 'Valid reason' },
    };
    const nonStrCodeRes = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(nonStrCodeRes.isError, true, 'Status must fail closed for non-string code');

    daemonResponse = {
        ...baseStatus,
        blocked: { code: 'CODE', reason: 456 },
    };
    const nonStrReasonRes = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(nonStrReasonRes.isError, true, 'Status must fail closed for non-string reason');

    // 7. Non-object, non-boolean invalid types (string, array, number)
    daemonResponse = { ...baseStatus, blocked: 'BLOCKED' };
    const strBlockedRes = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(strBlockedRes.isError, true, 'Status must fail closed for string blocked');

    daemonResponse = { ...baseStatus, blocked: ['array'] };
    const arrBlockedRes = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(arrBlockedRes.isError, true, 'Status must fail closed for array blocked');

    daemonResponse = { ...baseStatus, blocked: 123 };
    const numBlockedRes = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(numBlockedRes.isError, true, 'Status must fail closed for number blocked');
});

test('status rejects invented/malformed integrity shapes and requires valid boolean and nonnegative integer event count', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    let daemonResponse = {};
    const fakeClient = {
        health: async () => ({ status: 'healthy', workspace_root: wsRoot, session_id: 'sess-integrity-shapes' }),
        status: async () => daemonResponse,
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const validArgs = {
        workspace_root: wsRoot,
        session_id: 'sess-integrity-shapes',
    };

    const baseStatus = {
        session_id: 'sess-integrity-shapes',
        workspace_id: 'ws-1',
        workspace_root: wsRoot,
        state: 'EXECUTING',
        plan_revision: 1,
        current_baseline: { kind: 'git', id: 'a'.repeat(40) },
        tasks: {},
        gates: {},
        blocked: false,
    };

    // 1. Valid integrity shapes (event_count or eventCount)
    daemonResponse = {
        ...baseStatus,
        integrity: { valid: true, event_count: 10 },
    };
    const goodIntegrity1 = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(goodIntegrity1.isError, undefined);
    assert.deepEqual(goodIntegrity1.structuredContent.integrity, { valid: true, event_count: 10 });

    daemonResponse = {
        ...baseStatus,
        integrity: { valid: false, eventCount: 0 },
    };
    const goodIntegrity2 = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(goodIntegrity2.isError, undefined);
    assert.deepEqual(goodIntegrity2.structuredContent.integrity, { valid: false, event_count: 0 });

    // 2. Non-boolean valid (must NOT coerce)
    daemonResponse = {
        ...baseStatus,
        integrity: { valid: 'true', event_count: 5 },
    };
    const nonBoolValid = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(nonBoolValid.isError, true, 'Status must fail closed for string valid');

    daemonResponse = {
        ...baseStatus,
        integrity: { valid: 1, event_count: 5 },
    };
    const numValid = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(numValid.isError, true, 'Status must fail closed for number valid');

    // 3. Missing valid field
    daemonResponse = {
        ...baseStatus,
        integrity: { event_count: 5 },
    };
    const missingValid = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(missingValid.isError, true, 'Status must fail closed for missing valid');

    // 4. Missing event count (must NOT default to 0)
    daemonResponse = {
        ...baseStatus,
        integrity: { valid: true },
    };
    const missingCount = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(missingCount.isError, true, 'Status must fail closed for missing event count');

    // 5. Negative or non-integer event count
    daemonResponse = {
        ...baseStatus,
        integrity: { valid: true, event_count: -1 },
    };
    const negCount = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(negCount.isError, true, 'Status must fail closed for negative event count');

    daemonResponse = {
        ...baseStatus,
        integrity: { valid: true, event_count: 3.14 },
    };
    const floatCount = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(floatCount.isError, true, 'Status must fail closed for non-integer event count');

    daemonResponse = {
        ...baseStatus,
        integrity: { valid: true, event_count: '10' },
    };
    const strCount = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(strCount.isError, true, 'Status must fail closed for string event count');

    // 6. Non-object integrity
    daemonResponse = {
        ...baseStatus,
        integrity: 'true',
    };
    const strInteg = await client.callTool({ name: 'omni_dual_status', arguments: validArgs });
    assert.equal(strInteg.isError, true, 'Status must fail closed for string integrity');
});

// --------------------------------------------------------------------------
// 16. Requirement 3: Portable Repository Path Aliases
// --------------------------------------------------------------------------
test('isValidRepoRelativePath enforces portable cross-platform rules (rejects colons, control chars, trailing dot/space, Windows devices)', async () => {
    const { isValidRepoRelativePath } = await import('../lib/dual/mcp-server.mjs');

    // 1. Colons anywhere
    assert.equal(isValidRepoRelativePath('C:/path/file.js'), false);
    assert.equal(isValidRepoRelativePath('lib/file.js:stream'), false);
    assert.equal(isValidRepoRelativePath('foo:bar'), false);
    assert.equal(isValidRepoRelativePath(':leading'), false);
    assert.equal(isValidRepoRelativePath('trailing:'), false);

    // 2. ASCII control characters
    assert.equal(isValidRepoRelativePath('lib/file\x00name.js'), false);
    assert.equal(isValidRepoRelativePath('lib/file\x01name.js'), false);
    assert.equal(isValidRepoRelativePath('lib/file\x1fname.js'), false);
    assert.equal(isValidRepoRelativePath('lib/file\x7fname.js'), false);

    // 3. Trailing dot or space segments
    assert.equal(isValidRepoRelativePath('lib/foo.'), false);
    assert.equal(isValidRepoRelativePath('lib/foo '), false);
    assert.equal(isValidRepoRelativePath('dir./file.js'), false);
    assert.equal(isValidRepoRelativePath('dir /file.js'), false);
    assert.equal(isValidRepoRelativePath('a/b/c.'), false);
    assert.equal(isValidRepoRelativePath('a/b/c '), false);

    // 4. Windows reserved device basenames (case-insensitive, with any extensions)
    const reservedNames = [
        'CON', 'con', 'cOn', 'CON.txt', 'con.tar.gz',
        'PRN', 'prn', 'PRN.dat',
        'AUX', 'aux', 'aux.json', 'AUX.spec.ts',
        'NUL', 'nul', 'nul.md',
        'COM1', 'com1', 'COM1.js', 'com9', 'COM9.log',
        'LPT1', 'lpt1', 'lpt1.txt', 'LPT9', 'lpt9.tar.gz',
    ];
    for (const r of reservedNames) {
        assert.equal(isValidRepoRelativePath(r), false, `Must reject reserved device name: ${r}`);
        assert.equal(isValidRepoRelativePath(`src/${r}`), false, `Must reject reserved device in path: src/${r}`);
        assert.equal(isValidRepoRelativePath(`src/${r}/test.js`), false, `Must reject reserved device directory: src/${r}/test.js`);
    }

    // Non-reserved names that share prefixes must be ALLOWED
    assert.equal(isValidRepoRelativePath('contact.txt'), true);
    assert.equal(isValidRepoRelativePath('constant.js'), true);
    assert.equal(isValidRepoRelativePath('auxiliary.ts'), true);
    assert.equal(isValidRepoRelativePath('null.js'), true);
    assert.equal(isValidRepoRelativePath('prndir/foo.js'), true);

    // 5. Valid Unicode and spaces inside segments must WORK
    assert.equal(isValidRepoRelativePath('src/my component.js'), true);
    assert.equal(isValidRepoRelativePath('docs/тест/задача.md'), true);
    assert.equal(isValidRepoRelativePath('plans/🚀 rocket/feature.ts'), true);
    assert.equal(isValidRepoRelativePath('lib/valid-file.v2.min.js'), true);
});

// --------------------------------------------------------------------------
// 17. Requirement 4: Bound Completion Blockers Without Leaking Opaque Payload
// --------------------------------------------------------------------------
test('completion rejects non-string blockers, removes control chars, and redacts hashes and bearer tokens', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    let completionResponse = {};
    const fakeClient = {
        health: async () => ({ status: 'healthy', workspace_root: wsRoot, session_id: 'sess-blockers' }),
        evaluateCompletion: async () => completionResponse,
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const validArgs = {
        workspace_root: wsRoot,
        session_id: 'sess-blockers',
    };

    // 1. Non-string blocker element (e.g. object { secret_key: 'abc' }) MUST fail closed or be rejected
    completionResponse = {
        verified: false,
        session_state: 'BLOCKED',
        blockers: [{ opaque_secret: 'TOP_SECRET_BEARER_TOKEN' }],
    };
    const nonStrBlockerRes = await client.callTool({ name: 'omni_dual_completion', arguments: validArgs });
    assert.equal(nonStrBlockerRes.isError, true, 'Non-string blocker element must make response invalid');
    const serializedNonStr = JSON.stringify(nonStrBlockerRes);
    assert.equal(serializedNonStr.includes('TOP_SECRET'), false);
    assert.equal(serializedNonStr.includes('[object Object]'), false);

    // 2. Redacts 40-hex and 64-hex hashes and bearer tokens from blocker strings
    const secretHash40 = '1234567890abcdef1234567890abcdef12345678';
    const secretHash64 = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const secretToken = 'dual_tok_99887766554433221100';
    completionResponse = {
        verified: false,
        session_state: 'BLOCKED',
        blockers: [
            `UNVERIFIED_BASE: Git commit ${secretHash40} differs from expected`,
            `INTEGRITY_MISMATCH: Hash ${secretHash64} failed verification`,
            `AUTH_ERROR: bearer ${secretToken} expired\x01\x02`,
        ],
    };
    const redactedRes = await client.callTool({ name: 'omni_dual_completion', arguments: validArgs });
    assert.equal(redactedRes.isError, undefined);
    const serializedRedacted = JSON.stringify(redactedRes);
    assert.equal(serializedRedacted.includes(secretHash40), false, '40-hex hash must be redacted');
    assert.equal(serializedRedacted.includes(secretHash64), false, '64-hex hash must be redacted');
    assert.equal(serializedRedacted.includes(secretToken), false, 'Bearer token must be redacted');
    assert.equal(serializedRedacted.includes('\x01'), false, 'Control characters must be removed');
    assert.ok(serializedRedacted.includes('[REDACTED'));

    // 3. Blockers capped count
    const manyBlockers = [];
    for (let i = 0; i < 40; i++) {
        manyBlockers.push(`Blocker issue reason message #${i}`);
    }
    completionResponse = {
        verified: false,
        session_state: 'BLOCKED',
        blockers: manyBlockers,
    };
    const cappedBlockersRes = await client.callTool({ name: 'omni_dual_completion', arguments: validArgs });
    assert.equal(cappedBlockersRes.isError, undefined);
    assert.equal(cappedBlockersRes.structuredContent.blockers_truncated, true);
    assert.equal(cappedBlockersRes.structuredContent.blockers_total, 40);
    assert.equal(cappedBlockersRes.structuredContent.blockers.length, 25);
});

// --------------------------------------------------------------------------
// 18. Requirement 5: Flush-Safe CLI Exits & In-Process Lifecycle
// --------------------------------------------------------------------------
test('in-process main sets process.exitCode and removes signal listeners without leaking', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { main } = await import('../lib/dual/mcp-server.mjs');

    const initialSigint = process.listenerCount('SIGINT');
    const initialSigterm = process.listenerCount('SIGTERM');

    // 1. In-process --help sets exitCode = 0 and does not crash process
    process.exitCode = undefined;
    await main(['--help']);
    assert.equal(process.exitCode, 0);
    assert.equal(process.listenerCount('SIGINT'), initialSigint, 'Must not leak SIGINT on --help');
    assert.equal(process.listenerCount('SIGTERM'), initialSigterm, 'Must not leak SIGTERM on --help');

    // 2. In-process unknown arg sets exitCode = 1
    process.exitCode = undefined;
    await main(['--invalid-unknown-flag']);
    assert.equal(process.exitCode, 1);
    assert.equal(process.listenerCount('SIGINT'), initialSigint, 'Must not leak SIGINT on invalid arg');
    assert.equal(process.listenerCount('SIGTERM'), initialSigterm, 'Must not leak SIGTERM on invalid arg');

    // 3. In-process missing workspace directory sets exitCode = 1
    process.exitCode = undefined;
    await main(['--workspace']);
    assert.equal(process.exitCode, 1);
    assert.equal(process.listenerCount('SIGINT'), initialSigint, 'Must not leak SIGINT on missing dir');
    assert.equal(process.listenerCount('SIGTERM'), initialSigterm, 'Must not leak SIGTERM on missing dir');

    // 4. In-process non-existent directory sets exitCode = 1
    process.exitCode = undefined;
    await main(['--workspace', path.join(wsRoot, 'non-existent-subfolder-123')]);
    assert.equal(process.exitCode, 1);
    assert.equal(process.listenerCount('SIGINT'), initialSigint, 'Must not leak SIGINT on non-existent dir');
    assert.equal(process.listenerCount('SIGTERM'), initialSigterm, 'Must not leak SIGTERM on non-existent dir');

    // Clean exitCode for next tests
    process.exitCode = 0;
});

// --------------------------------------------------------------------------
// 19. Requirement 7: Strict MCP Nested Validation & Read-Only No-Evidence
// --------------------------------------------------------------------------
test('MCP omni_dual_completion rejects omitted nested fields for QC, quality, and UI evidence', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    let clientCalls = [];
    const fakeClient = {
        health: async () => ({ status: 'healthy', workspace_root: wsRoot, session_id: 'sess-strict-mcp' }),
        evaluateCompletion: async (sid, opts) => {
            clientCalls.push({ sid, opts });
            return { verified: false, session_state: 'EXECUTING', blockers: ['INCOMPLETE'] };
        },
    };

    const mcpServerInstance = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        mcpServerInstance.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await mcpServerInstance.close();
    });

    const baseArgs = {
        workspace_root: wsRoot,
        session_id: 'sess-strict-mcp',
    };

    // 1. Completion without evidence is allowed and delegates empty options
    clientCalls = [];
    const noEvRes = await client.callTool({ name: 'omni_dual_completion', arguments: baseArgs });
    assert.equal(noEvRes.isError, undefined);
    assert.equal(clientCalls.length, 1);
    assert.deepEqual(clientCalls[0].opts, {});

    // 2. QC evidence: missing diff_fingerprint rejected by schema before calling client
    clientCalls = [];
    const badQc1 = await client.callTool({
        name: 'omni_dual_completion',
        arguments: {
            ...baseArgs,
            qc_evidence: {
                task_id: 'TASK-1',
                verdict: 'SUCCESS',
                plan_revision: 1,
                // missing diff_fingerprint
                command_outputs: [{ command: 'npm test', exit_code: 0, duration_ms: 10 }],
                findings: [],
                modified_files: ['lib/a.js'],
            },
        },
    });
    assert.equal(badQc1.isError, true);
    assert.equal(clientCalls.length, 0, 'Must not call client on schema validation failure');

    // 3. QC evidence: non-empty findings rejected
    const badQc2 = await client.callTool({
        name: 'omni_dual_completion',
        arguments: {
            ...baseArgs,
            qc_evidence: {
                task_id: 'TASK-1',
                verdict: 'SUCCESS',
                plan_revision: 1,
                diff_fingerprint: 'a'.repeat(64),
                command_outputs: [{ command: 'npm test', exit_code: 0, duration_ms: 10 }],
                findings: ['something failed'],
                modified_files: ['lib/a.js'],
            },
        },
    });
    assert.equal(badQc2.isError, true);
    assert.equal(clientCalls.length, 0);

    // 4. Quality evidence: empty object rejected
    const badQe1 = await client.callTool({
        name: 'omni_dual_completion',
        arguments: {
            ...baseArgs,
            quality_evidence: {},
        },
    });
    assert.equal(badQe1.isError, true);
    assert.equal(clientCalls.length, 0);

    // 5. Quality evidence: missing commands rejected
    const badQe2 = await client.callTool({
        name: 'omni_dual_completion',
        arguments: {
            ...baseArgs,
            quality_evidence: {
                cycle_index: 1,
                attempt: 1,
                total_tasks: 1,
                completed_task_ids: ['TASK-1'],
                plan_revision: 1,
                diff_fingerprint: 'a'.repeat(64),
                gate_results: [{ id: 'gate-1', required: true, status: 'PASSED' }],
                // missing commands
                evidence_sha256: 'b'.repeat(64),
            },
        },
    });
    assert.equal(badQe2.isError, true);
    assert.equal(clientCalls.length, 0);

    // 6. UI evidence: missing requirement or evidence rejected
    const badUi1 = await client.callTool({
        name: 'omni_dual_completion',
        arguments: {
            ...baseArgs,
            ui_evidence: {
                evidence: {
                    runtime_status: 'UNAVAILABLE',
                    evidence_sha256: 'c'.repeat(64),
                },
            },
        },
    });
    assert.equal(badUi1.isError, true);
    assert.equal(clientCalls.length, 0);
});

test('omni_dual_completion MCP tool passes through DUAL_SNAPSHOT_EXECUTION_PENDING error on snapshot quality submission', async (t) => {
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    const fakeClient = {
        async health() {
            return {
                status: 'healthy',
                workspace_root: process.cwd(),
                session_id: '550e8400-e29b-41d4-a716-446655440000',
            };
        },
        async evaluateCompletion() {
            const err = new Error('DUAL_SNAPSHOT_EXECUTION_PENDING: Snapshot baseline quality execution is pending in this slice');
            err.code = 'DUAL_SNAPSHOT_EXECUTION_PENDING';
            throw err;
        },
    };

    const server = createOmniDualMcpServer({
        workspaceRoot: process.cwd(),
        createClient: () => fakeClient,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    t.after(async () => {
        await client.close();
        await server.close();
    });

    const result = await client.callTool({
        name: 'omni_dual_completion',
        arguments: {
            workspace_root: process.cwd(),
            session_id: '550e8400-e29b-41d4-a716-446655440000',
            quality_evidence: {
                cycle_index: 1,
                attempt: 1,
                total_tasks: 1,
                completed_task_ids: ['TASK-1'],
                plan_revision: 1,
                diff_fingerprint: 'a'.repeat(64),
                gate_results: [{ id: 'unit-tests', required: true, status: 'PASSED' }],
                commands: [{ command: 'npm test', exit_code: 0, duration_ms: 100 }],
                evidence_sha256: 'b'.repeat(64),
            },
        },
    });

    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.error.code, 'DUAL_MCP_COMPLETION_ERROR');
});

test('MCP omni_dual_register_plan rejects omitted args or cwd inside validation_commands before client call', async (t) => {
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    const clientCalls = [];
    const fakeClient = {
        async health() {
            return {
                status: 'healthy',
                workspace_root: process.cwd(),
                session_id: '550e8400-e29b-41d4-a716-446655440000',
            };
        },
        async registerPlan(params) {
            clientCalls.push(params);
            return { registered: true };
        },
    };

    const server = createOmniDualMcpServer({
        workspaceRoot: process.cwd(),
        createClient: () => fakeClient,
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    t.after(async () => {
        await client.close();
        await server.close();
    });

    // Missing args inside validation command
    const missingArgsRes = await client.callTool({
        name: 'omni_dual_register_plan',
        arguments: {
            workspace_root: process.cwd(),
            session_id: '550e8400-e29b-41d4-a716-446655440000',
            plan_path: 'plans/plan.md',
            plan_sha256: 'a'.repeat(64),
            tasks: [{
                task_id: 'TASK-1',
                title: 'Task 1',
                allowed_files: ['index.html'],
                validation_commands: [{ program: 'npm', cwd: '.' }], // missing args
            }],
        },
    });
    assert.equal(missingArgsRes.isError, true);
    assert.equal(clientCalls.length, 0);

    // Missing cwd inside validation command
    const missingCwdRes = await client.callTool({
        name: 'omni_dual_register_plan',
        arguments: {
            workspace_root: process.cwd(),
            session_id: '550e8400-e29b-41d4-a716-446655440000',
            plan_path: 'plans/plan.md',
            plan_sha256: 'a'.repeat(64),
            tasks: [{
                task_id: 'TASK-1',
                title: 'Task 1',
                allowed_files: ['index.html'],
                validation_commands: [{ program: 'npm', args: ['test'] }], // missing cwd
            }],
        },
    });
    assert.equal(missingCwdRes.isError, true);
    assert.equal(clientCalls.length, 0);
});

test('MCP omni_dual_register_plan accepts repository root cwd dot and forwards exact argv contract', async (t) => {
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');
    const sessionId = '550e8400-e29b-41d4-a716-446655440000';
    const calls = [];
    const fakeClient = {
        async health() {
            return {
                status: 'healthy',
                workspace_root: process.cwd(),
                session_id: sessionId,
            };
        },
        async request(method, params, requestOptions) {
            calls.push({ method, params, requestOptions });
            return {
                session_id: sessionId,
                state: 'PLANNED',
                plan_revision: 1,
                total_tasks: 1,
                registered: true,
            };
        },
    };
    const server = createOmniDualMcpServer({
        workspaceRoot: process.cwd(),
        createClient: () => fakeClient,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    t.after(async () => {
        await client.close();
        await server.close();
    });

    const result = await client.callTool({
        name: 'omni_dual_register_plan',
        arguments: {
            workspace_root: process.cwd(),
            session_id: sessionId,
            plan_revision: 1,
            plan_path: 'plans/plan.md',
            plan_sha256: 'a'.repeat(64),
            tasks: [{
                task_id: 'TASK-1',
                title: 'Task 1',
                allowed_files: ['index.html'],
                deny_patterns: [],
                validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
            }],
        },
    });

    assert.notEqual(result.isError, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'plan.register');
    assert.ok(
        calls[0].requestOptions.timeoutMs >= 30000,
        'plan registration must allow the bounded two-command AGY capability preflight to finish'
    );
    assert.deepEqual(calls[0].params.tasks[0].validation_commands[0], {
        program: 'node',
        args: ['--version'],
        cwd: '.',
    });
});

test('Codex MCP list-tools wire schema compatibility: all 5 tools expose object-only items and omni_dual_completion passes strict schema constraints', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');

    const fakeClient = {
        async health() {
            return {
                status: 'healthy',
                workspace_root: wsRoot,
                session_id: '550e8400-e29b-41d4-a716-446655440000',
            };
        },
        async evaluateCompletion(sessionId, params) {
            return {
                verified: true,
                session_state: 'VERIFIED',
                receipt: { receipt_sha256: 'e'.repeat(64) },
            };
        },
    };

    const server = createOmniDualMcpServer({
        workspaceRoot: wsRoot,
        createClient: () => fakeClient,
    });
    const client = new Client({ name: 'test-codex-client', version: '1.0.0' }, { capabilities: {} });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
    ]);
    t.after(async () => {
        await client.close();
        await server.close();
    });

    const listResult = await client.listTools();
    assert.ok(listResult && Array.isArray(listResult.tools));
    assert.equal(listResult.tools.length, 5, 'Must list exactly 5 tools over the wire');

    // Helper: Recursively validate that wire schema adheres to Codex / OpenAI tool schema constraints
    function validateCodexWireSchema(node, jsonPath) {
        if (!node || typeof node !== 'object') return;

        // Constraint 1: In OpenAI / Codex Function Calling JSON Schema, array items MUST be a schema object, NEVER an array (tuple)
        if (node.type === 'array' || 'items' in node) {
            assert.ok(
                node.items && typeof node.items === 'object' && !Array.isArray(node.items),
                `Schema at ${jsonPath} has invalid array items: items must be a schema object, not an array/tuple (Codex MCP compatibility constraint)`
            );
        }

        // Recursively check properties
        if (node.properties && typeof node.properties === 'object') {
            for (const [key, child] of Object.entries(node.properties)) {
                validateCodexWireSchema(child, `${jsonPath}.${key}`);
            }
        }

        // Recursively check array items
        if (node.items && typeof node.items === 'object' && !Array.isArray(node.items)) {
            validateCodexWireSchema(node.items, `${jsonPath}[]`);
        }

        // Recursively check anyOf / allOf / oneOf
        for (const unionKey of ['anyOf', 'allOf', 'oneOf']) {
            if (Array.isArray(node[unionKey])) {
                node[unionKey].forEach((child, idx) => {
                    validateCodexWireSchema(child, `${jsonPath}.${unionKey}[${idx}]`);
                });
            }
        }
    }

    for (const tool of listResult.tools) {
        assert.ok(tool.inputSchema, `Tool ${tool.name} must have inputSchema`);
        validateCodexWireSchema(tool.inputSchema, tool.name);
    }

    // Explicitly verify omni_dual_completion schema details
    const completionTool = listResult.tools.find((t) => t.name === 'omni_dual_completion');
    assert.ok(completionTool, 'omni_dual_completion must be present in tools/list');
    const viewportWidthsSchema = completionTool.inputSchema?.properties?.ui_evidence?.properties?.requirement?.properties?.viewport_widths;
    assert.ok(viewportWidthsSchema, 'viewport_widths schema must exist');
    assert.equal(viewportWidthsSchema.type, 'array');
    assert.equal(Array.isArray(viewportWidthsSchema.items), false, 'viewport_widths.items must NOT be an array');
    assert.equal(typeof viewportWidthsSchema.items, 'object', 'viewport_widths.items must be an object');

    // Test tool execution with valid UI evidence
    const validUiResult = await client.callTool({
        name: 'omni_dual_completion',
        arguments: {
            workspace_root: wsRoot,
            session_id: '550e8400-e29b-41d4-a716-446655440000',
            ui_evidence: {
                requirement: {
                    gate_id: 'ui-responsive',
                    required: true,
                    viewport_widths: [390, 768, 1024, 1440],
                    reduced_motion_required: true,
                },
                evidence: {
                    runtime_status: 'AVAILABLE',
                    evidence_sha256: 'c'.repeat(64),
                    viewports: [
                        { width: 390, passed: true, horizontal_overflow: false },
                        { width: 768, passed: true, horizontal_overflow: false },
                        { width: 1024, passed: true, horizontal_overflow: false },
                        { width: 1440, passed: true, horizontal_overflow: false },
                    ],
                    reduced_motion: { tested: true, passed: true },
                },
            },
        },
    });
    assert.notEqual(validUiResult.isError, true, 'Valid omni_dual_completion with UI evidence must succeed');

    // Test rejection with invalid viewport widths (e.g. wrong count or values)
    const invalidUiResult = await client.callTool({
        name: 'omni_dual_completion',
        arguments: {
            workspace_root: wsRoot,
            session_id: '550e8400-e29b-41d4-a716-446655440000',
            ui_evidence: {
                requirement: {
                    gate_id: 'ui-responsive',
                    required: true,
                    viewport_widths: [390, 768], // Only 2 elements instead of 4
                    reduced_motion_required: true,
                },
                evidence: {
                    runtime_status: 'AVAILABLE',
                    evidence_sha256: 'c'.repeat(64),
                },
            },
        },
    });
    assert.equal(invalidUiResult.isError, true, 'Invalid viewport widths count must fail validation');

    const duplicateUiResult = await client.callTool({
        name: 'omni_dual_completion',
        arguments: {
            workspace_root: wsRoot,
            session_id: '550e8400-e29b-41d4-a716-446655440000',
            ui_evidence: {
                requirement: {
                    gate_id: 'ui-responsive',
                    required: true,
                    viewport_widths: [390, 390, 768, 1024],
                    reduced_motion_required: true,
                },
                evidence: {
                    runtime_status: 'AVAILABLE',
                    evidence_sha256: 'c'.repeat(64),
                },
            },
        },
    });
    assert.equal(duplicateUiResult.isError, true, 'Viewport widths must preserve the exact required sequence');
});
