'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { inspectRuntimeCoverage, assertRuntimeCoverage } = require('../lib/dual/coverage-runtime');
const { createDualOrchestrator } = require('../lib/dual/orchestrator');

function root(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-runtime-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, '.omni/sdlc'), { recursive: true });
    return dir;
}
function save(dir, file, value) { fs.writeFileSync(path.join(dir, file), JSON.stringify(value)); }

test('legacy direct plans retain an explicit unchecked warning', (t) => {
    const dir = root(t);
    save(dir, '.omni/sdlc/dual-plan.json', { schema_version: 1 });
    const gate = assertRuntimeCoverage(dir);
    assert.equal(gate.state, 'LEGACY_UNCHECKED');
    assert.match(gate.warning, /LEGACY_UNCHECKED/);
});

test('malformed v2 cannot downgrade and direct implement is blocked before launch', async (t) => {
    const dir = root(t);
    save(dir, '.omni/sdlc/dual-plan.json', { schema_version: 2 });
    let launched = 0;
    const initialSnapshot = require('../lib/dual/snapshot-policy').createConfiguredSnapshotBaseline({ root: dir }).baseline.capture();
    const orchestrator = createDualOrchestrator({ cwd: dir, backend: 'snapshot', initialSnapshot, workerModel: 'test-model', workerEffort: 'high',
        processRunner: async () => { launched++; throw new Error('must not launch'); } });
    orchestrator.newTask('TASK-COVERAGE');
    await assert.rejects(orchestrator.runPhase('implement', 'TASK-COVERAGE'), (error) => error.code === 'SPEC_COVERAGE_REQUIRED');
    assert.equal(launched, 0);
    assert.equal(inspectRuntimeCoverage(dir).state, 'INVALID');
});

test('retry and resume re-read current registered v2 plan binding', (t) => {
    const dir = root(t);
    const file = '.omni/sdlc/registered.json';
    save(dir, file, { schema_version: 2 });
    const original = fs.readFileSync(path.join(dir, file));
    const derived = { plan: { schema_version: 2, plan_path: file, plan_sha256: crypto.createHash('sha256').update(original).digest('hex') } };
    assert.equal(inspectRuntimeCoverage(dir, { derived }).state, 'INVALID');
    save(dir, file, { schema_version: 2, plan_revision: 2 });
    assert.throws(() => assertRuntimeCoverage(dir, { derived }), (error) => error.code === 'SPEC_COVERAGE_REQUIRED' && error.details.state === 'STALE');
});

test('all-task reconnaissance barrier blocks preapproval until every context is bound', (t) => {
    const dir = root(t);
    const { expandCatalog, digest } = require('../lib/dual/spec-coverage');
    const artifact = { schema_version: 1, catalog_version: 1, revision: 1, app_types: ['booking'],
        classification_sources: ['user:request'], dimensions: expandCatalog(['booking']).map((d) => ({ id: d.id, state: 'unresolved', sources: [] })) };
    save(dir, '.omni/sdlc/spec-coverage.json', artifact);
    const plan = { schema_version: 2, plan_revision: 1, coverage: { path: '.omni/sdlc/spec-coverage.json', sha256: digest(JSON.stringify(artifact)), catalog_version: 1 },
        acceptance_policy: { protocol_version: 1, checks: [{ id: 'accept-1', requirement_id: 'requirement-1', phase: 'session', kind: 'command', required: true, command: { program: 'node', args: ['--version'], cwd: '.' } }] },
        tasks: ['TASK-A', 'TASK-B'].map((task_id) => ({ task_id, title: 'Booking', owner: 'agy', goal: 'Implement booking', category: 'frontend', complexity: 'medium', risk: 'low', execution_mode: 'isolated', allowed_files: ['src/booking.js'], context_files: [], deny_patterns: [], validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }], decision_ids: [] })) };
    save(dir, '.omni/sdlc/dual-plan.json', plan);
    assert.equal(inspectRuntimeCoverage(dir).state, 'DRAFT');
    const contexts = plan.tasks.map((task) => {
        const file = `.omni/sdlc/${task.task_id}.context.json`;
        save(dir, file, { task_id: task.task_id, coverage_findings: [] });
        return { path: file, sha256: digest(fs.readFileSync(path.join(dir, file))) };
    });
    save(dir, '.omni/sdlc/spec-coverage.reconnaissance.json', { plan_sha256: digest(JSON.stringify(plan)), baseline: 'base', task_ids: ['TASK-A', 'TASK-B'], contexts });
    assert.equal(inspectRuntimeCoverage(dir).state, 'AWAITING_APPROVAL');
    save(dir, contexts[1].path, { task_id: 'TASK-B', coverage_findings: [{ dimension_id: 'custom.new', reason: 'New product choice' }] });
    assert.equal(inspectRuntimeCoverage(dir).state, 'DRAFT');
    contexts[1].sha256 = digest(fs.readFileSync(path.join(dir, contexts[1].path)));
    save(dir, '.omni/sdlc/spec-coverage.reconnaissance.json', { plan_sha256: digest(JSON.stringify(plan)), baseline: 'base', task_ids: ['TASK-A', 'TASK-B'], contexts });
    assert.equal(inspectRuntimeCoverage(dir).state, 'STALE');
});

