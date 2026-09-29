'use strict';

const crypto = require('node:crypto');
const { z } = require('zod');

const SHA256 = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const AcceptanceCommandSchema = z.object({
    program: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    args: z.array(z.string().max(256).refine((arg) => !arg.includes('\0'), 'must not contain NUL')).max(100),
    cwd: z.string().min(1).max(512),
}).strict();

const AcceptanceRepoPathSchema = z.string().min(1).max(512).refine((candidate) => {
    if (candidate.includes('\0') || candidate.includes(':') || candidate.includes('\\')) return false;
    if (candidate.startsWith('/') || candidate.split('/').some((part) => !part || part === '..' || part === '.')) return false;
    return true;
}, 'must be a safe repository-relative path');

const AcceptanceCheckSchema = z.object({
    id: z.string().regex(ID),
    requirement_id: z.string().regex(ID),
    task_id: z.string().regex(ID).optional(),
    phase: z.enum(['pre_integration', 'session']),
    kind: z.enum(['command', 'review']),
    required: z.boolean(),
    command: AcceptanceCommandSchema.optional(),
}).strict().superRefine((check, ctx) => {
    if (check.phase === 'pre_integration' && !check.task_id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['task_id'], message: 'pre_integration checks require task_id' });
    }
    if (check.phase === 'session' && check.task_id !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['task_id'], message: 'session checks cannot target a task' });
    }
    if (check.kind === 'command' && !check.command) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: 'command checks require a typed command' });
    }
    if (check.kind === 'review' && check.command !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['command'], message: 'review checks cannot carry a command' });
    }
});

const AcceptanceUiSchema = z.object({
    required: z.boolean(),
    viewport_widths: z.array(z.number().int().min(240).max(4096)).min(1).max(10)
        .refine((widths) => new Set(widths).size === widths.length, 'viewport_widths must be unique'),
    reduced_motion_required: z.literal(true),
}).strict();

const AcceptanceCorrectionGrantSchema = z.object({
    failure_check_id: z.string().regex(ID),
    task_id: z.string().regex(ID),
    allowed_files: z.array(AcceptanceRepoPathSchema).min(1).max(10),
    validation_commands: z.array(AcceptanceCommandSchema).min(1).max(50),
}).strict();

const AcceptancePolicySchema = z.object({
    protocol_version: z.literal(1),
    checks: z.array(AcceptanceCheckSchema).max(1024),
    ui: AcceptanceUiSchema.optional(),
    correction_grants: z.array(AcceptanceCorrectionGrantSchema).max(1024).optional(),
}).strict();

const ReviewFindingSchema = z.string().min(1).max(512);
const ReviewCheckResultSchema = z.object({
    check_id: z.string().regex(ID),
    status: z.enum(['PASS', 'FAIL', 'BLOCKED', 'UNAVAILABLE']),
    findings: z.array(ReviewFindingSchema).max(64),
}).strict();

const ReviewEvidenceSchema = z.object({
    policy_sha256: z.string().regex(SHA256),
    task_id: z.string().regex(ID),
    result_sha256: z.string().regex(SHA256),
    check_results: z.array(ReviewCheckResultSchema).max(128),
    evidence_sha256: z.string().regex(SHA256),
}).strict();

const ReviewExecutionSchema = z.object({
    schema_version: z.literal(1),
    review_execution_id: z.string().uuid(),
    session_id: z.string().min(1).max(128),
    task_id: z.string().regex(ID),
    plan_revision: z.number().int().positive().max(100000),
    policy_sha256: z.string().regex(SHA256),
    result_sha256: z.string().regex(SHA256),
    diff_fingerprint: z.string().regex(SHA256),
    review_phase: z.enum(['pre_integration', 'post_integration']),
    reviewer_role: z.literal('codex'),
    provenance_mode: z.literal('fresh'),
}).strict();

const ReviewSubmissionSchema = z.object({
    review_execution_id: z.string().uuid(),
    check_results: z.array(ReviewCheckResultSchema).max(128),
}).strict();

const ReviewAttestationSchema = ReviewExecutionSchema.extend({
    check_results: z.array(ReviewCheckResultSchema).max(128),
    evidence_sha256: z.string().regex(SHA256),
    attestation_sha256: z.string().regex(SHA256),
}).strict();

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function canonicalReviewEvidencePayload(evidence) {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        throw policyError('DUAL_ACCEPTANCE_EVIDENCE_INVALID', 'Review evidence must be an object');
    }
    const { evidence_sha256: _ignored, ...unsigned } = evidence;
    return JSON.stringify(stableValue(unsigned));
}

