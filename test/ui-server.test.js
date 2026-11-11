'use strict';

// `omni ui` P6a (SPEC-SQUAD-P6 §2–§3, V44): loopback server with token, Host and
// Origin checks, sidebar state from the squad files and ledger, the SSE timeline
// with Last-Event-ID resume, and no write path at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const gates = require('../lib/dual/approval-gates');
const { writeBinding } = require('../lib/squad/bindings');
const { startUiServer } = require('../lib/ui/server');
const { buildState } = require('../lib/ui/state');
const feed = require('../lib/ui/feed');
const { handleUi, openBrowser } = require('../lib/commands/ui');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'squad');
const TOKEN = 't'.repeat(43);

function project(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-ui-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const squadDir = path.join(root, '.omni', 'squad');
    fs.mkdirSync(path.join(squadDir, 'roles'), { recursive: true });
    for (const name of fs.readdirSync(path.join(TEMPLATES, 'roles'))) {
        fs.copyFileSync(path.join(TEMPLATES, 'roles', name), path.join(squadDir, 'roles', name));
    }
    fs.copyFileSync(path.join(TEMPLATES, 'pipelines', 'dual.yaml'), path.join(squadDir, 'pipeline.yaml'));
    writeBinding(root, { schema_version: 1, preset: 'dual', updated_at: '2026-11-01T00:00:00Z', roles: {
        orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
        worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }], reviewer: null } });
    return root;
}

function session(root) {
    const store = createAuthorityStore(path.join(root, '.omni', 'runs', 'dual-authority'));
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'ws-ui', session_id: 'session-ui', plan_revision: 1, expected_baseline: { kind: 'git', id: 'c'.repeat(40) }, mode: 'auto' });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: { agy_version: '1.1.27-test', agy_model: 'gemini-3.8-flash-high' } });
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'spec.md', plan_sha256: 'b'.repeat(64), total_tasks: 1,
        tasks: [{ task_id: 'TASK-1', title: '<img src=x onerror=alert(1)>', goal: 'Return two', owner: 'agy', risk: 'low',
            execution_mode: 'isolated', allowed_files: ['index.js'], context_files: ['spec.md'], deny_patterns: [],
            validation_commands: [{ program: 'node', args: ['--check', 'index.js'], cwd: '.' }] }] });
    gates.requireApproval(store, { phase: 'integrate', taskId: 'TASK-1', digest: 'a'.repeat(64), summary: 'merge TASK-1' });
    return store;
}

function journal(root, lines, name = 'd-1') {
    const file = path.join(root, '.omni', 'runs', 'dual-discussion', name, 'journal.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, lines);
    return file;
}

function request(port, { method = 'GET', url = '/api/state', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

// Reads SSE `entry` events until `count` arrive, then hangs up.
function stream(port, { count, headers = {} }) {
    return new Promise((resolve, reject) => {
        const events = [];
        const req = http.get({ host: '127.0.0.1', port, path: '/api/events',
            headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
            let buffer = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                buffer += chunk;
                let split;
                while ((split = buffer.indexOf('\n\n')) !== -1) {
                    const block = buffer.slice(0, split);
                    buffer = buffer.slice(split + 2);
                    const fields = Object.fromEntries(block.split('\n').filter((line) => /^(id|event|data): /.test(line))
                        .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
                    if (fields.event === 'entry') events.push({ id: fields.id, ...JSON.parse(fields.data) });
                }
                if (events.length >= count) { req.destroy(); resolve({ events, headers: res.headers }); }
            });
        });
        req.on('error', (error) => { if (events.length < count) reject(error); });
        setTimeout(() => { req.destroy(); resolve({ events, timedOut: true }); }, 5000).unref();
    });
}

async function serve(t, root, options = {}) {
    const ui = await startUiServer({ projectRoot: root, token: TOKEN, pollMs: 30, ...options });
    t.after(() => ui.close());
    return ui;
}

function tree(dir) {
    const out = {};
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else { const stat = fs.statSync(full); out[path.relative(dir, full)] = `${stat.size}:${stat.mtimeMs}`; }
        }
    };
    walk(dir);
    return out;
}