function approvedFixture(t) {
    const dir = root(t);
    const { expandCatalog, digest } = require('../lib/dual/spec-coverage');
    const artifact = { schema_version: 1, catalog_version: 1, revision: 1, app_types: ['booking'], classification_sources: ['user:initial'],
        dimensions: expandCatalog(['booking']).map((d) => ({ id: d.id, state: 'pinned', value: d.examples[0], sources: [{ kind: 'user', ref: 'user:initial' }] })) };
    const edit = artifact.dimensions.find((row) => row.id === 'actions.edit');
    edit.state = 'delegated'; delete edit.value; edit.constraints = ['Keep existing records'];
    const copy = artifact.dimensions.find((row) => row.id === 'ui.copy');
    copy.state = 'not_applicable'; delete copy.value; copy.reason = 'API only';
    save(dir, '.omni/sdlc/spec-coverage.json', artifact);
    const task = { task_id: 'TASK-A', title: 'API', owner: 'agy', goal: 'Implement API', category: 'backend', complexity: 'medium', risk: 'low', allowed_files: ['src/api.js'], context_files: [], deny_patterns: [], validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }], decision_ids: ['actions.edit', 'actions.delete', 'ui.copy'] };
    const plan = { schema_version: 2, plan_revision: 1, coverage: { path: '.omni/sdlc/spec-coverage.json', sha256: digest(JSON.stringify(artifact)), catalog_version: 1 }, acceptance_policy: { protocol_version: 1, checks: [{ id: 'accept-1', requirement_id: 'requirement-1', phase: 'session', kind: 'command', required: true, command: { program: 'node', args: ['--version'], cwd: '.' } }] }, tasks: [task] };
    save(dir, '.omni/sdlc/dual-plan.json', plan);
    const context = '.omni/sdlc/scout.json'; save(dir, context, { task_id: 'TASK-A', coverage_findings: [] });
    save(dir, '.omni/sdlc/spec-coverage.reconnaissance.json', { plan_sha256: digest(JSON.stringify(plan)), baseline: 'base', task_ids: ['TASK-A'], contexts: [{ path: context, sha256: digest(fs.readFileSync(path.join(dir, context))) }] });
    const gate = inspectRuntimeCoverage(dir);
    new (require('../lib/dual/spec-coverage').CoverageStore)(dir).approve({ request_id: 'user-approval', actor: 'user', source: 'message:1', session_id: 'session-1', workspace: 'workspace-1', candidate_digest: digest(artifact), plan_revision: 1, decisions: artifact.dimensions.map(({ sources, ...decision }) => decision) }, { baseline: null, reconnaissance_digest: gate.reconnaissance_digest });
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, '.omni/sdlc/spec-coverage.receipt.json'), 'utf8'));
    const runDir = path.join(dir, '.omni/runs/TASK-A'); fs.mkdirSync(runDir, { recursive: true });
    const passed = assertRuntimeCoverage(dir);
    fs.writeFileSync(path.join(runDir, 'coverage-input.json'), JSON.stringify({ candidate_digest: passed.candidate_digest, receipt }));
    fs.writeFileSync(path.join(runDir, 'decision-log.json'), JSON.stringify([{ dimension_id: 'actions.edit', chosen_value: { enabled: true, behavior: 'Allow editing labels' }, rationale: 'Explicitly delegated', evidence_refs: ['src/api.js:10'] }]));
    const review = { schema_version: 2, coverage_findings: [], coverage_checks: ['actions.delete', 'ui.copy'].map((dimension_id) => ({ dimension_id, satisfied: true, description: 'Verified against approved value/exclusion', evidence_refs: ['src/api.js:10'] })), constraint_findings: [{ dimension_id: 'actions.edit', constraint: 'Keep existing records', satisfied: true, evidence_ref: 'src/api.js:10' }] };
    fs.writeFileSync(path.join(runDir, 'review.json'), JSON.stringify(review));
    return { dir, runDir, receipt, review };
}

