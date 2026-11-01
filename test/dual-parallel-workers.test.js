'use strict';

// P5c (SPEC-SQUAD-P5 §4): isolated tasks run side by side when their workers,
// runtimes and files allow it; results keep plan order.

require('./helpers/auto-approve-gates');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runScheduled, concurrencyLimits, DEFAULT_CONCURRENCY } = require('../lib/dual/worker-scheduler');
const { withDiscussion } = require('./helpers/dual-discussion-stub');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { createOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
const { writeInitialSnapshot } = require('../lib/dual/snapshot-store');
const { writeBinding } = require('../lib/squad/bindings');

// start() resolves when the test releases the item; tracks peak concurrency.
function harness() {
    const gates = new Map();
    const log = [];
    let running = 0;
    let peak = 0;
    const start = (item) => new Promise((resolve) => {
        running++; peak = Math.max(peak, running); log.push(`start:${item.key}`);
        gates.set(item.key, () => { running--; log.push(`end:${item.key}`); resolve(`done:${item.key}`); });
    });
    const release = async (key) => { while (!gates.has(key)) await new Promise((r) => setImmediate(r)); gates.get(key)(); gates.delete(key); };
    return { start, release, log, peak: () => peak };
}

const item = (key, workerId, runtime, files) => ({ key, workerId, runtime, allowedFiles: files });

test('different workers and runtimes run together; results keep plan order', async () => {
    const h = harness();
    const done = runScheduled([item('A', 'worker-1', 'agy', ['a.js']), item('B', 'worker-2', 'claude', ['b.js'])],
        { limits: DEFAULT_CONCURRENCY, start: h.start });
    await h.release('B');
    await h.release('A');
    assert.deepEqual(await done, ['done:A', 'done:B']);
    assert.equal(h.peak(), 2);
});

test('one turn per worker, runtime slots, and overlapping files each serialize', async () => {
    for (const [items, label] of [
        [[item('A', 'worker-1', 'claude', ['a.js']), item('B', 'worker-1', 'claude', ['b.js'])], 'same worker'],
        [[item('A', 'worker-1', 'agy', ['a.js']), item('B', 'worker-2', 'agy', ['b.js'])], 'agy has one slot'],
        [[item('A', 'worker-1', 'agy', ['src/a.js']), item('B', 'worker-2', 'claude', ['src'])], 'overlapping paths'],
    ]) {
        const h = harness();
        const done = runScheduled(items, { limits: DEFAULT_CONCURRENCY, start: h.start });
        await h.release('A');
        await h.release('B');
        await done;
        assert.equal(h.peak(), 1, label);
        assert.deepEqual(h.log, ['start:A', 'end:A', 'start:B', 'end:B'], label);
    }
});

test('a later task that fits starts while an earlier blocked one waits', async () => {
    const h = harness();
    const done = runScheduled([item('A', 'worker-1', 'agy', ['a.js']), item('B', 'worker-2', 'agy', ['b.js']),
        item('C', 'worker-3', 'codex', ['c.js'])], { limits: DEFAULT_CONCURRENCY, start: h.start });
    await h.release('C');
    await h.release('A');
    await h.release('B');
    await done;
    assert.deepEqual(h.log.slice(0, 2), ['start:A', 'start:C'], 'B waits for the agy slot, C does not');
});

test('a task that throws becomes its own FAILED result; its sibling keeps its result', async () => {
    const results = await runScheduled([item('A', 'worker-1', 'agy', ['a.js']), item('B', 'worker-2', 'claude', ['b.js'])],
        { limits: DEFAULT_CONCURRENCY, start: async (it) => {
            if (it.key === 'B') throw Object.assign(new Error('seed failed'), { code: 'SEED_FAILED' });
            return { status: 'AWAITING_CODEX_QC' };
        } });
    assert.deepEqual(results, [{ status: 'AWAITING_CODEX_QC' }, { taskId: 'B', status: 'FAILED', code: 'SEED_FAILED', summary: 'seed failed' }]);
});

test('limits come from squad.local.json over the defaults', (t) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-limits-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.deepEqual(concurrencyLimits(root), { codex: 2, claude: 2, agy: 1 });
    writeBinding(root, { schema_version: 1, preset: 'squad', updated_at: 'x', limits: { concurrency: { agy: 3 } },
        roles: { orchestrator: { runtime: 'codex', model: 'm' }, worker: [{ id: 'worker-1', runtime: 'agy', model: 'g' }], reviewer: null } });
    assert.deepEqual(concurrencyLimits(root), { codex: 2, claude: 2, agy: 3 });
});

