'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { runIsolatedTask, resumeIsolatedTask } = require('../lib/dual/isolated-runner');
const { persistCheckpoint } = require('../lib/dual/checkpoint');
const { integrateTaskResult } = require('../lib/dual/task-integration');
const { createDiscussionStub } = require('./helpers/dual-discussion-stub');
function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-isolated-runner-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Return the number two.\n');
    return { workspaceRoot: root, sessionId: 'session-1', attempt: 1, planRevision: 1,
        task: { task_id: 'TASK-1', model: 'gemini-3.8-flash-high', effort: 'high', goal: 'Return two', allowed_files: ['index.js'], context_files: ['spec.md'],
            deny_patterns: [], validation_commands: [{ program: 'node', args: ['--check', 'index.js'], cwd: '.' }] },
        capability: { version: '1.1.27-test', model: 'gemini-3.8-flash-high' }, authorize: () => true };
}

function fakeWorker(calls, transform = (payload) => payload) {
    return async (invocation, options) => {
        calls.push(invocation);
        assert.ok(options.env.GIT_CEILING_DIRECTORIES);
        assert.equal(invocation.args.includes('--project'), false);
        const taskId = fs.readdirSync(path.join(invocation.cwd, '.omni/codex-gemini/runs'))[0];
        const taskRun = path.join(invocation.cwd, '.omni/codex-gemini/runs', taskId);
        const spec = JSON.parse(fs.readFileSync(path.join(taskRun, 'spec.json'), 'utf8'));
        const common = { schema_version: 1, task_id: taskId, expected_baseline: spec.expected_baseline };
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
            const target = spec.allowed_files[0];
            fs.writeFileSync(path.join(invocation.cwd, target), 'module.exports = 2;\n');
            payload = { ...common, status: 'SUCCESS', modified_files: [target],
                command_outputs: [{ command: 'node --check index.js', exit_code: 0, output: '' }], unverified_items: [],
                self_review: { checks: ['scope', 'syntax', 'value'], remaining_risks: [] } };
        } else payload = { ...common, recommendation: 'APPROVE', risk_level: 'LOW', findings: [],
            review_checks: ['scope', 'syntax', 'value'], challenge_summary: 'Compared original and changed return.' };
        return { exitCode: 0, stdout: JSON.stringify({ status: 'success', structured_output: transform(payload) }), stderr: '',
            timedOut: false, startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
    };
}


