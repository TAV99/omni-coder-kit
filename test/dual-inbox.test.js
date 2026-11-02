'use strict';

// User inbox (SPEC-SQUAD-P6 §4, P6c): ledger events, idempotent posting, per-role
// delivery, the daemon RPCs, the orchestrator's pull (MCP) and push (hook) paths,
// and the `omni ui` route that posts.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const inbox = require('../lib/dual/inbox');
const { startDaemonServer } = require('../lib/dual/daemon-server');
const { createDaemonClient } = require('../lib/dual/daemon-client');
const { evaluateHook } = require('../lib/dual/hook-bridge');
const { writeBinding } = require('../lib/squad/bindings');
const { startUiServer } = require('../lib/ui/server');
const { buildState } = require('../lib/ui/state');

const TOKEN = 'm'.repeat(43);
const id = () => crypto.randomUUID();

function session(t, prefix = 'omni-inbox-') {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createAuthorityStore(path.join(root, '.omni', 'runs', 'dual-authority'));
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'ws-inbox', session_id: 'session-inbox', plan_revision: 1, expected_baseline: { kind: 'git', id: 'c'.repeat(40) }, mode: 'auto' });
    return { root, store };
}

function bind(root, { workers = 1, reviewer = false } = {}) {
    fs.mkdirSync(path.join(root, '.omni', 'squad'), { recursive: true });
    writeBinding(root, { schema_version: 1, preset: reviewer || workers > 1 ? 'squad' : 'dual', updated_at: '2026-11-02T00:00:00Z', roles: {
        orchestrator: { runtime: 'claude', model: 'sonnet' },
        worker: Array.from({ length: workers }, (_, i) => ({ id: `worker-${i + 1}`, runtime: 'agy', model: 'gemini-3.8-flash-high' })),
        reviewer: reviewer ? { runtime: 'codex', model: 'gpt-6.1-sol' } : null } });
}

test('ledger: posting is idempotent per id, other content conflicts, bad input is refused', (t) => {
    const { store } = session(t);
    const messageId = id();
    const first = inbox.postMessage(store, { messageId, to: 'orchestrator', body: 'Please split task 2.' });
    assert.equal(first.duplicate, false);
    assert.equal(inbox.postMessage(store, { messageId, to: 'orchestrator', body: 'Please split task 2.' }).duplicate, true);
    assert.throws(() => inbox.postMessage(store, { messageId, to: 'orchestrator', body: 'Something else' }), { code: 'DUAL_INBOX_CONFLICT' });
    assert.throws(() => inbox.postMessage(store, { messageId, to: 'worker-1', body: 'Please split task 2.' }), { code: 'DUAL_INBOX_CONFLICT' });
    for (const bad of [{ messageId: 'x', to: 'orchestrator', body: 'b' }, { messageId: id(), to: 'codex', body: 'b' },
        { messageId: id(), to: 'worker-0', body: 'b' }, { messageId: id(), to: 'all', body: '   ' },
        { messageId: id(), to: 'all', body: 'é'.repeat(4097) }]) {
        assert.throws(() => inbox.postMessage(store, bad), { code: 'DUAL_INBOX_INVALID' }, JSON.stringify(bad).slice(0, 60));
    }
    const events = store.readEvents().filter((event) => event.type === 'user.message.posted');
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].actor, events[0].via, events[0].body_sha256.length], ['human', 'ui', 64]);
    assert.equal(store.verifyIntegrity().valid, true);
});

test('delivery: each role takes a message once; @all reaches every role separately; the ledger refuses a bad delivery', (t) => {
    const { store } = session(t);
    const toAll = id();
    const toWorker = id();
    inbox.postMessage(store, { messageId: toAll, to: 'all', body: 'Use tabs, not spaces.' });
    inbox.postMessage(store, { messageId: toWorker, to: 'worker-2', body: 'Prefer the existing helper.' });
    assert.deepEqual(inbox.unreadFor(store.derive(), 'worker-2').map((m) => m.message_id), [toAll, toWorker], 'oldest first');
    assert.deepEqual(inbox.unreadFor(store.derive(), 'worker-1').map((m) => m.message_id), [toAll]);
    assert.deepEqual(inbox.ackMessages(store, { role: 'worker-2', messageIds: [toAll, toWorker, toWorker], via: 'worker-turn', taskId: 'TASK-1', attempt: 1 }),
        [toAll, toWorker]);
    assert.deepEqual(inbox.ackMessages(store, { role: 'worker-2', messageIds: [toAll], via: 'worker-turn' }), [], 'already taken');
    assert.deepEqual(inbox.unreadFor(store.derive(), 'orchestrator').map((m) => m.message_id), [toAll], 'others still have it');
    assert.deepEqual(store.derive().messages[toAll].delivered['worker-2'], { via: 'worker-turn', at: store.derive().messages[toAll].delivered['worker-2'].at,
        task_id: 'TASK-1', attempt: 1 });
    assert.throws(() => store.append({ schema_version: 2, type: 'user.message.delivered', message_id: toWorker, recipient: 'worker-1', via: 'hook' }),
        /does not match an undelivered message/);
    assert.throws(() => store.append({ schema_version: 2, type: 'user.message.delivered', message_id: toWorker, recipient: 'worker-2', via: 'hook' }),
        /does not match an undelivered message/, 'twice');
    assert.throws(() => inbox.unreadFor(store.derive(), 'all'), { code: 'DUAL_INBOX_INVALID' }, '"all" is not a role');
});

