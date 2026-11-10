'use strict';

// SPEC-SQUAD-P7 §6.1 (P7e, V37): classify real runtime limit signals and let the
// task wait in WAITING_RUNTIME without using a technical attempt.
//
// The claude fixture is the `claude -p --output-format json` result envelope of
// the usage-limit refusal captured in P7d B-05 (claude 2.1.316, 2026-11-04):
// exit 1, empty stderr, is_error true with subtype "success", HTTP 429,
// api_error "usage_limit_reached", text "You've hit your 5-hour limit · resets
// 3:10am (Asia/Saigon)". The values come from that session's own transcript
// record; the envelope field names are the ones 2.1.316 writes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const claude = require('../lib/squad/runtimes/claude');
const codex = require('../lib/squad/runtimes/codex');
const agy = require('../lib/squad/runtimes/agy');
const { classifyRuntimeFailure, defineRuntime } = require('../lib/squad/runtimes/contract');
const { classifyWorkerFailure } = require('../lib/dual/worker-runtime');
const { runIsolatedTask } = require('../lib/dual/isolated-runner');
const { createDiscussionStub } = require('./helpers/dual-discussion-stub');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'squad-cli', 'claude-usage-limit.json'), 'utf8');
const limited = { exitCode: 1, stdout: fixture, stderr: '', timedOut: false };
const SESSION = '9ae7cc82-ff4e-48e4-89b7-84b9335e85b0';
const reply = (extra) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: SESSION,
    result: '', permission_denials: [], usage: { input_tokens: 1, output_tokens: 1 }, ...extra });

test('claude classifier: the real B-05 usage-limit envelope is rate_limited', () => {
    assert.deepEqual(classifyRuntimeFailure(claude, limited), { kind: 'rate_limited', signal: 'usage_limit_reached' });
    assert.deepEqual(classifyWorkerFailure('claude', limited), { kind: 'rate_limited', signal: 'usage_limit_reached' });
    // The ordinary parser still sees a failed turn, so callers without a wait keep the technical retry.
    assert.equal(claude.parseResult(limited).completion, 'failed');
});

test('claude classifier: 429 + limit text without the typed field; everything else is other', () => {
    const envelope = JSON.parse(fixture);
    delete envelope.api_error;
    assert.equal(classifyRuntimeFailure(claude, { ...limited, stdout: JSON.stringify(envelope) }).kind, 'rate_limited');
    const others = [
        { ...limited, stdout: reply({ is_error: true, result: 'boom' }) },
        { ...limited, stdout: reply({ is_error: true, api_error: 'connection_failed' }) },
        { ...limited, stdout: reply({ is_error: true, api_error_status: 429, result: 'server busy' }) },
        { ...limited, stdout: reply({ is_error: false, api_error: 'usage_limit_reached' }) },
        { ...limited, stdout: 'not json' },
        { ...limited, stdout: '' },
    ];
    for (const raw of others) assert.deepEqual(classifyRuntimeFailure(claude, raw), { kind: 'other' });
    assert.deepEqual(classifyWorkerFailure('claude', { ...limited, timedOut: true }), { kind: 'other' });
});

test('runtimes without an observed signal classify nothing (V37 not observed)', () => {
    assert.equal(codex.classifyFailure, undefined);
    assert.equal(agy.classifyFailure, undefined);
    assert.deepEqual(classifyRuntimeFailure(codex, limited), { kind: 'other' });
    assert.deepEqual(classifyWorkerFailure('agy', limited), { kind: 'other' });
    assert.deepEqual(classifyWorkerFailure('codex', limited), { kind: 'other' });
});

test('classifyRuntimeFailure never throws and rejects unknown kinds', () => {
    const base = { ...claude };
    const throwing = defineRuntime({ ...base, classifyFailure() { throw new Error('bug'); } });
    assert.deepEqual(classifyRuntimeFailure(throwing, limited), { kind: 'other' });
    const odd = defineRuntime({ ...base, classifyFailure: () => ({ kind: 'sleepy' }) });
    assert.deepEqual(classifyRuntimeFailure(odd, limited), { kind: 'other' });
    assert.deepEqual(classifyRuntimeFailure(null, limited), { kind: 'other' });
});

function isolatedFixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-runtime-wait-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Return the number two.\n');
    fs.mkdirSync(path.join(root, '.omni'), { recursive: true });
    fs.writeFileSync(path.join(root, '.omni', 'manifest.json'), JSON.stringify({ workerRuntime: 'claude' }));
    return { workspaceRoot: root, sessionId: 'session-1', attempt: 1, planRevision: 1, workerCommand: '/opt/claude',
        task: { task_id: 'TASK-1', model: 'sonnet', effort: 'high', goal: 'Return two', allowed_files: ['index.js'], context_files: ['spec.md'],
            deny_patterns: [], validation_commands: [{ program: 'node', args: ['--check', 'index.js'], cwd: '.' }] },
        capability: { version: '2.1.316', model: 'sonnet' }, authorize: () => true };
}

function discussion() {
    const common = (workerRoot, taskId) => {
        const spec = JSON.parse(fs.readFileSync(path.join(workerRoot, '.omni/codex-gemini/runs', taskId, 'spec.json'), 'utf8'));
        return { schema_version: 1, task_id: taskId, expected_baseline: spec.expected_baseline };
    };
    return { common, stub: createDiscussionStub({
        async turn({ workerRoot, phase, taskId }) {
            const base = common(workerRoot, taskId);
            if (phase === 'scout') {
                return { ...base, summary: 'Read index and spec', relevant_files: [{ path: 'index.js', description: 'return value' }],
                    exact_symbols: [], validation_commands: ['node --check index.js'], constraints: ['scope only'], risks: [], open_questions: [],
                    research_trace: ['index.js', 'spec.md'].map((source) => ({ question: 'What to change?', source, source_type: 'REPOSITORY', conclusion: 'Return two' })),
                    alternatives_considered: [{ option: 'Edit existing', tradeoff: 'small' }, { option: 'New file', tradeoff: 'unnecessary' }],
                    failure_modes: ['wrong return value'] };
            }
            return { ...base, recommendation: 'APPROVE', risk_level: 'LOW', findings: [], review_checks: ['scope', 'syntax', 'value'],
                challenge_summary: 'Compared original and changed return.' };
        },
    }) };
}

