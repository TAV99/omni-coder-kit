'use strict';

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createDaemonClient, DualDaemonClientError } from './daemon-client.js';
import {
    TaskIdSchema,
    GitObjectIdSchema,
    Sha256Schema,
    SessionStateSchema,
    BaselineIdentitySchema,
    TaskAuthorityStateSchema,
    GateStatusSchema,
} from './contracts.js';
import { AcceptancePolicySchema, ReviewEvidenceSchema } from './acceptance-policy.js';

const MAX_SERIALIZED_BYTES = 16 * 1024; // 16 KiB
const MAX_STATUS_TASKS = 25;
const MAX_STATUS_GATES = 25;
const MAX_ALLOWED_FILES_PER_TASK = 10;
const MAX_COMPLETION_BLOCKERS = 25;
const MAX_BLOCKER_LENGTH = 128;
const MCP_REQUEST_TIMEOUT_MS = 15_000;
const MCP_PLAN_REGISTER_TIMEOUT_MS = 35_000;

// --------------------------------------------------------------------------
// Public Stable Error Code Map (Zero Leaks of Paths, Sessions, or Internals)
// --------------------------------------------------------------------------
const PUBLIC_ERROR_MESSAGES = {
    DUAL_WORKSPACE_MISMATCH: 'Workspace root does not match bound workspace',
    DUAL_WORKSPACE_ROOT_INVALID: 'Workspace root must be an existing directory',
    DUAL_DAEMON_UNHEALTHY: 'Dual authority daemon is unhealthy or not running',
    DUAL_SESSION_MISMATCH: 'Session ID does not match active daemon session',
    DUAL_DISCOVERY_MISSING: 'Dual daemon discovery file not found',
    DUAL_DISCOVERY_CORRUPT: 'Dual daemon discovery file is corrupt',
    DUAL_DISCOVERY_WORKSPACE_MISMATCH: 'Daemon workspace does not match bound workspace',
    DUAL_CLIENT_TIMEOUT: 'Daemon request timed out',
    DUAL_CLIENT_CONNECTION_REFUSED: 'Cannot connect to Dual authority daemon',
    DUAL_CLIENT_CONNECTION_ERROR: 'Failed to connect to Dual authority daemon',
    DUAL_CLIENT_MALFORMED_RESPONSE: 'Daemon returned a malformed response',
    DUAL_CLIENT_RESPONSE_TOO_LARGE: 'Daemon response exceeded size limit',
    DUAL_CLIENT_HTTP_ERROR: 'Daemon returned an HTTP error',
    DUAL_CLIENT_RPC_ERROR: 'Daemon rejected the requested operation',
    DUAL_CONTRACT_INVALID: 'Invalid authority contract parameters',
    DUAL_PATH_ESCAPE: 'Invalid repository path',
    DUAL_TRANSITION_INVALID: 'Current Dual session state does not allow this operation',
    DUAL_SETUP_REQUIRED: 'Typed setup has not completed successfully for the current manifest',
    DUAL_PLAN_INVALID: 'Plan artifact or task graph is invalid',
    DUAL_PLAN_HASH_MISMATCH: 'Plan hash does not match the current plan artifact',
    DUAL_PLAN_REVISION_MISMATCH: 'Plan revision does not match the active Dual session',
    DUAL_CAPABILITY_BLOCKED: 'Dual capability preflight is blocked',
    DUAL_SESSION_NOT_FOUND: 'Active Dual session was not found',
    DUAL_SESSION_BLOCKED: 'Dual session is blocked',
    DUAL_MCP_RESPONSE_TOO_LARGE: 'Tool response exceeds maximum size limit',
    DUAL_MCP_INVALID_DAEMON_RESPONSE: 'Daemon response was invalid or unacknowledged',
    DUAL_MCP_BEGIN_ERROR: 'Failed to begin Dual authority session',
    DUAL_MCP_REGISTER_PLAN_ERROR: 'Failed to register plan with Dual authority daemon',
    DUAL_MCP_STATUS_ERROR: 'Failed to get session status from Dual authority daemon',
    DUAL_MCP_COMPLETION_ERROR: 'Failed to evaluate completion with Dual authority daemon',
    DUAL_MCP_RESUME_ERROR: 'Failed to resume session with Dual authority daemon',
    DUAL_MCP_ERROR: 'An error occurred during tool execution',
};

// --------------------------------------------------------------------------
// Canonicalization & Path Validation Helpers
// --------------------------------------------------------------------------
function canonicalizeExistingDirectory(p) {
    if (!p || typeof p !== 'string' || p.trim().length === 0) {
        throw new DualDaemonClientError(
            'DUAL_WORKSPACE_ROOT_INVALID',
            'Workspace root must be an existing directory'
        );
    }
    let canonical;
    try {
        if (!fs.existsSync(p)) {
            throw new Error('Directory does not exist');
        }
        canonical = fs.realpathSync?.native
            ? fs.realpathSync.native(p)
            : (fs.realpathSync ? fs.realpathSync(p) : path.resolve(p));
    } catch {
        throw new DualDaemonClientError(
            'DUAL_WORKSPACE_ROOT_INVALID',
            'Workspace root must be an existing directory'
        );
    }

    try {
        const stat = fs.statSync(canonical);
        if (!stat.isDirectory()) {
            throw new DualDaemonClientError(
                'DUAL_WORKSPACE_ROOT_INVALID',
                'Workspace root must be an existing directory'
            );
        }
    } catch (err) {
        if (err instanceof DualDaemonClientError) throw err;
        throw new DualDaemonClientError(
            'DUAL_WORKSPACE_ROOT_INVALID',
            'Workspace root must be an existing directory'
        );
    }
    return canonical;
}

function assertWorkspaceMatches(inputWorkspaceRoot, boundRoot) {
    let canonicalInput;
    try {
        canonicalInput = canonicalizeExistingDirectory(inputWorkspaceRoot);
    } catch {
        throw new DualDaemonClientError(
            'DUAL_WORKSPACE_MISMATCH',
            'Workspace root does not match bound workspace'
        );
    }
    if (canonicalInput !== boundRoot) {
        throw new DualDaemonClientError(
            'DUAL_WORKSPACE_MISMATCH',
            'Workspace root does not match bound workspace'
        );
    }
}