function hashReviewEvidence(evidence) {
    return crypto.createHash('sha256')
        .update(canonicalReviewEvidencePayload(evidence))
        .digest('hex');
}

function canonicalReviewAttestationPayload(attestation) {
    if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
        throw policyError('DUAL_REVIEW_ATTESTATION_INVALID', 'Review attestation must be an object');
    }
    const { attestation_sha256: _ignored, ...unsigned } = attestation;
    return JSON.stringify(stableValue(unsigned));
}

function hashReviewAttestation(attestation) {
    return crypto.createHash('sha256')
        .update(canonicalReviewAttestationPayload(attestation))
        .digest('hex');
}

function createReviewAttestation(execution, submission) {
    const parsedExecution = ReviewExecutionSchema.safeParse(execution);
    const parsedSubmission = ReviewSubmissionSchema.safeParse(submission);
    if (!parsedExecution.success || !parsedSubmission.success) {
        throw policyError('DUAL_REVIEW_ATTESTATION_INVALID', 'Review execution or findings schema is invalid');
    }
    if (parsedSubmission.data.review_execution_id !== parsedExecution.data.review_execution_id) {
        throw policyError('DUAL_REVIEW_EXECUTION_MISMATCH', 'Review submission does not match its prepared execution');
    }
    const reviewEvidence = {
        policy_sha256: parsedExecution.data.policy_sha256,
        task_id: parsedExecution.data.task_id,
        result_sha256: parsedExecution.data.result_sha256,
        check_results: parsedSubmission.data.check_results,
    };
    const unsigned = {
        ...parsedExecution.data,
        check_results: parsedSubmission.data.check_results,
        evidence_sha256: hashReviewEvidence(reviewEvidence),
    };
    return ReviewAttestationSchema.parse({
        ...unsigned,
        attestation_sha256: hashReviewAttestation(unsigned),
    });
}

function validateReviewAttestation(attestation) {
    const parsed = ReviewAttestationSchema.safeParse(attestation);
    if (!parsed.success) {
        throw policyError('DUAL_REVIEW_ATTESTATION_INVALID', 'Review attestation schema is invalid');
    }
    const expected = hashReviewAttestation(parsed.data);
    if (!safeDigestEqual(expected, parsed.data.attestation_sha256)) {
        throw policyError('DUAL_REVIEW_ATTESTATION_INVALID', 'Review attestation digest is invalid');
    }
    const evidence = {
        policy_sha256: parsed.data.policy_sha256,
        task_id: parsed.data.task_id,
        result_sha256: parsed.data.result_sha256,
        check_results: parsed.data.check_results,
    };
    if (!safeDigestEqual(hashReviewEvidence(evidence), parsed.data.evidence_sha256)) {
        throw policyError('DUAL_REVIEW_ATTESTATION_INVALID', 'Review evidence digest is invalid');
    }
    return parsed.data;
}

function reviewAttestationEvidence(attestation) {
    const parsed = validateReviewAttestation(attestation);
    return {
        policy_sha256: parsed.policy_sha256,
        task_id: parsed.task_id,
        result_sha256: parsed.result_sha256,
        check_results: parsed.check_results,
        evidence_sha256: parsed.evidence_sha256,
    };
}

