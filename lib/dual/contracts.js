'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const GIT_OBJECT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const TaskIdSchema = z.string().regex(TASK_ID_PATTERN);
const GitObjectIdSchema = z.string().regex(GIT_OBJECT_PATTERN);
const Sha256Schema = z.string().regex(SHA256_PATTERN);
const RepoPathSchema = z.string().min(1);
const StrictPlanRepoPathSchema = z.string().min(1).max(512).refine((candidate) => {
    if (candidate.includes('\0') || candidate.includes(':')) return false;
    if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || path.posix.isAbsolute(candidate)) return false;
    const slashPath = candidate.replace(/\\/g, '/');
    const segments = slashPath.split('/');
    if (segments.some((segment) => segment === '..' || segment.length === 0)) return false;
    const normalized = path.posix.normalize(slashPath).replace(/^\.\//, '');
    return normalized.length > 0 && normalized !== '.' && !normalized.startsWith('../');
}, 'must be a safe repository-relative path');
const PhaseSchema = z.enum(['preflight', 'scout', 'spec', 'route', 'implement', 'scope', 'review']);
const StateSchema = z.enum([
    'NEW',
    'PREFLIGHT_SAFE',
    'SCOUT_VALID',
    'SPEC_VALID',
    'ROUTED',
    'CODEX_OWNED',
    'IMPLEMENT_VALID',
    'SCOPE_VALID',
    'REVIEW_VALID',
    'CODEX_QC',
]);

const GitCorrelationShape = {
    schema_version: z.literal(1),
    task_id: TaskIdSchema,
    expected_base_commit: GitObjectIdSchema,
};

const SnapshotCorrelationShape = {
    schema_version: z.literal(1),
    task_id: TaskIdSchema,
    expected_baseline: z.object({
        kind: z.literal('snapshot'),
        id: Sha256Schema,
    }).strict(),
};

function createCorrelatedSchema(fields) {
    return z.union([
        z.object({
            ...GitCorrelationShape,
            ...fields,
        }).strict(),
        z.object({
            ...SnapshotCorrelationShape,
            ...fields,
        }).strict(),
    ]);
}

const ValidationCommandSchema = z.object({
    program: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1).default('.'),
}).strict();

const DualPlanValidationCommandSchema = z.object({
    program: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    args: z.array(z.string().max(256).refine((arg) => !arg.includes('\0'), 'must not contain NUL')).max(100),
    cwd: z.union([z.literal('.'), StrictPlanRepoPathSchema]),
}).strict();

const DualPlanTaskSchema = z.object({
    task_id: TaskIdSchema,
    title: z.string().min(1).max(256),
    owner: z.enum(['codex', 'agy']),
    goal: z.string().min(1).max(1024),
    category: z.string().min(1).max(128),
    complexity: z.string().min(1).max(128),
    risk: z.string().min(1).max(128),
    allowed_files: z.array(StrictPlanRepoPathSchema).min(1).max(100),
    context_files: z.array(StrictPlanRepoPathSchema).max(100),
    deny_patterns: z.array(z.string().min(1).max(256)).max(100),
    validation_commands: z.array(DualPlanValidationCommandSchema).max(50),
}).strict().superRefine((task, ctx) => {
    if (['setup', 'planning', 'qa', 'review', 'verification'].includes(task.category.toLowerCase())) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['category'],
            message: 'setup/planning/QA/review belong to the bootstrap controller or completion gates, not execution tasks',
        });
    }
    if (task.owner === 'agy' && task.allowed_files.length > 10) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowed_files'], message: 'AGY tasks require 1-10 allowed_files' });
    }
    if (task.owner === 'agy' && task.validation_commands.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['validation_commands'], message: 'AGY tasks require validation_commands' });
    }
});

const DualPlanManifestSchema = z.object({
    schema_version: z.literal(1),
    plan_revision: z.number().int().positive().max(100000),
    tasks: z.array(DualPlanTaskSchema).min(1).max(500),
}).strict().superRefine((manifest, ctx) => {
    const seen = new Set();
    let agyTasks = 0;
    for (let index = 0; index < manifest.tasks.length; index++) {
        const task = manifest.tasks[index];
        const taskId = task.task_id;
        if (task.owner === 'agy') agyTasks++;
        if (seen.has(taskId)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tasks', index, 'task_id'], message: `duplicate task_id: ${taskId}` });
        }
        seen.add(taskId);
    }
    if (agyTasks > 1) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tasks'],
            message: 'A Dual session supports at most one AGY task against its immutable baseline',
        });
    }
});