export function isValidRepoRelativePath(candidate) {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 1024) {
        return false;
    }
    // Reject colons anywhere (drive letters, alternate data streams)
    if (candidate.includes(':')) {
        return false;
    }
    // Reject ASCII control characters (\x00-\x1f and \x7f)
    if (/[\x00-\x1f\x7f]/.test(candidate)) {
        return false;
    }
    // Reject backslashes and absolute/UNC paths
    if (candidate.includes('\\') || candidate.startsWith('/')) {
        return false;
    }
    const segments = candidate.split('/');
    for (const seg of segments) {
        if (seg === '' || seg === '.' || seg === '..') {
            return false;
        }
        // Reject trailing dot or trailing space segments
        if (seg.endsWith('.') || seg.endsWith(' ')) {
            return false;
        }
        // Reject Windows reserved device basenames (case-insensitive, with any extensions)
        if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(seg)) {
            return false;
        }
    }
    return true;
}

const StrictRepoPathSchema = z.string()
    .min(1)
    .max(1024)
    .refine(isValidRepoRelativePath, {
        message: 'Invalid repository path: must be a normalized, repo-relative POSIX path without traversal, colons, control chars, reserved devices, or trailing dots/spaces',
    });

const RepoWorkingDirectorySchema = z.union([
    z.literal('.'),
    StrictRepoPathSchema,
]);

// --------------------------------------------------------------------------
// Tool Formatting Helpers
// --------------------------------------------------------------------------
function formatToolSuccess(data) {
    const text = JSON.stringify(data, null, 2);
    const result = {
        content: [{
            type: 'text',
            text,
        }],
        structuredContent: data,
    };
    const totalBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (totalBytes > MAX_SERIALIZED_BYTES) {
        return formatToolError(
            'DUAL_MCP_RESPONSE_TOO_LARGE',
            'Tool response exceeds maximum size limit of 16 KiB'
        );
    }
    return result;
}

function formatToolError(code, customMessage, customDetails) {
    const safeCode = (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code))
        ? code
        : 'DUAL_MCP_ERROR';
    const safeMessage = PUBLIC_ERROR_MESSAGES[safeCode] || (typeof customMessage === 'string' && !customMessage.includes('/') && !customMessage.includes('\\') ? customMessage.slice(0, 256) : 'An error occurred during tool execution');

    let safeDetails;
    if (customDetails && typeof customDetails === 'object') {
        safeDetails = {};
        for (const [k, v] of Object.entries(customDetails)) {
            if (typeof v === 'string' && !v.includes('/') && !v.includes('\\') && v.length <= 512) {
                safeDetails[k] = v;
            }
        }
        if (Object.keys(safeDetails).length === 0) {
            safeDetails = undefined;
        }
    }

    const errorPayload = {
        error: {
            code: safeCode,
            message: safeMessage,
            ...(safeDetails ? { details: safeDetails } : {}),
        },
    };
    const text = JSON.stringify(errorPayload, null, 2);
    return {
        isError: true,
        content: [{
            type: 'text',
            text,
        }],
        structuredContent: errorPayload,
    };
}

function handleToolError(err, fallbackCode) {
    const code = (err && typeof err.code === 'string' && PUBLIC_ERROR_MESSAGES[err.code])
        ? err.code
        : fallbackCode;
    let details;
    const rawMsg = err?.message || (typeof err?.details === 'string' ? err.details : err?.details?.message);
    if (typeof rawMsg === 'string' && !rawMsg.includes('/') && !rawMsg.includes('\\')) {
        const sanitized = rawMsg
            .replace(/bearer\s+[a-z0-9_-]+/gi, '[REDACTED_TOKEN]')
            .slice(0, 512);
        details = { reason: sanitized };
    }
    return formatToolError(code, undefined, details);
}

// --------------------------------------------------------------------------
// Session Health Pre-Check
// --------------------------------------------------------------------------
async function assertHealthySession(client, expectedSessionId, boundRoot) {
    const health = await client.health();
    if (!health || typeof health !== 'object' || health.status !== 'healthy') {
        throw new DualDaemonClientError(
            'DUAL_DAEMON_UNHEALTHY',
            'Dual authority daemon is unhealthy or not running'
        );
    }
    let healthCanonicalRoot;
    try {
        healthCanonicalRoot = canonicalizeExistingDirectory(health.workspace_root || '');
    } catch {
        throw new DualDaemonClientError(
            'DUAL_WORKSPACE_MISMATCH',
            'Daemon workspace root does not match bound workspace'
        );
    }
    if (healthCanonicalRoot !== boundRoot) {
        throw new DualDaemonClientError(
            'DUAL_WORKSPACE_MISMATCH',
            'Daemon workspace root does not match bound workspace'
        );
    }
    if (!health.session_id || health.session_id !== expectedSessionId) {
        throw new DualDaemonClientError(
            'DUAL_SESSION_MISMATCH',
            'Session ID does not match active daemon session'
        );
    }
    return health;
}

