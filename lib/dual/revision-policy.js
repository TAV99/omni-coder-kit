'use strict';
const crypto = require('node:crypto');
const { RevisionContractSchema } = require('./contracts');
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
        .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}
const revisionDigest = (value) => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const terminalRevision = (revision) => !revision || ['PROMOTED', 'FAILED', 'CANCELLED'].includes(revision.state);
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function revisionRequestDigest(event) {
    return revisionDigest(Object.fromEntries(['revision_id', 'parent_version_id', 'source_fingerprint', 'contract_sha256', 'approval']
        .map((key) => [key, event[key]])));
}
function currentVerifiedVersion(task) {
    if (task.current_verified_version) return task.current_verified_version;
    const version = { task_id: task.task_id, source_fingerprint: task.diff_fingerprint || task.diffFingerprint,
        handoff_sha256: task.isolatedHandoff?.handoff_sha256 || null, result_sha256: task.isolatedHandoff?.result_sha256 || null };
    return { ...version, version_id: revisionDigest(version) };
}
function checkBinding(revision, event) {
    for (const key of ['revision_id', 'parent_version_id', 'contract_sha256', 'source_fingerprint']) {
        if (event[key] !== revision[key]) fail('DUAL_REVISION_GRANT_INVALID', `Revision grant ${key} binding mismatch`);
    }
}
function requireEvidence(task, revision, event, context, kind) {
    const evidence = event.evidence;
    if (!evidence || evidence.kind !== kind || !/^[a-f0-9]{64}$/.test(evidence.candidate_sha256 || '')
        || typeof evidence.reference !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sha256 || '')
        || typeof context.verifyRevisionEvidence !== 'function'
        || !context.verifyRevisionEvidence(task, revision, evidence, event)) {
        fail('DUAL_REVISION_EVIDENCE_REQUIRED', 'Phase requires fresh hash-bound controller evidence for the candidate');
    }
    if (revision.candidate_sha256 && evidence.candidate_sha256 !== revision.candidate_sha256
        && !['handoff', 'context'].includes(kind)) fail('DUAL_REVISION_EVIDENCE_REQUIRED', 'Candidate digest changed after QC');
    return evidence;
}
function reduceRevisionEvent(task, event, context) {
    if (!task || context.sessionState !== 'ACCEPTANCE' || task.state !== 'TASK_VERIFIED'
        || event.session_id !== context.sessionId || event.plan_revision !== context.planRevision) {
        fail('DUAL_REVISION_STALE', 'Revision requires the current verified task in ACCEPTANCE');
    }
    const parent = currentVerifiedVersion(task);
    if (event.type === 'task.revision.requested') {
        if (revisionDigest(event.contract) !== event.contract_sha256) fail('DUAL_REVISION_REQUEST_CONFLICT', 'Request contract payload digest conflict');
        const previous = (task.revision_requests || []).find((item) => item.request_id === event.request_id);
        if (previous) {
            if (previous.request_sha256 !== event.request_sha256 || revisionRequestDigest(event) !== previous.request_sha256)
                fail('DUAL_REVISION_REQUEST_CONFLICT', 'Request ID payload conflict');
            return;
        }
        if (context.activeAcceptanceCorrection) fail('DUAL_REVISION_BUSY', 'Acceptance correction is active');
        if (Object.values(context.tasks).some((item) => !terminalRevision(item.active_revision)))
            fail('DUAL_REVISION_BUSY', 'A session active revision already exists');
        if (Object.values(context.tasks).some((item) => (item.revision_requests || []).some((request) =>
            request.request_id === event.request_id || request.revision_id === event.revision_id || request.approval.grant_id === event.approval.grant_id)))
            fail('DUAL_REVISION_REQUEST_CONFLICT', 'Request, revision, and grant IDs are single-lineage identities');
        const parsed = RevisionContractSchema.safeParse(event.contract);
        if (!parsed.success || revisionDigest(event.contract) !== event.contract_sha256)
            fail('DUAL_REVISION_CONTRACT_REQUIRED', 'A pinned v2 revision contract and matching digest are required');
        if (event.expected_sequence !== event.sequence - 1 || event.parent_version_id !== parent.version_id
            || event.contract.parent_version_id !== event.parent_version_id
            || event.contract.source_fingerprint !== event.source_fingerprint)
            fail('DUAL_REVISION_STALE', 'Revision parent, sequence or source binding is stale');
        if (typeof context.verifySourceFingerprint !== 'function' || !context.verifySourceFingerprint(event.source_fingerprint))
            fail('DUAL_REVISION_STALE', 'Revision request requires controller-verified source fingerprint evidence');
        const allowed = task.allowed_files || task.allowedFiles || [];
        if (event.contract.allowed_files.some((file) => !allowed.includes(file)))
            fail('DUAL_REVISION_SCOPE', 'Revision scope exceeds task; use a successor');
        if (event.contract.candidate_plan) {
            const planned = event.contract.candidate_plan.tasks.find((item) => item.task_id === task.task_id);
            if (!planned || planned.owner !== task.owner
                || canonical(planned.depends_on || []) !== canonical(task.depends_on || []) || planned.allowed_files.some((file) => !event.contract.allowed_files.includes(file)))
                fail('DUAL_REVISION_SCOPE', 'Candidate plan must bind the same task and pinned scope');
            for (const item of event.contract.candidate_plan.tasks) {
                const original = context.tasks[item.task_id];
                if (!original) fail('DUAL_REVISION_SCOPE', 'Revision cannot add another task');
                if (item.task_id !== task.task_id && Object.keys(item).some((key) => key !== 'decision_ids' && canonical(item[key]) !== canonical(original[key])))
                    fail('DUAL_REVISION_SCOPE', 'Revision cannot change another task dependency contract');
            }
            const previousChecks = context.plan?.acceptance_policy?.checks || [];
            const nextChecks = event.contract.candidate_plan.acceptance_policy.checks;
            const superseded = event.contract.superseded_acceptance_criteria || [];
            if (previousChecks.some((check) => !superseded.includes(check.id)
                && !nextChecks.some((next) => canonical(check) === canonical(next))))
                fail('DUAL_REVISION_SCOPE', 'All old acceptance checks must remain unless user explicitly supersedes them');
        }
        const approval = event.approval;
        if (approval?.approved_by !== 'user' || !approval.grant_id) fail('DUAL_REVISION_APPROVAL_REQUIRED', 'Each revision contract requires user approval');
        checkBinding(event, approval);
        if (revisionRequestDigest(event) !== event.request_sha256) fail('DUAL_REVISION_REQUEST_CONFLICT', 'Request payload digest conflict');
        task.current_verified_version = parent;
        task.verified_versions ||= [parent];
        const request = JSON.parse(JSON.stringify(event));
        task.revision_requests = [...(task.revision_requests || []), request];
        const inherited = Object.fromEntries(['title', 'goal', 'model', 'effort', 'tokenBudget', 'context_files', 'deny_patterns',
            'depends_on', 'dependency_mode', 'generated_outputs', 'category', 'complexity', 'risk', 'decision_ids']
            .filter((key) => task[key] !== undefined).map((key) => [key, task[key]]));
        const planned = event.contract.candidate_plan?.tasks.find((item) => item.task_id === task.task_id);
        const commands = [...(task.validation_commands || []), ...event.contract.validation_commands];
        const validationCommands = commands.filter((command, index) => commands.findIndex((other) => canonical(other) === canonical(command)) === index);
        const candidate = { ...inherited, ...(planned || {}), task_id: task.task_id, taskId: task.task_id, title: task.title,
            owner: task.owner, execution_mode: 'isolated', allowed_files: event.contract.allowed_files,
            allowedFiles: event.contract.allowed_files, validation_commands: validationCommands,
            planRevision: context.planRevision, routePlanRevision: context.planRevision,
            revision_id: event.revision_id, parent_version_id: event.parent_version_id, contract_sha256: event.contract_sha256,
            source_fingerprint: event.source_fingerprint, request_id: event.request_id, contract: request.contract,
            approval: request.approval, grant_consumed: false, state: 'REQUESTED', attempt: 1,
            recoveryPolicy: { policy_version: 1, worker_limit: 2, harness_limit: 1, total_limit: 3 } };
        task.revisions ||= []; task.revisions.push(candidate); task.active_revision = candidate;
        return;
    }
    const revision = task.active_revision;
    if (!revision || revision.revision_id !== event.revision_id || terminalRevision(revision))
        fail('DUAL_REVISION_STALE', 'No matching active revision');
    if (event.type === 'task.revision.started') {
        checkBinding(revision, event);
        if (!revision.contract.candidate_plan || revision.contract.candidate_plan.schema_version !== 2)
            fail('DUAL_REVISION_CONTRACT_REQUIRED', 'Candidate execution requires its own v2 plan; LEGACY_UNCHECKED is insufficient');
        if (revision.state !== 'REQUESTED' || revision.grant_consumed || revision.approval.grant_id !== event.grant_id)
            fail('DUAL_REVISION_GRANT_INVALID', 'Revision start needs its unused single-use grant');
        if ((task.revisions_started || 0) >= 3) fail('DUAL_REVISION_LIMIT', 'Revision lifetime budget exhausted; use a successor');
        if (event.expected_sequence !== event.sequence - 1 || parent.version_id !== revision.parent_version_id
            || context.activeAcceptanceCorrection || Object.values(context.leases || {}).some((lease) => !lease.released_at)
            || context.integrationPending === true)
            fail('DUAL_REVISION_STALE', 'Revision start requires current parent, sequence, source and exclusive released integration authority');
        if (typeof context.verifySourceFingerprint !== 'function' || !context.verifySourceFingerprint(event.source_fingerprint))
            fail('DUAL_REVISION_STALE', 'Revision source fingerprint has drifted');
        revision.grant_consumed = true; revision.state = 'EXECUTING'; revision.started_sequence = event.sequence; revision.attempt_started_sequence = event.sequence;
        task.revisions_started = (task.revisions_started || 0) + 1;
        return;
    }
    if (event.attempt !== revision.attempt) fail('DUAL_REVISION_STALE', 'Candidate attempt mismatch');
    if (event.type === 'task.revision.failed' || event.type === 'task.revision.cancelled') {
        if (revision.state === 'PROMOTING' && !context.rollbackComplete)
            fail('DUAL_REVISION_RECONCILIATION_REQUIRED', 'Promotion must reconcile or rollback before closing');
        if (Object.values(context.leases || {}).some((lease) => lease.revision_id === revision.revision_id && !lease.released_at))
            fail('DUAL_REVISION_BUSY', 'Release candidate leases before closing');
        revision.state = event.type === 'task.revision.failed' ? 'FAILED' : 'CANCELLED'; revision.reason = event.reason;
        return;
    }
    if (event.type === 'task.revision.phase.changed') {
        if (revision.amendment_required && event.to === 'EXECUTING')
            fail('DUAL_REVISION_AMENDMENT_REVIEW_REQUIRED', 'Scope changes require a new approved contract');
        const transitions = { EXECUTING: ['WAITING_CONTEXT', 'QC'], WAITING_CONTEXT: ['EXECUTING'], QC: ['READY'], READY: ['PROMOTING'] };
        if (event.from !== revision.state || !transitions[event.from]?.includes(event.to))
            fail('DUAL_REVISION_PHASE_INVALID', 'Invalid candidate phase transition');
        const kind = event.to === 'WAITING_CONTEXT' || event.from === 'WAITING_CONTEXT' ? 'context'
            : event.to === 'QC' ? 'handoff' : event.to === 'READY' ? 'qc' : 'promotion';
        const evidence = requireEvidence(task, revision, event, context, kind);
        if (event.to === 'QC' && (!revision.isolatedHandoff || revision.isolatedHandoff.result_sha256 !== evidence.candidate_sha256))
            fail('DUAL_REVISION_EVIDENCE_REQUIRED', 'QC requires the current candidate handoff');
        if (event.to === 'READY') {
            const gate = context.gates?.[`revision-${revision.revision_id}-${revision.attempt}-isolated-qc-${task.task_id}`]
                || revision.gates?.[`isolated-qc-${task.task_id}`];
            if (gate?.status !== 'PASSED' || gate.details?.result_sha256 !== evidence.candidate_sha256
                || !Array.isArray(gate.details.commands) || gate.details.commands.some((command) => command.exit_code !== 0))
                fail('DUAL_REVISION_EVIDENCE_REQUIRED', 'READY requires fresh complete candidate QC');
        }
        revision.state = event.to; revision.candidate_sha256 = evidence.candidate_sha256;
        revision.phase_evidence = [...(revision.phase_evidence || []), { ...evidence, sequence: event.sequence }];
        return;
    }
    if (event.type === 'task.revision.promoted') {
        if (event.expected_sequence !== event.sequence - 1
            || parent.version_id !== revision.parent_version_id || event.parent_version_id !== parent.version_id)
            fail('DUAL_REVISION_CAS_FAILED', 'Promotion parent CAS failed');
        checkBinding(revision, event);
        if (revision.state !== 'PROMOTING' || event.candidate_sha256 !== revision.candidate_sha256)
            fail('DUAL_REVISION_EVIDENCE_REQUIRED', 'Promotion requires the current READY candidate');
        const evidence = requireEvidence(task, revision, event, context, 'integration');
        if (evidence.candidate_sha256 !== event.candidate_sha256) fail('DUAL_REVISION_EVIDENCE_REQUIRED', 'Promotion digest mismatch');
        const version = { version_id: event.version_id, parent_version_id: parent.version_id, revision_id: revision.revision_id,
            attempt: revision.attempt, contract_sha256: revision.contract_sha256, source_fingerprint: event.integrated_source_fingerprint,
            candidate_sha256: event.candidate_sha256, evidence };
        task.verified_versions.push(version); task.current_verified_version = version; revision.state = 'PROMOTED';
        return;
    }
    fail('DUAL_REVISION_INVALID', 'Unknown revision event');
}
function projectRevisionAuthority(derived, taskId, revisionId) {
    const parent = derived.tasks[taskId], candidate = parent?.active_revision;
    if (derived.sessionState !== 'ACCEPTANCE' || !candidate || candidate.revision_id !== revisionId || terminalRevision(candidate)
        || candidate.state === 'REQUESTED') fail('DUAL_REVISION_STALE', 'Candidate authority is not active');
    const policy = candidate.contract.candidate_plan?.acceptance_policy;
    const policyHash = policy ? require('./acceptance-policy').hashAcceptancePolicy(policy) : null;
    return { ...derived, plan: policy ? { ...derived.plan, ...candidate.contract.candidate_plan,
        acceptancePolicy: policy, acceptance_policy: policy, acceptancePolicySha256: policyHash, acceptance_policy_sha256: policyHash } : derived.plan,
        reviewExecutions: candidate.reviewExecutions || {}, reviewAttestations: candidate.reviewAttestations || {},
        review_executions: candidate.reviewExecutions || {}, review_attestations: candidate.reviewAttestations || {}, sessionState: 'EXECUTING', tasks: { ...derived.tasks, [taskId]: { ...candidate,
        state: 'ROUTED', revision_phase: candidate.state } },
        gates: Object.fromEntries(Object.entries(derived.gates).filter(([key]) => key.startsWith(`revision-${revisionId}-${candidate.attempt}-`))
            .map(([key, value]) => [key.slice(`revision-${revisionId}-${candidate.attempt}-`.length), value])),
        leases: Object.fromEntries(Object.entries(derived.leases).filter(([, lease]) => lease.revision_id === revisionId && lease.attempt === candidate.attempt)),
        revisionContext: { revision_id: revisionId, attempt: candidate.attempt, task_id: taskId,
            contract_digest: candidate.contract_sha256, plan: candidate.contract.candidate_plan } };
}
module.exports = { revisionDigest, revisionRequestDigest, terminalRevision, currentVerifiedVersion, reduceRevisionEvent, projectRevisionAuthority };
