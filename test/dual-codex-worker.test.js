'use strict';

// P3c-3 (SPEC-SQUAD-P3 §4.4): codex fills the worker slot. The slot keeps its
// internal id 'agy'; argv, output parsing, probes and discussion follow codex.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { EvidenceSchema, toDraft7Schema } = require('../lib/dual/contracts');
const {
    workerOutputSchema, buildWorkerInvocation, extractWorkerPayload, workerCommandFor, probeCodexWorker,
} = require('../lib/dual/worker-runtime');
const { buildAgyInvocation } = require('../lib/dual/agy-runner');
const { strictJsonSchema, stripNullOptionals } = require('../lib/squad/runtimes/strict-schema');
const {
    resolveConfiguredWorkerRuntime, effectiveWorkerEffort, workerEffortArgs, workerConfigurationError, MODEL_DEFAULT_EFFORT,
} = require('../lib/dual/agy-model');
const { workerSlotAdapter, workerSlotSeed } = require('../lib/dual/discussion/worker-slot');
const { runIsolatedTask } = require('../lib/dual/isolated-runner');
const { createDiscussionStub } = require('./helpers/dual-discussion-stub');

const fixtureText = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'squad-cli', name), 'utf8');
const tempRoot = (t) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-codex-worker-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
};
const jsonl = (payload, { failed = false } = {}) => [
    { type: 'thread.started', thread_id: '01a1952b-46fc-7241-b931-c270928eccdb' },
    { type: 'turn.started' },
    ...(payload === undefined ? [] : [{ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: JSON.stringify(payload) } }]),
    failed ? { type: 'turn.failed', error: { message: 'quota' } }
        : { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, reasoning_output_tokens: 0 } },
].map((event) => JSON.stringify(event)).join('\n') + '\n';

test('worker runtime comes from options, then manifest, then env, then agy', (t) => {
    const root = tempRoot(t);
    const saved = process.env.OMNI_DUAL_WORKER_RUNTIME;
    t.after(() => { if (saved === undefined) delete process.env.OMNI_DUAL_WORKER_RUNTIME; else process.env.OMNI_DUAL_WORKER_RUNTIME = saved; });
    delete process.env.OMNI_DUAL_WORKER_RUNTIME;
    assert.equal(resolveConfiguredWorkerRuntime(root), 'agy');
    process.env.OMNI_DUAL_WORKER_RUNTIME = 'codex';
    assert.equal(resolveConfiguredWorkerRuntime(root), 'codex');
    fs.mkdirSync(path.join(root, '.omni'));
    fs.writeFileSync(path.join(root, '.omni', 'manifest.json'), JSON.stringify({ workerRuntime: 'agy' }));
    assert.equal(resolveConfiguredWorkerRuntime(root), 'agy');
    assert.equal(resolveConfiguredWorkerRuntime(root, { workerRuntime: 'codex' }), 'codex');
});

test('bindings always carry an effort; the marker never reaches argv (H7)', () => {
    assert.equal(effectiveWorkerEffort('gemini-3.8-flash-high', null), 'high');
    assert.equal(effectiveWorkerEffort('claude-sonnet-4-6', undefined), MODEL_DEFAULT_EFFORT);
    assert.equal(effectiveWorkerEffort('gpt-6.1-sol', 'xhigh'), 'xhigh');
    assert.deepEqual(workerEffortArgs(MODEL_DEFAULT_EFFORT), []);
    assert.equal(workerConfigurationError('claude-sonnet-4-6', MODEL_DEFAULT_EFFORT), null);
    assert.match(workerConfigurationError('gpt-6.1-sol', null), /Missing AGY worker effort/, 'codex models still need an effort');
});

