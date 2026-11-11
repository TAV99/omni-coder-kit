'use strict';

// P5a (SPEC-SQUAD-P5 §2): an independent reviewer reviews each released isolated
// attempt before command QC. It sees spec, diff, evidence and scope files only;
// NEEDS_FIX rejects the handoff verbatim and opens a bounded correction.

require('./helpers/auto-approve-gates');

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { withDiscussion } = require('./helpers/dual-discussion-stub');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { getRuntimeDir } = require('../lib/dual/daemon-lock');
const { createOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
const { writeInitialSnapshot } = require('../lib/dual/snapshot-store');
const { readTaskBinding } = require('../lib/dual/task-workspace');
const { ReviewSchema } = require('../lib/dual/contracts');
const {
    reviewerConfig, needsReview, reviewApproved, runReviewerQc, settleReviewVerdict, rejectionFindings, prepareReviewRoot,
} = require('../lib/dual/reviewer-qc');
const { writeBinding } = require('../lib/squad/bindings');
const { fakeSpawn } = require('./helpers/squad-fakes');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'squad');
const CONFIG = { runtime: 'claude', model: 'sonnet', effort: 'low', maxCorrections: 3 };

// `beforeRun(store)` runs before the worker; `inputs` collects each phase's prompt (agy inlines the input).
async function handoff(t, { beforeRun, taskIds = ['TASK-1'], sessionId = 'session-1', planRevision = 1,
    questions = [], contextAnswer = 'Decision: return two. Source: spec.md. Scope unchanged.' } = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-reviewer-qc-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const tasks = taskIds.map((task_id, index) => {
        const file = index ? `index-${index}.js` : 'index.js';
        fs.writeFileSync(path.join(root, file), 'module.exports = 1;\n');
        return { task_id, title: 'Return two', goal: 'Return two', owner: 'agy', risk: 'low',
            execution_mode: 'isolated', allowed_files: [file], context_files: ['spec.md'], deny_patterns: [],
            validation_commands: [{ program: 'node', args: ['--check', file], cwd: '.' }] };
    });
    fs.writeFileSync(path.join(root, 'spec.md'), 'Return two.\n');
    const dir = path.join(root, '.omni/runs/dual-authority');
    const store = createAuthorityStore(dir);
    const snapshot = createConfiguredSnapshotBaseline({ root }).baseline.capture();
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'workspace-test', session_id: sessionId, plan_revision: planRevision, expected_baseline: snapshot.identity, mode: 'auto' });
    writeInitialSnapshot({ authorityDir: dir, sessionId, workspaceId: 'workspace-test', workspaceRoot: root,
        identity: snapshot.identity, manifest: snapshot.manifest });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: { agy_version: '1.1.27-test', agy_model: 'gemini-3.8-flash-high' } });
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'spec.md', plan_sha256: 'b'.repeat(64), total_tasks: tasks.length, tasks });
    for (const task of tasks) store.append({ schema_version: 2, type: 'task.routed', task_id: task.task_id, owner: 'agy', authority_state: 'ROUTED',
        allowed_files: task.allowed_files, model: 'gemini-3.8-flash-high', effort: 'high', reason: 'Private task' });
    const inputs = [];
    const processRunner = async (invocation) => {
        const runs = path.join(invocation.cwd, '.omni/codex-gemini/runs');
        const spec = JSON.parse(fs.readFileSync(path.join(runs, fs.readdirSync(runs)[0], 'spec.json'), 'utf8'));
        const file = spec.allowed_files[0];
        const common = { schema_version: 1, task_id: spec.task_id, expected_baseline: spec.expected_baseline };
        const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
        inputs.push(prompt);
        let payload;
        if (prompt.includes('scout phase')) payload = { ...common, summary: 'Read index and spec',
            relevant_files: [{ path: file, description: 'return value' }], exact_symbols: [],
            validation_commands: [`node --check ${file}`], constraints: ['scope only'], risks: [], open_questions: questions,
            research_trace: [file, 'spec.md'].map((source) => ({ question: 'What to change?', source,
                source_type: 'REPOSITORY', conclusion: 'Return two' })),
            alternatives_considered: [{ option: 'Edit existing', tradeoff: 'small' }, { option: 'New file', tradeoff: 'unnecessary' }],
            failure_modes: ['wrong return value'] };
        else if (prompt.includes('implement phase')) {
            fs.writeFileSync(path.join(invocation.cwd, file), 'module.exports = 2;\n');
            payload = { ...common, status: 'SUCCESS', modified_files: [file],
                command_outputs: [{ command: `node --check ${file}`, exit_code: 0, output: '' }], unverified_items: [],
                self_review: { checks: ['scope', 'syntax', 'value'], remaining_risks: [] } };
        } else payload = { ...common, recommendation: 'APPROVE', risk_level: 'LOW', findings: [],
            review_checks: ['scope', 'syntax', 'value'], challenge_summary: 'Compared original and changed return.' };
        return { exitCode: 0, stdout: JSON.stringify({ status: 'success', structured_output: payload }), stderr: '',
            timedOut: false, startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
    };
    if (beforeRun) beforeRun(store);
    const adapter = createOrchestratorAdapter(withDiscussion({ workspaceRoot: root, authorityStore: store, processRunner }));
    let results = await adapter.runTask(store.derive());
    if (questions.length) {
        const { postTaskMessage } = require('../lib/dual/task-messages');
        for (const taskId of taskIds) for (const question of store.derive().tasks[taskId].messages.filter(m => m.kind === 'question')) {
            postTaskMessage({ authorityStore: store, sessionId, planRevision, taskId, kind: 'reply',
                messageId: `reply-${taskId}-${question.message_id.slice(-12)}`, replyTo: question.message_id, body: contextAnswer });
        }
        results = await adapter.runTask(store.derive());
    }
    assert.equal(results.length, taskIds.length);
    assert.ok(results.every(result => result.status === 'AWAITING_CODEX_QC'));
    const task = store.derive().tasks[taskIds[0]];
    const { workerRoot } = readTaskBinding(root, task.isolatedWorkspace.reference);
    const spec = JSON.parse(fs.readFileSync(path.join(workerRoot, '.omni/codex-gemini/runs', taskIds[0], 'spec.json'), 'utf8'));
    return { root, store, task, spec, inputs, adapter };
}

