'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadRoles } = require('../lib/squad/roles');
const {
    parseBinding, readBinding, writeBinding, readUserDefaults, writeUserDefaults,
    checkBinding, engineSupport, legacyManifestFields,
} = require('../lib/squad/bindings');
const { defaultRegistry } = require('../lib/squad/runtimes');
const { tempDir, readyReports } = require('./helpers/squad-project');

const roles = loadRoles(path.join(__dirname, '..', 'templates', 'squad', 'roles'));
const dual = (worker = { id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }, orchestrator = { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' }) => ({
    schema_version: 1, preset: 'dual', roles: { orchestrator, worker: [worker], reviewer: null }, updated_at: '2026-11-01T00:00:00Z',
});

test('preset shape is enforced', () => {
    assert.doesNotThrow(() => parseBinding(dual()));
    const two = dual();
    two.roles.worker.push({ id: 'worker-2', runtime: 'agy', model: 'x' });
    assert.throws(() => parseBinding(two), /preset dual needs 1\.\.1 workers/);
    assert.throws(() => parseBinding({ ...dual(), roles: { ...dual().roles, reviewer: { runtime: 'codex', model: 'm' } } }), /has no reviewer/);
    assert.throws(() => parseBinding({ ...dual(), extra: 1 }), { code: 'SQUAD_BINDING_INVALID' });
});

test('local binding and user defaults round-trip', (t) => {
    const root = tempDir(t, 'squad-bind-');
    const home = tempDir(t, 'squad-home-');
    assert.equal(readBinding(root), null);
    writeBinding(root, dual());
    assert.equal(readBinding(root).roles.worker[0].model, 'gemini-3.8-flash-high');
    writeUserDefaults(home, parseBinding(dual()));
    assert.equal(readUserDefaults(home).dual.orchestrator.runtime, 'codex');
});

test('check: unknown runtime, model not offered, wrong effort, missing capability', () => {
    const reports = readyReports();
    const check = (binding) => checkBinding(parseBinding(binding), { roles, registry: defaultRegistry, reports }).errors.map((e) => e.message);
    assert.deepEqual(check(dual()), []);
    assert.match(check(dual({ id: 'worker-1', runtime: 'ghost', model: 'm' }))[0], /unknown runtime "ghost"/);
    assert.match(check(dual({ id: 'worker-1', runtime: 'agy', model: 'gemini-9' }))[0], /not offered by agy/);
    assert.match(check(dual({ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high', effort: 'low' }))[0], /not valid.*\(high\)/);
    assert.match(check(dual({ id: 'worker-1', runtime: 'agy', model: 'claude-sonnet-4-6', effort: 'high' }))[0], /no effort setting/);
});

test('D18 warnings: shared account and same-family QC', () => {
    const shared = dual({ id: 'worker-1', runtime: 'codex', model: 'gpt-6.1-sol' });
    const warnings = checkBinding(parseBinding(shared), { roles, registry: defaultRegistry, reports: readyReports() }).warnings.map((w) => w.code);
    assert.ok(warnings.includes('SQUAD_SHARED_ACCOUNT'));
    const squad = { ...dual(), preset: 'squad', roles: { ...dual().roles, reviewer: { runtime: 'agy', model: 'gemini-3.8-flash-high' } } };
    const qc = checkBinding(parseBinding(squad), { roles, registry: defaultRegistry, reports: readyReports() }).warnings.map((w) => w.code);
    assert.ok(qc.includes('SQUAD_QC_SAME_FAMILY_AS_WORKER'));
});

test('engine support and legacy manifest fields', () => {
    assert.deepEqual(engineSupport(parseBinding(dual())), { supported: true, reasons: [] });
    assert.ok(!engineSupport(parseBinding(dual({ id: 'worker-1', runtime: 'codex', model: 'gpt-6.1-sol' }))).supported);
    // Since H7 (P3c-1) dual runs agy Claude models without --effort.
    assert.deepEqual(engineSupport(parseBinding(dual({ id: 'worker-1', runtime: 'agy', model: 'claude-sonnet-4-6' }))), { supported: true, reasons: [] });
    assert.deepEqual(legacyManifestFields(parseBinding(dual()), readyReports()),
        { workerModel: 'gemini-3.8-flash-high', workerEffort: 'high' }, 'effort comes from the model suffix');
    const claude = legacyManifestFields(parseBinding(dual({ id: 'worker-1', runtime: 'agy', model: 'claude-sonnet-4-6' })), readyReports());
    assert.deepEqual(JSON.parse(JSON.stringify({ workerModel: 'old', workerEffort: 'high', ...claude })), { workerModel: 'claude-sonnet-4-6' },
        'a stale effort is cleared');
});
