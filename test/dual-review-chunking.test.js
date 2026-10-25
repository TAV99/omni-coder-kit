'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { createDualOrchestrator } = require('../lib/dual/orchestrator');
const { buildBindings } = require('../lib/dual/discussion/session');

async function fixture(t, { enabled, missingResolver = false, disabledSession = false, unknown = false, invalid = false, snapshot = false, taskId = 'TASK-DISCUSSION', allowedFiles = ['index.html'] } = {}) {
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
    const orch = createDualOrchestrator({ workerModel: 'gemini-3.7-flash-high', workerEffort: 'high', cwd: repoRoot, backend: snapshot ? 'snapshot' : 'git', initialSnapshot,
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
