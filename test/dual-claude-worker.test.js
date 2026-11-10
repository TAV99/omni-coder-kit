'use strict';

// P4b (SPEC-SQUAD-P4 §4): Claude Code fills the worker slot. The slot keeps its
// internal id 'agy'; argv, output parsing, probes and discussion follow claude.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { EvidenceSchema, toDraft7Schema } = require('../lib/dual/contracts');
const {
    workerOutputSchema, buildWorkerInvocation, extractWorkerPayload, workerCommandFor, probeAdapterWorker,
} = require('../lib/dual/worker-runtime');
const { effectiveWorkerEffort, workerConfigurationError, MODEL_DEFAULT_EFFORT } = require('../lib/dual/agy-model');
const { workerSlotAdapter, workerSlotSeed } = require('../lib/dual/discussion/worker-slot');
const { runIsolatedTask } = require('../lib/dual/isolated-runner');
const { engineSupport, legacyManifestFields } = require('../lib/squad/bindings');
const { createDiscussionStub } = require('./helpers/dual-discussion-stub');

const SESSION = '9ae7cc82-ff4e-48e4-89b7-84b9335e85b0';
const fixtureText = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'squad-cli', name), 'utf8');
const tempRoot = (t) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-claude-worker-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
};
// One `claude -p --output-format json` result object (V23).
const reply = ({ result = '', structured, subtype = 'success', session = SESSION } = {}) => JSON.stringify({
    type: 'result', subtype, is_error: subtype !== 'success', session_id: session, result,
    ...(structured ? { structured_output: structured } : {}), permission_denials: [],
    usage: { input_tokens: 1, output_tokens: 1, output_tokens_details: { thinking_tokens: 0 } },
});

test('claude worker config: model required, effort optional and from claude\'s own list', () => {
    assert.equal(workerConfigurationError('sonnet', undefined, 'claude'), null);
    assert.equal(workerConfigurationError('claude-sonnet-5-5', 'high', 'claude'), null, 'the agy no-effort rule for claude-* does not apply');
    assert.match(workerConfigurationError('claude-sonnet-5-5', 'high'), /agy does not accept --effort/, 'agy keeps its rule');
    assert.match(workerConfigurationError('sonnet', 'ultra', 'claude'), /claude does not accept effort "ultra"/);
    assert.match(workerConfigurationError('', 'low', 'claude'), /Missing claude worker model/);
    assert.equal(workerConfigurationError('sonnet', MODEL_DEFAULT_EFFORT, 'claude'), null);
    assert.equal(effectiveWorkerEffort('opus-high', undefined, 'claude'), MODEL_DEFAULT_EFFORT, 'no agy suffix rule for claude');
});

test('claude implement schema is not strict and drops the agy-only tool fields (V24)', () => {
    const base = toDraft7Schema(EvidenceSchema, 'omni-dual-evidence-v1', { schemaVersion: 2, baselineKind: 'snapshot' });
    const schema = workerOutputSchema('claude', base);
    assert.equal(schema.properties.toolAction, undefined);
    assert.deepEqual(schema.required, base.required.filter((key) => key !== 'toolAction' && key !== 'toolSummary'));
    assert.deepEqual(schema.properties.self_review, base.properties.self_review, 'nested optional fields stay optional, no null unions');
});

