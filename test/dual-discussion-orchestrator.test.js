'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { createDualOrchestrator, DualOrchestratorError } = require('../lib/dual/orchestrator');
const { AttemptMetaSchema } = require('../lib/dual/contracts');
const { createOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
const { bindingRef } = require('../lib/dual/discussion/contracts');
const { buildBindings } = require('../lib/dual/discussion/session');
const { DiscussionPhaseError } = require('../lib/dual/discussion/phase-bridge');

function expectedScoutPrompt(runDir) {
    return `${fs.readFileSync(path.join(runDir, 'raw/scout.1.input.md'), 'utf8')}\n\n--- PHASE OUTPUT SCHEMA (JSON Schema) ---\n${fs.readFileSync(path.join(runDir, 'raw/scout.1.schema.json'), 'utf8')}\nAnswer with ONLY a JSON object matching this schema.\n`;
}

async function fixture(t, { enabled, missingResolver = false, disabledSession = false, unknown = false, invalid = false, snapshot = false, taskId = 'TASK-DISCUSSION' } = {}) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-discussion-orch-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const git = (...args) => {
        const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
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
            goal: 'Keep entry valid', allowed_files: ['index.html'], deny_patterns: [],
            validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
            risk_flags: [], permission_authority: 'dual-init-dangerous-auto-v1' }));
        await orch.runPhase('spec', taskId);
        await orch.runPhase('route', taskId);
    }
    return { orch, taskId, repoRoot, runDir, read, payloads, agyCalls, bridgeCalls, contexts, messages, session, route, initialSnapshot };
}

for (const enabled of [undefined, false, 'true', 1]) {
    test(`discussion enabled=${String(enabled)} requires discussion without recording scout events`, async (t) => {
        const f = await fixture(t, { enabled, snapshot: true });
        const eventsBefore = fs.readFileSync(path.join(f.runDir, 'events.ndjson'), 'utf8');
        await assert.rejects(f.orch.runPhase('scout', f.taskId), { code: 'DUAL_DISCUSSION_REQUIRED' });
        assert.equal(fs.readFileSync(path.join(f.runDir, 'events.ndjson'), 'utf8'), eventsBefore);
        for (const suffix of ['failure.json', 'input.md', 'schema.json']) {
            assert.equal(fs.existsSync(path.join(f.runDir, `raw/scout.1.${suffix}`)), false);
        }
        assert.equal(f.agyCalls.length, 0);
        assert.equal(f.bridgeCalls.length, 0);
        assert.equal(f.contexts.length, 0);
    });
}

test('missing discussion does not poison a task retried with valid discussion', async (t) => {
    const f = await fixture(t, { snapshot: true });
    const eventsBefore = fs.readFileSync(path.join(f.runDir, 'events.ndjson'), 'utf8');
    await assert.rejects(f.orch.runPhase('scout', f.taskId), { code: 'DUAL_DISCUSSION_REQUIRED' });
    assert.equal(fs.readFileSync(path.join(f.runDir, 'events.ndjson'), 'utf8'), eventsBefore);
    assert.equal(fs.existsSync(path.join(f.runDir, 'raw/scout.1.failure.json')), false);
    assert.equal(f.agyCalls.length, 0);
    assert.equal(f.orch.status(f.taskId).nextAction, 'scout');

    const configured = createDualOrchestrator({ workerModel: 'gemini-3.7-flash-high', workerEffort: 'high', cwd: f.repoRoot, backend: 'snapshot', initialSnapshot: f.initialSnapshot,
        authoritativeCapabilityEvidence: { version: '1.1.19', model: 'gemini-3.7-flash-high' },
        discussion: { enabled: true, sessionResolver: async () => f.session },
        processRunner: async () => { assert.fail('Scout must not invoke the cold worker'); } });
    assert.equal((await configured.runPhase('scout', f.taskId)).state, 'SCOUT_VALID');
    assert.deepEqual(f.read('context.json'), f.payloads.scout);
    assert.equal(f.read('raw/scout.1.meta.json').attempt, 1);
    assert.equal(f.bridgeCalls.length, 1);
});