const ContextSchema = createCorrelatedSchema({
    summary: z.string().min(1),
    relevant_files: z.array(z.object({
        path: RepoPathSchema,
        description: z.string(),
    }).strict()),
    exact_symbols: z.array(z.object({
        name: z.string().min(1),
        file: RepoPathSchema,
        verified: z.boolean(),
        kind: z.string().optional(),
    }).strict()),
    validation_commands: z.array(z.string()),
    constraints: z.array(z.string()),
    risks: z.array(z.string()),
    open_questions: z.array(z.string()),
    research_trace: z.array(z.object({
        question: z.string().min(1),
        source: z.string().min(1),
        source_type: z.enum(['REPOSITORY', 'OFFICIAL_DOCS', 'TEST_OUTPUT']),
        conclusion: z.string().min(1),
    }).strict()).min(2),
    alternatives_considered: z.array(z.object({
        option: z.string().min(1),
        tradeoff: z.string().min(1),
    }).strict()).min(2),
    failure_modes: z.array(z.string().min(1)).min(1),
});

const SpecSchema = createCorrelatedSchema({
    goal: z.string().min(1),
    allowed_files: z.array(RepoPathSchema).min(1),
    deny_patterns: z.array(z.string().min(1)),
    validation_commands: z.array(ValidationCommandSchema).min(1),
    risk_flags: z.array(z.string()),
    permission_authority: z.literal('dual-init-dangerous-auto-v1'),
});

const RouteSchema = createCorrelatedSchema({
    owner: z.enum(['codex', 'gemini']),
    model: z.literal('gemini-3.7-flash-high').nullable(),
    effort: z.literal('high').nullable(),
    token_budget: z.number().int().positive().nullable(),
    allowed_files: z.array(RepoPathSchema),
    reason: z.string().min(1),
});

const EvidenceSchema = createCorrelatedSchema({
    status: z.enum(['SUCCESS', 'FAILURE', 'BLOCKED']),
    modified_files: z.array(RepoPathSchema),
    command_outputs: z.array(z.object({
        command: z.string(),
        exit_code: z.number().int(),
        output: z.string(),
    }).strict()),
    unverified_items: z.array(z.string()),
    self_review: z.object({
        checks: z.array(z.string().min(1)).min(3),
        remaining_risks: z.array(z.string()),
    }).strict(),
});

const ReviewSchema = createCorrelatedSchema({
    recommendation: z.enum(['APPROVE', 'NEEDS_FIX', 'REJECT']),
    risk_level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    findings: z.array(z.object({
        file: RepoPathSchema,
        line: z.number().int().positive().optional(),
        description: z.string().min(1),
        severity: z.enum(['INFO', 'WARNING', 'ERROR']),
    }).strict()),
    review_checks: z.array(z.string().min(1)).min(3),
    challenge_summary: z.string().min(1),
});

const GitEventBaseShape = {
    ...GitCorrelationShape,
    event_id: z.string().uuid(),
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime({ offset: true }),
};

const SnapshotEventBaseShape = {
    ...SnapshotCorrelationShape,
    event_id: z.string().uuid(),
    sequence: z.number().int().positive(),
    timestamp: z.string().datetime({ offset: true }),
};