async function runPair(t, { failTask } = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-parallel-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const name of ['a', 'b']) fs.writeFileSync(path.join(root, `${name}.js`), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Return two.\n');
    writeBinding(root, { schema_version: 1, preset: 'squad', updated_at: 'x', limits: { concurrency: { agy: 2 } },
        roles: { orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol' }, reviewer: null, worker: [
            { id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' },
            { id: 'worker-2', runtime: 'agy', model: 'gemini-3.8-flash-low', effort: 'low' }] } });
    const dir = path.join(root, '.omni/runs/dual-authority');
    const store = createAuthorityStore(dir);
    const snapshot = createConfiguredSnapshotBaseline({ root }).baseline.capture();
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'workspace-test', session_id: 'session-1', plan_revision: 1, expected_baseline: snapshot.identity, mode: 'auto' });
    writeInitialSnapshot({ authorityDir: dir, sessionId: 'session-1', workspaceId: 'workspace-test', workspaceRoot: root,
        identity: snapshot.identity, manifest: snapshot.manifest });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        details: { agy_version: '1.4.12', agy_model: 'gemini-3.8-flash-high',
            workers: { 'worker-2': { runtime: 'agy', version: '1.4.12', model: 'gemini-3.8-flash-low' } } } });
    const planTask = (id, worker, model, effort) => ({ task_id: id, title: id, goal: 'Return two', owner: 'agy', risk: 'low',
        execution_mode: 'isolated', allowed_files: [`${id.toLowerCase()}.js`], context_files: ['spec.md'], deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--check', `${id.toLowerCase()}.js`], cwd: '.' }], model, effort, ...(worker ? { worker } : {}) });
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'spec.md', plan_sha256: 'b'.repeat(64), total_tasks: 2,
        tasks: [planTask('A', undefined, 'gemini-3.8-flash-high', 'high'), planTask('B', 'worker-2', 'gemini-3.8-flash-low', 'low')] });
    for (const [id, model, effort] of [['A', 'gemini-3.8-flash-high', 'high'], ['B', 'gemini-3.8-flash-low', 'low']]) {
        store.append({ schema_version: 2, type: 'task.routed', task_id: id, owner: 'agy', authority_state: 'ROUTED',
            allowed_files: [`${id.toLowerCase()}.js`], model, effort, reason: 'Private task' });
    }
    let implementing = 0;
    let peak = 0;
    const models = new Set();
    const processRunner = async (invocation) => {
        const taskId = fs.readdirSync(path.join(invocation.cwd, '.omni/codex-gemini/runs'))[0];
        if (taskId === failTask) return { exitCode: 0, stdout: JSON.stringify({ status: 'error', error: 'boom' }), stderr: 'boom', timedOut: false, startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
        const spec = JSON.parse(fs.readFileSync(path.join(invocation.cwd, '.omni/codex-gemini/runs', taskId, 'spec.json'), 'utf8'));
        const common = { schema_version: 1, task_id: taskId, expected_baseline: spec.expected_baseline };
        const prompt = invocation.args.find((arg) => arg.startsWith('-p='));
        const model = invocation.args[invocation.args.indexOf('--model') + 1];
        if (/^gemini-/.test(model || '')) models.add(model);
        let payload;
        if (prompt.includes('scout phase')) payload = { ...common, summary: 'Read file and spec',
            relevant_files: [{ path: spec.allowed_files[0], description: 'return value' }], exact_symbols: [],
            validation_commands: ['node --check'], constraints: ['scope only'], risks: [], open_questions: [],
            research_trace: [spec.allowed_files[0], 'spec.md'].map((source) => ({ question: 'What to change?', source, source_type: 'REPOSITORY', conclusion: 'Return two' })),
            alternatives_considered: [{ option: 'Edit existing', tradeoff: 'small' }, { option: 'New file', tradeoff: 'unnecessary' }],
            failure_modes: ['wrong return value'] };
        else if (prompt.includes('implement phase')) {
            implementing++; peak = Math.max(peak, implementing);
            for (let i = 0; i < 100 && peak < 2 && !failTask; i++) await new Promise((resolve) => setTimeout(resolve, 20));
            implementing--;
            fs.writeFileSync(path.join(invocation.cwd, spec.allowed_files[0]), 'module.exports = 2;\n');
            payload = { ...common, status: 'SUCCESS', modified_files: spec.allowed_files,
                command_outputs: [{ command: `node --check ${spec.allowed_files[0]}`, exit_code: 0, output: '' }], unverified_items: [],
                self_review: { checks: ['scope', 'syntax', 'value'], remaining_risks: [] } };
        } else payload = { ...common, recommendation: 'APPROVE', risk_level: 'LOW', findings: [],
            review_checks: ['scope', 'syntax', 'value'], challenge_summary: 'Compared original and changed return.' };
        return { exitCode: 0, stdout: JSON.stringify({ status: 'success', structured_output: payload }), stderr: '',
            timedOut: false, startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
    };
    const adapter = createOrchestratorAdapter(withDiscussion({ workspaceRoot: root, authorityStore: store, processRunner }));
    const results = await adapter.runTask(store.derive());
    return { results, peak, models, tasks: store.derive().tasks, dir };
}

test('two isolated tasks on two agy workers implement at the same time and both hand off', async (t) => {
    const { results, peak, models, tasks } = await runPair(t);
    assert.deepEqual(results.map((r) => r.status), ['AWAITING_CODEX_QC', 'AWAITING_CODEX_QC']);
    assert.equal(peak, 2, 'both implement turns overlapped');
    assert.deepEqual([...models].sort(), ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'], 'each task ran on its own worker model');
    assert.ok(tasks.A.isolatedHandoff && tasks.B.isolatedHandoff);
});

test('one parallel task failing does not stop the other', async (t) => {
    const { results, tasks } = await runPair(t, { failTask: 'B' });
    assert.equal(results[0].status, 'AWAITING_CODEX_QC', 'task A still hands off');
    assert.notEqual(results[1].status, 'AWAITING_CODEX_QC');
    assert.ok(tasks.A.isolatedHandoff);
    assert.equal(tasks.B.isolatedHandoff, undefined);
});

// A reader in another process can land between the daemon's operation-record
// write and its commitment event; derive re-reads instead of calling it corrupt.
test('a reader racing a half-written operation record re-reads; a truly broken ledger still fails', async (t) => {
    const { dir } = await runPair(t);
    const realFs = require('node:fs');
    const racing = (halfWrites) => {
        let reads = 0;
        return { fsImpl: new Proxy(realFs, { get(target, key) {
            if (key !== 'readFileSync') return target[key];
            return (file, ...rest) => {
                const content = target.readFileSync(file, ...rest);
                if (!String(file).endsWith('operations.ndjson')) return content;
                reads += 1;
                return reads <= halfWrites ? `${content}{"partial":` : content;
            };
        } }), reads: () => reads };
    };
    const transient = racing(1);
    const derived = createAuthorityStore(dir, { fsImpl: transient.fsImpl }).derive();
    assert.ok(derived.tasks.A.isolatedHandoff);
    assert.ok(transient.reads() >= 2, 'the ledger was read again after the half record');
    const broken = racing(Infinity);
    assert.throws(() => createAuthorityStore(dir, { fsImpl: broken.fsImpl }).derive(), { code: 'DUAL_OPERATION_CORRUPT' });
    assert.equal(broken.reads(), 5, 'gives up after the retry budget');
});

