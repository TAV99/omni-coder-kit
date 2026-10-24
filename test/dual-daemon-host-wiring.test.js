'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { createAuthorityStore, computeEventHash } = require('../lib/dual/authority-store');
const { createDaemonDiscussionHost } = require('../lib/dual/daemon-server');
const { createDiscussionAdapter } = require('../lib/dual/discussion/adapter');

function loadModule(relativePath, mocks, processImpl = process) {
    const filename = require.resolve(relativePath);
    const localRequire = createRequire(filename);
    const module = { exports: {} };
    const wrapped = vm.runInNewContext('(function(require, module, exports) {\n'
        + fs.readFileSync(filename, 'utf8').replace(/^#![^\n]*/, '') + '\n})', { process: processImpl }, { filename });
    wrapped((name) => Object.hasOwn(mocks, name) ? mocks[name] : localRequire(name), module, module.exports);
    return module.exports;
}

function workspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-daemon-wiring-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function stubAdapter(provider) {
    return createDiscussionAdapter({
        id: `stub-${provider}`, provider, version: '1', mode: 'fake',
        profile: { format: 'json', requireConversationMatch: true,
            allowlistedTerminalMarkers: ['fixture.completed'] },
        invoke: async () => assert.fail('no provider invocation expected'),
        classify: () => assert.fail('no provider classification expected'),
    });
}

test('shared helper resolves both stub bindings with a real authority store and restores envelopes', async (t) => {
    const root = workspace(t);
    const authorityStore = createAuthorityStore(path.join(root, 'authority'));
    authorityStore.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED',
        workspace_id: 'ws-wiring', session_id: 'session-wiring', plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) }, workspace_root: root, mode: 'auto' });
    const seeds = [];
    const host = createDaemonDiscussionHost({ authorityStore, workspaceRoot: root,
        adapters: { codex: stubAdapter('codex'), agy: stubAdapter('agy') },
        seeds: Object.fromEntries(['codex', 'agy'].map((provider) => [provider, async (options) => {
            seeds.push({ provider, options });
            return { conversationId: `stub-${provider}` };
        }])),
        preflight: { run: async () => assert.fail('resolver must not run preflight') },
        recoveryProbes: { isProcessQuiescent: async () => true },
    });
    t.after(() => host.closeAll());
    assert.equal(typeof host.sessionResolver, 'function');
    const session = await host.sessionResolver({ taskId: 'TASK-1', snapshotSha256: 'a'.repeat(40) });
    assert.equal(session.enabled, true);
    assert.deepEqual(session.bindings.map((b) => b.provider), ['codex', 'agy']);
    assert.ok(session.bindings.every((b) => b.session_id === authorityStore.derive().sessionId
        && b.plan_revision === authorityStore.derive().planRevision));
    assert.ok(seeds.every(({ options }) => options.cwd === root));
    const state = await host.authorityReader({ bindings: session.bindings });
    let previousHash = '0'.repeat(64);
    assert.deepEqual(state.leaseEvents, authorityStore.readEvents().map((event) => {
        const envelope = { previous_hash: previousHash, event_hash: computeEventHash(previousHash, event), event };
        previousHash = envelope.event_hash;
        return envelope;
    }));
    const stateDir = path.join(root, '.omni', 'runs', 'dual-discussion');
    assert.equal(fs.readdirSync(stateDir).length, 1);
    await host.closeAll();
    const { inspectJournal } = require('../lib/dual/discussion/journal');
    assert.equal((await inspectJournal({ stateDir: path.join(stateDir, fs.readdirSync(stateDir)[0]) })).locked, false);
});

for (const [flag, enabled] of [[undefined, true], ['1', true], ['0', false], ['banana', false]]) {
    test(`executable factory forwards discussion and project identity for env=${flag}`, () => {
        let hostCalls = 0;
        const resolver = async () => {};
        const isolatedFactory = async () => {};
        const store = {};
        const host = { sessionResolver: resolver, createIsolatedDiscussion: isolatedFactory, closeAll: async () => {} };
        const server = require('../lib/dual/daemon-server');
        const executable = loadModule('../bin/omni-daemon', {
            '../lib/dual/daemon-server': { ...server, createDaemonDiscussionHost(options) {
                hostCalls++;
                assert.equal(options.authorityStore, store);
                assert.equal(options.workspaceRoot, '/canonical');
                return host;
            } },
            '../lib/dual/orchestrator-adapter': { createOrchestratorAdapter: (options) => options },
        });
        const result = executable.createExecutableOrchestrator({ workspaceRoot: '/canonical',
            authorityStore: store, agyProjectId: 'registered-project',
            env: flag === undefined ? {} : { OMNI_DUAL_DISCUSSION_ENABLED: flag } });
        assert.equal(result.orchestrator.agyProjectId, 'registered-project');
        assert.equal(result.orchestrator.authorityStore, store);
        assert.equal(hostCalls, enabled ? 1 : 0);
        if (enabled) {
            assert.equal(result.discussionHost, host);
            assert.equal(result.orchestrator.discussion.enabled, true);
            assert.equal(result.orchestrator.discussion.sessionResolver, resolver);
            assert.equal(result.orchestrator.discussion.createIsolatedDiscussion, isolatedFactory);
        } else {
            assert.equal(result.discussionHost, null);
            assert.equal(Object.hasOwn(result.orchestrator, 'discussion'), false);
        }
    });
}