function discussion(worker, stall = false) {
    return createDiscussionStub({
        async beforeTurn(context) {
            if (stall && context.phase === 'review') {
                await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
                context.signal.throwIfAborted();
            }
        },
        async turn({ workerRoot, phase }) {
            return JSON.parse((await worker({ cwd: workerRoot, args: [`-p=${phase} phase`] }, { env: { GIT_CEILING_DIRECTORIES: workerRoot } })).stdout).structured_output;
        },
    });
}
async function stalled(t) {
    const input = fixture(t), worker = fakeWorker([]);
    let reference, checkpoint;
    await assert.rejects(runIsolatedTask({ ...input, discussion: discussion(worker, true), processRunner: worker,
        checkpointMilestone: { summary: 'milestone 1 complete', next: 'implement milestone 2' },
        onPrepared(value) { reference = value; }, onCheckpoint(value) { checkpoint = value; },
        turnSafety: { softMs: 2000, hardMs: 4000, heartbeatMs: 10, noProgressMs: 100, graceMs: 50, pollMs: 5 },
    }), { code: 'DUAL_NO_WRITE_PROGRESS', message: 'NO_WRITE_PROGRESS: review (no_evidence)' });
    assert.ok(checkpoint);
    return { input, reference, checkpoint };
}
for (const target of ['workspace', 'manifest']) test(`tamper ${target} fails closed before new attempt`, async t => {
    const { input, reference, checkpoint } = await stalled(t);
    const file = target === 'workspace' ? path.join(reference.workerRoot, 'index.js') : path.join(input.workspaceRoot, checkpoint.path);
    fs.appendFileSync(file, 'tampered');
    await assert.rejects(resumeIsolatedTask({ ...input, attempt: 2, sourceReference: reference, checkpoint }), { code: 'DUAL_CHECKPOINT_TAMPERED' });
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('tampered'));
    assert.equal(fs.existsSync(path.join(path.dirname(path.dirname(path.join(input.workspaceRoot, reference.bindingPath))), 'attempt-2')), false);
});
test('TRIAL: completed milestone → watchdog stall → explicit resume → final artifact with original correlation and lineage', async t => {
    const { input, reference, checkpoint } = await stalled(t);
    const worker = fakeWorker([]);
    const result = await resumeIsolatedTask({ ...input, attempt: 2, sourceReference: reference, checkpoint,
        discussion: discussion(worker), processRunner: async (invocation, deps) => {
            assert.match(fs.readFileSync(path.join(invocation.cwd, '.omni/codex-gemini/runs/TASK-1/raw/implement.1.input.md'), 'utf8'), /milestone 1 complete/);
            assert.equal(fs.readFileSync(path.join(invocation.cwd, 'index.js'), 'utf8'), 'module.exports = 2;\n');
            const spec = JSON.parse(fs.readFileSync(path.join(invocation.cwd, '.omni/codex-gemini/runs/TASK-1/spec.json')));
            const output = { exitCode: 0, stdout: JSON.stringify({ status: 'success', structured_output: {
                schema_version: 1, task_id: 'TASK-1', expected_baseline: spec.expected_baseline, status: 'SUCCESS',
                modified_files: ['index.js'], command_outputs: [{ command: 'node --check index.js', exit_code: 0, output: '' }],
                unverified_items: [], self_review: { checks: ['scope', 'syntax', 'both milestones'], remaining_risks: [] },
            } }), stderr: '', timedOut: false, startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
            fs.appendFileSync(path.join(invocation.cwd, 'index.js'), '// milestone 2\n');
            return output;
        } });
    assert.equal(result.status, 'AWAITING_CODEX_QC');
    assert.equal(Buffer.from(result.result.changes[0].contentBase64, 'base64').toString(), 'module.exports = 2;\n// milestone 2\n');
    assert.equal(result.reference.workerBaselineSha256, reference.workerBaselineSha256);
    assert.equal(result.reference.originalBaseline.path, path.join(path.dirname(reference.bindingPath), 'worker-baseline.json'));
    assert.equal(result.reference.resumeLineage.resumedFrom, checkpoint.sha256);
    assert.equal(result.reference.resumeLineage.sourceAttempt, 1);
    assert.equal(result.reference.resumeLineage.attempt, 2);
    const original = JSON.parse(fs.readFileSync(path.join(input.workspaceRoot, result.reference.originalBaseline.path)));
    assert.deepEqual(result.workerBaseline, original.identity);
    assert.equal(result.result.taskId, input.task.task_id);
    for (const file of ['context.json', 'spec.json', 'route.json', 'evidence.json', 'review.json']) {
        const artifact = JSON.parse(fs.readFileSync(path.join(result.reference.workerRoot, result.artifactPath, file)));
        assert.equal(artifact.task_id, input.task.task_id);
        assert.deepEqual(artifact.expected_baseline, original.identity);
    }
    const integrated = integrateTaskResult({ workspaceRoot: input.workspaceRoot, reference: result.reference,
        result: result.result, expectedResultSha256: result.result.resultSha256, authorize: () => true });
    assert.equal(integrated.status, 'INTEGRATED');
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 2;\n// milestone 2\n');
});
test('no checkpoint retries original workspace, discarding incomplete output', async t => {
    const input = fixture(t), worker = fakeWorker([]);
    let reference;
    await assert.rejects(runIsolatedTask({ ...input, discussion: createDiscussionStub({ async beforeTurn(context) {
        fs.writeFileSync(path.join(context.workerRoot, 'index.js'), '// incomplete');
        await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
        context.signal.throwIfAborted();
    } }), onPrepared(value) { reference = value; },
    turnSafety: { softMs: 2000, hardMs: 4000, heartbeatMs: 10, noProgressMs: 40, graceMs: 20, pollMs: 5 } }), { code: 'DUAL_TURN_STALLED' });
    const result = await resumeIsolatedTask({ ...input, attempt: 2, sourceReference: reference,
        discussion: discussion(worker), processRunner: async (invocation, deps) => {
            assert.equal(fs.readFileSync(path.join(invocation.cwd, 'index.js'), 'utf8'), 'module.exports = 1;\n');
            return worker(invocation, deps);
        } });
    assert.equal(result.reference.resumeLineage.mode, 'baseline-retry');
    assert.equal(result.reference.resumeLineage.resumedFrom, null);
    assert.equal(result.reference.workerBaselineSha256, reference.workerBaselineSha256);
});

test('checkpoint is write-once and lives outside worker root', async t => {
    const { input, reference, checkpoint } = await stalled(t);
    const manifest = JSON.parse(fs.readFileSync(path.join(input.workspaceRoot, checkpoint.path)));
    assert.equal(path.dirname(checkpoint.path), path.dirname(reference.bindingPath));
    assert.equal(manifest.sourceReference.bindingSha256, reference.bindingSha256);
    assert.throws(() => persistCheckpoint({ workspaceRoot: input.workspaceRoot, reference,
        sequence: 1, milestone: manifest.milestone }), { code: 'DUAL_CHECKPOINT_EXISTS' });
});
test('checkpoint cannot silently fall back to baseline retry', async t => {
    const { input, reference } = await stalled(t);
    await assert.rejects(resumeIsolatedTask({ ...input, attempt: 2, sourceReference: reference }), { code: 'DUAL_CHECKPOINT_INVALID' });
});
test('resume requires live authority before filesystem mutation', async t => {
    const { input, reference, checkpoint } = await stalled(t);
    await assert.rejects(resumeIsolatedTask({ ...input, attempt: 2, sourceReference: reference, checkpoint,
        authorize: () => false }), { code: 'DUAL_ISOLATED_UNAUTHORIZED' });
});
test('original baseline tampering rejects resume', async t => {
    const { input, reference, checkpoint } = await stalled(t);
    fs.appendFileSync(path.join(input.workspaceRoot, reference.originalBaseline.path), ' ');
    await assert.rejects(resumeIsolatedTask({ ...input, attempt: 2, sourceReference: reference, checkpoint }), { code: 'DUAL_CHECKPOINT_TAMPERED' });
});
test('resume startup gate still rejects drift before implementation', async t => {
    const { input, reference, checkpoint } = await stalled(t);
    const worker = fakeWorker([]);
    await assert.rejects(resumeIsolatedTask({ ...input, attempt: 2, sourceReference: reference, checkpoint,
        onPrepared(next) { fs.appendFileSync(path.join(next.workerRoot, 'index.js'), '// drift'); },
        discussion: discussion(worker), processRunner() { assert.fail('implementation must not start'); },
    }), { code: 'DUAL_BASE_COMMIT_STALE' });
});
test('resume startup evidence is hash guarded', async t => {
    const { input, reference, checkpoint } = await stalled(t);
    const worker = fakeWorker([]);
    await assert.rejects(resumeIsolatedTask({ ...input, attempt: 2, sourceReference: reference, checkpoint,
        onPrepared(next) { fs.appendFileSync(path.join(input.workspaceRoot, next.resumeLineage.startupReference.path), ' '); },
        discussion: discussion(worker), processRunner() { assert.fail('implementation must not start'); },
    }), { code: 'DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID' });
});
test('resumed checkpoints retain cumulative milestones and original source lineage', async t => {
    const { input, reference, checkpoint } = await stalled(t);
    const worker = fakeWorker([]);
    let nextReference, nextCheckpoint;
    const result = await resumeIsolatedTask({ ...input, attempt: 2, sourceReference: reference, checkpoint,
        discussion: discussion(worker), processRunner: worker,
        checkpointMilestone: { summary: 'milestone 2 complete', next: 'milestone 3' },
        onPrepared(value) { nextReference = value; }, onCheckpoint(value) { nextCheckpoint = value; } });
    assert.equal(result.status, 'AWAITING_CODEX_QC');
    const manifest = JSON.parse(fs.readFileSync(path.join(input.workspaceRoot, nextCheckpoint.path)));
    assert.deepEqual(manifest.completedMilestones.map(item => item.summary), ['milestone 1 complete', 'milestone 2 complete']);
    const third = await resumeIsolatedTask({ ...input, attempt: 3, sourceReference: nextReference, checkpoint: nextCheckpoint,
        discussion: discussion(worker), processRunner: async (invocation, deps) => {
            const prompt = fs.readFileSync(path.join(invocation.cwd, '.omni/codex-gemini/runs/TASK-1/raw/implement.1.input.md'), 'utf8');
            assert.match(prompt, /milestone 1 complete/);
            assert.match(prompt, /milestone 2 complete/);
            assert.match(prompt, /milestone 3/);
            return worker(invocation, deps);
        } });
    assert.equal(third.reference.originalBaseline.path, reference.originalBaseline.path);
    assert.equal(third.reference.resumeLineage.sourceAttempt, 2);
    assert.equal(third.reference.workerBaselineSha256, reference.workerBaselineSha256);
});
test('older milestone cannot replace latest checkpoint selection', async t => {
    const { input, reference, checkpoint } = await stalled(t);
    const latest = persistCheckpoint({ workspaceRoot: input.workspaceRoot, reference, sequence: 2,
        milestone: { summary: 'later completed turn', next: 'remaining work' } });
    assert.notEqual(latest.sha256, checkpoint.sha256);
    await assert.rejects(resumeIsolatedTask({ ...input, attempt: 2, sourceReference: reference, checkpoint }), { code: 'DUAL_CHECKPOINT_INVALID' });
});
test('lineage mirror cannot diverge from authority binding', async t => {
    const { input, reference, checkpoint } = await stalled(t);
    const worker = fakeWorker([]);
    await assert.rejects(resumeIsolatedTask({ ...input, attempt: 2, sourceReference: reference, checkpoint,
        onPrepared(next) { fs.writeFileSync(path.join(input.workspaceRoot, path.dirname(next.bindingPath), 'resume-lineage.json'), '{}'); },
        discussion: discussion(worker), processRunner() { assert.fail('implementation must not start'); },
    }), { code: 'DUAL_CHECKPOINT_TAMPERED' });
});