test('claude worker argv: full-auto only in an isolated root, tool lists elsewhere, schema inline', (t) => {
    const repoRoot = tempRoot(t);
    const schemaPath = path.join(repoRoot, 'raw', 'implement.1.schema.json');
    fs.mkdirSync(path.dirname(schemaPath));
    fs.writeFileSync(schemaPath, JSON.stringify({ type: 'object' }));
    const args = { repoRoot, phase: 'implement', inputPath: path.join(repoRoot, 'raw', 'implement.1.input.md'), schemaPath,
        timeoutMs: 120_000, model: 'sonnet', effort: 'high', workerCommand: '/opt/claude' };
    const isolated = buildWorkerInvocation({ runtime: 'claude', isolatedRoot: true, ...args });
    assert.equal(isolated.command, '/opt/claude');
    assert.equal(isolated.args[0], '-p');
    assert.equal(isolated.args[1], 'Read raw/implement.1.input.md and complete only the implement phase. Return the required JSON contract.');
    for (const flag of ['bypassPermissions', '--strict-mcp-config', '--settings']) assert.ok(isolated.args.includes(flag), flag);
    assert.equal(isolated.args[isolated.args.indexOf('--effort') + 1], 'high');
    assert.equal(isolated.args[isolated.args.indexOf('--json-schema') + 1], '{"type":"object"}');
    assert.equal(isolated.cwd, repoRoot);
    const shared = buildWorkerInvocation({ runtime: 'claude', ...args });
    assert.equal(shared.args[shared.args.indexOf('--tools') + 1], 'Read,Grep,Glob,Skill,Edit,Write', 'shared mode edits only (Q-P4-4)');
    assert.ok(!shared.args.includes('bypassPermissions'));
    const scout = buildWorkerInvocation({ runtime: 'claude', isolatedRoot: true, ...args, phase: 'scout' });
    assert.equal(scout.args[scout.args.indexOf('--tools') + 1], 'Read,Grep,Glob,Skill');
    const noEffort = buildWorkerInvocation({ runtime: 'claude', ...args, effort: MODEL_DEFAULT_EFFORT });
    assert.ok(!noEffort.args.includes('--effort'), 'model-default never reaches argv');
    assert.throws(() => buildWorkerInvocation({ runtime: 'claude', ...args, effort: 'warp' }), { code: 'DUAL_WORKER_CONFIG_MISSING' });
    assert.deepEqual(workerCommandFor('claude', { workerCommand: '/opt/claude', workerPrefixArgs: ['x'] }), { command: '/opt/claude', prefixArgs: ['x'] });
});

test('claude worker reply: real structured_output validates; failures keep the agy retry codes', () => {
    const real = extractWorkerPayload('claude', { exitCode: 0, stdout: fixtureText('claude-json-schema-evidence.json') }, EvidenceSchema);
    assert.deepEqual([real.payload.status, real.payload.task_id, real.extractionMode], ['SUCCESS', 'T-1', 'claude_output_schema']);
    const code = (result) => { try { extractWorkerPayload('claude', result, EvidenceSchema); return null; } catch (error) { return error.code; } };
    assert.equal(code({ exitCode: 0, stdout: '' }), 'DUAL_AGY_EMPTY_OUTPUT');
    assert.equal(code({ exitCode: 0, stdout: reply({ subtype: 'error_max_turns' }) }), 'DUAL_AGY_EXIT_NONZERO');
    assert.equal(code({ exitCode: 1, stdout: reply() }), 'DUAL_AGY_EXIT_NONZERO');
    assert.equal(code({ exitCode: 0, stdout: reply({ result: 'no json here' }) }), 'DUAL_AGY_OUTPUT_MALFORMED');
    assert.equal(code({ exitCode: 0, stdout: reply({ structured: { status: 'SUCCESS' } }) }), 'DUAL_AGY_CONTRACT_INVALID');
    assert.equal(code({ exitCode: 0, stdout: 'plain text' }), 'DUAL_AGY_OUTPUT_MALFORMED');
});

