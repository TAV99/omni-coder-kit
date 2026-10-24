'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');

const {
    startDaemonServer,
    createDaemonClient,
    createAuthorityStore,
    executeSetupManifest,
} = require('../lib/dual');

function makeChild() {
    const child = new EventEmitter();
    child.pid = undefined;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    return child;
}

function createSpawnSequence({ firstFailure = 'resource', code = 'EAGAIN', onSpawn } = {}) {
    let calls = 0;
    let authorityStore = null;
    const spawnImpl = (_command, args) => {
        calls += 1;
        const child = makeChild();
        setImmediate(() => {
            if (calls === 1 && firstFailure === 'sync-throw') {
                return;
            }
            if (calls === 1 && firstFailure === 'resource') {
                const error = Object.assign(new Error('simulated process-table pressure'), { code });
                if (onSpawn) onSpawn(authorityStore);
                child.emit('error', error);
                child.emit('close', null, null);
                return;
            }
            if (calls === 1 && firstFailure === 'post-spawn-error') {
                child.pid = 12345;
                child.emit('spawn');
                child.emit('error', Object.assign(new Error('error after spawn'), { code }));
                child.emit('close', null, null);
                return;
            }
            if (calls === 1 && firstFailure === 'nonzero') {
                child.pid = 12345;
                child.emit('spawn');
                child.stderr.end('Error: ECONNRESET from provider\n');
                setImmediate(() => child.emit('close', 1, null));
                return;
            }
            if (calls === 1 && firstFailure === 'timeout') {
                child.pid = 12345;
                child.emit('spawn');
                return;
            }

            child.pid = 12345;
            child.emit('spawn');
            const output = args[0] === '--version'
                ? 'agy version 1.1.19\n'
                : 'Model\n gemini-3.7-flash-high\n';
            child.stdout.end(output);
            child.stderr.end();
            setImmediate(() => child.emit('close', 0, null));
        });
        if (calls === 1 && firstFailure === 'sync-throw') {
            throw Object.assign(new Error('simulated process-table pressure'), { code });
        }
        return child;
    };
    return {
        spawnImpl,
        bind: (store) => { authorityStore = store; },
        get calls() { return calls; },
    };
}

async function createHarness(t, { spawnSequence, capabilityPreflight, checkConfig, setupReady = true, invalidConfig = false, timeoutMs } = {}) {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dual-preflight-retry-'));
    let daemon = null;
    t.after(async () => {
        if (daemon) await daemon.close();
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    });

    fs.writeFileSync(path.join(workspaceRoot, 'package.json'), '{"name":"preflight-retry-test"}\n');
    fs.mkdirSync(path.join(workspaceRoot, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, '.codex', 'config.toml'), invalidConfig
        ? '[features]\nhooks = false\n[mcp_servers.omni_dual]\n'
        : '[features]\nhooks = true\n[mcp_servers.omni_dual]\n');
    fs.writeFileSync(path.join(workspaceRoot, '.codex', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [] } }));
    fs.mkdirSync(path.join(workspaceRoot, '.omni', 'sdlc'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, '.omni', 'sdlc', 'setup.json'), JSON.stringify({
        schema_version: 1,
        actions: [],
    }, null, 2) + '\n');

    const authorityDir = path.join(workspaceRoot, '.omni', 'runs', 'dual-authority');
    const authorityStore = createAuthorityStore(authorityDir);
    if (spawnSequence && typeof spawnSequence.bind === 'function') spawnSequence.bind(authorityStore);
    const serverOptions = { workspaceRoot, authorityStore };
    if (spawnSequence) serverOptions.spawnImpl = spawnSequence.spawnImpl;
    if (capabilityPreflight) serverOptions.capabilityPreflight = capabilityPreflight;
    if (checkConfig) serverOptions.checkConfig = checkConfig;
    if (timeoutMs !== undefined) serverOptions.timeoutMs = timeoutMs;
    daemon = await startDaemonServer(serverOptions);

    const client = createDaemonClient({ workspaceRoot, timeoutMs: 5000 });
    const begun = await client.beginSession({ workspace_root: workspaceRoot, mode: 'auto' });
    if (setupReady) executeSetupManifest({ workspaceRoot });

    const planText = '# retry plan\n';
    const planPath = path.join(workspaceRoot, 'plans', 'retry-plan.md');
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, planText);
    const payload = {
        plan_path: 'plans/retry-plan.md',
        plan_sha256: crypto.createHash('sha256').update(planText).digest('hex'),
        plan_revision: 1,
        acceptance_policy: {
            protocol_version: 1,
            checks: [],
            ui: {
                required: false,
                viewport_widths: [390, 768, 1024, 1440],
                reduced_motion_required: true,
            },
        },
        tasks: [{ task_id: 'TASK-PREFLIGHT-RETRY', title: 'Preflight retry', owner: 'agy', model: 'gemini-3.7-flash-high', effort: 'high', allowed_files: ['lib/a.js'], deny_patterns: [], validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }] }],
    };
    const eventsPath = path.join(authorityDir, 'events.ndjson');
    return { workspaceRoot, authorityDir, authorityStore, client, sessionId: begun.session_id, payload, eventsPath, spawnSequence };
}

