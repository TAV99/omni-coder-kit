'use strict';

// `omni ui` P6b (SPEC-SQUAD-P6 §5): the orchestrator PTY through the spawnPty
// seam — command from the binding, session pin/resume, env cleanup, ring buffer
// and re-attach, one typing tab, exit/restart, no node-pty, and the HTTP routes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { writeBinding } = require('../lib/squad/bindings');
const { createPtyHost, ensureSpawnHelper, childEnv } = require('../lib/ui/pty-host');
const { startUiServer } = require('../lib/ui/server');
const codex = require('../lib/squad/runtimes/codex');
const claude = require('../lib/squad/runtimes/claude');

const TOKEN = 'p'.repeat(43);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function project(t, orchestrator = { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' }) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-ui-pty-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.omni', 'squad'), { recursive: true });
    writeBinding(root, { schema_version: 1, preset: 'dual', updated_at: '2026-11-02T00:00:00Z', roles: {
        orchestrator, worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }], reviewer: null } });
    return root;
}

// A fake node-pty: records every call, lets the test emit output and exit.
function fakePty() {
    const spawns = [];
    const spawnPty = (command, args, options) => {
        const handlers = { data: [], exit: [] };
        const child = { command, args, options, writes: [], sizes: [], killed: null, pid: 4242 + spawns.length,
            onData: (fn) => handlers.data.push(fn), onExit: (fn) => handlers.exit.push(fn),
            write: (data) => child.writes.push(data), resize: (cols, rows) => child.sizes.push([cols, rows]),
            kill: (signal) => { child.killed = signal; },
            emit: (data) => handlers.data.forEach((fn) => fn(data)), exit: (exitCode, signal = 0) => handlers.exit.forEach((fn) => fn({ exitCode, signal })) };
        spawns.push(child);
        return child;
    };
    return { spawnPty, spawns };
}

const resolve = (runtime) => ({ found: true, command: `/fake/bin/${runtime.id}`, prefixArgs: [] });

function host(root, extra = {}) {
    const fake = fakePty();
    const ptyHost = createPtyHost({ projectRoot: root, spawnPty: fake.spawnPty, resolve,
        env: { PATH: '/usr/bin', HOME: '/home/x', CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_USE_BEDROCK: '1', CODEX_THREAD_ID: 't' }, ...extra });
    return { ptyHost, fake };
}

const savedSession = (root) => JSON.parse(fs.readFileSync(path.join(root, '.omni', 'ui', 'orchestrator.json'), 'utf8'));

test('adapters: interactiveCommand pins or resumes a session only where the CLI can', () => {
    const resolved = { found: true, command: '/bin/x', prefixArgs: [] };
    const base = { model: 'opus', cwd: '/work' };
    const id = '39921ea4-7099-4eeb-a137-278fc722b1e6';
    assert.deepEqual(claude.interactiveCommand({ ...base, session: { newId: id } }, { resolved }).args.slice(-2), ['--session-id', id]);
    assert.deepEqual(claude.interactiveCommand({ ...base, session: { resumeId: id } }, { resolved }).args.slice(-2), ['--resume', id]);
    assert.throws(() => claude.interactiveCommand({ ...base, session: { newId: 'bad id;rm' } }, { resolved }), { code: 'SQUAD_RUNTIME_BAD_TURN' });
    const resumed = codex.interactiveCommand({ model: 'gpt-6.1-sol', cwd: '/work', session: { resumeId: id } }, { resolved });
    assert.deepEqual(resumed.args.slice(0, 4), ['resume', id, '-m', 'gpt-6.1-sol']);
    assert.throws(() => codex.interactiveCommand({ model: 'gpt-6.1-sol', cwd: '/work', session: { newId: id } }, { resolved }), { code: 'SQUAD_RUNTIME_BAD_TURN' });
    assert.deepEqual(codex.interactiveCommand({ model: 'gpt-6.1-sol', cwd: '/work' }, { resolved }).args, ['-m', 'gpt-6.1-sol', '-C', '/work']);
});