// --------------------------------------------------------------------------
// Status Result Deep Sanitizers (Strict Fail-Closed Authority Validation)
// --------------------------------------------------------------------------
function sanitizeStatusTasks(rawTasks) {
    if (rawTasks === undefined || rawTasks === null) {
        return { tasks: {}, tasks_truncated: false, tasks_total: 0 };
    }
    if (typeof rawTasks !== 'object' || Array.isArray(rawTasks)) {
        throw new DualDaemonClientError(
            'DUAL_MCP_INVALID_DAEMON_RESPONSE',
            'Invalid tasks container in status response'
        );
    }
    const entries = Object.entries(rawTasks);
    const total = entries.length;
    const truncated = total > MAX_STATUS_TASKS;
    const slice = entries.slice(0, MAX_STATUS_TASKS);
    const tasks = {};

    for (const [key, tInfo] of slice) {
        if (!tInfo || typeof tInfo !== 'object' || Array.isArray(tInfo)) {
            throw new DualDaemonClientError(
                'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                'Invalid task entry in status response'
            );
        }
        const rawTaskId = tInfo.task_id || key;
        if (
            typeof rawTaskId !== 'string' ||
            !TaskIdSchema.safeParse(rawTaskId).success ||
            (tInfo.task_id && key !== tInfo.task_id)
        ) {
            throw new DualDaemonClientError(
                'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                'Invalid task_id in status response'
            );
        }
        const taskId = rawTaskId;

        if (tInfo.owner !== 'codex' && tInfo.owner !== 'agy') {
            throw new DualDaemonClientError(
                'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                'Invalid task owner authority in status response'
            );
        }
        const owner = tInfo.owner;

        if (!TaskAuthorityStateSchema.safeParse(tInfo.state).success) {
            throw new DualDaemonClientError(
                'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                'Invalid task authority state in status response'
            );
        }
        const state = tInfo.state;

        const title = typeof tInfo.title === 'string' ? tInfo.title.slice(0, 128) : '';

        let allowed_files = [];
        if (tInfo.allowed_files !== undefined) {
            if (!Array.isArray(tInfo.allowed_files)) {
                throw new DualDaemonClientError(
                    'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                    'Invalid allowed_files format in status response'
                );
            }
            for (const f of tInfo.allowed_files) {
                if (typeof f !== 'string' || !isValidRepoRelativePath(f)) {
                    throw new DualDaemonClientError(
                        'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                        'Invalid allowed_files path in status response'
                    );
                }
            }
            allowed_files = tInfo.allowed_files
                .slice(0, MAX_ALLOWED_FILES_PER_TASK)
                .map((f) => f.slice(0, 128));
        }

        tasks[taskId] = {
            task_id: taskId,
            state,
            owner,
            title,
            allowed_files,
        };
        if (tInfo.lastOutcome !== undefined) {
            const outcome = z.object({ attempt: z.number().int().min(1).max(3),
                status: z.enum(['NEEDS_FIX', 'CONFLICT', 'FAILED']), code: z.string().regex(/^[A-Z0-9_]{1,128}$/),
                summary: z.string().min(1).max(2048) }).strict().safeParse(tInfo.lastOutcome);
            if (!outcome.success) throw new DualDaemonClientError('DUAL_MCP_INVALID_DAEMON_RESPONSE', 'Invalid task outcome');
            tasks[taskId].last_outcome = { ...outcome.data, summary: outcome.data.summary.slice(0, 1024),
                ...(outcome.data.summary.length > 1024 ? { summary_truncated: true } : {}) };
        }
        if (tInfo.messages !== undefined) {
            const messageSchema = z.object({ message_id: TaskIdSchema, kind: z.enum(['question', 'reply']),
                body: z.string().min(1).max(4096), reply_to: TaskIdSchema.optional(),
                plan_revision: z.number().int().positive() }).strict();
            const parsed = z.array(messageSchema).max(100).safeParse(tInfo.messages);
            if (!parsed.success) throw new DualDaemonClientError('DUAL_MCP_INVALID_DAEMON_RESPONSE', 'Invalid task messages');
            const pending = parsed.data.filter((message) => message.kind === 'question'
                && !parsed.data.some((reply) => reply.reply_to === message.message_id));
            tasks[taskId].pending_questions = pending.slice(0, 5).map((message) => ({
                message_id: message.message_id, body: message.body.slice(0, 1024),
                ...(message.body.length > 1024 ? { body_truncated: true } : {}),
            }));
            if (pending.length > 5) tasks[taskId].questions_truncated = true;
        }
    }

    return { tasks, tasks_truncated: truncated, tasks_total: total };
}

function sanitizeStatusGates(rawGates) {
    if (rawGates === undefined || rawGates === null) {
        return { gates: {}, gates_truncated: false, gates_total: 0 };
    }
    if (typeof rawGates !== 'object' || Array.isArray(rawGates)) {
        throw new DualDaemonClientError(
            'DUAL_MCP_INVALID_DAEMON_RESPONSE',
            'Invalid gates container in status response'
        );
    }
    const entries = Object.entries(rawGates);
    const total = entries.length;
    const truncated = total > MAX_STATUS_GATES;
    const slice = entries.slice(0, MAX_STATUS_GATES);
    const gates = {};

    for (const [gateKey, gInfo] of slice) {
        if (!gInfo || typeof gInfo !== 'object' || Array.isArray(gInfo)) {
            throw new DualDaemonClientError(
                'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                'Invalid gate entry in status response'
            );
        }
        const rawGateId = gInfo.gate_id || gateKey;
        if (
            typeof rawGateId !== 'string' ||
            rawGateId.length === 0 ||
            rawGateId.length > 64 ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(rawGateId) ||
            (gInfo.gate_id && gateKey !== gInfo.gate_id)
        ) {
            throw new DualDaemonClientError(
                'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                'Invalid gate_id in status response'
            );
        }
        const gateId = rawGateId;

        if (!GateStatusSchema.safeParse(gInfo.status).success) {
            throw new DualDaemonClientError(
                'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                'Invalid gate status authority in status response'
            );
        }
        const status = gInfo.status;

        let required;
        if (gInfo.required !== undefined) {
            if (typeof gInfo.required !== 'boolean') {
                throw new DualDaemonClientError(
                    'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                    'Invalid gate required field in status response'
                );
            }
            required = gInfo.required;
        }

        let reason;
        if (gInfo.reason !== undefined) {
            if (typeof gInfo.reason !== 'string') {
                throw new DualDaemonClientError(
                    'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                    'Invalid gate reason in status response'
                );
            }
            reason = gInfo.reason.slice(0, 128);
        }

        let evidence_sha256;
        if (gInfo.evidence_sha256 !== undefined) {
            if (typeof gInfo.evidence_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(gInfo.evidence_sha256)) {
                throw new DualDaemonClientError(
                    'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                    'Invalid gate evidence_sha256 in status response'
                );
            }
            evidence_sha256 = gInfo.evidence_sha256;
        }

        gates[gateId] = {
            gate_id: gateId,
            status,
            ...(required !== undefined ? { required } : {}),
            ...(reason !== undefined ? { reason } : {}),
            ...(evidence_sha256 !== undefined ? { evidence_sha256 } : {}),
        };
    }
    return { gates, gates_truncated: truncated, gates_total: total };
}