test('pre-spawn resource pressure leaves a fresh session retryable without ledger writes', async (t) => {
    const spawnSequence = createSpawnSequence();
    const harness = await createHarness(t, { spawnSequence });
    const { authorityStore, client, sessionId, payload, eventsPath } = harness;
    const beforeEvents = fs.readFileSync(eventsPath);

    await assert.rejects(
        () => client.registerPlan(sessionId, payload),
        (error) => error.code === 'DUAL_CAPABILITY_RETRYABLE'
    );

    assert.deepEqual(fs.readFileSync(eventsPath), beforeEvents, 'retryable preflight must not append any session event');
    assert.equal((await client.sessionStatus(sessionId)).state, 'DISCOVERED');
    const afterFailure = authorityStore.derive();
    assert.deepEqual(Object.keys(afterFailure.tasks), []);
    assert.deepEqual(Object.keys(afterFailure.leases), []);
    assert.deepEqual(Object.keys(afterFailure.gates), []);
    assert.deepEqual(authorityStore.readOperationRecords(), []);

    const registered = await client.registerPlan(sessionId, payload);
    assert.equal(registered.registered, true);
    assert.ok(authorityStore.derive().plan, 'healthy retry must persist the registered plan');
    const events = authorityStore.readEvents();
    assert.equal(events.filter((event) => event.type === 'capability.result').length, 1);
    assert.equal(events.filter((event) => event.type === 'plan.registered').length, 1);
    assert.equal(spawnSequence.calls, 3, 'one failed version probe then the healthy version and models probes');
});

test('only allowlisted pre-spawn resource errors qualify for a retryable response', async (t) => {
    for (const [code, firstFailure] of [['EAGAIN', 'resource'], ['EMFILE', 'sync-throw'], ['ENFILE', 'resource']]) {
        await t.test(`${code} is retryable before a child exists`, async (subtest) => {
            const spawnSequence = createSpawnSequence({ code, firstFailure });
            const harness = await createHarness(subtest, { spawnSequence });
            const before = fs.readFileSync(harness.eventsPath);

            await assert.rejects(
                () => harness.client.registerPlan(harness.sessionId, harness.payload),
                (error) => error.code === 'DUAL_CAPABILITY_RETRYABLE'
            );

            assert.deepEqual(fs.readFileSync(harness.eventsPath), before);
            assert.equal((await harness.client.sessionStatus(harness.sessionId)).state, 'DISCOVERED');
        });
    }
});

test('generic typed and untyped injected errors remain terminal and never authorize retry', async (t) => {
    for (const error of [
        Object.assign(new Error('provider socket reset ECONNRESET'), { code: 'ECONNRESET' }),
        Object.assign(new Error('untrusted retry code'), { code: 'DUAL_CAPABILITY_RETRYABLE', details: { probe_code: 'EAGAIN' } }),
        new Error('untyped temporary failure'),
    ]) {
        await t.test(error.code || 'untyped error', async (subtest) => {
            const harness = await createHarness(subtest, {
                capabilityPreflight: async () => { throw error; },
            });

            await assert.rejects(
                () => harness.client.registerPlan(harness.sessionId, harness.payload),
                (caught) => caught.code === 'DUAL_CAPABILITY_BLOCKED'
            );
            assert.equal((await harness.client.sessionStatus(harness.sessionId)).state, 'DISCOVERED');
            const capabilityEvents = harness.authorityStore.readEvents().filter((event) => event.type === 'capability.result');
            assert.equal(capabilityEvents.length, 0);
        });
    }
});