test('claude worker probe: version, alias list, any full claude-… id', async (t) => {
    const home = tempRoot(t);
    const cli = path.join(home, 'claude');
    const models = JSON.parse(fixtureText('claude-slash-model.json'));
    fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify(models));
    fs.writeFileSync(cli, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.316 (Claude Code)"; else cat "${path.join(home, 'models.json')}"; fi\n`, { mode: 0o700 });
    const probe = (model) => probeAdapterWorker({ runtime: 'claude', command: cli, cwd: home, env: process.env, model });
    assert.deepEqual(await probe('sonnet'), { ok: true, version: '2.1.316' });
    assert.equal((await probe('claude-opus-5-5')).ok, true);
    assert.equal((await probe('gpt-6.1-sol')).code, 'DUAL_PREFLIGHT_MODEL_UNAVAILABLE');
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

test('discussion worker slot: claude answers as provider agy, own session, read-only and isolated', async () => {
    const cwd = path.resolve('/work');
    const seedRun = capture(reply({ result: JSON.stringify({ schema_version: 1, kind: 'reply', body: 'ready' }) }));
    const seeded = await workerSlotSeed('claude')({ cwd, command: '/opt/claude', model: 'sonnet', effort: 'low',
        isolatedRoot: true, spawnImpl: seedRun.spawnImpl });
    assert.equal(seeded.conversationId, SESSION);
    const seedArgs = seedRun.calls[0].args;
    assert.equal(seedRun.calls[0].command, '/opt/claude');
    assert.equal(seedArgs[seedArgs.indexOf('--tools') + 1], 'Read,Grep,Glob,Skill');
    assert.ok(seedArgs.includes('--strict-mcp-config') && !seedArgs.includes('--resume'));

    const turnRun = capture(reply({ result: '```json\n{"schema_version":1,"kind":"reply","body":"answer"}\n```' }));
    const adapter = workerSlotAdapter('claude', { cwd, command: '/opt/claude', isolatedRoot: true, spawnImpl: turnRun.spawnImpl });
    assert.equal(adapter.provider, 'agy');
    const binding = { provider: 'agy', role: 'argon', model: 'sonnet', effort: MODEL_DEFAULT_EFFORT, conversation_id: SESSION,
        session_id: 'session-1', task_id: 'TASK-1', plan_revision: 1,
        snapshot_sha256: crypto.createHash('sha256').update('ctx').digest('hex') };
    const raw = await adapter.invoke({ binding, snapshot: { text: 'ctx', sha256: binding.snapshot_sha256 }, envelope: { kind: 'question', body: 'scout?' },
        invocationId: 'inv-1', timeoutMs: 10_000, signal: new AbortController().signal, markNudged() {} });
    const classified = adapter.classify(raw, binding, 'inv-1');
    assert.deepEqual([classified.completion, classified.payload.body], ['succeeded', 'answer']);
    const args = turnRun.calls[0].args;
    assert.deepEqual(args.slice(-2), ['--resume', SESSION]);
    assert.ok(!args.includes('--effort'), 'model-default sends no effort');
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob,Skill');
});

test('bindings: the dual engine takes a claude worker and writes workerRuntime claude', () => {
    const binding = { roles: { orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol' },
        worker: [{ id: 'worker-1', runtime: 'claude', model: 'sonnet', effort: 'high' }], reviewer: null } };
    assert.deepEqual(engineSupport(binding), { supported: true, reasons: [] });
    assert.deepEqual(JSON.parse(JSON.stringify(legacyManifestFields(binding, []))),
        { workerRuntime: 'claude', workerModel: 'sonnet', workerEffort: 'high', orchestratorRuntime: 'codex' });
});

function isolatedFixture(t) {
    const root = tempRoot(t);
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Return the number two.\n');
    return { workspaceRoot: root, sessionId: 'session-1', attempt: 1, planRevision: 1, workerRuntime: 'claude', workerCommand: '/opt/claude',
        task: { task_id: 'TASK-1', model: 'sonnet', effort: 'high', goal: 'Return two', allowed_files: ['index.js'], context_files: ['spec.md'],
            deny_patterns: [], validation_commands: [{ program: 'node', args: ['--check', 'index.js'], cwd: '.' }] },
        capability: { version: '2.1.316', model: 'sonnet' }, authorize: () => true };
}

test('isolated Claude implementation denies source writes and still reaches a QC handoff', { skip: process.platform !== 'darwin' }, async (t) => {
    const { workerRuntime, ...input } = isolatedFixture(t);
    const manifest = path.join(input.workspaceRoot, '.omni', 'manifest.json');
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify({ workerRuntime }));
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
        onPrepared() {
            // A concurrent configuration change must not separate the launcher from the fence.
            fs.writeFileSync(manifest, JSON.stringify({ workerRuntime: 'agy' }));
        },
        processRunner: async (invocation, deps) => {
            implementCalls.push(invocation);
            assert.equal(invocation.command, '/opt/claude', 'the launcher uses the runtime selected before preparation');
            const taskId = fs.readdirSync(path.join(invocation.cwd, '.omni/codex-gemini/runs'))[0];
            const source = path.join(input.workspaceRoot, 'index.js');
            const child = deps.spawn(process.execPath, ['-e', `
                const fs = require('node:fs');
                try {
                    fs.writeFileSync(process.argv[1], 'escaped');
                    console.log('ESCAPED');
                } catch (error) {
                    console.log(error.code);
                }
                fs.writeFileSync('index.js', 'module.exports = 2;\\n');
            `, source], { cwd: invocation.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
            let output = '';
            child.stdout.on('data', (chunk) => { output += chunk; });
            assert.deepEqual(await once(child, 'close'), [0, null]);
            assert.match(output.trim(), /^(EPERM|EACCES)$/);
            assert.equal(fs.readFileSync(source, 'utf8'), 'module.exports = 1;\n');
            const schema = JSON.parse(invocation.args[invocation.args.indexOf('--json-schema') + 1]);
            assert.equal(schema.properties.toolAction, undefined, 'the worker gets the claude schema inline');
            const payload = { ...common(invocation.cwd, taskId), status: 'SUCCESS', modified_files: ['index.js'],
                command_outputs: [{ command: 'node --check index.js', exit_code: 0, output: '' }], unverified_items: [],
                self_review: { checks: ['scope', 'syntax', 'value'], remaining_risks: [] } };
            return { exitCode: 0, stdout: reply({ structured: payload }), stderr: '', timedOut: false,
                startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
        } });
    assert.equal(handoff.status, 'AWAITING_CODEX_QC');
    assert.equal(implementCalls.length, 1, 'only implement spawns the worker CLI');
    const [call] = implementCalls;
    assert.equal(call.cwd, handoff.reference.workerRoot);
    assert.ok(call.args.includes('bypassPermissions') && call.args.includes('--strict-mcp-config'));
    const settings = JSON.parse(call.args[call.args.indexOf('--settings') + 1]);
    assert.ok(settings.claudeMdExcludes.includes(path.join(input.workspaceRoot, 'CLAUDE.md')), 'the project CLAUDE.md is excluded');
    assert.equal(fs.readFileSync(path.join(input.workspaceRoot, 'index.js'), 'utf8'), 'module.exports = 1;\n', 'source untouched until QC');
    assert.equal(Buffer.from(handoff.result.changes[0].contentBase64, 'base64').toString(), 'module.exports = 2;\n');
});

test('shared claude worker turns skip the project root CLAUDE.md and hooks (P7f dual-9)', async () => {
    const cwd = path.resolve('/work/project');
    const turnRun = capture(reply({ result: '```json\n{"schema_version":1,"kind":"reply","body":"answer"}\n```' }));
    const adapter = workerSlotAdapter('claude', { cwd, command: '/opt/claude', spawnImpl: turnRun.spawnImpl });
    const binding = { provider: 'agy', role: 'argon', model: 'sonnet', effort: MODEL_DEFAULT_EFFORT, conversation_id: SESSION,
        session_id: 'session-1', task_id: 'TASK-1', plan_revision: 1, snapshot_sha256: crypto.createHash('sha256').update('ctx').digest('hex') };
    await adapter.invoke({ binding, snapshot: { text: 'ctx', sha256: binding.snapshot_sha256 }, envelope: { kind: 'question', body: 'scout?' },
        invocationId: 'inv-1', timeoutMs: 10_000, signal: new AbortController().signal, markNudged() {} });
    const args = turnRun.calls[0].args;
    const settingsJson = JSON.parse(args[args.indexOf('--settings') + 1]);
    assert.equal(settingsJson.disableAllHooks, true);
    assert.ok(settingsJson.claudeMdExcludes.includes(path.join(cwd, 'CLAUDE.md')), 'the project root controller rules are excluded');
    assert.ok(args.includes('--strict-mcp-config'));
    const seedRun = capture(reply({ result: JSON.stringify({ schema_version: 1, kind: 'reply', body: 'ready' }) }));
    await workerSlotSeed('claude')({ cwd, command: '/opt/claude', model: 'sonnet', spawnImpl: seedRun.spawnImpl });
    const seedSettings = JSON.parse(seedRun.calls[0].args[seedRun.calls[0].args.indexOf('--settings') + 1]);
    assert.ok(seedSettings.claudeMdExcludes.includes(path.join(cwd, 'CLAUDE.md')), 'the seed is excluded the same way');
    // An isolated worker root keeps the previous behaviour: only the parents are excluded.
    const isolatedRun = capture(reply({ result: JSON.stringify({ schema_version: 1, kind: 'reply', body: 'ready' }) }));
    await workerSlotSeed('claude')({ cwd, command: '/opt/claude', model: 'sonnet', isolatedRoot: true, spawnImpl: isolatedRun.spawnImpl });
    const isolatedSettings = JSON.parse(isolatedRun.calls[0].args[isolatedRun.calls[0].args.indexOf('--settings') + 1]);
    assert.ok(!isolatedSettings.claudeMdExcludes.includes(path.join(cwd, 'CLAUDE.md')));
    assert.ok(isolatedSettings.claudeMdExcludes.includes(path.join(path.dirname(cwd), 'CLAUDE.md')));
});