test('strict schema: every key required, optional ones nullable, nulls stripped back out (V17)', () => {
    const schema = { type: 'object', additionalProperties: false, required: ['a'],
        properties: { a: { type: 'string' }, b: { type: 'object', required: [], properties: { c: { type: 'number' } } },
            list: { type: 'array', items: { type: 'object', required: ['x'], properties: { x: { type: 'string' }, y: { type: 'string' } } } } } };
    const strict = strictJsonSchema(schema);
    assert.deepEqual(strict.required, ['a', 'b', 'list']);
    assert.deepEqual(strict.properties.b.anyOf[1], { type: 'null' });
    assert.deepEqual(strict.properties.b.anyOf[0].required, ['c']);
    assert.deepEqual(strict.properties.list.anyOf[0].items.required, ['x', 'y']);
    assert.deepEqual(stripNullOptionals({ a: 'v', b: null, list: [{ x: '1', y: null }] }, schema), { a: 'v', list: [{ x: '1' }] });
    assert.deepEqual(stripNullOptionals({ a: null }, schema), { a: null }, 'a null in a required field is left for zod to reject');
    const union = { anyOf: [
        { type: 'object', additionalProperties: false, required: ['v', 'n'], properties: { v: { const: 1 }, n: { type: 'string' } } },
        { type: 'object', additionalProperties: false, required: ['v'], properties: { v: { const: 2 }, n: { type: 'string' } } }] };
    assert.deepEqual(stripNullOptionals({ v: 2, n: null }, union), { v: 2 }, 'the matching branch decides');
    assert.deepEqual(stripNullOptionals({ v: 1, n: null }, union), { v: 1, n: null });
});

test('codex implement schema is strict and drops the agy-only tool fields; agy keeps its schema', () => {
    const base = toDraft7Schema(EvidenceSchema, 'omni-dual-evidence-v1', { schemaVersion: 2, baselineKind: 'snapshot' });
    assert.ok(base.properties.toolAction);
    const strict = workerOutputSchema('codex', base);
    assert.equal(strict.properties.toolAction, undefined);
    assert.deepEqual(strict.required.sort(), Object.keys(strict.properties).sort());
    assert.equal(workerOutputSchema('agy', base), base);
    assert.throws(() => workerOutputSchema('opencode', base), { code: 'DUAL_WORKER_RUNTIME_UNSUPPORTED' });
});

test('codex worker argv: full-auto only in an isolated root, read-only outside implement, prompt stays a file reference', (t) => {
    const repoRoot = tempRoot(t);
    const args = { repoRoot, phase: 'implement', inputPath: path.join(repoRoot, 'raw', 'implement.1.input.md'),
        schemaPath: path.join(repoRoot, 'raw', 'implement.1.schema.json'), timeoutMs: 120_000, model: 'gpt-6.1-sol', effort: 'high',
        workerCommand: '/opt/codex' };
    const isolated = buildWorkerInvocation({ runtime: 'codex', isolatedRoot: true, ...args });
    assert.equal(isolated.command, '/opt/codex');
    assert.deepEqual(isolated.args.slice(0, 2), ['exec', '--skip-git-repo-check']);
    for (const flag of ['--json', '--dangerously-bypass-approvals-and-sandbox', 'project_root_markers=[]', 'model_reasoning_effort="high"']) {
        assert.ok(isolated.args.includes(flag), flag);
    }
    assert.equal(isolated.args[isolated.args.indexOf('--output-schema') + 1], args.schemaPath);
    assert.equal(isolated.args[isolated.args.indexOf('-C') + 1], repoRoot);
    assert.equal(isolated.args.at(-1), 'Read raw/implement.1.input.md and complete only the implement phase. Return the required JSON contract.');
    const shared = buildWorkerInvocation({ runtime: 'codex', ...args });
    assert.deepEqual(shared.args.slice(shared.args.indexOf('-s'), shared.args.indexOf('-s') + 2), ['-s', 'workspace-write']);
    assert.ok(!shared.args.includes('--dangerously-bypass-approvals-and-sandbox'));
    const scout = buildWorkerInvocation({ runtime: 'codex', isolatedRoot: true, ...args, phase: 'scout' });
    assert.deepEqual(scout.args.slice(scout.args.indexOf('-s'), scout.args.indexOf('-s') + 2), ['-s', 'read-only']);
    // agy still gets its legacy argv byte for byte.
    assert.deepEqual(buildWorkerInvocation({ runtime: 'agy', ...args, model: 'gemini-3.8-flash-high' }),
        buildAgyInvocation({ ...args, model: 'gemini-3.8-flash-high' }));
    assert.throws(() => buildWorkerInvocation({ runtime: 'codex', ...args, effort: 'warp' }), { code: 'DUAL_WORKER_CONFIG_MISSING' });
    assert.deepEqual(workerCommandFor('agy', { agyCommand: '/bin/agy', agyPrefixArgs: ['x'] }), { command: '/bin/agy', prefixArgs: ['x'] });
});