test('malformed or wrong-model PASS evidence remains fail-closed', async (t) => {
    const malformedResults = [
        {
            status: 'PASSED',
            to_state: 'CAPABILITY_SAFE',
            checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        },
        {
            status: 'PASSED',
            to_state: 'CAPABILITY_SAFE',
            checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
            details: {
                agy_version: '1.1.19',
                agy_model: 'gemini-2.0-flash',
                agy_evidence: { version: '1.1.19', model: 'gemini-2.0-flash' },
            },
        },
    ];
    for (const result of malformedResults) {
        await t.test(result.details ? 'wrong model' : 'missing durable evidence', async (subtest) => {
            const harness = await createHarness(subtest, { capabilityPreflight: async () => result });
            await assert.rejects(
                () => harness.client.registerPlan(harness.sessionId, harness.payload),
                (error) => error.code === 'DUAL_CAPABILITY_BLOCKED'
            );
            assert.equal((await harness.client.sessionStatus(harness.sessionId)).state, 'DISCOVERED');
        });
    }
});

test('missing setup credentials and preflight setup receipts are not retryable', async (t) => {
    let preflightCalls = 0;
    const harness = await createHarness(t, {
        setupReady: false,
        capabilityPreflight: async () => {
            preflightCalls += 1;
            throw Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
        },
    });

    await assert.rejects(
        () => harness.client.registerPlan(harness.sessionId, harness.payload),
        (error) => error.code === 'DUAL_SETUP_REQUIRED'
    );
    assert.equal(preflightCalls, 0);
    assert.equal((await harness.client.sessionStatus(harness.sessionId)).state, 'DISCOVERED');
});

test('live-child errors, timeouts, missing executable, and nonzero CLI output are terminal', async (t) => {
    const scenarios = [
        { firstFailure: 'post-spawn-error', code: 'EAGAIN' },
        { firstFailure: 'timeout', timeoutMs: 10 },
        { firstFailure: 'resource', code: 'ENOENT' },
        { firstFailure: 'nonzero' },
    ];
    for (const scenario of scenarios) {
        await t.test(scenario.firstFailure === 'resource' ? 'missing executable' : scenario.firstFailure, async (subtest) => {
            const spawnSequence = createSpawnSequence(scenario);
            const harness = await createHarness(subtest, { spawnSequence, timeoutMs: scenario.timeoutMs });
            await assert.rejects(
                () => harness.client.registerPlan(harness.sessionId, harness.payload),
                (error) => error.code === 'DUAL_CAPABILITY_BLOCKED'
            );
            assert.equal((await harness.client.sessionStatus(harness.sessionId)).state, 'DISCOVERED');
        });
    }
});

test('a terminal check takes precedence over a transient pre-spawn resource error', async (t) => {
    const spawnSequence = createSpawnSequence({ code: 'EAGAIN' });
    const harness = await createHarness(t, { spawnSequence, invalidConfig: true });

    await assert.rejects(
        () => harness.client.registerPlan(harness.sessionId, harness.payload),
        (error) => error.code === 'DUAL_CAPABILITY_BLOCKED'
    );
    assert.equal((await harness.client.sessionStatus(harness.sessionId)).state, 'DISCOVERED');
    assert.equal(harness.authorityStore.readEvents().filter((event) => event.type === 'capability.result').length, 0);
});

