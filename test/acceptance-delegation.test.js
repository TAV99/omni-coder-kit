'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const gates = require('../lib/dual/approval-gates');
const { prepareAcceptanceProject } = require('./helpers/acceptance-project');
const { readyReports, registryWith } = require('./helpers/squad-project');
function api() {
    const file = path.join(__dirname, 'helpers/acceptance-delegation.js');
    assert.ok(fs.existsSync(file), 'explicit benchmark delegation helper must exist');
    return require(file);
}
async function fixture(t) {
    const prepared = await prepareAcceptanceProject({ config: 'B', taskIds: ['T01'],
        registry: registryWith(readyReports({ codexModels: ['gpt-6.1-sol', 'gpt-6-luna'], claudeModels: ['sonnet'] })) });
    t.after(() => fs.rmSync(prepared.container, { recursive: true, force: true }));
    const privateDir = path.join(prepared.container, 'private'); fs.mkdirSync(privateDir, { mode: 0o700 });
    const ref = api().createDelegation({ prepared, privateDir, deadline: Date.now() + 60000 });
    return { prepared, ref };
}

test('real acceptance wrapper serves health and shuts down without running any model', async t => {
    const {prepared,ref}=await fixture(t);
    const {spawnDaemon,createPoller}=require('./helpers/squad-live');
    const handle=spawnDaemon({root:prepared.root,logFile:path.join(prepared.container,'daemon.log'),
        entryPoint:path.join(__dirname,'acceptance-daemon.js'),argvPrefix:['--delegation',ref.path,'--sha256',ref.sha256]});
    try {
        await handle.waitUntilReady(createPoller(),10000);
        assert.equal((await handle.client.health()).status,'healthy');
        assert.equal(handle.authority.readEvents().length,0);
    } finally {await handle.stop();}
});

test('delegation is private, pinned to a fresh fixture, and rejects another workspace or tampering', async t => {
    const { prepared, ref } = await fixture(t), a = api();
    assert.equal(fs.statSync(ref.path).mode & 0o777, 0o600);
    const loaded = a.loadDelegation({ root: prepared.root, ...ref });
    assert.equal(loaded.protocol, 'benchmark-delegation-v1');
    assert.deepEqual(loaded.taskIds, ['T01']);
    assert.throws(() => a.loadDelegation({ root: process.cwd(), ...ref }), { code: 'ACCEPTANCE_DELEGATION_INVALID' });
    fs.appendFileSync(ref.path, ' ');
    assert.throws(() => a.loadDelegation({ root: prepared.root, ...ref }), { code: 'ACCEPTANCE_DELEGATION_INVALID' });
});

test('fresh wrapper refuses a previously started authority instead of silently adopting a manual run', async t => {
    const { prepared, ref } = await fixture(t);
    const dir = path.join(prepared.root, '.omni/runs/dual-authority'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'events.ndjson'), 'old authority\n');
    assert.throws(() => api().loadDelegation({ root: prepared.root, ...ref }), { code: 'ACCEPTANCE_DELEGATION_INVALID' });
});

test('fresh delegation rejects symlinked source parents even when fixture bytes match', async t => {
    const { prepared, ref } = await fixture(t);
    fs.renameSync(path.join(prepared.root,'lib'),path.join(prepared.root,'held-lib'));
    fs.symlinkSync(path.join(prepared.root,'held-lib'),path.join(prepared.root,'lib'),'dir');
    assert.throws(()=>api().loadDelegation({root:prepared.root,...ref}),{code:'ACCEPTANCE_DELEGATION_INVALID'});
});

test('existing gate seam records automatic decisions as test/test-harness, never human/TTY', async t => {
    const { prepared, ref } = await fixture(t), a = api();
    const delegation = a.loadDelegation({ root: prepared.root, ...ref });
    const store = createAuthorityStore(path.join(prepared.root, '.omni/runs/dual-authority'));
    store.append({ schema_version: 2, type: 'session.created', state: 'DISCOVERED', workspace_id: 'ws', session_id: 's',
        plan_revision: 1, expected_baseline: { kind: 'git', id: prepared.baselineCommit }, workspace_root: prepared.root, mode: 'auto' });
    store.append({ schema_version: 2, type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
        status: 'PASSED', checks: [{ name: 'unit', status: 'PASSED' }] });
    store.append({ schema_version: 2, type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
        plan_path: 'plans/plan.md', plan_sha256: prepared.planSha256, total_tasks: 1, tasks: delegation.contracts });
    gates.setTestApprover(a.createDelegatedApprover({ root: prepared.root, delegation, ref, authorityStore: store }));
    t.after(() => gates.setTestApprover(null));
    const result = gates.requireApproval(store, { phase: 'integrate', taskId: 'T01', digest: 'a'.repeat(64), summary: 'unit' });
    assert.equal(result.approved, true);
    assert.deepEqual([result.gate.actor, result.gate.via], ['test', 'test-harness']);
    assert.equal(store.verifyIntegrity().valid, true);
    assert.throws(() => gates.requireApproval(store, { phase: 'integrate', taskId: 'T02', digest: 'b'.repeat(64), summary: 'outside' }),
        { code: 'ACCEPTANCE_DELEGATION_SCOPE' });
});

test('expired delegation fails before granting any gate', async t => {
    const { prepared, ref } = await fixture(t), a = api();
    const delegation = a.loadDelegation({ root: prepared.root, ...ref });
    const approve = a.createDelegatedApprover({ root: prepared.root, delegation, ref,
        authorityStore: { derive: () => assert.fail('expired authority must not be consulted') },
        now: () => Date.parse(delegation.expiresAt) + 1 });
    assert.throws(() => approve({}), { code: 'ACCEPTANCE_DELEGATION_SCOPE' });
});

test('delegated decision validation checks provenance, time, phase, task identity and digest', () => {
    const a = api(), delegation = { protocol: 'benchmark-delegation-v1', id: 'id', artifactSha256: 'a'.repeat(64),
        createdAt: '2026-11-03T00:00:00Z', expiresAt: '2026-11-03T04:00:00Z', planRevision: 1,
        planSha256: 'b'.repeat(64), taskIds: ['T01'] };
    const gate = { phase: 'integrate', gate_id: 'integrate-T01', task_id: 'T01', digest: 'c'.repeat(64) };
    const decision = { type: 'gate.approved', actor: 'test', via: 'test-harness', timestamp: '2026-11-03T01:00:00Z', digest: gate.digest };
    assert.equal(a.isDelegatedDecision(gate, decision, delegation), true);
    assert.equal(a.isDelegatedDecision(gate, decision, undefined), false);
    assert.equal(a.isDelegatedDecision(gate, { ...decision, timestamp: '2026-11-03T05:00:00Z' }, delegation), false);
    assert.equal(a.isDelegatedDecision({ ...gate, task_id: 'T02' }, decision, delegation), false);
    assert.equal(a.isDelegatedDecision(gate, { ...decision, digest: 'd'.repeat(64) }, delegation), false);
    assert.equal(a.isDelegatedDecision(gate, decision, {...delegation,expiresAt:'2027-01-01T00:00:00Z'}), false);
    assert.equal(a.isDelegatedDecision({...gate,plan_revision:2},decision,delegation),false);
});