// A claude -p result carrying a reviewer verdict for the fixture task.
function claudeVerdict(spec, recommendation, findings = []) {
    const verdict = { schema_version: 1, task_id: spec.task_id, expected_baseline: spec.expected_baseline, recommendation,
        risk_level: recommendation === 'APPROVE' ? 'LOW' : 'MEDIUM', findings,
        review_checks: ['spec vs diff', 'evidence', 'regression'], challenge_summary: 'Checked the return value against the spec.' };
    return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'review-session',
        result: '', structured_output: verdict, permission_denials: [], usage: { input_tokens: 1, output_tokens: 1 } });
}

test('reviewer config: only a squad pipeline with qc on a bound reviewer turns it on', (t) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-reviewer-config-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.equal(reviewerConfig(root), null);
    const squad = path.join(root, '.omni', 'squad');
    fs.mkdirSync(path.join(squad, 'roles'), { recursive: true });
    for (const name of fs.readdirSync(path.join(TEMPLATES, 'roles'))) fs.copyFileSync(path.join(TEMPLATES, 'roles', name), path.join(squad, 'roles', name));
    fs.copyFileSync(path.join(TEMPLATES, 'pipelines', 'dual.yaml'), path.join(squad, 'pipeline.yaml'));
    const roles = { orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol' }, worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }] };
    writeBinding(root, { schema_version: 1, preset: 'dual', updated_at: '2026-11-01T00:00:00Z', roles: { ...roles, reviewer: null } });
    assert.equal(reviewerConfig(root), null, 'preset dual keeps QC with the orchestrator');
    fs.copyFileSync(path.join(TEMPLATES, 'pipelines', 'squad.yaml'), path.join(squad, 'pipeline.yaml'));
    writeBinding(root, { schema_version: 1, preset: 'squad', updated_at: '2026-11-01T00:00:00Z',
        roles: { ...roles, reviewer: { runtime: 'claude', model: 'opus', effort: 'high' } } });
    assert.deepEqual(reviewerConfig(root), { runtime: 'claude', model: 'opus', effort: 'high', maxCorrections: 3 });
});

