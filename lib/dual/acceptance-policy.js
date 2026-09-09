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

const AcceptancePolicySchema = z.object({
    protocol_version: z.literal(1),
    checks: z.array(AcceptanceCheckSchema).max(1024),
    ui: AcceptanceUiSchema.optional(),
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

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
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
    return parsedEvidence.data;
}

function evaluateCheckResults(checks, checkResults) {
    const byId = new Map(checkResults.map((result) => [result.check_id, result]));
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

module.exports = {
    AcceptanceCommandSchema,
    AcceptanceCheckSchema,
    AcceptancePolicySchema,
    AcceptanceUiSchema,
    ReviewCheckResultSchema,
    ReviewEvidenceSchema,
    hashAcceptancePolicy,
    validateAcceptancePolicy,
    validateReviewEvidence,
    evaluatePreIntegrationReview,
    evaluateSessionAcceptance,
};