test('review without discussion records no phase events and can run after configuration', async (t) => {
    const f = await fixture(t, { enabled: true, snapshot: true });
    await f.orch.runPhase('scout', f.taskId);
    await f.route();
    await f.orch.runPhase('implement', f.taskId);
    await f.orch.runPhase('scope', f.taskId);
    const eventsBefore = fs.readFileSync(path.join(f.runDir, 'events.ndjson'), 'utf8');
    const unconfigured = createDualOrchestrator({ workerModel: 'gemini-3.7-flash-high', workerEffort: 'high', cwd: f.repoRoot, backend: 'snapshot', initialSnapshot: f.initialSnapshot,
        authoritativeCapabilityEvidence: { version: '1.1.19', model: 'gemini-3.7-flash-high' },
        processRunner: async () => { assert.fail('Review must not invoke the cold worker'); } });
    await assert.rejects(unconfigured.runPhase('review', f.taskId), { code: 'DUAL_DISCUSSION_REQUIRED' });
    assert.equal(fs.readFileSync(path.join(f.runDir, 'events.ndjson'), 'utf8'), eventsBefore);
    for (const suffix of ['failure.json', 'input.md', 'schema.json']) {
        assert.equal(fs.existsSync(path.join(f.runDir, `raw/review.1.${suffix}`)), false);
    }
    assert.equal((await f.orch.runPhase('review', f.taskId)).state, 'CODEX_QC');
    assert.equal(f.read('raw/review.1.meta.json').attempt, 1);
});

test('opt-in scout preserves payload, public return shape, raw observation and binding direction', async (t) => {
    const f = await fixture(t, { enabled: true });
    const result = await f.orch.runPhase('scout', f.taskId);
    assert.deepEqual(result, { taskId: f.taskId, state: 'SCOUT_VALID', owner: 'codex', nextAction: 'spec', warnings: [], reused: false });
    assert.deepEqual(f.read('context.json'), f.payloads.scout);
    assert.equal(f.agyCalls.length, 0);
    assert.equal(f.bridgeCalls.length, 1);
    assert.deepEqual(f.contexts[0], { taskId: f.taskId,
        snapshotSha256: undefined, phase: 'scout', workspaceRoot: f.repoRoot, workerModel: 'gemini-3.7-flash-high', workerEffort: 'high' });
    const question = f.messages[0];
    assert.equal(question.sender_ref, bindingRef(f.session.bindings[0]));
    assert.equal(question.recipient_ref, bindingRef(f.session.bindings[1]));
    assert.equal(question.body, expectedScoutPrompt(f.runDir));
    const meta = f.read('raw/scout.1.meta.json');
    assert.deepEqual(AttemptMetaSchema.parse(meta), meta);
    assert.equal(meta.transport, 'discussion');
    assert.equal(meta.messageId, question.message_id);
    assert.equal(meta.responseMessageId, f.messages[1].message_id);
    assert.equal(meta.attempt, 1);
    assert.equal(meta.exit_code, 0);
    assert.equal(meta.timed_out, false);
    assert.equal(Date.parse(meta.ended_at) - Date.parse(meta.started_at), meta.duration_ms);
    assert.equal(fs.readFileSync(path.join(f.runDir, 'raw/scout.1.stdout.json'), 'utf8'), f.messages[1].body);
});

test('discussion scout receives the output schema from its phase schema file', async (t) => {
    const f = await fixture(t, { enabled: true, snapshot: true });
    await f.orch.runPhase('scout', f.taskId);
    const schemaContent = fs.readFileSync(path.join(f.runDir, 'raw/scout.1.schema.json'), 'utf8');
    assert.ok(schemaContent.includes('research_trace'));
    assert.ok(f.messages[0].body.includes('--- PHASE OUTPUT SCHEMA (JSON Schema) ---'));
    assert.ok(f.messages[0].body.includes(schemaContent));
    assert.ok(f.messages[0].body.endsWith('Answer with ONLY a JSON object matching this schema.\n'));
});

