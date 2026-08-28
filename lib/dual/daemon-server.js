'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

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

const {
    evaluateMandatoryGates,
    evaluateQualityCompletion,
    createQualityLedger,
} = require('./quality-ledger');

const {
    evaluateUiEvidence,
    recordUiEvidence,
} = require('./ui-gate');

const {
    captureDiffFingerprint,
} = require('./scope-guard');

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
                    'completion.evaluate',
                    'plan.register',
                    'session.resume',
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
            case 'completion.evaluate':
                return handleCompletionEvaluate(params, res);
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
            plan_revision: derived.planRevision,
            current_baseline: derived.currentBaseline,
            plan: derived.plan,
            tasks: derived.tasks,
            leases: derived.leases,
            gates: derived.gates,
            blocked: derived.blocked,
            receipt: derived.receipt,
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
        if (
            derived.plan &&
            derived.plan.plan_sha256 === params.plan_sha256 &&
            derived.plan.total_tasks === params.tasks.length &&
            derived.planRevision === planRevision
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

        if (derived.sessionState === 'BLOCKED') {
            return sendError(res, 400, 'DUAL_SESSION_BLOCKED', 'Session is in BLOCKED state');
        }

        // If session is still in DISCOVERED, run real / injected capability preflight
        if (derived.sessionState === 'DISCOVERED') {
            const preflightFn = typeof effectivePreflight === 'function' ? effectivePreflight : runCapabilityPreflight;
            let capResult;
            try {
                capResult = await preflightFn(canonicalWorkspaceRoot, {
                    authorityStore,
                    fsImpl,
                    ...options,
                });
            } catch (err) {
                capResult = {
                    status: 'BLOCKED',
                    to_state: 'BLOCKED',
                    checks: [
                        { name: 'preflight_exception', status: 'BLOCKED', reason: err.message },
                    ],
                };
            }

            if (capResult && capResult.status === 'PASSED') {
                const validation = validateCapabilityResult(capResult);
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
            if (t.category) taskObj.category = t.category.toLowerCase();
            if (t.complexity) taskObj.complexity = t.complexity.toLowerCase();
            if (t.risk) taskObj.risk = t.risk.toLowerCase();
            if (t.deny_patterns) taskObj.deny_patterns = t.deny_patterns;
            if (t.validation_commands) taskObj.validation_commands = t.validation_commands;

            registeredTasksMap.set(t.task_id, { ...t, owner, risk: t.risk ? t.risk.toLowerCase() : undefined });
            planTasks.push(taskObj);
        }

        if (planTasks.filter((task) => task.owner === 'agy').length > 1) {
            return sendError(res, 400, 'DUAL_PLAN_INVALID', 'A Dual session supports at most one AGY task against its immutable baseline');
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
            });

            for (const t of planTasks) {
                const isAgy = t.owner === 'agy';
                authorityStore.append({
                    schema_version: 2,
                    type: 'task.routed',
                    task_id: t.task_id,
                    owner: t.owner,
                    authority_state: 'ROUTED',
                    model: isAgy ? 'gemini-3.7-flash-high' : null,
                    effort: isAgy ? 'high' : null,
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

        if (task.state === 'REGISTERED') {
            return sendResult(res, 200, {
                decision: 'deny',
                permissionDecision: 'deny',
                reason: `[omni-blocked] task ${taskId} is not routed`,
                permissionDecisionReason: `[omni-blocked] task ${taskId} is not routed`,
            });
        }

        const requestedOwner = params.owner;
        if (requestedOwner && requestedOwner !== task.owner) {
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

        if (!hasActiveLease && !hasInteractiveCodexAuthority) {
            return sendResult(res, 200, {
                decision: 'deny',
                permissionDecision: 'deny',
                reason: `[omni-blocked] no active lease for task ${taskId}`,
                permissionDecisionReason: `[omni-blocked] no active lease for task ${taskId}`,
            });
        }

        const allowed = (task.allowed_files || task.allowedFiles || []).map((f) => f.replace(/\\/g, '/'));

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

    function handleCompletionEvaluate(params, res) {
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

                if (routeObj.owner !== 'gemini' || routeObj.model !== 'gemini-3.7-flash-high' || routeObj.effort !== 'high') {
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
                                    model: 'gemini-3.7-flash-high',
                                    effort: 'high',
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
                const qualityLedger = createQualityLedger({
                    authorityStore,
                    readDiffFingerprint: () => {
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
                            return snapBaseline.fingerprint(initialSnapshot.identity, initialSnapshot.manifest, { excludedPaths }).patchSha256;
                        }
                        return captureDiffFingerprint({
                            repoRoot: canonicalWorkspaceRoot,
                            baseCommit: derived.currentBaseline ? derived.currentBaseline.id : undefined,
                            excludedPaths: ['.omni'],
                        }).patchSha256;
                    },
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
                recordUiEvidence({
                    authorityStore,
                    requirement: ue.requirement,
                    evidence: ue.evidence,
                });
                derived = authorityStore.derive();
            } catch (err) {
                return sendError(res, 400, 'DUAL_UI_GATE_ERROR', `Failed to record UI evidence: ${err.message}`);
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
                    if (ws.head !== derived.currentBaseline.id || ws.sourceChanges.length > 0) {
                        return sendResult(res, 200, {
                            verified: false,
                            session_state: 'VERIFIED',
                            blockers: ['WORKSPACE_DRIFT_AFTER_VERIFIED: workspace modified after verification'],
                        });
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
        });
        if (!qualityEval.passed) {
            for (const b of qualityEval.blockers) {
                blockers.push(b);
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
