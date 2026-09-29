'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { exactExternalOperation } = require('./external-operations');
const { validateTaskPath } = require('./task-workspace');
const { ValidationCommandSchema } = require('./contracts');
const { buildValidatorEnv, redactArgv, redactDiagnostic } = require('./validator-security');

const {
    acquireDaemonLock,
    computeWorkspaceId,
    getRuntimeDir,
    DualDaemonLockError,
} = require('./daemon-lock');

const {
    normalizeBaselineCorrelation,
    validateEventSequence,
    validatePhaseArtifactHashes,
    parseContract,
    ContextSchema,
    SpecSchema,
    RouteSchema,
    EvidenceSchema,
    ReviewSchema,
    EventSchema,
    QcEvidenceSchema,
    QualityEvidenceSchema,
    UiEvidenceSchema,
} = require('./contracts');

const {
    normalizeRepoPath,
    resolveWorkspace,
} = require('./workspace');

const {
    runCapabilityPreflight,
    validateCapabilityResult,
    getRetryableCapabilityPreflightCode,
} = require('./capability-preflight');

const {
    computeSnapshotManifestFingerprint,
} = require('./baseline-snapshot');

const {
    createConfiguredSnapshotBaseline,
} = require('./snapshot-policy');

const {
    writeInitialSnapshot,
    readInitialSnapshot,
    writeAcceptedSnapshot,
    readAcceptedSnapshot,
    buildReceiptObject,
    computeReceiptSha256,
} = require('./snapshot-store');

const {
    detectBaselineBackend,
    createGitBaseline,
} = require('./baseline');

const {
    createOrchestratorAdapter,
} = require('./orchestrator-adapter');
const { completeIsolatedTask } = require('./isolated-qc');
const { orderedTasks } = require('./task-scheduler');
const {
    validateAcceptancePolicy,
    hashAcceptancePolicy,
    ReviewSubmissionSchema,
    createReviewAttestation,
    reviewAttestationEvidence,
    evaluateAttestedReview,
    evaluateSessionAcceptance,
} = require('./acceptance-policy');
const { postTaskMessage } = require('./task-messages');
const { requestTaskCorrection } = require('./task-correction');
const { recoverTaskLease } = require('./task-processes');

const {
    evaluateMandatoryGates,
    evaluateQualityCompletion,
    createQualityLedger,
} = require('./quality-ledger');
const { buildQualityPlan, deriveQualityExecutionId, verifyQualityExecutionArtifact } = require('./quality-runner');

const {
    recordUiEvidence,
} = require('./ui-gate');

const {
    captureDiffFingerprint,
    listUntrackedFiles,
    DEFAULT_RUNTIME_PATHS,
} = require('./scope-guard');
const { execGit } = require('./workspace');

const {
    resolveConfiguredWorkerModel,
    resolveConfiguredWorkerEffort,
} = require('./agy-model');

const {
    evaluateSetupReadiness,
} = require('./setup-command');

class DualDaemonServerError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DualDaemonServerError';
        this.code = code;
        this.details = details;
    }
}

function digestEqual(expected, actual) {
    if (typeof expected !== 'string' || typeof actual !== 'string'
        || !/^[0-9a-f]{64}$/.test(expected) || !/^[0-9a-f]{64}$/.test(actual)) return false;
    const left = Buffer.from(expected, 'hex');
    const right = Buffer.from(actual, 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const CANONICAL_UI_GATE_ID = 'responsive_visual_qa';
const LEGACY_UI_FALLBACK = Object.freeze({
    required: true,
    viewport_widths: Object.freeze([390, 768, 1024, 1440]),
    reduced_motion_required: true,
});

function sameOrderedValues(left, right) {
    return Array.isArray(left) && Array.isArray(right)
        && left.length === right.length
        && left.every((value, index) => value === right[index]);
}

function sha256Json(value, cryptoImpl = crypto) {
    return cryptoImpl.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stableJsonValue(value) {
    if (Array.isArray(value)) return value.map(stableJsonValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])]));
}

function sameJsonValue(left, right) {
    return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
}

const QUALITY_EXECUTION_BINDING_FIELDS = Object.freeze([
    'execution_id', 'artifact_sha256', 'policy_sha256', 'diff_fingerprint', 'cycle_index',
    'attempt', 'total_tasks', 'completed_task_ids', 'session_id', 'workspace_id',
    'plan_revision', 'expected_baseline',
]);
const QUALITY_EXECUTION_ATTEMPT_IDENTITY_FIELDS = Object.freeze([
    'policy_sha256', 'diff_fingerprint', 'cycle_index', 'attempt', 'session_id',
    'workspace_id', 'plan_revision', 'expected_baseline',
]);

function sameQualityExecutionBinding(left, right) {
    return QUALITY_EXECUTION_BINDING_FIELDS.every((field) => sameJsonValue(left?.[field], right?.[field]));
}

function sameQualityExecutionAttemptIdentity(left, right) {
    return QUALITY_EXECUTION_ATTEMPT_IDENTITY_FIELDS.every((field) => sameJsonValue(left?.[field], right?.[field]));
}

function qualityExecutionBinding(expected, executionId, artifactSha256) {
    return {
        execution_id: executionId,
        artifact_sha256: artifactSha256,
        policy_sha256: expected.policySha256,
        diff_fingerprint: expected.diffFingerprint,
        cycle_index: expected.cycleIndex,
        attempt: expected.attempt,
        total_tasks: expected.totalTasks,
        completed_task_ids: [...expected.completedTaskIds],
        session_id: expected.sessionId,
        workspace_id: expected.workspaceId,
        plan_revision: expected.planRevision,
        expected_baseline: expected.baseline,
    };
}

function appendQualityExecutionAttestation(authorityStore, binding) {
    const current = authorityStore.derive();
    const existing = current.qualityExecutions?.[binding.execution_id];
    if (existing) {
        if (!sameQualityExecutionBinding(existing, binding)) {
            throw new DualDaemonServerError('DUAL_QUALITY_ATTESTATION_INVALID',
                'Durable quality execution attestation conflicts with the current execution identity');
        }
        return existing;
    }
    const ack = authorityStore.append({
        schema_version: 2,
        type: 'quality.execution.attested',
        // Supply these identity fields explicitly so append cannot bind a
        // delayed execution to a newer session, revision, or baseline.
        workspace_id: binding.workspace_id,
        session_id: binding.session_id,
        plan_revision: binding.plan_revision,
        expected_baseline: binding.expected_baseline,
        execution_id: binding.execution_id,
        artifact_sha256: binding.artifact_sha256,
        policy_sha256: binding.policy_sha256,
        diff_fingerprint: binding.diff_fingerprint,
        cycle_index: binding.cycle_index,
        attempt: binding.attempt,
        total_tasks: binding.total_tasks,
        completed_task_ids: binding.completed_task_ids,
    });
    if (ack.type !== 'quality.execution.attested' || !sameQualityExecutionBinding(ack, binding)) {
        throw new DualDaemonServerError('DUAL_QUALITY_ATTESTATION_INVALID',
            'Authority store did not durably acknowledge the complete quality execution attestation');
    }
    return ack;
}

function verifyTrustedUiArtifacts({ authorityDir, artifactPaths, expectedHashes, fsImpl = fs, cryptoImpl = crypto }) {
    if (!Array.isArray(artifactPaths) || artifactPaths.length !== expectedHashes.length || artifactPaths.length === 0) {
        throw new DualDaemonServerError('DUAL_UI_ATTESTATION_INVALID', 'Trusted UI adapter must return one artifact path for every artifact hash');
    }
    const uiRoot = path.join(authorityDir, 'ui');
    let canonicalUiRoot;
    try {
        canonicalUiRoot = fsImpl.realpathSync?.native ? fsImpl.realpathSync.native(uiRoot) : fsImpl.realpathSync(uiRoot);
    } catch (cause) {
        throw new DualDaemonServerError('DUAL_UI_ATTESTATION_INVALID', 'Trusted UI artifact directory is unavailable', { cause });
    }
    const hashes = artifactPaths.map((artifactPath, index) => {
        if (typeof artifactPath !== 'string' || artifactPath.trim() === '') {
            throw new DualDaemonServerError('DUAL_UI_ATTESTATION_INVALID', 'Trusted UI artifact path must be a non-empty string');
        }
        const target = path.isAbsolute(artifactPath) ? path.normalize(artifactPath) : path.resolve(authorityDir, artifactPath);
        let canonicalTarget;
        let stat;
        let bytes;
        try {
            canonicalTarget = fsImpl.realpathSync?.native ? fsImpl.realpathSync.native(target) : fsImpl.realpathSync(target);
            const relative = path.relative(canonicalUiRoot, canonicalTarget);
            if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('path escapes run-owned UI directory');
            stat = fsImpl.lstatSync(canonicalTarget);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 25 * 1024 * 1024) throw new Error('artifact must be a bounded regular file');
            bytes = fsImpl.readFileSync(canonicalTarget);
        } catch (cause) {
            throw new DualDaemonServerError('DUAL_UI_ATTESTATION_INVALID', `Trusted UI artifact ${index + 1} is invalid`, { cause });
        }
        return cryptoImpl.createHash('sha256').update(bytes).digest('hex');
    });
    if (!sameOrderedValues(hashes, expectedHashes)) {
        throw new DualDaemonServerError('DUAL_UI_ARTIFACT_HASH_MISMATCH', 'Server-side UI artifact hashes do not match adapter evidence');
    }
    return hashes;
}

function persistedUiRequirement(derived) {
    const policy = derived.plan?.acceptance_policy || derived.plan?.acceptancePolicy;
    const ui = policy?.ui || LEGACY_UI_FALLBACK;
    return {
        policy,
        policySha256: policy ? hashAcceptancePolicy(policy) : null,
        requirement: {
            gate_id: CANONICAL_UI_GATE_ID,
            required: ui.required,
            viewport_widths: [...ui.viewport_widths],
            reduced_motion_required: ui.reduced_motion_required,
        },
        legacyFallback: !policy?.ui,
    };
}

function captureCorrectionState(repoRoot, baseCommit) {
    const tracked = execGit(['diff', '--name-only', '-z', baseCommit, '--', '.'], { cwd: repoRoot, encoding: null })
        .toString('utf8').split('\0').filter(Boolean);
    const untracked = listUntrackedFiles({ repoRoot, excludedPaths: ['.omni'] });
    const excluded = ['.omni', ...DEFAULT_RUNTIME_PATHS].map((item) => String(item).replace(/\\/g, '/').replace(/\/+$/, ''));
    const isExcluded = (file) => excluded.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));
    const files = [...new Set([...tracked, ...untracked].map((file) => file.replace(/\\/g, '/')).filter((file) => !isExcluded(file)))].sort();
    const entries = {};
    for (const file of files) {
        const normalized = normalizeRepoPath(repoRoot, file);
        const target = path.join(repoRoot, ...normalized.split('/'));
        try {
            const stat = fs.lstatSync(target);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('non-regular file');
            const bytes = fs.readFileSync(target);
            entries[normalized] = { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mode: stat.mode & 0o777 };
        } catch (error) {
            if (error.code === 'ENOENT') entries[normalized] = null;
            else throw new DualDaemonServerError('DUAL_DIFF_FAILED', `Unable to capture correction state for ${normalized}`);
        }
    }
    const canonical = JSON.stringify(Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b))));
    return {
        files,
        entries,
        state_sha256: crypto.createHash('sha256').update(canonical).digest('hex'),
        diff_fingerprint: captureDiffFingerprint({ repoRoot, baseCommit, excludedPaths: ['.omni'] }).patchSha256,
    };
}

function verifyPlanArtifact(workspaceRoot, params, { fsImpl = fs, cryptoImpl = crypto } = {}) {
    let normalizedPath;
    try {
        normalizedPath = normalizeRepoPath(workspaceRoot, params.plan_path);
    } catch (cause) {
        throw new DualDaemonServerError('DUAL_PLAN_INVALID', 'plan_path must be a repository-relative path inside the workspace', { cause });
    }

    const absolutePath = path.join(workspaceRoot, ...normalizedPath.split('/'));
    let stat;
    let content;
    try {
        stat = fsImpl.statSync(absolutePath);
        if (!stat.isFile()) {
            throw new Error('not a regular file');
        }
        content = fsImpl.readFileSync(absolutePath);
    } catch (cause) {
        throw new DualDaemonServerError('DUAL_PLAN_INVALID', 'plan_path must reference a readable regular file', { cause });
    }

    const actualSha256 = cryptoImpl.createHash('sha256').update(content).digest('hex');
    if (actualSha256 !== params.plan_sha256) {
        throw new DualDaemonServerError(
            'DUAL_PLAN_HASH_MISMATCH',
            'plan_sha256 does not match the current plan artifact',
            { plan_path: normalizedPath, actual_sha256: actualSha256 }
        );
    }
    return { plan_path: normalizedPath, plan_sha256: actualSha256 };
}

function unlinkOwnDiscovery(discoveryPath, fsImpl, expectedOwnership) {
    if (!fsImpl.existsSync(discoveryPath)) {
        return;
    }
    let rawContent;
    try {
        rawContent = fsImpl.readFileSync(discoveryPath, 'utf8');
    } catch {
        return;
    }
    let onDisk;
    try {
        onDisk = JSON.parse(rawContent);
    } catch {
        return;
    }
    if (
        onDisk &&
        typeof onDisk === 'object' &&
        onDisk.pid === expectedOwnership.pid &&
        onDisk.started_at === expectedOwnership.startedAt &&
        onDisk.workspace_id === expectedOwnership.workspaceId
    ) {
        try {
            fsImpl.unlinkSync(discoveryPath);
        } catch {
            // ignore unlink errors
        }
    }
}

const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KiB

function safeTokenCompare(expectedToken, candidateToken) {
    if (typeof expectedToken !== 'string' || typeof candidateToken !== 'string') {
        return false;
    }
    const expectedBuf = Buffer.from(expectedToken, 'utf8');
    const candidateBuf = Buffer.from(candidateToken, 'utf8');
    if (expectedBuf.length !== candidateBuf.length) {
        return false;
    }
    return crypto.timingSafeEqual(expectedBuf, candidateBuf);
}

function extractToken(req, body) {
    const authHeader = req.headers['authorization'];
    if (authHeader && typeof authHeader === 'string') {
        const parts = authHeader.trim().split(/\s+/);
        if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
            return parts[1];
        }
    }
    if (body && typeof body === 'object' && typeof body.token === 'string') {
        return body.token;
    }
    return null;
}

function sendJsonResponse(res, statusCode, payload) {
    if (res.writableEnded) return;
    const bodyStr = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(bodyStr),
    });
    res.end(bodyStr);
}

function sendError(res, statusCode, code, message, details = {}) {
    sendJsonResponse(res, statusCode, {
        error: {
            code,
            message,
            ...(Object.keys(details).length > 0 ? { details } : {}),
        },
    });
}

function samePreflightAuthorityVersion(before, after) {
    return Boolean(before && after
        && before.sessionId === after.sessionId
        && before.workspaceId === after.workspaceId
        && before.workspaceRoot === after.workspaceRoot
        && before.sessionState === after.sessionState
        && before.planRevision === after.planRevision
        && before.lastSequence === after.lastSequence
        && before.lastHash === after.lastHash
        && before.lastEventId === after.lastEventId
        && JSON.stringify(before.currentBaseline) === JSON.stringify(after.currentBaseline));
}

function inspectFreshDiscoveredPreflight(derived, authorityStore) {
    if (!derived || derived.sessionState !== 'DISCOVERED' || derived.plan) return { fresh: false, integrityError: false };
    if (Object.keys(derived.tasks || {}).length !== 0
        || Object.keys(derived.leases || {}).length !== 0
        || Object.keys(derived.gates || {}).length !== 0) {
        return { fresh: false, integrityError: false };
    }
    if (typeof authorityStore.readEvents !== 'function' || typeof authorityStore.readOperationRecords !== 'function') {
        return { fresh: false, integrityError: true };
    }

    try {
        const events = authorityStore.readEvents();
        const operations = authorityStore.readOperationRecords();
        return {
            fresh: Array.isArray(events)
                && !events.some((event) => event.type === 'capability.result' && event.status === 'PASSED')
                && Array.isArray(operations)
                && operations.length === 0,
            integrityError: false,
        };
    } catch {
        return { fresh: false, integrityError: true };
    }
}

function sendResult(res, statusCode, result) {
    sendJsonResponse(res, statusCode, {
        result,
    });
}

