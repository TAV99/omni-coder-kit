'use strict';

// Orchestrator transcripts (SPEC-SQUAD-P6 §6, P6d, V41): codex and claude session
// files read incrementally and safely, only for the session `omni ui` started,
// and shown in the timeline with a cursor that never carries a path.
// Fixtures are trimmed from real files (claude 2.1.316, codex-cli 0.166.0).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const transcript = require('../lib/squad/runtimes/transcript');
const codex = require('../lib/squad/runtimes/codex');
const claude = require('../lib/squad/runtimes/claude');
const { createTranscriptSource, fileKey } = require('../lib/ui/transcript-source');
const feed = require('../lib/ui/feed');
const { startUiServer } = require('../lib/ui/server');

const FIXTURES = path.join(__dirname, 'fixtures', 'squad-cli');
const CLAUDE_ID = '39921ea4-7099-4eeb-a137-278fc722b1e6';
const CODEX_ID = '01a19ac3-9bd6-7e70-9543-2da5d2d9bae4';
const TOKEN = 'r'.repeat(43);

function temp(t, prefix) {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

const fixture = (name, cwd) => fs.readFileSync(path.join(FIXTURES, name), 'utf8').replaceAll('/work/project', cwd);

function claudeHome(t, project, { folder } = {}) {
    const home = temp(t, 'omni-tx-home-');
    const dir = path.join(home, '.claude', 'projects', folder || project.replace(/[^A-Za-z0-9-]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${CLAUDE_ID}.jsonl`);
    fs.writeFileSync(file, fixture('claude-transcript.jsonl', project));
    return { home, file };
}

function codexHome(t, project, { day = '2026/11/02', id = CODEX_ID, name } = {}) {
    const home = temp(t, 'omni-tx-codex-');
    const dir = path.join(home, '.codex', 'sessions', ...day.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name || `rollout-2026-11-02T12-37-53-${id}.jsonl`);
    fs.writeFileSync(file, fixture('codex-rollout.jsonl', project).replaceAll(CODEX_ID, id));
    return { home, file, dir };
}

test('claude: the person and the orchestrator, nothing else; reads resume after the last whole line', (t) => {
    const project = temp(t, 'omni-tx-project-');
    const { home, file } = claudeHome(t, project);
    const ctx = { homedir: home, env: {} };
    const first = claude.readTranscript({ sessionId: CLAUDE_ID, cwd: project }, ctx);
    assert.equal(first.file, file);
    assert.deepEqual(first.entries.map((e) => [e.role, e.text]), [
        ['user', 'Reply with exactly the text V40-OK and nothing else.'], ['assistant', 'V40-OK'],
        ['user', 'What exact text did you reply with in your previous answer? Answer with that text followed by -AGAIN.'], ['assistant', 'V40-OK-AGAIN']]);
    assert.equal(first.cursor.offset, fs.statSync(file).size);
    const line = (record) => `${JSON.stringify({ sessionId: CLAUDE_ID, timestamp: '2026-11-02T06:00:00Z', uuid: crypto.randomUUID(), isSidechain: false, ...record })}\n`;
    fs.appendFileSync(file, [
        line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'secret file text' }] } }),
        line({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta caveat' } }),
        line({ type: 'user', message: { role: 'user', content: '<command-name>/exit</command-name>' } }),
        line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent talk' }] } }),
        '{"broken json\n',
        line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Running the tests.' }, { type: 'tool_use', name: 'Bash', input: { command: 'cat ~/.ssh/id' } }] } }),
    ].join(''));
    fs.appendFileSync(file, '{"type":"user","message":{"role":"user","content":"half wr');
    const next = claude.readTranscript({ cursor: first.cursor }, ctx);
    assert.deepEqual(next.entries.map((e) => [e.role, e.text]), [['assistant', 'Running the tests.'], ['tool', 'Bash']],
        'tool results, meta, slash commands, sidechains and broken lines are skipped; tool input is not shown');
    assert.equal(JSON.stringify(next.entries).includes('id_'), false);
    fs.appendFileSync(file, 'itten"}}\n');
    assert.deepEqual(claude.readTranscript({ cursor: next.cursor }, ctx).entries.map((e) => e.text), ['half written']);
});

test('claude: a shortened folder name is found by session id; CLAUDE_CONFIG_DIR wins; a missing session is not an error', (t) => {
    const project = temp(t, 'omni-tx-project-');
    const { home } = claudeHome(t, project, { folder: '-very-long-path-shortened-abc123' });
    assert.equal(claude.readTranscript({ sessionId: CLAUDE_ID, cwd: project }, { homedir: home, env: {} }).entries.length, 4);
    assert.equal(claude.readTranscript({ sessionId: CLAUDE_ID, cwd: project }, { homedir: '/nowhere', env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }).entries.length, 4);
    const missing = claude.readTranscript({ sessionId: crypto.randomUUID(), cwd: project }, { homedir: home, env: {} });
    assert.deepEqual([missing.found, missing.entries], [false, []]);
});

test('codex: the rollout is found by project and start time (or id); clean text only', (t) => {
    const project = temp(t, 'omni-tx-project-');
    const other = temp(t, 'omni-tx-other-');
    const { home, dir, file } = codexHome(t, project);
    // Another project's session from the same minute, and an old one of ours.
    fs.writeFileSync(path.join(dir, `rollout-2026-11-02T12-37-54-${crypto.randomUUID()}.jsonl`), fixture('codex-rollout.jsonl', other));
    const old = path.join(dir, `rollout-2026-11-02T08-00-00-${crypto.randomUUID()}.jsonl`);
    fs.writeFileSync(old, fixture('codex-rollout.jsonl', project).replaceAll('2026-11-02T05:37:53.206Z', '2026-11-02T01:00:00.000Z'));
    const ctx = { homedir: home, env: {}, now: () => new Date('2026-11-02T06:00:00Z') };
    const found = codex.readTranscript({ cwd: project, since: '2026-11-02T05:37:50Z' }, ctx);
    assert.deepEqual([found.file, found.sessionId], [file, CODEX_ID]);
    assert.deepEqual(found.entries.map((e) => [e.role, e.text, e.phase]), [
        ['user', 'Reply with exactly the text V40-OK and nothing else. Do not run any command.', undefined], ['assistant', 'V40-OK', 'final_answer'],
        ['user', 'What exact text did you reply with in your previous answer? Answer with that text followed by -AGAIN. Do not run any command.', undefined],
        ['assistant', 'V40-OK-AGAIN', 'final_answer']], 'AGENTS.md and environment text are not the person talking');
    assert.equal(codex.readTranscript({ sessionId: CODEX_ID, cwd: project, since: '2026-11-01T00:00:00Z' }, ctx).file, file);
    assert.equal(codex.readTranscript({ cwd: other, since: '2026-11-02T06:30:00Z' }, ctx).found, false, 'started before the PTY');
    assert.equal(codex.readTranscript({ cwd: project, since: 'not a date' }, ctx).found, false);
    assert.equal(codex.readTranscript({ cwd: project, since: '2026-11-02T05:37:50Z' }, { homedir: '/nowhere', env: { CODEX_HOME: path.join(home, '.codex') }, now: ctx.now }).file, file);
});

test('readJsonl: bounded window, partial lines wait, an oversized line is stepped over', (t) => {
    const dir = temp(t, 'omni-tx-jsonl-');
    const file = path.join(dir, 'x.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ a: 1 })}\n${'x'.repeat(300)}`);
    const first = transcript.readJsonl(file, 0, { maxBytes: 100 });
    assert.deepEqual([first.records, first.offset], [[{ a: 1 }], 8]);
    const huge = transcript.readJsonl(file, first.offset, { maxBytes: 100 });
    assert.deepEqual([huge.records, huge.offset], [[], 108], 'a line longer than the window is skipped, not read forever');
    assert.deepEqual(transcript.readJsonl(path.join(dir, 'missing'), 5), { records: [], ends: [], offset: 5 });
});

test('source: only the UI\'s own session; cursor is a file hash and offset; codex learns its id', (t) => {
    const project = temp(t, 'omni-tx-project-');
    const { home, file } = codexHome(t, project);
    let ref = { runtime: 'codex', session_id: null, started_at: '2026-11-02T05:37:50Z' };
    const recorded = [];
    const source = createTranscriptSource({ projectRoot: project, sessionRef: () => ref,
        recordSession: (runtime, id) => { recorded.push([runtime, id]); ref = { ...ref, session_id: id }; },
        ctx: { homedir: home, env: {}, now: () => new Date('2026-11-02T06:00:00Z') } });
    const first = source.read(null);
    assert.equal(first.entries.length, 4);
    assert.deepEqual(recorded, [['codex', CODEX_ID]]);
    assert.deepEqual(first.cursor, { k: fileKey(file), o: fs.statSync(file).size });
    assert.equal(JSON.stringify(first).includes(file), false, 'no path leaves the server');
    assert.deepEqual(first.entries.map((e) => [e.source, e.type, e.fields.runtime]).at(0), ['transcript', 'user', 'codex']);
    assert.deepEqual(source.read(first.cursor).entries, [], 'the id became known: same file, same offset');
    assert.equal(source.read(first.entries[1].cursor).entries.length, 2, 'resume after any entry');
    assert.equal(source.read({ k: 'f'.repeat(32), o: 5 }).entries.length, 4, 'a cursor for another file starts over');
    const none = createTranscriptSource({ projectRoot: project, sessionRef: () => null });
    assert.deepEqual(none.read(null), { entries: [], cursor: null });
    const agy = createTranscriptSource({ projectRoot: project, sessionRef: () => ({ runtime: 'agy', session_id: 'x' }) });
    assert.deepEqual(agy.read(null).entries, [], 'a runtime without transcripts adds nothing');
});

test('feed cursor: the transcript part is validated; a path is dropped', () => {
    const k = 'a'.repeat(32);
    assert.deepEqual(feed.decodeCursor(feed.encodeCursor({ l: 1, j: {}, t: { k, o: 9 } })), { l: 1, j: {}, t: { k, o: 9 } });
    for (const t of [{ k: '/etc/passwd', o: 0 }, { k, o: -1 }, { file: '/etc/passwd', offset: 0 }, { k: 'A'.repeat(32), o: 1 }]) {
        assert.deepEqual(feed.decodeCursor(feed.encodeCursor({ l: 1, j: {}, t })), { l: 1, j: {} }, JSON.stringify(t));
    }
});

function stream(port, { until, headers = {} }) {
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
                    const fields = Object.fromEntries(block.split('\n').filter((l) => /^(id|event|data): /.test(l)).map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
                    if (fields.event === 'entry') events.push({ id: fields.id, ...JSON.parse(fields.data) });
                }
                if (until(events)) { req.destroy(); resolve(events); }
            });
        });
        req.on('error', (error) => reject(error));
        setTimeout(() => { req.destroy(); resolve(events); }, 4000).unref();
    });
}