function sanitizeStatusBlocked(rawBlocked) {
    if (rawBlocked === false || rawBlocked === undefined || rawBlocked === null) {
        return false;
    }
    if (rawBlocked === true) {
        return true;
    }
    if (typeof rawBlocked === 'object' && !Array.isArray(rawBlocked)) {
        const rawCode = rawBlocked.code ?? rawBlocked.blocker_code ?? rawBlocked.blockerCode;
        const rawReason = rawBlocked.reason;
        if (
            typeof rawCode !== 'string' ||
            rawCode.length === 0 ||
            rawCode.length > 64 ||
            typeof rawReason !== 'string' ||
            rawReason.length === 0 ||
            rawReason.length > 256
        ) {
            throw new DualDaemonClientError(
                'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                'Invalid blocked object in status response'
            );
        }
        return {
            code: rawCode.slice(0, 64),
            reason: rawReason.slice(0, 128),
        };
    }
    throw new DualDaemonClientError(
        'DUAL_MCP_INVALID_DAEMON_RESPONSE',
        'Invalid blocked format in status response'
    );
}

function sanitizeStatusIntegrity(rawIntegrity) {
    if (rawIntegrity === undefined || rawIntegrity === null) {
        return undefined;
    }
    if (typeof rawIntegrity !== 'object' || Array.isArray(rawIntegrity)) {
        throw new DualDaemonClientError(
            'DUAL_MCP_INVALID_DAEMON_RESPONSE',
            'Invalid integrity format in status response'
        );
    }
    if (typeof rawIntegrity.valid !== 'boolean') {
        throw new DualDaemonClientError(
            'DUAL_MCP_INVALID_DAEMON_RESPONSE',
            'Invalid or missing integrity valid boolean in status response'
        );
    }
    const rawEventCount = rawIntegrity.event_count !== undefined
        ? rawIntegrity.event_count
        : rawIntegrity.eventCount;
    if (
        typeof rawEventCount !== 'number' ||
        !Number.isInteger(rawEventCount) ||
        rawEventCount < 0 ||
        rawEventCount > Number.MAX_SAFE_INTEGER
    ) {
        throw new DualDaemonClientError(
            'DUAL_MCP_INVALID_DAEMON_RESPONSE',
            'Invalid or missing integrity event count in status response'
        );
    }
    return {
        valid: rawIntegrity.valid,
        event_count: rawEventCount,
    };
}

// --------------------------------------------------------------------------
// Completion Blockers Sanitizer (Redacts Hashes & Tokens, Never String(obj))
// --------------------------------------------------------------------------
function sanitizeCompletionBlockers(rawBlockers) {
    if (rawBlockers === undefined || rawBlockers === null) {
        return { blockers: [], blockers_truncated: false, blockers_total: 0 };
    }
    if (!Array.isArray(rawBlockers)) {
        throw new DualDaemonClientError(
            'DUAL_MCP_INVALID_DAEMON_RESPONSE',
            'Blockers must be an array in completion response'
        );
    }
    const total = rawBlockers.length;
    const truncated = total > MAX_COMPLETION_BLOCKERS;
    const slice = rawBlockers.slice(0, MAX_COMPLETION_BLOCKERS);
    const blockers = [];

    for (const item of slice) {
        if (typeof item !== 'string') {
            throw new DualDaemonClientError(
                'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                'Blocker element must be a string'
            );
        }
        // 1. Remove ASCII control characters
        let cleaned = item.replace(/[\x00-\x1f\x7f]/g, '');

        // 2. Redact standalone 64-hex and 40-hex hashes
        cleaned = cleaned.replace(/\b[0-9a-fA-F]{64}\b/g, '[REDACTED_HASH]');
        cleaned = cleaned.replace(/\b[0-9a-fA-F]{40}\b/g, '[REDACTED_HASH]');

        // 3. Redact bearer tokens and sensitive keys
        cleaned = cleaned.replace(/(?:bearer\s+|token[:=]\s*)[A-Za-z0-9._~+/-]{16,}/gi, 'bearer [REDACTED_TOKEN]');
        cleaned = cleaned.replace(/\b(?:omni|dual|tok|sec|key)_[A-Za-z0-9_-]{16,}\b/gi, '[REDACTED_TOKEN]');

        // 4. Bound length
        cleaned = cleaned.slice(0, MAX_BLOCKER_LENGTH).trim();
        blockers.push(cleaned);
    }

    return { blockers, blockers_truncated: truncated, blockers_total: total };
}

// --------------------------------------------------------------------------
// Tool Input Schemas (Strict, Bounded Zod Schemas)
// --------------------------------------------------------------------------
const BeginInputSchema = z.object({
    workspace_root: z.string().min(1).max(1024),
    expected_baseline: BaselineIdentitySchema.optional(),
    session_id: z.string().min(1).max(128).optional(),
    mode: z.literal('auto').default('auto'),
}).strict();

const RegisterPlanInputSchema = z.object({
    workspace_root: z.string().min(1).max(1024),
    session_id: z.string().min(1).max(128),
    plan_revision: z.number().int().positive().max(100000),
    plan_path: StrictRepoPathSchema,
    plan_sha256: Sha256Schema,
    acceptance_policy: AcceptancePolicySchema.optional(),
    tasks: z.array(z.object({
        task_id: TaskIdSchema,
        title: z.string().min(1).max(256),
        owner: z.enum(['codex', 'agy']).optional(),
        allowed_files: z.array(StrictRepoPathSchema).max(100),
        goal: z.string().min(1).max(1024).optional(),
        category: z.string().min(1).max(128).optional(),
        complexity: z.string().min(1).max(128).optional(),
        risk: z.string().min(1).max(128).optional(),
        deny_patterns: z.array(z.string().min(1).max(256)).max(100).optional(),
        validation_commands: z.array(z.object({
            program: z.string().min(1).max(256),
            args: z.array(z.string().max(256)).max(100),
            cwd: RepoWorkingDirectorySchema,
        }).strict()).max(50).optional(),
        context_files: z.array(StrictRepoPathSchema).max(100).optional(),
        // JSON-schema transport shape; daemon validates exact bounded input and task ownership.
        external_operations: z.array(z.object({
            tool_name: z.string().regex(/^mcp__stitch__[a-z][a-z0-9_]{0,95}$/),
            tool_input: z.record(z.string(), z.unknown()),
            evidence_file: StrictRepoPathSchema,
        }).strict()).max(20).optional(),
        execution_mode: z.enum(['shared', 'isolated']).optional(),
        dependency_mode: z.enum(['none', 'npm-ci']).optional(),
        depends_on: z.array(TaskIdSchema).max(100).optional(),
    }).strict()).min(1).max(500),
}).strict();

