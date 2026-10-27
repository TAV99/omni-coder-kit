'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reduceRevisionEvent, revisionDigest, currentVerifiedVersion } = require('../lib/dual/revision-policy');
const { revisionSourceFingerprint } = require('../lib/dual/task-revision-integration');
function fixture(t) {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-rpc-'));
    t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
    fs.writeFileSync(path.join(workspaceRoot, 'app.js'), 'module.exports = 1;\n');
    const source_fingerprint = revisionSourceFingerprint(workspaceRoot);
    const task = { task_id: 'task-1', state: 'TASK_VERIFIED', owner: 'agy', allowed_files: ['app.js'],
        current_verified_version: { version_id: revisionDigest('parent'), source_fingerprint } };
    const derived = { sessionId: 'session-1', sessionState: 'ACCEPTANCE', planRevision: 1, workspaceId: 'workspace-1',
        sequence: 0, tasks: { 'task-1': task }, leases: {}, gates: {}, plan: { schema_version: 1 } };
    const events = [];
    const authorityStore = { directory: path.join(workspaceRoot, '.omni/runs/dual-authority'),
        derive: () => derived, readEvents: () => events,
        verifyIntegrity: () => ({ lastSequence: events.length }),
        append(event) {
            const full = { schema_version: 2, session_id: 'session-1', plan_revision: 1, sequence: events.length + 1, ...event };
            reduceRevisionEvent(task, full, { tasks: derived.tasks, sessionState: derived.sessionState, sessionId: derived.sessionId,
                planRevision: 1, leases: derived.leases, gates: derived.gates,
                activeAcceptanceCorrection: derived.active_acceptance_correction,
                verifySourceFingerprint: fingerprint => fingerprint === revisionSourceFingerprint(workspaceRoot) });
            events.push(full); derived.sequence = events.length; return full;
        } };
    const contract = { schema_version: 2, reason: 'Change value', allowed_files: ['app.js'], affected_dimensions: ['content'],
        acceptance_criteria: ['Export two'], validation_commands: [{ program: 'node', args: ['--check', 'app.js'], cwd: '.' }],
        parent_version_id: currentVerifiedVersion(task).version_id, source_fingerprint, changes: 'files', dependency_contract_changed: false };
    const contract_sha256 = revisionDigest(contract);
    const common = { session_id: derived.sessionId, task_id: task.task_id, revision_id: 'revision-1' };
    const approval = { approved_by: 'user', grant_id: 'grant-1', revision_id: common.revision_id,
        parent_version_id: contract.parent_version_id, contract_sha256, source_fingerprint };
    const params = { ...common, request_id: 'request-1', expected_sequence: 0, parent_version_id: contract.parent_version_id,
        source_fingerprint, contract, contract_sha256, approval };
    const calls = [];
    const invoke = async (method, input) => require('../lib/dual/task-revision').revisionRpc({ method,
        params: input, authorityStore, workspaceRoot, dispatch: async (...args) => { calls.push(args); } });
    const start = () => ({ ...common, expected_sequence: events.length, parent_version_id: contract.parent_version_id,
        source_fingerprint, contract_sha256, grant_id: approval.grant_id });
    return { workspaceRoot, task, derived, events, authorityStore, params, common, invoke, start, calls };
}
test('revision RPC request replay preserves lifetime and binds request payload', async t => {
    const f = fixture(t);
    await f.invoke('dual.task.revision.request', f.params);
    await f.invoke('dual.task.revision.request', f.params);
    assert.equal(f.task.revision_requests.length, 1);
    assert.equal(f.task.revisions_started || 0, 0);
    assert.equal(f.task.state, 'TASK_VERIFIED');
    await assert.rejects(f.invoke('dual.task.revision.request', { ...f.params, approval: { ...f.params.approval, grant_id: 'other-grant' } }));
});
test('revision RPC start consumes one slot and stale fingerprint never dispatches', async t => {
    const f = fixture(t);
    await f.invoke('dual.task.revision.request', f.params);
    fs.writeFileSync(path.join(f.workspaceRoot, 'app.js'), 'drift');
    await assert.rejects(f.invoke('dual.task.revision.start', f.start()));
    assert.equal(f.task.revisions_started || 0, 0);
    assert.equal(f.calls.length, 0);
});
test('revision RPC rejects wrong session, candidate identity and unapproved contract', async t => {
    const f = fixture(t);
    await assert.rejects(f.invoke('dual.task.revision.request', { ...f.params, session_id: 'other-session' }));
    await assert.rejects(f.invoke('dual.task.revision.request', { ...f.params, approval: { ...f.params.approval, approved_by: 'controller' } }));
    await f.invoke('dual.task.revision.request', f.params);
    await assert.rejects(f.invoke('dual.task.revision.start', { ...f.start(), revision_id: 'other-revision' }));
    assert.equal(f.calls.length, 0);
});
test('revision RPC cancellation preserves current verified parent and exposes terminal status', async t => {
    const f = fixture(t), parent = f.task.current_verified_version;
    await f.invoke('dual.task.revision.request', f.params);
    await f.invoke('dual.task.revision.cancel', { ...f.common, reason: 'User cancelled' });
    assert.equal(f.task.active_revision.state, 'CANCELLED');
    assert.equal(f.task.current_verified_version, parent);
    assert.equal(f.task.revisions_started || 0, 0);
    const status = await f.invoke('dual.task.revision.status', f.common);
    assert.ok(JSON.stringify(status).includes('CANCELLED'));
});
test('revision RPC cannot promote a requested candidate or stale parent', async t => {
    const f = fixture(t);
    await f.invoke('dual.task.revision.request', f.params);
    await assert.rejects(f.invoke('dual.task.revision.promote', { ...f.common, expected_sequence: f.events.length,
        parent_version_id: revisionDigest('other-parent'), candidate_sha256: revisionDigest('candidate') }));
    assert.equal(f.task.current_verified_version.version_id, f.params.parent_version_id);
    assert.equal(f.task.active_revision.state, 'REQUESTED');
});
test('revision RPC replay rejects changed contract bytes even with original supplied digest', async t => {
    const f = fixture(t);
    await f.invoke('dual.task.revision.request', f.params);
    await assert.rejects(f.invoke('dual.task.revision.request', { ...f.params, contract: { ...f.params.contract, reason: 'Different change' } }));
});
test('revision RPC start from v1 parent requires an independently pinned v2 candidate', async t => {
    const f = fixture(t);
    await f.invoke('dual.task.revision.request', f.params);
    await assert.rejects(f.invoke('dual.task.revision.start', f.start()), { code: 'SPEC_COVERAGE_REQUIRED' });
    assert.equal(f.task.revisions_started || 0, 0);
    assert.equal(f.calls.length, 0);
});
test('revision RPC approved v2 start and retry consume exactly one slot and one dispatch', async t => {
    const f = fixture(t);
    const coverage = require('../lib/dual/spec-coverage');
    const artifact = { schema_version: 1, catalog_version: 1, revision: 1, app_types: ['booking'], classification_sources: ['user:original'],
        dimensions: coverage.expandCatalog(['booking']).map(row => ({ id: row.id, state: 'pinned', value: row.examples[0], sources: [{ kind: 'user', ref: 'user:original' }] })) };
    const plan = { schema_version: 2, plan_revision: 1,
        coverage: { path: path.relative(f.workspaceRoot, path.join(coverage.revisionCoverageDirectory(f.workspaceRoot, { revision_id: f.common.revision_id, attempt: 1 }), 'candidate-coverage.json')), sha256: coverage.digest(JSON.stringify(artifact)), catalog_version: 1 },
        acceptance_policy: { protocol_version: 1, checks: [{ id: 'accept', requirement_id: 'accept', phase: 'session', kind: 'command', required: true, command: { program: 'node', args: ['--version'], cwd: '.' } }] },
        tasks: [{ task_id: 'task-1', title: 'Update', goal: 'Export two', owner: 'agy', category: 'backend', complexity: 'low', risk: 'low', allowed_files: ['app.js'], context_files: [], deny_patterns: [], validation_commands: f.params.contract.validation_commands, decision_ids: artifact.dimensions.map(row => row.id) }] };
    const normalizedPlan = require('../lib/dual/contracts').DualPlanManifestV2Schema.parse(plan);
    f.params.contract = { ...f.params.contract, candidate_plan: normalizedPlan };
    f.params.contract_sha256 = revisionDigest(f.params.contract);
    f.params.approval = { ...f.params.approval, contract_sha256: f.params.contract_sha256 };
    const context = { revision_id: f.common.revision_id, attempt: 1, task_id: f.common.task_id,
        contract_digest: f.params.contract_sha256, plan: normalizedPlan, session_id: f.common.session_id, workspace: f.derived.workspaceId };
    const directory = coverage.revisionCoverageDirectory(f.workspaceRoot, context);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(f.workspaceRoot, plan.coverage.path), JSON.stringify(artifact));
    const contextPath = path.relative(f.workspaceRoot, path.join(directory, 'context.json'));
    const contextBytes = JSON.stringify({ task_id: 'task-1', coverage_findings: [] });
    fs.writeFileSync(path.join(f.workspaceRoot, contextPath), contextBytes);
    const recon = JSON.stringify({ plan_sha256: coverage.digest(JSON.stringify(normalizedPlan)), baseline: null, task_ids: ['task-1'], contexts: [{ path: contextPath, sha256: coverage.digest(contextBytes) }] });
    fs.writeFileSync(path.join(directory, 'spec-coverage.reconnaissance.json'), recon);
    new coverage.CoverageStore(f.workspaceRoot).approve({ request_id: 'approve-coverage', actor: 'user', source: 'user:approval',
        session_id: f.common.session_id, workspace: f.derived.workspaceId, candidate_digest: coverage.digest(artifact), plan_revision: 1, decisions: [] },
    { ...context, reconnaissance_digest: coverage.digest(recon) });
    await f.invoke('dual.task.revision.request', f.params);
    const start = { ...f.start(), contract_sha256: f.params.contract_sha256 };
    await f.invoke('dual.task.revision.start', start);
    await f.invoke('dual.task.revision.start', start);
    assert.equal(f.task.revisions_started, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.task.state, 'TASK_VERIFIED');
    assert.equal(f.task.active_revision.state, 'EXECUTING');
    await f.invoke('dual.task.revision.cancel', { ...f.common, reason: 'Stop' });
    assert.equal(f.task.revisions_started, 1);
    assert.equal(f.task.active_revision.state, 'CANCELLED');
});
