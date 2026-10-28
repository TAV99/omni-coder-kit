'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { createDualOrchestrator } = require('../lib/dual/orchestrator');
const { buildBindings } = require('../lib/dual/discussion/session');

async function fixture(t, { enabled, missingResolver = false, disabledSession = false, unknown = false, invalid = false, snapshot = false, taskId = 'TASK-DISCUSSION', allowedFiles = ['index.html'], orchestratorFactory = createDualOrchestrator } = {}) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-discussion-orch-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const git = (...args) => {
        const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test User');
    git('config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(repoRoot, 'index.html'), '<body>Hello</body>\n');
    git('add', '.');
    git('commit', '-m', 'initial');
    const head = git('rev-parse', 'HEAD');
    const initialSnapshot = snapshot
        ? require('../lib/dual/baseline-snapshot').createSnapshotBaseline({ root: repoRoot }).capture()
        : undefined;
    const correlation = { schema_version: 1, task_id: taskId,
        ...(snapshot ? { expected_baseline: initialSnapshot.identity } : { expected_base_commit: head }) };
    const payloads = {
        scout: { ...correlation, summary: 'Scout analysis',
            relevant_files: [{ path: 'index.html', description: 'Entry' }],
            exact_symbols: [{ name: 'body', file: 'index.html', verified: true }],
            validation_commands: ['node --version'], constraints: [], risks: [], open_questions: [],
            research_trace: [
                { question: 'Where?', source: 'index.html', source_type: 'REPOSITORY', conclusion: 'Entry.' },
                { question: 'Check?', source: 'node --version', source_type: 'TEST_OUTPUT', conclusion: 'Available.' },
            ],
            alternatives_considered: [{ option: 'Edit entry', tradeoff: 'Small.' }, { option: 'New module', tradeoff: 'Complex.' }],
            failure_modes: ['Malformed markup.'] },
        implement: { ...correlation, status: 'SUCCESS', modified_files: [],
            command_outputs: [{ command: 'node --version', exit_code: 0, output: 'v22' }], unverified_items: [],
            self_review: { checks: ['scope inspected', 'edge case challenged', 'validation checked'], remaining_risks: [] } },
        review: { ...correlation, recommendation: 'APPROVE', risk_level: 'LOW', findings: [],
            review_checks: ['spec correlated', 'evidence correlated', 'regression challenged'],
            challenge_summary: 'No markup changed; inspected the empty diff.' },
    };
    const agyCalls = [], bridgeCalls = [], contexts = [], messages = [];
    const session = { enabled: !disabledSession,
        bindings: buildBindings({ models: { agy: 'gemini-3.7-flash-high' }, efforts: { agy: 'high' }, sessionId: 'session-1', taskId, planRevision: 2,
            snapshotSha256: 'a'.repeat(64), codexConversationId: 'codex-1', agyConversationId: 'agy-1' }),
        relay: {
            async inspect() { return { messages, unknown: unknown ? { invocation_id: 'inv-unknown', binding_ref: 'worker-ref' } : null }; },
            async receive(message) { messages.push(message); },
            async dispatch(messageId) {
                bridgeCalls.push(messageId);
                if (unknown) throw Object.assign(new Error('outcome unavailable'), { code: 'OUTCOME_UNKNOWN' });
                const phase = messages.at(-1).body.includes('# Review') ? 'review' : 'scout';
                const body = JSON.stringify(invalid ? { ...correlation, summary: 42 } : payloads[phase]);
                messages.push({ message_id: `response-${messageId}`, body });
                return { response_message_id: `response-${messageId}`, invocation_id: 'inv-1' };
            },
        } };
    const orch = orchestratorFactory({ workerModel: 'gemini-3.7-flash-high', workerEffort: 'high', cwd: repoRoot, backend: snapshot ? 'snapshot' : 'git', initialSnapshot,
        authoritativeCapabilityEvidence: { version: '1.1.19', model: 'gemini-3.7-flash-high' },
        gitRunner: (args, { cwd, encoding = 'utf8' } = {}) => {
            const result = spawnSync('git', args, { cwd, encoding, stdio: ['ignore', 'pipe', 'pipe'] });
            assert.ifError(result.error);
            assert.equal(result.status, 0, String(result.stderr));
            return result.stdout;
        },
        discussion: { enabled, ...(!missingResolver ? { sessionResolver: async (context) => {
            contexts.push(context); return session;
        } } : {}) },
        processRunner: async (invocation) => {
            agyCalls.push(invocation);
            const phase = ['scout', 'implement', 'review'].find((p) => invocation.args.some((arg) => arg.startsWith('-p=') && arg.includes(`the ${p} phase`)));
            assert.ok(phase, 'Only phase execution should reach fake AGY');
            const now = new Date();
            return { exitCode: 0, stdout: JSON.stringify({ structured_output: payloads[phase] }), stderr: '',
                timedOut: false, startedAt: now, endedAt: now, durationMs: 0 };
        } });
    orch.newTask(taskId);
    await orch.runPhase('preflight', taskId);
    const runDir = path.join(repoRoot, '.omni/codex-gemini/runs', taskId);
    const read = (name) => JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8'));
    async function route() {
        fs.writeFileSync(path.join(runDir, 'spec.json'), JSON.stringify({ ...correlation,
            goal: 'Keep entry valid', allowed_files: allowedFiles, deny_patterns: [],
            validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
            risk_flags: [], permission_authority: 'dual-init-dangerous-auto-v1' }));
        await orch.runPhase('spec', taskId);
        await orch.runPhase('route', taskId);
    }
    return { orch, taskId, repoRoot, runDir, read, payloads, agyCalls, bridgeCalls, contexts, messages, session, route, initialSnapshot };
}

async function ready(t, text, options = {}) {
    const f = await fixture(t, { enabled: true, ...options });
    await f.orch.runPhase('scout', f.taskId);
    await f.route();
    await f.orch.runPhase('implement', f.taskId);
    fs.writeFileSync(path.join(f.repoRoot, 'index.html'), text);
    for (const [name, content] of Object.entries(options.assets || {})) fs.writeFileSync(path.join(f.repoRoot, name), content);
    await f.orch.runPhase('scope', f.taskId);
    f.messages.length = 0;
    return f;
}
const large = Array.from({ length: 1500 }, (_, i) => `<div>Task ${i}: tiếng Việt 😀</div>\n`).join('');
const hash = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex');
const { CEILINGS } = require('../lib/dual/discussion/contracts');
function verifyManifest(f) {
    const m = f.read('raw/review.1.chunks.json');
    const original = fs.readFileSync(path.join(f.runDir, m.diff_file));
    let offset = 0;
    const parts = m.chunks.map((c) => {
        const bytes = fs.readFileSync(path.join(f.runDir, c.file));
        assert.equal(c.byte_start, offset);
        offset = c.byte_end;
        assert.deepEqual(bytes, original.subarray(c.byte_start, c.byte_end));
        assert.equal(hash(bytes), c.sha256);
        const prompt = fs.readFileSync(path.join(f.runDir, c.input_file), 'utf8');
        assert.equal(Buffer.byteLength(prompt), c.body_bytes);
        assert.ok(c.body_bytes <= CEILINGS.maxBodyBytes);
        assert.ok(prompt.includes(`--- BEGIN REVIEW DIFF ---\n${bytes.toString()}\n--- END REVIEW DIFF ---`));
        if (offset < original.length) assert.equal(bytes.at(-1), 10);
        return bytes;
    });
    assert.equal(offset, original.length);
    assert.deepEqual(Buffer.concat(parts), original);
    assert.equal(hash(original), m.sha256);
    return m;
}
for (const snapshot of [false, true]) {
    test(`large UTF-8 review uses bounded lossless chunks (snapshot=${snapshot})`, async (t) => {
        const f = await ready(t, large, { snapshot });
        const receive = f.session.relay.receive;
        f.session.relay.receive = async (m) => {
            assert.ok(Buffer.byteLength(m.body) <= CEILINGS.maxBodyBytes);
            return receive(m);
        };
        await f.orch.runPhase('review', f.taskId);
        const m = verifyManifest(f);
        assert.ok(m.chunks.length > 1);
        assert.equal(f.messages.filter((m) => m.kind === 'question').length, m.chunks.length);
        assert.equal(f.read('review.json').recommendation, 'APPROVE');
    });
}
test('small review preserves its single question body', async (t) => {
    const f = await ready(t, '<body>Small</body>\n');
    await f.orch.runPhase('review', f.taskId);
    const m = verifyManifest(f);
    assert.equal(m.chunks.length, 1);
    const input = fs.readFileSync(path.join(f.runDir, 'raw/review.1.input.md'), 'utf8');
    const schema = fs.readFileSync(path.join(f.runDir, 'raw/review.1.schema.json'), 'utf8');
    const diff = fs.readFileSync(path.join(f.runDir, m.diff_file), 'utf8');
    assert.equal(f.messages[0].body, `${input}\n\n--- BEGIN REVIEW DIFF ---\n${diff}\n--- END REVIEW DIFF ---\n\n\n--- PHASE OUTPUT SCHEMA (JSON Schema) ---\n${schema}\nAnswer with ONLY a JSON object matching this schema.\n`);
});
test('failure in a later chunk is terminal and never publishes partial review', async (t) => {
    const f = await ready(t, large);
    const dispatch = f.session.relay.dispatch;
    let calls = 0;
    f.session.relay.dispatch = async (id) => {
        if (++calls === 2) throw Object.assign(new Error('chunk limit'), { code: 'LIMIT_EXCEEDED' });
        return dispatch(id);
    };
    await assert.rejects(f.orch.runPhase('review', f.taskId), { code: 'LIMIT_EXCEEDED' });
    assert.equal(calls, 2);
    assert.equal(fs.existsSync(path.join(f.runDir, 'review.json')), false);
    assert.equal(fs.existsSync(path.join(f.runDir, 'raw/review.1.stdout.json')), false);
    assert.equal(f.read('raw/review.1.failure.json').retryable, false);
    await assert.rejects(f.orch.runPhase('review', f.taskId));
    assert.equal(calls, 2, 'terminal chunk failure must not retry');
});
test('oversized single line fails closed before sending any chunk', async (t) => {
    const f = await ready(t, '😀'.repeat(18000));
    await assert.rejects(f.orch.runPhase('review', f.taskId), (e) => e.code === 'LIMIT_EXCEEDED' && /line.*budget/i.test(e.message));
    assert.equal(f.messages.length, 0);
    assert.equal(fs.existsSync(path.join(f.runDir, 'review.json')), false);
});
test('aggregation keeps all findings and the most conservative recommendation and risk', async (t) => {
    const f = await ready(t, large);
    const dispatch = f.session.relay.dispatch;
    let calls = 0;
    f.session.relay.dispatch = async (id) => {
        const n = ++calls;
        Object.assign(f.payloads.review, { recommendation: n === 2 ? 'REJECT' : 'APPROVE',
            risk_level: n === 2 ? 'CRITICAL' : 'LOW',
            findings: [{ file: 'index.html', line: n, severity: n === 2 ? 'ERROR' : 'INFO', description: `Finding ${n}` }] });
        return dispatch(id);
    };
    await f.orch.runPhase('review', f.taskId);
    assert.ok(calls > 1);
    const review = f.read('review.json');
    assert.equal(review.recommendation, 'REJECT');
    assert.equal(review.risk_level, 'CRITICAL');
    assert.equal(review.findings.length, calls);
});

test('invalid schema in a later chunk fails after the bounded correction', async (t) => {
    const f = await ready(t, large);
    const dispatch = f.session.relay.dispatch;
    let calls = 0;
    f.session.relay.dispatch = async (id) => {
        if (++calls >= 2) f.payloads.review = { task_id: f.taskId, recommendation: 'APPROVE' };
        return dispatch(id);
    };
    await assert.rejects(f.orch.runPhase('review', f.taskId), { code: 'RESULT_MALFORMED' });
    assert.equal(calls, 3);
    for (const message of f.messages) assert.ok(Buffer.byteLength(message.body) <= CEILINGS.maxBodyBytes);
    assert.equal(fs.existsSync(path.join(f.runDir, 'review.json')), false);
    assert.equal(fs.existsSync(path.join(f.runDir, 'raw/review.1.stdout.json')), false);
});

test('every chunk must match task correlation', async (t) => {
    const f = await ready(t, large);
    const dispatch = f.session.relay.dispatch;
    let calls = 0;
    f.session.relay.dispatch = async (id) => {
        if (++calls === 2) f.payloads.review.task_id = 'TASK-WRONG';
        return dispatch(id);
    };
    await assert.rejects(f.orch.runPhase('review', f.taskId), { code: 'DUAL_REVIEW_CORRELATION' });
    assert.equal(fs.existsSync(path.join(f.runDir, 'review.json')), false);
});

const { planReviewChunks, reviewBody, aggregateReviews } = require('../lib/dual/review-chunking');
test('overhead is counted in bytes; exact-ceiling small body stays unchanged', () => {
    const input = 'tiếng Việt 😀';
    const schema = '{}';
    const room = CEILINGS.maxBodyBytes - Buffer.byteLength(reviewBody(input, schema, ''));
    const diff = 'x'.repeat(room);
    const p = planReviewChunks(input, schema, diff);
    assert.equal(p.chunks.length, 1);
    assert.equal(p.chunks[0].body_bytes, CEILINGS.maxBodyBytes);
    assert.equal(p.chunks[0].body, reviewBody(input, schema, diff));
    assert.throws(() => planReviewChunks('x'.repeat(17000), schema, ''),
        (e) => e.code === 'LIMIT_EXCEEDED' && /overhead/.test(e.message));
    assert.throws(() => planReviewChunks('x'.repeat(17000), schema, 'a\nb\n'),
        (e) => e.code === 'LIMIT_EXCEEDED' && /overhead/.test(e.message));
});
test('whole file boundaries and initial git headers stay with hunks', () => {
    const file = (name) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1,300 @@\n`
        + '+tiếng Việt 😀\n'.repeat(300);
    const diff = file('a.js') + file('b.js') + file('c.js');
    const p = planReviewChunks('', '{}', diff);
    assert.ok(p.chunks.length > 1);
    assert.equal(p.chunks.map((c) => c.text).join(''), diff);
    for (const c of p.chunks) {
        assert.ok(c.text.startsWith('diff --git '));
        assert.ok(c.text.includes('@@ -1 +1,300 @@\n+tiếng Việt 😀\n'));
    }
});
test('NEEDS_FIX and higher risk survive later approvals', () => {
    const base = { findings: [], review_checks: ['a', 'b', 'c'], challenge_summary: 'checked' };
    const r = aggregateReviews([{ ...base, recommendation: 'NEEDS_FIX', risk_level: 'HIGH' },
        { ...base, recommendation: 'APPROVE', risk_level: 'LOW' }]);
    assert.equal(r.recommendation, 'NEEDS_FIX');
    assert.equal(r.risk_level, 'HIGH');
});

for (const snapshot of [false, true]) {
    test(`demo-sized three-file diff is fully reviewed (snapshot=${snapshot})`, async (t) => {
        const content = (bytes) => 'const task = "demo task";\n'.repeat(bytes).slice(0, bytes - 1) + '\n';
        const f = await ready(t, content(8366), { snapshot,
            allowedFiles: ['index.html', 'styles.css', 'app.js'],
            assets: { 'styles.css': content(16761), 'app.js': content(23056) } });
        await f.orch.runPhase('review', f.taskId);
        const m = verifyManifest(f);
        assert.ok(m.byte_length > 48000);
        assert.ok(m.chunks.length > 1);
        // Enough room remains under the existing discussion invocation ceiling
        // for the scout turn; this fix does not raise any session ceilings.
        assert.ok(m.chunks.length + 1 <= CEILINGS.maxInvocations);
    });
}
test('artifact corruption before aggregate publication fails closed', async (t) => {
    const f = await ready(t, large);
    const dispatch = f.session.relay.dispatch;
    f.session.relay.dispatch = async (id) => {
        const result = await dispatch(id);
        const m = f.read('raw/review.1.chunks.json');
        fs.writeFileSync(path.join(f.runDir, m.chunks[0].file), 'corrupt');
        return result;
    };
    await assert.rejects(f.orch.runPhase('review', f.taskId), { code: 'DUAL_REVIEW_COVERAGE' });
    assert.equal(fs.existsSync(path.join(f.runDir, 'review.json')), false);
    assert.equal(fs.existsSync(path.join(f.runDir, 'raw/review.1.stdout.json')), false);
});

const { runDiscussionPhase } = require('../lib/dual/discussion/phase-bridge');
async function correctedReview(promptBody) {
    const messages = [];
    let validations = 0;
    const session = { enabled: true, relay: {
        async inspect() { return { messages }; },
        async receive(m) { assert.ok(Buffer.byteLength(m.body) <= CEILINGS.maxBodyBytes); messages.push(m); },
        async dispatch(id) { messages.push({ message_id: `reply-${id}`, body: '{}' }); return { response_message_id: `reply-${id}` }; },
    } };
    await runDiscussionPhase({ session, phase: 'review', promptBody,
        senderRef: 'sender', recipientRef: 'recipient', messageId: 'question',
        validate: () => ++validations === 1 ? { ok: false, issues: '😀'.repeat(4096) } : { ok: true } });
    return messages.filter((m) => m.kind === 'question');
}
test('schema correction bounds UTF-8 diagnostics while retaining every original prompt byte', async () => {
    const original = 'x'.repeat(15500);
    const questions = await correctedReview(original);
    assert.equal(questions.length, 2);
    assert.ok(questions[1].body.startsWith(original));
    assert.ok(!questions[1].body.includes('�'));
});
test('no correction question is sent when fixed overhead cannot fit', async () => {
    await assert.rejects(correctedReview('x'.repeat(CEILINGS.maxBodyBytes)), { code: 'LIMIT_EXCEEDED' });
});

test('crash recovery accepts only the complete aggregate with manifest evidence', async (t) => {
    const f = await ready(t, large);
    await f.orch.runPhase('review', f.taskId);
    const eventsFile = path.join(f.runDir, 'events.ndjson');
    const events = fs.readFileSync(eventsFile, 'utf8').trim().split('\n');
    const completed = events.findIndex((line) => { const e = JSON.parse(line); return e.type === 'phase.completed' && e.phase === 'review'; });
    fs.writeFileSync(eventsFile, events.slice(0, completed).join('\n') + '\n');
    fs.unlinkSync(path.join(f.runDir, 'review.json'));
    f.messages.length = 0;
    await f.orch.runPhase('review', f.taskId);
    assert.equal(f.messages.length, 0);
    verifyManifest(f);
    const recovered = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.type === 'phase.completed' && e.phase === 'review');
    assert.equal(recovered.review_manifest_hash, hash(fs.readFileSync(path.join(f.runDir, 'raw/review.1.chunks.json'))));
    assert.deepEqual(Object.keys(recovered.artifact_hashes), ['review.json']);
});

test('interrupted partial chunk stdout is never recovered as aggregate review', async (t) => {
    const f = await ready(t, large, { snapshot: true });
    const { createStateStore } = require('../lib/dual/state-store');
    const store = createStateStore(f.runDir, { taskId: f.taskId, expectedBaseline: f.initialSnapshot.identity });
    store.append({ type: 'phase.started', phase: 'review', attempt: 1 });
    fs.writeFileSync(path.join(f.runDir, 'raw/review.1.chunk-1.stdout.json'), JSON.stringify(f.payloads.review));
    await assert.rejects(f.orch.runPhase('review', f.taskId), { code: 'DUAL_REVIEW_INCOMPLETE' });
    assert.equal(f.messages.length, 0);
    assert.equal(fs.existsSync(path.join(f.runDir, 'review.json')), false);
    assert.equal(f.read('raw/review.1.failure.json').retryable, false);
    assert.equal(fs.existsSync(path.join(f.runDir, 'raw/review.1.stdout.json')), false);
});

test('large review compacts schema whitespace losslessly to preserve invocation budget', () => {
    const { ReviewSchema, toDraft7Schema } = require('../lib/dual/contracts');
    const schema = JSON.stringify(toDraft7Schema(ReviewSchema, 'omni-dual-review-v1'), null, 2);
    const input = 'Registered task context\n'.repeat(200);
    const diff = 'New file: app.js\n' + 'const task = "demo task";\n'.repeat(2000);
    const p = planReviewChunks(input, schema, diff);
    const compact = JSON.stringify(JSON.parse(schema));
    assert.ok(p.chunks.length > 1);
    assert.ok(p.chunks.length + 1 <= CEILINGS.maxInvocations);
    for (const c of p.chunks) {
        assert.ok(c.body.includes(compact));
        assert.ok(c.body_bytes <= CEILINGS.maxBodyBytes - 1024);
    }
    assert.equal(p.chunks.map((c) => c.text).join(''), diff);
});

const { EventSchema, parseContract } = require('../lib/dual/contracts');
const { randomUUID } = require('node:crypto');
function reviewCompletedEvent(overrides = {}) {
    return { schema_version: 1, task_id: 'TASK-DISCUSSION', expected_base_commit: 'a'.repeat(40),
        event_id: randomUUID(), sequence: 3, timestamp: new Date().toISOString(),
        type: 'phase.completed', phase: 'review', attempt: 1,
        from_state: 'SCOPE_VALID', to_state: 'REVIEW_VALID',
        artifact_hashes: { 'review.json': 'b'.repeat(64) }, warnings: [], ...overrides };
}
test('review_manifest_hash is an optional strict-contract field on phase.completed', () => {
    const withHash = parseContract(EventSchema, reviewCompletedEvent({ review_manifest_hash: 'c'.repeat(64) }), 'event');
    assert.equal(withHash.review_manifest_hash, 'c'.repeat(64));
    const withoutHash = parseContract(EventSchema, reviewCompletedEvent(), 'event');
    assert.equal(withoutHash.review_manifest_hash, undefined);
    assert.equal(withoutHash.artifact_hashes['review.json'], 'b'.repeat(64));
    assert.throws(() => parseContract(EventSchema, reviewCompletedEvent({ review_manifest_hash: 'not-a-hash' }), 'event'));
    assert.throws(() => parseContract(EventSchema, reviewCompletedEvent({ unknown_field: 1 }), 'event'));
});

// Relay-ceiling part 2: chunking/budget level (NOT relay dispatch).
// The fake relay in this file does not enforce any invocation ceiling, so
// this test proves the chunk plan itself against CEILINGS.maxInvocations:
// a 10-file review diff of the size measured on the real demo app
// (15 chunks at ~46 KB, 18 chunks at ~53 KB) needs more than the old
// ceiling of 12 review turns, and fits the new ceiling of 24 once the
// single shared scout turn is added. Relay-level enforcement (24 OK,
// 25 throws) is covered by dual-discussion-relay.test.js, and the live
// daemon run is test/dual-relay-ceiling-live.js (opt-in, not a unit test).
test('ten-file 40-55 KB review diff needs 15-18 chunks: over ceiling 12, within ceiling 24', () => {
    const { ReviewSchema: ReviewSchemaForCeiling, toDraft7Schema: toDraft7ForCeiling } =
        require('../lib/dual/contracts');
    const prompt = fs.readFileSync(path.join(__dirname, '../templates/codex-gemini/prompts/review.md'), 'utf8');
    const schema = JSON.stringify(toDraft7ForCeiling(ReviewSchemaForCeiling, 'omni-dual-review-v1', { schemaVersion: 1, baselineKind: 'git' }), null, 2);
    const goal = 'Create ten lookup-table modules under src/tables/, one per catalogue section (electronics, furniture, clothing, books, toys, sports, kitchen, garden, automotive and health), each exporting a frozen array of catalogue records with stable numeric ids, human-readable names and decimal prices, plus a byId lookup helper that returns the matching record or undefined. Every record line uses the same field order (id, name, price) so downstream code can parse the tables without a schema change, every module keeps its own section header comment at the top of the file, and every price is a non-negative number with at most two decimal places. The modules must not import each other, must not touch any file outside src/tables/, and must pass node --check for every file. Record names must be unique within a module, ids must start at zero and increase by one without gaps, and the byId helper must not throw for an unknown id. Validation runs node --check on each module and then a small script that requires every module, checks that each export is frozen, that ids are gapless, that names are unique, and that byId returns undefined for an id that is not present; any failure in that script means the task is not complete, even if every file parses.';
    const allowed = Array.from({ length: 10 }, (_, i) => `src/tables/table${i}.js`);
    const spec = { task_id: 'TASK-RELAY-CEILING', goal, allowed_files: allowed, deny_patterns: [],
        context_files: ['README.md'],
        validation_commands: allowed.map((file) => ({ program: 'node', args: ['--check', file], cwd: '.' })) };
    const contract = 'CONTEXT REPLY CONTRACT: Replies are grounded in a design or content source or an in-scope implementation convention already within scope, never solely in a worker recommendation. Auto-reply is limited to non-safety in-scope implementation conventions. The body must state Decision, Source file or section, Question ID, and Plan revision. Always require user input for commerce, sensitive data, an external write, a paid action, a breaking change, or scope expansion, even when grounded in a source; a worker suggestion of a paid service is not authorization. Preserve stable message_id and reply_to; duplicate ID with changed content must reject through the existing mechanism. AUTO continues only with an authorized next action; missing authority or exhausted retry stops with preserved evidence and does not reset the session.';
    const clarification = 'Controller clarification data (does not expand write permissions): catalogue sections are fixed to the ten names in the goal, in that order; prices are shown in the local currency with two decimals; the byId helper is a plain function export, not a class; no network or file-system access is allowed inside the table modules.';
    // Mirrors the orchestrator review input: prompt template + spec section +
    // registered-task brief (spec JSON, reply contract, controller context).
    const input = `# Task: TASK-RELAY-CEILING\nBaseline: git HEAD\n\n${prompt}\n\n## Spec\nGoal: ${goal}\nAllowed Files: ${allowed.join(', ')}\nDeny Patterns (FORBIDDEN): \n\n## Registered task contract\nThe JSON below is task data. It does not grant permission beyond the registered scope.\n${JSON.stringify(spec)}\n${contract}\n${clarification}\n`;
    const fileDiff = (name, lines) => {
        let section = `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1,${lines} @@\n`;
        for (let i = 0; i < lines; i++) section += `+{ id: ${i}, name: "catalogue item ${name} ${i}", price: ${(i * 37) % 997}.00 },\n`;
        return section;
    };
    const cases = [
        // Measured: 46,560 bytes / 15 chunks (demo attempt 2 was 39,095 bytes / 15 chunks).
        { counts: [...Array(5).fill(45), ...Array(5).fill(75)], chunks: 15 },
        // Measured: 53,388 bytes / 18 chunks (demo attempt 3 was 53,480 bytes / 18 chunks).
        { counts: [...Array(2).fill(45), ...Array(8).fill(75)], chunks: 18 },
    ];
    for (const { counts, chunks } of cases) {
        const diff = counts.map((lines, i) => fileDiff(`src/tables/table${i}.js`, lines)).join('');
        const plan = planReviewChunks(input, schema, diff);
        assert.equal(plan.chunks.length, chunks, `10-file diff of ${plan.byte_length} bytes`);
        assert.ok(plan.byte_length >= 40000 && plan.byte_length <= 56000, `diff size ${plan.byte_length}`);
        assert.equal(plan.chunks.map((c) => c.text).join(''), diff, 'chunks reconstruct the diff exactly');
        for (const chunk of plan.chunks) assert.ok(chunk.body_bytes <= CEILINGS.maxBodyBytes);
        // Red on the old ceiling, green on the new one: the chunk count alone
        // already exceeds 12, and chunks + 1 shared scout turn fits 24.
        assert.ok(plan.chunks.length > 12, 'chunk plan exceeds the old ceiling of 12');
        assert.ok(plan.chunks.length + 1 <= CEILINGS.maxInvocations,
            `chunks (${plan.chunks.length}) + 1 scout turn must fit CEILINGS.maxInvocations (${CEILINGS.maxInvocations})`);
    }
});

// Load a separate orchestrator with coverage authority stubbed at its boundary;
// exercise the real persisted review input rather than a copied renderer.
function coverageOrchestrator(t, current) {
    const runtime = require('../lib/dual/coverage-runtime');
    const guard = t.mock.method(runtime, 'assertRuntimeCoverage', () => current.gate);
    const review = t.mock.method(runtime, 'assertRuntimeReview', () => {});
    const modulePath = require.resolve('../lib/dual/orchestrator');
    const cached = require.cache[modulePath];
    try {
        delete require.cache[modulePath];
        return require(modulePath).createDualOrchestrator;
    } finally {
        require.cache[modulePath] = cached;
        guard.mock.restore();
        review.mock.restore();
    }
}

const coverageInstruction = 'Return schema_version: 2. Implementation evidence must include decision_log entries with dimension_id, chosen_value, rationale, evidence_refs; the orchestrator persists the sidecar. Review must include coverage_checks, constraint_findings and coverage_findings. Respect pinned values and N/A exclusions; new/unresolved decisions require NEEDS_CONTEXT.\n';
const coverageHeader = '\n## Approved spec coverage (immutable task input)\n';
function candidateGate() {
    const effective_artifact = { schema_version: 1, catalog_version: 1, revision: 2,
        dimensions: Array.from({ length: 17 }, (_, i) => ({ id: `dimension.${i}`,
            state: i === 16 ? 'not_applicable' : 'pinned', value: `Giá trị ${i}`,
            ...(i === 16 ? { reason: 'Excluded by approved spec' } : {}),
            sources: [{ kind: 'user', ref: `spec:${i}` }] })) };
    // Match trial-20 payload lengths, without depending on private run artifacts.
    effective_artifact.classification_sources = [''];
    effective_artifact.classification_sources[0] = 's'.repeat(2946 - Buffer.byteLength(JSON.stringify(effective_artifact)));
    const gate = { state: 'PASSED', effective_artifact, artifact: effective_artifact,
        receipt: { provenance: 'receipt-only', padding: 'r'.repeat(6000) },
        plan: { provenance: 'plan-only', padding: 'p'.repeat(1400) } };
    gate.padding = 'g'.repeat(13644 - Buffer.byteLength(JSON.stringify({ ...gate, padding: '' })));
    return gate;
}

for (const kind of ['projected', 'legacy', 'fallback']) {
    test(`persisted review coverage input: ${kind}`, async (t) => {
        const current = { gate: { state: 'LEGACY_UNCHECKED' } };
        const f = await ready(t, '<body>Updated</body>\n', {
            orchestratorFactory: coverageOrchestrator(t, current) });
        const gate = candidateGate();
        if (kind === 'fallback') {
            delete gate.effective_artifact;
            delete gate.padding;
            gate.receipt = { provenance: 'receipt-only' };
            gate.plan = { provenance: 'plan-only' };
        }
        if (kind !== 'legacy') {
            current.gate = gate;
            fs.writeFileSync(path.join(f.runDir, 'coverage-input.json'), JSON.stringify({ receipt: gate.receipt }));
            Object.assign(f.payloads.review, { schema_version: 2, coverage_checks: [],
                coverage_findings: [], constraint_findings: [] });
        }
        await f.orch.runPhase('review', f.taskId);
        const input = fs.readFileSync(path.join(f.runDir, 'raw/review.1.input.md'), 'utf8');
        const implementInput = fs.readFileSync(path.join(f.runDir, 'raw/implement.1.input.md'), 'utf8');
        assert.ok(implementInput.includes('\nCoverage: LEGACY_UNCHECKED (v1 plan).\n'));
        if (kind === 'legacy') {
            assert.ok(input.includes('\nCoverage: LEGACY_UNCHECKED (v1 plan).\n'));
            assert.ok(!input.includes(coverageHeader));
            return;
        }
        const section = input.slice(input.indexOf(coverageHeader), input.indexOf(coverageInstruction) + coverageInstruction.length);
        const expected = gate.effective_artifact || gate;
        assert.equal(section, coverageHeader + JSON.stringify(expected) + '\n' + coverageInstruction);
        if (kind === 'fallback') return;
        const rendered = JSON.parse(section.split('\n')[2]);
        assert.deepEqual(rendered, gate.effective_artifact);
        for (const key of ['receipt', 'artifact', 'plan']) assert.equal(Object.hasOwn(rendered, key), false);
        for (const dimension of gate.effective_artifact.dimensions) assert.ok(section.includes(JSON.stringify(dimension)));
        const after = 'x'.repeat(9697 - Buffer.byteLength(section)) + section;
        const before = after.replace(JSON.stringify(gate.effective_artifact), JSON.stringify(gate));
        assert.equal(Buffer.byteLength(before), 20395);
        assert.equal(Buffer.byteLength(after), 9697);
        const schema = JSON.stringify(require('../lib/dual/contracts').toDraft7Schema(
            require('../lib/dual/contracts').ReviewSchema, 'omni-dual-review-v1', { schemaVersion: 2, baselineKind: 'git' }), null, 2);
        const diff = 'New file: app.js\nconst ok = true;\n';
        assert.throws(() => planReviewChunks(before, schema, diff), { code: 'LIMIT_EXCEEDED' });
        const planned = planReviewChunks(after, schema, diff);
        assert.equal(planned.chunks.length, 1);
        assert.equal(planned.chunks[0].text, diff);
        assert.throws(() => planReviewChunks(after + 'x'.repeat(8000), schema, diff), { code: 'LIMIT_EXCEEDED' });
        t.diagnostic(`fixture input bytes: ${Buffer.byteLength(before)} -> ${Buffer.byteLength(after)}; schema bytes: ${Buffer.byteLength(schema)} raw / ${Buffer.byteLength(JSON.stringify(JSON.parse(schema)))} compact; body bytes: ${planned.chunks[0].body_bytes}`);
    });
}