const EventSchema = z.union([
    z.object({
        ...GitEventBaseShape,
        type: z.literal('transaction.created'),
        state: z.literal('NEW'),
    }).strict(),
    z.object({
        ...SnapshotEventBaseShape,
        type: z.literal('transaction.created'),
        state: z.literal('NEW'),
    }).strict(),
    z.object({
        ...GitEventBaseShape,
        type: z.literal('phase.started'),
        phase: PhaseSchema,
        attempt: z.number().int().positive(),
    }).strict(),
    z.object({
        ...SnapshotEventBaseShape,
        type: z.literal('phase.started'),
        phase: PhaseSchema,
        attempt: z.number().int().positive(),
    }).strict(),
    z.object({
        ...GitEventBaseShape,
        type: z.literal('phase.completed'),
        phase: PhaseSchema,
        attempt: z.number().int().positive(),
        from_state: StateSchema,
        to_state: StateSchema,
        artifact_hashes: z.record(z.string(), Sha256Schema),
        warnings: z.array(z.string()).default([]),
        capability_evidence: z.object({
            agy_version: z.string().min(1),
            agy_model: z.literal('gemini-3.7-flash-high'),
        }).strict().optional(),
    }).strict(),
    z.object({
        ...SnapshotEventBaseShape,
        type: z.literal('phase.completed'),
        phase: PhaseSchema,
        attempt: z.number().int().positive(),
        from_state: StateSchema,
        to_state: StateSchema,
        artifact_hashes: z.record(z.string(), Sha256Schema),
        warnings: z.array(z.string()).default([]),
        capability_evidence: z.object({
            agy_version: z.string().min(1),
            agy_model: z.literal('gemini-3.7-flash-high'),
        }).strict().optional(),
    }).strict(),
    z.object({
        ...GitEventBaseShape,
        type: z.literal('phase.failed'),
        phase: PhaseSchema,
        attempt: z.number().int().positive(),
        error_code: z.string().min(1),
        retryable: z.boolean(),
    }).strict(),
    z.object({
        ...SnapshotEventBaseShape,
        type: z.literal('phase.failed'),
        phase: PhaseSchema,
        attempt: z.number().int().positive(),
        error_code: z.string().min(1),
        retryable: z.boolean(),
    }).strict(),
    z.object({
        ...GitEventBaseShape,
        type: z.literal('handoff.completed'),
        owner: z.literal('codex'),
        from_state: z.enum(['ROUTED', 'REVIEW_VALID']),
        to_state: z.enum(['CODEX_OWNED', 'CODEX_QC']),
        reason: z.enum(['codex_route', 'final_qc']),
    }).strict(),
    z.object({
        ...SnapshotEventBaseShape,
        type: z.literal('handoff.completed'),
        owner: z.literal('codex'),
        from_state: z.enum(['ROUTED', 'REVIEW_VALID']),
        to_state: z.enum(['CODEX_OWNED', 'CODEX_QC']),
        reason: z.enum(['codex_route', 'final_qc']),
    }).strict(),
]);

const AttemptMetaSchema = createCorrelatedSchema({
    phase: PhaseSchema,
    attempt: z.number().int().positive(),
    package_version: z.string().min(1),
    agy_version: z.string().min(1),
    started_at: z.string().datetime({ offset: true }),
    ended_at: z.string().datetime({ offset: true }),
    duration_ms: z.number().int().nonnegative(),
    exit_code: z.number().int().nullable(),
    timed_out: z.boolean(),
    cwd: z.string().min(1),
    redacted_argv: z.array(z.string()),
    shell: z.literal(false),
    input_sha256: Sha256Schema,
    schema_sha256: Sha256Schema,
});

const BaselineIdentitySchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('git'), id: GitObjectIdSchema }).strict(),
    z.object({ kind: z.literal('snapshot'), id: Sha256Schema }).strict(),
]);

const GateStatusSchema = z.enum([
    'PASSED', 'FAILED', 'BLOCKED', 'UNAVAILABLE', 'OPTIONAL_SKIPPED',
]);

const SessionStateSchema = z.enum([
    'DISCOVERED', 'CAPABILITY_SAFE', 'INTERVIEWING', 'PLANNED',
    'EXECUTING', 'ACCEPTANCE', 'VERIFIED', 'BLOCKED',
]);

const TaskAuthorityStateSchema = z.enum([
    'REGISTERED', 'ROUTED', 'AGY_SCOUT', 'AGY_IMPLEMENT', 'SCOPE_VALID',
    'AGY_REVIEW', 'CODEX_IMPLEMENT', 'CODEX_QC', 'TASK_VERIFIED', 'BLOCKED',
]);

const PACKAGE_MANAGER_PROGRAMS = ['npm', 'pnpm', 'yarn', 'bun'];
const PackageManagerProgramSchema = z.enum(['auto', ...PACKAGE_MANAGER_PROGRAMS]);
const NativeSetupProgramSchema = z.string().min(1).refine(
    (program) => {
        const lower = program.toLowerCase();
        return !PACKAGE_MANAGER_PROGRAMS.some((manager) => (
            lower === manager ||
            lower === `${manager}.cmd` ||
            lower === `${manager}.bat` ||
            lower === `${manager}.ps1`
        ));
    },
    { message: 'Package-manager identifiers require kind "package-manager"' }
);

const SetupActionSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('native'),
        program: NativeSetupProgramSchema,
        args: z.array(z.string()),
        cwd: RepoPathSchema.default('.'),
    }).strict(),
    z.object({
        kind: z.literal('node-cli'),
        program: z.string().min(1),
        args: z.array(z.string()),
        cwd: RepoPathSchema.default('.'),
    }).strict(),
    z.object({
        kind: z.literal('package-manager'),
        program: PackageManagerProgramSchema,
        args: z.array(z.string()),
        cwd: RepoPathSchema.default('.'),
    }).strict(),
]);