test('opt-in implement stays on fake AGY; review uses discussion', async (t) => {
    const f = await fixture(t, { enabled: true });
    await f.orch.runPhase('scout', f.taskId);
    await f.route();
    const result = await f.orch.runPhase('implement', f.taskId);
    assert.equal(result.state, 'IMPLEMENT_VALID');
    assert.equal(f.agyCalls.length, 1);
    assert.equal(f.bridgeCalls.length, 1);
    await f.orch.runPhase('scope', f.taskId);
    const review = await f.orch.runPhase('review', f.taskId);
    assert.equal(review.state, 'CODEX_QC');
    assert.deepEqual(f.read('review.json'), f.payloads.review);
    assert.deepEqual(f.contexts.map((c) => c.phase), ['scout', 'review']);
    assert.equal(f.bridgeCalls.length, 2);
});

for (const [option, code] of [['missingResolver', 'DUAL_DISCUSSION_RESOLVER_REQUIRED'], ['disabledSession', 'DUAL_DISCUSSION_SESSION_DISABLED']]) {
    test(`opt-in ${option} fails closed without AGY`, async (t) => {
        const f = await fixture(t, { enabled: true, [option]: true });
        await assert.rejects(f.orch.runPhase('scout', f.taskId), (err) => err instanceof DualOrchestratorError && err.code === code);
        assert.equal(f.agyCalls.length, 0);
        assert.equal(f.bridgeCalls.length, 0);
    });
}

test('unknown outcome propagates bridge details after exactly one call without retry', async (t) => {
    const f = await fixture(t, { enabled: true, unknown: true });
    await assert.rejects(f.orch.runPhase('scout', f.taskId), (err) => {
        assert.ok(err instanceof DiscussionPhaseError);
        assert.equal(err.code, 'OUTCOME_UNKNOWN');
        assert.equal(err.details.invocationId, 'inv-unknown');
        assert.equal(err.details.messageId, f.bridgeCalls[0]);
        assert.equal(err.details.bindingRef, 'worker-ref');
        return true;
    });
    assert.equal(f.bridgeCalls.length, 1);
    assert.equal(f.agyCalls.length, 0);
});

for (const phase of ['scout', 'review']) {
    test(`discussion ${phase} terminal failure cannot dispatch again or fall back cold`, async (t) => {
        const f = await fixture(t, { enabled: true, snapshot: true });
        if (phase === 'review') {
            await f.orch.runPhase('scout', f.taskId);
            await f.route();
            await f.orch.runPhase('implement', f.taskId);
            await f.orch.runPhase('scope', f.taskId);
        }
        const callsBefore = f.bridgeCalls.length;
        const coldBefore = f.agyCalls.length;
        f.session.relay.dispatch = async (id) => {
            f.bridgeCalls.push(id);
            throw Object.assign(new Error('outcome unavailable'), { code: 'OUTCOME_UNKNOWN' });
        };
        await assert.rejects(f.orch.runPhase(phase, f.taskId), { code: 'OUTCOME_UNKNOWN' });
        await assert.rejects(f.orch.runPhase(phase, f.taskId), { code: 'OUTCOME_UNKNOWN' });
        assert.equal(f.bridgeCalls.length, callsBefore + 1);
        assert.equal(f.agyCalls.length, coldBefore);
        assert.equal(f.read(`raw/${phase}.1.failure.json`).retryable, false);
    });
}

test('invalid discussion payload exhausts one correction and saves bounded failure evidence', async (t) => {
    const f = await fixture(t, { enabled: true, invalid: true });
    await assert.rejects(f.orch.runPhase('scout', f.taskId), (err) =>
        err instanceof DiscussionPhaseError && err.code === 'RESULT_MALFORMED');
    assert.equal(f.bridgeCalls.length, 2);
    assert.equal(f.agyCalls.length, 0);
    const failure = f.read('raw/scout.1.failure.json');
    assert.ok(failure.rawReplyExcerpt.includes('summary'));
    assert.ok(failure.rawReplyExcerpt.length <= 4096);
    assert.ok(failure.validationIssues.includes('Invalid Agy payload contract'));
    assert.equal(fs.existsSync(path.join(f.runDir, 'context.json')), false);
});