async function startDaemonServer(options = {}) {
    const {
        workspaceRoot = process.cwd(),
        authorityStore,
        clock = (() => new Date()),
        idleTimeoutMs = 0,
        port = 0,
        host = '127.0.0.1',
        fsImpl = fs,
        cryptoImpl = crypto,
        healthProbe,
        isProcessAlive,
        processIdentityMatches,
        capabilityPreflight,
        preflightRunner,
        orchestrator,
        agyCommand = 'agy',
        agyPrefixArgs = [],
        processRunner,
        gitRunner,
        planArtifactVerifier = verifyPlanArtifact,
        trustedQualityRunner = null,
        trustedUiAdapter = null,
    } = options;

    const effectivePreflight = capabilityPreflight || preflightRunner;

    if (host !== '127.0.0.1') {
        throw new DualDaemonServerError(
            'DUAL_SERVER_HOST_INVALID',
            `Daemon server can only bind to loopback address 127.0.0.1, got: ${host}`
        );
    }

    if (!authorityStore || typeof authorityStore.derive !== 'function') {
        throw new DualDaemonServerError(
            'DUAL_SERVER_INVALID_CONFIG',
            'authorityStore is required and must implement derive() and verifyIntegrity()'
        );
    }
    if (trustedQualityRunner !== null && typeof trustedQualityRunner !== 'function') {
        throw new DualDaemonServerError('DUAL_SERVER_INVALID_CONFIG', 'trustedQualityRunner must be a function or null');
    }
    if (trustedUiAdapter !== null && typeof trustedUiAdapter !== 'function') {
        throw new DualDaemonServerError('DUAL_SERVER_INVALID_CONFIG', 'trustedUiAdapter must be a function or null');
    }

    let canonicalWorkspaceRoot;
    try {
        canonicalWorkspaceRoot = fsImpl.realpathSync?.native
            ? fsImpl.realpathSync.native(workspaceRoot)
            : (fsImpl.realpathSync ? fsImpl.realpathSync(workspaceRoot) : path.resolve(workspaceRoot));
    } catch {
        canonicalWorkspaceRoot = path.resolve(workspaceRoot);
    }

    const configuredSnapshotBaseline = () => createConfiguredSnapshotBaseline({
        root: canonicalWorkspaceRoot,
        fsImpl,
        cryptoImpl,
    });

    const effectiveOrchestrator = orchestrator !== undefined ? orchestrator : createOrchestratorAdapter({
        workspaceRoot: canonicalWorkspaceRoot,
        authorityStore,
        clock,
        agyCommand,
        agyPrefixArgs,
        processRunner,
        gitRunner,
    });

    const workspaceId = computeWorkspaceId(canonicalWorkspaceRoot, cryptoImpl);
    const runtimeDir = getRuntimeDir(canonicalWorkspaceRoot);
    const startedAt = new Date(clock()).toISOString();
    const pid = process.pid;

    // Acquire exclusive single-instance daemon lock
    let lockHandle;
    try {
        lockHandle = await acquireDaemonLock({
            runtimeDir,
            workspaceId,
            pid,
            startedAt,
            healthProbe,
            isProcessAlive,
            processIdentityMatches,
            fsImpl,
            clock,
        });
    } catch (err) {
        if (err instanceof DualDaemonLockError) {
            throw err;
        }
        throw new DualDaemonServerError(
            'DUAL_LOCK_ERROR',
            `Failed to acquire lock: ${err.message}`,
            { cause: err }
        );
    }

    const token = cryptoImpl.randomBytes(32).toString('hex');
    const qualityExecutionInFlight = new Map();
    const trustedUiExecutions = new Map();
    let isStopped = false;
    let idleTimer = null;
    let lastActivityTime = Date.now();

    const server = http.createServer((req, res) => {
        lastActivityTime = Date.now();

        // 1. Method check: POST only
        if (req.method !== 'POST') {
            return sendError(res, 405, 'DUAL_METHOD_NOT_ALLOWED', 'Only POST method is allowed');
        }

        // 2. Content-Type check: application/json
        const contentType = req.headers['content-type'] || '';
        if (!contentType.toLowerCase().startsWith('application/json')) {
            return sendError(
                res,
                415,
                'DUAL_CONTENT_TYPE_INVALID',
                'Content-Type must be application/json'
            );
        }

        // 3. Collect body with 64 KiB size limit
        const chunks = [];
        let bytesReceived = 0;
        let tooLarge = false;

        req.on('data', (chunk) => {
            if (tooLarge) return;
            bytesReceived += chunk.length;
            if (bytesReceived > MAX_PAYLOAD_BYTES) {
                tooLarge = true;
                req.pause();
                sendError(
                    res,
                    413,
                    'DUAL_REQUEST_TOO_LARGE',
                    `Request exceeds maximum size limit of ${MAX_PAYLOAD_BYTES} bytes`
                );
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            if (tooLarge) return;

            const bodyStr = Buffer.concat(chunks).toString('utf8');
            let body;
            try {
                body = JSON.parse(bodyStr);
            } catch (err) {
                return sendError(
                    res,
                    400,
                    'DUAL_MALFORMED_JSON',
                    `Malformed JSON body: ${err.message}`
                );
            }

            if (!body || typeof body !== 'object' || Array.isArray(body)) {
                return sendError(
                    res,
                    400,
                    'DUAL_MALFORMED_JSON',
                    'Request body must be a JSON object'
                );
            }

            // 4. Protocol version check: 1
            if (body.protocol_version !== 1) {
                return sendError(
                    res,
                    400,
                    'DUAL_PROTOCOL_VERSION_INVALID',
                    `Unsupported protocol_version: ${body.protocol_version}`
                );
            }

            // 5. Authentication check: bearer token
            const candidateToken = extractToken(req, body);
            if (!candidateToken || !safeTokenCompare(token, candidateToken)) {
                return sendError(
                    res,
                    401,
                    'DUAL_UNAUTHORIZED',
                    'Missing or invalid bearer authorization token'
                );
            }

            // 6. Workspace ID check
            if (!body.workspace_id || body.workspace_id !== workspaceId) {
                return sendError(
                    res,
                    403,
                    'DUAL_WORKSPACE_MISMATCH',
                    `Workspace mismatch: request targeted ${body.workspace_id || 'unspecified'}`
                );
            }

            const method = body.method;
            const params = body.params || body;

            // Session ID correlation check if session is initialized
            let derivedState;
            try {
                derivedState = authorityStore.derive();
            } catch {
                derivedState = null;
            }

            if (derivedState && derivedState.sessionId) {
                const methodsRequiringSessionId = [
                    'session.status',
                    'hook.evaluate',
                    'quality.execute',
                    'completion.evaluate',
                    'plan.register',
                    'session.resume',
                    'task.qc',
                    'acceptance.review.prepare',
                    'acceptance.review.submit',
                    'task.reply',
                    'task.correct',
                    'task.recover',
                    'acceptance.correction.start',
                    'acceptance.correction.complete',
                    'session.block',
                ];
                if (methodsRequiringSessionId.includes(method)) {
                    const requestedSessionId = (params && params.session_id !== undefined) ? params.session_id : body.session_id;
                    if (!requestedSessionId || typeof requestedSessionId !== 'string' || requestedSessionId.trim().length === 0) {
                        return sendError(
                            res,
                            400,
                            'DUAL_SESSION_REQUIRED',
                            `session_id is required for ${method} when an active session exists`
                        );
                    }
                    if (requestedSessionId !== derivedState.sessionId) {
                        return sendError(
                            res,
                            403,
                            'DUAL_SESSION_MISMATCH',
                            `Session ID mismatch: active session is ${derivedState.sessionId}, request specified ${requestedSessionId}`
                        );
                    }
                } else if (method !== 'session.begin' && params.session_id && params.session_id !== derivedState.sessionId) {
                    return sendError(
                        res,
                        403,
                        'DUAL_SESSION_MISMATCH',
                        `Session ID mismatch: active session is ${derivedState.sessionId}, request specified ${params.session_id}`
                    );
                }
            }

            // 7. Dispatch RPC method
            handleRpcMethod(method, params, res);
        });
    });

    function handleRpcMethod(method, params, res) {
        switch (method) {
            case 'health':
                return handleHealth(res);
            case 'session.begin':
                return handleSessionBegin(params, res);
            case 'session.status':
                return handleSessionStatus(params, res);
            case 'plan.register':
                return handlePlanRegister(params, res);
            case 'session.resume':
                return handleSessionResume(params, res);
            case 'hook.evaluate':
                return handleHookEvaluate(params, res);
            case 'quality.execute':
                return handleQualityExecute(params, res);
            case 'completion.evaluate':
                return handleCompletionEvaluate(params, res);
            case 'task.qc':
                return handleIsolatedQc(params, res);
            case 'acceptance.review.prepare':
                return handleAcceptanceReviewPrepare(params, res);
            case 'acceptance.review.submit':
                return handleAcceptanceReviewSubmit(params, res);
            case 'task.reply':
                return handleTaskReply(params, res);
            case 'task.correct':
                return handleTaskCorrection(params, res);
            case 'task.recover':
                return handleTaskRecovery(params, res);
            case 'acceptance.correction.start':
                return handleAcceptanceCorrectionStart(params, res);
            case 'acceptance.correction.complete':
                return handleAcceptanceCorrectionComplete(params, res);
            case 'session.block':
                return handleSessionBlock(params, res);
            case 'daemon.stop':
                return handleDaemonStop(res);
            default:
                return sendError(
                    res,
                    404,
                    'DUAL_METHOD_NOT_FOUND',
                    `Method not found: ${method}`
                );
        }
    }

    function handleHealth(res) {
        let integrity;
        let derived;
        try {
            integrity = authorityStore.verifyIntegrity();
            derived = authorityStore.derive();
        } catch (err) {
            return sendError(
                res,
                500,
                'DUAL_INTEGRITY_CORRUPT',
                `Authority store integrity check failed: ${err.message}`
            );
        }

        if (!integrity || !integrity.valid) {
            return sendError(
                res,
                500,
                'DUAL_INTEGRITY_CORRUPT',
                'Authority store integrity invalid'
            );
        }

        const address = server.address();
        sendResult(res, 200, {
            status: 'healthy',
            protocol_version: 1,
            workspace_id: workspaceId,
            workspace_root: canonicalWorkspaceRoot,
            pid,
            started_at: startedAt,
            session_id: (derived && derived.sessionId) ? derived.sessionId : null,
            session_state: (derived && derived.sessionState) ? derived.sessionState : null,
            current_baseline: (derived && derived.currentBaseline) ? derived.currentBaseline : null,
            endpoint: {
                host: '127.0.0.1',
                port: address ? address.port : 0,
            },
            authority: {
                valid: true,
                event_count: integrity.eventCount,
                last_sequence: integrity.lastSequence,
                last_hash: integrity.lastHash,
            },
        });
    }

    async function handleQualityExecute(params, res) {
        try {
            if (!params || !Number.isSafeInteger(params.cycle_index)
                || ![1, 2, 3].includes(params.cycle_index)
                || Object.keys(params).some((key) => !['session_id', 'cycle_index'].includes(key))) {
                return sendError(res, 400, 'DUAL_QUALITY_EXECUTION_INVALID', 'Quality execution requires only session_id and cycle_index 1..3');
            }
            if (!trustedQualityRunner) {
                return sendError(res, 400, 'DUAL_QUALITY_ATTESTATION_REQUIRED', 'Fresh quality evidence requires a daemon-owned runner in the current daemon process');
            }
            const derived = authorityStore.derive();
            const policy = derived.plan?.acceptance_policy || derived.plan?.acceptancePolicy;
            if (!policy) {
                return sendError(res, 400, 'DUAL_QUALITY_ARTIFACT_BINDING', 'Legacy session has no persisted acceptance policy; create a new run before executing fresh quality evidence');
            }
            const taskIds = Object.keys(derived.tasks || {});
            const completedTaskIdsNow = taskIds.filter((taskId) => derived.tasks[taskId]?.state === 'TASK_VERIFIED');
            const allTasksVerified = taskIds.length > 0 && completedTaskIdsNow.length === taskIds.length;
            const expectedSessionState = allTasksVerified ? 'ACCEPTANCE' : 'EXECUTING';
            const finalizedReplayState = allTasksVerified && derived.sessionState === 'VERIFIED';
            if (taskIds.length === 0 || (derived.sessionState !== expectedSessionState && !finalizedReplayState)) {
                return sendError(res, 400, 'DUAL_QC_UNVERIFIED_TASK',
                    `Quality checkpoint requires session state ${expectedSessionState}; verified ${completedTaskIdsNow.length}/${taskIds.length} in ${derived.sessionState}`);
            }
            const authorityDir = path.join(canonicalWorkspaceRoot, '.omni', 'runs', 'dual-authority');
            let diffFingerprint;
            if (derived.currentBaseline?.kind === 'snapshot') {
                const initialSnapshot = readInitialSnapshot({
                    authorityDir,
                    sessionId: derived.sessionId,
                    workspaceId: derived.workspaceId,
                    workspaceRoot: canonicalWorkspaceRoot,
                    fsImpl,
                    cryptoImpl,
                });
                const { baseline: snapBaseline, excludedPaths } = configuredSnapshotBaseline();
                diffFingerprint = snapBaseline.fingerprint(initialSnapshot.identity, initialSnapshot.manifest, { excludedPaths }).patchSha256;
            } else {
                diffFingerprint = captureDiffFingerprint({
                    repoRoot: canonicalWorkspaceRoot,
                    baseCommit: derived.currentBaseline?.id,
                    excludedPaths: ['.omni'],
                }).patchSha256;
            }
            const registeredCommands = Object.values(derived.tasks || {})
                .flatMap((task) => Array.isArray(task.validation_commands) ? task.validation_commands : []);
            const qualityPlan = buildQualityPlan(canonicalWorkspaceRoot, fsImpl, { validationCommands: registeredCommands });
            const qualityLedger = createQualityLedger({
                authorityStore,
                readDiffFingerprint: () => diffFingerprint,
            });
            let cycleHistory;
            try {
                cycleHistory = qualityLedger.inspectCycle(params.cycle_index);
            } catch (error) {
                if (['DUAL_QUALITY_PRIOR_CYCLE_NOT_PASSED', 'DUAL_QUALITY_LATER_CYCLE_EXISTS'].includes(error.code)) {
                    return sendError(res, 409, 'DUAL_QUALITY_CYCLE_ORDER',
                        `Quality cycle ${params.cycle_index} requires earlier PASSED cycles in the current source generation`);
                }
                return sendError(res, 400, error.code || 'DUAL_QUALITY_EXECUTION_FAILED', error.message || 'Quality cycle history is invalid');
            }
            if (finalizedReplayState && !cycleHistory.successfulEvent) {
                return sendError(res, 409, 'DUAL_SESSION_VERIFIED',
                    'A verified session can replay only a previously successful quality checkpoint from the current generation');
            }
            if (cycleHistory.successfulEvent && cycleHistory.unresolvedExecutions.length > 0) {
                return sendError(res, 409, 'DUAL_QUALITY_EXECUTION_CONFLICT',
                    `Quality cycle ${params.cycle_index} has both a successful gate and an unresolved attested attempt`);
            }
            const priorExecution = cycleHistory.successfulExecution || cycleHistory.unresolvedExecutions[0] || null;
            const attempt = priorExecution ? priorExecution.attempt : cycleHistory.attempts + 1;
            if (attempt > 3) {
                return sendError(res, 409, 'DUAL_QC_ATTEMPT_EXHAUSTED', `Quality cycle ${params.cycle_index} has exhausted its three attempts in this source generation`);
            }
            const completedTaskIds = priorExecution
                ? [...priorExecution.completed_task_ids]
                : completedTaskIdsNow;
            const cycleThreshold = Math.ceil(taskIds.length * params.cycle_index / 3);
            if (completedTaskIds.length < cycleThreshold
                || completedTaskIds.some((taskId) => derived.tasks[taskId]?.state !== 'TASK_VERIFIED')) {
                return sendError(res, 400, 'DUAL_QC_UNVERIFIED_TASK',
                    `Quality cycle ${params.cycle_index} requires at least ${cycleThreshold} currently verified tasks in its bound checkpoint`);
            }
            const expected = {
                sessionId: derived.sessionId,
                workspaceId: derived.workspaceId,
                baseline: derived.currentBaseline,
                planRevision: derived.planRevision,
                policySha256: hashAcceptancePolicy(policy),
                diffFingerprint,
                cycleIndex: params.cycle_index,
                attempt,
                totalTasks: taskIds.length,
                completedTaskIds,
                workspaceRoot: canonicalWorkspaceRoot,
                commandPlan: qualityPlan.commands,
            };
            const executionId = deriveQualityExecutionId({
                workspaceRoot: canonicalWorkspaceRoot,
                sessionId: derived.sessionId,
                workspaceId: derived.workspaceId,
                baseline: derived.currentBaseline,
                planRevision: derived.planRevision,
                policySha256: hashAcceptancePolicy(policy),
                diffFingerprint,
                cycleIndex: params.cycle_index,
                attempt,
                totalTasks: taskIds.length,
                completedTaskIds,
                commandPlan: qualityPlan.commands,
            }, { fsImpl });
            const existingAnchor = priorExecution || derived.qualityExecutions?.[executionId] || null;
            if (existingAnchor && existingAnchor.execution_id !== executionId) {
                return sendError(res, 409, 'DUAL_QUALITY_EXECUTION_CONFLICT',
                    `Quality cycle ${params.cycle_index} attempt ${attempt} is durably anchored under a different runtime or execution identity; no validators were run and no authority or artifact state was changed. Preserve this session and start a new session if the runtime change is intentional.`);
            }
            const attemptIdentity = qualityExecutionBinding(expected, executionId, null);
            const conflictingAttempt = existingAnchor ? null : Object.values(derived.qualityExecutions || {}).find((anchor) =>
                sameQualityExecutionAttemptIdentity(anchor, attemptIdentity));
            if (conflictingAttempt) {
                return sendError(res, 409, 'DUAL_QUALITY_EXECUTION_CONFLICT',
                    `Quality cycle ${params.cycle_index} attempt ${attempt} already has a durable execution under a different execution ID; no validators were run. Do not increment the attempt automatically.`);
            }

            const runQualityExecution = async () => {
                const executed = await trustedQualityRunner({
                    mode: 'execute',
                    authorityDir,
                    workspaceRoot: canonicalWorkspaceRoot,
                    expected,
                    ...(existingAnchor ? { executionAttestation: existingAnchor } : {}),
                });
                const qualityEvidence = parseContract(QualityEvidenceSchema, executed?.quality_evidence, 'quality_evidence');
                if (executed?.execution_id !== qualityEvidence.provenance.execution_id
                    || executed.execution_id !== executionId
                    || !digestEqual(executed?.artifact_sha256, qualityEvidence.evidence_sha256)) {
                    throw new DualDaemonServerError('DUAL_QUALITY_ATTESTATION_INVALID',
                        'Daemon-owned runner returned inconsistent execution evidence');
                }

                let current;
                try {
                    current = authorityStore.derive();
                } catch (error) {
                    throw new DualDaemonServerError('DUAL_QUALITY_ATTESTATION_INVALID',
                        `Authority changed or became unreadable during quality execution: ${error.message}`);
                }
                const currentPolicy = current.plan?.acceptance_policy || current.plan?.acceptancePolicy;
                const currentTaskIds = Object.keys(current.tasks || {});
                const currentCompletedIds = currentTaskIds.filter((taskId) => current.tasks[taskId]?.state === 'TASK_VERIFIED');
                const currentAllTasksVerified = currentTaskIds.length > 0 && currentCompletedIds.length === currentTaskIds.length;
                const currentExpectedSessionState = currentAllTasksVerified ? 'ACCEPTANCE' : 'EXECUTING';
                const currentCommands = Object.values(current.tasks || {})
                    .flatMap((task) => Array.isArray(task.validation_commands) ? task.validation_commands : []);
                const currentPlan = buildQualityPlan(canonicalWorkspaceRoot, fsImpl, { validationCommands: currentCommands });
                const currentIsSuccessfulFinalizedReplay = Boolean(existingAnchor && cycleHistory.successfulEvent
                    && current.sessionState === 'VERIFIED');
                if (current.sessionId !== derived.sessionId || current.workspaceId !== derived.workspaceId
                    || current.planRevision !== derived.planRevision
                    || !sameJsonValue(current.currentBaseline, derived.currentBaseline)
                    || !currentPolicy || !digestEqual(hashAcceptancePolicy(currentPolicy), hashAcceptancePolicy(policy))
                    || !sameOrderedValues(currentTaskIds, taskIds)
                    || (current.sessionState !== currentExpectedSessionState && !currentIsSuccessfulFinalizedReplay)
                    || (existingAnchor
                        ? completedTaskIds.some((taskId) => current.tasks[taskId]?.state !== 'TASK_VERIFIED')
                        : !sameOrderedValues(currentCompletedIds, completedTaskIds))
                    || !sameJsonValue(currentPlan.commands, qualityPlan.commands)) {
                    throw new DualDaemonServerError('DUAL_QUALITY_ATTESTATION_INVALID',
                        'Session, plan, policy, task, or command identity changed during daemon-owned quality execution');
                }
                let postExecutionFingerprint;
                if (current.currentBaseline?.kind === 'snapshot') {
                    const initialSnapshot = readInitialSnapshot({
                        authorityDir,
                        sessionId: current.sessionId,
                        workspaceId: current.workspaceId,
                        workspaceRoot: canonicalWorkspaceRoot,
                        fsImpl,
                        cryptoImpl,
                    });
                    const { baseline: snapBaseline, excludedPaths } = configuredSnapshotBaseline();
                    postExecutionFingerprint = snapBaseline.fingerprint(
                        initialSnapshot.identity,
                        initialSnapshot.manifest,
                        { excludedPaths },
                    ).patchSha256;
                } else {
                    postExecutionFingerprint = captureDiffFingerprint({
                        repoRoot: canonicalWorkspaceRoot,
                        baseCommit: current.currentBaseline?.id,
                        excludedPaths: ['.omni'],
                    }).patchSha256;
                }
                if (!digestEqual(postExecutionFingerprint, diffFingerprint)) {
                    throw new DualDaemonServerError('DUAL_QUALITY_SOURCE_DRIFT',
                        'Source diff fingerprint changed during daemon-owned quality execution');
                }
                const verified = verifyQualityExecutionArtifact({
                    authorityDir,
                    qualityEvidence,
                    fsImpl,
                    expected,
                });
                if (!digestEqual(verified.sha256, executed.artifact_sha256)) {
                    throw new DualDaemonServerError('DUAL_QUALITY_ATTESTATION_INVALID',
                        'Daemon-owned quality artifact changed before execution completed');
                }

                const eventBinding = qualityExecutionBinding(expected, executionId, executed.artifact_sha256);
                const currentAnchor = authorityStore.derive().qualityExecutions?.[executionId];
                if (existingAnchor || currentAnchor) {
                    const anchor = currentAnchor || existingAnchor;
                    if (!sameQualityExecutionBinding(anchor, eventBinding)) {
                        throw new DualDaemonServerError('DUAL_QUALITY_ATTESTATION_INVALID',
                            'Durable quality execution attestation conflicts with the current execution identity');
                    }
                } else {
                    appendQualityExecutionAttestation(authorityStore, eventBinding);
                }
                return Object.freeze({ quality_evidence: qualityEvidence });
            };

            let pending = qualityExecutionInFlight.get(executionId);
            if (!pending) {
                pending = runQualityExecution();
                qualityExecutionInFlight.set(executionId, pending);
            }
            try {
                return sendResult(res, 200, await pending);
            } finally {
                if (qualityExecutionInFlight.get(executionId) === pending) {
                    qualityExecutionInFlight.delete(executionId);
                }
            }
        } catch (error) {
            return sendError(res, 400, error.code || 'DUAL_QUALITY_EXECUTION_FAILED', error.message || 'Daemon-owned quality execution failed');
        }
    }

    async function handleIsolatedQc(params, res) {
        try {
            if (!params || typeof params.task_id !== 'string' || !Number.isSafeInteger(params.plan_revision)
                || Object.keys(params).some((key) => !['session_id', 'task_id', 'plan_revision'].includes(key))) {
                const code = params?.review_evidence || params?.reviewEvidence
                    ? 'DUAL_REVIEW_ATTESTATION_REQUIRED' : 'DUAL_QC_INVALID_SCHEMA';
                return sendError(res, 400, code, 'Isolated QC requires task ID, plan revision, and prior daemon-owned review attestation');
            }
            const result = await completeIsolatedTask({ workspaceRoot: canonicalWorkspaceRoot, authorityStore,
                sessionId: params.session_id, taskId: params.task_id, planRevision: params.plan_revision });
            return sendResult(res, 200, { ...result, session_id: params.session_id,
                verified: false, session_state: authorityStore.derive().sessionState });
        } catch (error) {
            return sendError(res, 400, error.code || 'DUAL_ISOLATED_QC_FAILED', 'Isolated QC failed; inspect authority state and preserved private artifacts');
        }
    }

    function resolveReviewExecutionBinding(derived, taskId, planRevision) {
        if (derived.planRevision !== planRevision) {
            const error = new Error('Review plan revision does not match the registered plan');
            error.code = 'DUAL_ACCEPTANCE_REVIEW_STALE';
            throw error;
        }
        const task = derived.tasks?.[taskId];
        if (!task) {
            const error = new Error('Review task is not registered');
            error.code = 'DUAL_REVIEW_EXECUTION_MISMATCH';
            throw error;
        }
        const policy = derived.plan?.acceptance_policy || derived.plan?.acceptancePolicy;
        if (!policy) {
            const error = new Error('Acceptance review requires a registered policy');
            error.code = 'DUAL_ACCEPTANCE_CORRECTION_POLICY_REQUIRED';
            throw error;
        }
        const policySha256 = hashAcceptancePolicy(policy);

        if (derived.sessionState === 'EXECUTING' && task.execution_mode === 'isolated'
            && task.state !== 'TASK_VERIFIED' && task.isolatedHandoff?.result_sha256) {
            return {
                task,
                policy,
                policySha256,
                resultSha256: task.isolatedHandoff.result_sha256,
                diffFingerprint: task.isolatedHandoff.result_sha256,
                reviewPhase: 'pre_integration',
            };
        }

        if (derived.sessionState === 'ACCEPTANCE' && task.state === 'TASK_VERIFIED') {
            if (derived.currentBaseline?.kind !== 'git') {
                const error = new Error('Post-integration review currently requires a Git baseline');
                error.code = 'DUAL_ACCEPTANCE_REVIEW_INVALID';
                throw error;
            }
            const current = captureCorrectionState(canonicalWorkspaceRoot, derived.currentBaseline.id);
            return {
                task,
                policy,
                policySha256,
                resultSha256: current.diff_fingerprint,
                diffFingerprint: current.diff_fingerprint,
                reviewPhase: 'post_integration',
            };
        }

        const error = new Error('Task is not ready for a daemon-owned acceptance review');
        error.code = 'DUAL_ACCEPTANCE_REVIEW_INVALID';
        throw error;
    }

    function handleAcceptanceReviewPrepare(params, res) {
        try {
            const allowedKeys = new Set(['session_id', 'task_id', 'plan_revision']);
            if (!params || Object.keys(params).some((key) => !allowedKeys.has(key))
                || typeof params.task_id !== 'string' || !Number.isSafeInteger(params.plan_revision)) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_REVIEW_INVALID', 'Review prepare requires task and plan revision');
            }
            const derived = authorityStore.derive();
            const binding = resolveReviewExecutionBinding(derived, params.task_id, params.plan_revision);
            const matching = Object.values(derived.reviewExecutions || {}).find((execution) =>
                execution.task_id === params.task_id
                && execution.plan_revision === params.plan_revision
                && execution.policy_sha256 === binding.policySha256
                && execution.result_sha256 === binding.resultSha256
                && execution.diff_fingerprint === binding.diffFingerprint
                && execution.review_phase === binding.reviewPhase);
            if (matching) return sendResult(res, 200, matching);

            const execution = {
                schema_version: 1,
                review_execution_id: crypto.randomUUID(),
                session_id: derived.sessionId,
                task_id: params.task_id,
                plan_revision: params.plan_revision,
                policy_sha256: binding.policySha256,
                result_sha256: binding.resultSha256,
                diff_fingerprint: binding.diffFingerprint,
                review_phase: binding.reviewPhase,
                reviewer_role: 'codex',
                provenance_mode: 'fresh',
            };
            authorityStore.append({ schema_version: 2, type: 'review.execution.prepared', execution });
            return sendResult(res, 200, execution);
        } catch (error) {
            return sendError(res, 400, error.code || 'DUAL_ACCEPTANCE_REVIEW_INVALID', 'Acceptance review preparation was rejected');
        }
    }

    function handleAcceptanceReviewSubmit(params, res) {
        try {
            if (params?.review_evidence || params?.reviewEvidence) {
                return sendError(res, 400, 'DUAL_REVIEW_ATTESTATION_REQUIRED', 'Caller-computable review evidence is not trusted');
            }
            if (params?.review_submission && typeof params.review_submission === 'object'
                && ['policy_sha256', 'result_sha256', 'evidence_sha256', 'reviewer_role', 'provenance_mode']
                    .some((key) => Object.prototype.hasOwnProperty.call(params.review_submission, key))) {
                return sendError(res, 400, 'DUAL_REVIEW_ATTESTATION_REQUIRED', 'Caller-computable review bindings are not trusted');
            }
            const allowedKeys = new Set(['session_id', 'task_id', 'plan_revision', 'review_submission']);
            if (!params || Object.keys(params).some((key) => !allowedKeys.has(key))
                || typeof params.task_id !== 'string' || !Number.isSafeInteger(params.plan_revision)) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_REVIEW_INVALID', 'Review submit requires task, plan revision, and untrusted findings');
            }
            const parsedSubmission = ReviewSubmissionSchema.safeParse(params.review_submission);
            if (!parsedSubmission.success) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_REVIEW_INVALID', 'Review findings schema is invalid');
            }
            const derived = authorityStore.derive();
            const execution = derived.reviewExecutions?.[parsedSubmission.data.review_execution_id];
            if (!execution || execution.session_id !== derived.sessionId
                || execution.task_id !== params.task_id || execution.plan_revision !== params.plan_revision) {
                return sendError(res, 409, 'DUAL_REVIEW_EXECUTION_MISMATCH', 'Review execution does not match this session, task, or revision');
            }
            const binding = resolveReviewExecutionBinding(derived, params.task_id, params.plan_revision);
            if (execution.policy_sha256 !== binding.policySha256
                || execution.result_sha256 !== binding.resultSha256
                || execution.diff_fingerprint !== binding.diffFingerprint
                || execution.review_phase !== binding.reviewPhase) {
                return sendError(res, 409, 'DUAL_REVIEW_EXECUTION_MISMATCH', 'Review execution bindings are stale or mismatched');
            }

            const attestation = createReviewAttestation(execution, parsedSubmission.data);
            const existingAttestation = derived.reviewAttestations?.[execution.review_execution_id];
            if (existingAttestation && existingAttestation.attestation_sha256 !== attestation.attestation_sha256) {
                return sendError(res, 409, 'DUAL_ACCEPTANCE_EVIDENCE_CONFLICT', 'Review execution was already consumed by different findings');
            }
            const evidence = reviewAttestationEvidence(existingAttestation || attestation);
            const result = evaluateAttestedReview(binding.policy, evidence, {
                reviewPhase: execution.review_phase,
                taskId: params.task_id,
                resultSha256: binding.resultSha256,
            });
            if (!existingAttestation && result.status !== 'NEEDS_REVIEW') {
                authorityStore.append({ schema_version: 2, type: 'review.attested', attestation });
            }

            return sendResult(res, 200, {
                status: result.status,
                task_id: params.task_id,
                result_sha256: binding.resultSha256,
                review_execution_id: execution.review_execution_id,
                attestation_sha256: (existingAttestation || attestation).attestation_sha256,
                ...(result.status === 'NEEDS_REVIEW' ? { missing: result.missing } : {}),
                ...(result.status === 'NEEDS_FIX' ? { failed: result.failed, correction_grant: result.correction_grant || null } : {}),
            });
        } catch (error) {
            return sendError(res, 400, error.code || 'DUAL_ACCEPTANCE_REVIEW_INVALID', 'Acceptance review findings were rejected');
        }
    }

    function handleTaskReply(params, res) {
        try {
            if (!params || Object.keys(params).some((key) => !['session_id', 'task_id', 'plan_revision', 'message_id', 'reply_to', 'body'].includes(key))
                || typeof params.reply_to !== 'string' || typeof params.body !== 'string') {
                return sendError(res, 400, 'DUAL_MESSAGE_INVALID', 'Controller reply requires bounded task/message identifiers and content');
            }
            const result = postTaskMessage({ authorityStore, sessionId: params.session_id, planRevision: params.plan_revision,
                taskId: params.task_id, messageId: params.message_id, kind: 'reply', body: params.body, replyTo: params.reply_to });
            return sendResult(res, 200, result);
        } catch (error) {
            return sendError(res, 400, error.code || 'DUAL_MESSAGE_INVALID', 'Reply could not be correlated to a waiting task');
        }
    }

    function handleTaskCorrection(params, res) {
        try {
            if (!params || Object.keys(params).some((key) => !['session_id', 'task_id', 'plan_revision', 'request_id', 'expected_attempt', 'reason'].includes(key))) {
                return sendError(res, 400, 'DUAL_CORRECTION_INVALID', 'Correction cannot modify registered scope or task fields');
            }
            const result = requestTaskCorrection({ workspaceRoot: canonicalWorkspaceRoot, authorityStore,
                sessionId: params.session_id, planRevision: params.plan_revision, taskId: params.task_id,
                requestId: params.request_id, expectedAttempt: params.expected_attempt, reason: params.reason });
            return sendResult(res, 200, result);
        } catch (error) {
            return sendError(res, 400, error.code || 'DUAL_CORRECTION_INVALID', 'Correction requires a failed released attempt within the retry budget');
        }
    }

    function handleTaskRecovery(params, res) {
        try {
            if (!params || Object.keys(params).some((key) => !['session_id', 'task_id', 'plan_revision'].includes(key))) {
                return sendError(res, 400, 'DUAL_RECOVERY_UNSAFE', 'Recovery accepts task lineage only, never caller-supplied PIDs');
            }
            return sendResult(res, 200, recoverTaskLease({ workspaceRoot: canonicalWorkspaceRoot, authorityStore,
                sessionId: params.session_id, taskId: params.task_id, planRevision: params.plan_revision }));
        } catch (error) {
            return sendError(res, 400, error.code || 'DUAL_RECOVERY_UNSAFE', 'Task process recovery could not be proven safe');
        }
    }

    function handleAcceptanceCorrectionStart(params, res) {
        try {
            if (!params || typeof params !== 'object') {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_INVALID', 'Request body must be an object');
            }
            const allowedKeys = new Set(['session_id', 'task_id', 'reason',
                'correction_id', 'expected_sequence', 'start_fingerprint', 'failure_check_id']);
            if (Object.keys(params).some((key) => !allowedKeys.has(key))) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_INVALID', 'Correction request contains unsupported fields');
            }
            const taskId = params.task_id;
            if (!taskId || typeof taskId !== 'string') {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_INVALID', 'task_id is required');
            }
            const reason = params.reason;
            if (!reason || typeof reason !== 'string' || reason.trim().length === 0 || reason.length > 2048) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_INVALID', 'reason must be a non-empty string up to 2048 chars');
            }
            if (!Number.isSafeInteger(params.expected_sequence) || params.expected_sequence < 0
                || !/^[0-9a-f]{64}$/.test(params.start_fingerprint || '')
                || typeof params.failure_check_id !== 'string' || !params.failure_check_id.trim()) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_INVALID', 'expected_sequence, start_fingerprint, and failure_check_id are required');
            }
            const derived = authorityStore.derive();
            if (derived.sessionState !== 'ACCEPTANCE') {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_NOT_IN_ACCEPTANCE', `Acceptance correction only allowed from ACCEPTANCE state, currently ${derived.sessionState}`);
            }
            if (derived.legacyAcceptanceCorrection || derived.legacy_acceptance_correction) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_LEGACY', 'Historical correction records are read-only and cannot grant new authority');
            }
            if (derived.activeAcceptanceCorrection) {
                if (derived.activeAcceptanceCorrection.legacy === true) {
                    return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_LEGACY', 'Historical correction records are read-only and cannot grant new authority');
                }
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_ACTIVE', `Another acceptance correction is already in progress: ${derived.activeAcceptanceCorrection.correctionId}`);
            }
            const task = derived.tasks ? derived.tasks[taskId] : null;
            if (!task) {
                return sendError(res, 404, 'DUAL_TASK_NOT_FOUND', `Task ${taskId} not found`);
            }
            if (task.state !== 'TASK_VERIFIED') {
                return sendError(res, 400, 'DUAL_TASK_NOT_VERIFIED', `Task ${taskId} is in state ${task.state}, must be TASK_VERIFIED`);
            }

            const acceptancePolicy = derived.plan?.acceptance_policy || derived.plan?.acceptancePolicy;
            if (!acceptancePolicy || !Array.isArray(acceptancePolicy.checks)) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_POLICY_REQUIRED', 'Correction authority requires a registered acceptance policy');
            }
            const correctionGrant = (acceptancePolicy.correction_grants || []).find((grant) => grant.failure_check_id === params.failure_check_id
                && grant.task_id === taskId);
            if (!correctionGrant) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_FAILURE_INVALID', 'failure_check_id has no registered correction grant for this task');
            }
            const reviewEvents = authorityStore.readEvents();
            const derivedCorrections = derived.acceptanceCorrections || [];
            const failedEvent = reviewEvents.slice().reverse().find((event) => {
                const attestedFailure = event.type === 'review.attested'
                    && event.attestation?.review_phase === 'post_integration'
                    && event.attestation.task_id === taskId
                    && event.attestation.check_results.some((result) => result.check_id === params.failure_check_id
                        && result.status === 'FAIL');
                const legacyGateFailure = event.type === 'gate.result'
                    && (event.gate_id === params.failure_check_id || event.gate_id === `acceptance-${params.failure_check_id}`)
                    && event.status === 'FAILED'
                    && event.task_id === taskId
                    && event.details?.check_id === params.failure_check_id
                    && event.details?.review_phase === 'post_integration';
                return (attestedFailure || legacyGateFailure)
                    && !derivedCorrections.some((correction) => correction.failureSequence === event.sequence
                        && correction.failureCheckId === params.failure_check_id)
                    && !derivedCorrections.some((correction) => correction.status === 'PASSED'
                        && (correction.failureEvidenceSha256 === (event.attestation?.evidence_sha256 || event.evidence_sha256)
                            || correction.failureResultSha256 === (event.attestation?.result_sha256 || event.details?.result_sha256)));
            });
            if (!failedEvent) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_FAILURE_REQUIRED', 'A durable failed acceptance check is required before correction');
            }
            if (params.expected_sequence !== derived.lastSequence) {
                return sendError(res, 409, 'DUAL_ACCEPTANCE_CORRECTION_STALE', 'Correction expected_sequence does not match the current authority sequence');
            }
            let startState;
            try {
                if (derived.currentBaseline?.kind !== 'git') {
                    return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_INVALID', 'Correction currently requires a Git baseline');
                }
                startState = captureCorrectionState(canonicalWorkspaceRoot, derived.currentBaseline.id);
            } catch (error) {
                return sendError(res, 400, error.code || 'DUAL_DIFF_FAILED', 'Unable to capture correction start state');
            }
            if (!digestEqual(params.start_fingerprint, startState.diff_fingerprint)) {
                return sendError(res, 409, 'DUAL_ACCEPTANCE_CORRECTION_STALE', 'Correction start_fingerprint does not match the current integrated workspace');
            }
            const failedResultSha256 = failedEvent.attestation?.result_sha256 || failedEvent.details?.result_sha256;
            const failedEvidenceSha256 = failedEvent.attestation?.evidence_sha256 || failedEvent.evidence_sha256;
            if (failedResultSha256 !== startState.diff_fingerprint) {
                return sendError(res, 409, 'DUAL_ACCEPTANCE_CORRECTION_STALE', 'Correction failure evidence does not match the current integrated workspace');
            }

            const taskAllowed = (task.allowed_files || task.allowedFiles || []).map((f) => f.replace(/\\/g, '/'));
            const normAllowed = [];
            for (const file of correctionGrant.allowed_files) {
                const norm = normalizeRepoPath(canonicalWorkspaceRoot, file);
                if (!taskAllowed.includes(norm)) {
                    return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_SCOPE_EXCEEDED', `File ${file} (${norm}) is not within task ${taskId} registered allowed_files`);
                }
                if (normAllowed.includes(norm)) {
                    return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_INVALID', `Duplicate allowed file: ${norm}`);
                }
                normAllowed.push(norm);
            }

            const priorAttempts = (derived.acceptanceCorrections || []).filter((c) => c.taskId === taskId);
            const attempt = priorAttempts.length + 1;
            if (attempt > 3) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_LIMIT_EXCEEDED', `Maximum 3 acceptance corrections exceeded for task ${taskId}`);
            }

            const correctionId = params.correction_id || cryptoImpl.randomUUID();
            authorityStore.append({
                schema_version: 2,
                type: 'acceptance.correction.started',
                correction_id: correctionId,
                task_id: taskId,
                attempt,
                allowed_files: normAllowed,
                reason,
                validation_commands: correctionGrant.validation_commands,
                expected_sequence: params.expected_sequence,
                start_fingerprint: startState.diff_fingerprint,
                start_state_sha256: startState.state_sha256,
                start_files: startState.files,
                start_state_entries: startState.entries,
                failure_check_id: params.failure_check_id,
                failure_sequence: failedEvent.sequence,
                failure_evidence_sha256: failedEvidenceSha256,
                failure_result_sha256: failedResultSha256,
            });

            return sendResult(res, 200, {
                started: true,
                session_id: derived.sessionId,
                correction_id: correctionId,
                task_id: taskId,
                attempt,
                allowed_files: normAllowed,
                reason,
                expected_sequence: params.expected_sequence,
                start_fingerprint: startState.diff_fingerprint,
                failure_check_id: params.failure_check_id,
            });
        } catch (error) {
            return sendError(res, 400, error.code || 'DUAL_ACCEPTANCE_CORRECTION_INVALID', error.message);
        }
    }

    async function handleAcceptanceCorrectionComplete(params, res) {
        try {
            if (!params || typeof params !== 'object') {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_INVALID', 'Request body must be an object');
            }
            const completionKeys = new Set(['session_id', 'correction_id', 'summary']);
            if (Object.keys(params).some((key) => !completionKeys.has(key))) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_INVALID', 'Correction completion does not accept caller-supplied status, validator, or commands');
            }
            const derived = authorityStore.derive();
            if (derived.sessionState !== 'ACCEPTANCE') {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_NOT_IN_ACCEPTANCE', `Acceptance correction only allowed from ACCEPTANCE state, currently ${derived.sessionState}`);
            }
            const active = derived.activeAcceptanceCorrection;
            if (!active) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_NOT_FOUND', 'No active acceptance correction in progress');
            }
            if (active.legacy === true) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_LEGACY', 'Historical correction records are read-only and cannot grant new authority');
            }
            if (params.correction_id && params.correction_id !== active.correctionId) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_MISMATCH', `Correction ID mismatch: active is ${active.correctionId}, request specified ${params.correction_id}`);
            }

            const commandsToRun = active.validationCommands || [];
            if (!Array.isArray(commandsToRun) || commandsToRun.length === 0) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_INVALID', 'Correction has no registered validator commands');
            }

            let status = 'PASSED';
            let failureSummary = null;
            const validatorEnv = buildValidatorEnv(process.env);

            const { execFileSync } = require('node:child_process');
            for (const cmd of commandsToRun) {
                const parsedCommand = ValidationCommandSchema.safeParse(cmd);
                if (!parsedCommand.success) {
                    status = 'FAILED';
                    failureSummary = 'Registered correction validator has an invalid typed command';
                    break;
                }
                const { program, args } = parsedCommand.data;
                const cwd = path.resolve(canonicalWorkspaceRoot, parsedCommand.data.cwd || '.');
                const relativeCwd = path.relative(canonicalWorkspaceRoot, cwd);
                if (relativeCwd.startsWith('..') || path.isAbsolute(relativeCwd) || !fs.existsSync(cwd)) {
                    status = 'FAILED';
                    failureSummary = 'Registered correction validator cwd escapes the workspace';
                    break;
                }
                try {
                    execFileSync(program, args, { cwd, env: validatorEnv, stdio: 'pipe', timeout: 30000 });
                } catch (cmdErr) {
                    status = 'FAILED';
                    failureSummary = redactDiagnostic(
                        `Command failed: ${program} ${redactArgv(args).join(' ')}: ${cmdErr.message}`,
                        { maxLength: 2048 }
                    );
                    break;
                }
            }

            if (derived.currentBaseline?.kind === 'git' && active.startStateSha256) {
                let currentState;
                try {
                    currentState = captureCorrectionState(canonicalWorkspaceRoot, derived.currentBaseline.id);
                } catch (error) {
                    return sendError(res, 400, error.code || 'DUAL_DIFF_FAILED', 'Unable to capture correction completion state');
                }
                if (!digestEqual(active.startFingerprint, currentState.diff_fingerprint)
                    && active.startStateSha256 === currentState.state_sha256) {
                    // Fingerprint can change only when the state changed; this is
                    // defensive corruption detection, not a success shortcut.
                    return sendError(res, 409, 'DUAL_ACCEPTANCE_CORRECTION_STALE', 'Correction workspace state is inconsistent');
                }
                const startFiles = new Set(active.startFiles || []);
                const allChanged = new Set([...startFiles, ...currentState.files]);
                const changed = [];
                for (const file of allChanged) {
                    const before = active.startStateEntries?.[file];
                    const after = currentState.entries[file];
                    if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) changed.push(file);
                }
                const allowed = new Set(active.allowedFiles || []);
                const unauthorized = changed.filter((file) => !allowed.has(file));
                if (unauthorized.length) {
                    return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_SCOPE_EXCEEDED', `Correction changed unauthorized files: ${unauthorized.join(', ')}`);
                }
            }

            let diffInfo;
            if (derived.currentBaseline.kind === 'snapshot') {
                let initialSnapshot;
                try {
                    initialSnapshot = readInitialSnapshot({
                        authorityDir,
                        sessionId: derived.sessionId,
                        workspaceId: derived.workspaceId,
                        workspaceRoot: canonicalWorkspaceRoot,
                        fsImpl,
                        cryptoImpl,
                    });
                } catch (err) {
                    return sendError(res, 400, 'DUAL_SNAPSHOT_CORRUPT', `Failed to read initial snapshot: ${err.message}`);
                }
                const { baseline: snapBaseline, excludedPaths } = configuredSnapshotBaseline();
                const captured = snapBaseline.capture();
                diffInfo = computeSnapshotManifestFingerprint(
                    initialSnapshot.identity,
                    initialSnapshot.manifest,
                    captured.identity,
                    captured.manifest,
                    { cryptoImpl, excludedPaths }
                );
            } else if (derived.currentBaseline.kind === 'git') {
                try {
                    diffInfo = captureDiffFingerprint({
                        repoRoot: canonicalWorkspaceRoot,
                        baseCommit: derived.currentBaseline.id,
                        excludedPaths: ['.omni'],
                    });
                } catch (err) {
                    return sendError(res, 400, 'DUAL_DIFF_FAILED', `Failed to measure workspace diff: ${err.message}`);
                }
            } else {
                return sendError(res, 400, 'DUAL_BASELINE_INVALID', `Unsupported baseline kind: ${derived.currentBaseline.kind}`);
            }

            if (status === 'PASSED' && active.startFingerprint
                && digestEqual(active.startFingerprint, diffInfo.patchSha256)) {
                return sendError(res, 400, 'DUAL_ACCEPTANCE_CORRECTION_NO_CHANGE',
                    'A successful acceptance correction must change the integrated workspace before it can supersede a failed review');
            }

            const summary = redactDiagnostic(
                failureSummary || (typeof params.summary === 'string' && params.summary.trim()
                    ? params.summary.trim()
                    : `Acceptance correction attempt ${active.attempt} ${status.toLowerCase()}`),
                { maxLength: 2048 }
            );
            authorityStore.append({
                schema_version: 2,
                type: 'acceptance.correction.completed',
                correction_id: active.correctionId,
                task_id: active.taskId,
                attempt: active.attempt,
                status,
                diff_fingerprint: diffInfo.patchSha256,
                summary,
            });

            if (status === 'PASSED' && active.startFingerprint && !digestEqual(active.startFingerprint, diffInfo.patchSha256)) {
                authorityStore.append({
                    schema_version: 2,
                    type: 'quality.generation.invalidated',
                    previous_fingerprint: active.startFingerprint,
                    new_fingerprint: diffInfo.patchSha256,
                    reason: `Acceptance correction ${active.correctionId} changed the integrated workspace`,
                });
            }

            return sendResult(res, 200, {
                completed: true,
                session_id: derived.sessionId,
                correction_id: active.correctionId,
                task_id: active.taskId,
                attempt: active.attempt,
                status,
                diff_fingerprint: diffInfo.patchSha256,
                summary,
            });
        } catch (error) {
            return sendError(res, 400, error.code || 'DUAL_ACCEPTANCE_CORRECTION_INVALID', error.message);
        }
    }

    function handleSessionBlock(params, res) {
        let derived;
        try {
            derived = authorityStore.derive();
        } catch (err) {
            return sendError(res, 500, 'DUAL_INTEGRITY_CORRUPT', `Failed to read authority store: ${err.message}`);
        }

        const reason = typeof params.reason === 'string' && params.reason.trim().length > 0
            ? params.reason.trim()
            : 'Session blocked by controller';
        const blockerCode = typeof params.blocker_code === 'string' && params.blocker_code.trim().length > 0
            ? params.blocker_code.trim()
            : (typeof params.blockerCode === 'string' && params.blockerCode.trim().length > 0 ? params.blockerCode.trim() : 'TERMINAL_FAILURE');

        if (derived.sessionState === 'BLOCKED') {
            return sendResult(res, 200, {
                blocked: true,
                session_id: derived.sessionId,
                session_state: 'BLOCKED',
                reason: derived.blocked?.reason || reason,
                blocker_code: derived.blocked?.blockerCode || blockerCode,
            });
        }

        if (derived.sessionState === 'VERIFIED') {
            return sendError(res, 409, 'DUAL_SESSION_VERIFIED', 'Cannot block an already verified session');
        }

        try {
            authorityStore.append({
                schema_version: 2,
                type: 'session.blocked',
                from_state: derived.sessionState,
                to_state: 'BLOCKED',
                reason,
                blocker_code: blockerCode,
            });
        } catch (err) {
            return sendError(res, 400, err.code || 'DUAL_SESSION_BLOCK_FAILED', `Failed to block session: ${err.message}`);
        }

        return sendResult(res, 200, {
            blocked: true,
            session_id: derived.sessionId,
            session_state: 'BLOCKED',
            reason,
            blocker_code: blockerCode,
        });
    }

    function handleSessionBegin(params, res) {
        if (!params.workspace_root || typeof params.workspace_root !== 'string' || params.workspace_root.trim().length === 0) {
            return sendError(
                res,
                403,
                'DUAL_WORKSPACE_MISMATCH',
                'workspace_root is required'
            );
        }

        let candidateRoot;
        try {
            candidateRoot = fsImpl.realpathSync?.native
                ? fsImpl.realpathSync.native(params.workspace_root)
                : (fsImpl.realpathSync ? fsImpl.realpathSync(params.workspace_root) : path.resolve(params.workspace_root));
        } catch {
            candidateRoot = path.resolve(params.workspace_root);
        }

        if (candidateRoot !== canonicalWorkspaceRoot) {
            return sendError(
                res,
                403,
                'DUAL_WORKSPACE_MISMATCH',
                `Workspace root mismatch: expected ${canonicalWorkspaceRoot}, got ${params.workspace_root}`
            );
        }

        let derived;
        try {
            derived = authorityStore.derive();
        } catch (err) {
            return sendError(
                res,
                500,
                'DUAL_INTEGRITY_CORRUPT',
                `Failed to read authority store: ${err.message}`
            );
        }

        let normalizedBaseline;
        let capturedSnapshot = null;
        if (params.expected_baseline || params.expected_base_commit || (params.kind && params.id)) {
            try {
                normalizedBaseline = normalizeBaselineCorrelation(params);
            } catch (err) {
                return sendError(
                    res,
                    400,
                    'DUAL_BASELINE_INVALID',
                    `Invalid baseline correlation: ${err.message}`
                );
            }
            if (normalizedBaseline.kind === 'snapshot') {
                try {
                    const { baseline: snapshotBaseline } = configuredSnapshotBaseline();
                    capturedSnapshot = snapshotBaseline.capture();
                    if (capturedSnapshot.identity.id !== normalizedBaseline.id) {
                        return sendError(
                            res,
                            400,
                            'DUAL_BASELINE_INVALID',
                            `Captured snapshot root hash (${capturedSnapshot.identity.id}) does not match expected_baseline (${normalizedBaseline.id})`
                        );
                    }
                } catch (err) {
                    return sendError(
                        res,
                        500,
                        'DUAL_BASELINE_CAPTURE_FAILED',
                        `Failed to capture baseline: ${err.message}`
                    );
                }
            }
        } else {
            try {
                const backend = detectBaselineBackend(canonicalWorkspaceRoot);
                if (backend === 'git') {
                    const gitBaseline = createGitBaseline({ root: canonicalWorkspaceRoot });
                    normalizedBaseline = gitBaseline.capture();
                } else {
                    const { baseline: snapshotBaseline } = configuredSnapshotBaseline();
                    capturedSnapshot = snapshotBaseline.capture();
                    normalizedBaseline = capturedSnapshot.identity;
                }
            } catch (err) {
                return sendError(
                    res,
                    500,
                    'DUAL_BASELINE_CAPTURE_FAILED',
                    `Failed to capture baseline: ${err.message}`
                );
            }
        }

        let requestedSessionId = params.session_id;
        const requestedMode = params.mode || 'auto';

        // Case 1: Session not yet initialized
        if (!derived.sessionId) {
            // For snapshot baseline: atomically persist initial snapshot before appending session.created
            if (normalizedBaseline.kind === 'snapshot') {
                const authorityDir = path.join(canonicalWorkspaceRoot, '.omni', 'runs', 'dual-authority');
                const initialSnapPath = path.join(authorityDir, 'initial-snapshot.json');

                if (fsImpl.existsSync(initialSnapPath)) {
                    let existingInitial;
                    try {
                        existingInitial = readInitialSnapshot({
                            authorityDir,
                            workspaceId,
                            workspaceRoot: canonicalWorkspaceRoot,
                            fsImpl,
                            cryptoImpl,
                        });
                    } catch (err) {
                        return sendError(
                            res,
                            409,
                            'DUAL_SNAPSHOT_CONFLICT',
                            `Existing initial-snapshot.json is invalid/conflicting: ${err.message}`
                        );
                    }

                    if (existingInitial.identity.id !== capturedSnapshot.identity.id) {
                        return sendError(
                            res,
                            409,
                            'DUAL_SNAPSHOT_CONFLICT',
                            'Workspace source changed relative to existing initial snapshot'
                        );
                    }

                    if (requestedSessionId && requestedSessionId !== existingInitial.session_id) {
                        return sendError(
                            res,
                            409,
                            'DUAL_SNAPSHOT_CONFLICT',
                            `Requested session_id '${requestedSessionId}' conflicts with existing initial snapshot session '${existingInitial.session_id}'`
                        );
                    }

                    // Recover exact persisted session ID
                    requestedSessionId = existingInitial.session_id;
                } else {
                    if (!requestedSessionId) {
                        requestedSessionId = crypto.randomUUID();
                    }
                }

                try {
                    writeInitialSnapshot({
                        authorityDir,
                        sessionId: requestedSessionId,
                        workspaceId,
                        workspaceRoot: canonicalWorkspaceRoot,
                        identity: capturedSnapshot.identity,
                        manifest: capturedSnapshot.manifest,
                        fsImpl,
                        cryptoImpl,
                    });
                } catch (err) {
                    return sendError(
                        res,
                        err.code === 'DUAL_SNAPSHOT_CONFLICT' ? 409 : 500,
                        err.code || 'DUAL_SNAPSHOT_WRITE_FAILED',
                        `Failed to write initial snapshot: ${err.message}`
                    );
                }
            } else {
                if (!requestedSessionId) {
                    requestedSessionId = crypto.randomUUID();
                }
            }

            const eventPayload = {
                schema_version: 2,
                type: 'session.created',
                state: 'DISCOVERED',
                workspace_root: canonicalWorkspaceRoot,
                mode: requestedMode,
                workspace_id: workspaceId,
                session_id: requestedSessionId,
                plan_revision: 1,
                expected_baseline: normalizedBaseline,
            };

            let created;
            try {
                created = authorityStore.append(eventPayload);
            } catch (err) {
                return sendError(
                    res,
                    500,
                    'DUAL_INTEGRITY_CORRUPT',
                    `Failed to append session.created: ${err.message}`
                );
            }

            return sendResult(res, 200, {
                session_id: created.session_id,
                state: created.state,
                session_state: created.state,
                workspace_id: created.workspace_id,
                workspace_root: created.workspace_root,
                expected_baseline: created.expected_baseline,
                baseline: created.expected_baseline,
                plan_revision: created.plan_revision,
            });
        }

        // Case 2: Session already initialized -> Idempotency or Conflict check
        if (normalizedBaseline.kind === 'snapshot') {
            const authorityDir = path.join(canonicalWorkspaceRoot, '.omni', 'runs', 'dual-authority');
            try {
                readInitialSnapshot({
                    authorityDir,
                    sessionId: derived.sessionId,
                    workspaceId: derived.workspaceId,
                    workspaceRoot: canonicalWorkspaceRoot,
                    fsImpl,
                    cryptoImpl,
                });
            } catch (err) {
                return sendError(
                    res,
                    409,
                    'DUAL_SNAPSHOT_CONFLICT',
                    `Persisted initial-snapshot.json is corrupted or invalid: ${err.message}`
                );
            }
        }

        const isMatch =
            (!params.session_id || params.session_id === derived.sessionId) &&
            candidateRoot === derived.workspaceRoot &&
            requestedMode === derived.mode &&
            normalizedBaseline.kind === derived.currentBaseline.kind &&
            normalizedBaseline.id === derived.currentBaseline.id;

        if (isMatch) {
            return sendResult(res, 200, {
                session_id: derived.sessionId,
                state: derived.sessionState,
                session_state: derived.sessionState,
                workspace_id: derived.workspaceId,
                workspace_root: derived.workspaceRoot,
                expected_baseline: derived.currentBaseline,
                baseline: derived.currentBaseline,
                plan_revision: derived.planRevision,
            });
        }

        return sendError(
            res,
            409,
            'DUAL_SESSION_CONFLICT',
            'Conflicting session already initialized with different parameters.'
        );
    }

    function handleSessionStatus(params, res) {
        let derived;
        let integrity;
        try {
            derived = authorityStore.derive();
            integrity = authorityStore.verifyIntegrity();
        } catch (err) {
            return sendError(
                res,
                500,
                'DUAL_INTEGRITY_CORRUPT',
                `Failed to query session status: ${err.message}`
            );
        }

        sendResult(res, 200, {
            session_id: derived.sessionId,
            workspace_id: derived.workspaceId,
            workspace_root: derived.workspaceRoot,
            state: derived.sessionState,
            session_state: derived.sessionState,
            plan_revision: derived.planRevision,
            current_baseline: derived.currentBaseline,
            plan: derived.plan,
            tasks: derived.tasks,
            leases: derived.leases,
            gates: derived.gates,
            blocked: derived.blocked,
            receipt: derived.receipt,
            active_acceptance_correction: derived.activeAcceptanceCorrection || null,
            acceptance_corrections: derived.acceptanceCorrections || [],
            integrity,
        });
    }

    async function handlePlanRegister(params, res) {
        if (!params.session_id || typeof params.session_id !== 'string') {
            return sendError(res, 400, 'DUAL_SESSION_REQUIRED', 'session_id is required for plan.register');
        }
        if (!params.plan_path || typeof params.plan_path !== 'string') {
            return sendError(res, 400, 'DUAL_CONTRACT_INVALID', 'plan_path is required');
        }
        if (!params.plan_sha256 || typeof params.plan_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(params.plan_sha256)) {
            return sendError(res, 400, 'DUAL_CONTRACT_INVALID', 'plan_sha256 must be a 64-hex string');
        }
        if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
            return sendError(res, 400, 'DUAL_CONTRACT_INVALID', 'tasks must be a non-empty array');
        }
        const planRevision = typeof params.plan_revision === 'number' && Number.isInteger(params.plan_revision) && params.plan_revision > 0
            ? params.plan_revision
            : 1;

        let derived;
        try {
            derived = authorityStore.derive();
        } catch (err) {
            return sendError(res, 500, 'DUAL_INTEGRITY_CORRUPT', `Failed to read authority store: ${err.message}`);
        }

        if (!derived.sessionId) {
            return sendError(res, 400, 'DUAL_SESSION_NOT_FOUND', 'No session initialized');
        }

        if (!derived.plan && params.acceptance_policy === undefined) {
            return sendError(res, 400, 'DUAL_ACCEPTANCE_POLICY_REQUIRED',
                'A new plan registration requires an explicit persisted acceptance_policy');
        }

        let verifiedPlan;
        try {
            verifiedPlan = await planArtifactVerifier(canonicalWorkspaceRoot, params, { fsImpl, cryptoImpl });
        } catch (err) {
            const code = err && typeof err.code === 'string' ? err.code : 'DUAL_PLAN_INVALID';
            const message = code === 'DUAL_PLAN_HASH_MISMATCH'
                ? 'plan_sha256 does not match the current plan artifact'
                : 'plan_path must reference a readable repository file';
            return sendError(res, 400, code, message);
        }
        params.plan_path = verifiedPlan.plan_path;
        params.plan_sha256 = verifiedPlan.plan_sha256;

        // Validate policy syntax and task provenance before capability preflight
        // can append anything to the session ledger. The policy is immutable once
        // plan.registered is written, so malformed input must be side-effect free.
        if (params.acceptance_policy !== undefined) {
            try {
                validateAcceptancePolicy(params.acceptance_policy, {
                    taskIds: params.tasks.map((task) => task && task.task_id).filter(Boolean),
                });
            } catch (error) {
                return sendError(res, 400, error.code || 'DUAL_PLAN_INVALID', `Acceptance policy is invalid: ${error.message}`);
            }
        }

        const setupReadiness = evaluateSetupReadiness(canonicalWorkspaceRoot, { fsImpl });
        if (!setupReadiness.ready) {
            return sendError(
                res,
                409,
                'DUAL_SETUP_REQUIRED',
                `Typed setup is not ready (${setupReadiness.code}): ${setupReadiness.reason}. Run omni dual setup run and retry plan registration.`,
                {
                    setup_code: setupReadiness.code,
                    manifest_sha256: setupReadiness.manifest_sha256,
                    action_count: setupReadiness.action_count,
                }
            );
        }

        // Idempotent retry check: if already registered with matching plan and tasks
        let candidatePolicySha = null;
        if (params.acceptance_policy) {
            try { candidatePolicySha = hashAcceptancePolicy(params.acceptance_policy); } catch {}
        }
        const currentPolicySha = derived.plan ? (derived.plan.acceptance_policy_sha256 || null) : null;
        if (
            derived.plan &&
            derived.plan.plan_sha256 === params.plan_sha256 &&
            derived.plan.total_tasks === params.tasks.length &&
            derived.planRevision === planRevision &&
            currentPolicySha === candidatePolicySha
        ) {
            return sendResult(res, 200, {
                session_id: derived.sessionId,
                state: derived.sessionState,
                session_state: derived.sessionState,
                plan_revision: derived.planRevision,
                total_tasks: derived.plan.total_tasks,
                tasks: Object.values(derived.tasks || {}),
                registered: true,
            });
        }

        if (params.acceptance_policy === undefined) {
            return sendError(res, 400, 'DUAL_ACCEPTANCE_POLICY_REQUIRED',
                'A new plan registration requires an explicit persisted acceptance_policy');
        }

        if (derived.sessionState === 'BLOCKED') {
            return sendError(res, 400, 'DUAL_SESSION_BLOCKED', 'Session is in BLOCKED state');
        }

        // If session is still in DISCOVERED, run real / injected capability preflight
        if (derived.sessionState === 'DISCOVERED') {
            let preflightStart;
            try {
                preflightStart = authorityStore.derive();
            } catch (err) {
                return sendError(res, 500, 'DUAL_INTEGRITY_CORRUPT', `Failed to read authority store: ${err.message}`);
            }
            const preflightStartCheck = inspectFreshDiscoveredPreflight(preflightStart, authorityStore);
            if (preflightStartCheck.integrityError) {
                return sendError(res, 500, 'DUAL_INTEGRITY_CORRUPT', 'Failed to inspect authority before capability preflight.');
            }
            if (!samePreflightAuthorityVersion(derived, preflightStart) || !preflightStartCheck.fresh) {
                return sendError(
                    res,
                    409,
                    'DUAL_TRANSITION_INVALID',
                    'Session authority changed before capability preflight; inspect the current session state and retry plan registration.'
                );
            }

            const preflightFn = typeof effectivePreflight === 'function' ? effectivePreflight : runCapabilityPreflight;
            let capResult;
            let preflightError = null;
            try {
                capResult = await preflightFn(canonicalWorkspaceRoot, {
                    authorityStore,
                    fsImpl,
                    ...options,
                });
            } catch (err) {
                preflightError = err;
            }

            if (preflightError) {
                let latest;
                try {
                    latest = authorityStore.derive();
                } catch {
                    return sendError(res, 500, 'DUAL_INTEGRITY_CORRUPT', 'Failed to recheck authority after capability preflight.');
                }
                if (!samePreflightAuthorityVersion(preflightStart, latest)) {
                    return sendError(
                        res,
                        409,
                        'DUAL_TRANSITION_INVALID',
                        'Session authority changed while capability preflight was running; inspect the current session state before retrying.'
                    );
                }

                const retryableProbeCode = getRetryableCapabilityPreflightCode(preflightError);
                const latestCheck = inspectFreshDiscoveredPreflight(latest, authorityStore);
                if (latestCheck.integrityError) {
                    return sendError(res, 500, 'DUAL_INTEGRITY_CORRUPT', 'Failed to inspect authority after capability preflight.');
                }
                if (retryableProbeCode && latestCheck.fresh) {
                    return sendError(
                        res,
                        503,
                        'DUAL_CAPABILITY_RETRYABLE',
                        'Capability availability probe could not start because local process resources are temporarily unavailable; retry plan registration.',
                        { probe_code: retryableProbeCode }
                    );
                }

                capResult = {
                    status: 'BLOCKED',
                    to_state: 'BLOCKED',
                    checks: [
                        { name: 'preflight_exception', status: 'BLOCKED', reason: 'Capability preflight failed with an unclassified error' },
                    ],
                };
            }

            if (capResult && capResult.status === 'PASSED') {
                const targetWorkerModel = resolveConfiguredWorkerModel(canonicalWorkspaceRoot, options);
                const validation = validateCapabilityResult(capResult, targetWorkerModel);
                if (!validation.valid) {
                    capResult = {
                        status: 'BLOCKED',
                        to_state: 'BLOCKED',
                        checks: [{
                            name: 'agy_cli_and_model',
                            status: 'BLOCKED',
                            reason: validation.reason,
                        }],
                        details: {},
                    };
                }
            }

            try {
                authorityStore.append({
                    schema_version: 2,
                    type: 'capability.result',
                    from_state: 'DISCOVERED',
                    status: capResult.status,
                    checks: capResult.checks,
                    ...(capResult.details ? { details: capResult.details } : {}),
                    to_state: capResult.to_state,
                });
            } catch (err) {
                return sendError(res, 500, 'DUAL_INTEGRITY_CORRUPT', `Failed to append capability.result: ${err.message}`);
            }

            derived = authorityStore.derive();
            if (derived.sessionState === 'BLOCKED') {
                const failureReason = capResult.checks.find((c) => c.status !== 'PASSED')?.reason || 'Capability preflight checks failed';
                return sendError(res, 400, 'DUAL_CAPABILITY_BLOCKED', `Capability preflight failed: ${failureReason}`);
            }
        }

        if (derived.sessionState !== 'CAPABILITY_SAFE') {
            return sendError(
                res,
                400,
                'DUAL_TRANSITION_INVALID',
                `Cannot register plan from session state ${derived.sessionState}`
            );
        }

        const registeredTasksMap = new Map();
        const planTasks = [];
        for (const t of params.tasks) {
            const risk = (t.risk || '').toLowerCase();
            const complexity = (t.complexity || '').toLowerCase();
            const category = (t.category || '').toLowerCase();
            const allowedFiles = t.allowed_files || [];

            const isCodexCandidate =
                t.owner === 'codex' ||
                (risk !== '' && risk !== 'low') ||
                complexity === 'high' ||
                allowedFiles.length === 0 ||
                allowedFiles.length > 10 ||
                category === 'architecture' ||
                category === 'migration' ||
                category === 'security' ||
                category === 'ambiguous' ||
                category === 'database' ||
                category === 'infra' ||
                category === 'review' ||
                category === 'design' ||
                category === 'auth';

            const owner = isCodexCandidate ? 'codex' : 'agy';
            if (t.dependency_mode === 'npm-ci' && (t.execution_mode !== 'isolated'
                || allowedFiles.some((file) => ['package.json', 'package-lock.json'].includes(String(file).toLowerCase())))) {
                return sendError(res, 400, 'DUAL_PLAN_INVALID', 'Private npm-ci requires isolated execution and immutable package/lock inputs');
            }
            if (t.execution_mode === 'isolated' && owner !== 'agy') {
                return sendError(res, 400, 'DUAL_PLAN_INVALID', 'Isolated execution requires an eligible AGY worker slice');
            }
            if (t.depends_on?.length && t.execution_mode !== 'isolated') {
                return sendError(res, 400, 'DUAL_PLAN_INVALID', 'Dependencies require isolated worker execution');
            }

            if (owner === 'agy') {
                if (!Array.isArray(t.allowed_files) || t.allowed_files.length < 1 || t.allowed_files.length > 10) {
                    return sendError(res, 400, 'DUAL_PLAN_INVALID', `Task ${t.task_id} must specify 1-10 allowed_files for AGY execution`);
                }
                for (const f of t.allowed_files) {
                    if (typeof f !== 'string' || !f.trim()) {
                        return sendError(res, 400, 'DUAL_PLAN_INVALID', `Task ${t.task_id} contains invalid allowed_file`);
                    }
                    try {
                        normalizeRepoPath(workspaceRoot, f);
                    } catch (err) {
                        return sendError(res, 400, 'DUAL_PLAN_INVALID', `Task ${t.task_id} allowed_file '${f}' is invalid: ${err.message}`);
                    }
                }
                if (!Array.isArray(t.deny_patterns)) {
                    return sendError(res, 400, 'DUAL_PLAN_INVALID', `Task ${t.task_id} requires an explicit deny_patterns array for AGY execution`);
                }
                for (const p of t.deny_patterns) {
                    if (typeof p !== 'string') {
                        return sendError(res, 400, 'DUAL_PLAN_INVALID', `Task ${t.task_id} contains invalid deny_pattern`);
                    }
                }
                if (!Array.isArray(t.validation_commands) || t.validation_commands.length === 0) {
                    return sendError(res, 400, 'DUAL_PLAN_INVALID', `Task ${t.task_id} requires a non-empty validation_commands array for AGY execution`);
                }
                for (const cmd of t.validation_commands) {
                    if (!cmd || typeof cmd !== 'object' || typeof cmd.program !== 'string' || !cmd.program.trim()) {
                        return sendError(res, 400, 'DUAL_PLAN_INVALID', `Task ${t.task_id} validation_command missing valid program`);
                    }
                    if (!Array.isArray(cmd.args) || !cmd.args.every(a => typeof a === 'string')) {
                        return sendError(res, 400, 'DUAL_PLAN_INVALID', `Task ${t.task_id} validation_command missing string args array`);
                    }
                    if (typeof cmd.cwd !== 'string' || !cmd.cwd.trim()) {
                        return sendError(res, 400, 'DUAL_PLAN_INVALID', `Task ${t.task_id} validation_command missing explicit repo-relative cwd`);
                    }
                    if (cmd.cwd !== '.') {
                        try {
                            normalizeRepoPath(workspaceRoot, cmd.cwd);
                        } catch (err) {
                            return sendError(res, 400, 'DUAL_PLAN_INVALID', `Task ${t.task_id} validation_command invalid cwd '${cmd.cwd}': ${err.message}`);
                        }
                    }
                }
            }

            const taskObj = {
                task_id: t.task_id,
                title: t.title,
                owner,
                allowed_files: allowedFiles,
            };
            if (t.goal) taskObj.goal = t.goal;
            if (t.execution_mode !== undefined) taskObj.execution_mode = t.execution_mode;
            if (t.dependency_mode !== undefined) taskObj.dependency_mode = t.dependency_mode;
            if (t.depends_on !== undefined) taskObj.depends_on = t.depends_on;
            if (t.context_files !== undefined) taskObj.context_files = t.context_files;
            if (t.external_operations !== undefined) {
                const candidate = { ...t, owner, state: 'ROUTED' };
                if (t.owner !== 'codex' || !Array.isArray(t.external_operations) || t.external_operations.length > 20 ||
                    !t.external_operations.every((grant) => grant && exactExternalOperation(candidate, grant.tool_name, grant.tool_input))) {
                    return sendError(res, 400, 'DUAL_PLAN_INVALID', 'External operations require exact Codex/shared task grants');
                }
                taskObj.external_operations = t.external_operations;
            }
            if (t.category) taskObj.category = t.category.toLowerCase();
            if (t.complexity) taskObj.complexity = t.complexity.toLowerCase();
            if (t.risk) taskObj.risk = t.risk.toLowerCase();
            if (t.deny_patterns) taskObj.deny_patterns = t.deny_patterns;
            if (t.validation_commands) taskObj.validation_commands = t.validation_commands;

            registeredTasksMap.set(t.task_id, { ...t, owner, risk: t.risk ? t.risk.toLowerCase() : undefined });
            planTasks.push(taskObj);
        }

        if (planTasks.filter((task) => task.owner === 'agy').length > 1 && planTasks.some((task) => task.execution_mode !== 'isolated')) {
            return sendError(res, 400, 'DUAL_PLAN_INVALID', 'A Dual session supports at most one AGY task against its immutable baseline');
        }
        try { orderedTasks(planTasks); }
        catch (error) { return sendError(res, 400, 'DUAL_PLAN_INVALID', error.message); }

        let validatedAcceptancePolicy;
        let acceptancePolicySha256;
        if (params.acceptance_policy !== undefined) {
            try {
                const validation = validateAcceptancePolicy(params.acceptance_policy, {
                    taskIds: planTasks.map((task) => task.task_id),
                });
                validatedAcceptancePolicy = validation.policy;
                acceptancePolicySha256 = hashAcceptancePolicy(validatedAcceptancePolicy);
            } catch (error) {
                return sendError(res, 400, error.code || 'DUAL_PLAN_INVALID', `Acceptance policy is invalid: ${error.message}`);
            }
        }

        try {
            authorityStore.append({
                schema_version: 2,
                type: 'plan.registered',
                from_state: 'INTERVIEWING',
                to_state: 'PLANNED',
                plan_path: params.plan_path,
                plan_sha256: params.plan_sha256,
                total_tasks: planTasks.length,
                tasks: planTasks,
                ...(validatedAcceptancePolicy ? {
                    acceptance_policy: validatedAcceptancePolicy,
                    acceptance_policy_sha256: acceptancePolicySha256,
                } : {}),
            });

            const configuredWorkerModel = derived.capability?.details?.agy_model ||
                derived.capability?.details?.agy_evidence?.model ||
                resolveConfiguredWorkerModel(canonicalWorkspaceRoot, options) ||
                'gemini-3.7-flash-high';
            const configuredWorkerEffort = resolveConfiguredWorkerEffort(canonicalWorkspaceRoot, options) || 'high';

            for (const t of planTasks) {
                const isAgy = t.owner === 'agy';
                authorityStore.append({
                    schema_version: 2,
                    type: 'task.routed',
                    task_id: t.task_id,
                    owner: t.owner,
                    authority_state: 'ROUTED',
                    model: isAgy ? configuredWorkerModel : null,
                    effort: isAgy ? configuredWorkerEffort : null,
                    token_budget: null,
                    allowed_files: t.allowed_files || [],
                    reason: isAgy ? 'Eligible implementation task routed to AGY' : 'Codex architecture/risk ownership',
                });
            }
        } catch (err) {
            return sendError(res, 500, 'DUAL_INTEGRITY_CORRUPT', `Failed to append plan registration: ${err.message}`);
        }

        derived = authorityStore.derive();

        return sendResult(res, 200, {
            session_id: derived.sessionId,
            state: derived.sessionState,
            session_state: derived.sessionState,
            plan_revision: derived.planRevision,
            total_tasks: planTasks.length,
            tasks: Object.values(derived.tasks || {}),
            registered: true,
        });
    }

    let isWorkerRunning = false;

    async function handleSessionResume(params, res) {
        let derived;
        try {
            derived = authorityStore.derive();
        } catch (err) {
            return sendError(res, 500, 'DUAL_INTEGRITY_CORRUPT', `Failed to read authority store: ${err.message}`);
        }

        if (!derived.sessionId) {
            return sendError(res, 400, 'DUAL_SESSION_NOT_FOUND', 'No session initialized');
        }

        if (derived.sessionState === 'BLOCKED') {
            return sendError(res, 400, 'DUAL_SESSION_BLOCKED', 'Cannot resume BLOCKED session');
        }

        if (params.task_id !== undefined && (typeof params.task_id !== 'string' || !Object.hasOwn(derived.tasks, params.task_id))) {
            return sendError(res, 400, 'DUAL_TASK_NOT_FOUND', 'Requested authority task does not exist');
        }
        if (params.plan_revision !== undefined && params.plan_revision !== derived.planRevision) {
            return sendError(res, 409, 'DUAL_PLAN_REVISION_MISMATCH', 'Plan revision changed before continuation');
        }

        if ((derived.sessionState === 'PLANNED' || derived.sessionState === 'EXECUTING') && !isWorkerRunning) {
            if (effectiveOrchestrator && typeof effectiveOrchestrator.runTask === 'function') {
                isWorkerRunning = true;
                setImmediate(async () => {
                    try {
                        // Extract registered tasks from plan.registered events to preserve rich metadata
                        const events = authorityStore.readEvents();
                        const planReg = events.find(e => e.type === 'plan.registered');
                        const registeredTasksMap = new Map();
                        if (planReg && Array.isArray(planReg.tasks)) {
                            for (const pt of planReg.tasks) {
                                registeredTasksMap.set(pt.task_id, pt);
                            }
                        }

                        const enrichedTasks = {};
                        for (const [tid, t] of Object.entries(derived.tasks || {})) {
                            if (params.task_id !== undefined && tid !== params.task_id) continue;
                            const reg = registeredTasksMap.get(tid) || {};
                            enrichedTasks[tid] = { ...reg, ...t };
                        }

                        const enrichedDerived = {
                            ...derived,
                            tasks: enrichedTasks,
                        };

                        await effectiveOrchestrator.runTask(enrichedDerived);
                    } catch {
                        // handled internally
                    } finally {
                        isWorkerRunning = false;
                    }
                });
            }
        }

        return sendResult(res, 200, {
            session_id: derived.sessionId,
            state: derived.sessionState,
            session_state: derived.sessionState,
            plan_revision: derived.planRevision,
            current_baseline: derived.currentBaseline,
            tasks: derived.tasks,
            leases: derived.leases,
            gates: derived.gates,
            resumed: true,
        });
    }

    function handleHookEvaluate(params, res) {
        const hookEvent = params.hook_event_name || params.event_name || params.hookEventName;
        if (typeof params.tool_name === 'string' && params.tool_name.startsWith('mcp__stitch__') && params.operation !== 'external') {
            return sendResult(res, 200, { decision: 'deny', permissionDecision: 'deny', reason: 'Stitch tool requires exact external authorization' });
        }
        if (params.operation === 'external') {
            const deny = (reason) => sendResult(res, 200, { decision: 'deny', permissionDecision: 'deny', reason, permissionDecisionReason: reason });
            try {
                if (!['PreToolUse', 'PostToolUse'].includes(hookEvent) || params.owner !== 'codex') return deny('Invalid external operation owner/event');
                const current = authorityStore.derive();
                if (current.sessionState !== 'EXECUTING') return deny('External operation requires executing session');
                const matches = Object.values(current.tasks).map((task) => ({ task,
                    match: exactExternalOperation(task, params.tool_name, params.tool_input) })).filter((value) => value.match);
                if (matches.length !== 1) return deny('External operation lacks a unique exact registered grant');
                const { task, match } = matches[0];
                if (params.task_id !== task.task_id) return deny('External task mismatch');
                if (Object.values(current.leases || {}).some((lease) => ['active', 'expired'].includes(lease.status) && lease.owner === 'agy')) {
                    return deny('External operation waits for active AGY lease release');
                }
                validateTaskPath(canonicalWorkspaceRoot, match.grant.evidence_file);
                const prior = task.externalReservations?.[match.fingerprint];
                if (hookEvent === 'PreToolUse') {
                    if (prior) return deny('External operation already reserved; inspect remote state before any new authorized action');
                    authorityStore.append({ schema_version: 2, type: 'task.external.reserved', task_id: task.task_id, fingerprint: match.fingerprint });
                } else {
                    if (!prior) return deny('External operation has no durable reservation');
                    if (!prior.observed) authorityStore.append({ schema_version: 2, type: 'task.external.observed', task_id: task.task_id, fingerprint: match.fingerprint });
                }
                return sendResult(res, 200, { decision: 'allow', permissionDecision: 'allow' });
            } catch { return deny('External operation authority validation failed'); }
        }

        // 1. Non-mutating events are allowed
        if (
            hookEvent === 'SessionStart' ||
            hookEvent === 'UserPromptSubmit' ||
            hookEvent === 'PostToolUse'
        ) {
            return sendResult(res, 200, {
                decision: 'allow',
                permissionDecision: 'allow',
            });
        }

        const operation = params.operation;

        // 2. Strict normalized operation enum check
        if (operation === 'read') {
            // Only strict read operation may bypass task/lease/file scope
            return sendResult(res, 200, {
                decision: 'allow',
                permissionDecision: 'allow',
            });
        }

        if (operation !== 'write' && operation !== 'execute') {
            return sendResult(res, 200, {
                decision: 'deny',
                permissionDecision: 'deny',
                reason: `[omni-blocked] unknown or unsupported operation: ${operation || 'unspecified'}`,
                permissionDecisionReason: `[omni-blocked] unknown or unsupported operation: ${operation || 'unspecified'}`,
            });
        }

        let derived;
        try {
            derived = authorityStore.derive();
        } catch (err) {
            return sendResult(res, 200, {
                decision: 'deny',
                permissionDecision: 'deny',
                reason: `[omni-blocked] authority store error: ${err.message}`,
                permissionDecisionReason: `[omni-blocked] authority store error: ${err.message}`,
            });
        }

        if (derived.sessionState === 'BLOCKED') {
            return sendResult(res, 200, {
                decision: 'deny',
                permissionDecision: 'deny',
                reason: '[omni-blocked] session is BLOCKED',
                permissionDecisionReason: '[omni-blocked] session is BLOCKED',
            });
        }

        const taskId = params.task_id || params.taskId;
        if (!taskId) {
            return sendResult(res, 200, {
                decision: 'deny',
                permissionDecision: 'deny',
                reason: '[omni-blocked] mutating tool requires a valid task_id',
                permissionDecisionReason: '[omni-blocked] mutating tool requires a valid task_id',
            });
        }

        const task = derived.tasks ? derived.tasks[taskId] : null;
        if (!task) {
            return sendResult(res, 200, {
                decision: 'deny',
                permissionDecision: 'deny',
                reason: `[omni-blocked] task ${taskId} not found in plan`,
                permissionDecisionReason: `[omni-blocked] task ${taskId} not found in plan`,
            });
        }

        const activeCorrection = derived.activeAcceptanceCorrection;
        const hasAcceptanceCorrectionAuthority = Boolean(
            activeCorrection &&
            activeCorrection.legacy !== true &&
            activeCorrection.taskId === taskId &&
            derived.sessionState === 'ACCEPTANCE' &&
            params.owner === 'codex'
        );

        if (derived.sessionState === 'ACCEPTANCE' && !hasAcceptanceCorrectionAuthority) {
            return sendResult(res, 200, {
                decision: 'deny',
                permissionDecision: 'deny',
                reason: '[omni-blocked] mutations in ACCEPTANCE phase require an active authorized acceptance correction',
                permissionDecisionReason: '[omni-blocked] mutations in ACCEPTANCE phase require an active authorized acceptance correction',
            });
        }

        if (derived.sessionState === 'VERIFIED') {
            return sendResult(res, 200, {
                decision: 'deny',
                permissionDecision: 'deny',
                reason: '[omni-blocked] session is already VERIFIED, mutations are not permitted',
                permissionDecisionReason: '[omni-blocked] session is already VERIFIED, mutations are not permitted',
            });
        }

        if (!hasAcceptanceCorrectionAuthority && task.state === 'REGISTERED') {
            return sendResult(res, 200, {
                decision: 'deny',
                permissionDecision: 'deny',
                reason: `[omni-blocked] task ${taskId} is not routed`,
                permissionDecisionReason: `[omni-blocked] task ${taskId} is not routed`,
            });
        }

        const requestedOwner = params.owner;
        if (!hasAcceptanceCorrectionAuthority && requestedOwner && requestedOwner !== task.owner) {
            const ownerMsg = task.owner === 'agy' ? 'AGY_OWNED' : 'CODEX_OWNED';
            return sendResult(res, 200, {
                decision: 'deny',
                permissionDecision: 'deny',
                reason: `[omni-blocked] task is ${ownerMsg}, owner mismatch: ${requestedOwner}`,
                permissionDecisionReason: `[omni-blocked] task is ${ownerMsg}, owner mismatch: ${requestedOwner}`,
            });
        }

        // Check active lease
        let hasActiveLease = false;
        for (const lease of Object.values(derived.leases || {})) {
            if (lease.task_id === taskId && lease.status === 'active') {
                if (!requestedOwner || lease.owner === requestedOwner) {
                    hasActiveLease = true;
                    break;
                }
            }
        }

        const hasInteractiveCodexAuthority = (
            !hasActiveLease &&
            requestedOwner === 'codex' &&
            task.owner === 'codex' &&
            task.state === 'ROUTED'
        );

        if (!hasActiveLease && !hasInteractiveCodexAuthority && !hasAcceptanceCorrectionAuthority) {
            return sendResult(res, 200, {
                decision: 'deny',
                permissionDecision: 'deny',
                reason: `[omni-blocked] no active lease for task ${taskId}`,
                permissionDecisionReason: `[omni-blocked] no active lease for task ${taskId}`,
            });
        }

        const allowed = (
            hasAcceptanceCorrectionAuthority
                ? (activeCorrection.allowed_files || activeCorrection.allowedFiles || [])
                : (task.allowed_files || task.allowedFiles || [])
        ).map((f) => f.replace(/\\/g, '/'));

        if (operation === 'write') {
            const filePath =
                params.file_path ||
                params.filePath ||
                (params.tool_input && (params.tool_input.path || params.tool_input.file_path || params.tool_input.file)) ||
                (params.tool_args && (params.tool_args.path || params.tool_args.file_path || params.tool_args.file));

            if (!filePath || typeof filePath !== 'string' || filePath.trim().length === 0) {
                return sendResult(res, 200, {
                    decision: 'deny',
                    permissionDecision: 'deny',
                    reason: '[omni-blocked] write operation requires a valid file_path',
                    permissionDecisionReason: '[omni-blocked] write operation requires a valid file_path',
                });
            }

            let normPath;
            try {
                normPath = normalizeRepoPath(canonicalWorkspaceRoot, filePath);
            } catch (err) {
                return sendResult(res, 200, {
                    decision: 'deny',
                    permissionDecision: 'deny',
                    reason: `[omni-blocked] invalid file path: ${err.message}`,
                    permissionDecisionReason: `[omni-blocked] invalid file path: ${err.message}`,
                });
            }

            if (!allowed.includes(normPath)) {
                return sendResult(res, 200, {
                    decision: 'deny',
                    permissionDecision: 'deny',
                    reason: `[omni-blocked] file outside allowed scope: ${filePath}`,
                    permissionDecisionReason: `[omni-blocked] file outside allowed scope: ${filePath}`,
                });
            }

            return sendResult(res, 200, {
                decision: 'allow',
                permissionDecision: 'allow',
            });
        }

        if (operation === 'execute') {
            const declaredPaths = params.declared_paths || params.declaredPaths;
            if (!Array.isArray(declaredPaths) || declaredPaths.length === 0) {
                return sendResult(res, 200, {
                    decision: 'deny',
                    permissionDecision: 'deny',
                    reason: '[omni-blocked] execute operation requires non-empty declared_paths',
                    permissionDecisionReason: '[omni-blocked] execute operation requires non-empty declared_paths',
                });
            }

            for (const p of declaredPaths) {
                if (!p || typeof p !== 'string' || p.trim().length === 0) {
                    return sendResult(res, 200, {
                        decision: 'deny',
                        permissionDecision: 'deny',
                        reason: '[omni-blocked] declared path must be a non-empty string',
                        permissionDecisionReason: '[omni-blocked] declared path must be a non-empty string',
                    });
                }
                let normP;
                try {
                    normP = normalizeRepoPath(canonicalWorkspaceRoot, p);
                } catch (err) {
                    return sendResult(res, 200, {
                        decision: 'deny',
                        permissionDecision: 'deny',
                        reason: `[omni-blocked] invalid declared path: ${err.message}`,
                        permissionDecisionReason: `[omni-blocked] invalid declared path: ${err.message}`,
                    });
                }
                if (!allowed.includes(normP)) {
                    return sendResult(res, 200, {
                        decision: 'deny',
                        permissionDecision: 'deny',
                        reason: `[omni-blocked] declared path outside allowed scope: ${p}`,
                        permissionDecisionReason: `[omni-blocked] declared path outside allowed scope: ${p}`,
                    });
                }
            }

            return sendResult(res, 200, {
                decision: 'allow',
                permissionDecision: 'allow',
            });
        }

        return sendResult(res, 200, {
            decision: 'deny',
            permissionDecision: 'deny',
            reason: '[omni-blocked] operation is unknown or denied',
            permissionDecisionReason: '[omni-blocked] operation is unknown or denied',
        });
    }

    async function handleCompletionEvaluate(params, res) {
        let derived;
        try {
            derived = authorityStore.derive();
        } catch (err) {
            return sendResult(res, 200, {
                verified: false,
                session_state: 'UNKNOWN',
                blockers: [`AUTHORITY_STORE_CORRUPT: ${err.message}`],
            });
        }

        // 1. Process optional qc_evidence from Codex
        if (params.qc_evidence && typeof params.qc_evidence === 'object') {
            let qc;
            try {
                qc = parseContract(QcEvidenceSchema, params.qc_evidence, 'qc_evidence');
            } catch (err) {
                return sendError(res, 400, 'DUAL_QC_INVALID_SCHEMA', `qc_evidence schema validation failed: ${err.message}`);
            }

            const taskId = qc.task_id;
            let task = derived.tasks ? derived.tasks[taskId] : null;
            if (!task) {
                return sendError(res, 400, 'DUAL_TASK_NOT_FOUND', `Task not registered: ${taskId}`);
            }

            const allEvents = authorityStore.readEvents();
            const planReg = allEvents.find(e => e.type === 'plan.registered');
            if (planReg && Array.isArray(planReg.tasks)) {
                const regTask = planReg.tasks.find(pt => pt.task_id === taskId);
                if (regTask) {
                    task = { ...regTask, ...task };
                }
            }

            if (qc.plan_revision !== derived.planRevision) {
                return sendError(res, 400, 'DUAL_PLAN_REVISION_MISMATCH', `qc_evidence plan revision (${qc.plan_revision}) does not match session plan revision (${derived.planRevision})`);
            }

            if (!Array.isArray(qc.findings) || qc.findings.length > 0) {
                return sendError(res, 400, 'DUAL_QC_FINDINGS_NONEMPTY', `qc_evidence findings must be an empty array for SUCCESS verdict`);
            }

            if (!Array.isArray(qc.command_outputs) || qc.command_outputs.length === 0) {
                return sendError(res, 400, 'DUAL_QC_COMMANDS_EMPTY', `qc_evidence command_outputs must not be empty`);
            }

            for (const cmd of qc.command_outputs) {
                if (typeof cmd.exit_code !== 'number' || !Number.isSafeInteger(cmd.exit_code) || cmd.exit_code !== 0) {
                    return sendError(res, 400, 'DUAL_QC_COMMAND_FAILED', `qc_evidence command '${cmd.command}' failed with exit code ${cmd.exit_code}`);
                }
            }

            if (!derived.currentBaseline || !derived.currentBaseline.id) {
                return sendError(res, 400, 'DUAL_BASELINE_INVALID', 'Task QC requires an initialized baseline in session');
            }

            let diffInfo;
            if (derived.currentBaseline.kind === 'snapshot') {
                const authorityDir = path.join(canonicalWorkspaceRoot, '.omni', 'runs', 'dual-authority');
                let initialSnapshot;
                try {
                    initialSnapshot = readInitialSnapshot({
                        authorityDir,
                        sessionId: derived.sessionId,
                        workspaceId: derived.workspaceId,
                        workspaceRoot: canonicalWorkspaceRoot,
                        fsImpl,
                        cryptoImpl,
                    });
                } catch (err) {
                    return sendError(res, 400, 'DUAL_SNAPSHOT_CORRUPT', `Failed to read initial snapshot: ${err.message}`);
                }
                const { baseline: snapBaseline, excludedPaths } = configuredSnapshotBaseline();
                diffInfo = snapBaseline.fingerprint(initialSnapshot.identity, initialSnapshot.manifest, { excludedPaths });
            } else if (derived.currentBaseline.kind === 'git') {
                try {
                    diffInfo = captureDiffFingerprint({
                        repoRoot: canonicalWorkspaceRoot,
                        baseCommit: derived.currentBaseline.id,
                        excludedPaths: ['.omni'],
                    });
                } catch (err) {
                    return sendError(res, 400, 'DUAL_DIFF_FAILED', `Failed to measure workspace diff: ${err.message}`);
                }
            } else {
                return sendError(res, 400, 'DUAL_BASELINE_INVALID', `Unsupported baseline kind: ${derived.currentBaseline.kind}`);
            }

            if (qc.diff_fingerprint !== diffInfo.patchSha256) {
                return sendError(res, 400, 'DUAL_FINGERPRINT_MISMATCH', `qc_evidence diff fingerprint (${qc.diff_fingerprint}) does not match workspace diff (${diffInfo.patchSha256})`);
            }

            const measuredFilesSorted = [...diffInfo.files].sort();
            const qcFilesSorted = [...qc.modified_files].sort();
            if (measuredFilesSorted.length !== qcFilesSorted.length || !measuredFilesSorted.every((f, i) => f === qcFilesSorted[i])) {
                return sendError(res, 400, 'DUAL_MODIFIED_FILES_MISMATCH', `qc_evidence modified_files do not match measured workspace files`);
            }

            if (measuredFilesSorted.length === 0) {
                const allowEmpty = task.allow_no_op === true || (Array.isArray(task.risk_flags) && task.risk_flags.includes('allow_no_op'));
                if (!allowEmpty) {
                    return sendError(res, 400, 'DUAL_EMPTY_DIFF_BLOCKED', `Task ${taskId} produced no modified files and no-op is not declared allowed`);
                }
            }

            // Artifact correlation for AGY task
            const taskRunDir = path.join(canonicalWorkspaceRoot, '.omni', 'codex-gemini', 'runs', taskId);
            const contextPath = path.join(taskRunDir, 'context.json');
            const specPath = path.join(taskRunDir, 'spec.json');
            const routePath = path.join(taskRunDir, 'route.json');
            const evidencePath = path.join(taskRunDir, 'evidence.json');
            const reviewPath = path.join(taskRunDir, 'review.json');
            const eventsPath = path.join(taskRunDir, 'events.ndjson');

            const expectedWorkerModel = task.model || derived.capability?.details?.agy_model || resolveConfiguredWorkerModel(canonicalWorkspaceRoot, options) || 'gemini-3.7-flash-high';
            const expectedWorkerEffort = task.effort || resolveConfiguredWorkerEffort(canonicalWorkspaceRoot, options) || 'high';

            if (task.owner === 'agy') {
                if (
                    !fsImpl.existsSync(contextPath) ||
                    !fsImpl.existsSync(specPath) ||
                    !fsImpl.existsSync(routePath) ||
                    !fsImpl.existsSync(evidencePath) ||
                    !fsImpl.existsSync(reviewPath) ||
                    !fsImpl.existsSync(eventsPath)
                ) {
                    return sendError(res, 400, 'DUAL_ARTIFACT_MISSING', `AGY execution artifacts missing for task ${taskId}`);
                }

                let contextObj, specObj, routeObj, evidenceObj, reviewObj, eventLines;
                try {
                    contextObj = parseContract(ContextSchema, JSON.parse(fsImpl.readFileSync(contextPath, 'utf8')), 'context');
                    specObj = parseContract(SpecSchema, JSON.parse(fsImpl.readFileSync(specPath, 'utf8')), 'spec');
                    routeObj = parseContract(RouteSchema, JSON.parse(fsImpl.readFileSync(routePath, 'utf8')), 'route');
                    evidenceObj = parseContract(EvidenceSchema, JSON.parse(fsImpl.readFileSync(evidencePath, 'utf8')), 'evidence');
                    reviewObj = parseContract(ReviewSchema, JSON.parse(fsImpl.readFileSync(reviewPath, 'utf8')), 'review');

                    eventLines = fsImpl.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
                    if (eventLines.length === 0) {
                        throw new Error('events.ndjson is empty');
                    }
                    for (const line of eventLines) {
                        parseContract(EventSchema, JSON.parse(line), 'event log line');
                    }
                } catch (err) {
                    return sendError(res, 400, 'DUAL_ARTIFACT_CORRUPT', `Artifact validation failed for task ${taskId}: ${err.message}`);
                }

                if (
                    contextObj.task_id !== taskId ||
                    specObj.task_id !== taskId ||
                    routeObj.task_id !== taskId ||
                    evidenceObj.task_id !== taskId ||
                    reviewObj.task_id !== taskId
                ) {
                    return sendError(res, 400, 'DUAL_CORRELATION_ERROR', `task_id mismatch across artifacts for task ${taskId}`);
                }

                let contextBase, specBase, routeBase, evidenceBase, reviewBase;
                try {
                    contextBase = normalizeBaselineCorrelation(contextObj, 'context');
                    specBase = normalizeBaselineCorrelation(specObj, 'spec');
                    routeBase = normalizeBaselineCorrelation(routeObj, 'route');
                    evidenceBase = normalizeBaselineCorrelation(evidenceObj, 'evidence');
                    reviewBase = normalizeBaselineCorrelation(reviewObj, 'review');
                } catch (err) {
                    return sendError(res, 400, 'DUAL_BASELINE_MISMATCH', `Artifact baseline normalization failed: ${err.message}`);
                }

                if (
                    contextBase.id !== derived.currentBaseline.id || contextBase.kind !== derived.currentBaseline.kind ||
                    specBase.id !== derived.currentBaseline.id || specBase.kind !== derived.currentBaseline.kind ||
                    routeBase.id !== derived.currentBaseline.id || routeBase.kind !== derived.currentBaseline.kind ||
                    evidenceBase.id !== derived.currentBaseline.id || evidenceBase.kind !== derived.currentBaseline.kind ||
                    reviewBase.id !== derived.currentBaseline.id || reviewBase.kind !== derived.currentBaseline.kind
                ) {
                    return sendError(res, 400, 'DUAL_BASELINE_MISMATCH', `baseline mismatch in artifacts for task ${taskId}`);
                }

                const taskAllowed = task.allowed_files || task.allowedFiles || [];
                const expectedGoal = task.goal || task.title;
                if (specObj.goal !== expectedGoal) {
                    return sendError(res, 400, 'DUAL_CORRELATION_ERROR', `spec.json goal mismatch for task ${taskId}`);
                }
                if (
                    JSON.stringify(specObj.allowed_files) !== JSON.stringify(taskAllowed)
                ) {
                    return sendError(res, 400, 'DUAL_CORRELATION_ERROR', `spec.json allowed_files mismatch for task ${taskId}`);
                }
                if (
                    JSON.stringify(specObj.deny_patterns) !== JSON.stringify(task.deny_patterns || task.denyPatterns || [])
                ) {
                    return sendError(res, 400, 'DUAL_CORRELATION_ERROR', `spec.json deny_patterns mismatch for task ${taskId}`);
                }
                if (JSON.stringify(specObj.context_files || []) !== JSON.stringify(task.context_files || [])) {
                    return sendError(res, 400, 'DUAL_CORRELATION_ERROR', `spec.json context_files mismatch for task ${taskId}`);
                }
                const expectedCmds = task.validation_commands || task.validationCommands || [];
                if (specObj.validation_commands.length !== expectedCmds.length) {
                    return sendError(res, 400, 'DUAL_CORRELATION_ERROR', `spec.json validation_commands length mismatch for task ${taskId}`);
                }
                for (let i = 0; i < expectedCmds.length; i++) {
                    const sc = specObj.validation_commands[i];
                    const tc = expectedCmds[i];
                    if (sc.program !== tc.program || JSON.stringify(sc.args) !== JSON.stringify(tc.args) || sc.cwd !== tc.cwd) {
                        return sendError(res, 400, 'DUAL_CORRELATION_ERROR', `spec.json validation_commands mismatch at index ${i} for task ${taskId}`);
                    }
                }
                if (JSON.stringify(specObj.risk_flags) !== JSON.stringify([])) {
                    return sendError(res, 400, 'DUAL_CORRELATION_ERROR', `spec.json risk_flags mismatch for task ${taskId}`);
                }
                if (specObj.permission_authority !== 'dual-init-dangerous-auto-v1') {
                    return sendError(res, 400, 'DUAL_CORRELATION_ERROR', `spec.json permission_authority mismatch for task ${taskId}`);
                }

                if (
                    JSON.stringify(routeObj.allowed_files) !== JSON.stringify(taskAllowed)
                ) {
                    return sendError(res, 400, 'DUAL_ROUTE_MISMATCH', `route.json allowed_files mismatch for task ${taskId}`);
                }

                if (routeObj.owner !== 'gemini' || (expectedWorkerModel && routeObj.model !== expectedWorkerModel) || (expectedWorkerEffort && routeObj.effort !== expectedWorkerEffort)) {
                    return sendError(res, 400, 'DUAL_ROUTE_MISMATCH', `route.json has invalid owner/model/effort for task ${taskId}`);
                }
                if (evidenceObj.status !== 'SUCCESS') {
                    return sendError(res, 400, 'DUAL_EVIDENCE_NOT_SUCCESS', `evidence.json status is not SUCCESS for task ${taskId}`);
                }
                if (!Array.isArray(evidenceObj.command_outputs) || evidenceObj.command_outputs.length === 0) {
                    return sendError(res, 400, 'DUAL_EVIDENCE_NOT_SUCCESS', `evidence.json command_outputs must be non-empty for task ${taskId}`);
                }
                for (const cmd of evidenceObj.command_outputs) {
                    if (typeof cmd.exit_code !== 'number' || cmd.exit_code !== 0) {
                        return sendError(res, 400, 'DUAL_VALIDATION_COMMAND_FAILED', `Validation command '${cmd.command}' in evidence.json failed with exit code ${cmd.exit_code}`);
                    }
                }
                const evModifiedSorted = [...evidenceObj.modified_files].sort();
                if (evModifiedSorted.length !== measuredFilesSorted.length || !evModifiedSorted.every((f, i) => f === measuredFilesSorted[i])) {
                    return sendError(res, 400, 'DUAL_EVIDENCE_FILES_MISMATCH', `evidence.json modified_files do not match measured workspace files`);
                }
                if (reviewObj.recommendation !== 'APPROVE') {
                    return sendError(res, 400, 'DUAL_REVIEW_NOT_APPROVED', `review.json recommendation is ${reviewObj.recommendation}, not APPROVE`);
                }

                const parsedEvents = [];
                for (const line of eventLines) {
                    parsedEvents.push(parseContract(EventSchema, JSON.parse(line), 'event log line'));
                }
                try {
                    validateEventSequence(parsedEvents, taskId, derived.currentBaseline);
                    validatePhaseArtifactHashes(taskRunDir, parsedEvents);
                } catch (err) {
                    return sendError(res, 400, 'DUAL_EVENT_SEQUENCE_INVALID', `Event log validation failed for task ${taskId}: ${err.message}`);
                }
            }

            if (task.state === 'TASK_VERIFIED') {
                if (
                    task.diff_fingerprint !== diffInfo.patchSha256 ||
                    task.verdict !== 'SUCCESS' ||
                    (task.verified_by !== 'codex' && task.verifiedBy !== 'codex')
                ) {
                    return sendError(res, 400, 'DUAL_QC_CONFLICT', `Task ${taskId} is already verified with conflicting evidence`);
                }
            } else {
                let qcLease;
                try {
                    qcLease = authorityStore.acquireLease(taskId, 'codex', { ttl_ms: 60_000 });
                } catch (err) {
                    return sendError(res, 500, 'DUAL_LEASE_FAILED', `Failed to acquire QC lease on task ${taskId}: ${err.message}`);
                }

                try {
                    if (task.owner === 'agy') {
                        const contextSha = cryptoImpl.createHash('sha256').update(fsImpl.readFileSync(contextPath)).digest('hex');
                        const evidenceSha = cryptoImpl.createHash('sha256').update(fsImpl.readFileSync(evidencePath)).digest('hex');
                        const reviewSha = cryptoImpl.createHash('sha256').update(fsImpl.readFileSync(reviewPath)).digest('hex');

                        if (!derived.gates || !derived.gates[`delegation-${taskId}`] || derived.gates[`delegation-${taskId}`].status !== 'PASSED') {
                            const ack1 = authorityStore.append({
                                schema_version: 2,
                                type: 'gate.result',
                                gate_id: `delegation-${taskId}`,
                                task_id: taskId,
                                status: 'PASSED',
                                reason: `Delegation scout and spec validated for task ${taskId}`,
                                details: {
                                    required: true,
                                    task_id: taskId,
                                    worker: 'agy',
                                    model: expectedWorkerModel,
                                    effort: expectedWorkerEffort,
                                },
                                evidence_sha256: contextSha,
                            });
                            if (!ack1 || ack1.type !== 'gate.result') throw new Error(`Failed to append delegation gate for ${taskId}`);
                        }

                        if (!derived.gates || !derived.gates[`scope-${taskId}`] || derived.gates[`scope-${taskId}`].status !== 'PASSED') {
                            const ack2 = authorityStore.append({
                                schema_version: 2,
                                type: 'gate.result',
                                gate_id: `scope-${taskId}`,
                                task_id: taskId,
                                status: 'PASSED',
                                reason: `Scope and diff validated for task ${taskId}`,
                                details: {
                                    required: true,
                                    task_id: taskId,
                                    modified_files: diffInfo.files,
                                    diff_fingerprint: diffInfo.patchSha256,
                                },
                                evidence_sha256: evidenceSha,
                            });
                            if (!ack2 || ack2.type !== 'gate.result') throw new Error(`Failed to append scope gate for ${taskId}`);
                        }

                        if (!derived.gates || !derived.gates[`review-${taskId}`] || derived.gates[`review-${taskId}`].status !== 'PASSED') {
                            const ack3 = authorityStore.append({
                                schema_version: 2,
                                type: 'gate.result',
                                gate_id: `review-${taskId}`,
                                task_id: taskId,
                                status: 'PASSED',
                                reason: `Review approval validated for task ${taskId}`,
                                details: {
                                    required: true,
                                    task_id: taskId,
                                    recommendation: 'APPROVE',
                                    diff_fingerprint: diffInfo.patchSha256,
                                },
                                evidence_sha256: reviewSha,
                            });
                            if (!ack3 || ack3.type !== 'gate.result') throw new Error(`Failed to append review gate for ${taskId}`);
                        }
                    }

                    const compAck = authorityStore.append({
                        schema_version: 2,
                        type: 'task.completed',
                        task_id: taskId,
                        owner: task.owner,
                        authority_state: 'TASK_VERIFIED',
                        modified_files: diffInfo.files,
                        diff_fingerprint: diffInfo.patchSha256,
                        verdict: 'SUCCESS',
                        verified_by: 'codex',
                    });
                    if (!compAck || compAck.type !== 'task.completed') throw new Error(`Failed to append task.completed for ${taskId}`);

                    authorityStore.releaseLease(qcLease.lease_id, taskId, 'codex', { reason: 'codex_qc_verified' });
                } catch (err) {
                    let releaseErr = null;
                    try {
                        authorityStore.releaseLease(qcLease.lease_id, taskId, 'codex', { reason: `qc_error: ${err.message}` });
                    } catch (rErr) {
                        releaseErr = rErr;
                    }
                    if (releaseErr) {
                        return sendError(res, 500, 'DUAL_QC_FAILED', `Failed to record task completion for ${taskId}: ${err.message}; lease release also failed: ${releaseErr.message}`);
                    }
                    return sendError(res, 500, 'DUAL_QC_FAILED', `Failed to record task completion for ${taskId}: ${err.message}`);
                }

                derived = authorityStore.derive();
            }
        }

        // 2. Process optional quality_evidence
        if (params.quality_evidence && typeof params.quality_evidence === 'object') {
            let qe;
            try {
                qe = parseContract(QualityEvidenceSchema, params.quality_evidence, 'quality_evidence');
            } catch (err) {
                return sendError(res, 400, 'DUAL_QUALITY_INVALID_SCHEMA', `quality_evidence schema validation failed: ${err.message}`);
            }

            try {
                let currentQualityFingerprint;
                if (derived.currentBaseline && derived.currentBaseline.kind === 'snapshot') {
                    const authorityDir = path.join(canonicalWorkspaceRoot, '.omni', 'runs', 'dual-authority');
                    const initialSnapshot = readInitialSnapshot({
                        authorityDir,
                        sessionId: derived.sessionId,
                        workspaceId: derived.workspaceId,
                        workspaceRoot: canonicalWorkspaceRoot,
                        fsImpl,
                        cryptoImpl,
                    });
                    const { baseline: snapBaseline, excludedPaths } = configuredSnapshotBaseline();
                    currentQualityFingerprint = snapBaseline.fingerprint(
                        initialSnapshot.identity,
                        initialSnapshot.manifest,
                        { excludedPaths }
                    ).patchSha256;
                } else {
                    currentQualityFingerprint = captureDiffFingerprint({
                        repoRoot: canonicalWorkspaceRoot,
                        baseCommit: derived.currentBaseline ? derived.currentBaseline.id : undefined,
                        excludedPaths: ['.omni'],
                    }).patchSha256;
                }
                if (!digestEqual(qe.diff_fingerprint, currentQualityFingerprint)) {
                    return sendError(res, 400, 'DUAL_QUALITY_ERROR', `Diff fingerprint mismatch: fresh diff is ${currentQualityFingerprint}, input got ${qe.diff_fingerprint}`);
                }
                const persistedUi = persistedUiRequirement(derived);
                if (!persistedUi.policySha256) {
                    return sendError(res, 400, 'DUAL_QUALITY_ARTIFACT_BINDING', 'Legacy session has no persisted acceptance policy; create a new run before submitting fresh quality evidence');
                }
                try {
                    if (!trustedQualityRunner) {
                        return sendError(res, 400, 'DUAL_QUALITY_ATTESTATION_REQUIRED', 'Fresh quality evidence requires a daemon-owned runner in the current daemon process');
                    }
                    const registeredCommands = Object.values(derived.tasks || {})
                        .flatMap((task) => Array.isArray(task.validation_commands) ? task.validation_commands : []);
                    const expectedQualityPlan = buildQualityPlan(canonicalWorkspaceRoot, fsImpl, {
                        validationCommands: registeredCommands,
                    });
                    const authorityDir = path.join(canonicalWorkspaceRoot, '.omni', 'runs', 'dual-authority');
                    const expectedArtifact = {
                        sessionId: derived.sessionId,
                        workspaceId: derived.workspaceId,
                        baseline: derived.currentBaseline,
                        planRevision: derived.planRevision,
                        policySha256: persistedUi.policySha256,
                        diffFingerprint: qe.diff_fingerprint,
                        cycleIndex: qe.cycle_index,
                        attempt: qe.attempt,
                        totalTasks: qe.total_tasks,
                        completedTaskIds: [...qe.completed_task_ids],
                        workspaceRoot: canonicalWorkspaceRoot,
                        commandPlan: expectedQualityPlan.commands,
                    };
                    const executionId = qe.provenance.execution_id;
                    const existingAnchor = derived.qualityExecutions?.[executionId] || null;
                    const trusted = await trustedQualityRunner({
                        mode: 'submit',
                        authorityDir,
                        workspaceRoot: canonicalWorkspaceRoot,
                        executionId,
                        qualityEvidence: qe,
                        expected: expectedArtifact,
                        ...(existingAnchor ? { executionAttestation: existingAnchor } : {}),
                    });
                    if (!trusted || trusted.execution_id !== executionId
                        || !digestEqual(trusted.artifact_sha256, qe.evidence_sha256)) {
                        return sendError(res, 400, 'DUAL_QUALITY_ATTESTATION_INVALID', 'Daemon-owned quality runner did not attest the submitted execution and artifact hash');
                    }
                    const verifiedArtifact = verifyQualityExecutionArtifact({
                        authorityDir,
                        qualityEvidence: qe,
                        fsImpl,
                        expected: expectedArtifact,
                    });
                    if (!digestEqual(verifiedArtifact.sha256, trusted.artifact_sha256)
                        || !digestEqual(verifiedArtifact.sha256, qe.evidence_sha256)) {
                        return sendError(res, 400, 'DUAL_QUALITY_ATTESTATION_INVALID', 'Quality artifact bytes changed after daemon-owned execution');
                    }
                    const binding = qualityExecutionBinding(expectedArtifact, executionId, verifiedArtifact.sha256);
                    if (existingAnchor) {
                        const currentAnchor = authorityStore.derive().qualityExecutions?.[executionId];
                        if (!sameQualityExecutionBinding(existingAnchor, binding)
                            || !sameQualityExecutionBinding(currentAnchor, binding)) {
                            return sendError(res, 400, 'DUAL_QUALITY_ATTESTATION_INVALID', 'Durable quality execution attestation does not match submitted evidence');
                        }
                    } else {
                        const after = authorityStore.derive();
                        const afterPolicy = after.plan?.acceptance_policy || after.plan?.acceptancePolicy;
                        const afterTaskIds = Object.keys(after.tasks || {});
                        const afterCompletedIds = afterTaskIds.filter((taskId) => after.tasks[taskId]?.state === 'TASK_VERIFIED');
                        const afterCommands = Object.values(after.tasks || {})
                            .flatMap((task) => Array.isArray(task.validation_commands) ? task.validation_commands : []);
                        const afterPlan = buildQualityPlan(canonicalWorkspaceRoot, fsImpl, { validationCommands: afterCommands });
                        if (after.sessionId !== expectedArtifact.sessionId
                            || after.workspaceId !== expectedArtifact.workspaceId
                            || after.planRevision !== expectedArtifact.planRevision
                            || !sameJsonValue(after.currentBaseline, expectedArtifact.baseline)
                            || !afterPolicy || !digestEqual(hashAcceptancePolicy(afterPolicy), expectedArtifact.policySha256)
                            || afterTaskIds.length !== expectedArtifact.totalTasks
                            || !sameOrderedValues(afterCompletedIds, expectedArtifact.completedTaskIds)
                            || !sameJsonValue(afterPlan.commands, expectedArtifact.commandPlan)) {
                            return sendError(res, 400, 'DUAL_QUALITY_ATTESTATION_INVALID',
                                'Session, plan, policy, task, or command identity changed during daemon-owned quality verification');
                        }
                        let postExecutionFingerprint;
                        if (after.currentBaseline?.kind === 'snapshot') {
                            const initialSnapshot = readInitialSnapshot({
                                authorityDir,
                                sessionId: after.sessionId,
                                workspaceId: after.workspaceId,
                                workspaceRoot: canonicalWorkspaceRoot,
                                fsImpl,
                                cryptoImpl,
                            });
                            const { baseline: snapBaseline, excludedPaths } = configuredSnapshotBaseline();
                            postExecutionFingerprint = snapBaseline.fingerprint(
                                initialSnapshot.identity,
                                initialSnapshot.manifest,
                                { excludedPaths }
                            ).patchSha256;
                        } else {
                            postExecutionFingerprint = captureDiffFingerprint({
                                repoRoot: canonicalWorkspaceRoot,
                                baseCommit: after.currentBaseline?.id,
                                excludedPaths: ['.omni'],
                            }).patchSha256;
                        }
                        if (!digestEqual(postExecutionFingerprint, currentQualityFingerprint)) {
                            return sendError(res, 400, 'DUAL_QUALITY_SOURCE_DRIFT', 'Source diff fingerprint changed during daemon-owned quality execution');
                        }
                        appendQualityExecutionAttestation(authorityStore, binding);
                    }
                } catch (artifactError) {
                    return sendError(
                        res,
                        400,
                        artifactError.code || 'DUAL_QUALITY_ARTIFACT_INVALID',
                        artifactError.message || 'Quality execution artifact validation failed'
                    );
                }
                const qualityLedger = createQualityLedger({
                    authorityStore,
                    readDiffFingerprint: () => currentQualityFingerprint,
                });

                qualityLedger.recordCycle(qe);
                derived = authorityStore.derive();
            } catch (err) {
                return sendError(res, 400, 'DUAL_QUALITY_ERROR', `Failed to record quality cycle: ${err.message}`);
            }
        }

        // 3. Process optional ui_evidence
        if (params.ui_evidence && typeof params.ui_evidence === 'object') {
            let ue;
            try {
                ue = parseContract(UiEvidenceSchema, params.ui_evidence, 'ui_evidence');
            } catch (err) {
                return sendError(res, 400, 'DUAL_UI_GATE_INVALID_SCHEMA', `ui_evidence schema validation failed: ${err.message}`);
            }

            try {
                const persistedUi = persistedUiRequirement(derived);
                if (!persistedUi.policySha256) {
                    return sendError(res, 400, 'DUAL_UI_POLICY_REQUIRED', 'Legacy session has no persisted acceptance policy; create a new run with explicit UI policy for new UI evidence');
                }
                const expected = persistedUi.requirement;
                if (ue.requirement.gate_id !== expected.gate_id
                    || ue.requirement.required !== expected.required
                    || ue.requirement.reduced_motion_required !== expected.reduced_motion_required
                    || !sameOrderedValues(ue.requirement.viewport_widths, expected.viewport_widths)) {
                    return sendError(res, 400, 'DUAL_UI_POLICY_MISMATCH', 'UI requirement must exactly match the persisted acceptance policy');
                }
                if (!digestEqual(ue.evidence.policy_sha256, persistedUi.policySha256)
                    || !sameOrderedValues(ue.evidence.requested_viewports, expected.viewport_widths)) {
                    return sendError(res, 400, 'DUAL_UI_BINDING_MISMATCH', 'UI evidence policy hash or requested viewports do not match persisted authority');
                }
                let measuredFingerprint;
                if (derived.currentBaseline?.kind === 'snapshot') {
                    const authorityDir = path.join(canonicalWorkspaceRoot, '.omni', 'runs', 'dual-authority');
                    const initialSnapshot = readInitialSnapshot({
                        authorityDir,
                        sessionId: derived.sessionId,
                        workspaceId: derived.workspaceId,
                        workspaceRoot: canonicalWorkspaceRoot,
                        fsImpl,
                        cryptoImpl,
                    });
                    const { baseline: snapBaseline, excludedPaths } = configuredSnapshotBaseline();
                    measuredFingerprint = snapBaseline.fingerprint(
                        initialSnapshot.identity,
                        initialSnapshot.manifest,
                        { excludedPaths }
                    ).patchSha256;
                } else {
                    measuredFingerprint = captureDiffFingerprint({
                        repoRoot: canonicalWorkspaceRoot,
                        baseCommit: derived.currentBaseline?.id,
                        excludedPaths: ['.omni'],
                    }).patchSha256;
                }
                if (!digestEqual(ue.evidence.source_fingerprint, measuredFingerprint)) {
                    return sendError(res, 400, 'DUAL_UI_BINDING_MISMATCH', 'UI evidence source fingerprint does not match the measured workspace');
                }
                if (ue.evidence.runtime_status === 'AVAILABLE') {
                    if (!trustedUiAdapter) {
                        return sendError(res, 400, 'DUAL_UI_ATTESTATION_REQUIRED', 'AVAILABLE UI evidence requires a daemon-owned browser adapter in the current daemon process');
                    }
                    const authorityDir = path.join(canonicalWorkspaceRoot, '.omni', 'runs', 'dual-authority');
                    const evidenceKey = `${derived.sessionId}:${ue.evidence.evidence_sha256}`;
                    let trusted = trustedUiExecutions.get(evidenceKey);
                    if (!trusted) {
                        const adapterResult = await trustedUiAdapter({
                            authorityDir,
                            workspaceRoot: canonicalWorkspaceRoot,
                            sessionId: derived.sessionId,
                            requirement: expected,
                            policySha256: persistedUi.policySha256,
                            sourceFingerprint: measuredFingerprint,
                            viewports: [...expected.viewport_widths],
                        });
                        if (!adapterResult || !sameJsonValue(adapterResult.evidence, ue.evidence)) {
                            return sendError(res, 400, 'DUAL_UI_ATTESTATION_INVALID', 'Daemon-owned browser adapter evidence does not match the submitted UI evidence');
                        }
                        const evidenceData = {
                            runtime_status: ue.evidence.runtime_status,
                            policy_sha256: ue.evidence.policy_sha256,
                            source_fingerprint: ue.evidence.source_fingerprint,
                            requested_viewports: ue.evidence.requested_viewports,
                            viewports: ue.evidence.viewports,
                            reduced_motion: ue.evidence.reduced_motion,
                        };
                        const expectedEvidenceSha256 = sha256Json({ evidenceData, artifactHashes: ue.evidence.artifact_hashes }, cryptoImpl);
                        if (!digestEqual(expectedEvidenceSha256, ue.evidence.evidence_sha256)) {
                            return sendError(res, 400, 'DUAL_UI_ATTESTATION_INVALID', 'UI evidence digest does not bind the adapter measurements and artifact hashes');
                        }
                        const artifactHashes = verifyTrustedUiArtifacts({
                            authorityDir,
                            artifactPaths: adapterResult.artifact_paths,
                            expectedHashes: ue.evidence.artifact_hashes,
                            fsImpl,
                            cryptoImpl,
                        });
                        trusted = Object.freeze({
                            evidence_sha256: ue.evidence.evidence_sha256,
                            evidence_binding_sha256: sha256Json(stableJsonValue(ue.evidence), cryptoImpl),
                            artifact_hashes: Object.freeze([...artifactHashes]),
                            artifact_paths: Object.freeze([...adapterResult.artifact_paths]),
                        });
                        trustedUiExecutions.set(evidenceKey, trusted);
                    } else {
                        if (!digestEqual(trusted.evidence_binding_sha256, sha256Json(stableJsonValue(ue.evidence), cryptoImpl))) {
                            return sendError(res, 400, 'DUAL_UI_ATTESTATION_INVALID', 'UI replay payload differs from the daemon-attested adapter evidence');
                        }
                        verifyTrustedUiArtifacts({
                            authorityDir,
                            artifactPaths: trusted.artifact_paths,
                            expectedHashes: trusted.artifact_hashes,
                            fsImpl,
                            cryptoImpl,
                        });
                    }
                }
                recordUiEvidence({
                    authorityStore,
                    requirement: ue.requirement,
                    evidence: ue.evidence,
                });
                derived = authorityStore.derive();
            } catch (err) {
                return sendError(res, 400, err.code || 'DUAL_UI_GATE_ERROR', `Failed to record UI evidence: ${err.message}`);
            }
        }

        // If already VERIFIED: validate accepted snapshot/drift and return idempotently
        if (derived.sessionState === 'VERIFIED') {
            if (derived.currentBaseline && derived.currentBaseline.kind === 'snapshot') {
                const authorityDir = path.join(canonicalWorkspaceRoot, '.omni', 'runs', 'dual-authority');
                let initialSnapshot;
                try {
                    initialSnapshot = readInitialSnapshot({
                        authorityDir,
                        sessionId: derived.sessionId,
                        workspaceId: derived.workspaceId,
                        workspaceRoot: canonicalWorkspaceRoot,
                        fsImpl,
                        cryptoImpl,
                    });
                } catch (err) {
                    return sendResult(res, 200, {
                        verified: false,
                        session_state: 'VERIFIED',
                        blockers: [`INITIAL_SNAPSHOT_INVALID: ${err.message}`],
                    });
                }

                const authTasks = Object.keys(derived.tasks || {}).sort();
                let accepted;
                try {
                    accepted = readAcceptedSnapshot({
                        authorityDir,
                        sessionId: derived.sessionId,
                        workspaceId: derived.workspaceId,
                        workspaceRoot: canonicalWorkspaceRoot,
                        planRevision: derived.planRevision,
                        completedTasks: authTasks,
                        fsImpl,
                        cryptoImpl,
                    });
                } catch (err) {
                    return sendResult(res, 200, {
                        verified: false,
                        session_state: 'VERIFIED',
                        blockers: [`ACCEPTED_SNAPSHOT_INVALID: ${err.message}`],
                    });
                }

                // Require accepted completed tasks exactly equal authoritative sorted tasks
                if (
                    accepted.completed_tasks.length !== authTasks.length ||
                    !accepted.completed_tasks.every((t, i) => t === authTasks[i])
                ) {
                    return sendResult(res, 200, {
                        verified: false,
                        session_state: 'VERIFIED',
                        blockers: ['ACCEPTED_SNAPSHOT_TASKS_MISMATCH: accepted completed tasks do not match authoritative tasks'],
                    });
                }

                // Require accepted identity equals a fresh current capture
                const { baseline: snapBaseline, excludedPaths } = configuredSnapshotBaseline();
                const currentSnap = snapBaseline.capture();
                if (currentSnap.identity.id !== accepted.identity.id) {
                    return sendResult(res, 200, {
                        verified: false,
                        session_state: 'VERIFIED',
                        blockers: ['WORKSPACE_DRIFT_AFTER_VERIFIED: workspace modified after verification'],
                    });
                }

                // Recompute diff purely from initial + accepted manifest and require it equals accepted diff
                let recomputedDiff;
                try {
                    recomputedDiff = computeSnapshotManifestFingerprint(
                        initialSnapshot.identity,
                        initialSnapshot.manifest,
                        accepted.identity,
                        accepted.manifest,
                        { cryptoImpl, excludedPaths }
                    );
                } catch (err) {
                    return sendResult(res, 200, {
                        verified: false,
                        session_state: 'VERIFIED',
                        blockers: [`ACCEPTED_SNAPSHOT_DIFF_FAILED: ${err.message}`],
                    });
                }

                if (recomputedDiff.patchSha256 !== accepted.diff_fingerprint) {
                    return sendResult(res, 200, {
                        verified: false,
                        session_state: 'VERIFIED',
                        blockers: ['ACCEPTED_SNAPSHOT_DIFF_MISMATCH: accepted diff fingerprint does not match recomputed manifest diff'],
                    });
                }

                // Reconstruct receipt through shared helper and require it equals both authority receipt and accepted receipt
                const reconstructedReceiptObj = buildReceiptObject({
                    sessionId: derived.sessionId,
                    workspaceId: derived.workspaceId,
                    planRevision: derived.planRevision,
                    currentBaseline: derived.currentBaseline,
                    completedTasks: authTasks,
                    diffFingerprint: accepted.diff_fingerprint,
                    acceptedSnapshotIdentity: accepted.identity,
                });
                const reconstructedReceiptSha = computeReceiptSha256(reconstructedReceiptObj, cryptoImpl);
                const authReceiptSha = derived.receipt?.receipt_sha256 || derived.receipt?.receiptSha256;

                if (accepted.receipt_sha256 !== authReceiptSha || reconstructedReceiptSha !== authReceiptSha) {
                    return sendResult(res, 200, {
                        verified: false,
                        session_state: 'VERIFIED',
                        blockers: ['ACCEPTED_SNAPSHOT_RECEIPT_MISMATCH: accepted receipt does not match authoritative receipt'],
                    });
                }
            } else if (derived.currentBaseline && derived.currentBaseline.kind === 'git') {
                try {
                    const ws = resolveWorkspace(canonicalWorkspaceRoot);
                    if (ws.head !== derived.currentBaseline.id) {
                        return sendResult(res, 200, {
                            verified: false,
                            session_state: 'VERIFIED',
                            blockers: ['WORKSPACE_DRIFT_AFTER_VERIFIED: workspace modified after verification (HEAD moved)'],
                        });
                    }

                    const allEvents = authorityStore.readEvents();
                    const lastCycle = [...allEvents].reverse().find(e => e.type === 'gate.result' && typeof e.gate_id === 'string' && e.gate_id.startsWith('quality-cycle-'));
                    const acceptedDiffFingerprint = lastCycle?.details?.diff_fingerprint;

                    if (acceptedDiffFingerprint) {
                        const currentDiffFingerprint = captureDiffFingerprint({
                            repoRoot: canonicalWorkspaceRoot,
                            baseCommit: derived.currentBaseline.id,
                            excludedPaths: ['.omni'],
                        }).patchSha256;

                        if (currentDiffFingerprint !== acceptedDiffFingerprint) {
                            return sendResult(res, 200, {
                                verified: false,
                                session_state: 'VERIFIED',
                                blockers: ['WORKSPACE_DRIFT_AFTER_VERIFIED: workspace modified after verification'],
                            });
                        }
                    }
                } catch (err) {
                    return sendResult(res, 200, {
                        verified: false,
                        session_state: 'VERIFIED',
                        blockers: [`WORKSPACE_DRIFT_CHECK_FAILED: ${err.message}`],
                    });
                }
            }

            const terminalLeaseBlockers = [];
            for (const lease of Object.values(derived.leases || {})) {
                if (lease.status === 'active') {
                    terminalLeaseBlockers.push(
                        `ACTIVE_LEASE: lease ${lease.lease_id} for task ${lease.task_id} is active`
                    );
                } else if (lease.status === 'expired' && !lease.released_at && !lease.releasedAt) {
                    terminalLeaseBlockers.push(
                        `EXPIRED_UNRELEASED_LEASE: lease ${lease.lease_id} for task ${lease.task_id} expired without durable release`
                    );
                }
            }
            if (terminalLeaseBlockers.length > 0) {
                return sendResult(res, 200, {
                    verified: false,
                    session_state: 'VERIFIED',
                    blockers: terminalLeaseBlockers,
                });
            }

            return sendResult(res, 200, {
                verified: true,
                session_state: 'VERIFIED',
                receipt: derived.receipt,
                receipt_sha256: derived.receipt?.receipt_sha256 || derived.receipt?.receiptSha256,
                blockers: [],
            });
        }

        const blockers = [];

        // 4. Baseline check: baseline must exist
        if (!derived.currentBaseline || !derived.currentBaseline.id) {
            blockers.push('NO_BASELINE: session has no valid baseline');
        }

        // 5. All registered tasks must be TASK_VERIFIED
        const taskIds = Object.keys(derived.tasks || {});
        if (taskIds.length === 0) {
            blockers.push('NO_TASKS_REGISTERED: plan contains no tasks');
        } else {
            for (const tid of taskIds) {
                const task = derived.tasks[tid];
                if (task.state !== 'TASK_VERIFIED') {
                    blockers.push(`TASK_UNVERIFIED: task ${tid} is in state ${task.state}`);
                }
                if (task.owner === 'agy') {
                    if (task.verdict !== 'SUCCESS' || !task.diff_fingerprint) {
                        blockers.push(`DELEGATION_EVIDENCE_MISSING: agy task ${tid} lacks validated worker delegation evidence`);
                    }
                    if (task.verified_by !== 'codex' && task.verifiedBy !== 'codex') {
                        blockers.push(`CODEX_QC_MISSING: agy task ${tid} lacks Codex QC verification`);
                    }
                    const delGate = derived.gates ? derived.gates[`delegation-${tid}`] : null;
                    if (!delGate || delGate.status !== 'PASSED') {
                        blockers.push(`DELEGATION_GATE_UNMET: delegation gate for task ${tid} is not PASSED`);
                    }
                    const scopeGate = derived.gates ? derived.gates[`scope-${tid}`] : null;
                    if (!scopeGate || scopeGate.status !== 'PASSED') {
                        blockers.push(`SCOPE_GATE_UNMET: scope gate for task ${tid} is not PASSED`);
                    }
                    const reviewGate = derived.gates ? derived.gates[`review-${tid}`] : null;
                    if (!reviewGate || reviewGate.status !== 'PASSED') {
                        blockers.push(`REVIEW_GATE_UNMET: review gate for task ${tid} is not PASSED`);
                    }
                }
            }
        }

        // 5b. Acceptance correction checks
        if (derived.activeAcceptanceCorrection) {
            blockers.push(`ACCEPTANCE_CORRECTION_ACTIVE: correction ${derived.activeAcceptanceCorrection.correctionId} is currently active for task ${derived.activeAcceptanceCorrection.taskId}`);
        }
        for (const tid of taskIds) {
            const taskCorrections = (derived.acceptanceCorrections || []).filter((c) => c.taskId === tid);
            if (taskCorrections.length > 0) {
                const latestCorr = taskCorrections[taskCorrections.length - 1];
                if (latestCorr.status !== 'PASSED') {
                    blockers.push(`ACCEPTANCE_CORRECTION_FAILED: task ${tid} acceptance correction (attempt ${latestCorr.attempt}) failed: ${latestCorr.summary}`);
                }
            }
        }

        // 6. No active or expired unreleased lease
        for (const lease of Object.values(derived.leases || {})) {
            if (lease.status === 'active') {
                blockers.push(
                    `ACTIVE_LEASE: lease ${lease.lease_id} for task ${lease.task_id} is active`
                );
            } else if (lease.status === 'expired' && !lease.released_at && !lease.releasedAt) {
                blockers.push(
                    `EXPIRED_UNRELEASED_LEASE: lease ${lease.lease_id} for task ${lease.task_id} expired without durable release`
                );
            }
        }

        // 7. Quality completion evaluation (3 PASSED cycles correlated to plan/tasks)
        let currentDiffFingerprint;
        let capturedSnapshot = null;
        if (derived.currentBaseline) {
            try {
                if (derived.currentBaseline.kind === 'snapshot') {
                    const authorityDir = path.join(canonicalWorkspaceRoot, '.omni', 'runs', 'dual-authority');
                    const initialSnapshot = readInitialSnapshot({
                        authorityDir,
                        sessionId: derived.sessionId,
                        workspaceId: derived.workspaceId,
                        workspaceRoot: canonicalWorkspaceRoot,
                        fsImpl,
                        cryptoImpl,
                    });
                    const { baseline: snapBaseline, excludedPaths } = configuredSnapshotBaseline();
                    capturedSnapshot = snapBaseline.capture();
                    const diffInfo = computeSnapshotManifestFingerprint(
                        initialSnapshot.identity,
                        initialSnapshot.manifest,
                        capturedSnapshot.identity,
                        capturedSnapshot.manifest,
                        { cryptoImpl, excludedPaths }
                    );
                    currentDiffFingerprint = diffInfo.patchSha256;
                } else {
                    currentDiffFingerprint = captureDiffFingerprint({
                        repoRoot: canonicalWorkspaceRoot,
                        baseCommit: derived.currentBaseline.id,
                        excludedPaths: ['.omni'],
                    }).patchSha256;
                }
            } catch (err) {
                blockers.push(`DIFF_MEASUREMENT_FAILED: ${err.message}`);
            }
        }

        const totalPlanTasks = derived.plan?.total_tasks || derived.plan?.totalTasks || taskIds.length;
        const qualityEval = evaluateQualityCompletion({
            allEvents: authorityStore.readEvents(),
            totalTasks: totalPlanTasks,
            planRevision: derived.planRevision,
            diffFingerprint: currentDiffFingerprint,
            derivedTasks: derived.tasks || {},
            sessionId: derived.sessionId,
            workspaceId: derived.workspaceId,
            baseline: derived.currentBaseline,
            policySha256: derived.plan?.acceptance_policy_sha256 || derived.plan?.acceptancePolicySha256,
            qualityExecutions: derived.qualityExecutions,
            requireGeneration: true,
        });
        if (!qualityEval.passed) {
            for (const b of qualityEval.blockers) {
                blockers.push(b);
            }
        }

        // UI authority comes from the persisted acceptance policy, never from
        // runtime capability or a caller-provided requirement downgrade.
        const persistedUi = persistedUiRequirement(derived);
        const uiGate = derived.gates?.[CANONICAL_UI_GATE_ID];
        if (persistedUi.requirement.required && !uiGate) {
            blockers.push(persistedUi.legacyFallback
                ? 'UI_EVIDENCE_MISSING: legacy session has no explicit UI policy; required fallback cannot be satisfied implicitly'
                : 'UI_EVIDENCE_MISSING: persisted UI policy requires evidence before completion');
        } else if (uiGate) {
            const binding = uiGate.details || {};
            if (!persistedUi.policySha256
                || !digestEqual(binding.policy_sha256, persistedUi.policySha256)
                || !digestEqual(binding.source_fingerprint, currentDiffFingerprint)
                || !sameOrderedValues(binding.requested_viewports, persistedUi.requirement.viewport_widths)
                || binding.required !== persistedUi.requirement.required
                || binding.reduced_motion_required !== persistedUi.requirement.reduced_motion_required) {
                blockers.push('UI_EVIDENCE_STALE: recorded UI gate is not bound to the current policy and source fingerprint');
            }
        }

        // 8. Mandatory gates evaluation using evaluateMandatoryGates
        const allGates = Object.values(derived.gates || {}).map((g) => ({
            id: g.gate_id,
            required: g.details?.required !== false,
            status: g.status,
            ...(g.reason ? { reason: g.reason } : {}),
        }));
        if (allGates.length === 0) {
            blockers.push('MANDATORY_GATES_EMPTY: No quality or mandatory gates recorded');
        } else {
            try {
                const gateEval = evaluateMandatoryGates(allGates);
                if (gateEval.verdict !== 'PASSED') {
                    for (const b of gateEval.blockers) {
                        blockers.push(`MANDATORY_GATE_UNMET: gate ${b.id} ended with status ${b.status}: ${b.reason}`);
                    }
                }
            } catch (err) {
                blockers.push(`MANDATORY_GATES_ERROR: ${err.message}`);
            }
        }

        // 8b. Acceptance Policy evaluation for session-phase checks
        const sessionPolicy = derived.plan?.acceptance_policy || derived.plan?.acceptancePolicy;
        if (sessionPolicy && Array.isArray(sessionPolicy.checks)) {
            const sessionChecks = sessionPolicy.checks.filter((c) => c.phase === 'session');
            if (sessionChecks.length > 0) {
                const checkResults = [];
                for (const check of sessionChecks) {
                    const matchingGate = derived.gates?.[check.id] || derived.gates?.[`acceptance-${check.id}`];
                    if (matchingGate) {
                        const reviewBindingValid = check.kind !== 'review' || (
                            matchingGate.details?.review_phase === 'post_integration'
                            && matchingGate.details?.result_sha256 === currentDiffFingerprint
                            && matchingGate.details?.policy_sha256 === hashAcceptancePolicy(sessionPolicy)
                        );
                        const status = matchingGate.status === 'PASSED' && reviewBindingValid ? 'PASS'
                            : (matchingGate.status === 'FAILED' ? 'FAIL'
                                : (matchingGate.status === 'BLOCKED' ? 'BLOCKED' : 'UNAVAILABLE'));
                        checkResults.push({
                            check_id: check.id,
                            status,
                            findings: reviewBindingValid
                                ? (matchingGate.reason ? [matchingGate.reason] : [])
                                : ['Acceptance review evidence is stale or not bound to the current fingerprint'],
                        });
                    }
                }
                const sessionEval = evaluateSessionAcceptance(sessionPolicy, checkResults);
                if (sessionEval.status !== 'PASSED') {
                    if (sessionEval.missing && sessionEval.missing.length) {
                        blockers.push(`SESSION_ACCEPTANCE_MISSING: missing session acceptance checks: ${sessionEval.missing.join(', ')}`);
                    }
                    if (sessionEval.failed && sessionEval.failed.length) {
                        blockers.push(`SESSION_ACCEPTANCE_FAILED: failed session acceptance checks: ${sessionEval.failed.map((f) => `${f.check_id} (${f.status})`).join(', ')}`);
                    }
                }
            }
        }

        // 9. Session state check: if blockers exist, report not verified
        if (blockers.length > 0) {
            return sendResult(res, 200, {
                verified: false,
                session_state: derived.sessionState,
                blockers,
            });
        }

        // 10. Zero blockers! Derive receipt
        const sortedTaskIds = [...taskIds].sort();
        const receiptObj = buildReceiptObject({
            sessionId: derived.sessionId,
            workspaceId: derived.workspaceId,
            planRevision: derived.planRevision,
            currentBaseline: derived.currentBaseline,
            completedTasks: sortedTaskIds,
            diffFingerprint: currentDiffFingerprint,
            acceptedSnapshotIdentity: capturedSnapshot ? capturedSnapshot.identity : undefined,
        });
        const receiptSha256 = computeReceiptSha256(receiptObj, cryptoImpl);

        // For snapshot baseline: atomically persist and validate accepted-snapshot.json BEFORE appending session.verified
        if (derived.currentBaseline && derived.currentBaseline.kind === 'snapshot') {
            try {
                const authorityDir = path.join(canonicalWorkspaceRoot, '.omni', 'runs', 'dual-authority');
                writeAcceptedSnapshot({
                    authorityDir,
                    sessionId: derived.sessionId,
                    workspaceId: derived.workspaceId,
                    workspaceRoot: canonicalWorkspaceRoot,
                    planRevision: derived.planRevision,
                    completedTasks: sortedTaskIds,
                    diffFingerprint: currentDiffFingerprint,
                    receiptSha256,
                    identity: capturedSnapshot.identity,
                    manifest: capturedSnapshot.manifest,
                    fsImpl,
                    cryptoImpl,
                });

                const verifiedAccepted = readAcceptedSnapshot({
                    authorityDir,
                    sessionId: derived.sessionId,
                    workspaceId: derived.workspaceId,
                    workspaceRoot: canonicalWorkspaceRoot,
                    planRevision: derived.planRevision,
                    receiptSha256,
                    diffFingerprint: currentDiffFingerprint,
                    completedTasks: sortedTaskIds,
                    identity: capturedSnapshot.identity,
                    fsImpl,
                    cryptoImpl,
                });

                const recomputedReceiptObj = buildReceiptObject({
                    sessionId: verifiedAccepted.session_id,
                    workspaceId: verifiedAccepted.workspace_id,
                    planRevision: verifiedAccepted.plan_revision,
                    currentBaseline: derived.currentBaseline,
                    completedTasks: verifiedAccepted.completed_tasks,
                    diffFingerprint: verifiedAccepted.diff_fingerprint,
                    acceptedSnapshotIdentity: verifiedAccepted.identity,
                });
                const recomputedReceiptSha = computeReceiptSha256(recomputedReceiptObj, cryptoImpl);

                if (recomputedReceiptSha !== receiptSha256) {
                    throw new Error('Accepted snapshot receipt recomputation mismatch');
                }
            } catch (snapErr) {
                return sendResult(res, 200, {
                    verified: false,
                    session_state: derived.sessionState,
                    blockers: [`SNAPSHOT_CAPTURE_FAILED: ${snapErr.message}`],
                });
            }
        }

        try {
            authorityStore.append({
                schema_version: 2,
                type: 'session.verified',
                from_state: 'ACCEPTANCE',
                to_state: 'VERIFIED',
                receipt_sha256: receiptSha256,
                completed_tasks: sortedTaskIds,
            });
        } catch (err) {
            return sendResult(res, 200, {
                verified: false,
                session_state: derived.sessionState,
                blockers: [`VERIFICATION_APPEND_FAILED: ${err.message}`],
            });
        }

        derived = authorityStore.derive();
        return sendResult(res, 200, {
            verified: true,
            session_state: 'VERIFIED',
            receipt: derived.receipt,
            receipt_sha256: receiptSha256,
            blockers: [],
        });
    }

    function handleDaemonStop(res) {
        sendResult(res, 200, {
            success: true,
            message: 'Daemon stopping',
        });
        setImmediate(() => {
            closeServer();
        });
    }

    let serverListening = false;
    let actualPort = 0;
    let tmpDiscoveryPath = null;
    let discoveryWritten = false;
    const discoveryPath = path.join(runtimeDir, 'daemon.json');

    try {
        // Start listening on 127.0.0.1
        await new Promise((resolve, reject) => {
            server.on('error', reject);
            server.listen(port, '127.0.0.1', () => {
                server.removeListener('error', reject);
                serverListening = true;
                resolve();
            });
        });

        actualPort = server.address().port;

        // Attach endpoint to lock
        lockHandle.attachEndpoint({
            host: '127.0.0.1',
            port: actualPort,
        });

        // Write atomic discovery file
        const discoveryPayload = {
            protocol_version: 1,
            workspace_id: workspaceId,
            workspace_root: canonicalWorkspaceRoot,
            pid,
            started_at: startedAt,
            host: '127.0.0.1',
            port: actualPort,
            token,
        };
        tmpDiscoveryPath = path.join(
            runtimeDir,
            `daemon.json.tmp.${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`
        );
        fsImpl.writeFileSync(tmpDiscoveryPath, JSON.stringify(discoveryPayload, null, 2) + '\n', {
            encoding: 'utf8',
            mode: 0o600,
        });
        fsImpl.renameSync(tmpDiscoveryPath, discoveryPath);
        discoveryWritten = true;
        tmpDiscoveryPath = null;
    } catch (startupErr) {
        if (tmpDiscoveryPath && fsImpl.existsSync(tmpDiscoveryPath)) {
            try {
                fsImpl.unlinkSync(tmpDiscoveryPath);
            } catch {
                // ignore
            }
        }
        if (discoveryWritten) {
            unlinkOwnDiscovery(discoveryPath, fsImpl, { pid, startedAt, workspaceId });
        }
        if (serverListening) {
            try {
                await new Promise((resolve) => server.close(resolve));
            } catch {
                // ignore
            }
        }
        if (lockHandle) {
            try {
                await lockHandle.release();
            } catch {
                // ignore
            }
        }
        throw startupErr;
    }

    let stopResolve;
    const stoppedPromise = new Promise((resolve) => {
        stopResolve = resolve;
    });

    async function closeServer() {
        if (isStopped) {
            return stoppedPromise;
        }
        isStopped = true;

        if (idleTimer) {
            clearInterval(idleTimer);
            idleTimer = null;
        }

        // Clean discovery file if it belongs to this daemon
        unlinkOwnDiscovery(discoveryPath, fsImpl, { pid, startedAt, workspaceId });

        // Release lock
        try {
            await lockHandle.release();
        } catch {
            // ignore
        }

        await new Promise((resolve) => {
            server.close(() => {
                resolve();
            });
        });

        stopResolve();
        return stoppedPromise;
    }

    // Setup Idle Timer if requested
    if (idleTimeoutMs > 0) {
        idleTimer = setInterval(() => {
            if (isStopped) return;
            const now = Date.now();
            if (now - lastActivityTime >= idleTimeoutMs) {
                // Check if any active lease exists
                let hasActiveLease = false;
                try {
                    const derived = authorityStore.derive();
                    for (const lease of Object.values(derived.leases || {})) {
                        if (lease.status === 'active') {
                            hasActiveLease = true;
                            break;
                        }
                    }
                } catch {
                    // if store cannot be derived, fail safe and don't postpone blindly
                }

                if (hasActiveLease) {
                    // Active lease postpones shutdown
                    lastActivityTime = now;
                } else {
                    closeServer();
                }
            }
        }, Math.min(Math.max(10, Math.floor(idleTimeoutMs / 2)), 100));
    }

    return {
        address: {
            host: '127.0.0.1',
            port: actualPort,
        },
        workspaceId,
        workspaceRoot: canonicalWorkspaceRoot,
        runtimeDir,
        token,
        close: closeServer,
        stopped: stoppedPromise,
        get isStopped() {
            return isStopped;
        },
    };
}

module.exports = {
    DualDaemonServerError,
    startDaemonServer,
    safeTokenCompare,
    verifyPlanArtifact,
};