const SessionEventBaseShape = {
    schema_version: z.literal(2),
    event_id: z.string().uuid(),
    causation_id: z.string().uuid(),
    sequence: z.number().int().positive(),
    workspace_id: z.string().min(1),
    session_id: z.string().min(1),
    plan_revision: z.number().int().positive(),
    expected_baseline: BaselineIdentitySchema,
    timestamp: z.string().datetime({ offset: true }),
};

const SessionEventSchema = z.discriminatedUnion('type', [
    z.object({
        ...SessionEventBaseShape,
        type: z.literal('session.created'),
        state: z.literal('DISCOVERED'),
        workspace_root: RepoPathSchema,
        mode: z.literal('auto'),
    }).strict(),
    z.object({
        ...SessionEventBaseShape,
        type: z.literal('capability.result'),
        from_state: z.literal('DISCOVERED'),
        status: GateStatusSchema,
        checks: z.array(z.object({
            name: z.string().min(1),
            status: GateStatusSchema,
            reason: z.string().optional(),
        }).strict()).min(1),
        details: z.record(z.string(), z.unknown()).optional(),
        to_state: z.enum(['CAPABILITY_SAFE', 'BLOCKED']),
    }).strict().superRefine((val, ctx) => {
        if (val.status === 'PASSED' && val.to_state !== 'CAPABILITY_SAFE') {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "status 'PASSED' requires to_state 'CAPABILITY_SAFE'",
                path: ['to_state'],
            });
        } else if (val.status !== 'PASSED' && val.to_state !== 'BLOCKED') {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `status '${val.status}' requires to_state 'BLOCKED'`,
                path: ['to_state'],
            });
        }
    }),
    z.object({
        ...SessionEventBaseShape,
        type: z.literal('plan.registered'),
        from_state: z.literal('INTERVIEWING'),
        to_state: z.literal('PLANNED'),
        plan_path: RepoPathSchema,
        plan_sha256: Sha256Schema,
        total_tasks: z.number().int().positive(),
        tasks: z.array(z.object({
            task_id: TaskIdSchema,
            title: z.string().min(1),
            owner: z.enum(['codex', 'agy']),
            allowed_files: z.array(RepoPathSchema),
            goal: z.string().min(1).optional(),
            category: z.string().min(1).optional(),
            complexity: z.string().min(1).optional(),
            risk: z.string().min(1).optional(),
            deny_patterns: z.array(z.string().min(1)).optional(),
            validation_commands: z.array(ValidationCommandSchema).optional(),
        }).strict()).min(1),
    }).strict().refine((val) => val.tasks.length === val.total_tasks, {
        message: 'tasks count must match total_tasks',
        path: ['tasks'],
    }),
    z.object({
        ...SessionEventBaseShape,
        type: z.literal('task.routed'),
        task_id: TaskIdSchema,
        owner: z.enum(['codex', 'agy']),
        authority_state: z.literal('ROUTED'),
        model: z.string().min(1).nullable().optional(),
        effort: z.string().min(1).nullable().optional(),
        token_budget: z.number().int().positive().nullable().optional(),
        allowed_files: z.array(RepoPathSchema),
        reason: z.string().min(1),
    }).strict(),
    z.object({
        ...SessionEventBaseShape,
        type: z.literal('lease.acquired'),
        lease_id: z.string().uuid(),
        task_id: TaskIdSchema,
        owner: z.enum(['codex', 'agy']),
        acquired_at: z.string().datetime({ offset: true }),
        expires_at: z.string().datetime({ offset: true }),
        ttl_ms: z.number().int().positive(),
    }).strict(),
    z.object({
        ...SessionEventBaseShape,
        type: z.literal('lease.renewed'),
        lease_id: z.string().uuid(),
        task_id: TaskIdSchema,
        renewed_at: z.string().datetime({ offset: true }),
        expires_at: z.string().datetime({ offset: true }),
        ttl_ms: z.number().int().positive(),
    }).strict(),
    z.object({
        ...SessionEventBaseShape,
        type: z.literal('lease.released'),
        lease_id: z.string().uuid(),
        task_id: TaskIdSchema,
        released_at: z.string().datetime({ offset: true }),
        reason: z.string().min(1),
    }).strict(),
    z.object({
        ...SessionEventBaseShape,
        type: z.literal('gate.result'),
        gate_id: z.string().min(1),
        status: GateStatusSchema,
        cycle_index: z.number().int().positive().optional(),
        task_id: TaskIdSchema.optional(),
        details: z.record(z.string(), z.unknown()).optional(),
        evidence_sha256: Sha256Schema,
        reason: z.string().min(1),
    }).strict(),
    z.object({
        ...SessionEventBaseShape,
        type: z.literal('task.completed'),
        task_id: TaskIdSchema,
        owner: z.enum(['codex', 'agy']),
        authority_state: z.literal('TASK_VERIFIED'),
        modified_files: z.array(RepoPathSchema),
        diff_fingerprint: Sha256Schema,
        verdict: z.literal('SUCCESS'),
        verified_by: z.literal('codex'),
    }).strict(),
    z.object({
        ...SessionEventBaseShape,
        type: z.literal('session.verified'),
        from_state: z.literal('ACCEPTANCE'),
        to_state: z.literal('VERIFIED'),
        receipt_sha256: Sha256Schema,
        completed_tasks: z.array(TaskIdSchema).min(1),
    }).strict(),
    z.object({
        ...SessionEventBaseShape,
        type: z.literal('session.blocked'),
        from_state: z.enum([
            'DISCOVERED', 'CAPABILITY_SAFE', 'INTERVIEWING', 'PLANNED',
            'EXECUTING', 'ACCEPTANCE',
        ]),
        to_state: z.literal('BLOCKED'),
        reason: z.string().min(1),
        blocker_code: z.string().min(1),
    }).strict(),
    z.object({
        ...SessionEventBaseShape,
        type: z.literal('baseline.promoted'),
        from_baseline: z.object({ kind: z.literal('snapshot'), id: Sha256Schema }).strict(),
        to_baseline: z.object({ kind: z.literal('git'), id: GitObjectIdSchema }).strict(),
    }).strict(),
]);