test('discussion raw evidence recovers scout after interruption without a second bridge call', async (t) => {
    const f = await fixture(t, { enabled: true });
    await f.orch.runPhase('scout', f.taskId);
    const eventsPath = path.join(f.runDir, 'events.ndjson');
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    // Simulate the crash boundary after raw evidence, before phase.completed.
    lines.pop();
    fs.writeFileSync(eventsPath, `${lines.join('\n')}\n`);
    const recovered = await f.orch.runPhase('scout', f.taskId);
    assert.deepEqual(recovered.warnings, []);
    assert.equal(recovered.state, 'SCOUT_VALID');
    assert.deepEqual(f.read('context.json'), f.payloads.scout);
    assert.equal(f.bridgeCalls.length, 1);
    assert.equal(f.agyCalls.length, 0);
});

test('CLI discussion env is strict and preserves an injected resolver', async (t) => {
    const { getOrchestrator } = require('../lib/commands/dual');
    const original = process.env.OMNI_DUAL_DISCUSSION_ENABLED;
    t.after(() => {
        if (original === undefined) delete process.env.OMNI_DUAL_DISCUSSION_ENABLED;
        else process.env.OMNI_DUAL_DISCUSSION_ENABLED = original;
    });
    const cases = [
        [undefined, false], ['', false], ['   ', false],
        ['0', false], ['false', false], ['off', false], ['no', false],
        ['1', true], ['true', true], ['on', true], ['yes', true],
        ['banana', false], ['01', false],
        [' 0 ', false], [' FALSE ', false], [' Off ', false], [' NO ', false],
        [' 1 ', true], [' TRUE ', true], [' On ', true], [' YES ', true],
    ];
    for (const [value, enabled] of cases) {
        if (value === undefined) delete process.env.OMNI_DUAL_DISCUSSION_ENABLED;
        else process.env.OMNI_DUAL_DISCUSSION_ENABLED = value;
        const f = await fixture(t, { snapshot: true });
        const calls = [];
        let processCalls = 0;
        const eventsBefore = fs.readFileSync(path.join(f.runDir, 'events.ndjson'), 'utf8');
        const orch = getOrchestrator({ workerModel: 'gemini-3.7-flash-high', workerEffort: 'high', cwd: f.repoRoot, backend: 'snapshot', initialSnapshot: f.initialSnapshot,
            authoritativeCapabilityEvidence: { version: '1.1.19', model: 'gemini-3.7-flash-high' },
            discussion: { sessionResolver: async (context) => { calls.push(context); return { enabled: false }; } },
            processRunner: async () => { processCalls++; assert.fail('Scout must not invoke the cold worker'); },
        });
        if (enabled) {
            await assert.rejects(orch.runPhase('scout', f.taskId), { code: 'DUAL_DISCUSSION_SESSION_DISABLED' });
            assert.equal(calls.length, 1);
        } else {
            await assert.rejects(orch.runPhase('scout', f.taskId), { code: 'DUAL_DISCUSSION_REQUIRED' });
            assert.equal(fs.readFileSync(path.join(f.runDir, 'events.ndjson'), 'utf8'), eventsBefore);
            assert.equal(calls.length, 0);
        }
        assert.equal(processCalls, 0);
    }
});


test('resolver context uses the active snapshot baseline identity', async (t) => {
    const f = await fixture(t, { enabled: true, snapshot: true });
    await f.orch.runPhase('scout', f.taskId);
    assert.equal(f.contexts[0].snapshotSha256, f.initialSnapshot.identity.id);
    assert.deepEqual(f.read('context.json'), f.payloads.scout);
});