test('codex worker reply: real strict-schema output validates; failures keep the agy retry codes', () => {
    const real = extractWorkerPayload('codex', { exitCode: 0, stdout: fixtureText('codex-exec-evidence-strict.jsonl') }, EvidenceSchema);
    assert.deepEqual([real.payload.status, real.payload.task_id, real.extractionMode], ['SUCCESS', 'T-1', 'codex_output_schema']);
    const code = (result) => { try { extractWorkerPayload('codex', result, EvidenceSchema); return null; } catch (error) { return error.code; } };
    assert.equal(code({ exitCode: 0, stdout: '' }), 'DUAL_AGY_EMPTY_OUTPUT');
    assert.equal(code({ exitCode: 0, stdout: jsonl(undefined, { failed: true }) }), 'DUAL_AGY_EXIT_NONZERO');
    assert.equal(code({ exitCode: 1, stdout: jsonl({}) }), 'DUAL_AGY_EXIT_NONZERO');
    assert.equal(code({ exitCode: 0, stdout: jsonl(undefined) }), 'DUAL_AGY_OUTPUT_MALFORMED');
    assert.equal(code({ exitCode: 0, stdout: jsonl({ status: 'SUCCESS' }) }), 'DUAL_AGY_CONTRACT_INVALID');
    assert.equal(code({ exitCode: 0, stdout: 'plain text' }), 'DUAL_AGY_OUTPUT_MALFORMED');
});

test('codex worker probe: parseable version, model in cache (hidden allowed), missing cache trusted', async (t) => {
    const home = tempRoot(t);
    t.mock.method(os, 'homedir', () => home);
    const savedHome = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    t.after(() => { if (savedHome !== undefined) process.env.CODEX_HOME = savedHome; });
    const cli = path.join(home, 'codex');
    fs.writeFileSync(cli, '#!/bin/sh\necho "codex-cli 0.166.0"\n', { mode: 0o700 });
    const probe = (model) => probeCodexWorker({ command: cli, cwd: home, env: process.env, model });
    assert.deepEqual(await probe('gpt-6.1-sol'), { ok: true, version: '0.166.0' });
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', visibility: 'hide' }] }));
    assert.equal((await probe('gpt-6.1-sol')).ok, true);
    assert.equal((await probe('gpt-0')).code, 'DUAL_PREFLIGHT_MODEL_UNAVAILABLE');
    fs.writeFileSync(cli, '#!/bin/sh\necho "1.0"\n');
    assert.equal((await probe('gpt-6.1-sol')).code, 'DUAL_PREFLIGHT_AGY_VERSION_INVALID');
});