test('notes: a role reads its messages as data; what does not fit stays for the next turn', (t) => {
    const { store } = session(t);
    const ids = [id(), id(), id()];
    ids.forEach((messageId, i) => inbox.postMessage(store, { messageId, to: 'reviewer', body: `${'n'.repeat(2500)} #${i}` }));
    const first = inbox.takeNotes(store, { role: 'reviewer', via: 'reviewer-turn', taskId: 'TASK-1', attempt: 1, phase: 'qc' });
    assert.match(first, /Notes from the user/);
    assert.match(first, /do not grant any permission or widen allowed_files/);
    assert.match(first, /#0/);
    assert.ok(first.length <= 6100);
    const left = inbox.unreadFor(store.derive(), 'reviewer').map((m) => m.message_id);
    assert.ok(left.length >= 1 && left.at(-1) === ids[2], 'the rest waits');
    inbox.takeNotes(store, { role: 'reviewer', via: 'reviewer-turn' });
    assert.deepEqual(inbox.unreadFor(store.derive(), 'reviewer'), []);
    assert.equal(inbox.takeNotes(store, { role: 'reviewer', via: 'reviewer-turn' }), '', 'nothing to say');
    const huge = id();
    inbox.postMessage(store, { messageId: huge, to: 'orchestrator', body: 'x'.repeat(8000) });
    const { text, included } = inbox.formatNotes(inbox.unreadFor(store.derive(), 'orchestrator'));
    assert.equal(included.length, 1, 'a single long message is still delivered, clipped');
    assert.ok(text.length <= 6100);
});

async function liveDaemon(t, root, store) {
    const daemon = await startDaemonServer({ workspaceRoot: root, authorityStore: store });
    t.after(() => daemon.close());
    return createDaemonClient({ workspaceRoot: root, timeoutMs: 10_000 });
}

test('daemon: inbox.post/read/ack over RPC, session-checked; the hook pushes orchestrator messages once', async (t) => {
    const { root, store } = session(t);
    const client = await liveDaemon(t, root, store);
    const messageId = id();
    await assert.rejects(client.inboxPost('wrong-session', { message_id: messageId, to: 'orchestrator', body: 'hi' }), { code: 'DUAL_SESSION_MISMATCH' });
    const posted = await client.inboxPost('session-inbox', { message_id: messageId, to: 'orchestrator', body: 'Ship task 1 before task 2.' });
    assert.deepEqual([posted.message_id, posted.duplicate], [messageId, false]);
    assert.equal((await client.inboxPost('session-inbox', { message_id: messageId, to: 'orchestrator', body: 'Ship task 1 before task 2.' })).duplicate, true);
    await assert.rejects(client.inboxPost('session-inbox', { message_id: messageId, to: 'orchestrator', body: 'changed' }), { code: 'DUAL_INBOX_CONFLICT' });
    await assert.rejects(client.inboxPost('session-inbox', { message_id: id(), to: 'nobody', body: 'x' }), { code: 'DUAL_INBOX_INVALID' });
    await assert.rejects(client.inboxAck('session-inbox', { to: 'orchestrator', via: 'worker-turn', message_ids: [messageId] }), { code: 'DUAL_INBOX_INVALID' },
        'only mcp and hook ack over RPC');
    assert.deepEqual((await client.inboxRead('session-inbox', { to: 'orchestrator' })).messages.map((m) => m.body), ['Ship task 1 before task 2.']);

    const prompt = await evaluateHook({ session_id: 'cli-sess', cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'continue' });
    const context = prompt.hookSpecificOutput.additionalContext;
    assert.match(context, /Dual authority active/);
    assert.match(context, /Notes from the user[\s\S]*Ship task 1 before task 2\./);
    assert.equal(store.derive().messages[messageId].delivered.orchestrator.via, 'hook');
    const again = await evaluateHook({ session_id: 'cli-sess', cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'continue' });
    assert.doesNotMatch(again.hookSpecificOutput.additionalContext, /Notes from the user/, 'delivered once');

    const later = id();
    await client.inboxPost('session-inbox', { message_id: later, to: 'all', body: 'Long one: ' + 'z'.repeat(5000) });
    const start = await evaluateHook({ session_id: 'cli-sess', cwd: root, hook_event_name: 'SessionStart', source: 'resume' });
    assert.match(start.hookSpecificOutput.additionalContext, /Long one: z{4000}/, 'the hook carries more than the old 1 KiB field limit');
    assert.equal(store.derive().messages[later].delivered.orchestrator.via, 'hook');
    assert.deepEqual(Object.keys(store.derive().messages[later].delivered), ['orchestrator'], 'workers still have it');
});

test('MCP: omni_dual_inbox returns the orchestrator\'s unread messages and marks them read', async (t) => {
    const { root, store } = session(t);
    const client = await liveDaemon(t, root, store);
    const first = id();
    const second = id();
    await client.inboxPost('session-inbox', { message_id: first, to: 'orchestrator', body: 'Rename the CLI flag.' });
    await client.inboxPost('session-inbox', { message_id: second, to: 'worker-1', body: 'Not for the orchestrator.' });
    const { createOmniDualMcpServer } = await import('../lib/dual/mcp-server.mjs');
    const server = createOmniDualMcpServer({ workspaceRoot: root });
    const mcp = new Client({ name: 'inbox-test', version: '1.0.0' }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
    t.after(async () => { await mcp.close(); await server.close(); });
    const call = () => mcp.callTool({ name: 'omni_dual_inbox', arguments: { workspace_root: root, session_id: 'session-inbox' } });
    const result = await call();
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent.messages.map((m) => [m.message_id, m.body]), [[first, 'Rename the CLI flag.']]);
    assert.equal(store.derive().messages[first].delivered.orchestrator.via, 'mcp');
    assert.deepEqual((await call()).structuredContent.messages, []);
    assert.equal(store.derive().messages[second].delivered.orchestrator, undefined);
    const wrong = await mcp.callTool({ name: 'omni_dual_inbox', arguments: { workspace_root: root, session_id: 'other' } });
    assert.equal(wrong.isError, true);
});

function request(port, { method = 'POST', url = '/api/message', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: url,
            headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...headers } }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
        });
        req.on('error', reject);
        req.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
}