for (const taskId of ['TASK-ALPHA', 'TASK-BETA']) {
    test(`truthful resolver context for ${taskId} without host identity`, async (t) => {
        const f = await fixture(t, { enabled: true, snapshot: true, taskId });
        const result = await f.orch.runPhase('scout', taskId);
        assert.deepEqual(f.contexts, [{ taskId, snapshotSha256: f.initialSnapshot.identity.id,
            phase: 'scout', workspaceRoot: f.repoRoot, workerModel: 'gemini-3.7-flash-high', workerEffort: 'high' }]);
        assert.deepEqual(AttemptMetaSchema.parse(f.read('raw/scout.1.meta.json')), f.read('raw/scout.1.meta.json'));
        assert.deepEqual(result.warnings, []);
    });
}

test('record bindings work for scout and recovery preserves live warnings', async (t) => {
    const f = await fixture(t, { enabled: true, snapshot: true });
    f.session.bindings = Object.fromEntries(f.session.bindings.map((b) => [b.role, b]));
    const live = await f.orch.runPhase('scout', f.taskId);
    const eventsPath = path.join(f.runDir, 'events.ndjson');
    const lines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n');
    lines.pop();
    fs.writeFileSync(eventsPath, `${lines.join('\n')}\n`);
    const recovered = await f.orch.runPhase('scout', f.taskId);
    assert.deepEqual(recovered.warnings, live.warnings);
    assert.equal(f.bridgeCalls.length, 1);
    assert.equal(f.agyCalls.length, 0);
});

for (const bindings of [undefined, [], {}, { only: 'astra' }, ['astra'], ['argon']]) {
    test(`missing discussion roles fails closed (${JSON.stringify(bindings)})`, async (t) => {
        const f = await fixture(t, { enabled: true, snapshot: true });
        f.session.bindings = Array.isArray(bindings)
            ? f.session.bindings.filter((b) => bindings.includes(b.role)) : bindings;
        await assert.rejects(f.orch.runPhase('scout', f.taskId), (err) =>
            err instanceof DualOrchestratorError && err.code === 'DUAL_DISCUSSION_BINDINGS_REQUIRED');
        const failure = f.read('raw/scout.1.failure.json');
        assert.equal(failure.error_code, 'DUAL_DISCUSSION_BINDINGS_REQUIRED');
        assert.equal(failure.retryable, false);
        assert.equal(f.agyCalls.length, 0);
        assert.equal(f.bridgeCalls.length, 0);
    });
}

for (const option of ['unknown', 'invalid', 'missingResolver', 'disabledSession']) {
    test(`discussion ${option} persists terminal failure evidence`, async (t) => {
        const f = await fixture(t, { enabled: true, snapshot: true, [option]: true });
        let failure;
        await assert.rejects(f.orch.runPhase('scout', f.taskId), (err) => { failure = err; return true; });
        const { rawReplyExcerpt, validationIssues, ...storedFailure } = f.read('raw/scout.1.failure.json');
        if (option === 'invalid') {
            assert.ok(rawReplyExcerpt.includes('summary'));
            assert.ok(validationIssues.includes('Invalid Agy payload contract'));
        }
        assert.deepEqual(storedFailure, {
            schema_version: 1, task_id: f.taskId, expected_baseline: f.initialSnapshot.identity,
            phase: 'scout', attempt: 1, error_code: failure.code, reason: failure.message.slice(0, 2048), retryable: false,
        });
        await assert.rejects(f.orch.runPhase('scout', f.taskId), (err) =>
            err.details.evidencePath === 'raw/scout.1.failure.json');
    });
}

test('discussion review receives delimited diff without altering saved input', async (t) => {
    const f = await fixture(t, { enabled: true, snapshot: true });
    await f.orch.runPhase('scout', f.taskId);
    await f.route();
    await f.orch.runPhase('implement', f.taskId);
    fs.writeFileSync(path.join(f.repoRoot, 'index.html'), '<body>Updated for review</body>\n');
    await f.orch.runPhase('scope', f.taskId);
    await f.orch.runPhase('review', f.taskId);
    const saved = fs.readFileSync(path.join(f.runDir, 'raw/review.1.input.md'), 'utf8');
    const prompt = f.messages.find((m) => m.body.includes('# Review')).body;
    assert.ok(prompt.startsWith(saved));
    assert.ok(prompt.includes('--- BEGIN REVIEW DIFF ---'));
    assert.ok(prompt.includes('index.html'));
    assert.ok(prompt.includes('Updated for review'));
    assert.ok(prompt.includes('--- END REVIEW DIFF ---'));
    assert.ok(prompt.includes('--- PHASE OUTPUT SCHEMA (JSON Schema) ---'));
    const schemaContent = fs.readFileSync(path.join(f.runDir, 'raw/review.1.schema.json'), 'utf8');
    assert.ok(schemaContent.includes('challenge_summary'));
    assert.ok(prompt.includes(schemaContent));
    assert.equal(saved.includes('--- BEGIN REVIEW DIFF ---'), false);
    assert.equal(saved.includes('Updated for review'), false);
});