function capture(stdout) {
    const calls = [];
    const spawnImpl = (command, args, options) => {
        calls.push({ command, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => true;
        setImmediate(() => { child.stdout.emit('data', Buffer.from(stdout)); child.emit('close', 0, null); });
        return child;
    };
    return { calls, spawnImpl };
}

test('discussion worker slot: codex adapter answers as provider agy, own session, read-only and isolated', async () => {
    const seedRun = capture(jsonl({ schema_version: 1, kind: 'reply', body: 'ready' }));
    const seeded = await workerSlotSeed('codex')({ cwd: '/work', codexPath: '/opt/codex', model: 'gpt-6.1-sol', effort: 'high',
        isolatedRoot: true, spawnImpl: seedRun.spawnImpl });
    assert.equal(seeded.conversationId, '01a1952b-46fc-7241-b931-c270928eccdb');
    const seedArgs = seedRun.calls[0].args;
    assert.deepEqual([seedArgs[0], seedArgs[seedArgs.indexOf('-m') + 1]], ['exec', 'gpt-6.1-sol']);
    assert.ok(seedArgs.includes('read-only') && seedArgs.includes('project_root_markers=[]'));

    const turnRun = capture(jsonl({ schema_version: 1, kind: 'reply', body: 'answer' }));
    const adapter = workerSlotAdapter('codex', { cwd: '/work', codexPath: '/opt/codex', isolatedRoot: true, spawnImpl: turnRun.spawnImpl });
    assert.equal(adapter.provider, 'agy');
    const binding = { provider: 'agy', role: 'argon', model: 'gpt-6.1-sol', effort: 'high', conversation_id: seeded.conversationId,
        session_id: 'session-1', task_id: 'TASK-1', plan_revision: 1,
        snapshot_sha256: crypto.createHash('sha256').update('ctx').digest('hex') };
    const raw = await adapter.invoke({ binding, snapshot: { text: 'ctx', sha256: binding.snapshot_sha256 }, envelope: { kind: 'question', body: 'scout?' },
        invocationId: 'inv-1', timeoutMs: 10_000, signal: new AbortController().signal, markNudged() {} });
    assert.equal(adapter.classify(raw, binding, 'inv-1').completion, 'succeeded');
    const args = turnRun.calls[0].args;
    assert.deepEqual(args.slice(0, 4), ['exec', 'resume', '--skip-git-repo-check', seeded.conversationId]);
    assert.ok(args.includes('sandbox_mode="read-only"') && args.includes('project_root_markers=[]'));
    assert.equal(workerSlotAdapter('agy', { isolatedRoot: true }).provider, 'agy');
});

function isolatedFixture(t) {
    const root = tempRoot(t);
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Return the number two.\n');
    return { workspaceRoot: root, sessionId: 'session-1', attempt: 1, planRevision: 1, workerRuntime: 'codex', workerCommand: '/opt/codex',
        task: { task_id: 'TASK-1', model: 'gpt-6.1-sol', effort: 'high', goal: 'Return two', allowed_files: ['index.js'], context_files: ['spec.md'],
            deny_patterns: [], validation_commands: [{ program: 'node', args: ['--check', 'index.js'], cwd: '.' }] },
        capability: { version: '0.166.0', model: 'gpt-6.1-sol' }, authorize: () => true };
}

test('isolated task with a codex worker: scout/review by discussion, implement by codex exec, QC handoff', async (t) => {
    const input = isolatedFixture(t);
    const implementCalls = [];
    const common = (workerRoot, taskId) => {
        const spec = JSON.parse(fs.readFileSync(path.join(workerRoot, '.omni/codex-gemini/runs', taskId, 'spec.json'), 'utf8'));
        return { schema_version: 1, task_id: taskId, expected_baseline: spec.expected_baseline };
    };
    const discussion = createDiscussionStub({
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
    });
    const handoff = await runIsolatedTask({ ...input, discussion,
        processRunner: async (invocation) => {
            implementCalls.push(invocation);
            const taskId = fs.readdirSync(path.join(invocation.cwd, '.omni/codex-gemini/runs'))[0];
            fs.writeFileSync(path.join(invocation.cwd, 'index.js'), 'module.exports = 2;\n');
            const schema = JSON.parse(fs.readFileSync(invocation.args[invocation.args.indexOf('--output-schema') + 1], 'utf8'));
            assert.deepEqual(schema.required.sort(), Object.keys(schema.properties).sort(), 'the worker sees a strict schema');
            const payload = { ...common(invocation.cwd, taskId), status: 'SUCCESS', modified_files: ['index.js'],
                command_outputs: [{ command: 'node --check index.js', exit_code: 0, output: '' }], unverified_items: [],
                self_review: { checks: ['scope', 'syntax', 'value'], remaining_risks: [] } };
            return { exitCode: 0, stdout: jsonl(payload), stderr: '', timedOut: false, startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
        } });
    assert.equal(handoff.status, 'AWAITING_CODEX_QC');
    assert.equal(implementCalls.length, 1, 'only implement spawns the worker CLI');
    const [call] = implementCalls;
    assert.equal(call.command, '/opt/codex');
    assert.equal(call.cwd, handoff.reference.workerRoot);
    assert.ok(call.args.includes('--dangerously-bypass-approvals-and-sandbox') && call.args.includes('project_root_markers=[]'));
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 1;\n', 'source untouched until QC');
    assert.equal(Buffer.from(handoff.result.changes[0].contentBase64, 'base64').toString(), 'module.exports = 2;\n');
});
