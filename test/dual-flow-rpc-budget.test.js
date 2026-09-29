'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { computeWorkspaceId } = require('../lib/dual/daemon-lock');
const { createDaemonClient } = require('../lib/dual/daemon-client');

function getRuntimeDir(workspaceRoot) {
    return path.join(workspaceRoot, '.omni', 'runtime', 'dual');
}

function createWorkspace(t) {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-rpc-budget-'));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));

    fs.mkdirSync(getRuntimeDir(workspaceRoot), { recursive: true });
    fs.writeFileSync(path.join(getRuntimeDir(workspaceRoot), 'daemon.json'), JSON.stringify({
        protocol_version: 1,
        workspace_id: computeWorkspaceId(workspaceRoot),
        workspace_root: fs.realpathSync(workspaceRoot),
        pid: process.pid,
        started_at: new Date().toISOString(),
        host: '127.0.0.1',
        port: 43210,
        token: 'a'.repeat(64),
    }));

    return workspaceRoot;
}

function createTransport({ timeoutMethod } = {}) {
    const requests = [];
    const httpImpl = {
        request(options, callback) {
            const request = new EventEmitter();
            let body = '';
            const observed = { method: null, timeout: options.timeout };
            requests.push(observed);

            request.write = (chunk) => { body += chunk.toString('utf8'); };
            request.end = () => {
                const payload = JSON.parse(body);
                observed.method = payload.method;
                queueMicrotask(() => {
                    if (payload.method === timeoutMethod) {
                        request.emit('timeout');
                        return;
                    }

                    const response = new EventEmitter();
                    response.statusCode = 200;
                    callback(response);
                    response.emit('data', Buffer.from(JSON.stringify({ result: { method: payload.method } })));
                    response.emit('end');
                });
            };
            request.destroy = () => { request.destroyed = true; };
            return request;
        },
    };

    return { httpImpl, requests };
}

test('daemon RPC operations request budgets sized for their bounded command work', async (t) => {
    const workspaceRoot = createWorkspace(t);
    const transport = createTransport();
    const client = createDaemonClient({ workspaceRoot, httpImpl: transport.httpImpl });
    const operations = [
        ['health', 500, () => client.health()],
        ['plan.register', 35_000, () => client.registerPlan('session', {})],
        ['quality.execute', 50 * 120_000 + 30_000, () => client.executeQualityCycle('session', 1)],
        ['completion.evaluate', 50 * 120_000 + 60_000, () => client.evaluateCompletion('session', {})],
        ['task.qc', 50 * 60_000 + 30_000, () => client.completeIsolatedTask('session', 'TASK-1', 1)],
        ['acceptance.correction.complete', 50 * 30_000 + 30_000,
            () => client.completeAcceptanceCorrection('session', {})],
    ];

    const observedOperations = [];
    for (const [method, expectedTimeout, invoke] of operations) {
        const result = await invoke();
        const observed = transport.requests.at(-1);
        assert.equal(result.method, method);
        assert.equal(observed.method, method);
        observedOperations.push({ method, expectedTimeout, actualTimeout: observed.timeout });
    }

    assert.deepEqual(observedOperations.map(({ method, expectedTimeout, actualTimeout }) => [method, actualTimeout]),
        operations.map(([method, expectedTimeout]) => [method, expectedTimeout]));
});

test('general timeout and per-request overrides remain effective', async (t) => {
    const workspaceRoot = createWorkspace(t);
    const transport = createTransport();
    const client = createDaemonClient({ workspaceRoot, timeoutMs: 777, httpImpl: transport.httpImpl });

    await client.status('session');
    assert.equal(transport.requests.at(-1).timeout, 777);

    const overriddenOperations = [
        ['health', 11, () => client.health({ timeoutMs: 11 })],
        ['plan.register', 22, () => client.registerPlan('session', {}, { timeoutMs: 22 })],
        ['quality.execute', 33, () => client.executeQualityCycle('session', 1, { timeoutMs: 33 })],
        ['completion.evaluate', 44, () => client.evaluateCompletion('session', {}, { timeoutMs: 44 })],
        ['task.qc', 55, () => client.completeIsolatedTask('session', 'TASK-1', 1, { timeoutMs: 55 })],
        ['acceptance.correction.complete', 66,
            () => client.completeAcceptanceCorrection('session', {}, { timeoutMs: 66 })],
    ];

    for (const [method, expectedTimeout, invoke] of overriddenOperations) {
        await invoke();
        const observed = transport.requests.at(-1);
        assert.equal(observed.method, method);
        assert.equal(observed.timeout, expectedTimeout);
    }
});

test('a timed-out mutation is sent once and reports an unknown outcome for same-session inspection', async (t) => {
    const workspaceRoot = createWorkspace(t);
    const transport = createTransport({ timeoutMethod: 'task.qc' });
    const client = createDaemonClient({ workspaceRoot, httpImpl: transport.httpImpl });

    await assert.rejects(
        () => client.completeIsolatedTask('session', 'TASK-1', 1, { timeoutMs: 1 }),
        (error) => {
            assert.equal(error.code, 'DUAL_CLIENT_TIMEOUT');
            assert.match(error.message, /outcome is unknown/i);
            assert.match(error.message, /same session/i);
            return true;
        }
    );

    assert.equal(transport.requests.length, 1);
    assert.equal(transport.requests[0].method, 'task.qc');
});
