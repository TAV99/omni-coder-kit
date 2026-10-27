'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RevisionContractSchema } = require('./contracts');
const { revisionDigest, revisionRequestDigest, terminalRevision, currentVerifiedVersion } = require('./revision-policy');
const integration = require('./task-revision-integration');
const { collectTaskResult, readTaskBinding, validateTaskPath } = require('./task-workspace');
const { runBoundedCommandAsync } = require('./quality-runner');
const { evaluateAttestedReview, reviewAttestationEvidence } = require('./acceptance-policy');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function uniqueCommands(commands) {
    return [...new Map(commands.map((command) => [revisionDigest(command), command])).values()];
}
function appendArtifact(root, candidate, kind, record) {
    const directory = `.omni/runs/dual-revisions/${sha(candidate.revision_id)}/attempt-${candidate.attempt}`;
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    const reference = `${directory}/${kind}-${crypto.randomUUID()}.json`;
    const bytes = JSON.stringify(record, null, 2) + '\n';
    const descriptor = fs.openSync(path.join(root, reference), 'wx', 0o600);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    return { reference, sha256: sha(bytes), candidate_sha256: record.candidate_sha256, kind };
}
function candidateFor(derived, params, { terminal = false } = {}) {
    if (!params || params.session_id !== derived.sessionId) fail('DUAL_REVISION_STALE', 'Revision session does not match authority');
    const task = derived.tasks?.[params.task_id];
    if (!task) fail('DUAL_TASK_NOT_FOUND', 'Revision task is not registered');
    const candidate = (task.revisions || []).find((item) => item.revision_id === params.revision_id)
        || (task.active_revision?.revision_id === params.revision_id ? task.active_revision : null);
    if (!candidate || (!terminal && (terminalRevision(candidate) || task.active_revision?.revision_id !== candidate.revision_id)))
        fail('DUAL_REVISION_STALE', 'No matching active revision');
    if (params.attempt !== undefined && params.attempt !== candidate.attempt) fail('DUAL_REVISION_STALE', 'Candidate attempt changed');
    return { task, candidate };
}
function binding(candidate) {
    return Object.fromEntries(['revision_id', 'parent_version_id', 'contract_sha256', 'source_fingerprint'].map((key) => [key, candidate[key]]));
}
function requireBinding(candidate, params) {
    for (const [key, value] of Object.entries(binding(candidate))) if (params[key] !== value)
        fail('DUAL_REVISION_GRANT_INVALID', `Revision ${key} binding mismatch`);
}
function phase(authorityStore, taskId, candidate, to, evidence) {
    return authorityStore.recordRevisionPhase({ taskId, revisionId: candidate.revision_id,
        from: candidate.state, to, candidateSha256: evidence.candidate_sha256, evidence });
}