function implementRunner(common, plan) {
    const calls = [];
    const runner = async (invocation) => {
        calls.push(invocation);
        const step = plan[Math.min(calls.length - 1, plan.length - 1)];
        if (step === 'limited') return { ...limited, startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
        const taskId = fs.readdirSync(path.join(invocation.cwd, '.omni/codex-gemini/runs'))[0];
        fs.writeFileSync(path.join(invocation.cwd, 'index.js'), 'module.exports = 2;\n');
        const payload = { ...common(invocation.cwd, taskId), status: 'SUCCESS', modified_files: ['index.js'],
            command_outputs: [{ command: 'node --check index.js', exit_code: 0, output: '' }], unverified_items: [],
            self_review: { checks: ['scope', 'syntax', 'value'], remaining_risks: [] } };
        return { exitCode: 0, stdout: reply({ structured_output: payload }), stderr: '', timedOut: false,
            startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
    };
    return { calls, runner };
}

// The claude implement launcher is bound to the macOS source-write fence.
const darwinOnly = { skip: process.platform !== 'darwin' };

test('isolated claude implement waits out a usage limit, then completes without using attempts', darwinOnly, async (t) => {
    const input = isolatedFixture(t);
    const { common, stub } = discussion();
    // Five refusals exceed the three technical attempts: none of them may count.
    const { calls, runner } = implementRunner(common, ['limited', 'limited', 'limited', 'limited', 'limited', 'ok']);
    const waits = [], resumes = [];
    const handoff = await runIsolatedTask({ ...input, discussion: stub, processRunner: runner,
        runtimeWait: { probeMs: 5, maxWaitMs: 1000, onWait: (info) => waits.push(info), onResume: (info) => resumes.push(info) } });
    assert.equal(handoff.status, 'AWAITING_CODEX_QC');
    assert.equal(calls.length, 6);
    assert.equal(waits.length, 5);
    assert.equal(resumes.length, 5);
    assert.deepEqual([waits[0].runtime, waits[0].kind, waits[0].phase, waits[0].signal],
        ['claude', 'rate_limited', 'implement', 'usage_limit_reached']);
    assert.ok(!Number.isNaN(Date.parse(waits[0].waitUntil)));
    const runDir = path.join(handoff.reference.workerRoot, '.omni/codex-gemini/runs', 'TASK-1');
    const failures = fs.readFileSync(path.join(runDir, 'events.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
        .filter((event) => event.type === 'phase.failed');
    assert.deepEqual([...new Set(failures.map((event) => event.error_code))], ['DUAL_RUNTIME_RATE_LIMITED']);
    const progress = fs.readFileSync(path.join(path.dirname(path.join(input.workspaceRoot, handoff.reference.bindingPath)),
        'turn-progress.ndjson'), 'utf8');
    assert.match(progress, /"type":"runtime-wait"/);
});

test('isolated claude implement stops with DUAL_RUNTIME_WAIT_EXHAUSTED after the bounded wait', darwinOnly, async (t) => {
    const input = isolatedFixture(t);
    const { common, stub } = discussion();
    const { calls, runner } = implementRunner(common, ['limited']);
    const waits = [];
    await assert.rejects(runIsolatedTask({ ...input, discussion: stub, processRunner: runner,
        runtimeWait: { probeMs: 5, maxWaitMs: 20, onWait: (info) => waits.push(info) } }),
    (error) => error.code === 'DUAL_RUNTIME_WAIT_EXHAUSTED');
    assert.equal(waits.length, 4);
    assert.equal(calls.length, 5);
});

test('isolated claude implement wait ends on abort', darwinOnly, async (t) => {
    const input = isolatedFixture(t);
    const { common, stub } = discussion();
    const { runner } = implementRunner(common, ['limited']);
    const controller = new AbortController();
    await assert.rejects(runIsolatedTask({ ...input, discussion: stub, processRunner: runner, signal: controller.signal,
        runtimeWait: { probeMs: 60_000, maxWaitMs: 120_000, onWait: () => setImmediate(() => controller.abort(new Error('stop'))) } }),
    (error) => error.code === 'ABORT_ERR');
});

test('without a runtime wait the usage limit keeps the ordinary three technical attempts', darwinOnly, async (t) => {
    const input = isolatedFixture(t);
    const { common, stub } = discussion();
    const { calls, runner } = implementRunner(common, ['limited']);
    await assert.rejects(runIsolatedTask({ ...input, discussion: stub, processRunner: runner }),
        (error) => error.code === 'DUAL_AGY_EXIT_NONZERO');
    assert.equal(calls.length, 3);
});

const { createAuthorityStore } = require('../lib/dual/authority-store');
const { normalizeAuthorityTaskStatus } = require('../lib/commands/dual');

function authorityFixture(t, { execution = true } = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-runtime-wait-ledger-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, '.omni/runs/dual-authority');
    const store = createAuthorityStore(dir);
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'ws', session_id: 'session', plan_revision: 1, expected_baseline: { kind: 'snapshot', id: 'a'.repeat(64) }, mode: 'auto' });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'fixture', status: 'PASSED' }] });
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'plan.md', plan_sha256: 'b'.repeat(64), total_tasks: 1,
        tasks: [{ task_id: 'TASK-1', title: 'task', owner: 'agy', execution_mode: 'isolated', allowed_files: ['a.js'] }] });
    store.append({ schema_version: 2, type: 'task.routed', task_id: 'TASK-1', owner: 'agy', authority_state: 'ROUTED',
        allowed_files: ['a.js'], reason: 'fixture' });
    const lease = store.acquireLease('TASK-1', 'agy');
    if (execution) store.append({ schema_version: 2, type: 'task.execution.started', task_id: 'TASK-1', lease_id: lease.lease_id, controller_pid: process.pid });
    return { dir, store, lease };
}

