'use strict';

// SPEC-SQUAD-P8 §5 (P8b): `omni ui` without .omni/squad serves a setup mode that
// lists CLIs, preflights a binding without writing, and applies it through
// runSetup; workspace routes wait for apply, and setup approves nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startUiServer } = require('../lib/ui/server');
const { createSetupService } = require('../lib/ui/setup-service');
const { handleUi } = require('../lib/commands/ui');
const { tempDir, readyReports, registryWith } = require('./helpers/squad-project');

const TOKEN = 's'.repeat(43);
const BINDS = { orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    'worker-1': { runtime: 'agy', model: 'gemini-3.8-flash-high' } };

function project(t) {
    const root = tempDir(t, 'omni-ui-setup-');
    fs.mkdirSync(path.join(root, '.omni'), { recursive: true });
    fs.writeFileSync(path.join(root, '.omni', 'manifest.json'), JSON.stringify({ version: '3.2.0', ide: 'squad' }));
    return { root, home: tempDir(t, 'omni-ui-setup-home-') };
}

function request(port, { method = 'GET', url, body, headers = {} }) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `127.0.0.1:${port}`,
            authorization: `Bearer ${TOKEN}`, ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }));
        });
        req.on('error', reject);
        req.end(payload);
    });
}

async function serve(t, p, extra = {}) {
    let probes = 0;
    const registry = registryWith(readyReports());
    const counted = Object.create(registry);
    counted.probeAll = async (ctx) => { probes += 1; return registry.probeAll(ctx); };
    const ui = await startUiServer({ projectRoot: p.root, token: TOKEN, pty: { spawnPty: null, reason: 'test' },
        squadRegistry: counted, homedir: p.home, ...extra });
    t.after(() => ui.close());
    return { ui, probes: () => probes };
}

test('without .omni/squad the server starts in setup mode and workspace routes wait', async (t) => {
    const p = project(t);
    const { ui } = await serve(t, p);
    assert.equal(ui.mode(), 'setup');
    const state = await request(ui.port, { url: '/api/state' });
    assert.equal(state.status, 200);
    assert.equal(state.json.mode, 'setup');
    for (const url of ['/api/events', '/api/pty/stream', '/api/runtime-catalog', '/api/limits']) {
        const res = await request(ui.port, { url });
        assert.equal(res.status, 409, url);
        assert.equal(res.json.code, 'SQUAD_SETUP_REQUIRED', url);
    }
    const message = await request(ui.port, { method: 'POST', url: '/api/message', body: { to: 'all', body: 'hi' } });
    assert.equal(message.status, 409);
});

test('setup routes need the token and the same origin', async (t) => {
    const p = project(t);
    const { ui } = await serve(t, p);
    assert.equal((await request(ui.port, { url: '/api/setup/runtimes', headers: { authorization: 'Bearer wrong' } })).status, 403);
    assert.equal((await request(ui.port, { method: 'POST', url: '/api/setup/apply', body: { request_id: 'req-00000001' },
        headers: { origin: 'http://evil.example' } })).status, 403);
});

test('runtimes are probed once per cache window; refresh probes again', async (t) => {
    const p = project(t);
    const { ui, probes } = await serve(t, p);
    const first = await request(ui.port, { url: '/api/setup/runtimes' });
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.runtimes.map((r) => r.id).sort(), ['agy', 'codex']);
    assert.deepEqual(first.json.presets.squad.workers, [1, 8]);
    await request(ui.port, { url: '/api/setup/runtimes' });
    assert.equal(probes(), 1);
    await request(ui.port, { url: '/api/setup/runtimes?refresh=1' });
    assert.equal(probes(), 2);
});