test('default server factory still creates the shared host before adapter construction without a socket', async () => {
    const sentinel = new Error('stop before socket');
    let hostOptions;
    let adapterOptions;
    const resolver = async () => {};
    const server = loadModule('../lib/dual/daemon-server', {
        './discussion/host-resolver': { createDiscussionHost(options) {
            hostOptions = options;
            return { sessionResolver: resolver, closeAll: async () => {} };
        } },
        './orchestrator-adapter': { createOrchestratorAdapter(options) {
            adapterOptions = options;
            throw sentinel;
        } },
    }, { env: {}, cwd: () => process.cwd() });
    await assert.rejects(server.startDaemonServer({ workspaceRoot: process.cwd(),
        authorityStore: { derive: () => ({ sessionId: 'default', planRevision: 3 }) },
    }), (error) => error === sentinel);
    assert.equal(adapterOptions.discussion.sessionResolver, resolver);
    assert.equal(hostOptions.daemon.sessionId, 'default');
    assert.equal(hostOptions.daemon.getPlanRevision(), 3);
    assert.equal(typeof hostOptions.adapters.codex.probeRecovery, 'function');
    assert.equal(typeof hostOptions.adapters.agy.probeRecovery, 'function');
});

for (const mode of ['SIGINT', 'SIGTERM', 'stopped', 'startup-failure']) {
    test(`executable closes its host on ${mode}`, async (t) => {
        const root = workspace(t);
        const proc = new EventEmitter();
        Object.assign(proc, { env: {}, stderr: { write() {} } });
        let hostCloses = 0;
        let daemonCloses = 0;
        let stop;
        const stopped = new Promise((resolve) => { stop = resolve; });
        const executable = loadModule('../bin/omni-daemon', {
            '../lib/dual/daemon-server': {
                daemonDiscussionOptions: require('../lib/dual/daemon-server').daemonDiscussionOptions,
                discussionEnabledFromEnv: () => true,
                createDaemonDiscussionHost: () => ({ sessionResolver: async () => {},
                    closeAll: async () => { hostCloses++; } }),
                startDaemonServer: async () => {
                    if (mode === 'startup-failure') throw new Error('startup failed');
                    return { stopped, close: async () => { daemonCloses++; stop(); } };
                },
            },
            '../lib/dual/orchestrator-adapter': { createOrchestratorAdapter: () => ({}) },
            '../lib/dual/agy-project': { resolveRegisteredAgyProjectId: () => null },
        }, proc);
        const running = executable.runDaemon(['--workspace', root]);
        // Let startup install signal listeners without opening a socket.
        await new Promise((resolve) => setImmediate(resolve));
        if (mode === 'stopped') stop();
        else if (mode !== 'startup-failure') { proc.emit(mode); proc.emit(mode); }
        await running;
        assert.equal(hostCloses, 1);
        assert.equal(daemonCloses, mode.startsWith('SIG') ? 1 : 0);
        assert.equal(proc.listenerCount('SIGINT'), 0);
        assert.equal(proc.listenerCount('SIGTERM'), 0);
        if (mode === 'startup-failure') assert.equal(proc.exitCode, 1);
    });
}