test('security: loopback only, token in the fragment, wrong Host/Origin/token → 403 on every route', async (t) => {
    const root = project(t);
    const ui = await serve(t, root);
    assert.equal(ui.url, `http://127.0.0.1:${ui.port}/workspace/#token=${TOKEN}`);
    assert.equal(ui.classicUrl, `http://127.0.0.1:${ui.port}/#token=${TOKEN}`);
    const port = ui.port;
    const bearer = { authorization: `Bearer ${TOKEN}` };
    for (const url of ['/', '/app.js', '/api/state', '/api/events']) {
        assert.equal((await request(port, { url, headers: { host: `evil.example:${port}`, ...bearer } })).status, 403, `Host ${url}`);
        assert.equal((await request(port, { url, headers: { host: `127.0.0.1:${port + 1}`, ...bearer } })).status, 403, `port ${url}`);
        assert.equal((await request(port, { url, headers: { origin: 'http://evil.example', ...bearer } })).status, 403, `Origin ${url}`);
    }
    for (const url of ['/api/state', '/api/events']) {
        assert.equal((await request(port, { url })).status, 403, `no token ${url}`);
        assert.equal((await request(port, { url, headers: { authorization: `Bearer ${'x'.repeat(43)}` } })).status, 403);
        assert.equal((await request(port, { url, headers: { cookie: `omni_ui=${'x'.repeat(43)}` } })).status, 403);
    }
    const page = await request(port, { url: '/' });
    assert.equal(page.status, 200, 'the page loads before the token is known');
    assert.doesNotMatch(page.body, new RegExp(TOKEN));
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    const state = await request(port, { headers: { ...bearer, host: `localhost:${port}`, origin: `http://localhost:${port}` } });
    assert.equal(state.status, 200);
    const login = await request(port, { method: 'POST', url: '/api/login', headers: bearer });
    assert.equal(login.status, 200);
    assert.match(login.headers['set-cookie'][0], /^omni_ui=t+; HttpOnly; SameSite=Strict; Path=\/$/);
    assert.equal((await request(port, { headers: { cookie: `a=b; omni_ui=${TOKEN}` } })).status, 200);
});

test('no route approves or writes the ledger by itself; the server binds 127.0.0.1 only', async (t) => {
    const root = project(t);
    session(root);
    const ui = await serve(t, root);
    const bearer = { authorization: `Bearer ${TOKEN}` };
    // POST /api/message exists since P6c but only takes JSON (test/dual-inbox.test.js).
    assert.equal((await request(ui.port, { method: 'POST', url: '/api/message', headers: bearer })).status, 415);
    for (const [method, url] of [['POST', '/api/approve'], ['POST', '/api/state'], ['PUT', '/api/state'],
        ['POST', '/api/gates/integrate-TASK-1'], ['DELETE', '/api/events'], ['GET', '/../.omni/squad.local.json'], ['GET', '/api/../index.html']]) {
        assert.equal((await request(ui.port, { method, url, headers: bearer })).status, 404, `${method} ${url}`);
    }
    const before = tree(path.join(root, '.omni', 'runs'));
    await request(ui.port, { headers: bearer });
    await stream(ui.port, { count: 3 });
    await request(ui.port, { method: 'POST', url: '/api/login', headers: bearer });
    assert.deepEqual(tree(path.join(root, '.omni', 'runs')), before, 'nothing under .omni/runs changed');
    assert.equal(createAuthorityStore(path.join(root, '.omni', 'runs', 'dual-authority')).derive().approvals['integrate-TASK-1'].status, 'pending');
    await assert.rejects(new Promise((resolve, reject) => {
        const socket = require('node:net').connect({ host: '::1', port: ui.port });
        socket.on('connect', () => { socket.destroy(); resolve(); });
        socket.on('error', reject);
    }), 'not listening on IPv6 loopback either');
});