test('APPROVE: review root holds spec, diff, evidence and scope files only; argv is read-only and isolated', async (t) => {
    const f = await handoff(t);
    assert.equal(needsReview(f.task), true);
    const spawnImpl = fakeSpawn(() => ({ stdout: claudeVerdict(f.spec, 'APPROVE') }));
    const result = await runReviewerQc({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1', config: CONFIG, spawnImpl });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.verdict.recommendation, 'APPROVE');
    const [call] = spawnImpl.calls;
    const reviewRoot = call.options.cwd;
    assert.equal(path.basename(reviewRoot), 'review');
    const files = fs.readdirSync(reviewRoot).filter((name) => !name.startsWith('.')).sort();
    assert.deepEqual(files, ['diff.patch', 'evidence.json', 'index.js', 'spec.json', 'spec.md']);
    assert.equal(fs.readFileSync(path.join(reviewRoot, 'index.js'), 'utf8'), 'module.exports = 2;\n', 'the post-change file');
    assert.ok(fs.existsSync(path.join(reviewRoot, '.git')), 'its own git root');
    assert.equal(call.args[call.args.indexOf('--tools') + 1], 'Read,Grep,Glob,Skill');
    assert.equal(JSON.parse(call.args[call.args.indexOf('--settings') + 1]).disableAllHooks, true);
    assert.match(call.args[1], /Do not run shell commands/);
    const task = f.store.derive().tasks['TASK-1'];
    assert.equal(reviewApproved(task), true);
    assert.equal(needsReview(task), false);
    assert.deepEqual(f.store.readEvents().filter((e) => e.type.startsWith('qc.review.')).map((e) => [e.type, e.runtime || e.verdict]),
        [['qc.review.started', 'claude'], ['qc.review.completed', 'APPROVE']]);
    const verdictFile = path.join(path.dirname(reviewRoot), 'qc-verdict.json');
    assert.deepEqual(JSON.parse(fs.readFileSync(verdictFile, 'utf8')).reviewer, { runtime: 'claude', model: 'sonnet' });
    assert.equal(ReviewSchema.safeParse(JSON.parse(fs.readFileSync(verdictFile, 'utf8'))).success, false, 'the stored verdict carries reviewer metadata');
});

test('codex reviewer may read local files through shell while sandbox and no-execution rules remain', async (t) => {
    const f = await handoff(t);
    const payload = JSON.parse(claudeVerdict(f.spec, 'APPROVE')).structured_output;
    const stdout = [{ type: 'thread.started', thread_id: 'review-session' },
        { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(payload) } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }].map(JSON.stringify).join('\n');
    const spawnImpl = fakeSpawn(() => ({ stdout }));
    const result = await runReviewerQc({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1',
        config: { ...CONFIG, runtime: 'codex', model: 'gpt-6-luna' }, spawnImpl });
    assert.equal(result.status, 'COMPLETED');
    const [call] = spawnImpl.calls;
    assert.equal(call.args[call.args.indexOf('-s') + 1], 'read-only');
    assert.ok(call.args.includes('project_root_markers=[]'));
    assert.ok(!call.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    const prompt = call.args.at(-1);
    assert.match(prompt, /read-only shell commands.*cat.*sed.*rg/i);
    assert.doesNotMatch(prompt, /Do not run shell commands/);
    assert.match(prompt, /Do not modify any file/);
    assert.match(prompt, /Do not run tests, validation commands or scripts/);
    assert.match(prompt, /only.*local file/i);
});

test('reviewer receives current authority clarifications, not worker context or previous attempts', async (t) => {
    const answer = 'Decision: finance fields are id,title,amount. Source: approved-format.md §1. Scope unchanged.';
    const f = await handoff(t, { questions: ['Which approved export format?'], contextAnswer: answer });
    const { workerRoot } = readTaskBinding(f.root, f.task.isolatedWorkspace.reference);
    fs.writeFileSync(path.join(workerRoot, '.omni/codex-gemini/runs/TASK-1/controller-context.json'), 'FORGED WORKER CONTEXT');
    const spawnImpl = fakeSpawn(() => ({ stdout: claudeVerdict(f.spec, 'APPROVE') }));
    const authorityStore = { ...f.store, derive() {
        const snapshot = f.store.derive();
        snapshot.tasks['TASK-1'].previousAttempts = [{ messages: [{ kind: 'reply', body: 'STALE PREVIOUS ANSWER' }] }];
        return snapshot;
    } };
    await runReviewerQc({ workspaceRoot: f.root, authorityStore, taskId: 'TASK-1', config: CONFIG, spawnImpl });
    const call = spawnImpl.calls[0], root = call.options.cwd;
    const text = fs.readFileSync(path.join(root, '.qc-controller-context.json'), 'utf8');
    const context = JSON.parse(text), messages = f.store.derive().tasks['TASK-1'].messages;
    assert.equal(context.session_id, 'session-1'); assert.equal(context.plan_revision, 1);
    assert.equal(context.task_id, 'TASK-1'); assert.equal(context.attempt, 1);
    assert.deepEqual(context.replies, [{ question_id: messages[0].message_id, question: messages[0].body,
        reply_id: messages[1].message_id, answer }]);
    assert.ok(!text.includes('FORGED'));
    assert.ok(!text.includes('STALE PREVIOUS ANSWER'));
    assert.match(call.args[1], /\.qc-controller-context\.json/);
    assert.match(call.args[1], /does not expand.*scope/i);
    assert.equal(fs.existsSync(path.join(root, 'context.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'review.json')), false);
});

test('review input hash binds exact current authority clarification data', async (t) => {
    const f = await handoff(t, { questions: ['Which approved value?'] });
    const runtime = require('../lib/squad/runtimes').defaultRegistry.get('claude');
    const snapshot = f.store.derive();
    const before = prepareReviewRoot({ workspaceRoot: f.root, task: f.task, runtime, authoritySnapshot: snapshot });
    const changed = structuredClone(snapshot);
    changed.tasks['TASK-1'].messages.find(m => m.kind === 'reply').body += ' Additional approved clarification.';
    const after = prepareReviewRoot({ workspaceRoot: f.root, task: f.task, runtime, authoritySnapshot: changed });
    assert.notEqual(before.inputSha256, after.inputSha256);
    const staleOnly = structuredClone(snapshot);
    staleOnly.tasks['TASK-1'].previousAttempts = [{ messages: [{ body: 'Old answer changes' }] }];
    const same = prepareReviewRoot({ workspaceRoot: f.root, task: f.task, runtime, authoritySnapshot: staleOnly });
    assert.equal(before.inputSha256, same.inputSha256);
});

test('review clarification rejects stale, unpaired or oversized authority data without truncation', async (t) => {
    const f = await handoff(t, { questions: ['Which approved value?'] });
    const runtime = require('../lib/squad/runtimes').defaultRegistry.get('claude');
    for (const mode of ['stale', 'unpaired', 'oversized', 'session', 'revision']) {
        const snapshot = f.store.derive();
        const reply = snapshot.tasks['TASK-1'].messages.find(m => m.kind === 'reply');
        if (mode === 'stale') reply.plan_revision++;
        else if (mode === 'unpaired') reply.reply_to = 'not-a-current-question';
        else if (mode === 'oversized') reply.body = 'x'.repeat(2 * 1024 * 1024);
        else if (mode === 'session') snapshot.sessionId = 'other-session';
        else {
            snapshot.planRevision++;
            for (const message of snapshot.tasks['TASK-1'].messages) message.plan_revision++;
        }
        assert.throws(() => prepareReviewRoot({ workspaceRoot: f.root, task: f.task, runtime, authoritySnapshot: snapshot }),
            { code: 'DUAL_REVIEW_INPUT_INVALID' });
    }
});

test('a changed authority clarification cannot publish a successful reviewer verdict', async (t) => {
    const f = await handoff(t, { questions: ['Which approved value?'] });
    let changed = false;
    const authorityStore = { ...f.store, derive() {
        const snapshot = f.store.derive();
        if (changed) snapshot.tasks['TASK-1'].messages.find(m => m.kind === 'reply').body += ' New authority answer.';
        return snapshot;
    } };
    const spawnImpl = fakeSpawn(() => { changed = true; return { stdout: claudeVerdict(f.spec, 'APPROVE') }; });
    const result = await runReviewerQc({ workspaceRoot: f.root, authorityStore, taskId: 'TASK-1', config: CONFIG, spawnImpl });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.code, 'DUAL_REVIEW_INPUT_INVALID');
    assert.equal(f.store.readEvents().some(event => event.type === 'qc.review.completed'), false);
});

test('NEEDS_FIX: findings reach the handoff rejection verbatim and a correction opens', async (t) => {
    const f = await handoff(t);
    const findings = [{ file: 'index.js', line: 1, description: 'Returns 2 but the spec asks for the string "two".', severity: 'ERROR' },
        { file: 'test/x.test.js', description: 'No test covers the new value.', severity: 'WARNING' },
        { file: 'index.js', description: 'Style nit.', severity: 'INFO' }];
    const spawnImpl = fakeSpawn(() => ({ stdout: claudeVerdict(f.spec, 'NEEDS_FIX', findings) }));
    const result = await runReviewerQc({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1', config: CONFIG, spawnImpl });
    const settled = settleReviewVerdict({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1',
        verdict: result.verdict, attempt: result.attempt, config: CONFIG });
    assert.deepEqual(settled, { status: 'CORRECTING', attempt: 2 });
    const task = f.store.derive().tasks['TASK-1'];
    // The correction archives attempt 1 together with its rejection.
    assert.deepEqual(task.previousAttempts.at(-1).handoffRejection.findings, [
        { id: 'qc-1-1', file: 'index.js', line: 1, requirement_id: 'qc-review', description: '[ERROR] Returns 2 but the spec asks for the string "two".' },
        { id: 'qc-1-2', file: 'index.js', line: 1, requirement_id: 'qc-review', description: '[WARNING] (test/x.test.js) No test covers the new value.' },
    ]);
    assert.equal(task.correction.attempt, 2);
    assert.equal(reviewApproved(task), false);
});

test('multiple tasks and attempts open distinct bounded corrections', async (t) => {
    const taskIds = ['TASK-1', 'T'.repeat(64)];
    const f = await handoff(t, { taskIds });
    for (const attempt of [1, 2]) {
        if (attempt === 2) {
            const results = await f.adapter.runTask(f.store.derive());
            assert.equal(results.length, 2);
            assert.ok(results.every(result => result.status === 'AWAITING_CODEX_QC'));
        }
        for (const taskId of taskIds) {
            const task = f.store.derive().tasks[taskId];
            const { workerRoot } = readTaskBinding(f.root, task.isolatedWorkspace.reference);
            const spec = JSON.parse(fs.readFileSync(path.join(workerRoot, '.omni/codex-gemini/runs', taskId, 'spec.json')));
            const result = await runReviewerQc({ workspaceRoot: f.root, authorityStore: f.store, taskId, config: CONFIG,
                spawnImpl: fakeSpawn(() => ({ stdout: claudeVerdict(spec, 'NEEDS_FIX',
                    [{ file: spec.allowed_files[0], line: 1, description: 'Must return a string.', severity: 'ERROR' }]) })) });
            assert.deepEqual(settleReviewVerdict({ workspaceRoot: f.root, authorityStore: f.store, taskId,
                verdict: result.verdict, attempt, config: CONFIG }), { status: 'CORRECTING', attempt: attempt + 1 });
        }
    }
    const events = f.store.readEvents().filter(e => ['task.handoff.rejected', 'task.correction.requested'].includes(e.type));
    assert.equal(events.length, 8);
    assert.equal(new Set(events.map(e => e.request_id)).size, 8);
    for (const event of events) assert.equal(require('../lib/dual/contracts').TaskIdSchema.safeParse(event.request_id).success, true);
    for (const taskId of taskIds) assert.equal(f.store.derive().tasks[taskId].correction.attempt, 3);
});

test('review settlement request IDs distinguish session and plan revision', async (t) => {
    const ids = [];
    for (const [sessionId, planRevision] of [['session-1', 1], ['session-2', 1], ['session-1', 2]]) {
        const f = await handoff(t, { sessionId, planRevision });
        const result = await runReviewerQc({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1', config: CONFIG,
            spawnImpl: fakeSpawn(() => ({ stdout: claudeVerdict(f.spec, 'NEEDS_FIX',
                [{ file: 'index.js', description: 'Wrong return value.', severity: 'ERROR' }]) })) });
        assert.equal(settleReviewVerdict({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1',
            verdict: result.verdict, attempt: 1, config: CONFIG }).status, 'CORRECTING');
        ids.push(...f.store.readEvents().filter(e => ['task.handoff.rejected', 'task.correction.requested'].includes(e.type)).map(e => e.request_id));
    }
    assert.equal(ids.length, 6);
    assert.equal(new Set(ids).size, 6);
});

test('replaying the same rejected verdict is idempotent and changed findings conflict', async (t) => {
    const f = await handoff(t);
    const result = await runReviewerQc({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1', config: CONFIG,
        spawnImpl: fakeSpawn(() => ({ stdout: claudeVerdict(f.spec, 'REJECT',
            [{ file: 'index.js', description: 'Wrong approach.', severity: 'ERROR' }]) })) });
    const opts = { workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1', verdict: result.verdict, attempt: 1, config: CONFIG };
    assert.equal(settleReviewVerdict(opts).status, 'NEEDS_DECISION');
    const count = f.store.readEvents().length;
    assert.equal(settleReviewVerdict(opts).status, 'NEEDS_DECISION');
    assert.equal(f.store.readEvents().length, count);
    assert.throws(() => settleReviewVerdict({ ...opts, verdict: { ...result.verdict,
        findings: [{ file: 'index.js', description: 'Changed finding.', severity: 'ERROR' }] } }),
        { code: 'DUAL_HANDOFF_REJECTION_CONFLICT' });
    assert.equal(f.store.readEvents().length, count);
});

test('REJECT and an exhausted budget stop for the orchestrator without a correction', async (t) => {
    const rejected = await handoff(t);
    const spawnImpl = fakeSpawn(() => ({ stdout: claudeVerdict(rejected.spec, 'REJECT', [{ file: 'index.js', description: 'Wrong approach.', severity: 'ERROR' }]) }));
    const result = await runReviewerQc({ workspaceRoot: rejected.root, authorityStore: rejected.store, taskId: 'TASK-1', config: CONFIG, spawnImpl });
    const settled = settleReviewVerdict({ workspaceRoot: rejected.root, authorityStore: rejected.store, taskId: 'TASK-1',
        verdict: result.verdict, attempt: result.attempt, config: CONFIG });
    assert.equal(settled.status, 'NEEDS_DECISION');
    assert.equal(rejected.store.derive().tasks['TASK-1'].correction, undefined);

    const capped = await handoff(t);
    const spawnCapped = fakeSpawn(() => ({ stdout: claudeVerdict(capped.spec, 'NEEDS_FIX', [{ file: 'index.js', description: 'Off by one.', severity: 'ERROR' }]) }));
    const second = await runReviewerQc({ workspaceRoot: capped.root, authorityStore: capped.store, taskId: 'TASK-1', config: CONFIG, spawnImpl: spawnCapped });
    const noBudget = settleReviewVerdict({ workspaceRoot: capped.root, authorityStore: capped.store, taskId: 'TASK-1',
        verdict: second.verdict, attempt: second.attempt, config: { ...CONFIG, maxCorrections: 0 } });
    assert.deepEqual(noBudget, { status: 'NEEDS_DECISION', reason: 'correction limit reached' });
    assert.ok(capped.store.derive().tasks['TASK-1'].handoffRejection, 'the handoff is still rejected for the orchestrator to decide');
});

test('a broken reviewer reply records qc.review.failed and leaves the attempt reviewable', async (t) => {
    const f = await handoff(t);
    const result = await runReviewerQc({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1', config: CONFIG,
        spawnImpl: fakeSpawn(() => ({ stdout: 'not json' })) });
    assert.deepEqual([result.status, result.code], ['FAILED', 'DUAL_AGY_OUTPUT_MALFORMED']);
    const task = f.store.derive().tasks['TASK-1'];
    assert.equal(task.qcReview.status, 'failed');
    assert.equal(needsReview(task), true, 'a technical failure is retried later, not counted as a correction');
    const retry = await runReviewerQc({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1', config: CONFIG,
        spawnImpl: fakeSpawn(() => ({ stdout: claudeVerdict(f.spec, 'APPROVE') })) });
    assert.equal(retry.status, 'COMPLETED');
    assert.equal(reviewApproved(f.store.derive().tasks['TASK-1']), true);
});

test('rejection findings: in-scope files keep their line; out-of-scope paths move into the text', () => {
    const verdict = { findings: [], challenge_summary: 'Nothing concrete, but the approach is wrong.' };
    assert.deepEqual(rejectionFindings(verdict, 2, ['a.js']), [{ id: 'qc-2-1', file: 'a.js', line: 1, requirement_id: 'qc-review',
        description: 'Nothing concrete, but the approach is wrong.' }]);
});

// Daemon wiring (SPEC-SQUAD-P5 §2.1): task.qc waits for the reviewer, the daemon
// pushes the review, APPROVE lets command QC integrate, NEEDS_FIX re-dispatches.
async function daemonFor(t, f, recommendation, { review } = {}) {
    const http = require('node:http');
    const { EventEmitter } = require('node:events');
    const { startDaemonServer } = require('../lib/dual/daemon-server');
    const squad = path.join(f.root, '.omni', 'squad');
    fs.mkdirSync(path.join(squad, 'roles'), { recursive: true });
    for (const name of fs.readdirSync(path.join(TEMPLATES, 'roles'))) fs.copyFileSync(path.join(TEMPLATES, 'roles', name), path.join(squad, 'roles', name));
    fs.copyFileSync(path.join(TEMPLATES, 'pipelines', 'squad.yaml'), path.join(squad, 'pipeline.yaml'));
    writeBinding(f.root, { schema_version: 1, preset: 'squad', updated_at: '2026-11-01T00:00:00Z', roles: {
        orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol' }, worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }],
        reviewer: { runtime: 'claude', model: 'sonnet' } } });
    let handler;
    t.mock.method(http, 'createServer', (callback) => {
        handler = callback;
        const server = new EventEmitter();
        server.listen = (_port, _host, ready) => ready();
        server.address = () => ({ port: 43212 });
        server.close = (done) => done();
        return server;
    });
    const reviews = [];
    const dispatched = [];
    const daemon = await startDaemonServer({ workspaceRoot: f.root, authorityStore: f.store,
        orchestrator: { runTask: async (_derived, options) => { dispatched.push(options); return []; } },
        runReviewerQc: review || (async (args) => {
            reviews.push(args.config);
            return runReviewerQc({ ...args, spawnImpl: fakeSpawn(() => ({ stdout: claudeVerdict(f.spec, recommendation,
                recommendation === 'APPROVE' ? [] : [{ file: 'index.js', line: 1, description: 'Must return the string "two".', severity: 'ERROR' }]) })) });
        }) });
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
    const settle = async () => {
        for (let i = 0; i < 200 && (f.store.derive().tasks['TASK-1'].qcReview?.status !== 'completed' || dispatched.length === 0 && recommendation !== 'APPROVE'); i++) {
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    };
    return { rpc, reviews, dispatched, settle, daemon };
}

test('daemon shutdown holds ownership until reviewer drain and ignores a late correction verdict', async (t) => {
    const f = await handoff(t);
    let release, started, signal;
    const ready = new Promise(resolve => { started = resolve; });
    const pending = new Promise(resolve => { release = () => resolve({ status: 'COMPLETED', attempt: 1,
        verdict: JSON.parse(claudeVerdict(f.spec, 'NEEDS_FIX', [
            { file: 'index.js', line: 1, description: 'Change requested after shutdown', severity: 'ERROR' },
        ])).structured_output }); });
    const d = await daemonFor(t, f, 'NEEDS_FIX', { review: async args => {
        signal = args.signal;
        started();
        return pending;
    } });
    let closing;
    try {
        const result = await d.rpc('task.qc', { session_id: 'session-1', task_id: 'TASK-1', plan_revision: 1 });
        assert.equal(result.status, 'AWAITING_REVIEW');
        await ready;
        let closed = false;
        closing = d.daemon.close().then(() => { closed = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(signal?.aborted, true);
        assert.equal(closed, false, 'a noncooperative reviewer is still owned until it returns');
        assert.equal(fs.existsSync(path.join(getRuntimeDir(f.root), 'daemon.lock')), true);
        release();
        await closing;
        assert.equal(fs.existsSync(path.join(getRuntimeDir(f.root), 'daemon.lock')), false);
        assert.equal(f.store.readEvents().some(event => event.type === 'task.correction.requested'), false);
        assert.equal(d.dispatched.length, 0);
    } finally {
        release();
        if (closing) await closing;
    }
});

test('reviewer cancellation drains close and cannot publish a buffered successful verdict', async (t) => {
    const { EventEmitter } = require('node:events');
    const f = await handoff(t), controller = new AbortController();
    let childClosed = false;
    const spawnImpl = (_command, _args, options) => {
        assert.equal(options.signal, controller.signal);
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
        setImmediate(() => {
            child.stdout.emit('data', Buffer.from(claudeVerdict(f.spec, 'APPROVE')));
            controller.abort(Object.assign(new Error('Daemon is shutting down'), { code: 'DUAL_DAEMON_STOPPED' }));
            childClosed = true;
            child.emit('close', 0, null);
        });
        return child;
    };
    const result = await runReviewerQc({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1',
        config: CONFIG, spawnImpl, signal: controller.signal });
    assert.equal(childClosed, true);
    assert.equal(result.status, 'FAILED');
    assert.equal(result.code, 'DUAL_DAEMON_STOPPED');
    assert.equal(f.store.readEvents().some(event => event.type === 'qc.review.completed'), false);
    assert.equal(f.store.derive().tasks['TASK-1'].qcReview.status, 'failed');
});

test('daemon: task.qc waits for the pushed review, then APPROVE runs command QC to TASK_VERIFIED', async (t) => {
    const f = await handoff(t);
    const d = await daemonFor(t, f, 'APPROVE');
    const qc = { session_id: 'session-1', task_id: 'TASK-1', plan_revision: 1 };
    const waiting = await d.rpc('task.qc', qc);
    assert.equal(waiting.status, 'AWAITING_REVIEW');
    await d.settle();
    assert.deepEqual(d.reviews, [{ runtime: 'claude', model: 'sonnet', maxCorrections: 3 }]);
    assert.equal(reviewApproved(f.store.derive().tasks['TASK-1']), true);
    const verified = await d.rpc('task.qc', qc);
    assert.equal(verified.status, 'TASK_VERIFIED');
    assert.equal(fs.readFileSync(path.join(f.root, 'index.js'), 'utf8'), 'module.exports = 2;\n');
});

test('daemon: NEEDS_FIX rejects the handoff and re-dispatches the worker for attempt 2', async (t) => {
    const f = await handoff(t);
    const d = await daemonFor(t, f, 'NEEDS_FIX');
    const qc = { session_id: 'session-1', task_id: 'TASK-1', plan_revision: 1 };
    assert.equal((await d.rpc('task.qc', qc)).status, 'AWAITING_REVIEW');
    await d.settle();
    const task = f.store.derive().tasks['TASK-1'];
    assert.equal(task.correction.attempt, 2);
    const { signal, ...dispatchOptions } = d.dispatched.at(-1);
    assert.deepEqual(dispatchOptions, { resume: true });
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
    assert.equal(fs.readFileSync(path.join(f.root, 'index.js'), 'utf8'), 'module.exports = 1;\n', 'nothing integrated');
});

test('real reviewer verdicts from codex, agy and claude parse against ReviewSchema (V33)', () => {
    const { extractWorkerPayload } = require('../lib/dual/worker-runtime');
    for (const runtime of ['codex', 'agy', 'claude']) {
        const stdout = fs.readFileSync(path.join(__dirname, 'fixtures', 'squad-cli', `${runtime}-reviewer-verdict.txt`), 'utf8');
        const { payload } = extractWorkerPayload(runtime, { exitCode: 0, stdout }, ReviewSchema);
        assert.equal(payload.recommendation, 'NEEDS_FIX', `${runtime} caught the planted null bug`);
        assert.ok(payload.findings.some((finding) => /null/i.test(finding.description)), runtime);
    }
});

// P5d (SPEC-SQUAD-P5 §5): role budgets from .omni/squad/roles/<id>.yaml.
function writeRoleBudgets(root, budgets) {
    const dir = path.join(root, '.omni', 'squad', 'roles');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of fs.readdirSync(path.join(TEMPLATES, 'roles'))) {
        const id = name.replace(/\.yaml$/, '');
        const text = fs.readFileSync(path.join(TEMPLATES, 'roles', name), 'utf8');
        const budget = budgets[id] ? `budget: { ${Object.entries(budgets[id]).map(([k, v]) => `${k}: ${v}`).join(', ')} }\n` : '';
        fs.writeFileSync(path.join(dir, name), text + budget);
    }
}

test('budget: role YAML budget parses, rejects junk, and reaches roleBudget', (t) => {
    const { roleBudget } = require('../lib/dual/role-budget');
    const { parseRole } = require('../lib/squad/roles');
    const base = { schema_version: 1, id: 'reviewer', description: 'x', cardinality: '0..1', phases: [], permission: 'read-only',
        requires: ['headless'], root: 'isolated' };
    assert.equal(parseRole({ ...base, budget: { turn_minutes: 10, max_turns: 2 } }, 'r.yaml').budget.max_turns, 2);
    assert.throws(() => parseRole({ ...base, budget: { turn_minutes: 0 } }, 'r.yaml'));
    assert.throws(() => parseRole({ ...base, budget: { tokens: 5 } }, 'r.yaml'));
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-budget-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.deepEqual(roleBudget(root, 'worker'), {});
    writeRoleBudgets(root, { worker: { turn_minutes: 12, max_turns: 2 }, reviewer: { max_turns: 1 } });
    assert.deepEqual(roleBudget(root, 'worker'), { turnMs: 720_000, maxTurns: 2 });
    assert.deepEqual(roleBudget(root, 'reviewer'), { maxTurns: 1 });
});

test('budget: reviewer max_turns stops reviews (failed runs count); usage is recorded', async (t) => {
    const f = await handoff(t);
    const config = { ...CONFIG, maxTurns: 1 };
    const broken = await runReviewerQc({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1', config,
        spawnImpl: fakeSpawn(() => ({ stdout: 'not json' })) });
    assert.equal(broken.status, 'FAILED');
    const task = f.store.derive().tasks['TASK-1'];
    assert.equal(task.qcReviewRuns, 1);
    const { reviewBudgetExhausted } = require('../lib/dual/reviewer-qc');
    assert.equal(reviewBudgetExhausted(task, config), true);
    const again = await runReviewerQc({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1', config,
        spawnImpl: fakeSpawn(() => assert.fail('no review past the budget')) });
    assert.equal(again.status, 'BUDGET_EXHAUSTED');

    const g = await handoff(t);
    await runReviewerQc({ workspaceRoot: g.root, authorityStore: g.store, taskId: 'TASK-1', config: CONFIG,
        spawnImpl: fakeSpawn(() => ({ stdout: claudeVerdict(g.spec, 'APPROVE') })) });
    assert.deepEqual(g.store.derive().tasks['TASK-1'].qcReview.usage, { input_tokens: 1, output_tokens: 1, thinking_tokens: null });
});

test('budget: worker max_turns caps attempts, so a reviewer NEEDS_FIX stops for a decision', async (t) => {
    const f = await handoff(t);
    writeRoleBudgets(f.root, { worker: { max_turns: 1 } });
    const result = await runReviewerQc({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1', config: CONFIG,
        spawnImpl: fakeSpawn(() => ({ stdout: claudeVerdict(f.spec, 'NEEDS_FIX', [{ file: 'index.js', description: 'Wrong value.', severity: 'ERROR' }]) })) });
    const settled = settleReviewVerdict({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1',
        verdict: result.verdict, attempt: result.attempt, config: CONFIG });
    assert.deepEqual(settled, { status: 'NEEDS_DECISION', reason: 'DUAL_CORRECTION_LIMIT' });
    assert.equal(f.store.derive().tasks['TASK-1'].correction, undefined);
});

// SPEC-SQUAD-P6 §4.3: a user message reaches the role's next turn once, as data.
test('user notes: worker-1 reads its message in the next phase only; the reviewer gets its own as a file', async (t) => {
    const { postMessage } = require('../lib/dual/inbox');
    const ids = { worker: crypto.randomUUID(), other: crypto.randomUUID(), reviewer: crypto.randomUUID() };
    const f = await handoff(t, { beforeRun(store) {
        postMessage(store, { messageId: ids.worker, to: 'worker-1', body: 'Keep the module.exports style.' });
        postMessage(store, { messageId: ids.other, to: 'worker-2', body: 'Not for worker-1.' });
        postMessage(store, { messageId: ids.reviewer, to: 'reviewer', body: 'Check the value really is 2.' });
    } });
    assert.equal(f.inputs.length, 3, 'scout, implement, review');
    assert.match(f.inputs[0], /Notes from the user[\s\S]*do not grant any permission[\s\S]*Keep the module\.exports style\./);
    assert.doesNotMatch(f.inputs[0], /Not for worker-1|Check the value/);
    assert.doesNotMatch(f.inputs[1] + f.inputs[2], /Notes from the user/, 'taken once');
    const messages = f.store.derive().messages;
    assert.deepEqual(messages[ids.worker].delivered['worker-1'], { via: 'worker-turn', at: messages[ids.worker].delivered['worker-1'].at,
        task_id: 'TASK-1', attempt: 1, phase: 'scout' });
    assert.deepEqual(messages[ids.other].delivered, {});
    const spawnImpl = fakeSpawn(() => ({ stdout: claudeVerdict(f.spec, 'APPROVE') }));
    await runReviewerQc({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1', config: CONFIG, spawnImpl });
    const [call] = spawnImpl.calls;
    assert.match(fs.readFileSync(path.join(call.options.cwd, 'user-notes.md'), 'utf8'), /Check the value really is 2\./);
    assert.match(call.args[1], /Also read user-notes\.md/);
    assert.equal(f.store.derive().messages[ids.reviewer].delivered.reviewer.via, 'reviewer-turn');
    assert.equal(call.args.join(' ').includes('Check the value'), false, 'the note is a file, not argv');
});

for (const recommendation of ['NEEDS_FIX', 'INVALID']) {
    test(`acceptance capture records reviewer ${recommendation} actual contract without a technical retry`, async t => {
        const f = await handoff(t);
        const capture = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-review-capture-'));
        t.after(() => fs.rmSync(capture, { recursive: true, force: true }));
        const env = { ...process.env, OMNI_SQUAD_ACCEPTANCE_EVIDENCE: capture };
        const output = recommendation === 'INVALID' ? '{"type":"result","subtype":"success","result":"{}"}'
            : claudeVerdict(f.spec, 'NEEDS_FIX', [{ file: 'index.js', line: 1, description: 'Wrong result', severity: 'ERROR' }]);
        const spawnImpl = fakeSpawn(() => ({ stdout: output, stderr: 'review stderr' }));
        const result = await runReviewerQc({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1', config: CONFIG, env, spawnImpl });
        assert.equal(result.status, recommendation === 'INVALID' ? 'FAILED' : 'COMPLETED');
        const records = fs.readdirSync(path.join(capture, 'turns')).map(name => JSON.parse(fs.readFileSync(path.join(capture, 'turns', name))));
        assert.equal(records.length, 1);
        assert.equal(records[0].contract.status, recommendation === 'INVALID' ? 'failed' : 'succeeded');
        assert.equal(records[0].role, 'reviewer'); assert.equal(records[0].attempt, 1);
        assert.equal(records[0].stderrTail, 'review stderr'); assert.equal(records[0].retry.applied, false);
        assert.equal(spawnImpl.calls[0].options.env.OMNI_SQUAD_ACCEPTANCE_EVIDENCE, undefined);
    });
}

test('a NEEDS_FIX verdict with only INFO findings fails the review instead of rejecting the worker (P7f C rerun)', async (t) => {
    const f = await handoff(t);
    const spawnImpl = fakeSpawn(() => ({ stdout: claudeVerdict(f.spec, 'NEEDS_FIX',
        [{ file: 'index.js', line: 23, description: 'No defect? All fine.', severity: 'INFO' }]) }));
    const result = await runReviewerQc({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1', config: CONFIG, spawnImpl });
    assert.deepEqual(result, { status: 'FAILED', attempt: 1, code: 'DUAL_REVIEW_VERDICT_INCONSISTENT' });
    const task = f.store.derive().tasks['TASK-1'];
    assert.equal(task.handoffRejection, undefined, 'the worker handoff is not rejected');
    assert.equal(f.store.readEvents().some((event) => event.type === 'task.correction.requested'), false);
    const none = await runReviewerQc({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'TASK-1', config: CONFIG,
        spawnImpl: fakeSpawn(() => ({ stdout: claudeVerdict(f.spec, 'NEEDS_FIX', []) })) });
    assert.equal(none.code, 'DUAL_REVIEW_VERDICT_INCONSISTENT', 'no findings at all is inconsistent too');
});