test('a blocked credential check inside real preflight takes precedence over pre-spawn EAGAIN', async (t) => {
    const spawnSequence = createSpawnSequence({ code: 'EAGAIN' });
    const harness = await createHarness(t, {
        spawnSequence,
        checkConfig: async () => ({
            name: 'agy_credentials',
            status: 'BLOCKED',
            reason: 'AGY credentials are unavailable',
        }),
    });

    await assert.rejects(
        () => harness.client.registerPlan(harness.sessionId, harness.payload),
        (error) => error.code === 'DUAL_CAPABILITY_BLOCKED'
    );

    assert.equal(spawnSequence.calls, 1, 'real runCapabilityPreflight must still execute the AGY probe');
    assert.equal((await harness.client.sessionStatus(harness.sessionId)).state, 'DISCOVERED');
    const capabilityEvents = harness.authorityStore.readEvents().filter((event) => event.type === 'capability.result');
    assert.equal(capabilityEvents.length, 0);
});

test('authority changes during awaited preflight invalidate retry classification', async (t) => {
    const spawnSequence = createSpawnSequence({
        code: 'EAGAIN',
        onSpawn: (authorityStore) => {
            authorityStore.append({
                schema_version: 2,
                type: 'capability.result',
                from_state: 'DISCOVERED',
                status: 'PASSED',
                checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
                details: {
                    agy_version: '1.1.19',
                    agy_model: 'gemini-3.7-flash-high',
                    agy_evidence: { version: '1.1.19', model: 'gemini-3.7-flash-high' },
                },
                to_state: 'CAPABILITY_SAFE',
            });
        },
    });
    const harness = await createHarness(t, { spawnSequence });

    await assert.rejects(
        () => harness.client.registerPlan(harness.sessionId, harness.payload),
        (error) => error.code === 'DUAL_TRANSITION_INVALID'
    );
    assert.equal((await harness.client.sessionStatus(harness.sessionId)).state, 'CAPABILITY_SAFE');
    const events = harness.authorityStore.readEvents();
    assert.equal(events.filter((event) => event.type === 'capability.result').length, 1);
    assert.equal(events.some((event) => event.type === 'plan.registered'), false);
});

test('non-empty gates invalidate an otherwise retryable preflight failure', async (t) => {
    const spawnSequence = createSpawnSequence({
        code: 'EAGAIN',
        onSpawn: (authorityStore) => {
            const originalDerive = authorityStore.derive.bind(authorityStore);
            authorityStore.derive = (...args) => ({
                ...originalDerive(...args),
                gates: { 'injected-gate': { status: 'PASSED' } },
            });
        },
    });
    const harness = await createHarness(t, { spawnSequence });

    await assert.rejects(
        () => harness.client.registerPlan(harness.sessionId, harness.payload),
        (error) => error.code === 'DUAL_CAPABILITY_BLOCKED'
    );

    assert.equal((await harness.client.sessionStatus(harness.sessionId)).state, 'DISCOVERED');
    const capabilityEvents = harness.authorityStore.readEvents().filter((event) => event.type === 'capability.result');
    assert.equal(capabilityEvents.length, 0);
    assert.equal(spawnSequence.calls, 1);
});

test('authority evidence read failures fail closed at preflight start and after await', async (t) => {
    for (const method of ['readEvents', 'readOperationRecords']) {
        for (const [phase, failureCall] of [['before await', 1], ['after await', 2]]) {
            await t.test(`${method} failure ${phase}`, async (subtest) => {
                const spawnSequence = createSpawnSequence({ code: 'EAGAIN' });
                const harness = await createHarness(subtest, { spawnSequence });
                const original = harness.authorityStore[method].bind(harness.authorityStore);
                let calls = 0;
                harness.authorityStore[method] = (...args) => {
                    calls += 1;
                    if (calls === failureCall) throw new Error('simulated authority evidence read failure');
                    return original(...args);
                };
                const before = fs.readFileSync(harness.eventsPath);

                await assert.rejects(
                    () => harness.client.registerPlan(harness.sessionId, harness.payload),
                    (error) => error.code === 'DUAL_INTEGRITY_CORRUPT'
                );

                assert.deepEqual(fs.readFileSync(harness.eventsPath), before);
                assert.equal((await harness.client.sessionStatus(harness.sessionId)).state, 'DISCOVERED');
                if (phase === 'before await') {
                    assert.equal(spawnSequence.calls, 0, 'authority must be checked before starting preflight');
                }
            });
        }
    }
});