// Runs the entire registered contract for each invocation. Worker reports never
// substitute for commands or independent, daemon-anchored review attestations.
async function runRevisionChecks({ workspaceRoot, authorityStore, taskId, revisionId, phase: checkPhase, executionRoot }) {
    const derived = authorityStore.derive();
    const { task, candidate } = candidateFor(derived, { session_id: derived.sessionId, task_id: taskId, revision_id: revisionId });
    const scoped = authorityStore.forRevision(taskId, revisionId).derive();
    const handoff = candidate.isolatedHandoff;
    if (!handoff) fail('DUAL_REVISION_EVIDENCE_REQUIRED', 'Candidate handoff is required');
    const { workerRoot } = readTaskBinding(workspaceRoot, candidate.isolatedWorkspace.reference);
    const candidateDigest = collectTaskResult({ workspaceRoot, reference: candidate.isolatedWorkspace.reference, readOnly: true }).resultSha256;
    if (candidateDigest !== handoff.result_sha256) fail('DUAL_REVISION_EVIDENCE_REQUIRED', 'Candidate changed after handoff');
    const oldPolicy = derived.plan?.acceptance_policy || derived.plan?.acceptancePolicy;
    const policy = scoped.plan?.acceptance_policy || scoped.plan?.acceptancePolicy;
    const superseded = new Set(candidate.contract.superseded_acceptance_criteria || []);
    const retained = (oldPolicy?.checks || []).filter((check) => !superseded.has(check.id));
    const checks = [...new Map([...retained, ...(policy?.checks || [])].map((check) => [revisionDigest(check), check])).values()];
    for (const old of retained) {
        const replacement = policy?.checks?.find((check) => check.id === old.id);
        if (replacement && revisionDigest(replacement) !== revisionDigest(old))
            fail('DUAL_REVISION_SCOPE', 'Changing an existing acceptance check requires an explicitly approved successor contract');
    }
    if (retained.some((old) => !policy?.checks?.some((check) => revisionDigest(check) === revisionDigest(old))))
        fail('DUAL_REVISION_SCOPE', 'Candidate must retain the entire registered acceptance suite');
    const specifications = uniqueCommands([...(task.validation_commands || []), ...(candidate.validation_commands || []),
        ...(candidate.contract.validation_commands || []), ...checks.filter((check) => check.kind === 'command').map((check) => check.command)]);
    const commands = [];
    const executionId = crypto.randomUUID();
    const root = executionRoot || (checkPhase === 'post_integration' ? workspaceRoot : workerRoot);
    for (const command of specifications) {
        const cwd = command.cwd === '.' ? root : path.join(root, validateTaskPath(root, command.cwd));
        const result = await runBoundedCommandAsync(command, { cwd, workspaceRoot: root, purpose: 'quality', runId: executionId });
        commands.push(result);
        if (!result.ok || result.exit_code !== 0) fail('DUAL_REVISION_CHECK_FAILED', 'Registered revision validation failed');
        const now = authorityStore.derive();
        if (now.tasks[taskId]?.active_revision?.revision_id !== revisionId
            || now.tasks[taskId].active_revision.attempt !== candidate.attempt
            || now.tasks[taskId].active_revision.contract_sha256 !== candidate.contract_sha256
            || now.tasks[taskId].active_revision.isolatedHandoff?.result_sha256 !== candidateDigest) fail('DUAL_REVISION_STALE', 'Candidate authority changed during checks');
    }
    const reviewPhase = checkPhase === 'post_integration' ? 'post_integration' : 'pre_integration';
    const required = checks.filter((check) => check.kind === 'review' && check.required
        && (reviewPhase === 'post_integration' ? check.phase === 'session' : check.phase === 'pre_integration' && check.task_id === taskId));
    const reviewEvidence = [];
    if (required.length || specifications.length === 0) {
        const attestations = Object.values(scoped.reviewAttestations || {}).filter((item) => item.task_id === taskId
            && item.result_sha256 === candidateDigest && item.review_phase === reviewPhase && item.provenance_mode === 'fresh');
        const attestation = attestations.at(-1);
        if (!attestation || (specifications.length === 0 && !attestation.check_results.some((entry) => entry.status === 'PASS' && entry.findings?.length)))
            fail('DUAL_REVISION_REVIEW_REQUIRED', 'Fresh independent review of this candidate is required');
        const result = evaluateAttestedReview(policy, reviewAttestationEvidence(attestation), {
            reviewPhase, taskId, resultSha256: candidateDigest });
        if (result.status !== 'PASSED' || required.some((check) => !attestation.check_results.some((entry) => entry.check_id === check.id && entry.status === 'PASS')))
            fail('DUAL_REVISION_REVIEW_REQUIRED', 'All registered acceptance review checks must pass for this candidate');
        reviewEvidence.push(attestation.attestation_sha256);
    }
    if (collectTaskResult({ workspaceRoot, reference: candidate.isolatedWorkspace.reference, readOnly: true }).resultSha256 !== candidateDigest)
        fail('DUAL_REVISION_EVIDENCE_REQUIRED', 'Validation changed candidate bytes; fresh handoff and review are required');
    const evidence = appendArtifact(workspaceRoot, candidate, 'qc', { schema_version: 1,
        session_id: derived.sessionId, task_id: taskId, revision_id: revisionId, attempt: candidate.attempt,
        contract_sha256: candidate.contract_sha256, candidate_sha256: candidateDigest, phase: checkPhase, kind: 'qc', verified_by: 'codex',
        authority_sequence: authorityStore.verifyIntegrity().lastSequence, execution_id: executionId, commands, review_evidence: reviewEvidence, status: 'PASSED' });
    return { status: 'PASSED', candidateDigest, commands, review_evidence: reviewEvidence,
        evidence: [{ path: evidence.reference, sha256: evidence.sha256 }], authorityEvidence: evidence };
}