const QcCommandOutputSchema = z.object({
    command: z.string().min(1).max(256),
    exit_code: z.number().int(),
    duration_ms: z.number().int().min(0),
    output: z.string().max(16384).optional(),
}).strict();

const QcEvidenceSchema = z.object({
    task_id: TaskIdSchema,
    verdict: z.literal('SUCCESS'),
    plan_revision: z.number().int().positive().max(100000),
    diff_fingerprint: Sha256Schema,
    command_outputs: z.array(QcCommandOutputSchema).min(1).max(50),
    findings: z.array(z.string().max(256)).max(0),
    modified_files: z.array(RepoPathSchema),
}).strict();

const QualityGateResultSchema = z.object({
    id: z.string().min(1).max(128),
    required: z.boolean(),
    status: GateStatusSchema,
    reason: z.string().max(256).optional(),
}).strict();

const QualityCommandRecordSchema = z.object({
    command: z.string().min(1).max(256),
    exit_code: z.number().int(),
    duration_ms: z.number().int().min(0),
}).strict();

const QualityEvidenceSchema = z.object({
    cycle_index: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    attempt: z.number().int().min(1).max(3),
    total_tasks: z.number().int().min(1).max(1024),
    completed_task_ids: z.array(TaskIdSchema).min(1).max(1024),
    plan_revision: z.number().int().positive().max(100000),
    diff_fingerprint: Sha256Schema,
    gate_results: z.array(QualityGateResultSchema).min(1).max(100),
    commands: z.array(QualityCommandRecordSchema).min(1).max(50),
    evidence_sha256: Sha256Schema,
}).strict();

const UiRequirementSchema = z.object({
    gate_id: z.string().min(1).max(128),
    required: z.boolean(),
    viewport_widths: z.tuple([z.literal(390), z.literal(768), z.literal(1024), z.literal(1440)]),
    reduced_motion_required: z.literal(true),
}).strict();

const UiViewportRecordSchema = z.object({
    width: z.union([z.literal(390), z.literal(768), z.literal(1024), z.literal(1440)]),
    passed: z.boolean(),
    horizontal_overflow: z.boolean(),
}).strict();

const UiReducedMotionRecordSchema = z.object({
    tested: z.boolean(),
    passed: z.boolean(),
}).strict();

const UiEvidenceRecordSchema = z.object({
    runtime_status: z.enum(['AVAILABLE', 'UNAVAILABLE', 'BLOCKED']),
    evidence_sha256: Sha256Schema,
    viewports: z.array(UiViewportRecordSchema).max(10).optional(),
    reduced_motion: UiReducedMotionRecordSchema.optional(),
    reason: z.string().min(1).max(256).optional(),
}).strict();

const UiEvidenceSchema = z.object({
    requirement: UiRequirementSchema,
    evidence: UiEvidenceRecordSchema,
}).strict();

class DualContractError extends Error {
    constructor(label, issues) {
        const summary = issues
            .map((issue) => {
                const location = issue.path.length > 0 ? issue.path.join('.') : '<root>';
                return `${location}: ${issue.message}`;
            })
            .join('; ');
        super(`Invalid ${label} contract: ${summary}`);
        this.name = 'DualContractError';
        this.code = 'DUAL_CONTRACT_INVALID';
        this.label = label;
    }
}