test('state: roles, pipeline, tasks, pending gates with the approve command; works with no session', async (t) => {
    const root = project(t);
    const empty = buildState(root);
    assert.deepEqual([empty.session, empty.tasks, empty.gates], [null, [], []]);
    assert.deepEqual(empty.roles.map((role) => [role.id, role.runtime]), [['orchestrator', 'codex'], ['worker-1', 'agy']]);
    assert.ok(empty.pipeline.some((phase) => phase.id === 'integrate'));
    session(root);
    const ui = await serve(t, root);
    const state = JSON.parse((await request(ui.port, { headers: { authorization: `Bearer ${TOKEN}` } })).body);
    assert.equal(state.session.id, 'session-ui');
    assert.deepEqual(state.tasks.map((task) => [task.task_id, task.state, task.worker, task.owner_role]), [['TASK-1', 'REGISTERED', 'worker-1', 'worker']]);
    assert.equal(state.tasks[0].title, '<img src=x onerror=alert(1)>', 'kept as data; the page renders it as text');
    assert.deepEqual(state.gates.map((gate) => [gate.gate_id, gate.command]), [['integrate-TASK-1', 'omni squad approve integrate-TASK-1']]);
    assert.equal(JSON.stringify(state).includes(gates.confirmationCode(state.gates[0])), false, 'the confirmation code stays in the TTY');
    assert.deepEqual(state.errors, []);
});

test('feed: partial trailing lines wait, cursors resume exactly, bad cursors are ignored', (t) => {
    const root = project(t);
    session(root);
    const file = journal(root, `${JSON.stringify({ timestamp: Date.parse('2026-11-02T00:00:00Z'), event: { envelope: { kind: 'question', body: 'x'.repeat(900) } } })}\n{"event":{"type":"par`);
    const first = feed.readSince(root);
    const ledgerCount = first.entries.filter((entry) => entry.source === 'ledger').length;
    assert.ok(ledgerCount >= 4);
    const discussion = first.entries.filter((entry) => entry.source === 'discussion');
    assert.equal(discussion.length, 1, 'the partial second line is not read yet');
    assert.equal(discussion[0].fields.kind, 'question');
    assert.equal(discussion[0].fields.body.length, 601, 'long bodies are clipped');
    assert.equal(discussion[0].journal, '.omni/runs/dual-discussion/d-1/journal.jsonl');
    assert.equal(feed.readSince(root, first.cursor).entries.length, 0);
    fs.appendFileSync(file, 'tial","completion":"done"}}\n');
    const second = feed.readSince(root, first.cursor);
    assert.deepEqual(second.entries.map((entry) => [entry.source, entry.type, entry.fields.completion]), [['discussion', 'partial', 'done']]);
    // Every entry's cursor resumes right after it.
    const middle = first.entries[1];
    const resumed = feed.readSince(root, feed.decodeCursor(middle.cursor)).entries;
    assert.deepEqual(resumed.map((entry) => entry.cursor), [...first.entries.slice(2), ...second.entries].map((entry) => entry.cursor));
    for (const bad of [undefined, '', 'not-base64!', feed.encodeCursor({ l: -1, j: {} }), feed.encodeCursor([1])]) {
        assert.equal(feed.decodeCursor(bad), null);
    }
    assert.deepEqual(feed.decodeCursor(feed.encodeCursor({ l: 2, j: { a: 1, b: -3 } })), { l: 2, j: { a: 1 } });
});