test('authority adapter forwards discussion verbatim to its task orchestrator', async (t) => {
    const f = await fixture(t, { snapshot: true });
    const derived = { sessionId: 'adapter-session', workspaceId: 'adapter-workspace', planRevision: 1,
        currentBaseline: f.initialSnapshot.identity,
        capability: { status: 'PASSED', to_state: 'CAPABILITY_SAFE',
            checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
            details: { agy_version: '1.1.19', agy_model: 'gemini-3.7-flash-high' } } };
    const { writeInitialSnapshot } = require('../lib/dual/snapshot-store');
    writeInitialSnapshot({ authorityDir: path.join(f.repoRoot, '.omni/runs/dual-authority'),
        sessionId: derived.sessionId, workspaceId: derived.workspaceId,
        workspaceRoot: f.repoRoot, identity: f.initialSnapshot.identity, manifest: f.initialSnapshot.manifest });
    const sentinel = new Error('adapter resolver reached');
    const calls = [];
    const discussion = { enabled: true, sessionResolver: async (context) => { calls.push(context); return f.session; } };
    f.session.relay.dispatch = async (id) => { f.bridgeCalls.push(id); throw sentinel; };
    const adapter = createOrchestratorAdapter({ workerModel: 'gemini-3.7-flash-high', workerEffort: 'high', workspaceRoot: f.repoRoot, discussion,
        processRunner: async () => { throw new Error('Cold-start must not run'); },
        authorityStore: { derive: () => derived, acquireLease: () => ({ lease_id: 'lease-1' }), releaseLease() {} },
        operationWriter: {}, setIntervalFn: () => null, clearIntervalFn() {} });
    await assert.rejects(adapter.executeAgyTask(f.taskId, { owner: 'agy', risk: 'low', goal: 'Adapter scout',
        allowed_files: ['index.html'], deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }] }, derived), (err) => err === sentinel);
    assert.equal(f.bridgeCalls.length, 1);
    assert.equal(f.messages[0].body, expectedScoutPrompt(f.runDir));
    assert.deepEqual(calls, [{ taskId: f.taskId, snapshotSha256: f.initialSnapshot.identity.id,
        phase: 'scout', workspaceRoot: f.repoRoot, workerModel: 'gemini-3.7-flash-high', workerEffort: 'high' }]);
});

test('one orchestrator resolves distinct contexts for two tasks in the same workspace', async (t) => {
    const f = await fixture(t, { enabled: true, snapshot: true });
    await f.orch.runPhase('scout', f.taskId);
    const secondTask = 'TASK-SECOND';
    f.payloads.scout.task_id = secondTask;
    f.orch.newTask(secondTask);
    await f.orch.runPhase('preflight', secondTask);
    await f.orch.runPhase('scout', secondTask);
    assert.deepEqual(f.contexts.map((c) => c.taskId), [f.taskId, secondTask]);
    assert.equal(f.contexts[0].workspaceRoot, f.contexts[1].workspaceRoot);
    assert.equal(f.contexts[0].snapshotSha256, f.contexts[1].snapshotSha256);
    assert.ok(f.contexts.every((c) => !('sessionId' in c) && !('planRevision' in c)));
});

