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

// SPEC-SQUAD-P3 §5.3 (H5, Q-P3-4): with a squad pipeline the agent's
// coverage.approve only prepares; the person's gate.decide applies it.
test('squad project: coverage.approve waits for the spec gate and the approval applies the exact submission', async t => {
    const gates = require('../lib/dual/approval-gates');
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-coverage-gate-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const templates = path.join(__dirname, '..', 'templates', 'squad');
    fs.mkdirSync(path.join(root, '.omni/squad/roles'), { recursive: true });
    for (const name of fs.readdirSync(path.join(templates, 'roles'))) fs.copyFileSync(path.join(templates, 'roles', name), path.join(root, '.omni/squad/roles', name));
    fs.copyFileSync(path.join(templates, 'pipelines', 'dual.yaml'), path.join(root, '.omni/squad/pipeline.yaml'));
    const store = createAuthorityStore(path.join(root, '.omni/sessions/test'));
    let handler;
    t.mock.method(http, 'createServer', callback => {
        handler = callback;
        const server = new EventEmitter();
        server.listen = (_port, _host, ready) => ready();
        server.address = () => ({ port: 43211 });
        server.close = done => done();
        return server;
    });
    let runs = 0;
    const daemon = await startDaemonServer({ workspaceRoot: root, authorityStore: store, orchestrator: { runTask: async () => { runs++; return []; } } });
    t.after(() => daemon.close());
    const rpc = (method, params) => new Promise((resolve, reject) => {
        const req = new EventEmitter();
        req.method = 'POST'; req.headers = { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` };
        handler(req, { writeHead() {}, end(raw) {
            const payload = JSON.parse(raw);
            if (payload.error) reject(Object.assign(new Error(payload.error.message), payload.error)); else resolve(payload.result);
        } });
        req.emit('data', Buffer.from(JSON.stringify({ protocol_version: 1, method, params, workspace_id: daemon.workspaceId })));
        req.emit('end');
    });
    await rpc('session.begin', { session_id: 'gate-session', workspace_root: root, mode: 'auto', expected_base_commit: 'a'.repeat(40) });
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
    const contextPath = '.omni/sdlc/scout-context.json';
    fs.writeFileSync(path.join(root, contextPath), JSON.stringify({ task_id: 'TASK-1', coverage_findings: [] }));
    fs.writeFileSync(path.join(dir, 'spec-coverage.reconnaissance.json'), JSON.stringify({ schema_version: 1,
        plan_sha256: digest(JSON.stringify(plan)), baseline: store.derive().currentBaseline, task_ids: ['TASK-1'],
        contexts: [{ path: contextPath, sha256: digest(fs.readFileSync(path.join(root, contextPath))) }] }));
    const request = { request_id: 'approval-1', actor: 'user', source: 'user-message:1', session_id: 'gate-session',
        workspace: daemon.workspaceId, plan_revision: 1, candidate_digest: digest(artifact),
        decisions: artifact.dimensions.map(d => ({ id: d.id, state: 'delegated', constraints: [] })) };

    const prepared = await rpc('coverage.approve', request);
    assert.deepEqual([prepared.approved, prepared.status, prepared.gate.gate_id], [false, 'AWAITING_HUMAN_APPROVAL', 'spec-r1']);
    assert.equal((await rpc('coverage.inspect', { session_id: 'gate-session' })).state, 'AWAITING_APPROVAL', 'the agent alone approved nothing');
    const status = await rpc('session.status', { session_id: 'gate-session' });
    assert.equal(status.awaiting_gate.gate_id, 'spec-r1');
    assert.match(status.awaiting_gate.how, /omni squad approve spec-r1/);
    await assert.rejects(rpc('gate.decide', { session_id: 'gate-session', gate_id: 'spec-r1', approve: true, code: 'nope00' }),
        e => e.code === 'SQUAD_GATE_CODE_MISMATCH');
    const decided = await rpc('gate.decide', { session_id: 'gate-session', gate_id: 'spec-r1', approve: true,
        code: gates.confirmationCode(status.approvals['spec-r1']) });
    assert.equal(decided.gate.status, 'approved');
    assert.equal(decided.applied.state, 'PASSED');
    assert.equal((await rpc('coverage.inspect', { session_id: 'gate-session' })).state, 'PASSED');

    // Plan gate: a planned session does not start any task before the person approves the plan.
    t.mock.method(store, 'derive', () => ({ ...originalDerive(), sessionState: 'PLANNED',
        plan: { schema_version: 2, plan_path: '.omni/sdlc/dual-plan.json', plan_sha256: digest(JSON.stringify(plan)), total_tasks: 1 } }));
    await rpc('session.resume', { session_id: 'gate-session' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs, 0);
    const held = await rpc('session.status', { session_id: 'gate-session' });
    const planGate = held.approvals['plan-r1'];
    assert.deepEqual([planGate.status, planGate.digest], ['pending', digest(JSON.stringify(plan))]);
    assert.deepEqual([held.worker_start.state, held.worker_start.gate_id], ['awaiting_approval', 'plan-r1']);
    await rpc('gate.decide', { session_id: 'gate-session', gate_id: 'plan-r1', approve: true, code: gates.confirmationCode(planGate) });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.notEqual((await rpc('session.status', { session_id: 'gate-session' })).worker_start.state, 'awaiting_approval',
        'approving the plan releases the held-back dispatch');
});

test('a recorded spec decision whose application fails is reported as DUAL_GATE_APPLY_FAILED, never corruption (P7f)', async t => {
    const gates = require('../lib/dual/approval-gates');
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dual-coverage-gate-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const templates = path.join(__dirname, '..', 'templates', 'squad');
    fs.mkdirSync(path.join(root, '.omni/squad/roles'), { recursive: true });
    for (const name of fs.readdirSync(path.join(templates, 'roles'))) fs.copyFileSync(path.join(templates, 'roles', name), path.join(root, '.omni/squad/roles', name));
    fs.copyFileSync(path.join(templates, 'pipelines', 'dual.yaml'), path.join(root, '.omni/squad/pipeline.yaml'));
    const store = createAuthorityStore(path.join(root, '.omni/sessions/test'));
    let handler;
    t.mock.method(http, 'createServer', callback => {
        handler = callback;
        const server = new EventEmitter();
        server.listen = (_port, _host, ready) => ready();
        server.address = () => ({ port: 43212 });
        server.close = done => done();
        return server;
    });
    let runs = 0;
    const daemon = await startDaemonServer({ workspaceRoot: root, authorityStore: store, orchestrator: { runTask: async () => { runs++; return []; } } });
    t.after(() => daemon.close());
    const rpc = (method, params) => new Promise((resolve, reject) => {
        const req = new EventEmitter();
        req.method = 'POST'; req.headers = { 'content-type': 'application/json', authorization: `Bearer ${daemon.token}` };
        handler(req, { writeHead() {}, end(raw) {
            const payload = JSON.parse(raw);
            if (payload.error) reject(Object.assign(new Error(payload.error.message), payload.error)); else resolve(payload.result);
        } });
        req.emit('data', Buffer.from(JSON.stringify({ protocol_version: 1, method, params, workspace_id: daemon.workspaceId })));
        req.emit('end');
    });
    await rpc('session.begin', { session_id: 'gate-session', workspace_root: root, mode: 'auto', expected_base_commit: 'a'.repeat(40) });
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
    const contextPath = '.omni/sdlc/scout-context.json';
    fs.writeFileSync(path.join(root, contextPath), JSON.stringify({ task_id: 'TASK-1', coverage_findings: [] }));
    fs.writeFileSync(path.join(dir, 'spec-coverage.reconnaissance.json'), JSON.stringify({ schema_version: 1,
        plan_sha256: digest(JSON.stringify(plan)), baseline: store.derive().currentBaseline, task_ids: ['TASK-1'],
        contexts: [{ path: contextPath, sha256: digest(fs.readFileSync(path.join(root, contextPath))) }] }));
    const request = { request_id: 'approval-1', actor: 'user', source: 'user-message:1', session_id: 'gate-session',
        workspace: daemon.workspaceId, plan_revision: 1, candidate_digest: digest(artifact),
        decisions: artifact.dimensions.map(d => ({ id: d.id, state: 'delegated', constraints: [] })) };

    const prepared = await rpc('coverage.approve', request);
    assert.deepEqual([prepared.approved, prepared.status, prepared.gate.gate_id], [false, 'AWAITING_HUMAN_APPROVAL', 'spec-r1']);
    assert.equal((await rpc('coverage.inspect', { session_id: 'gate-session' })).state, 'AWAITING_APPROVAL', 'the agent alone approved nothing');
    const status = await rpc('session.status', { session_id: 'gate-session' });
    assert.equal(status.awaiting_gate.gate_id, 'spec-r1');
    assert.match(status.awaiting_gate.how, /omni squad approve spec-r1/);
    await assert.rejects(rpc('gate.decide', { session_id: 'gate-session', gate_id: 'spec-r1', approve: true, code: 'nope00' }),
        e => e.code === 'SQUAD_GATE_CODE_MISMATCH');
    // Coverage falls back to DRAFT before the person decides: the decision is durable, applying it fails.
    fs.unlinkSync(path.join(dir, 'spec-coverage.reconnaissance.json'));
    await assert.rejects(rpc('gate.decide', { session_id: 'gate-session', gate_id: 'spec-r1', approve: true,
        code: gates.confirmationCode(status.approvals['spec-r1']) }),
    e => e.code === 'DUAL_GATE_APPLY_FAILED' && /spec-r1 was recorded/.test(e.message));
    const after = await rpc('session.status', { session_id: 'gate-session' });
    assert.deepEqual([after.approvals['spec-r1'].status, after.approvals['spec-r1'].actor, after.approvals['spec-r1'].via], ['approved', 'human', 'cli-tty']);
});
