'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry } = require('../lib/squad/runtimes/registry');
const { defaultRegistry } = require('../lib/squad/runtimes');
const { fakeFs } = require('./helpers/squad-fakes');

const caps = (over = {}) => ({
    interactive: false, mcp: false, hooks: false, headless: true, write: true, resume: false,
    structuredOutput: false, transcript: false, sandbox: false, usage: false, multiModel: false, ...over,
});

function fakeRuntime(id, { calls = [], auth = 'authenticated', models = true, capabilities = caps() } = {}) {
    return {
        id, displayName: `Fake ${id}`,
        binary: { name: id, envOverride: 'OMNI_FAKE_PATH', extraCandidates: () => [`/bin/${id}`] },
        capabilities, efforts: null,
        version: async () => { calls.push('version'); return { ok: true, version: '1.0.0' }; },
        authStatus: async () => { calls.push('auth'); return { state: auth, method: null, evidence: auth, fix: 'log in' }; },
        listModels: async () => { calls.push('models'); return models ? { ok: true, source: 'cli', models: [] } : { ok: false, code: 'X', reason: 'no' }; },
        buildHeadless: () => ({}),
        permissionFlags: () => [],
    };
}

test('duplicate and unknown ids are rejected', () => {
    const registry = createRegistry({ runtimes: [fakeRuntime('one')] });
    assert.throws(() => registry.register(fakeRuntime('one')), { code: 'SQUAD_RUNTIME_DUPLICATE' });
    assert.throws(() => registry.get('two'), { code: 'SQUAD_RUNTIME_UNKNOWN' });
});

test('descriptor violating capability ⇔ method is rejected', () => {
    assert.throws(() => createRegistry({ runtimes: [fakeRuntime('one', { capabilities: caps({ resume: true }) })] }),
        { code: 'SQUAD_RUNTIME_INVALID_DESCRIPTOR' });
});

test('eligibleFor filters by declared capabilities', () => {
    assert.deepEqual(defaultRegistry.eligibleFor(['headless', 'resume']), ['codex', 'agy']);
    assert.deepEqual(defaultRegistry.eligibleFor(['multiModel']), ['agy']);
    assert.deepEqual(defaultRegistry.eligibleFor(['transcript']), []);
    assert.throws(() => defaultRegistry.eligibleFor(['teleport']), { code: 'SQUAD_RUNTIME_UNKNOWN' });
});

test('probe stops after a failed detect and suggests a fix', async () => {
    const calls = [];
    const registry = createRegistry({ runtimes: [fakeRuntime('one', { calls })] });
    const report = await registry.probe('one', { platform: 'linux', env: {}, fsImpl: fakeFs({}) });
    assert.equal(report.ready, false);
    assert.deepEqual(calls, []);
    assert.equal(report.problems[0].code, 'SQUAD_RUNTIME_NOT_FOUND');
    assert.match(report.problems[0].fix, /OMNI_FAKE_PATH/);
});

test('ready needs version, sign-in and models', async () => {
    const fsImpl = fakeFs({ '/bin/aa': '', '/bin/bb': '', '/bin/cc': '' });
    const registry = createRegistry({ runtimes: [
        fakeRuntime('aa'), fakeRuntime('bb', { auth: 'unauthenticated' }), fakeRuntime('cc', { models: false }),
    ] });
    const reports = await registry.probeAll({ platform: 'linux', env: {}, fsImpl });
    assert.deepEqual(reports.map((r) => [r.id, r.ready]), [['aa', true], ['bb', false], ['cc', false]]);
    assert.deepEqual(reports[1].problems.map((p) => [p.code, p.fix]), [['SQUAD_RUNTIME_UNAUTHENTICATED', 'log in']]);
});