test('start: the bound orchestrator runs in the project with a clean env; codex resume uses the id it printed', (t) => {
    const root = project(t);
    const { ptyHost, fake } = host(root);
    const status = ptyHost.start();
    assert.deepEqual([status.status, status.runtime, status.model], ['running', 'codex', 'gpt-6.1-sol']);
    const [child] = fake.spawns;
    assert.equal(child.command, '/fake/bin/codex');
    assert.deepEqual(child.args, ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"', '-C', root]);
    assert.equal(child.options.cwd, root);
    assert.equal(child.options.env.TERM, 'xterm-256color');
    assert.equal(child.options.env.PATH, '/usr/bin');
    assert.equal(child.options.env.CLAUDE_CODE_USE_BEDROCK, '1', 'user configuration is kept');
    for (const marker of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CODEX_THREAD_ID']) assert.equal(child.options.env[marker], undefined, marker);
    assert.throws(() => ptyHost.start(), { code: 'UI_PTY_RUNNING' });
    const id = '01a19ac3-9bd6-7e70-9543-2da5d2d9bae4';
    child.emit(`\x1b[2mTo continue this session, run \x1b[1mcodex resume ${id}\x1b[0m\r\n`);
    child.exit(0);
    assert.deepEqual([ptyHost.status().status, ptyHost.status().exit_code], ['exited', 0]);
    assert.deepEqual(ptyHost.status().resumable, { runtime: 'codex', session_id: id });
    ptyHost.start({ resume: true });
    assert.deepEqual(fake.spawns[1].args.slice(0, 2), ['resume', id]);
    fake.spawns[1].exit(1);
    ptyHost.start();
    assert.equal(fake.spawns[2].args.includes('resume'), false, 'a plain start is a new session');
});

test('start: claude gets a pinned session id, saved so the next start can resume exactly it', (t) => {
    const root = project(t, { runtime: 'claude', model: 'sonnet', effort: 'low' });
    const { ptyHost, fake } = host(root);
    ptyHost.start();
    const args = fake.spawns[0].args;
    const id = args[args.indexOf('--session-id') + 1];
    assert.match(id, UUID);
    assert.deepEqual(savedSession(root), { runtime: 'claude', session_id: id, started_at: savedSession(root).started_at });
    fake.spawns[0].exit(0);
    ptyHost.start({ resume: true });
    assert.deepEqual(fake.spawns[1].args.slice(-2), ['--resume', id]);
    assert.equal(fake.spawns[1].args.includes('--session-id'), false);
});

test('start: problems become a visible status, not a crash', (t) => {
    const root = project(t);
    const missing = createPtyHost({ projectRoot: root, spawnPty: fakePty().spawnPty, resolve: () => ({ found: false, reason: 'codex not on PATH' }) });
    assert.throws(() => missing.start(), { code: 'UI_PTY_NOT_FOUND' });
    assert.deepEqual([missing.status().status, missing.status().error], ['failed', 'codex not on PATH']);
    const none = createPtyHost({ projectRoot: root, spawnPty: null, unavailableReason: 'node-pty is not installed' });
    assert.deepEqual([none.status().available, none.status().reason], [false, 'node-pty is not installed']);
    assert.throws(() => none.start(), { code: 'UI_PTY_UNAVAILABLE' });
    fs.rmSync(path.join(root, '.omni', 'squad.local.json'));
    const unbound = host(root).ptyHost;
    assert.throws(() => unbound.start(), { code: 'UI_PTY_NO_BINDING' });
});

test('ring buffer: re-attach replays what was missed; a client too far behind gets a reset', (t) => {
    const root = project(t);
    const { ptyHost, fake } = host(root, { ringBytes: 300 });
    ptyHost.start();
    const child = fake.spawns[0];
    for (let i = 0; i < 10; i += 1) child.emit(`line-${i}-${'x'.repeat(40)}\r\n`);
    const fresh = ptyHost.attach(() => {});
    assert.equal(fresh.replay.reset, true, 'the start of the output left the ring');
    const kept = fresh.replay.chunks.map((chunk) => chunk.data).join('');
    assert.ok(kept.length <= 300 && kept.includes('line-9'));
    assert.equal(kept.includes('line-0-'), false);
    const lastSeq = fresh.replay.chunks.at(-1).seq;
    child.emit('after\r\n');
    const resumed = ptyHost.attach(() => {}, lastSeq);
    assert.deepEqual([resumed.replay.reset, resumed.replay.chunks.map((chunk) => chunk.data)], [false, ['after\r\n']]);
    assert.equal(ptyHost.attach(() => {}, 999).replay.reset, true, 'an id from the future replays everything');
});

test('one tab types at a time; another tab takes control; input, resize and limits', (t) => {
    const root = project(t);
    const { ptyHost, fake } = host(root);
    const seen = [];
    const first = ptyHost.attach((event, payload) => seen.push([event, payload && payload.seq]));
    const second = ptyHost.attach(() => {});
    assert.equal(ptyHost.status().writer, first.clientId, 'the first tab types');
    assert.throws(() => ptyHost.input(first.clientId, 'x'), { code: 'UI_PTY_STOPPED' });
    ptyHost.resize(first.clientId, 120, 40);
    ptyHost.start();
    const child = fake.spawns[0];
    assert.deepEqual([child.options.cols, child.options.rows], [120, 40], 'the size set before start is used');
    ptyHost.input(first.clientId, 'hello');
    ptyHost.input(first.clientId, '\r');
    assert.deepEqual(child.writes, ['hello', '\r']);
    assert.throws(() => ptyHost.input(second.clientId, 'x'), { code: 'UI_PTY_NOT_WRITER' });
    assert.throws(() => ptyHost.resize(second.clientId, 80, 24), { code: 'UI_PTY_NOT_WRITER' });
    ptyHost.claim(second.clientId);
    assert.throws(() => ptyHost.input(first.clientId, 'x'), { code: 'UI_PTY_NOT_WRITER' });
    ptyHost.input(second.clientId, 'y');
    ptyHost.resize(second.clientId, 80, 24);
    assert.deepEqual(child.sizes, [[80, 24]]);
    for (const [cols, rows] of [[1, 24], [80, 0], [80.5, 24], [2000, 24]]) {
        assert.throws(() => ptyHost.resize(second.clientId, cols, rows), { code: 'UI_PTY_INPUT' });
    }
    assert.throws(() => ptyHost.input(second.clientId, 'z'.repeat(64 * 1024 + 1)), { code: 'UI_PTY_INPUT' });
    assert.throws(() => ptyHost.claim('nobody'), { code: 'UI_PTY_CLIENT' });
    second.detach();
    assert.equal(ptyHost.status().writer, null, 'nobody types until a tab takes control');
    child.emit('out');
    assert.ok(seen.some(([event]) => event === 'data'), 'attached tabs receive output');
    ptyHost.stop();
    assert.equal(child.killed, 'SIGHUP');
});

test('env: parent-session markers are removed, everything else is kept', () => {
    const env = childEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/h', AI_AGENT: 'x' });
    assert.deepEqual(env, { PATH: '/bin', CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/h', TERM: 'xterm-256color', COLORTERM: 'truecolor' });
});

test('node-pty spawn-helper without the execute bit is fixed before the first spawn (V39)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-ui-helper-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const helper = path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(helper, '#!/bin/sh\n', { mode: 0o644 });
    ensureSpawnHelper(path.join(root, 'lib', 'index.js'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(helper).mode & 0o111, 0o111);
});

function request(port, { method = 'GET', url, headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: url,
            headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

const post = (port, action, body, headers = {}) => request(port, { method: 'POST', url: `/api/pty/${action}`,
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// Opens the PTY stream and collects SSE events until `done(events)` is true.
function ptyStream(port, done, headers = {}) {
    return new Promise((resolve, reject) => {
        const events = [];
        const req = http.get({ host: '127.0.0.1', port, path: '/api/pty/stream',
            headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
            let buffer = '';
            res.setEncoding('utf8');
            const stream = { events, close: () => req.destroy() };
            res.on('data', (chunk) => {
                buffer += chunk;
                let split;
                while ((split = buffer.indexOf('\n\n')) !== -1) {
                    const block = buffer.slice(0, split);
                    buffer = buffer.slice(split + 2);
                    const fields = {};
                    for (const line of block.split('\n')) {
                        const colon = line.indexOf(': ');
                        if (colon > 0) fields[line.slice(0, colon)] = line.slice(colon + 2);
                    }
                    if (fields.data !== undefined) events.push({ event: fields.event || 'message', id: fields.id, data: JSON.parse(fields.data) });
                }
                if (done(events)) resolve(stream);
            });
        });
        req.on('error', reject);
        setTimeout(() => reject(new Error(`stream timed out: ${JSON.stringify(events)}`)), 5000).unref();
    });
}

test('routes: token, JSON-only POSTs, SSE output with resume, input only from the typing tab', async (t) => {
    const root = project(t);
    const fake = fakePty();
    const ui = await startUiServer({ projectRoot: root, token: TOKEN, pty: { spawnPty: fake.spawnPty, hostOptions: { resolve } } });
    t.after(() => ui.close());
    const { port } = ui;
    assert.equal((await post(port, 'start', {}, { authorization: '' })).status, 403);
    assert.equal((await post(port, 'start', {}, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await request(port, { method: 'POST', url: '/api/pty/start', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415,
        'a plain form post cannot drive the terminal');
    assert.equal((await post(port, 'start', {})).status, 200);
    assert.equal((await post(port, 'start', {})).status, 409, 'already running');
    const state = JSON.parse((await request(port, { url: '/api/state' })).body);
    assert.deepEqual([state.pty.available, state.pty.status, state.pty.runtime], [true, 'running', 'codex']);
    const child = fake.spawns[0];
    child.emit('\x1b[32mready\x1b[0m');
    const first = await ptyStream(port, (events) => events.some((e) => e.event === 'message' && e.data.includes('ready')));
    const hello = first.events.find((e) => e.event === 'hello').data;
    assert.match(hello.client_id, UUID);
    const second = await ptyStream(port, (events) => events.some((e) => e.event === 'hello'));
    const other = second.events.find((e) => e.event === 'hello').data.client_id;
    assert.equal((await post(port, 'input', { client_id: hello.client_id, data: 'ls' })).status, 200);
    assert.equal((await post(port, 'input', { client_id: other, data: 'rm' })).status, 409);
    assert.equal((await post(port, 'claim', { client_id: other })).status, 200);
    assert.equal((await post(port, 'input', { client_id: other, data: '\r' })).status, 200);
    assert.equal((await post(port, 'resize', { client_id: other, cols: 132, rows: 43 })).status, 200);
    assert.deepEqual([child.writes, child.sizes], [['ls', '\r'], [[132, 43]]]);
    assert.equal((await request(port, { method: 'POST', url: '/api/pty/input', headers: { 'content-type': 'application/json' }, body: '{nope' })).status, 400);
    const lastId = first.events.filter((e) => e.event === 'message').at(-1).id;
    first.close();
    second.close();
    child.emit('later');
    const resumed = await ptyStream(port, (events) => events.some((e) => e.event === 'message'), { 'last-event-id': lastId });
    assert.deepEqual(resumed.events.filter((e) => e.event === 'message').map((e) => e.data), ['later'], 'only what was missed');
    child.exit(3);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(resumed.events.some((e) => e.event === 'state' && e.data.status === 'exited' && e.data.exit_code === 3));
    resumed.close();
});

test('routes: without node-pty the page still works and says why', async (t) => {
    const root = project(t);
    const ui = await startUiServer({ projectRoot: root, token: TOKEN, pty: { reason: 'node-pty is not installed' } });
    t.after(() => ui.close());
    const state = JSON.parse((await request(ui.port, { url: '/api/state' })).body);
    assert.deepEqual([state.pty.available, state.pty.reason], [false, 'node-pty is not installed']);
    assert.equal((await post(ui.port, 'start', {})).status, 503);
    assert.equal((await request(ui.port, { url: '/' })).status, 200);
});

test('routes: xterm assets are served from node_modules when installed', async (t) => {
    const root = project(t);
    const ui = await startUiServer({ projectRoot: root, token: TOKEN, pty: { reason: 'test' } });
    t.after(() => ui.close());
    let installed = true;
    try { require.resolve('@xterm/xterm'); } catch { installed = false; }
    for (const [url, type] of [['/vendor/xterm.js', /javascript/], ['/vendor/xterm.css', /css/], ['/vendor/addon-fit.js', /javascript/]]) {
        const res = await request(ui.port, { url, headers: { authorization: '' } });
        if (installed) { assert.equal(res.status, 200, url); assert.match(res.headers['content-type'], type); } else assert.equal(res.status, 404);
    }
    assert.equal((await request(ui.port, { url: '/vendor/../package.json' })).status, 404);
});

test('page: Enter is sent on its own, and server output is still only text', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ui', 'static', 'app.js'), 'utf8');
    assert.match(source, /split\(\/\(\\r\)\/\)/, 'keys are split around Enter');
    assert.match(source, /flushKeys\(\); ptyPost\('input', \{ client_id: pty\.client, data: '\\r' \}\)/);
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/);
});
