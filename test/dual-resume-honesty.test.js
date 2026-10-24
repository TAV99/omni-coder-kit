'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startDaemonServer } = require('../lib/dual/daemon-server');
const http = require('node:http');
const { EventEmitter } = require('node:events');

async function fixture(t, runTask) {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-resume-honesty-'));
    const derived = { sessionId: 'SESSION-RESUME', sessionState: 'EXECUTING', planRevision: 1,
        tasks: { 'TASK-1': { owner: 'agy', state: 'ROUTED' } }, leases: {}, gates: {} };
    const authorityStore = { derive: () => derived, readEvents: () => [], verifyIntegrity: () => ({ valid: true }) };
    let handleRequest;
    t.mock.method(http, 'createServer', handler => {
        handleRequest = handler;
        const server = new EventEmitter();
        server.listen = (port, host, ready) => { ready(); };
        server.address = () => ({ port: 12345 });
        server.close = done => done();
        return server;
    });
    const daemon = await startDaemonServer({ workspaceRoot, authorityStore, orchestrator: { runTask } });
    t.after(async () => { await daemon.close(); fs.rmSync(workspaceRoot, { recursive: true, force: true }); });
    const rpc = method => new Promise((resolve, reject) => {
        const req = new EventEmitter();
        req.method = 'POST'; req.headers = { 'content-type': 'application/json' };
        const res = { writeHead() {}, end(body) {
            const response = JSON.parse(body);
            if (response.error) reject(new Error(JSON.stringify(response.error)));
            else resolve(response.result);
        } };
        handleRequest(req, res);
        req.emit('data', Buffer.from(JSON.stringify({ protocol_version: 1, workspace_id: daemon.workspaceId,
            token: daemon.token, method, params: { session_id: derived.sessionId } })));
        req.emit('end');
    });
    return { resumeSession: () => rpc('session.resume'), status: () => rpc('session.status') };
}

test('resume reports immediate worker startup failure in response and status', async t => {
    const client = await fixture(t, async () => { throw Object.assign(new Error('startup denied'), { code: 'STARTUP_DENIED' }); });
    const result = await client.resumeSession('SESSION-RESUME');
    assert.equal(result.resumed, false);
    assert.equal(result.worker_start.state, 'failed');
    assert.equal(result.worker_start.error.code, 'STARTUP_DENIED');
    const status = await client.status('SESSION-RESUME');
    assert.equal(status.worker_start.state, 'failed');
    assert.equal(status.worker_running, false);
});

test('resume does not await pipeline and exposes subsequent worker death through status', async t => {
    let rejectWorker;
    let received;
    const client = await fixture(t, (derived, options) => {
        received = options;
        return new Promise((resolve, reject) => { rejectWorker = reject; });
    });
    const result = await client.resumeSession('SESSION-RESUME');
    assert.deepEqual(received, { resume: true });
    assert.equal(result.resumed, true);
    assert.equal(result.worker_start.state, 'running');
    rejectWorker(Object.assign(new Error('late failure'), { code: 'LATE_FAILURE' }));
    await new Promise(resolve => setImmediate(resolve));
    const status = await client.status('SESSION-RESUME');
    assert.equal(status.worker_start.state, 'failed');
    assert.equal(status.worker_start.error.code, 'LATE_FAILURE');
    assert.equal(status.worker_running, false);
});

for (const [name, results] of [['no eligible task', []], ['lease busy', [{ skipped: true, reason: 'lease busy' }]],
    ['incomplete pipeline', [{ status: 'INCOMPLETE' }]]]) {
    test(`resume exposes ${name} as WORKER_NOT_STARTED`, async t => {
        const client = await fixture(t, async () => results);
        const result = await client.resumeSession('SESSION-RESUME');
        assert.equal(result.resumed, false);
        assert.equal(result.worker_start.state, 'failed');
        assert.equal(result.worker_start.error.code, 'WORKER_NOT_STARTED');
    });
}