test('timeline: the orchestrator chat streams over SSE and resumes without repeats', async (t) => {
    const project = temp(t, 'omni-tx-project-');
    const { home, file } = claudeHome(t, project);
    fs.mkdirSync(path.join(project, '.omni', 'ui'), { recursive: true });
    fs.writeFileSync(path.join(project, '.omni', 'ui', 'orchestrator.json'),
        JSON.stringify({ runtime: 'claude', session_id: CLAUDE_ID, started_at: '2026-11-02T05:36:00Z' }));
    const ui = await startUiServer({ projectRoot: project, token: TOKEN, pollMs: 30, pty: { reason: 'test' },
        transcriptOptions: { ctx: { homedir: home, env: {} } } });
    t.after(() => ui.close());
    const chat = (events) => events.filter((e) => e.source === 'transcript');
    const first = await stream(ui.port, { until: (events) => chat(events).length >= 4 });
    assert.deepEqual(chat(first).map((e) => [e.type, e.fields.body]).slice(0, 2), [['user', 'Reply with exactly the text V40-OK and nothing else.'], ['assistant', 'V40-OK']]);
    const last = chat(first).at(-1);
    fs.appendFileSync(file, `${JSON.stringify({ type: 'user', sessionId: CLAUDE_ID, uuid: crypto.randomUUID(), timestamp: '2026-11-02T06:00:00Z',
        isSidechain: false, message: { role: 'user', content: 'One more thing.' } })}\n`);
    const resumed = await stream(ui.port, { until: (events) => chat(events).length >= 1, headers: { 'last-event-id': last.id } });
    assert.deepEqual(chat(resumed).map((e) => e.fields.body), ['One more thing.']);
});

test('adapters: codex and claude declare transcripts; agy does not yet', () => {
    const { BUILTIN_RUNTIMES } = require('../lib/squad/runtimes');
    assert.deepEqual(BUILTIN_RUNTIMES.map((r) => [r.id, r.capabilities.transcript, typeof r.readTranscript]),
        [['codex', true, 'function'], ['agy', false, 'undefined'], ['claude', true, 'function']]);
});
