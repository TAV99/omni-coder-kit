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
        const store = {};
        const host = { sessionResolver: resolver, closeAll: async () => {} };
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