const waiting = (lease) => ({ schema_version: 2, type: 'task.runtime.waiting', task_id: 'TASK-1', lease_id: lease.lease_id,
    runtime: 'claude', reason: 'rate_limited', phase: 'implement', wait_until: new Date(Date.now() + 600_000).toISOString() });
const statusOf = (store) => {
    const derived = store.derive();
    return normalizeAuthorityTaskStatus({ session_id: 'session', state: derived.sessionState, tasks: derived.tasks, leases: derived.leases }, 'TASK-1');
};

test('ledger: the live lease holder records WAITING_RUNTIME and its end; replay agrees', (t) => {
    const { dir, store, lease } = authorityFixture(t);
    assert.equal(statusOf(store).state, 'AGY_IN_PROGRESS');
    store.append(waiting(lease));
    store.append(waiting(lease));
    const wait = store.derive().tasks['TASK-1'].runtimeWait;
    assert.deepEqual([wait.runtime, wait.reason, wait.phase, wait.probes], ['claude', 'rate_limited', 'implement', 2]);
    assert.deepEqual([statusOf(store).state, statusOf(store).nextAction], ['WAITING_RUNTIME', 'wait_for_runtime']);
    store.append({ schema_version: 2, type: 'task.runtime.resumed', task_id: 'TASK-1', lease_id: lease.lease_id });
    assert.equal(store.derive().tasks['TASK-1'].runtimeWait, undefined);
    assert.equal(statusOf(store).state, 'AGY_IN_PROGRESS');
    store.append(waiting(lease));
    // A fresh reader replays the same chain to the same state.
    assert.equal(createAuthorityStore(dir).derive().tasks['TASK-1'].runtimeWait.probes, 1);
});

test('ledger: a wait needs the live execution lease, and a resume needs its wait', (t) => {
    const { store, lease } = authorityFixture(t, { execution: false });
    assert.throws(() => store.append(waiting(lease)), /live execution lease/);
    const other = authorityFixture(t);
    assert.throws(() => other.store.append({ schema_version: 2, type: 'task.runtime.resumed', task_id: 'TASK-1',
        lease_id: other.lease.lease_id }), /matching wait/);
    assert.throws(() => other.store.append({ ...waiting(other.lease), reason: 'sleepy' }));
    assert.throws(() => other.store.append({ ...waiting(other.lease), lease_id: '00000000-0000-4000-8000-000000000000' }), /live execution lease/);
});

test('ledger: a released lease no longer shows WAITING_RUNTIME', (t) => {
    const { store, lease } = authorityFixture(t);
    store.append(waiting(lease));
    store.releaseLease(lease.lease_id, 'fixture_done');
    assert.notEqual(statusOf(store).state, 'WAITING_RUNTIME');
});

test('ledger: a released controller reconnaissance lease leaves the task free for its worker lease', (t) => {
    const { dir, store } = authorityFixture(t, { execution: false });
    const derivedLeases = () => Object.values(store.derive().leases);
    for (const lease of derivedLeases()) store.releaseLease(lease.lease_id, 'fixture');
    const recon = store.acquireLease('TASK-1', 'codex', { ttlMs: 120000 });
    store.renewLease(recon.lease_id, { ttlMs: 120000 });
    store.releaseLease(recon.lease_id, 'coverage_reconnaissance');
    const worker = store.acquireLease('TASK-1', 'agy', { ttlMs: 120000 });
    assert.equal(store.derive().leases[worker.lease_id].status, 'active');
    assert.equal(createAuthorityStore(dir).derive().leases[worker.lease_id].status, 'active', 'a fresh reader replays the same chain');
});
