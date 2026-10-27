'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const coverage = require('../lib/dual/spec-coverage');
const runtime = require('../lib/dual/coverage-runtime');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-coverage-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.omni/sdlc'), { recursive: true });
    const artifact = { schema_version: 1, catalog_version: 1, revision: 1, app_types: ['booking'], classification_sources: ['user:original'], dimensions: coverage.expandCatalog(['booking']).map(row => ({ id: row.id, state: 'pinned', value: row.examples[0], sources: [{ kind: 'user', ref: 'user:original' }] })) };
    const plan = { schema_version: 2, plan_revision: 1, coverage: { path: '.omni/sdlc/spec-coverage.json', sha256: coverage.digest(JSON.stringify(artifact)), catalog_version: 1 }, acceptance_policy: { protocol_version: 1, checks: [{ id: 'old', requirement_id: 'old', phase: 'session', kind: 'command', required: true, command: { program: 'node', args: ['--version'], cwd: '.' } }] }, tasks: [{ task_id: 'TASK-A', title: 'Booking', goal: 'Booking', owner: 'agy', category: 'frontend', complexity: 'medium', risk: 'low', allowed_files: ['app.js'], context_files: [], deny_patterns: [], validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }], decision_ids: artifact.dimensions.map(row => row.id) }] };
    fs.writeFileSync(path.join(root, plan.coverage.path), JSON.stringify(artifact));
    fs.writeFileSync(path.join(root, '.omni/sdlc/dual-plan.json'), JSON.stringify({ schema_version: 1 }));
    const context = { plan, session_id: 's', workspace: 'w', revision_id: 'rev-1', attempt: 1, task_id: 'TASK-A', contract_digest: coverage.digest('contract') };
    const request = { request_id: 'approval-1', actor: 'user', source: 'user:approval', session_id: 's', workspace: 'w', candidate_digest: coverage.digest(artifact), plan_revision: 1, decisions: [] };
    return { root, artifact, plan, context, request };
}
test('revision cannot execute using legacy parent or missing candidate v2', t => {
    const f = fixture(t);
    assert.throws(() => runtime.assertRuntimeCoverage(f.root, { revision_id: 'rev', attempt: 1, derived: { plan: { schema_version: 1 } } }), { code: 'SPEC_COVERAGE_REQUIRED' });
    assert.equal(coverage.evaluateGate({ plan: { schema_version: 1 }, revision_id: 'rev' }).allowed, false);
});
test('revision approvals are isolated, immutable and bind candidate identity', t => {
    const f = fixture(t), store = new coverage.CoverageStore(f.root);
    const parentPath = path.join(f.root, '.omni/sdlc/spec-coverage.receipt.json');
    fs.writeFileSync(parentPath, 'parent receipt bytes');
    const result = store.approve(f.request, f.context);
    assert.equal(result.receipt.revision_id, 'rev-1');
    assert.equal(store.inspect(f.context).state, 'PASSED');
    assert.equal(fs.readFileSync(parentPath, 'utf8'), 'parent receipt bytes');
    assert.equal(store.inspect({ ...f.context, receipt: result.receipt, attempt: 2 }).state, 'STALE');
    assert.equal(store.inspect({ ...f.context, receipt: result.receipt, contract_digest: coverage.digest('other') }).state, 'STALE');
    assert.deepEqual(store.approve(f.request, f.context), result);
});
test('semantic carry-forward requires equal full contract and audits old receipt', t => {
    const f = fixture(t), store = new coverage.CoverageStore(f.root);
    const previous = store.approve(f.request, f.context).receipt;
    const context = { ...f.context, revision_id: 'rev-2', parent_receipt: previous, parent_plan: f.plan };
    const request = { ...f.request, request_id: 'carry-2', expected_semantic_digest: previous.semantic_digest };
    const result = coverage.carryForwardRevisionCoverage(f.root, request, context);
    assert.equal(result.receipt.carried_forward_receipt_digest, coverage.digest(previous));
    assert.equal(result.receipt.revision_id, 'rev-2');
    const changed = structuredClone(f.plan); changed.tasks[0].allowed_files.push('other.js');
    assert.throws(() => coverage.carryForwardRevisionCoverage(f.root, { ...request, request_id: 'carry-3' }, { ...context, revision_id: 'rev-3', plan: changed }), { code: 'SEMANTIC_APPROVAL_REQUIRED' });
});
test('semantic reapproval uses digest CAS and preserves superseded receipt history', t => {
    const f = fixture(t), store = new coverage.CoverageStore(f.root);
    const previous = store.approve(f.request, f.context).receipt;
    const context = { ...f.context, revision_id: 'rev-2', parent_receipt: previous, parent_plan: f.plan };
    assert.throws(() => store.approve({ ...f.request, request_id: 'delta', expected_semantic_digest: 'stale' }, context), { code: 'STALE_COVERAGE' });
    const next = store.approve({ ...f.request, request_id: 'delta', expected_semantic_digest: previous.semantic_digest }, context);
    assert.equal(next.receipt.supersedes_receipt_digest, coverage.digest(previous));
});
test('scoped runtime derives candidate coverage and requires fresh revision reconnaissance', t => {
    const f = fixture(t);
    const derived = { plan: { schema_version: 1 }, revisionContext: f.context };
    assert.equal(runtime.inspectRuntimeCoverage(f.root, { derived }).state, 'DRAFT');
    const directory = coverage.revisionCoverageDirectory(f.root, f.context);
    fs.mkdirSync(directory, { recursive: true });
    const contextPath = path.relative(f.root, path.join(directory, 'context.json'));
    const context = JSON.stringify({ task_id: 'TASK-A', coverage_findings: [] });
    fs.writeFileSync(path.join(f.root, contextPath), context);
    const record = JSON.stringify({ plan_sha256: coverage.digest(JSON.stringify(f.plan)), baseline: null, task_ids: ['TASK-A'], contexts: [{ path: contextPath, sha256: coverage.digest(context) }] });
    fs.writeFileSync(path.join(directory, 'spec-coverage.reconnaissance.json'), record);
    new coverage.CoverageStore(f.root).approve(f.request, { ...f.context, reconnaissance_digest: coverage.digest(record) });
    assert.equal(runtime.assertRuntimeCoverage(f.root, { derived, plan: { schema_version: 1 } }).state, 'PASSED');
    fs.writeFileSync(path.join(f.root, contextPath), JSON.stringify({ task_id: 'TASK-A', coverage_findings: [], changed: true }));
    assert.throws(() => runtime.assertRuntimeCoverage(f.root, { derived }), { code: 'SPEC_COVERAGE_REQUIRED' });
});
test('revision gate rejects incomplete authority and semantic task scope drift', t => {
    const f = fixture(t), store = new coverage.CoverageStore(f.root);
    const receipt = store.approve(f.request, f.context).receipt;
    assert.equal(coverage.evaluateGate({ plan: f.plan, artifact: f.artifact, receipt: { ...receipt, attempt: undefined, task_id: undefined, contract_digest: undefined }, revision_id: f.context.revision_id }).allowed, false);
    const changed = structuredClone(f.plan); changed.tasks[0].allowed_files.push('other.js');
    assert.equal(store.inspect({ ...f.context, plan: changed }).state, 'STALE');
});