test('isolated factory uses real daemon authority, private process hooks, and separate discussion baseline end to end', async (t) => {
    const { createConfiguredSnapshotBaseline } = require('../lib/dual/snapshot-policy');
    const { writeInitialSnapshot } = require('../lib/dual/snapshot-store');
    const { createOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
    const { spawnBoundedProcess } = require('../lib/dual/capability-preflight');
    const { daemonDiscussionOptions } = require('../lib/dual/daemon-server');
    const root = fs.realpathSync.native(workspace(t));
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = 1;\n');
    const baseline = createConfiguredSnapshotBaseline({ root }).baseline.capture();
    const authorityDir = path.join(root, '.omni/runs/dual-authority');
    const store = createAuthorityStore(authorityDir);
    const model = 'gemini-3.8-flash-high';
    const task = { task_id: 'TASK-1', title: 'Return two', goal: 'Return two', owner: 'agy', risk: 'low',
        execution_mode: 'isolated', allowed_files: ['index.js'], context_files: [], deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--check', 'index.js'], cwd: '.' }] };
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'ws-private', session_id: 'session-private', plan_revision: 1, expected_baseline: baseline.identity, mode: 'auto' });
    writeInitialSnapshot({ authorityDir, sessionId: 'session-private', workspaceId: 'ws-private',
        workspaceRoot: root, identity: baseline.identity, manifest: baseline.manifest });
    const checks = ['authority_ledger_integrity', 'baseline_backend', 'project_configuration', 'agy_cli_and_model', 'mcp_and_hook_setup']
        .map((name) => ({ name, status: 'PASSED' }));
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks, details: { agy_version: '1.2.3', agy_model: model } });
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'plan.md', plan_sha256: 'a'.repeat(64), total_tasks: 1, tasks: [task] });
    store.append({ schema_version: 2, type: 'task.routed', task_id: task.task_id, owner: 'agy', authority_state: 'ROUTED',
        allowed_files: task.allowed_files, model, reason: 'Private discussion test' });
    const audit = [], phases = [];
    let context, savedBindings;
    async function auditProcess(hooks, kind) {
        await hooks.prespawnGuard({ cwd: hooks.workerRoot, kind });
        const auditFile = path.join(hooks.workerRoot, '.omni/codex-gemini/runs/TASK-1', `process-audit-${audit.length}.json`);
        const result = await spawnBoundedProcess(process.execPath, ['-e',
            'require("node:fs").writeFileSync(process.argv[1],JSON.stringify({cwd:process.cwd(),ceiling:process.env.GIT_CEILING_DIRECTORIES,gitDir:process.env.GIT_DIR}))', auditFile],
        { ...hooks, cwd: hooks.workerRoot, timeoutMs: 5000 });
        assert.equal(result.ok, true);
        assert.equal(result.code, 0);
        audit.push({ kind, ...JSON.parse(fs.readFileSync(auditFile, 'utf8')) });
    }
    const host = createDaemonDiscussionHost({ authorityStore: store, workspaceRoot: root,
        async createIsolatedAdapters(hooks) {
            context = hooks;
            const adapters = Object.fromEntries(['codex', 'agy'].map((provider) => [provider, createDiscussionAdapter({
                id: `private-${provider}`, provider, version: '1', mode: 'fake',
                profile: { format: 'json', requireConversationMatch: true, allowlistedTerminalMarkers: ['fixture.completed'] },
                async invoke({ binding, invocationId, envelope }) {
                    savedBindings = binding;
                    await auditProcess(hooks, 'turn');
                    const phase = envelope.body.includes('# Review') ? 'review' : 'scout';
                    phases.push(phase);
                    const spec = JSON.parse(fs.readFileSync(path.join(hooks.workerRoot, '.omni/codex-gemini/runs/TASK-1/spec.json')));
                    const common = { schema_version: 1, task_id: task.task_id, expected_baseline: spec.expected_baseline };
                    const payload = phase === 'review' ? { ...common, recommendation: 'APPROVE', risk_level: 'LOW', findings: [],
                        review_checks: ['scope', 'syntax', 'value'], challenge_summary: 'Checked change.' }
                        : { ...common, summary: 'Read index', relevant_files: [{ path: 'index.js', description: 'Return value' }], exact_symbols: [],
                            validation_commands: ['node --check index.js'], constraints: ['scope'], risks: [], open_questions: [],
                            research_trace: [{ question: 'What changes?', source: 'index.js', source_type: 'REPOSITORY', conclusion: 'Return two' },
                                { question: 'What validates?', source: 'index.js', source_type: 'REPOSITORY', conclusion: 'Node syntax check' }],
                            alternatives_considered: [{ option: 'Edit existing', tradeoff: 'Small' }, { option: 'Add file', tradeoff: 'Unnecessary' }],
                            failure_modes: ['Wrong value'] };
                    return { exitCode: 0, stderr: '', stdout: JSON.stringify({ binding, invocationId,
                        payload: { schema_version: 1, kind: 'reply', body: JSON.stringify(payload) } }) };
                },
                classify(raw) {
                    const value = JSON.parse(raw.stdout);
                    return { completion: 'succeeded', payload: value.payload,
                        observedConversationId: value.binding.conversation_id, observedInvocationId: value.invocationId,
                        terminalMarker: 'fixture.completed', evidenceRef: 'fixture', hasTerminalError: false };
                },
            })]));
            return { adapters,
                seeds: Object.fromEntries(['codex', 'agy'].map((provider) => [provider, async () => {
                    await auditProcess(hooks, 'seed');
                    return { conversationId: `${provider}-${hooks.operationId}` };
                }])),
                preflight: { async run(workerRoot, options) {
                    assert.equal(workerRoot, hooks.workerRoot);
                    assert.equal(options.spawnImpl, hooks.spawnImpl);
                    assert.equal(options.env, hooks.env);
                    await auditProcess(hooks, 'probe');
                    return { status: 'PASSED', to_state: 'CAPABILITY_SAFE', checks,
                        details: { agy_version: '1.2.3', agy_model: model, agy_evidence: { version: '1.2.3', model } } };
                }, codexProbe: async () => true },
            };
        },
    });
    t.after(() => host.closeAll());
    let implementCalls = 0;
    const discussion = daemonDiscussionOptions(host);
    discussion.createIsolatedDiscussion = async (execution) => {
        await assert.rejects(() => host.createIsolatedDiscussion({ ...execution, workerBaselineId: 'b'.repeat(64) }),
            (error) => error.code === 'DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID');
        assert.equal(audit.length, 0, 'authority baseline mismatch denies before any seed or probe');
        const child = await host.createIsolatedDiscussion(execution);
        const resolve = child.sessionResolver;
        child.sessionResolver = async (request) => {
            const session = await resolve(request);
            const state = await child.authorityReader({ bindings: session.bindings });
            assert.match(state.expectedSnapshotSha256, /^[a-f0-9]{64}$/);
            assert.equal(context.authorize(), true);
            const replayed = require('../lib/dual/authority-store').replayAuthorityEvents(state.leaseEvents,
                { operationRecords: state.operationLedger?.records, operationLedger: state.operationLedger });
            assert.equal(replayed.leases[context.leaseId].status, 'active');
            const { createDaemonHostDeps } = require('../lib/dual/discussion/daemon-ports');
            assert.equal(await createDaemonHostDeps({ authority: child.authorityReader, authorize: context.authorize,
                leaseId: context.leaseId }).checkAuthority({ bindings: session.bindings }), true,
            'real host ports must authorize exact active execution');
            return session;
        };
        return child;
    };
    const adapter = createOrchestratorAdapter({ workspaceRoot: root, authorityStore: store,
        discussion, async processRunner(invocation) {
            assert.ok(invocation.args.some((arg) => arg.includes('implement phase')));
            implementCalls++;
            const spec = JSON.parse(fs.readFileSync(path.join(invocation.cwd, '.omni/codex-gemini/runs/TASK-1/spec.json')));
            fs.writeFileSync(path.join(invocation.cwd, 'index.js'), 'module.exports = 2;\n');
            return { exitCode: 0, stdout: JSON.stringify({ status: 'success', structured_output: {
                schema_version: 1, task_id: task.task_id, expected_baseline: spec.expected_baseline, status: 'SUCCESS', modified_files: ['index.js'],
                command_outputs: [{ command: 'node --check index.js', exit_code: 0, output: '' }], unverified_items: [],
                self_review: { checks: ['scope', 'syntax', 'value'], remaining_risks: [] } } }), stderr: '', timedOut: false,
                startedAt: new Date(), endedAt: new Date(), durationMs: 1 };
        } });
    const current = store.derive();
    const handoff = await adapter.executeAgyTask(task.task_id, current.tasks[task.task_id], current);
    assert.equal(handoff.status, 'AWAITING_CODEX_QC');
    assert.deepEqual(phases, ['scout', 'review']);
    assert.equal(implementCalls, 1);
    assert.ok(audit.some((item) => item.kind === 'probe'));
    assert.ok(audit.every((item) => item.cwd === context.workerRoot && item.cwd !== root
        && item.ceiling === path.dirname(context.workerRoot) && item.gitDir === undefined));
    assert.notEqual(savedBindings.snapshot_sha256, context.workerBaselineId);
    assert.equal(store.derive().currentBaseline.id, baseline.identity.id);
    assert.equal(context.authorize(), false, 'closed execution loses exact operation authority');
    const execution = store.derive().tasks[task.task_id].executions[context.leaseId];
    assert.ok(Object.values(execution.processes).length >= audit.length);
    assert.ok(Object.values(execution.processes).every((child) => child.state === 'exited'));
    assert.equal(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), 'module.exports = 1;\n');
    await host.closeAll();
});