const StatusInputSchema = z.object({
    workspace_root: z.string().min(1).max(1024),
    session_id: z.string().min(1).max(128),
}).strict();

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
    modified_files: z.array(StrictRepoPathSchema),
}).strict();

const QualityGateResultSchema = z.object({
    id: z.string().min(1).max(128),
    required: z.boolean(),
    status: z.enum(['PASSED', 'FAILED', 'BLOCKED', 'UNAVAILABLE', 'OPTIONAL_SKIPPED']),
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
    viewport_widths: z.array(
        z.union([z.literal(390), z.literal(768), z.literal(1024), z.literal(1440)])
    ).length(4).refine(
        (widths) => widths.every((width, index) => width === [390, 768, 1024, 1440][index]),
        'viewport_widths must be exactly [390, 768, 1024, 1440]'
    ),
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

const CompletionInputSchema = z.object({
    workspace_root: z.string().min(1).max(1024),
    session_id: z.string().min(1).max(128),
    isolated_qc: z.object({ task_id: TaskIdSchema, plan_revision: z.number().int().positive().max(100000) }).strict().optional(),
    review_evidence: ReviewEvidenceSchema.optional(),
    qc_evidence: QcEvidenceSchema.optional(),
    quality_evidence: QualityEvidenceSchema.optional(),
    ui_evidence: UiEvidenceSchema.optional(),
}).strict().superRefine((input, ctx) => {
    if (input.review_evidence && !input.isolated_qc) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['review_evidence'],
            message: 'review_evidence is only accepted with isolated_qc; use acceptance_review_submit for standalone reviews' });
    }
});

const CorrectionStartInputSchema = z.object({
    workspace_root: z.string().min(1).max(1024),
    session_id: z.string().min(1).max(128),
    task_id: TaskIdSchema,
    reason: z.string().min(1).max(2048),
    expected_sequence: z.number().int().nonnegative(),
    start_fingerprint: Sha256Schema,
    failure_check_id: z.string().min(1).max(128),
}).strict();

const AcceptanceReviewSubmitInputSchema = z.object({
    workspace_root: z.string().min(1).max(1024),
    session_id: z.string().min(1).max(128),
    task_id: TaskIdSchema,
    plan_revision: z.number().int().positive().max(100000),
    review_evidence: ReviewEvidenceSchema,
}).strict();

const CorrectionCompleteInputSchema = z.object({
    workspace_root: z.string().min(1).max(1024),
    session_id: z.string().min(1).max(128),
    correction_id: z.string().uuid(),
    summary: z.string().min(1).max(2048).optional(),
}).strict();

const SessionBlockInputSchema = z.object({
    workspace_root: z.string().min(1).max(1024),
    session_id: z.string().min(1).max(128),
    reason: z.string().min(1).max(2048),
    blocker_code: z.string().min(1).max(128),
}).strict();

const ResumeInputSchema = z.object({
    workspace_root: z.string().min(1).max(1024),
    session_id: z.string().min(1).max(128),
    recovery: z.object({ task_id: TaskIdSchema, plan_revision: z.number().int().positive().max(100000) }).strict().optional(),
    context_reply: z.object({ task_id: TaskIdSchema, plan_revision: z.number().int().positive().max(100000),
        message_id: TaskIdSchema, reply_to: TaskIdSchema, body: z.string().min(1).max(4096).refine((body) => body.trim().length > 0) }).strict().optional(),
    correction: z.object({ task_id: TaskIdSchema, plan_revision: z.number().int().positive().max(100000),
        request_id: TaskIdSchema, expected_attempt: z.number().int().min(1).max(2),
        reason: z.string().min(1).max(2048).refine((body) => body.trim().length > 0) }).strict().optional(),
}).strict();

// Exported for machine validation of the public workflow template. Runtime
// handlers and documentation tests consume these exact production schemas.
export {
    BeginInputSchema,
    RegisterPlanInputSchema,
    CompletionInputSchema,
    CorrectionStartInputSchema,
    AcceptanceReviewSubmitInputSchema,
    CorrectionCompleteInputSchema,
    SessionBlockInputSchema,
    ResumeInputSchema,
};