function parseContract(schema, value, label = 'value') {
    let sanitized = value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const { toolAction, toolSummary, ...rest } = value;
        sanitized = rest;
    }
    const result = schema.safeParse(sanitized);
    if (!result.success) {
        throw new DualContractError(label, result.error.issues);
    }
    return result.data;
}

function normalizeBaselineCorrelation(value) {
    if (typeof value === 'string') {
        return parseContract(
            BaselineIdentitySchema,
            { kind: 'git', id: value },
            'baseline correlation'
        );
    }
    if (!value || typeof value !== 'object') {
        throw new DualContractError('baseline correlation', [{ path: [], message: 'Expected object' }]);
    }
    const hasBaseline = value.expected_baseline !== undefined;
    const hasBaseCommit = value.expected_base_commit !== undefined;

    if (hasBaseline && hasBaseCommit) {
        throw new DualContractError('baseline correlation', [
            { path: [], message: 'Cannot specify both expected_baseline and expected_base_commit' },
        ]);
    }
    if (hasBaseline) {
        return parseContract(BaselineIdentitySchema, value.expected_baseline, 'baseline correlation');
    }
    if (hasBaseCommit) {
        return parseContract(
            BaselineIdentitySchema,
            { kind: 'git', id: value.expected_base_commit },
            'baseline correlation'
        );
    }
    if (value.kind && value.id) {
        return parseContract(BaselineIdentitySchema, value, 'baseline correlation');
    }
    throw new DualContractError('baseline correlation', [
        { path: [], message: 'Missing expected_baseline or expected_base_commit' },
    ]);
}

function emitBaselineCorrelation(baseline) {
    const normalized = normalizeBaselineCorrelation(baseline);
    if (normalized.kind === 'git') {
        return { expected_base_commit: normalized.id };
    }
    if (normalized.kind === 'snapshot') {
        return { expected_baseline: { kind: 'snapshot', id: normalized.id } };
    }
    throw new DualContractError('baseline correlation', [
        { path: [], message: `Unknown baseline kind: ${normalized.kind}` },
    ]);
}

function toDraft7Schema(schema, id) {
    const raw = z.toJSONSchema(schema, { target: 'draft-7' });
    if (raw.anyOf && Array.isArray(raw.anyOf)) {
        for (const branch of raw.anyOf) {
            if (branch.properties) {
                branch.properties.toolAction = { type: 'string' };
                branch.properties.toolSummary = { type: 'string' };
            }
        }
    }
    return {
        $id: id,
        ...raw,
    };
}

const REQUIRED_PHASE_TRANSITIONS = [
    { phase: 'preflight', from: 'NEW', to: 'PREFLIGHT_SAFE' },
    { phase: 'scout', from: 'PREFLIGHT_SAFE', to: 'SCOUT_VALID' },
    { phase: 'spec', from: 'SCOUT_VALID', to: 'SPEC_VALID' },
    { phase: 'route', from: 'SPEC_VALID', to: 'ROUTED' },
    { phase: 'implement', from: 'ROUTED', to: 'IMPLEMENT_VALID' },
    { phase: 'scope', from: 'IMPLEMENT_VALID', to: 'SCOPE_VALID' },
    { phase: 'review', from: 'SCOPE_VALID', to: 'REVIEW_VALID' },
];

const PHASE_ARTIFACT_MAPPING = Object.freeze({
    preflight: Object.freeze([]),
    scout: Object.freeze(['context.json']),
    spec: Object.freeze(['spec.json']),
    route: Object.freeze(['route.json']),
    implement: Object.freeze(['evidence.json']),
    scope: Object.freeze([]),
    review: Object.freeze(['review.json']),
});