function safeDigestEqual(expected, actual) {
    if (typeof expected !== 'string' || typeof actual !== 'string'
        || !SHA256.test(expected) || !SHA256.test(actual)) return false;
    const left = Buffer.from(expected, 'hex');
    const right = Buffer.from(actual, 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function policyError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function validateAcceptancePolicy(value, { taskIds = [] } = {}) {
    const parsed = AcceptancePolicySchema.safeParse(value);
    if (!parsed.success) {
        throw policyError('DUAL_ACCEPTANCE_POLICY_INVALID', parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
    }
    const knownTasks = new Set(taskIds);
    const checkIds = new Set();
    const requirementChecks = new Map();
    for (const check of parsed.data.checks) {
        if (checkIds.has(check.id)) throw policyError('DUAL_ACCEPTANCE_POLICY_INVALID', `Duplicate acceptance check id: ${check.id}`);
        checkIds.add(check.id);
        if (check.task_id && knownTasks.size && !knownTasks.has(check.task_id)) {
            throw policyError('DUAL_ACCEPTANCE_POLICY_INVALID', `Acceptance check ${check.id} targets unknown task ${check.task_id}`);
        }
        const list = requirementChecks.get(check.requirement_id) || [];
        list.push(check);
        requirementChecks.set(check.requirement_id, list);
    }
    for (const [requirementId, checks] of requirementChecks) {
        if (!checks.some((check) => check.required)) {
            throw policyError('DUAL_ACCEPTANCE_POLICY_INVALID', `Requirement ${requirementId} has no required acceptance check`);
        }
    }
    const reviewChecks = new Map(parsed.data.checks.map((check) => [check.id, check]));
    const grantIds = new Set();
    for (const grant of parsed.data.correction_grants || []) {
        if (grantIds.has(grant.failure_check_id)) {
            throw policyError('DUAL_ACCEPTANCE_POLICY_INVALID', `Duplicate correction grant for check ${grant.failure_check_id}`);
        }
        grantIds.add(grant.failure_check_id);
        if (knownTasks.size && !knownTasks.has(grant.task_id)) {
            throw policyError('DUAL_ACCEPTANCE_POLICY_INVALID', `Correction grant ${grant.failure_check_id} targets unknown task ${grant.task_id}`);
        }
        const check = reviewChecks.get(grant.failure_check_id);
        if (!check || check.phase !== 'session' || check.kind !== 'review' || check.required !== true) {
            throw policyError('DUAL_ACCEPTANCE_POLICY_INVALID', `Correction grant ${grant.failure_check_id} must target a required session review check`);
        }
    }
    return { ok: true, policy: parsed.data };
}

function hashAcceptancePolicy(value) {
    const { policy } = validateAcceptancePolicy(value);
    return crypto.createHash('sha256').update(JSON.stringify(stableValue(policy))).digest('hex');
}

function validateReviewEvidence(policy, evidence, { taskId, resultSha256 } = {}) {
    const { policy: parsedPolicy } = validateAcceptancePolicy(policy, { taskIds: taskId ? [taskId] : [] });
    const parsedEvidence = ReviewEvidenceSchema.safeParse(evidence);
    if (!parsedEvidence.success) throw policyError('DUAL_ACCEPTANCE_EVIDENCE_INVALID', 'Review evidence schema is invalid');
    if (parsedEvidence.data.policy_sha256 !== hashAcceptancePolicy(parsedPolicy)) {
        throw policyError('DUAL_ACCEPTANCE_POLICY_STALE', 'Review evidence policy hash does not match the registered policy');
    }
    if (taskId && parsedEvidence.data.task_id !== taskId) {
        throw policyError('DUAL_ACCEPTANCE_TASK_MISMATCH', 'Review evidence task does not match the registered task');
    }
    if (resultSha256 && parsedEvidence.data.result_sha256 !== resultSha256) {
        throw policyError('DUAL_ACCEPTANCE_RESULT_STALE', 'Review evidence result hash does not match the current candidate result');
    }
    const seenCheckIds = new Set();
    for (const result of parsedEvidence.data.check_results) {
        if (seenCheckIds.has(result.check_id)) {
            throw policyError('DUAL_ACCEPTANCE_EVIDENCE_INVALID', `Duplicate review check id: ${result.check_id}`);
        }
        seenCheckIds.add(result.check_id);
    }
    const expectedEvidenceSha = hashReviewEvidence(parsedEvidence.data);
    if (!safeDigestEqual(expectedEvidenceSha, parsedEvidence.data.evidence_sha256)) {
        throw policyError('DUAL_ACCEPTANCE_EVIDENCE_TAMPERED', 'Review evidence digest does not match canonical findings');
    }
    return parsedEvidence.data;
}

function evaluateCheckResults(checks, checkResults) {
    const byId = new Map();
    for (const result of checkResults) {
        if (byId.has(result.check_id)) {
            throw policyError('DUAL_ACCEPTANCE_EVIDENCE_INVALID', `Duplicate review check id: ${result.check_id}`);
        }
        byId.set(result.check_id, result);
    }
    const known = new Set(checks.map((check) => check.id));
    for (const result of checkResults) {
        if (!known.has(result.check_id)) throw policyError('DUAL_ACCEPTANCE_EVIDENCE_INVALID', `Unknown acceptance check result: ${result.check_id}`);
    }
    const missing = checks.filter((check) => check.required && !byId.has(check.id)).map((check) => check.id);
    const failed = checks.filter((check) => {
        const result = byId.get(check.id);
        return result && check.required && result.status !== 'PASS';
    }).map((check) => ({ check_id: check.id, status: byId.get(check.id).status, findings: byId.get(check.id).findings }));
    return { missing, failed };
}

function evaluatePreIntegrationReview(policy, evidence, { taskId, resultSha256 } = {}) {
    const validated = validateReviewEvidence(policy, evidence, { taskId, resultSha256 });
    const checks = policy.checks.filter((check) => check.phase === 'pre_integration' && check.task_id === validated.task_id);
    const result = evaluateCheckResults(checks, validated.check_results);
    if (result.failed.length) return { status: 'NEEDS_FIX', missing: result.missing, failed: result.failed };
    if (result.missing.length) return { status: 'NEEDS_REVIEW', missing: result.missing, failed: [] };
    return { status: 'PASSED', missing: [], failed: [] };
}

function evaluateSessionAcceptance(policy, checkResults) {
    const parsed = AcceptancePolicySchema.parse(policy);
    const results = ReviewCheckResultSchema.array().parse(checkResults);
    const result = evaluateCheckResults(parsed.checks.filter((check) => check.phase === 'session'), results);
    if (result.failed.length || result.missing.length) return { status: 'BLOCKED', ...result };
    return { status: 'PASSED', missing: [], failed: [] };
}

function evaluatePostIntegrationReview(policy, evidence, { taskId, resultSha256 } = {}) {
    const validated = validateReviewEvidence(policy, evidence, { taskId, resultSha256 });
    const parsedPolicy = AcceptancePolicySchema.parse(policy);
    const grants = (parsedPolicy.correction_grants || []).filter((grant) => grant.task_id === validated.task_id);
    const grantByCheckId = new Map(grants.map((grant) => [grant.failure_check_id, grant]));
    // Post-integration review covers every registered session check. A check
    // may be required for acceptance without granting a worker correction;
    // such failures remain durable blockers rather than being rejected as an
    // invalid review request.
    const checks = parsedPolicy.checks.filter((check) => check.phase === 'session');
    const result = evaluateCheckResults(checks, validated.check_results);
    const failedGrant = result.failed
        .filter((failure) => failure.status === 'FAIL')
        .map((failure) => grantByCheckId.get(failure.check_id)).find(Boolean);
    if (result.failed.length) return { status: 'NEEDS_FIX', missing: result.missing, failed: result.failed, correction_grant: failedGrant };
    if (result.missing.length) return { status: 'NEEDS_REVIEW', missing: result.missing, failed: [] };
    return { status: 'PASSED', missing: [], failed: [], correction_grant: null };
}

function evaluateAttestedReview(policy, evidence, { reviewPhase, taskId, resultSha256 } = {}) {
    if (!['pre_integration', 'post_integration'].includes(reviewPhase)) {
        throw policyError('DUAL_REVIEW_ATTESTATION_INVALID', 'Review phase is invalid');
    }
    const validated = validateReviewEvidence(policy, evidence, { taskId, resultSha256 });
    const parsedPolicy = AcceptancePolicySchema.parse(policy);
    const policyPhase = reviewPhase === 'post_integration' ? 'session' : 'pre_integration';
    const checks = parsedPolicy.checks.filter((check) => check.kind === 'review'
        && check.phase === policyPhase
        && (reviewPhase !== 'pre_integration' || check.task_id === taskId));
    const result = evaluateCheckResults(checks, validated.check_results);
    if (result.failed.length) {
        const grants = parsedPolicy.correction_grants || [];
        const correctionGrant = reviewPhase === 'post_integration'
            ? result.failed.filter((failure) => failure.status === 'FAIL')
                .map((failure) => grants.find((grant) => grant.task_id === taskId
                    && grant.failure_check_id === failure.check_id)).find(Boolean)
            : null;
        return { status: 'NEEDS_FIX', missing: result.missing, failed: result.failed, correction_grant: correctionGrant || null };
    }
    if (result.missing.length) return { status: 'NEEDS_REVIEW', missing: result.missing, failed: [] };
    return { status: 'PASSED', missing: [], failed: [], correction_grant: null };
}

module.exports = {
    AcceptanceCommandSchema,
    AcceptanceRepoPathSchema,
    AcceptanceCorrectionGrantSchema,
    AcceptanceCheckSchema,
    AcceptancePolicySchema,
    AcceptanceUiSchema,
    ReviewCheckResultSchema,
    ReviewEvidenceSchema,
    ReviewExecutionSchema,
    ReviewSubmissionSchema,
    ReviewAttestationSchema,
    canonicalReviewEvidencePayload,
    hashReviewEvidence,
    canonicalReviewAttestationPayload,
    hashReviewAttestation,
    createReviewAttestation,
    validateReviewAttestation,
    reviewAttestationEvidence,
    hashAcceptancePolicy,
    validateAcceptancePolicy,
    validateReviewEvidence,
    evaluatePreIntegrationReview,
    evaluatePostIntegrationReview,
    evaluateAttestedReview,
    evaluateSessionAcceptance,
};
