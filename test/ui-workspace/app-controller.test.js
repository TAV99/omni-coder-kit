'use strict';

// The workspace page controller (lib/ui/static/workspace/app.mjs): API
// error shapes, feed → timeline mapping, binding candidate, and the terminal
// client's SSE/input contract with the real server routes.

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../lib/ui/static/workspace/app.mjs');

test('api client: reads both error shapes and keeps message ids stable per call', async () => {
    const { createApiClient, errorFrom } = await load();
    assert.deepEqual([errorFrom(409, { error: 'no squad session yet', code: 'UI_MESSAGE_NO_SESSION' }).message, errorFrom(409, { error: 'x', code: 'C' }).code],
        ['no squad session yet', 'C']);
    const typed = errorFrom(400, { error: { code: 'BAD', message: 'bad thing', retryable: false } });
    assert.deepEqual([typed.message, typed.code, typed.status], ['bad thing', 'BAD', 400]);

    const calls = [];
    const api = createApiClient({
        uuid: () => '11111111-2222-4333-8444-555555555555',
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            if (url === '/api/message') return { ok: false, status: 409, text: async () => JSON.stringify({ error: 'no session', code: 'UI_MESSAGE_NO_SESSION' }) };
            return { ok: true, status: 200, text: async () => JSON.stringify({ revision: 'r2' }) };
        },
    });
    await assert.rejects(api.sendMessage({ message: 'hi', to: 'worker-1' }), (err) => err.code === 'UI_MESSAGE_NO_SESSION' && err.status === 409);
    assert.deepEqual(JSON.parse(calls[0].init.body), { message_id: '11111111-2222-4333-8444-555555555555', to: 'worker-1', body: 'hi' });
    assert.equal(calls[0].init.credentials, 'same-origin');
    assert.deepEqual(await api.savePreferences({ revision: 'r1', theme: 'paper' }), { revision: 'r2' });
    assert.deepEqual(JSON.parse(calls[1].init.body), { value: { revision: 'r1', theme: 'paper' }, expected_revision: 'r1' });
    assert.equal(calls[1].init.method, 'PUT');
});

test('timeline mapping: ledger, discussion and transcript entries; gates carry the TTY command', async () => {
    const { timelineEvent, gateEvents } = await load();
    const ledger = timelineEvent({ source: 'ledger', type: 'task.routed', at: '2026-11-11T10:00:00Z', fields: { task_id: 'TASK-1', owner: 'agy' } });
    assert.deepEqual([ledger.title, ledger.message, ledger.sender], ['task.routed', 'task_id=TASK-1  owner=agy', 'ledger']);
    const chat = timelineEvent({ source: 'transcript', type: 'assistant', at: 'x', fields: { phase: 'final_answer', body: 'done' } });
    assert.deepEqual([chat.sender, chat.title, chat.message], ['Orchestrator', null, 'done']);
    const talk = timelineEvent({ source: 'discussion', type: 'message', at: 'x', fields: { from: 'worker-1', to: 'orchestrator', body: '<b>hi</b>' } });
    assert.deepEqual([talk.sender, talk.target, talk.message], ['worker-1', 'orchestrator', '<b>hi</b>']);
    const [gate] = gateEvents([{ phase: 'plan', task_id: null, summary: 'Duyệt plan r1', command: 'omni squad approve plan-r1' }]);
    assert.equal(gate.gate.command, 'omni squad approve plan-r1');
    assert.match(gate.title, /plan/);
});

test('binding candidate: the editor starts from the project binding, not a sample', async () => {
    const { bindingCandidate } = await load();
    assert.equal(bindingCandidate({ roles: [] }), null);
    const candidate = bindingCandidate({ preset: 'dual', roles: [
        { id: 'orchestrator', runtime: 'claude', model: 'sonnet', effort: 'low' },
        { id: 'worker-1', runtime: 'claude', model: 'sonnet' },
        { id: 'reviewer', runtime: 'codex', model: 'gpt-6-luna', effort: 'low' },
    ] });
    assert.deepEqual(candidate, { schema_version: 1, preset: 'dual', roles: {
        orchestrator: { runtime: 'claude', model: 'sonnet', effort: 'low' },
        worker: [{ id: 'worker-1', runtime: 'claude', model: 'sonnet' }],
        reviewer: { runtime: 'codex', model: 'gpt-6-luna', effort: 'low' },
    } });
});

function fakeContainer() {
    const make = (tag) => {
        const node = { tagName: tag, style: {}, children: [], textContent: '', className: '', scrollTop: 0, scrollHeight: 0,
            appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
            removeChild(child) { this.children = this.children.filter((c) => c !== child); },
            focus() {} };
        node.ownerDocument = doc;
        return node;
    };
    const doc = { createElement: make };
    return make('div');
}

class FakeEventSource {
    constructor(url) { this.url = url; this.listeners = {}; FakeEventSource.last = this; }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    emit(name, data) { for (const fn of this.listeners[name] || []) fn({ data }); }
    close() { this.closed = true; }
}

test('terminal client: speaks the server SSE (unnamed data, hello client id) and sends Enter on its own', async () => {
    const { attachTerminalView } = await import('../../lib/ui/static/workspace/terminals.mjs');
    const posts = [];
    const container = fakeContainer();
    const view = attachTerminalView({
        terminalId: 'orchestrator',
        container,
        clientId: 'local-id',
        transport: {
            streamUrl: '/api/pty/stream', inputUrl: '/api/pty/input', resizeUrl: '/api/pty/resize',
            eventSourceImpl: FakeEventSource,
            fetchImpl: async (url, init) => { posts.push([url, JSON.parse(init.body)]); return { ok: true }; },
        },
    });
    const source = FakeEventSource.last;
    assert.equal(source.url, '/api/pty/stream');
    source.emit('hello', JSON.stringify({ client_id: 'server-id', reset: false }));
    source.emit('message', JSON.stringify('hello \u001b[1mworld\u001b[0m'));
    const pre = container.children[0].children[0];
    assert.equal(pre.textContent, 'hello \u001b[1mworld\u001b[0m');

    assert.equal(await view.sendInput('ls\r'), true);
    await view.syncSize();
    assert.deepEqual(posts, [
        ['/api/pty/input', { client_id: 'server-id', data: 'ls' }],
        ['/api/pty/input', { client_id: 'server-id', data: '\r' }],
        ['/api/pty/resize', { client_id: 'server-id', cols: 80, rows: 24 }],
    ]);
    view.dispose();
    assert.equal(source.closed, true);
});

test('page controller and timeline render server data through textContent only', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    for (const file of ['app.mjs', 'timeline.mjs']) {
        const source = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'ui', 'static', 'workspace', file), 'utf8');
        assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/, file);
    }
});