test('discussion review keeps diff contents out of saved input bytes', async (t) => {
    const inputs = [];
    for (const changed of [false, true]) {
        const f = await fixture(t, { enabled: true, snapshot: true });
        await f.orch.runPhase('scout', f.taskId);
        await f.route();
        await f.orch.runPhase('implement', f.taskId);
        if (changed) fs.writeFileSync(path.join(f.repoRoot, 'index.html'), '<body>Changed</body>\n');
        await f.orch.runPhase('scope', f.taskId);
        await f.orch.runPhase('review', f.taskId);
        inputs.push(fs.readFileSync(path.join(f.runDir, 'raw/review.1.input.md')));
        assert.equal(f.agyCalls.length, 1);
    }
    assert.deepEqual(inputs[0], inputs[1]);
});


test('schema nudge uses existing payload contract and persists correction metadata', async (t) => {
    const f = await fixture(t, { enabled: true });
    const dispatch = f.session.relay.dispatch;
    f.session.relay.dispatch = async (id) => {
        const turn = await dispatch(id);
        if (f.bridgeCalls.length === 1) f.messages.at(-1).body = JSON.stringify({ ...f.payloads.scout, summary: 42 });
        return turn;
    };
    await f.orch.runPhase('scout', f.taskId);
    assert.equal(f.bridgeCalls.length, 2);
    assert.equal(f.agyCalls.length, 0);
    assert.ok(f.messages[2].body.startsWith(expectedScoutPrompt(f.runDir)));
    assert.ok(f.messages[2].body.includes('summary'));
    assert.equal(f.read('raw/scout.1.meta.json').discussionCorrection, 'schema-nudge');
    assert.deepEqual(AttemptMetaSchema.parse(f.read('raw/scout.1.meta.json')), f.read('raw/scout.1.meta.json'));
    assert.deepEqual(f.read('context.json'), f.payloads.scout);
});

for (const suffix of ['', '+nudge-denied']) {
    test(`discussion failure captures raw reply, repair and nudge (${suffix})`, async (t) => {
        const f = await fixture(t, { enabled: true });
        const dispatch = f.session.relay.dispatch;
        f.session.relay.dispatch = async (id) => {
            const turn = await dispatch(id);
            f.messages.at(-1).body = JSON.stringify({ summary: 42, text: 'x'.repeat(5000) });
            return { ...turn, evidence_ref: `agy-json;payload-repair=fence+bare_object+nudge${suffix}` };
        };
        await assert.rejects(f.orch.runPhase('scout', f.taskId), { code: 'RESULT_MALFORMED' });
        const failure = f.read('raw/scout.1.failure.json');
        assert.equal(failure.rawReplyExcerpt.length, 4096);
        assert.ok(failure.validationIssues.includes('Invalid Agy payload contract'));
        assert.equal(failure.repairKind, 'fence+bare_object');
        assert.equal(failure.nudged, true);
        assert.equal(f.bridgeCalls.length, 2);
    });
}

test('reconciled discussion re-ask persists recovery metadata', async (t) => {
    const f = await fixture(t, { enabled: true });
    const dispatch = f.session.relay.dispatch;
    let recoveries = 0;
    f.session.relay.reconcile = async () => {
        recoveries++;
        return { reconciled: true, reconciled_outcome: 'failed' };
    };
    f.session.relay.dispatch = async (id) => {
        if (recoveries === 0) {
            f.bridgeCalls.push(id);
            throw Object.assign(new Error('unknown'), { code: 'OUTCOME_UNKNOWN' });
        }
        return dispatch(id);
    };
    await f.orch.runPhase('scout', f.taskId);
    assert.equal(f.bridgeCalls.length, 2);
    assert.equal(recoveries, 1);
    assert.equal(f.read('raw/scout.1.meta.json').discussionRecovery, 'reconciled-retry');
    assert.equal(f.agyCalls.length, 0);
});