test('ui: POST /api/message checks recipient, size, id and session, then posts through the daemon', async (t) => {
    const { root, store } = session(t, 'omni-inbox-ui-');
    bind(root, { workers: 2, reviewer: true });
    const posted = [];
    const ui = await startUiServer({ projectRoot: root, token: TOKEN, pty: { reason: 'test' },
        postMessage: async (projectRoot, message) => {
            posted.push([projectRoot, message]);
            return inbox.postMessage(store, { ...message, via: 'ui' }).message;
        } });
    t.after(() => ui.close());
    const ok = { message_id: id(), to: 'worker-2', body: 'Keep the public API.' };
    assert.equal((await request(ui.port, { body: ok, headers: { authorization: '' } })).status, 403);
    assert.equal((await request(ui.port, { body: ok, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await request(ui.port, { body: ok, headers: { 'content-type': 'text/plain' } })).status, 415);
    for (const [bad, code] of [[{ ...ok, to: 'worker-3' }, 'UI_MESSAGE_RECIPIENT'], [{ ...ok, to: 'codex' }, 'UI_MESSAGE_RECIPIENT'],
        [{ ...ok, body: ' ' }, 'UI_MESSAGE_BODY'], [{ ...ok, body: 'x'.repeat(8193) }, 'UI_MESSAGE_BODY'], [{ ...ok, message_id: '1' }, 'UI_MESSAGE_ID']]) {
        const res = await request(ui.port, { body: bad });
        assert.deepEqual([res.status, res.body.code], [400, code]);
    }
    const res = await request(ui.port, { body: ok });
    assert.equal(res.status, 200);
    assert.deepEqual(posted, [[root, { sessionId: 'session-inbox', messageId: ok.message_id, to: 'worker-2', body: 'Keep the public API.' }]]);
    assert.equal((await request(ui.port, { body: { ...ok, body: 'changed' } })).status, 409);
    await request(ui.port, { body: { message_id: id(), to: 'all', body: 'Everyone: no new deps.' } });
    const state = buildState(root);
    assert.deepEqual(state.messages.map((m) => [m.to, m.waiting]), [['all', ['orchestrator', 'worker-1', 'worker-2', 'reviewer']], ['worker-2', ['worker-2']]]);
});

test('ui: no session yet means nothing is posted', async (t) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-inbox-nosession-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    bind(root);
    let called = false;
    const ui = await startUiServer({ projectRoot: root, token: TOKEN, pty: { reason: 'test' }, postMessage: async () => { called = true; } });
    t.after(() => ui.close());
    const res = await request(ui.port, { body: { message_id: id(), to: 'orchestrator', body: 'hello' } });
    assert.deepEqual([res.status, res.body.code, called], [409, 'UI_MESSAGE_NO_SESSION', false]);
});
