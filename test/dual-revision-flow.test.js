'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { revisionDigest, revisionRequestDigest, currentVerifiedVersion } = require('../lib/dual/revision-policy');
const { revisionSourceFingerprint, prepareRevisionWorkspace, reconcileRevisionPromotions } = require('../lib/dual/task-revision-integration');
const { collectTaskResult } = require('../lib/dual/task-workspace');
const { runRevisionChecks, revisionRpc } = require('../lib/dual/task-revision');
const command = source => ({ program: 'node', args: ['-e', source], cwd: '.' });
function fixture(t, { mutatingCheck = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-controller-flow-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 1;\n');
    const store = createAuthorityStore(path.join(root, '.omni/runs/dual-authority'));
    store.append({ type: 'session.created', state: 'DISCOVERED', workspace_root: root,
        workspace_id: 'workspace', session_id: 'session', plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) }, mode: 'auto' });
    store.append({ type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE', status: 'PASSED',
        checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }], details: { agy_model: 'test-model', agy_version: '1.1.27' } });
    const oldCommand = command("require('node:assert/strict').equal(typeof require('./app.js'), 'number')");
    const acceptanceCommand = command("require('node:assert/strict').ok(require('./app.js') > 0)");
    const newCommand = command(mutatingCheck ? "require('node:fs').writeFileSync('app.js', 'module.exports = 3;\\n')" : "require('node:assert/strict').equal(require('./app.js'), 2)");
    const policy = { protocol_version: 1, checks: [{ id: 'old-session', requirement_id: 'old-req', phase: 'session',
        kind: 'command', required: true, command: acceptanceCommand }] };
    const planTask = { task_id: 'task', title: 'Export number', goal: 'Export number', owner: 'agy', category: 'backend',
        complexity: 'medium', risk: 'low', allowed_files: ['app.js'], context_files: [], deny_patterns: [],
        validation_commands: [oldCommand], decision_ids: [] };
    store.append({ type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED', plan_path: 'plan.json',
        plan_sha256: revisionDigest('plan'), total_tasks: 1, tasks: [planTask], acceptance_policy: policy });
    store.append({ type: 'task.routed', task_id: 'task', owner: 'agy', authority_state: 'ROUTED', model: 'test-model',
        effort: 'high', allowed_files: ['app.js'], reason: 'test' });
    const lease = store.acquireLease('task', 'agy');
    store.append({ type: 'task.completed', task_id: 'task', owner: 'agy', authority_state: 'TASK_VERIFIED',
        modified_files: ['app.js'], diff_fingerprint: revisionDigest('verified-parent'), verdict: 'SUCCESS', verified_by: 'codex' });
    store.releaseLease(lease.lease_id, 'parent completed');
    const parent = store.derive().tasks.task;
    const parentVersion = currentVerifiedVersion(parent);
    const sourceFingerprint = revisionSourceFingerprint(root);
    const candidatePlan = { schema_version: 2, plan_revision: 1,
        coverage: { path: 'coverage.json', sha256: revisionDigest('coverage'), catalog_version: 1 },
        acceptance_policy: policy, tasks: [planTask] };
    const contract = { schema_version: 2, reason: 'Export two', allowed_files: ['app.js'], affected_dimensions: ['content'],
        acceptance_criteria: ['Exports two'], validation_commands: [newCommand], parent_version_id: parentVersion.version_id,
        source_fingerprint: sourceFingerprint, changes: 'files', dependency_contract_changed: false, candidate_plan: candidatePlan };
    const request = { type: 'task.revision.requested', task_id: 'task', revision_id: 'revision', request_id: 'request',
        expected_sequence: store.verifyIntegrity().lastSequence, parent_version_id: parentVersion.version_id,
        source_fingerprint: sourceFingerprint, contract, contract_sha256: revisionDigest(contract) };
    request.approval = { approved_by: 'user', grant_id: 'grant', revision_id: 'revision', parent_version_id: request.parent_version_id,
        contract_sha256: request.contract_sha256, source_fingerprint: sourceFingerprint };
    request.request_sha256 = revisionRequestDigest(request);
    store.append(request);
    store.append({ type: 'task.revision.started', task_id: 'task', revision_id: 'revision', parent_version_id: request.parent_version_id,
        contract_sha256: request.contract_sha256, source_fingerprint: sourceFingerprint, grant_id: 'grant',
        expected_sequence: store.verifyIntegrity().lastSequence });
    const scoped = store.forRevision('task', 'revision');
    const candidateLease = scoped.acquireLease('task', 'agy');
    const reference = prepareRevisionWorkspace({ workspaceRoot: root, sessionId: 'session', taskId: 'task', revisionId: 'revision',
        attempt: 1, planRevision: 1, allowedFiles: ['app.js'], contractDigest: request.contract_sha256,
        expectedSourceFingerprint: sourceFingerprint });
    scoped.append({ type: 'task.workspace.prepared', task_id: 'task', lease_id: candidateLease.lease_id, attempt: 1,
        reference: { bindingPath: reference.bindingPath, bindingSha256: reference.bindingSha256,
            workerBaselineSha256: revisionDigest('worker-baseline'), workerContractSha256: revisionDigest('worker-contract') } });
    fs.writeFileSync(path.join(reference.workerRoot, 'app.js'), 'module.exports = 2;\n');
    const result = collectTaskResult({ workspaceRoot: root, reference });
    scoped.append({ type: 'task.workspace.handoff', task_id: 'task', lease_id: candidateLease.lease_id, attempt: 1,
        handoff_path: '.omni/runs/handoff.json', handoff_sha256: revisionDigest('handoff'), result_sha256: result.resultSha256 });
    scoped.releaseLease(candidateLease.lease_id, 'candidate completed');
    return { root, store, scoped, reference, result, parentVersion, oldCommand, newCommand, acceptanceCommand };
}
test('controller reruns complete registered validation for fresh candidate and preserves verified parent', async t => {
    const f = fixture(t);
    const checked = await runRevisionChecks({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'task', revisionId: 'revision', phase: 'pre_integration' });
    assert.equal(checked.status, 'PASSED');
    assert.equal(checked.commands.length, 3);
    assert.ok(checked.commands.every(commandResult => commandResult.exit_code === 0));
    assert.equal(fs.readFileSync(path.join(f.root, 'app.js'), 'utf8'), 'module.exports = 1;\n');
    assert.deepEqual(f.store.derive().tasks.task.current_verified_version, f.parentVersion);
    assert.equal(f.store.derive().sessionState, 'ACCEPTANCE');
    const second = await runRevisionChecks({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'task', revisionId: 'revision', phase: 'pre_integration' });
    assert.notEqual(second.evidence[0].path, checked.evidence[0].path);
    const firstArtifact = JSON.parse(fs.readFileSync(path.join(f.root, checked.evidence[0].path), 'utf8'));
    const secondArtifact = JSON.parse(fs.readFileSync(path.join(f.root, second.evidence[0].path), 'utf8'));
    assert.notEqual(firstArtifact.execution_id, secondArtifact.execution_id);
    assert.equal(secondArtifact.candidate_sha256, f.result.resultSha256);
});
test('controller refuses stale handoff bytes before running checks or touching verified source', async t => {
    const f = fixture(t);
    fs.writeFileSync(path.join(f.reference.workerRoot, 'app.js'), 'module.exports = 3;\n');
    await assert.rejects(runRevisionChecks({ workspaceRoot: f.root, authorityStore: f.store,
        taskId: 'task', revisionId: 'revision', phase: 'pre_integration' }), { code: 'DUAL_REVISION_EVIDENCE_REQUIRED' });
    assert.equal(fs.readFileSync(path.join(f.root, 'app.js'), 'utf8'), 'module.exports = 1;\n');
    assert.deepEqual(f.store.derive().tasks.task.current_verified_version, f.parentVersion);
});
test('controller QC through promotion changes only the verified version pointer after fresh pre/post checks', async t => {
    const f = fixture(t);
    f.store.recordRevisionPhase({ taskId: 'task', revisionId: 'revision', from: 'EXECUTING', to: 'QC',
        candidateSha256: f.result.resultSha256 });
    const checked = await runRevisionChecks({ workspaceRoot: f.root, authorityStore: f.store,
        taskId: 'task', revisionId: 'revision', phase: 'pre_integration' });
    f.scoped.append({ type: 'gate.result', task_id: 'task', gate_id: 'isolated-qc-task', status: 'PASSED',
        evidence_sha256: checked.evidence[0].sha256, reason: 'Full controller validation', details: { required: true,
            handoff_sha256: revisionDigest('handoff'), result_sha256: f.result.resultSha256, commands: checked.commands } });
    f.store.recordRevisionPhase({ taskId: 'task', revisionId: 'revision', from: 'QC', to: 'READY', candidateSha256: f.result.resultSha256 });
    assert.equal(fs.readFileSync(path.join(f.root, 'app.js'), 'utf8'), 'module.exports = 1;\n');
    const promoted = await revisionRpc({ method: 'dual.task.revision.promote', params: { session_id: 'session', task_id: 'task',
        revision_id: 'revision', parent_version_id: f.parentVersion.version_id, candidate_sha256: f.result.resultSha256,
        expected_sequence: f.store.verifyIntegrity().lastSequence }, workspaceRoot: f.root, authorityStore: f.store });
    assert.equal(promoted.status, 'PROMOTED');
    const now = f.store.derive();
    assert.equal(now.sessionState, 'ACCEPTANCE');
    assert.equal(now.tasks.task.state, 'TASK_VERIFIED');
    assert.equal(now.tasks.task.active_revision.state, 'PROMOTED');
    assert.equal(now.tasks.task.current_verified_version.candidate_sha256, f.result.resultSha256);
    assert.equal(now.tasks.task.current_verified_version.parent_version_id, f.parentVersion.version_id);
    assert.equal(now.tasks.task.verified_versions[0].version_id, f.parentVersion.version_id);
    assert.equal(now.tasks.task.revisions_started, 1);
    assert.equal(fs.readFileSync(path.join(f.root, 'app.js'), 'utf8'), 'module.exports = 2;\n');
    assert.equal(reconcileRevisionPromotions({ workspaceRoot: f.root }).status, 'CLEAR');
    const receipt = JSON.parse(fs.readFileSync(path.join(f.root, promoted.receipt), 'utf8'));
    assert.equal(receipt.commands.length, 6);
    assert.equal(receipt.pre_evidence.length, 1);
    assert.equal(receipt.post_evidence.length, 1);
    assert.notEqual(receipt.pre_evidence[0].path, receipt.post_evidence[0].path);
});
test('controller never certifies a candidate whose bytes changed during a passing validator', async t => {
    const f = fixture(t, { mutatingCheck: true });
    await assert.rejects(runRevisionChecks({ workspaceRoot: f.root, authorityStore: f.store, taskId: 'task',
        revisionId: 'revision', phase: 'pre_integration' }), { code: 'DUAL_REVISION_EVIDENCE_REQUIRED' });
    assert.equal(fs.readFileSync(path.join(f.root, 'app.js'), 'utf8'), 'module.exports = 1;\n');
    assert.deepEqual(f.store.derive().tasks.task.current_verified_version, f.parentVersion);
});
test('revision runner executes real isolated phase machinery and resumes the same candidate without redispatch', async t => {
    const { runIsolatedTask } = require('../lib/dual/isolated-runner');
    const { createDiscussionStub } = require('./helpers/dual-discussion-stub');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revision-isolated-flow-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'spec.md'), 'Export two; preserve verified source until promotion.\n');
    const calls = [];
    const task = { task_id: 'task', revision_id: 'revision-runner', contract_sha256: revisionDigest('contract'),
        source_fingerprint: revisionSourceFingerprint(root), model: 'gemini-test', effort: 'high', goal: 'Export two',
        allowed_files: ['app.js'], context_files: ['spec.md'], deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--check', 'app.js'], cwd: '.' }] };
    function payload(workerRoot, phase) {
        calls.push(phase);
        const spec = JSON.parse(fs.readFileSync(path.join(workerRoot, '.omni/codex-gemini/runs/task/spec.json'), 'utf8'));
        const common = { schema_version: 1, task_id: 'task', expected_baseline: spec.expected_baseline };
        if (phase === 'scout') return { ...common, summary: 'Read source and spec', relevant_files: [{ path: 'app.js', description: 'export' }],
            exact_symbols: [], validation_commands: ['node --check app.js'], constraints: ['scope only'], risks: [], open_questions: [],
            research_trace: ['app.js', 'spec.md'].map(source => ({ question: 'Expected behavior?', source, source_type: 'REPOSITORY', conclusion: 'Export two' })),
            alternatives_considered: [{ option: 'Modify existing', tradeoff: 'small' }, { option: 'Create another', tradeoff: 'unnecessary' }], failure_modes: ['wrong number'] };
        if (phase === 'implement') {
            fs.writeFileSync(path.join(workerRoot, 'app.js'), 'module.exports = 2;\n');
            return { ...common, status: 'SUCCESS', modified_files: ['app.js'], command_outputs: [{ command: 'node --check app.js', exit_code: 0, output: '' }],
                unverified_items: [], self_review: { checks: ['scope', 'syntax', 'value'], remaining_risks: [] } };
        }
        return { ...common, recommendation: 'APPROVE', risk_level: 'LOW', findings: [], review_checks: ['scope', 'syntax', 'value'],
            challenge_summary: 'Compared candidate against integrated parent and full registered task.' };
    }
    const options = { workspaceRoot: root, sessionId: 'session', attempt: 1, planRevision: 1, task,
        capability: { version: '1.1.27-test', model: 'gemini-test' }, authorize: () => true,
        discussion: createDiscussionStub({ turn: async ({ workerRoot, phase }) => payload(workerRoot, phase) }),
        processRunner: async invocation => ({ exitCode: 0, stdout: JSON.stringify({ status: 'success',
            structured_output: payload(invocation.cwd, 'implement') }), stderr: '', timedOut: false, durationMs: 1,
            startedAt: new Date(), endedAt: new Date() }) };
    const handoff = await runIsolatedTask(options);
    assert.equal(handoff.status, 'AWAITING_CODEX_QC');
    assert.match(handoff.reference.bindingPath, /revision-revision-runner\/attempt-1\//);
    assert.equal(handoff.result.revisionId, task.revision_id);
    assert.equal(handoff.result.contractDigest, task.contract_sha256);
    assert.deepEqual(calls, ['scout', 'implement', 'review']);
    assert.equal(fs.readFileSync(path.join(root, 'app.js'), 'utf8'), 'module.exports = 1;\n');
    const resumed = await runIsolatedTask({ ...options, reference: handoff.reference });
    assert.equal(resumed.handoffSha256, handoff.handoffSha256);
    assert.equal(calls.length, 3);
    await assert.rejects(runIsolatedTask({ ...options, task: { ...task, revision_id: 'other-revision' }, reference: handoff.reference }),
        { code: 'DUAL_ISOLATED_WORKSPACE_MISMATCH' });
});
async function checkedPromotion(f) {
    const integration = require('../lib/dual/task-revision-integration');
    f.store.recordRevisionPhase({ taskId: 'task', revisionId: 'revision', from: 'EXECUTING', to: 'QC', candidateSha256: f.result.resultSha256 });
    const checked = await runRevisionChecks({ workspaceRoot: f.root, authorityStore: f.store,
        taskId: 'task', revisionId: 'revision', phase: 'pre_integration' });
    f.scoped.append({ type: 'gate.result', task_id: 'task', gate_id: 'isolated-qc-task', status: 'PASSED', evidence_sha256: checked.evidence[0].sha256,
        reason: 'Full controller validation', details: { required: true, handoff_sha256: revisionDigest('handoff'),
            result_sha256: f.result.resultSha256, commands: checked.commands } });
    f.store.recordRevisionPhase({ taskId: 'task', revisionId: 'revision', from: 'QC', to: 'READY', candidateSha256: f.result.resultSha256 });
    return integration.promoteRevisionResult({ workspaceRoot: f.root, reference: f.reference, result: f.result,
        expectedResultSha256: f.result.resultSha256, authorize: identity => identity.revisionId === 'revision',
        onPrepared({ journalPath, journalSha256, candidateDigest }) {
            f.store.recordRevisionPhase({ taskId: 'task', revisionId: 'revision', from: 'READY', to: 'PROMOTING', candidateSha256: candidateDigest,
                evidence: { kind: 'promotion', reference: journalPath, sha256: journalSha256, candidate_sha256: candidateDigest } });
        }, runChecks: ({ phase }) => runRevisionChecks({ workspaceRoot: f.root, authorityStore: f.store,
            taskId: 'task', revisionId: 'revision', phase }) });
}
function appendPromoted(f, checked) {
    const candidate = f.store.derive().tasks.task.active_revision;
    const receipt = JSON.parse(fs.readFileSync(path.join(f.root, checked.receiptPath), 'utf8'));
    f.store.append({ type: 'task.revision.promoted', task_id: 'task', revision_id: candidate.revision_id, attempt: candidate.attempt,
        expected_sequence: f.store.verifyIntegrity().lastSequence, parent_version_id: candidate.parent_version_id,
        contract_sha256: candidate.contract_sha256, source_fingerprint: candidate.source_fingerprint,
        candidate_sha256: candidate.candidate_sha256, integrated_source_fingerprint: receipt.integratedFingerprint,
        version_id: revisionDigest('promoted-before-crash'), evidence: { kind: 'integration', reference: checked.receiptPath,
            sha256: checked.receiptSha256, candidate_sha256: candidate.candidate_sha256 } });
}
test('restart promotion resumes durable checked receipt without creating a new revision or rerunning worker', async t => {
    const f = fixture(t);
    const checked = await checkedPromotion(f);
    assert.equal(checked.status, 'CHECKED');
    assert.equal(f.store.derive().tasks.task.active_revision.state, 'PROMOTING');
    const reopened = createAuthorityStore(path.join(f.root, '.omni/runs/dual-authority'));
    const promoted = await revisionRpc({ method: 'dual.task.revision.promote', params: { session_id: 'session', task_id: 'task', revision_id: 'revision',
        expected_sequence: reopened.verifyIntegrity().lastSequence, parent_version_id: f.parentVersion.version_id,
        candidate_sha256: f.result.resultSha256 }, authorityStore: reopened, workspaceRoot: f.root });
    assert.equal(promoted.status, 'PROMOTED');
    assert.equal(reopened.derive().tasks.task.revisions_started, 1);
    assert.equal(reopened.derive().tasks.task.active_revision.state, 'PROMOTED');
    assert.equal(reconcileRevisionPromotions({ workspaceRoot: f.root }).status, 'CLEAR');
});
test('restart never promotes APPLIED bytes without a durable CHECKED phase', async t => {
    const f = fixture(t);
    const checked = await checkedPromotion(f);
    const directory = path.dirname(path.join(f.root, checked.journalPath));
    const prefix = path.basename(checked.journalPath).replace(/\.json$/, '-phase-');
    const phaseFiles = fs.readdirSync(directory).filter(file => file.startsWith(prefix)).sort();
    fs.unlinkSync(path.join(directory, phaseFiles.at(-1)));
    const reopened = createAuthorityStore(path.join(f.root, '.omni/runs/dual-authority'));
    try {
        const result = await revisionRpc({ method: 'dual.task.revision.promote', params: { session_id: 'session', task_id: 'task', revision_id: 'revision',
            expected_sequence: reopened.verifyIntegrity().lastSequence, parent_version_id: f.parentVersion.version_id,
            candidate_sha256: f.result.resultSha256 }, authorityStore: reopened, workspaceRoot: f.root });
        assert.equal(result.status, 'RECONCILIATION_REQUIRED');
    } catch (error) { assert.equal(error.code, 'DUAL_REVISION_RECONCILIATION_REQUIRED'); }
    assert.equal(reopened.derive().tasks.task.current_verified_version.version_id, f.parentVersion.version_id);
    assert.equal(reopened.derive().tasks.task.active_revision.state, 'PROMOTING');
});
test('restart status reconciles journal only after matching authority promoted version and receipt', async t => {
    const f = fixture(t);
    const checked = await checkedPromotion(f);
    appendPromoted(f, checked);
    assert.equal(reconcileRevisionPromotions({ workspaceRoot: f.root }).status, 'RECONCILIATION_REQUIRED');
    const reopened = createAuthorityStore(path.join(f.root, '.omni/runs/dual-authority'));
    const status = await revisionRpc({ method: 'dual.task.revision.status', params: { session_id: 'session', task_id: 'task', revision_id: 'revision' },
        authorityStore: reopened, workspaceRoot: f.root });
    assert.equal(status.reconciliation.status, 'CLEAR');
    assert.equal(reopened.derive().tasks.task.current_verified_version.version_id, revisionDigest('promoted-before-crash'));
    assert.equal(fs.readFileSync(path.join(f.root, 'app.js'), 'utf8'), 'module.exports = 2;\n');
});
test('cancel rejects an already promoted candidate before touching its unfinished promotion journal', async t => {
    const f = fixture(t);
    const checked = await checkedPromotion(f);
    appendPromoted(f, checked);
    const reopened = createAuthorityStore(path.join(f.root, '.omni/runs/dual-authority'));
    const lastSequence = reopened.verifyIntegrity().lastSequence;
    await assert.rejects(revisionRpc({ method: 'dual.task.revision.cancel', params: { session_id: 'session', task_id: 'task', revision_id: 'revision',
        reason: 'Too late' }, authorityStore: reopened, workspaceRoot: f.root }));
    assert.equal(reopened.verifyIntegrity().lastSequence, lastSequence);
    assert.equal(fs.readFileSync(path.join(f.root, 'app.js'), 'utf8'), 'module.exports = 2;\n');
    assert.equal(reconcileRevisionPromotions({ workspaceRoot: f.root }).journals[0].phase, 'CHECKED');
});
test('restart status leaves journal fenced when promoted authority names a different receipt', async t => {
    const f = fixture(t);
    const checked = await checkedPromotion(f);
    const alternatePath = checked.receiptPath.replace(/\.json$/, '-alternate.json');
    fs.copyFileSync(path.join(f.root, checked.receiptPath), path.join(f.root, alternatePath), fs.constants.COPYFILE_EXCL);
    appendPromoted(f, { ...checked, receiptPath: alternatePath });
    const reopened = createAuthorityStore(path.join(f.root, '.omni/runs/dual-authority'));
    const status = await revisionRpc({ method: 'dual.task.revision.status', params: { session_id: 'session', task_id: 'task', revision_id: 'revision' },
        authorityStore: reopened, workspaceRoot: f.root });
    assert.equal(status.reconciliation.status, 'RECONCILIATION_REQUIRED');
    assert.equal(status.reconciliation.journals[0].phase, 'CHECKED');
    assert.equal(fs.readFileSync(path.join(f.root, 'app.js'), 'utf8'), 'module.exports = 2;\n');
});