// --------------------------------------------------------------------------
// Factory Function
// --------------------------------------------------------------------------
export function createOmniDualMcpServer(options = {}) {
    const rawWorkspaceRoot = options.workspaceRoot || process.cwd();
    const boundRoot = canonicalizeExistingDirectory(rawWorkspaceRoot);

    const clientFactory = options.createClient || ((clientOpts) => createDaemonClient(clientOpts));

    function getClient() {
        return clientFactory({
            workspaceRoot: boundRoot,
            timeoutMs: MCP_REQUEST_TIMEOUT_MS,
        });
    }

    const server = new McpServer({
        name: 'omni-dual-mcp-server',
        version: '3.0.0',
    });

    // 1. omni_dual_begin
    server.registerTool('omni_dual_begin', {
        description: 'Begin a new Dual AUTO authority session or attach to matching existing session',
        inputSchema: BeginInputSchema,
    }, async (args) => {
        try {
            assertWorkspaceMatches(args.workspace_root, boundRoot);
            const client = getClient();
            const result = await client.beginSession({
                workspace_root: boundRoot,
                expected_baseline: args.expected_baseline,
                session_id: args.session_id,
                mode: args.mode || 'auto',
            });
            if (
                !result ||
                typeof result !== 'object' ||
                typeof result.session_id !== 'string' ||
                result.session_id.length === 0 ||
                result.session_id.length > 128 ||
                (args.session_id && result.session_id !== args.session_id) ||
                !SessionStateSchema.safeParse(result.state).success ||
                typeof result.workspace_id !== 'string' ||
                result.workspace_id.length === 0 ||
                result.workspace_id.length > 128 ||
                typeof result.workspace_root !== 'string' ||
                result.workspace_root.length === 0 ||
                !result.expected_baseline ||
                typeof result.expected_baseline !== 'object' ||
                !BaselineIdentitySchema.safeParse(result.expected_baseline).success ||
                (args.expected_baseline && (result.expected_baseline.kind !== args.expected_baseline.kind || result.expected_baseline.id !== args.expected_baseline.id)) ||
                typeof result.plan_revision !== 'number' ||
                !Number.isInteger(result.plan_revision) ||
                result.plan_revision <= 0 ||
                result.plan_revision > 100000
            ) {
                throw new DualDaemonClientError(
                    'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                    'Daemon returned an invalid or incomplete begin session response'
                );
            }

            let resultCanonicalRoot;
            try {
                resultCanonicalRoot = canonicalizeExistingDirectory(result.workspace_root);
            } catch {
                throw new DualDaemonClientError(
                    'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                    'Daemon returned an invalid workspace root in begin session'
                );
            }
            if (resultCanonicalRoot !== boundRoot) {
                throw new DualDaemonClientError(
                    'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                    'Daemon returned workspace root that does not match bound root'
                );
            }

            return formatToolSuccess({
                session_id: result.session_id,
                state: result.state,
                workspace_id: result.workspace_id,
                workspace_root: result.workspace_root,
                expected_baseline: {
                    kind: result.expected_baseline.kind,
                    id: result.expected_baseline.id,
                },
                plan_revision: result.plan_revision,
            });
        } catch (err) {
            return handleToolError(err, 'DUAL_MCP_BEGIN_ERROR');
        }
    });

    // 2. omni_dual_register_plan
    server.registerTool('omni_dual_register_plan', {
        description: 'Register an approved implementation plan and task graph with the Dual authority daemon',
        inputSchema: RegisterPlanInputSchema,
    }, async (args) => {
        try {
            assertWorkspaceMatches(args.workspace_root, boundRoot);
            const client = getClient();
            await assertHealthySession(client, args.session_id, boundRoot);
            const result = await client.request('plan.register', {
                session_id: args.session_id,
                plan_revision: args.plan_revision,
                plan_path: args.plan_path,
                plan_sha256: args.plan_sha256,
                ...(args.acceptance_policy ? { acceptance_policy: args.acceptance_policy } : {}),
                tasks: args.tasks,
            }, { timeoutMs: MCP_PLAN_REGISTER_TIMEOUT_MS });
            if (
                !result ||
                typeof result !== 'object' ||
                result.session_id !== args.session_id ||
                result.plan_revision !== args.plan_revision ||
                !['PLANNED', 'EXECUTING'].includes(result.state) ||
                result.registered !== true ||
                typeof result.total_tasks !== 'number' ||
                result.total_tasks < 1
            ) {
                throw new DualDaemonClientError(
                    'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                    'Daemon returned an invalid or unacknowledged register plan response'
                );
            }
            return formatToolSuccess({
                session_id: result.session_id,
                state: result.state,
                plan_revision: result.plan_revision,
                total_tasks: result.total_tasks,
                registered: true,
            });
        } catch (err) {
            return handleToolError(err, 'DUAL_MCP_REGISTER_PLAN_ERROR');
        }
    });

    // 3. omni_dual_status
    server.registerTool('omni_dual_status', {
        description: 'Query current Dual session authority state, tasks, gates, and ledger integrity',
        inputSchema: StatusInputSchema,
    }, async (args) => {
        try {
            assertWorkspaceMatches(args.workspace_root, boundRoot);
            const client = getClient();
            await assertHealthySession(client, args.session_id, boundRoot);
            const result = await client.status(args.session_id);

            if (
                !result ||
                typeof result !== 'object' ||
                typeof result.session_id !== 'string' ||
                result.session_id !== args.session_id ||
                !SessionStateSchema.safeParse(result.state).success ||
                typeof result.workspace_id !== 'string' ||
                result.workspace_id.length === 0 ||
                result.workspace_id.length > 128 ||
                typeof result.workspace_root !== 'string' ||
                result.workspace_root.length === 0 ||
                typeof result.plan_revision !== 'number' ||
                !Number.isInteger(result.plan_revision) ||
                result.plan_revision <= 0 ||
                result.plan_revision > 100000 ||
                !result.current_baseline ||
                typeof result.current_baseline !== 'object' ||
                !BaselineIdentitySchema.safeParse(result.current_baseline).success
            ) {
                throw new DualDaemonClientError(
                    'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                    'Daemon returned an invalid status response'
                );
            }

            let statusCanonicalRoot;
            try {
                statusCanonicalRoot = canonicalizeExistingDirectory(result.workspace_root);
            } catch {
                throw new DualDaemonClientError(
                    'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                    'Daemon returned an invalid workspace root in status response'
                );
            }
            if (statusCanonicalRoot !== boundRoot) {
                throw new DualDaemonClientError(
                    'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                    'Daemon returned workspace root that does not match bound root'
                );
            }

            const { tasks, tasks_truncated, tasks_total } = sanitizeStatusTasks(result.tasks);
            const { gates, gates_truncated, gates_total } = sanitizeStatusGates(result.gates);
            const blocked = sanitizeStatusBlocked(result.blocked);
            const integrity = sanitizeStatusIntegrity(result.integrity);

            const statusData = {
                session_id: result.session_id,
                workspace_id: result.workspace_id,
                workspace_root: result.workspace_root,
                state: result.state,
                plan_revision: result.plan_revision,
                current_baseline: {
                    kind: result.current_baseline.kind,
                    id: result.current_baseline.id,
                },
                tasks,
                ...(tasks_truncated ? { tasks_truncated: true, tasks_total } : {}),
                gates,
                ...(gates_truncated ? { gates_truncated: true, gates_total } : {}),
                blocked,
                ...(integrity ? { integrity } : {}),
            };

            return formatToolSuccess(statusData);
        } catch (err) {
            return handleToolError(err, 'DUAL_MCP_STATUS_ERROR');
        }
    });

    // 4. omni_dual_completion
    server.registerTool('omni_dual_completion', {
        description: 'Evaluate Dual session completion readiness, verified gates, and completion receipt',
        inputSchema: CompletionInputSchema,
    }, async (args) => {
        try {
            assertWorkspaceMatches(args.workspace_root, boundRoot);
            const client = getClient();
            await assertHealthySession(client, args.session_id, boundRoot);
            if (args.isolated_qc) {
                if (args.qc_evidence || args.quality_evidence || args.ui_evidence) {
                    throw new DualDaemonClientError('DUAL_MCP_INVALID_INPUT', 'Isolated QC is a separate controller operation');
                }
                const result = await client.completeIsolatedTask(args.session_id, args.isolated_qc.task_id, args.isolated_qc.plan_revision,
                    args.review_evidence ? { review_evidence: args.review_evidence } : undefined);
                if (result?.session_id !== args.session_id || result.verified !== false
                    || !SessionStateSchema.safeParse(result.session_state).success
                    || !['TASK_VERIFIED', 'NEEDS_FIX', 'CONFLICT', 'WAITING_FOR_LEASE', 'WAITING_FOR_INTEGRATION',
                        'WAITING_FOR_DEPENDENCY', 'WAITING_FOR_SCOPE'].includes(result.status)) {
                    throw new DualDaemonClientError('DUAL_MCP_INVALID_DAEMON_RESPONSE', 'Invalid isolated QC response');
                }
                return formatToolSuccess({ verified: false, session_state: result.session_state,
                    isolated_task: { task_id: args.isolated_qc.task_id, status: result.status } });
            }
            const result = await client.evaluateCompletion(args.session_id, {
                ...(args.qc_evidence ? { qc_evidence: args.qc_evidence } : {}),
                ...(args.quality_evidence ? { quality_evidence: args.quality_evidence } : {}),
                ...(args.ui_evidence ? { ui_evidence: args.ui_evidence } : {}),
            });
            if (
                !result ||
                typeof result !== 'object' ||
                typeof result.verified !== 'boolean' ||
                !SessionStateSchema.safeParse(result.session_state).success
            ) {
                throw new DualDaemonClientError(
                    'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                    'Daemon returned an invalid completion evaluation response'
                );
            }
            const { blockers, blockers_truncated, blockers_total } = sanitizeCompletionBlockers(result.blockers);
            const receipt = (result.receipt && typeof result.receipt === 'object' && typeof result.receipt.receipt_sha256 === 'string' && /^[0-9a-f]{64}$/.test(result.receipt.receipt_sha256))
                ? { receipt_sha256: result.receipt.receipt_sha256 }
                : undefined;

            return formatToolSuccess({
                verified: result.verified,
                session_state: result.session_state,
                blockers,
                ...(blockers_truncated ? { blockers_truncated: true, blockers_total } : {}),
                ...(receipt ? { receipt } : {}),
            });
        } catch (err) {
            return handleToolError(err, 'DUAL_MCP_COMPLETION_ERROR');
        }
    });

    // 5. omni_dual_resume
    server.registerTool('omni_dual_resume', {
        description: 'Resume an interrupted or paused Dual session from the last durable authority event',
        inputSchema: ResumeInputSchema,
    }, async (args) => {
        try {
            assertWorkspaceMatches(args.workspace_root, boundRoot);
            const client = getClient();
            await assertHealthySession(client, args.session_id, boundRoot);
            if ([args.correction, args.context_reply, args.recovery].filter(Boolean).length > 1) throw new DualDaemonClientError('DUAL_MCP_INVALID_INPUT', 'Reply, correction and recovery are separate controller operations');
            if (args.recovery) {
                const recovered = await client.recoverTask(args.session_id, args.recovery.task_id, args.recovery.plan_revision);
                if (recovered?.taskId !== args.recovery.task_id || !['RECOVERED', 'NO_RECOVERY_NEEDED', 'WAITING_FOR_PROCESS',
                    'NEEDS_PROCESS_EVIDENCE', 'NEEDS_PROCESS_TREE_EVIDENCE'].includes(recovered.status)) {
                    throw new DualDaemonClientError('DUAL_MCP_INVALID_DAEMON_RESPONSE', 'Invalid process recovery acknowledgment');
                }
                if (!['RECOVERED', 'NO_RECOVERY_NEEDED'].includes(recovered.status)) {
                    return formatToolSuccess({ session_id: args.session_id, resumed: false,
                        recovery: { task_id: args.recovery.task_id, status: recovered.status } });
                }
            }
            if (args.correction) {
                const acknowledgment = await client.correctTask(args.session_id, args.correction);
                if (acknowledgment?.acknowledged !== true || acknowledgment.attempt !== args.correction.expected_attempt + 1) {
                    throw new DualDaemonClientError('DUAL_MCP_INVALID_DAEMON_RESPONSE', 'Correction was not acknowledged');
                }
            }
            if (args.context_reply) {
                const acknowledgment = await client.replyToTask(args.session_id, args.context_reply);
                if (acknowledgment?.acknowledged !== true || acknowledgment.message_id !== args.context_reply.message_id) {
                    throw new DualDaemonClientError('DUAL_MCP_INVALID_DAEMON_RESPONSE', 'Controller reply was not acknowledged');
                }
            }
            const result = await client.request('session.resume', {
                session_id: args.session_id,
                ...(args.context_reply ? { task_id: args.context_reply.task_id, plan_revision: args.context_reply.plan_revision } : {}),
                ...(args.correction ? { task_id: args.correction.task_id, plan_revision: args.correction.plan_revision } : {}),
                ...(args.recovery ? { task_id: args.recovery.task_id, plan_revision: args.recovery.plan_revision } : {}),
            });
            if (
                !result ||
                typeof result !== 'object' ||
                result.session_id !== args.session_id ||
                !SessionStateSchema.safeParse(result.state).success ||
                result.resumed !== true
            ) {
                throw new DualDaemonClientError(
                    'DUAL_MCP_INVALID_DAEMON_RESPONSE',
                    'Daemon returned an invalid or unacknowledged resume response'
                );
            }
            return formatToolSuccess({
                session_id: result.session_id,
                state: result.state,
                resumed: true,
            });
        } catch (err) {
            return handleToolError(err, 'DUAL_MCP_RESUME_ERROR');
        }
    });

    server.registerTool('omni_dual_acceptance_correction_start', {
        description: 'Start a policy-bound acceptance correction with CAS sequence, failure provenance, and exact file scope',
        inputSchema: CorrectionStartInputSchema,
    }, async (args) => {
        try {
            assertWorkspaceMatches(args.workspace_root, boundRoot);
            const client = getClient();
            await assertHealthySession(client, args.session_id, boundRoot);
            const result = await client.startAcceptanceCorrection(args.session_id, {
                task_id: args.task_id,
                reason: args.reason,
                expected_sequence: args.expected_sequence,
                start_fingerprint: args.start_fingerprint,
                failure_check_id: args.failure_check_id,
            });
            if (!result || result.started !== true || result.session_id !== args.session_id
                || result.task_id !== args.task_id || typeof result.correction_id !== 'string') {
                throw new DualDaemonClientError('DUAL_MCP_INVALID_DAEMON_RESPONSE', 'Invalid correction start response');
            }
            return formatToolSuccess({ session_id: args.session_id, ...result });
        } catch (err) {
            return handleToolError(err, 'DUAL_MCP_ERROR');
        }
    });

    server.registerTool('omni_dual_acceptance_review_submit', {
        description: 'Submit policy-bound post-integration acceptance review evidence for a verified task',
        inputSchema: AcceptanceReviewSubmitInputSchema,
    }, async (args) => {
        try {
            assertWorkspaceMatches(args.workspace_root, boundRoot);
            const client = getClient();
            await assertHealthySession(client, args.session_id, boundRoot);
            const result = await client.submitAcceptanceReview(args.session_id, args.task_id, args.plan_revision, args.review_evidence);
            if (!result || result.task_id !== args.task_id
                || !['PASSED', 'NEEDS_FIX', 'NEEDS_REVIEW'].includes(result.status)) {
                throw new DualDaemonClientError('DUAL_MCP_INVALID_DAEMON_RESPONSE', 'Invalid acceptance review response');
            }
            return formatToolSuccess({ session_id: args.session_id, ...result });
        } catch (err) {
            return handleToolError(err, 'DUAL_MCP_ERROR');
        }
    });

    server.registerTool('omni_dual_acceptance_correction_complete', {
        description: 'Complete a registered acceptance correction; validator status and delta scope are derived by the daemon',
        inputSchema: CorrectionCompleteInputSchema,
    }, async (args) => {
        try {
            assertWorkspaceMatches(args.workspace_root, boundRoot);
            const client = getClient();
            await assertHealthySession(client, args.session_id, boundRoot);
            const result = await client.completeAcceptanceCorrection(args.session_id, {
                correction_id: args.correction_id,
                ...(args.summary ? { summary: args.summary } : {}),
            });
            if (!result || result.completed !== true || result.session_id !== args.session_id
                || !['PASSED', 'FAILED'].includes(result.status)) {
                throw new DualDaemonClientError('DUAL_MCP_INVALID_DAEMON_RESPONSE', 'Invalid correction completion response');
            }
            return formatToolSuccess({ session_id: args.session_id, ...result });
        } catch (err) {
            return handleToolError(err, 'DUAL_MCP_ERROR');
        }
    });

    server.registerTool('omni_dual_session_block', {
        description: 'Durably block a Dual session with a bounded reason and blocker code',
        inputSchema: SessionBlockInputSchema,
    }, async (args) => {
        try {
            assertWorkspaceMatches(args.workspace_root, boundRoot);
            const client = getClient();
            await assertHealthySession(client, args.session_id, boundRoot);
            const result = await client.blockSession(args.session_id, {
                reason: args.reason,
                blocker_code: args.blocker_code,
            });
            if (!result || result.blocked !== true || result.session_id !== args.session_id
                || result.session_state !== 'BLOCKED') {
                throw new DualDaemonClientError('DUAL_MCP_INVALID_DAEMON_RESPONSE', 'Invalid session block response');
            }
            return formatToolSuccess({ session_id: args.session_id, ...result });
        } catch (err) {
            return handleToolError(err, 'DUAL_MCP_ERROR');
        }
    });

    return server;
}