test('final QC accepts valid delegated choice with independent pinned/N/A checks and constraint evidence', (t) => {
    const { assertRuntimeCoverageReview } = require('../lib/dual/coverage-runtime');
    const f = approvedFixture(t);
    assert.equal(assertRuntimeCoverageReview(f.dir, f.runDir, 'TASK-A').state, 'PASSED');
});

test('final QC rejects missing prose constraint finding, unsatisfied N/A and changed attempt binding', (t) => {
    const { assertRuntimeCoverageReview } = require('../lib/dual/coverage-runtime');
    const f = approvedFixture(t);
    const check = () => assertRuntimeCoverageReview(f.dir, f.runDir, 'TASK-A');
    const original = structuredClone(f.review);
    f.review.constraint_findings = [];
    fs.writeFileSync(path.join(f.runDir, 'review.json'), JSON.stringify(f.review));
    assert.throws(check, { code: 'SPEC_COVERAGE_REQUIRED' });
    const contradictory = structuredClone(original);
    contradictory.constraint_findings.push({ ...contradictory.constraint_findings[0], satisfied: false });
    fs.writeFileSync(path.join(f.runDir, 'review.json'), JSON.stringify(contradictory));
    assert.throws(check, { code: 'SPEC_COVERAGE_REQUIRED' });
    original.coverage_checks[1].satisfied = false;
    fs.writeFileSync(path.join(f.runDir, 'review.json'), JSON.stringify(original));
    assert.throws(check, { code: 'SPEC_COVERAGE_REQUIRED' });
    fs.writeFileSync(path.join(f.runDir, 'coverage-input.json'), JSON.stringify({ candidate_digest: 'changed', receipt: f.receipt }));
    assert.throws(check, { code: 'SPEC_COVERAGE_REQUIRED' });
});

test('headless pending adapter returns structured non-success without acquiring execution lease', async (t) => {
    const { createOrchestratorAdapter } = require('../lib/dual/orchestrator-adapter');
    const f = approvedFixture(t);
    fs.unlinkSync(path.join(f.dir, '.omni/sdlc/spec-coverage.receipt.json'));
    let leases = 0;
    let launches = 0;
    const derived = { tasks: { 'TASK-A': { task_id: 'TASK-A', owner: 'agy', state: 'ROUTED' } } };
    const adapter = createOrchestratorAdapter({ workspaceRoot: f.dir, operationWriter: {}, authorityStore: { derive: () => derived, acquireLease() { leases++; } }, processRunner: async () => { launches++; } });
    const result = await adapter.runTask(derived);
    assert.equal(result[0].code, 'SPEC_COVERAGE_REQUIRED');
    assert.equal(result[0].state, 'AWAITING_APPROVAL');
    assert.equal(leases, 0);
    assert.equal(launches, 0);
});

test('legacy authority prose plans do not acquire coverage hash or file requirements', (t) => {
    const dir = root(t);
    const derived = { plan: { plan_path: 'spec.md', plan_sha256: 'b'.repeat(64) } };
    fs.writeFileSync(path.join(dir, 'spec.md'), 'Legacy approved task scope.\n');
    assert.equal(assertRuntimeCoverage(dir, { derived }).state, 'LEGACY_UNCHECKED');
    derived.plan.plan_path = '.omni/plan.json';
    assert.equal(assertRuntimeCoverage(dir, { derived }).state, 'LEGACY_UNCHECKED');
    derived.plan.schema_version = 2;
    assert.throws(() => assertRuntimeCoverage(dir, { derived }), { code: 'SPEC_COVERAGE_REQUIRED' });
});