test('discussion failure redacts secrets from the last raw reply', async (t) => {
    const f = await fixture(t, { enabled: true });
    const dispatch = f.session.relay.dispatch;
    f.session.relay.dispatch = async (id) => {
        const turn = await dispatch(id);
        f.messages.at(-1).body = JSON.stringify({ summary: 42, api_key: 'secret-value',
            reply: f.bridgeCalls.length === 1 ? 'first reply' : 'last reply' });
        return turn;
    };
    await assert.rejects(f.orch.runPhase('scout', f.taskId), { code: 'RESULT_MALFORMED' });
    const failure = f.read('raw/scout.1.failure.json');
    assert.ok(failure.rawReplyExcerpt.includes('last reply'));
    assert.ok(!failure.rawReplyExcerpt.includes('first reply'));
    assert.ok(!failure.rawReplyExcerpt.includes('secret-value'));
    assert.ok(failure.rawReplyExcerpt.includes('[REDACTED]'));
});


test('unknown correction retains last available raw reply and validation issues', async (t) => {
    const f = await fixture(t, { enabled: true, invalid: true });
    const dispatch = f.session.relay.dispatch;
    f.session.relay.dispatch = async (id) => {
        if (f.bridgeCalls.length === 1) {
            f.bridgeCalls.push(id);
            throw Object.assign(new Error('correction unavailable'), { code: 'OUTCOME_UNKNOWN' });
        }
        return dispatch(id);
    };
    await assert.rejects(f.orch.runPhase('scout', f.taskId), { code: 'OUTCOME_UNKNOWN' });
    const failure = f.read('raw/scout.1.failure.json');
    assert.ok(failure.rawReplyExcerpt.includes('summary'));
    assert.ok(failure.validationIssues.includes('contract'));
    assert.equal(f.bridgeCalls.length, 2);
});

for (const diagnostic of [{ recoveryError: 'CAPABILITY_BLOCKED' }, { recoveryOutcome: 'succeeded' }]) {
    test(`discussion failure artifact preserves ${Object.keys(diagnostic)[0]}`, async (t) => {
        const f = await fixture(t, { enabled: true, unknown: true, snapshot: true });
        f.session.relay.reconcile = async () => {
            if (diagnostic.recoveryError) throw Object.assign(new Error('private'), { code: diagnostic.recoveryError });
            return { reconciled: true, reconciled_outcome: 'succeeded' };
        };
        await assert.rejects(f.orch.runPhase('scout', f.taskId), { code: 'OUTCOME_UNKNOWN' });
        const failure = f.read('raw/scout.1.failure.json');
        for (const [key, value] of Object.entries(diagnostic)) assert.equal(failure[key], value);
    });
}

test('schema-invalid observation excerpt reaches failure artifact without a stored reply', async (t) => {
    const f = await fixture(t, { enabled: true, snapshot: true });
    f.session.relay.dispatch = async () => ({ invocation_id: 'invalid-inv', schema: 'invalid',
        raw_reply_excerpt: 'token=secret-value\n' + 'x'.repeat(2000) });
    await assert.rejects(f.orch.runPhase('scout', f.taskId), { code: 'RESULT_MALFORMED' });
    const failure = f.read('raw/scout.1.failure.json');
    assert.equal(failure.rawReplyExcerpt.length, 1024);
    assert.ok(failure.rawReplyExcerpt.includes('[REDACTED]'));
    assert.ok(!failure.rawReplyExcerpt.includes('secret-value'));
});

test('settled failed re-ask persists failed-retry metadata', async (t) => {
    const f = await fixture(t, { enabled: true });
    const dispatch = f.session.relay.dispatch;
    f.session.relay.dispatch = async (id) => {
        if (f.bridgeCalls.length === 0) {
            f.bridgeCalls.push(id);
            return { provider: 'failed', message_id: id, invocation_id: 'inv-failed' };
        }
        return dispatch(id);
    };
    await f.orch.runPhase('scout', f.taskId);
    assert.equal(f.bridgeCalls.length, 2);
    assert.equal(f.messages[1].kind, 'reply');
    assert.equal(f.messages[1].reply_to, f.bridgeCalls[0]);
    assert.equal(f.messages[0].body, f.messages[2].body);
    assert.equal(f.read('raw/scout.1.meta.json').discussionRecovery, 'failed-retry');
    assert.equal(f.agyCalls.length, 0);
});