// --------------------------------------------------------------------------
// Flush-Safe Stdio Diagnostics and Main Entrypoint
// --------------------------------------------------------------------------
async function writeStderr(msg) {
    return new Promise((resolve) => {
        if (!process.stderr.write(msg)) {
            process.stderr.once('drain', resolve);
        } else {
            process.nextTick(resolve);
        }
    });
}

export async function main(argv = process.argv.slice(2)) {
    let workspaceRoot = process.cwd();

    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--workspace' || argv[i] === '-w') {
            if (!argv[i + 1] || argv[i + 1].startsWith('-')) {
                await writeStderr('Error: --workspace requires a valid directory argument\n');
                process.exitCode = 1;
                return;
            }
            workspaceRoot = argv[++i];
        } else if (argv[i] === '--help' || argv[i] === '-h') {
            await writeStderr('Usage: omni-dual-mcp-server [--workspace <dir>]\n');
            process.exitCode = 0;
            return;
        } else {
            await writeStderr('Error: Invalid command-line argument provided\n');
            process.exitCode = 1;
            return;
        }
    }

    let serverInstance;
    try {
        serverInstance = createOmniDualMcpServer({ workspaceRoot });
    } catch {
        await writeStderr('Error: Failed to initialize Dual MCP server\n');
        process.exitCode = 1;
        return;
    }

    const transport = new StdioServerTransport();

    let closing = false;
    const removeSignalListeners = () => {
        process.removeListener('SIGINT', handleSignal);
        process.removeListener('SIGTERM', handleSignal);
        process.stdin.removeListener('end', handleStdinEnd);
        process.stdin.removeListener('close', handleStdinEnd);
    };

    const handleSignal = async () => {
        if (closing) return;
        closing = true;
        removeSignalListeners();
        try {
            if (serverInstance) {
                await serverInstance.close();
            }
        } catch {
            // ignore
        }
        await writeStderr('');
        process.exit(0);
    };

    const handleStdinEnd = () => {
        void handleSignal();
    };

    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
    process.stdin.once('end', handleStdinEnd);
    process.stdin.once('close', handleStdinEnd);

    try {
        await serverInstance.connect(transport);
        if (serverInstance.server) {
            const originalOnClose = serverInstance.server.onclose;
            serverInstance.server.onclose = () => {
                removeSignalListeners();
                if (typeof originalOnClose === 'function') {
                    originalOnClose();
                }
            };
        }
    } catch {
        removeSignalListeners();
        await writeStderr('Error: Failed to connect Dual MCP transport\n');
        process.exitCode = 1;
        return;
    }
}

// Auto-run if executed directly
if (process.argv[1]) {
    try {
        const scriptPath = path.resolve(process.argv[1]);
        const currentPath = fileURLToPath(import.meta.url);
        if (scriptPath === currentPath) {
            main().then(() => {
                if (process.exitCode !== undefined && process.exitCode !== 0) {
                    process.exit(process.exitCode);
                }
            }).catch(async () => {
                await writeStderr('Error: Fatal uncaught MCP server error\n');
                process.exit(1);
            });
        }
    } catch {
        // ignore resolution error
    }
}