function validateEventSequence(events, taskId, expectedBaselineOrCommit) {
    if (!Array.isArray(events) || events.length === 0) {
        throw new Error('Event log is empty');
    }

    const expectedBaseline = normalizeBaselineCorrelation(
        typeof expectedBaselineOrCommit === 'string'
            ? { expected_base_commit: expectedBaselineOrCommit }
            : expectedBaselineOrCommit
    );

    let expectedSeq = 1;
    let currentPhaseIndex = 0;
    let activePhase = null;
    let terminalHandoffSeen = false;
    const completedPhases = new Set();
    const lastAttemptPerPhase = new Map();
    let lastPhaseFailed = null;

    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (!ev || typeof ev !== 'object') {
            throw new Error(`Invalid event record at index ${i}`);
        }

        // 1. Schema check
        parseContract(EventSchema, ev, `event[${i}]`);

        // 2. Exact task and baseline correlation
        if (ev.task_id !== taskId) {
            throw new Error(`Event task_id mismatch at sequence ${ev.sequence} (${ev.task_id} !== ${taskId})`);
        }
        const evBaseline = normalizeBaselineCorrelation(ev);
        if (evBaseline.kind !== expectedBaseline.kind || evBaseline.id !== expectedBaseline.id) {
            throw new Error(`Event baseline mismatch at sequence ${ev.sequence} (${JSON.stringify(evBaseline)} !== ${JSON.stringify(expectedBaseline)})`);
        }

        // 3. Contiguous sequence check
        if (ev.sequence !== expectedSeq) {
            throw new Error(`Event sequence mismatch at index ${i}: expected ${expectedSeq}, got ${ev.sequence}`);
        }
        expectedSeq++;

        // 4. Check events after terminal handoff
        if (terminalHandoffSeen) {
            throw new Error(`Event occurred after terminal handoff at sequence ${ev.sequence}`);
        }

        // 5. First event must be transaction.created with state NEW
        if (i === 0) {
            if (ev.type !== 'transaction.created' || ev.state !== 'NEW') {
                throw new Error(`First event must be transaction.created with state NEW, got ${ev.type}`);
            }
            continue;
        }

        if (ev.type === 'transaction.created') {
            throw new Error(`Duplicate transaction.created event at sequence ${ev.sequence}`);
        }

        if (ev.type === 'phase.started') {
            if (activePhase !== null) {
                throw new Error(`phase.started at sequence ${ev.sequence} while phase ${activePhase.phase} attempt ${activePhase.attempt} is still active`);
            }
            if (currentPhaseIndex >= REQUIRED_PHASE_TRANSITIONS.length) {
                throw new Error(`Unexpected phase.started for ${ev.phase} after all phases completed at sequence ${ev.sequence}`);
            }
            const expectedPhase = REQUIRED_PHASE_TRANSITIONS[currentPhaseIndex].phase;
            if (ev.phase !== expectedPhase) {
                throw new Error(`Unexpected phase.started: expected ${expectedPhase}, got ${ev.phase} at sequence ${ev.sequence}`);
            }
            if (completedPhases.has(ev.phase)) {
                throw new Error(`phase ${ev.phase} is already completed at sequence ${ev.sequence}`);
            }
            if (!lastAttemptPerPhase.has(ev.phase)) {
                if (ev.attempt !== 1) {
                    throw new Error(`First attempt for phase ${ev.phase} must be 1, got ${ev.attempt} at sequence ${ev.sequence}`);
                }
            } else {
                if (!lastPhaseFailed || lastPhaseFailed.phase !== ev.phase) {
                    throw new Error(`phase.started retry for ${ev.phase} without prior phase.failed at sequence ${ev.sequence}`);
                }
                if (lastPhaseFailed.retryable !== true) {
                    throw new Error(`Cannot retry phase ${ev.phase} after non-retryable failure at sequence ${ev.sequence}`);
                }
                const expectedAttempt = lastPhaseFailed.attempt + 1;
                if (ev.attempt !== expectedAttempt) {
                    throw new Error(`Expected attempt ${expectedAttempt} for retried phase ${ev.phase}, got ${ev.attempt} at sequence ${ev.sequence}`);
                }
            }
            lastAttemptPerPhase.set(ev.phase, ev.attempt);
            lastPhaseFailed = null;
            activePhase = { phase: ev.phase, attempt: ev.attempt };
            continue;
        }

        if (ev.type === 'phase.failed') {
            if (!activePhase || activePhase.phase !== ev.phase || activePhase.attempt !== ev.attempt) {
                throw new Error(`phase.failed at sequence ${ev.sequence} without matching phase.started (expected ${activePhase ? `${activePhase.phase}.${activePhase.attempt}` : 'none'}, got ${ev.phase}.${ev.attempt})`);
            }
            lastPhaseFailed = { phase: ev.phase, attempt: ev.attempt, retryable: ev.retryable === true };
            activePhase = null;
            continue;
        }

        if (ev.type === 'phase.completed') {
            if (!activePhase || activePhase.phase !== ev.phase || activePhase.attempt !== ev.attempt) {
                throw new Error(`phase.completed at sequence ${ev.sequence} without matching phase.started (expected ${activePhase ? `${activePhase.phase}.${activePhase.attempt}` : 'none'}, got ${ev.phase}.${ev.attempt})`);
            }
            const expectedTrans = REQUIRED_PHASE_TRANSITIONS[currentPhaseIndex];
            if (ev.from_state !== expectedTrans.from || ev.to_state !== expectedTrans.to) {
                throw new Error(`Invalid state transition for ${ev.phase} at sequence ${ev.sequence}: ${ev.from_state} -> ${ev.to_state}, expected ${expectedTrans.from} -> ${expectedTrans.to}`);
            }
            completedPhases.add(ev.phase);
            lastPhaseFailed = null;
            activePhase = null;
            currentPhaseIndex++;
            continue;
        }

        if (ev.type === 'handoff.completed') {
            if (activePhase !== null) {
                throw new Error(`handoff.completed at sequence ${ev.sequence} while phase ${activePhase.phase} is still active`);
            }
            if (currentPhaseIndex !== REQUIRED_PHASE_TRANSITIONS.length) {
                throw new Error(`handoff.completed at sequence ${ev.sequence} before all required phases completed (completed ${currentPhaseIndex}/${REQUIRED_PHASE_TRANSITIONS.length})`);
            }
            if (ev.owner !== 'codex' || ev.from_state !== 'REVIEW_VALID' || ev.to_state !== 'CODEX_QC' || ev.reason !== 'final_qc') {
                throw new Error(`Invalid terminal handoff event at sequence ${ev.sequence}: expected owner: codex, REVIEW_VALID -> CODEX_QC, reason: final_qc; got owner: ${ev.owner}, ${ev.from_state} -> ${ev.to_state}, reason: ${ev.reason}`);
            }
            terminalHandoffSeen = true;
            continue;
        }
    }

    if (activePhase !== null) {
        throw new Error(`Event sequence ended with unclosed phase ${activePhase.phase} attempt ${activePhase.attempt}`);
    }
    if (!terminalHandoffSeen) {
        throw new Error('Event sequence missing final handoff.completed event');
    }
    if (currentPhaseIndex !== REQUIRED_PHASE_TRANSITIONS.length) {
        throw new Error(`Event log missing required successful phase transitions: completed ${currentPhaseIndex} of ${REQUIRED_PHASE_TRANSITIONS.length}`);
    }
}