test('SSE: ledger events in order, live tail, Last-Event-ID resumes with no gap and no repeat', async (t) => {
    const root = project(t);
    const store = session(root);
    const ui = await serve(t, root);
    const total = feed.readSince(root).entries.length;
    const first = await stream(ui.port, { count: total });
    assert.equal(first.headers['content-type'], 'text/event-stream; charset=utf-8');
    const sequences = first.events.filter((event) => event.source === 'ledger').map((event) => event.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    assert.equal(first.events[0].type, 'session.created');
    const cut = first.events[1];
    gates.requireApproval(store, { phase: 'integrate', taskId: 'TASK-2', digest: 'd'.repeat(64), summary: 'merge TASK-2' });
    journal(root, `${JSON.stringify({ event: { response_envelope: { kind: 'answer', body: 'ok' } } })}\n`);
    const resumed = await stream(ui.port, { count: total, headers: { 'last-event-id': cut.id } });
    assert.deepEqual(resumed.events.slice(0, total - 2).map((event) => event.id), first.events.slice(2).map((event) => event.id));
    assert.deepEqual(resumed.events.slice(total - 2).map((event) => event.type).sort(), ['gate.requested', 'reply']);
    const live = stream(ui.port, { count: total + 3 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    journal(root, `${JSON.stringify({ event: { envelope: { kind: 'note', body: 'later' } } })}\n`);
    const tail = await live;
    assert.equal(tail.events.at(-1).fields.body, 'later', 'new lines reach an open stream');
});

test('workspace page: served at /workspace/, static files stay inside it, needs no inline script', async (t) => {
    const root = project(t);
    const ui = await serve(t, root);
    const get = (pathname) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: ui.port, path: pathname, headers: { Host: `127.0.0.1:${ui.port}` } }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
        }).on('error', reject);
    });
    const page = await get('/workspace/');
    assert.equal(page.status, 200);
    assert.match(page.type, /^text\/html/);
    assert.match(page.body, /<script type="module" src="\/workspace\/app\.mjs"><\/script>/);
    assert.doesNotMatch(page.body, /<script>|\son\w+=|https?:\/\/(?!127)/, 'no inline script, handlers or remote assets (CSP self)');
    assert.match((await get('/workspace/app.mjs')).type, /^text\/javascript/);
    assert.equal((await get('/workspace/workspace.css')).status, 200);
    assert.equal((await get('/workspace/../server.js')).status, 404);
    assert.equal((await get('/workspace/%2e%2e/server.js')).status, 404);
    assert.equal((await get('/')).status, 200, 'the P6 page stays as a fallback');
});

test('binding preflight: knows the built-in runtimes without a registry option', async (t) => {
    const root = project(t);
    const ui = await serve(t, root);
    const candidate = { schema_version: 1, preset: 'squad', roles: {
        orchestrator: { runtime: 'claude', model: 'sonnet', effort: 'low' },
        worker: [{ id: 'worker-1', runtime: 'claude', model: 'sonnet', effort: 'low' }],
        reviewer: { runtime: 'codex', model: 'gpt-6-luna', effort: 'low' } } };
    const res = await request(ui.port, { method: 'POST', url: '/api/bindings/preflight',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ candidate }) });
    assert.equal(res.status, 200, res.body);
    const { errors = [] } = JSON.parse(res.body);
    assert.deepEqual(errors.filter((e) => /unknown runtime/.test(e.message)), []);
});

test('page: renders server data only through textContent', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ui', 'static', 'app.js'), 'utf8');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    const html = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ui', 'static', 'index.html'), 'utf8');
    assert.doesNotMatch(html, /<script>|\son\w+=|https?:\/\/(?!127)/, 'no inline script, handlers or remote assets (CSP self)');
});

test('omni ui: needs a squad project, rejects a bad port, opens the right browser command', async (t) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-ui-cmd-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cwd = process.cwd();
    const exitCode = process.exitCode;
    const errors = [];
    const original = console.error;
    console.error = (line) => errors.push(line);
    try {
        process.chdir(root);
        assert.equal(await handleUi({ open: false }), null);
        fs.mkdirSync(path.join(root, '.omni', 'squad'), { recursive: true });
        assert.equal(await handleUi({ open: false, port: '99999' }), null);
    } finally {
        process.chdir(cwd);
        console.error = original;
        process.exitCode = exitCode;
    }
    assert.match(errors[0], /omni squad setup/);
    assert.match(errors[1], /--port/);
    const calls = [];
    const spawnImpl = (command, args) => { calls.push([command, args]); return { on() {}, unref() {} }; };
    for (const platform of ['darwin', 'linux', 'win32']) openBrowser('http://127.0.0.1:1/#token=a&b', { platform, spawnImpl });
    assert.deepEqual(calls.map(([command]) => command), ['open', 'xdg-open', 'cmd']);
    assert.equal(calls[2][1].at(-1), 'http://127.0.0.1:1/#token=a^&b');
    assert.equal(openBrowser('x', { spawnImpl: () => { throw new Error('ENOENT'); } }), false);
});
