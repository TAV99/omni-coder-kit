'use strict';

// P5a (SPEC-SQUAD-P5 §2): an independent reviewer reviews each released isolated
// attempt before command QC. It sees spec, diff, evidence and scope files only;
// NEEDS_FIX rejects the handoff verbatim and opens a bounded correction.

require('./helpers/auto-approve-gates');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { withDiscussion } = require('./helpers/dual-discussion-stub');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { createOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
const { writeInitialSnapshot } = require('../lib/dual/snapshot-store');
const { readTaskBinding } = require('../lib/dual/task-workspace');
const { ReviewSchema } = require('../lib/dual/contracts');
const {
    reviewerConfig, needsReview, reviewApproved, runReviewerQc, settleReviewVerdict, rejectionFindings,
} = require('../lib/dual/reviewer-qc');
const { writeBinding } = require('../lib/squad/bindings');
const { fakeSpawn } = require('./helpers/squad-fakes');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'squad');
const CONFIG = { runtime: 'claude', model: 'sonnet', effort: 'low', maxCorrections: 3 };

async function handoff(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-reviewer-qc-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Return two.\n');
    const dir = path.join(root, '.omni/runs/dual-authority');
    const store = createAuthorityStore(dir);
    const snapshot = createConfiguredSnapshotBaseline({ root }).baseline.capture();
    const command = { program: 'node', args: ['--check', 'index.js'], cwd: '.' };
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'workspace-test', session_id: 'session-1', plan_revision: 1, expected_baseline: snapshot.identity, mode: 'auto' });
    writeInitialSnapshot({ authorityDir: dir, sessionId: 'session-1', workspaceId: 'workspace-test', workspaceRoot: root,
        identity: snapshot.identity, manifest: snapshot.manifest });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: { agy_version: '1.1.27-test', agy_model: 'gemini-3.8-flash-high' } });
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'spec.md', plan_sha256: 'b'.repeat(64), total_tasks: 1,
        tasks: [{ task_id: 'TASK-1', title: 'Return two', goal: 'Return two', owner: 'agy', risk: 'low',
            execution_mode: 'isolated', allowed_files: ['index.js'], context_files: ['spec.md'], deny_patterns: [],
            validation_commands: [command] }] });
    store.append({ schema_version: 2, type: 'task.routed', task_id: 'TASK-1', owner: 'agy', authority_state: 'ROUTED',
        allowed_files: ['index.js'], model: 'gemini-3.8-flash-high', effort: 'high', reason: 'Private task' });
    const processRunner = async (invocation) => {
        const spec = JSON.parse(fs.readFileSync(path.join(invocation.cwd, '.omni/codex-gemini/runs/TASK-1/spec.json'), 'utf8'));
        const common = { schema_version: 1, task_id: 'TASK-1', expected_baseline: spec.expected_baseline };
        const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
        let payload;
        if (prompt.includes('scout phase')) payload = { ...common, summary: 'Read index and spec',
            relevant_files: [{ path: 'index.js', description: 'return value' }], exact_symbols: [],
            validation_commands: ['node --check index.js'], constraints: ['scope only'], risks: [], open_questions: [],
            research_trace: ['index.js', 'spec.md'].map((source) => ({ question: 'What to change?', source,
                source_type: 'REPOSITORY', conclusion: 'Return two' })),
            alternatives_considered: [{ option: 'Edit existing', tradeoff: 'small' }, { option: 'New file', tradeoff: 'unnecessary' }],
            failure_modes: ['wrong return value'] };
        else if (prompt.includes('implement phase')) {
            fs.writeFileSync(path.join(invocation.cwd, 'index.js'), 'module.exports = 2;\n');
            payload = { ...common, status: 'SUCCESS', modified_files: ['index.js'],
                command_outputs: [{ command: 'node --check index.js', exit_code: 0, output: '' }], unverified_items: [],
                self_review: { checks: ['scope', 'syntax', 'value'], remaining_risks: [] } };
        } else payload = { ...common, recommendation: 'APPROVE', risk_level: 'LOW', findings: [],
            review_checks: ['scope', 'syntax', 'value'], challenge_summary: 'Compared original and changed return.' };
        return { exitCode: 0, stdout: JSON.stringify({ status: 'success', structured_output: payload }), stderr: '',
            timedOut: false, startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
    };
    const adapter = createOrchestratorAdapter(withDiscussion({ workspaceRoot: root, authorityStore: store, processRunner }));
    assert.equal((await adapter.runTask(store.derive()))[0].status, 'AWAITING_CODEX_QC');
    const task = store.derive().tasks['TASK-1'];
    const { workerRoot } = readTaskBinding(root, task.isolatedWorkspace.reference);
    const spec = JSON.parse(fs.readFileSync(path.join(workerRoot, '.omni/codex-gemini/runs/TASK-1/spec.json'), 'utf8'));
    return { root, store, task, spec };
}

// A claude -p result carrying a reviewer verdict for the fixture task.
function claudeVerdict(spec, recommendation, findings = []) {
    const verdict = { schema_version: 1, task_id: 'TASK-1', expected_baseline: spec.expected_baseline, recommendation,
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
async function daemonFor(t, f, recommendation) {
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
        runReviewerQc: async (args) => {
            reviews.push(args.config);
            return runReviewerQc({ ...args, spawnImpl: fakeSpawn(() => ({ stdout: claudeVerdict(f.spec, recommendation,
                recommendation === 'APPROVE' ? [] : [{ file: 'index.js', line: 1, description: 'Must return the string "two".', severity: 'ERROR' }]) })) });
        } });
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
    return { rpc, reviews, dispatched, settle };
}

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
    assert.deepEqual(d.dispatched.at(-1), { resume: true });
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