function validatePhaseArtifactHashes(taskRunDir, events) {
    if (!fs.existsSync(taskRunDir)) {
        throw new Error(`Run directory not found: ${taskRunDir}`);
    }
    if (!Array.isArray(events)) {
        throw new Error('Events must be an array');
    }

    for (const ev of events) {
        if (!ev || ev.type !== 'phase.completed') continue;
        const expectedFiles = PHASE_ARTIFACT_MAPPING[ev.phase];
        if (!expectedFiles) {
            throw new Error(`Unknown phase in event: ${ev.phase}`);
        }
        const actualHashes = ev.artifact_hashes || {};
        const actualKeys = Object.keys(actualHashes).sort();
        const expectedKeys = [...expectedFiles].sort();

        if (actualKeys.length !== expectedKeys.length || !actualKeys.every((k, i) => k === expectedKeys[i])) {
            throw new Error(`artifact_hashes for phase ${ev.phase} mismatch: expected [${expectedKeys.join(', ')}], got [${actualKeys.join(', ')}]`);
        }

        for (const filename of expectedFiles) {
            const expectedSha = actualHashes[filename];
            const filePath = path.join(taskRunDir, filename);
            if (!fs.existsSync(filePath)) {
                throw new Error(`Required artifact file ${filename} missing from ${taskRunDir}`);
            }
            const content = fs.readFileSync(filePath);
            const actualSha = crypto.createHash('sha256').update(content).digest('hex');
            if (actualSha !== expectedSha) {
                throw new Error(`Artifact hash mismatch for ${filename}: event hash ${expectedSha} !== disk hash ${actualSha}`);
            }
        }
    }
}

module.exports = {
    TaskIdSchema,
    GitObjectIdSchema,
    Sha256Schema,
    PhaseSchema,
    StateSchema,
    ValidationCommandSchema,
    ContextSchema,
    SpecSchema,
    RouteSchema,
    EvidenceSchema,
    ReviewSchema,
    EventSchema,
    AttemptMetaSchema,
    BaselineIdentitySchema,
    GateStatusSchema,
    SessionStateSchema,
    TaskAuthorityStateSchema,
    SetupActionSchema,
    DualPlanTaskSchema,
    DualPlanManifestSchema,
    SessionEventSchema,
    QcEvidenceSchema,
    QualityEvidenceSchema,
    UiEvidenceSchema,
    UiRequirementSchema,
    UiEvidenceRecordSchema,
    normalizeBaselineCorrelation,
    emitBaselineCorrelation,
    validateEventSequence,
    validatePhaseArtifactHashes,
    DualContractError,
    parseContract,
    toDraft7Schema,
};
