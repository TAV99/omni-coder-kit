'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startDaemonServer } = require('../lib/dual/daemon-server');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { expandCatalog, digest } = require('../lib/dual/spec-coverage');

test('daemon coverage RPC requires exact identity, barrier and explicit per-ID approval', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-coverage-rpc-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createAuthorityStore(path.join(root, '.omni/sessions/test'));
    // Exercise the real authenticated HTTP handler in memory: the sandbox cannot
    // bind loopback sockets. Only the socket is replaced, never RPC validation.
    let handler;
    t.mock.method(http, 'createServer', callback => {
        handler = callback;
        const server = new EventEmitter();
        server.listen = (_port, _host, ready) => ready();
        server.address = () => ({ port: 43210 });
        server.close = done => done();
        return server;
    });
    let implementLaunches = 0;
    const daemon = await startDaemonServer({ workspaceRoot: root, authorityStore: store,
        orchestrator: { runTask: async () => { implementLaunches++; return []; } } });
    t.after(() => daemon.close());
    const requestRpc = (method, params) => new Promise((resolve, reject) => {
        const req = new EventEmitter();
        req.method = 'POST'; req.headers = { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` };
        const res = { writeHead() {}, end(raw) {
            const payload = JSON.parse(raw);
            if (payload.error) reject(Object.assign(new Error(payload.error.message), payload.error));
            else resolve(payload.result);
        } };
        handler(req, res);
        req.emit('data', Buffer.from(JSON.stringify({ protocol_version: 1, method, params, workspace_id: daemon.workspaceId })));
        req.emit('end');
    });
    const client = {
        beginSession: params => requestRpc('session.begin', params),
        inspectCoverage: session_id => requestRpc('coverage.inspect', { session_id }),
        approveCoverage: params => requestRpc('coverage.approve', params),
    };
    await client.beginSession({ session_id: 'coverage-session', workspace_root: root, mode: 'auto', expected_base_commit: 'a'.repeat(40) });
    const artifact = { schema_version: 1, catalog_version: 1, revision: 1, app_types: ['core'],
        classification_sources: ['user:initial'], dimensions: expandCatalog(['core']).map(d => ({ id: d.id, state: 'unresolved', sources: [] })) };
    const raw = JSON.stringify(artifact);
    const plan = { schema_version: 2, plan_revision: 1, coverage: { path: '.omni/sdlc/spec-coverage.json', sha256: digest(raw), catalog_version: 1 }, acceptance_policy: { protocol_version: 1, checks: [{ id: 'check', requirement_id: 'req', phase: 'session', kind: 'command', required: true, command: { program: 'node', args: ['--version'], cwd: '.' } }] },
        tasks: [{ task_id: 'TASK-1', title: 'Feature', owner: 'codex', goal: 'Feature', category: 'feature', complexity: 'small', risk: 'low', allowed_files: ['src/a.js'], context_files: [], deny_patterns: [], validation_commands: [], decision_ids: artifact.dimensions.map(d => d.id) }] };
    const dir = path.join(root, '.omni/sdlc'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'spec-coverage.json'), raw);
    fs.writeFileSync(path.join(dir, 'dual-plan.json'), JSON.stringify(plan));
    const originalDerive = store.derive.bind(store);
    t.mock.method(store, 'derive', () => ({ ...originalDerive(), plan: { schema_version: 2, plan_path: '.omni/sdlc/dual-plan.json', plan_sha256: digest(JSON.stringify(plan)) } }));
    const blocked = await requestRpc('session.resume', { session_id: 'coverage-session' });
    assert.equal(blocked.resumed, false);
    assert.equal(blocked.code, 'SPEC_COVERAGE_REQUIRED');
    assert.equal(implementLaunches, 0);
    assert.equal(Object.keys(store.derive().leases).length, 0);
    const completion = await requestRpc('completion.evaluate', { session_id: 'coverage-session' });
    assert.equal(completion.verified, false);
    assert.ok(completion.blockers.includes('SPEC_COVERAGE_REQUIRED'));
    assert.ok(completion.blockers.some(blocker => blocker !== 'SPEC_COVERAGE_REQUIRED'),
        'coverage must preserve the other completion blockers');
    const inspect = await client.inspectCoverage('coverage-session');
    assert.equal(inspect.state, 'DRAFT');
    const request = { request_id: 'approval-1', actor: 'user', source: 'user-message:1', session_id: 'coverage-session',
        workspace: daemon.workspaceId, plan_revision: 1, candidate_digest: digest(artifact),
        decisions: artifact.dimensions.map(d => ({ id: d.id, state: 'delegated', constraints: [] })) };
    await assert.rejects(client.approveCoverage(request), e => e.code === 'INVALID_COVERAGE');
    const baseline = store.derive().currentBaseline;
    const contextPath = '.omni/sdlc/scout-context.json';
    fs.writeFileSync(path.join(root, contextPath), JSON.stringify({ task_id: 'TASK-1', coverage_findings: [] }));
    fs.writeFileSync(path.join(dir, 'spec-coverage.reconnaissance.json'), JSON.stringify({ schema_version: 1,
        plan_sha256: digest(JSON.stringify(plan)), baseline, task_ids: ['TASK-1'], contexts: [{ path: contextPath, sha256: digest(fs.readFileSync(path.join(root, contextPath))) }] }));
    assert.equal((await client.inspectCoverage('coverage-session')).state, 'AWAITING_APPROVAL');
    await assert.rejects(client.approveCoverage({ ...request, workspace: 'wrong' }), e => e.code === 'STALE_COVERAGE');
    const approved = await client.approveCoverage(request);
    assert.equal(approved.state, 'PASSED');
    assert.equal((await client.inspectCoverage('coverage-session')).state, 'PASSED');
    assert.deepEqual(await client.approveCoverage(request), approved);
    await assert.rejects(client.approveCoverage({ ...request, actor: 'different' }), e => e.code === 'APPROVAL_REQUEST_CONFLICT');
    assert.equal(fs.readFileSync(path.join(dir, 'spec-coverage.json'), 'utf8'), raw);
});