function reconcileRevisionAuthority({ workspaceRoot, authorityStore }) {
    const derived = authorityStore.derive();
    for (const pending of integration.reconcileRevisionPromotions({ workspaceRoot }).journals) {
        const task = derived.tasks[pending.identity.taskId];
        const version = task?.current_verified_version;
        if (version?.revision_id !== pending.identity.revisionId || version.attempt !== pending.identity.attempt
            || version.candidate_sha256 !== pending.identity.candidateDigest) continue;
        const checked = integration.readCheckedRevisionPromotion({ workspaceRoot, journalPath: pending.journalPath });
        if (checked.status !== 'CHECKED' || version.evidence?.reference !== checked.receiptPath
            || version.evidence.sha256 !== checked.receiptSha256) continue;
        integration.finalizeRevisionPromotion({ workspaceRoot, journalPath: pending.journalPath,
            authorize: () => authorityStore.derive().tasks[pending.identity.taskId]?.current_verified_version?.version_id === version.version_id });
    }
    return integration.reconcileRevisionPromotions({ workspaceRoot });
}

async function revisionRpc({ method, params, authorityStore, workspaceRoot, dispatch }) {
    const action = method.split('.').at(-1);
    const derived = authorityStore.derive();
    if (!params || params.session_id !== derived.sessionId) fail('DUAL_REVISION_STALE', 'Revision session does not match authority');
    if (action === 'request') {
        if (derived.sessionState !== 'ACCEPTANCE') fail('DUAL_REVISION_STALE', 'Revision requires ACCEPTANCE');
        const contract = RevisionContractSchema.parse(params.contract);
        if (revisionDigest(contract) !== params.contract_sha256) fail('DUAL_REVISION_CONTRACT_REQUIRED', 'Contract digest does not match payload');
        const event = { schema_version: 2, type: 'task.revision.requested', task_id: params.task_id,
            revision_id: params.revision_id, request_id: params.request_id, expected_sequence: params.expected_sequence,
            parent_version_id: params.parent_version_id, source_fingerprint: params.source_fingerprint,
            contract, contract_sha256: params.contract_sha256, approval: params.approval };
        event.request_sha256 = revisionRequestDigest(event);
        const previous = derived.tasks[params.task_id]?.revision_requests?.find((item) => item.request_id === params.request_id);
        if (previous) {
            if (previous.request_sha256 !== event.request_sha256) fail('DUAL_REVISION_REQUEST_CONFLICT', 'Request ID already binds different payload');
            return { acknowledged: true, reused: true, revision_id: params.revision_id };
        }
        if (integration.reconcileRevisionPromotions({ workspaceRoot }).status !== 'CLEAR') fail('DUAL_REVISION_RECONCILIATION_REQUIRED', 'Unfinished integration journal blocks revision');
        if (integration.revisionSourceFingerprint(workspaceRoot) !== params.source_fingerprint) fail('DUAL_REVISION_STALE', 'Integrated source fingerprint changed');
        authorityStore.append(event);
        return { acknowledged: true, reused: false, revision_id: params.revision_id };
    }
    const { task, candidate } = candidateFor(derived, params, { terminal: action === 'status' || action === 'start' || action === 'cancel' || action === 'promote' });
    if (action === 'status') return { reconciliation: reconcileRevisionAuthority({ workspaceRoot, authorityStore }), session_id: derived.sessionId, task_id: params.task_id,
        current_verified_version: currentVerifiedVersion(task), revisions_started: task.revisions_started || 0,
        revision: candidate };
    if (action === 'start') {
        requireBinding(candidate, params);
        if (params.grant_id !== candidate.approval.grant_id) fail('DUAL_REVISION_GRANT_INVALID', 'Start requires the approved grant');
        if (candidate.grant_consumed) return { acknowledged: true, reused: true, revision_id: candidate.revision_id, attempt: candidate.attempt };
        if (integration.reconcileRevisionPromotions({ workspaceRoot }).status !== 'CLEAR') fail('DUAL_REVISION_RECONCILIATION_REQUIRED', 'Unfinished promotion blocks execution');
        if (integration.revisionSourceFingerprint(workspaceRoot) !== candidate.source_fingerprint) fail('DUAL_REVISION_STALE', 'Integrated source fingerprint changed');
        require('./coverage-runtime').assertRuntimeCoverage(workspaceRoot, { derived, revision_id: candidate.revision_id,
            attempt: candidate.attempt, task_id: params.task_id, contract_digest: candidate.contract_sha256, plan: candidate.contract.candidate_plan });
        authorityStore.append({ schema_version: 2, type: 'task.revision.started', task_id: params.task_id,
            ...binding(candidate), expected_sequence: params.expected_sequence, grant_id: params.grant_id });
        if (dispatch) await dispatch(authorityStore.derive(), { task_id: params.task_id, revision_id: candidate.revision_id });
        return { acknowledged: true, reused: false, revision_id: candidate.revision_id, attempt: 1 };
    }
    if (action === 'cancel') {
        if (typeof params.reason !== 'string' || !params.reason.trim() || params.reason.length > 4096)
            fail('DUAL_REVISION_INVALID', 'Cancellation requires a bounded reason');
        if (candidate.state === 'CANCELLED') return { acknowledged: true, reused: true };
        if (terminalRevision(candidate)) fail('DUAL_REVISION_STALE', 'A terminal candidate cannot be cancelled or rolled back');
        const journals = integration.reconcileRevisionPromotions({ workspaceRoot });
        let rollbackEvidence;
        for (const journal of journals.journals.filter((item) => item.identity.revisionId === candidate.revision_id)) {
            const rolled = integration.rollbackRevisionPromotion({ workspaceRoot, journalPath: journal.journalPath,
                authorize: (identity) => identity.revisionId === candidate.revision_id && identity.contractDigest === candidate.contract_sha256 });
            if (rolled.status !== 'ROLLED_BACK') fail('DUAL_REVISION_RECONCILIATION_REQUIRED', 'External drift prevents rollback');
            if (rolled.rollbackPhasePath) rollbackEvidence = { reference: rolled.rollbackPhasePath, sha256: rolled.rollbackPhaseSha256 };
        }
        authorityStore.append({ schema_version: 2, type: 'task.revision.cancelled', task_id: params.task_id,
            revision_id: candidate.revision_id, attempt: candidate.attempt, reason: params.reason,
            ...(rollbackEvidence ? { rollback_evidence: rollbackEvidence } : {}) });
        return { acknowledged: true, reused: false };
    }
    if (action !== 'promote') fail('DUAL_REVISION_INVALID', 'Unknown revision action');
    if (candidate.state === 'PROMOTED') {
        if (task.current_verified_version?.revision_id !== candidate.revision_id
            || params.parent_version_id !== candidate.parent_version_id || params.candidate_sha256 !== candidate.candidate_sha256)
            fail('DUAL_REVISION_CAS_FAILED', 'Promoted version no longer matches retry');
        const reconciled = reconcileRevisionAuthority({ workspaceRoot, authorityStore });
        return { status: reconciled.status === 'CLEAR' ? 'PROMOTED' : 'RECONCILIATION_REQUIRED',
            revision_id: candidate.revision_id, reused: true };
    }

    if (!['READY', 'PROMOTING'].includes(candidate.state) || params.parent_version_id !== candidate.parent_version_id
        || currentVerifiedVersion(task).version_id !== candidate.parent_version_id
        || params.candidate_sha256 !== candidate.candidate_sha256
        || params.expected_sequence !== authorityStore.verifyIntegrity().lastSequence) fail('DUAL_REVISION_CAS_FAILED', 'Promotion parent, candidate, or sequence changed');
    const reference = candidate.isolatedWorkspace.reference;
    const result = collectTaskResult({ workspaceRoot, reference });
    const authorize = (identity) => {
        const now = authorityStore.derive();
        const active = now.tasks[params.task_id]?.active_revision;
        return now.sessionState === 'ACCEPTANCE' && active?.revision_id === candidate.revision_id
            && active.contract_sha256 === identity.contractDigest && active.attempt === identity.attempt
            && ['READY', 'PROMOTING'].includes(active.state)
            && currentVerifiedVersion(now.tasks[params.task_id]).version_id === candidate.parent_version_id;
    };
    let checked;
    if (candidate.state === 'PROMOTING') {
        const pending = integration.reconcileRevisionPromotions({ workspaceRoot }).journals.find((item) =>
            item.identity.revisionId === candidate.revision_id && item.identity.taskId === params.task_id
            && item.identity.attempt === candidate.attempt && item.identity.contractDigest === candidate.contract_sha256);
        if (!pending) fail('DUAL_REVISION_RECONCILIATION_REQUIRED', 'No durable checked promotion to resume');
        checked = integration.readCheckedRevisionPromotion({ workspaceRoot, journalPath: pending.journalPath });
        if (checked.status !== 'CHECKED') return checked;
    } else checked = await integration.promoteRevisionResult({ workspaceRoot, reference, result,
        expectedResultSha256: candidate.candidate_sha256, authorize,
        onPrepared({ journalPath, journalSha256, candidateDigest }) {
            const current = authorityStore.derive().tasks[params.task_id].active_revision;
            phase(authorityStore, params.task_id, current, 'PROMOTING', { kind: 'promotion', reference: journalPath,
                sha256: journalSha256, candidate_sha256: candidateDigest });
        },
        runChecks: ({ phase: checkPhase }) => runRevisionChecks({ workspaceRoot, authorityStore,
            taskId: params.task_id, revisionId: candidate.revision_id, phase: checkPhase }),
    });
    if (checked.status !== 'CHECKED') {
        if (checked.status === 'ROLLED_BACK' && checked.rollbackPhasePath) authorityStore.append({ schema_version: 2,
            type: 'task.revision.failed', task_id: params.task_id, revision_id: candidate.revision_id, attempt: candidate.attempt,
            reason: 'Full post-integration validation failed; durable rollback restored the parent',
            rollback_evidence: { reference: checked.rollbackPhasePath, sha256: checked.rollbackPhaseSha256 } });
        return checked;
    }
    const receiptBytes = fs.readFileSync(path.join(workspaceRoot, validateTaskPath(workspaceRoot, checked.receiptPath)));
    const receipt = JSON.parse(receiptBytes.toString('utf8'));
    if (sha(receiptBytes) !== checked.receiptSha256
        || integration.revisionSourceFingerprint(workspaceRoot) !== receipt.integratedFingerprint)
        fail('DUAL_REVISION_RECONCILIATION_REQUIRED', 'Integrated source drifted before authority promotion');
    const evidence = { kind: 'integration', reference: checked.receiptPath, sha256: checked.receiptSha256,
        candidate_sha256: candidate.candidate_sha256 };
    authorityStore.append({ schema_version: 2, type: 'task.revision.promoted', task_id: params.task_id, expected_sequence: authorityStore.verifyIntegrity().lastSequence,
        ...binding(candidate), attempt: candidate.attempt, candidate_sha256: candidate.candidate_sha256,
        integrated_source_fingerprint: receipt.integratedFingerprint,
        version_id: revisionDigest({ parent: candidate.parent_version_id, revision_id: candidate.revision_id,
            candidate_sha256: candidate.candidate_sha256, evidence }), evidence });
    const finalized = integration.finalizeRevisionPromotion({ workspaceRoot, journalPath: checked.journalPath,
        authorize: () => authorityStore.derive().tasks[params.task_id]?.current_verified_version?.revision_id === candidate.revision_id });
    return { status: finalized.status, revision_id: candidate.revision_id, receipt: checked.receiptPath };
}
module.exports = { revisionRpc, reconcileRevisionAuthority, runRevisionChecks, appendArtifact, uniqueCommands };