test('preflight reports errors and trust without writing anything', async (t) => {
    const p = project(t);
    const { ui } = await serve(t, p);
    const before = fs.readdirSync(path.join(p.root, '.omni'));
    const good = await request(ui.port, { method: 'POST', url: '/api/setup/preflight', body: { preset: 'dual', binds: BINDS } });
    assert.equal(good.status, 200);
    assert.equal(good.json.ok, true);
    assert.ok(good.json.trust && typeof good.json.trust.status === 'string', 'trust verdict included');
    const bad = await request(ui.port, { method: 'POST', url: '/api/setup/preflight',
        body: { preset: 'dual', binds: { ...BINDS, orchestrator: { runtime: 'codex', model: 'no-such-model' } } } });
    assert.equal(bad.json.ok, false);
    assert.match(bad.json.errors[0].message, /no-such-model/);
    const missing = await request(ui.port, { method: 'POST', url: '/api/setup/preflight', body: { preset: 'dual', binds: {} } });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, 'UI_SETUP_INVALID');
    assert.deepEqual(fs.readdirSync(path.join(p.root, '.omni')), before);
});

test('apply runs squad setup, switches to workspace mode and refuses a second setup', async (t) => {
    const p = project(t);
    const { ui } = await serve(t, p);
    const body = { request_id: 'req-00000001', preset: 'dual', binds: BINDS, displace: true };
    const applied = await request(ui.port, { method: 'POST', url: '/api/setup/apply', body });
    assert.equal(applied.status, 200, JSON.stringify(applied.json));
    assert.equal(applied.json.mode, 'workspace');
    assert.ok(fs.existsSync(path.join(p.root, '.omni', 'squad', 'pipeline.yaml')));
    const local = JSON.parse(fs.readFileSync(path.join(p.root, '.omni', 'squad.local.json'), 'utf8'));
    assert.equal(local.roles.orchestrator.runtime, 'codex');
    assert.equal(fs.existsSync(path.join(p.root, '.omni', 'runs')), false, 'no ledger, no daemon session');
    assert.equal(ui.mode(), 'workspace');
    // Once set up, the setup routes close for good.
    assert.equal((await request(ui.port, { method: 'POST', url: '/api/setup/apply', body })).status, 409, 'setup routes close after apply');
    const state = await request(ui.port, { url: '/api/state' });
    assert.equal(state.json.mode, 'workspace');
});

test('apply is idempotent per request id and refuses while another apply runs', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'omni-setup-svc-'));
    try {
        const service = createSetupService({ root, registry: registryWith(readyReports()), homedir: root,
            runSetupImpl: async () => { calls += 1; await gate; return { created: ['x'], warnings: [] }; } });
        const body = { request_id: 'req-00000002', preset: 'dual', binds: BINDS };
        const first = service.apply(body);
        await assert.rejects(() => service.apply({ ...body, request_id: 'req-00000003' }), { code: 'UI_SETUP_BUSY' });
        release();
        const result = await first;
        assert.deepEqual(await service.apply(body), result);
        assert.equal(calls, 1);
        await assert.rejects(() => service.apply({ ...body, request_id: 'bad id' }), { code: 'UI_SETUP_INVALID' });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a project that is already set up never exposes setup routes', async (t) => {
    const p = project(t);
    fs.mkdirSync(path.join(p.root, '.omni', 'squad'), { recursive: true });
    const { ui } = await serve(t, p);
    assert.equal(ui.mode(), 'workspace');
    const res = await request(ui.port, { url: '/api/setup/runtimes' });
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'UI_SETUP_DONE');
});

test('omni ui starts in setup mode instead of exiting when .omni/squad is missing', async (t) => {
    const p = project(t);
    const cwd = process.cwd();
    const log = console.log;
    const lines = [];
    console.log = (line) => lines.push(String(line));
    let ui;
    try {
        process.chdir(p.root);
        ui = await handleUi({ open: false, start: false });
    } finally { process.chdir(cwd); console.log = log; }
    t.after(() => ui && ui.close());
    assert.ok(ui, 'the UI started');
    assert.equal(ui.mode(), 'setup');
    assert.ok(lines.some((line) => /trang thiết lập/.test(line)));
});

test('setup code has no route that approves a gate', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ui', 'setup-service.js'), 'utf8');
    assert.doesNotMatch(source, /approve|gate\.decide|approvals?\b/i);
});
