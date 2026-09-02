'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
    TaskIdSchema,
    ContextSchema,
    SpecSchema,
    RouteSchema,
    EvidenceSchema,
    ReviewSchema,
    AttemptMetaSchema,
    parseContract,
    toDraft7Schema,
    normalizeBaselineCorrelation,
    emitBaselineCorrelation,
} = require('./contracts');
const {
    DualWorkspaceError,
    execGit,
    resolveWorkspace,
    normalizeRepoPath,
    assertBaseWorkspace,
} = require('./workspace');
const {
    createConfiguredSnapshotBaseline,
} = require('./snapshot-policy');
const {
    DualScopeError,
    captureDiffFingerprint,
    assertAllowedDiff,
    assertReviewUnchanged,
} = require('./scope-guard');
const {
    STATES,
    TRANSITIONS,
    DualStateError,
    createStateStore,
} = require('./state-store');
const {
    DualArtifactError,
    createArtifactStore,
} = require('./artifacts');
const {
    DualAgyRunnerError,
    buildAgyInvocation,
    runProcess,
} = require('./agy-runner');
const {
    DualAgyOutputError,
    extractAgyPayload,
} = require('./agy-output');
const {
    parseAgyModelsOutput,
    parseAgyVersionOutput,
    spawnBoundedProcess,
} = require('./capability-preflight');
const {
    resolveConfiguredWorkerModel,
    resolveConfiguredWorkerEffort,
} = require('./agy-model');

class DualOrchestratorError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DualOrchestratorError';
        this.code = code;
        this.details = details;
    }
}

function resolvePackageVersion() {
    try {
        const pkgPath = path.resolve(__dirname, '../../package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg && typeof pkg.version === 'string') return pkg.version;
        }
    } catch {
        // Fallback below
    }
    return '1.0.0';
}

function loadPromptTemplate(phase) {
    const templatePath = path.resolve(__dirname, `../../templates/codex-gemini/prompts/${phase}.md`);
    if (fs.existsSync(templatePath)) {
        return fs.readFileSync(templatePath, 'utf8');
    }
    // Bundled fallback prompts
    if (phase === 'scout') {
        return '# Scout Phase Prompt (Read-Only Reconnaissance)\n\nSurvey the codebase to answer the request and discover exact symbols, files, tests, constraints, and risks.\n';
    }
    if (phase === 'implement') {
        return '# Implementation Phase Prompt\n\nImplement the changes specified in spec.json for the given task. Surgical edits only.\n';
    }
    if (phase === 'review') {
        return '# Review Phase Prompt\n\nPerform an independent read-only review of the changes in git diff against spec.json and evidence.json.\n';
    }
    return `# Phase ${phase}\n`;
}

function isNetworkOrTimeoutError(result, err) {
    if (result && result.timedOut) return true;
    if (err && err.code === 'DUAL_AGY_TIMEOUT') return true;
    const message = [
        result && result.stderr,
        result && result.stdout,
        err && err.message,
    ].filter(Boolean).join(' ');
    const networkPatterns = [
        /ETIMEDOUT/i,
        /ECONNRESET/i,
        /ECONNREFUSED/i,
        /ENOTFOUND/i,
        /EAI_AGAIN/i,
        /UND_ERR_CONNECT_TIMEOUT/i,
        /fetch failed/i,
        /socket hang up/i,
        /network error/i,
    ];
    return networkPatterns.some((pattern) => pattern.test(message));
}

const MAX_AGY_TECHNICAL_ATTEMPTS = 3;
const RETRYABLE_AGY_ERROR_CODES = new Set([
    'DUAL_AGY_TIMEOUT',
    'DUAL_AGY_SPAWN',
    'DUAL_AGY_EXIT_NONZERO',
    'DUAL_AGY_EMPTY_OUTPUT',
    'DUAL_AGY_OUTPUT_MALFORMED',
    'DUAL_AGY_CONTRACT_INVALID',
]);

function isRetryableAgyTechnicalFailure(result, err) {
    return Boolean(
        (result && result.timedOut)
        || (err && RETRYABLE_AGY_ERROR_CODES.has(err.code))
        || isNetworkOrTimeoutError(result, err),
    );
}

function retryCorrectionHint(errorCode) {
    const safeCode = RETRYABLE_AGY_ERROR_CODES.has(errorCode)
        ? errorCode
        : 'DUAL_AGY_TECHNICAL_FAILURE';
    return `Previous attempt failed with ${safeCode}. Re-read the source and return the exact strict JSON contract.`;
}

function createBaselineOperations(options = {}) {
    const cwd = options.cwd || process.cwd();
    const gitRunner = options.gitRunner || execGit;
    const backend = options.backend
        || (options.initialSnapshot || (options.baseline && options.baseline.kind === 'snapshot') ? 'snapshot' : 'git');

    if (backend === 'snapshot') {
        const initialSnapshot = options.initialSnapshot;
        if (!initialSnapshot) {
            throw new DualOrchestratorError('DUAL_BASELINE_INVALID', 'Snapshot orchestrator requires initialSnapshot');
        }
        const baseline = { kind: 'snapshot', id: initialSnapshot.identity.id };
        const {
            baseline: snapBaseline,
            excludedPaths: configuredExcludedPaths,
        } = createConfiguredSnapshotBaseline({ root: cwd });

        return {
            backend: 'snapshot',
            baseline,
            bindWorkspace() {
                let canonicalRoot;
                try {
                    canonicalRoot = fs.realpathSync?.native
                        ? fs.realpathSync.native(cwd)
                        : (fs.realpathSync ? fs.realpathSync(cwd) : path.resolve(cwd));
                } catch {
                    canonicalRoot = path.resolve(cwd);
                }
                return {
                    repoRoot: canonicalRoot,
                    baseline,
                    head: baseline.id,
                    sourceChanges: [],
                };
            },
            assertBaseWorkspace({ repoRoot, expectedBaseline, excludedRunDir }) {
                if (expectedBaseline) {
                    const norm = normalizeBaselineCorrelation(expectedBaseline);
                    if (norm.kind !== 'snapshot' || norm.id !== initialSnapshot.identity.id) {
                        throw new DualWorkspaceError(
                            'DUAL_BASE_COMMIT_STALE',
                            `Expected snapshot baseline ${norm.id} does not match initial snapshot ${initialSnapshot.identity.id}`
                        );
                    }
                }
                const excluded = [
                    ...configuredExcludedPaths,
                    ...(excludedRunDir ? [path.relative(repoRoot, excludedRunDir).replace(/\\/g, '/')] : []),
                ];
                const diffResults = snapBaseline.diff(initialSnapshot.identity, initialSnapshot.manifest, {
                    excludedPaths: excluded,
                });
                if (diffResults.length > 0) {
                    throw new DualWorkspaceError(
                        'DUAL_BASE_COMMIT_STALE',
                        `Workspace has uncommitted changes relative to snapshot baseline: ${diffResults.map((d) => d.path).join(', ')}`
                    );
                }
                return true;
            },
            captureDiffFingerprint({ repoRoot, baseline: currentBaseline, excludedPaths }) {
                const excluded = [...configuredExcludedPaths, ...(excludedPaths || []).map((p) => {
                    if (path.isAbsolute(p)) {
                        return path.relative(repoRoot, p).replace(/\\/g, '/');
                    }
                    return p.replace(/\\/g, '/');
                })];
                const fp = snapBaseline.fingerprint(initialSnapshot.identity, initialSnapshot.manifest, {
                    excludedPaths: excluded,
                });
                return {
                    files: fp.files,
                    patchSha256: fp.patchSha256,
                    rawDiff: '',
                };
            },
            assertScope({ repoRoot, baseline: currentBaseline, allowedFiles, denyPatterns, excludedPaths }) {
                const excluded = [...configuredExcludedPaths, ...(excludedPaths || []).map((p) => {
                    if (path.isAbsolute(p)) {
                        return path.relative(repoRoot, p).replace(/\\/g, '/');
                    }
                    return p.replace(/\\/g, '/');
                })];
                snapBaseline.assertScope(initialSnapshot.identity, initialSnapshot.manifest, {
                    allowedFiles,
                    denyPatterns,
                    excludedPaths: excluded,
                });
            },
            assertReviewUnchanged(before, after) {
                if (
                    before.patchSha256 !== after.patchSha256 ||
                    JSON.stringify(before.files) !== JSON.stringify(after.files)
                ) {
                    throw new DualScopeError('DUAL_SCOPE_REVIEW_MUTATED', 'Review phase mutated workspace files');
                }
            },
            formatPromptBaseline(currentBaseline) {
                return `Baseline identity: ${currentBaseline.id}`;
            },
            emitCorrelation(currentBaseline) {
                return emitBaselineCorrelation(currentBaseline);
            },
        };
    }

    // Default Git backend
    return {
        backend: 'git',
        bindWorkspace() {
            const { repoRoot, head, sourceChanges } = resolveWorkspace(cwd, gitRunner);
            return {
                repoRoot,
                baseline: { kind: 'git', id: head },
                head,
                sourceChanges,
            };
        },
        assertBaseWorkspace({ repoRoot, expectedBaseline, excludedRunDir }) {
            return assertBaseWorkspace({
                repoRoot,
                expectedBaseCommit: expectedBaseline.id,
                excludedRunDir,
                execGit: gitRunner,
            });
        },
        captureDiffFingerprint({ repoRoot, baseline: currentBaseline, excludedPaths }) {
            const relativeExcluded = (excludedPaths || []).map((p) => {
                if (path.isAbsolute(p)) {
                    return path.relative(repoRoot, p).replace(/\\/g, '/');
                }
                return p.replace(/\\/g, '/');
            });
            return captureDiffFingerprint({
                repoRoot,
                baseCommit: currentBaseline.id,
                excludedPaths: relativeExcluded,
                execGit: gitRunner,
            });
        },
        assertScope({ repoRoot, baseline: currentBaseline, allowedFiles, denyPatterns, excludedPaths }) {
            const relativeExcluded = (excludedPaths || []).map((p) => {
                if (path.isAbsolute(p)) {
                    return path.relative(repoRoot, p).replace(/\\/g, '/');
                }
                return p.replace(/\\/g, '/');
            });
            const { files } = captureDiffFingerprint({
                repoRoot,
                baseCommit: currentBaseline.id,
                excludedPaths: relativeExcluded,
                execGit: gitRunner,
            });
            assertAllowedDiff({
                changedFiles: files,
                allowedFiles,
                denyPatterns,
            });
        },
        assertReviewUnchanged(before, after) {
            return assertReviewUnchanged(before, after);
        },
        formatPromptBaseline(currentBaseline) {
            return `Base commit: ${currentBaseline.id}`;
        },
        emitCorrelation(currentBaseline) {
            return emitBaselineCorrelation(currentBaseline);
        },
    };
}

function createDualOrchestrator(options = {}) {
    const cwd = options.cwd || process.cwd();
    const agyCommand = options.agyCommand || 'agy';
    const agyPrefixArgs = options.agyPrefixArgs || [];
    const clock = options.clock || (() => new Date());
    const uuid = options.uuid || crypto.randomUUID;
    const packageVersion = options.packageVersion || resolvePackageVersion();
    const processRunner = options.processRunner || runProcess;
    const spawn = options.spawn;
    const env = options.env || process.env;
    // Give AGY a quality-first 20 minute reasoning window plus an outer
    // 30 second process margin. The runner derives --print-timeout from this.
    const defaultTimeoutMs = options.timeoutMs || 1_230_000;
    const baselineOps = options.baselineOps || createBaselineOperations(options);
    const authoritativeCapabilityEvidence = options.authoritativeCapabilityEvidence || options.capabilityEvidence;
    const targetWorkerModel = resolveConfiguredWorkerModel(cwd, options);
    const targetWorkerEffort = resolveConfiguredWorkerEffort(cwd, options);

    let cachedAgyVersion = null;

    const capabilityProcessRunner = options.capabilityProcessRunner || (options.processRunner
        ? processRunner
        : async (invocation) => {
            const startedAt = clock();
            const result = await spawnBoundedProcess(invocation.command, invocation.args, {
                spawnImpl: spawn,
                timeoutMs: invocation.timeoutMs,
                maxOutputBytes: 64 * 1024,
                cwd: invocation.cwd,
                env,
            });
            const endedAt = clock();
            return {
                exitCode: result.code,
                stdout: result.stdout,
                stderr: result.stderr,
                timedOut: Boolean(result.timedOut),
                startedAt,
                endedAt,
                durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
            };
        });

    function getTaskDir(repoRoot, taskId) {
        return path.join(repoRoot, '.omni', 'codex-gemini', 'runs', taskId);
    }

    function newTask(taskId) {
        parseContract(TaskIdSchema, taskId, 'task_id');
        const { repoRoot, baseline, head, sourceChanges } = baselineOps.bindWorkspace();

        const runDir = getTaskDir(repoRoot, taskId);
        if (fs.existsSync(path.join(runDir, 'events.ndjson'))) {
            throw new DualOrchestratorError('DUAL_TASK_EXISTS', `Task already exists: ${taskId}`, { taskId });
        }

        if (sourceChanges && sourceChanges.length > 0) {
            throw new DualWorkspaceError(
                'DUAL_WORKTREE_DIRTY',
                `Source tree has changes outside the active transaction: ${sourceChanges.join(', ')}`,
                { sourceChanges },
            );
        }

        fs.mkdirSync(path.join(runDir, 'raw'), { recursive: true });
        const requestPath = path.join(runDir, 'request.md');
        if (!fs.existsSync(requestPath)) {
            fs.writeFileSync(
                requestPath,
                `# Task: ${taskId}\n\n${baselineOps.formatPromptBaseline(baseline)}\n`,
                'utf8'
            );
        }

        const store = createStateStore(runDir, { taskId, expectedBaseline: baseline, clock, uuid });
        store.append({ type: 'transaction.created', state: 'NEW' });

        return {
            taskId,
            state: 'NEW',
            owner: 'codex',
            expectedBaseline: baseline,
            expectedBaseCommit: baseline.kind === 'git' ? baseline.id : undefined,
            nextAction: 'preflight',
            warnings: [],
            reused: false,
        };
    }

    function loadTask(taskId) {
        parseContract(TaskIdSchema, taskId, 'task_id');
        const { repoRoot, baseline, head } = baselineOps.bindWorkspace();
        const runDir = getTaskDir(repoRoot, taskId);

        if (!fs.existsSync(runDir) || !fs.existsSync(path.join(runDir, 'events.ndjson'))) {
            throw new DualOrchestratorError('DUAL_TASK_NOT_FOUND', `Task not found: ${taskId}`, { taskId });
        }

        const store = createStateStore(runDir, { taskId, clock, uuid });
        const artifacts = createArtifactStore(runDir);

        return { repoRoot, baseline, head, runDir, store, artifacts, taskId };
    }

    function derivePublicState(store, runDir) {
        const rawState = store.current();
        const routePath = path.join(runDir, 'route.json');
        if (fs.existsSync(routePath)) {
            try {
                const route = JSON.parse(fs.readFileSync(routePath, 'utf8'));
                if (rawState === 'ROUTED' && route.owner === 'codex') {
                    return 'CODEX_OWNED';
                }
            } catch {
                // Keep raw state
            }
        }
        if (rawState === 'REVIEW_VALID') {
            return 'CODEX_QC';
        }
        return rawState;
    }

    function getOwnerAndNextAction(state, route) {
        let owner = 'codex';
        if (route && route.owner === 'gemini' && !['NEW', 'PREFLIGHT_SAFE', 'SCOUT_VALID', 'SPEC_VALID', 'CODEX_OWNED', 'CODEX_QC'].includes(state)) {
            owner = 'gemini';
        }

        let nextAction;
        switch (state) {
            case 'NEW':
                nextAction = 'preflight';
                break;
            case 'PREFLIGHT_SAFE':
                nextAction = 'scout';
                break;
            case 'SCOUT_VALID':
                nextAction = 'spec';
                break;
            case 'SPEC_VALID':
                nextAction = 'route';
                break;
            case 'ROUTED':
                nextAction = owner === 'gemini' ? 'implement' : 'codex_work';
                break;
            case 'CODEX_OWNED':
                nextAction = 'codex_work';
                break;
            case 'IMPLEMENT_VALID':
                nextAction = 'scope';
                break;
            case 'SCOPE_VALID':
                nextAction = 'review';
                break;
            case 'REVIEW_VALID':
            case 'CODEX_QC':
                nextAction = 'codex_qc';
                break;
            default:
                nextAction = 'unknown';
        }

        return { owner, nextAction };
    }

    function status(taskId) {
        const { runDir, store, baseline } = loadTask(taskId);
        const state = derivePublicState(store, runDir);
        let route = null;
        const routePath = path.join(runDir, 'route.json');
        if (fs.existsSync(routePath)) {
            try {
                route = JSON.parse(fs.readFileSync(routePath, 'utf8'));
            } catch {
                // Ignore corrupt route in status
            }
        }

        const { owner, nextAction } = getOwnerAndNextAction(state, route);
        const events = store.readEvents();
        const currentBaseline = events[0]
            ? normalizeBaselineCorrelation(events[0])
            : baseline;

        const attempts = {};
        for (const event of events) {
            if (event.phase && typeof event.attempt === 'number') {
                attempts[event.phase] = Math.max(attempts[event.phase] || 0, event.attempt);
            }
        }

        return {
            taskId,
            state,
            owner,
            expectedBaseline: currentBaseline,
            expectedBaseCommit: currentBaseline.kind === 'git' ? currentBaseline.id : undefined,
            attempts,
            nextAction,
            warnings: [],
        };
    }

    async function executeAgyWithRetry({
        repoRoot,
        runDir,
        artifacts,
        store,
        phase,
        taskId,
        baseline,
        inputPath,
        schemaPath,
        schema,
        timeoutMs,
    }) {
        if (!cachedAgyVersion) {
            const completedPreflight = [...store.readEvents()].reverse().find(
                (event) => event.type === 'phase.completed' && event.phase === 'preflight'
            );
            const persistedVersion = parseAgyVersionOutput(
                completedPreflight?.capability_evidence?.agy_version || ''
            );
            const persistedModel = completedPreflight?.capability_evidence?.agy_model;
            if (persistedVersion && (persistedModel === targetWorkerModel || !persistedModel)) {
                cachedAgyVersion = persistedVersion;
            } else if (authoritativeCapabilityEvidence) {
                const authVersion = parseAgyVersionOutput(
                    authoritativeCapabilityEvidence.version ||
                    authoritativeCapabilityEvidence.agy_version ||
                    authoritativeCapabilityEvidence.agyVersion ||
                    ''
                );
                const authModel = authoritativeCapabilityEvidence.model ||
                    authoritativeCapabilityEvidence.agy_model ||
                    authoritativeCapabilityEvidence.agyModel;
                if (!authVersion || (authModel && authModel !== targetWorkerModel)) {
                    throw new DualOrchestratorError(
                        'DUAL_PREFLIGHT_AUTHORITY_INVALID',
                        'Authoritative capability evidence is invalid before AGY execution'
                    );
                }
                cachedAgyVersion = authVersion;
            } else {
                cachedAgyVersion = await probeStandaloneCapability(repoRoot);
            }
        }

        let attempt = store.nextAttempt(phase);
        let lastError = null;
        let retryHint;

        while (attempt <= MAX_AGY_TECHNICAL_ATTEMPTS) {
            const invocation = buildAgyInvocation({
                agyCommand,
                agyPrefixArgs,
                repoRoot,
                phase,
                inputPath,
                schemaPath,
                timeoutMs,
                retryHint,
                model: targetWorkerModel,
                effort: targetWorkerEffort,
            });

            store.append({ type: 'phase.started', phase, attempt });

            let result;
            try {
                result = await processRunner(invocation, { env, spawn });
            } catch (err) {
                lastError = err;
                const retryable = attempt < MAX_AGY_TECHNICAL_ATTEMPTS
                    && isRetryableAgyTechnicalFailure(null, err);
                store.append({
                    type: 'phase.failed',
                    phase,
                    attempt,
                    error_code: err.code || 'DUAL_AGY_SPAWN',
                    retryable,
                });
                if (retryable) {
                    retryHint = retryCorrectionHint(err.code || 'DUAL_AGY_SPAWN');
                    attempt = store.nextAttempt(phase);
                    continue;
                }
                throw err;
            }

            const inputBytes = fs.readFileSync(inputPath);
            const schemaBytes = fs.readFileSync(schemaPath);
            const inputSha256 = artifacts.sha256(inputBytes);
            const schemaSha256 = artifacts.sha256(schemaBytes);

            const meta = {
                schema_version: 1,
                task_id: taskId,
                ...baselineOps.emitCorrelation(baseline),
                phase,
                attempt,
                package_version: packageVersion,
                agy_version: cachedAgyVersion,
                started_at: result.startedAt ? result.startedAt.toISOString() : clock().toISOString(),
                ended_at: result.endedAt ? result.endedAt.toISOString() : clock().toISOString(),
                duration_ms: result.durationMs ?? 0,
                exit_code: result.exitCode ?? null,
                timed_out: Boolean(result.timedOut),
                cwd: repoRoot,
                redacted_argv: invocation.redactedArgs,
                shell: false,
                input_sha256: inputSha256,
                schema_sha256: schemaSha256,
            };

            artifacts.writeImmutable(`raw/${phase}.${attempt}.stdout.json`, result.stdout || '');
            artifacts.writeImmutable(`raw/${phase}.${attempt}.stderr.txt`, result.stderr || '');
            artifacts.writeJsonImmutable(`raw/${phase}.${attempt}.meta.json`, meta);

            if (result.timedOut) {
                const timeoutError = new DualAgyRunnerError(
                    'DUAL_AGY_TIMEOUT',
                    `Agy timed out during ${phase} phase`,
                );
                lastError = timeoutError;
                const retryable = attempt < MAX_AGY_TECHNICAL_ATTEMPTS;
                store.append({
                    type: 'phase.failed',
                    phase,
                    attempt,
                    error_code: 'DUAL_AGY_TIMEOUT',
                    retryable,
                });
                if (retryable) {
                    retryHint = retryCorrectionHint('DUAL_AGY_TIMEOUT');
                    attempt = store.nextAttempt(phase);
                    continue;
                }
                throw timeoutError;
            }

            try {
                const extracted = extractAgyPayload(result, schema);
                return { extracted, result, meta, attempt };
            } catch (err) {
                lastError = err;
                const retryable = attempt < MAX_AGY_TECHNICAL_ATTEMPTS
                    && isRetryableAgyTechnicalFailure(result, err);
                store.append({
                    type: 'phase.failed',
                    phase,
                    attempt,
                    error_code: err.code || 'DUAL_AGY_FAILED',
                    retryable,
                });
                if (retryable) {
                    retryHint = retryCorrectionHint(err.code || 'DUAL_AGY_FAILED');
                    attempt = store.nextAttempt(phase);
                    continue;
                }
                throw err;
            }
        }

        if (lastError) throw lastError;
        throw new DualAgyRunnerError('DUAL_AGY_FAILED', `Agy failed during ${phase} phase`);
    }

    function tryRecoverPhase({ runDir, artifacts, store, phase, taskId, expectedBaseline, schema, toState }) {
        const events = store.readEvents();
        const lastEvent = events.at(-1);
        if (!lastEvent || lastEvent.type !== 'phase.started' || lastEvent.phase !== phase) {
            return null;
        }

        const attempt = lastEvent.attempt;
        const stdoutFile = path.join(runDir, 'raw', `${phase}.${attempt}.stdout.json`);
        if (!fs.existsSync(stdoutFile)) {
            return null;
        }

        try {
            const rawStdout = fs.readFileSync(stdoutFile, 'utf8');
            const extracted = extractAgyPayload({ exitCode: 0, stdout: rawStdout }, schema);
            const payloadBaseline = normalizeBaselineCorrelation(extracted.payload);
            if (
                extracted.payload.task_id === taskId &&
                payloadBaseline.kind === expectedBaseline.kind &&
                payloadBaseline.id === expectedBaseline.id
            ) {
                return { payload: extracted.payload, attempt, warnings: extracted.warnings };
            }
        } catch {
            return null;
        }
        return null;
    }

    async function probeStandaloneCapability(repoRoot) {
        let versionResult;
        try {
            versionResult = await capabilityProcessRunner({
                command: agyCommand,
                args: [...agyPrefixArgs, '--version'],
                cwd: repoRoot,
                timeoutMs: 15_000,
                redactedArgs: [...agyPrefixArgs, '--version'],
            }, { env, spawn });
        } catch (error) {
            throw new DualOrchestratorError(
                'DUAL_PREFLIGHT_AGY_MISSING',
                'Agy CLI is not available or failed --version check',
                { cause: error.message },
            );
        }
        if (versionResult.timedOut || versionResult.exitCode !== 0) {
            throw new DualOrchestratorError(
                'DUAL_PREFLIGHT_AGY_MISSING',
                'Agy CLI is not available or failed --version check',
                { cause: versionResult.stderr || 'exit non-zero' },
            );
        }

        const parsedVersion = parseAgyVersionOutput(versionResult.stdout || '');
        if (!parsedVersion) {
            throw new DualOrchestratorError(
                'DUAL_PREFLIGHT_AGY_VERSION_INVALID',
                'Agy --version output did not contain one exact semantic version'
            );
        }

        let modelsResult;
        try {
            modelsResult = await capabilityProcessRunner({
                command: agyCommand,
                args: [...agyPrefixArgs, 'models'],
                cwd: repoRoot,
                timeoutMs: 15_000,
                redactedArgs: [...agyPrefixArgs, 'models'],
            }, { env, spawn });
        } catch (error) {
            throw new DualOrchestratorError(
                'DUAL_PREFLIGHT_MODEL_UNAVAILABLE',
                `Failed to query models or model ${targetWorkerModel} is not available`,
                { cause: error.message },
            );
        }
        if (
            modelsResult.timedOut ||
            modelsResult.exitCode !== 0 ||
            !parseAgyModelsOutput((modelsResult.stdout || '').trim(), targetWorkerModel)
        ) {
            throw new DualOrchestratorError(
                'DUAL_PREFLIGHT_MODEL_UNAVAILABLE',
                `Failed to query models or model ${targetWorkerModel} is not available`,
                { cause: modelsResult.stderr || 'required exact model missing' },
            );
        }

        return parsedVersion;
    }

    async function runPhase(phase, taskId) {
        const { repoRoot, baseline, runDir, store, artifacts } = loadTask(taskId);
        const events = store.readEvents();
        const expectedBaseline = events[0]
            ? normalizeBaselineCorrelation(events[0])
            : baseline;

        if (phase === 'preflight') {
            if (store.hasSuccessfulPhase('preflight')) {
                const completedPreflight = [...events].reverse().find(
                    (event) => event.type === 'phase.completed' && event.phase === 'preflight'
                );
                const persistedVersion = parseAgyVersionOutput(
                    completedPreflight?.capability_evidence?.agy_version || ''
                );
                const persistedModel = completedPreflight?.capability_evidence?.agy_model;
                if (persistedVersion && (persistedModel === targetWorkerModel || !persistedModel)) {
                    cachedAgyVersion = persistedVersion;
                } else if (authoritativeCapabilityEvidence) {
                    const authVersion = parseAgyVersionOutput(
                        authoritativeCapabilityEvidence.version ||
                        authoritativeCapabilityEvidence.agy_version ||
                        authoritativeCapabilityEvidence.agyVersion ||
                        ''
                    );
                    const authModel = authoritativeCapabilityEvidence.model ||
                        authoritativeCapabilityEvidence.agy_model ||
                        authoritativeCapabilityEvidence.agyModel;
                    if (!authVersion || (authModel && authModel !== targetWorkerModel)) {
                        throw new DualOrchestratorError(
                            'DUAL_PREFLIGHT_AUTHORITY_INVALID',
                            'Authoritative capability evidence is invalid on preflight resume'
                        );
                    }
                    cachedAgyVersion = authVersion;
                } else {
                    // Compatibility path for transactions created before capability evidence
                    // was persisted in phase.completed.
                    cachedAgyVersion = await probeStandaloneCapability(repoRoot);
                }
                return {
                    taskId,
                    state: derivePublicState(store, runDir),
                    owner: 'codex',
                    nextAction: 'scout',
                    warnings: [],
                    reused: true,
                };
            }

            baselineOps.assertBaseWorkspace({ repoRoot, expectedBaseline, excludedRunDir: runDir });

            if (authoritativeCapabilityEvidence) {
                if (typeof authoritativeCapabilityEvidence !== 'object' || authoritativeCapabilityEvidence === null) {
                    throw new DualOrchestratorError(
                        'DUAL_PREFLIGHT_AUTHORITY_INVALID',
                        'Authoritative capability evidence must be a valid object'
                    );
                }
                const authVersion = parseAgyVersionOutput(
                    authoritativeCapabilityEvidence.version || authoritativeCapabilityEvidence.agy_version || authoritativeCapabilityEvidence.agyVersion || ''
                );
                const authModel = authoritativeCapabilityEvidence.model || authoritativeCapabilityEvidence.agy_model || authoritativeCapabilityEvidence.agyModel;

                if (
                    !authVersion ||
                    (authModel && authModel !== targetWorkerModel)
                ) {
                    throw new DualOrchestratorError(
                        'DUAL_PREFLIGHT_AUTHORITY_INVALID',
                        `Authoritative capability evidence is invalid, missing required model ${targetWorkerModel}, or missing actual version`
                    );
                }

                cachedAgyVersion = authVersion;

                const attempt = store.nextAttempt('preflight');
                store.append({ type: 'phase.started', phase: 'preflight', attempt });
                store.append({
                    type: 'phase.completed',
                    phase: 'preflight',
                    attempt,
                    from_state: 'NEW',
                    to_state: 'PREFLIGHT_SAFE',
                    artifact_hashes: {},
                    warnings: [],
                    capability_evidence: {
                        agy_version: cachedAgyVersion,
                        agy_model: targetWorkerModel,
                    },
                });

                return {
                    taskId,
                    state: 'PREFLIGHT_SAFE',
                    owner: 'codex',
                    nextAction: 'scout',
                    warnings: [],
                    reused: false,
                };
            }

            // Standalone live preflight
            cachedAgyVersion = await probeStandaloneCapability(repoRoot);

            const attempt = store.nextAttempt('preflight');
            store.append({ type: 'phase.started', phase: 'preflight', attempt });
            store.append({
                type: 'phase.completed',
                phase: 'preflight',
                attempt,
                from_state: 'NEW',
                to_state: 'PREFLIGHT_SAFE',
                artifact_hashes: {},
                warnings: [],
                capability_evidence: {
                    agy_version: cachedAgyVersion,
                    agy_model: targetWorkerModel,
                },
            });

            return {
                taskId,
                state: 'PREFLIGHT_SAFE',
                owner: 'codex',
                nextAction: 'scout',
                warnings: [],
                reused: false,
            };
        }

        if (phase === 'scout') {
            if (store.hasSuccessfulPhase('scout')) {
                return {
                    taskId,
                    state: derivePublicState(store, runDir),
                    owner: 'codex',
                    nextAction: 'spec',
                    warnings: [],
                    reused: true,
                };
            }

            const currentState = store.current();
            if (currentState !== 'PREFLIGHT_SAFE') {
                throw new DualOrchestratorError(
                    'DUAL_TRANSITION_INVALID',
                    `Cannot run scout from state ${currentState}`,
                );
            }

            baselineOps.assertBaseWorkspace({ repoRoot, expectedBaseline, excludedRunDir: runDir });

            // Check crash recovery
            const recovered = tryRecoverPhase({
                runDir,
                artifacts,
                store,
                phase: 'scout',
                taskId,
                expectedBaseline,
                schema: ContextSchema,
                toState: 'SCOUT_VALID',
            });

            if (recovered) {
                const contextArt = artifacts.writeJsonAtomic('context.json', recovered.payload);
                store.append({
                    type: 'phase.completed',
                    phase: 'scout',
                    attempt: recovered.attempt,
                    from_state: 'PREFLIGHT_SAFE',
                    to_state: 'SCOUT_VALID',
                    artifact_hashes: { 'context.json': contextArt.sha256 },
                    warnings: recovered.warnings,
                });
                return {
                    taskId,
                    state: 'SCOUT_VALID',
                    owner: 'codex',
                    nextAction: 'spec',
                    warnings: recovered.warnings,
                    reused: false,
                };
            }

            const attempt = store.nextAttempt('scout');
            const requestContent = fs.existsSync(path.join(runDir, 'request.md'))
                ? fs.readFileSync(path.join(runDir, 'request.md'), 'utf8')
                : '';
            const promptTemplate = loadPromptTemplate('scout');
            const inputContent = `# Task: ${taskId}\n${baselineOps.formatPromptBaseline(expectedBaseline)}\n\n${promptTemplate}\n\n## Request\n${requestContent}\n`;

            const inputArt = artifacts.writeImmutable(`raw/scout.${attempt}.input.md`, inputContent);
            const schemaObj = toDraft7Schema(ContextSchema, 'omni-dual-context-v1');
            const schemaArt = artifacts.writeJsonImmutable(`raw/scout.${attempt}.schema.json`, schemaObj);

            const asyncResult = await executeAgyWithRetry({
                repoRoot,
                runDir,
                artifacts,
                store,
                phase: 'scout',
                taskId,
                baseline: expectedBaseline,
                inputPath: inputArt.path,
                schemaPath: schemaArt.path,
                schema: ContextSchema,
                timeoutMs: defaultTimeoutMs,
            });

            const contextArt = artifacts.writeJsonAtomic('context.json', asyncResult.extracted.payload);
            store.append({
                type: 'phase.completed',
                phase: 'scout',
                attempt: asyncResult.attempt,
                from_state: 'PREFLIGHT_SAFE',
                to_state: 'SCOUT_VALID',
                artifact_hashes: { 'context.json': contextArt.sha256 },
                warnings: asyncResult.extracted.warnings,
            });

            return {
                taskId,
                state: 'SCOUT_VALID',
                owner: 'codex',
                nextAction: 'spec',
                warnings: asyncResult.extracted.warnings,
                reused: false,
            };
        }

        if (phase === 'spec') {
            if (store.hasSuccessfulPhase('spec')) {
                return {
                    taskId,
                    state: derivePublicState(store, runDir),
                    owner: 'codex',
                    nextAction: 'route',
                    warnings: [],
                    reused: true,
                };
            }

            const currentState = store.current();
            if (currentState !== 'SCOUT_VALID') {
                throw new DualOrchestratorError(
                    'DUAL_TRANSITION_INVALID',
                    `Cannot validate spec from state ${currentState}`,
                );
            }

            const specPath = path.join(runDir, 'spec.json');
            if (!fs.existsSync(specPath)) {
                throw new DualOrchestratorError('DUAL_SPEC_MISSING', 'spec.json not found in run directory');
            }

            let rawSpec;
            try {
                rawSpec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
            } catch (error) {
                throw new DualOrchestratorError('DUAL_SPEC_INVALID', 'spec.json contains malformed JSON');
            }

            const spec = parseContract(SpecSchema, rawSpec, 'spec');
            const specBaseline = normalizeBaselineCorrelation(spec);
            if (
                spec.task_id !== taskId ||
                specBaseline.kind !== expectedBaseline.kind ||
                specBaseline.id !== expectedBaseline.id
            ) {
                throw new DualOrchestratorError('DUAL_SPEC_CORRELATION', 'spec.json task_id or baseline does not match');
            }

            for (const file of spec.allowed_files) {
                normalizeRepoPath(repoRoot, file);
            }

            const attempt = store.nextAttempt('spec');
            store.append({ type: 'phase.started', phase: 'spec', attempt });
            const specHash = artifacts.sha256(fs.readFileSync(specPath));
            store.append({
                type: 'phase.completed',
                phase: 'spec',
                attempt,
                from_state: 'SCOUT_VALID',
                to_state: 'SPEC_VALID',
                artifact_hashes: { 'spec.json': specHash },
                warnings: [],
            });

            return {
                taskId,
                state: 'SPEC_VALID',
                owner: 'codex',
                nextAction: 'route',
                warnings: [],
                reused: false,
            };
        }

        if (phase === 'route') {
            if (store.hasSuccessfulPhase('route')) {
                const route = JSON.parse(fs.readFileSync(path.join(runDir, 'route.json'), 'utf8'));
                const owner = route.owner;
                const state = owner === 'codex' ? 'CODEX_OWNED' : 'ROUTED';
                const nextAction = owner === 'codex' ? 'codex_work' : 'implement';
                return {
                    taskId,
                    state,
                    owner,
                    nextAction,
                    warnings: [],
                    reused: true,
                };
            }

            const currentState = store.current();
            if (currentState !== 'SPEC_VALID') {
                throw new DualOrchestratorError(
                    'DUAL_TRANSITION_INVALID',
                    `Cannot route from state ${currentState}`,
                );
            }

            const specPath = path.join(runDir, 'spec.json');
            const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

            const hasRisk = Array.isArray(spec.risk_flags) && spec.risk_flags.length > 0;
            const isTooManyFiles = Array.isArray(spec.allowed_files) && spec.allowed_files.length > 10;
            const isCodex = hasRisk || isTooManyFiles;
            const owner = isCodex ? 'codex' : 'gemini';

            const routeData = {
                schema_version: 1,
                task_id: taskId,
                ...baselineOps.emitCorrelation(expectedBaseline),
                owner,
                model: isCodex ? null : targetWorkerModel,
                effort: isCodex ? null : targetWorkerEffort,
                token_budget: null,
                allowed_files: spec.allowed_files,
                reason: isCodex
                    ? (isTooManyFiles
                        ? `Spec allows ${spec.allowed_files.length} files (exceeds maximum of 10). Codex retains architecture ownership.`
                        : `Spec contains risk flags: ${spec.risk_flags.join(', ')}. Codex retains ownership.`)
                    : 'Spec meets bounded criteria (<= 3 allowed files, zero risk flags, validation commands). Routed to Gemini.',
            };

            const routeArt = artifacts.writeJsonAtomic('route.json', routeData);
            const attempt = store.nextAttempt('route');
            store.append({ type: 'phase.started', phase: 'route', attempt });
            store.append({
                type: 'phase.completed',
                phase: 'route',
                attempt,
                from_state: 'SPEC_VALID',
                to_state: 'ROUTED',
                artifact_hashes: { 'route.json': routeArt.sha256 },
                warnings: [],
            });

            if (isCodex) {
                store.append({
                    type: 'handoff.completed',
                    owner: 'codex',
                    from_state: 'ROUTED',
                    to_state: 'CODEX_OWNED',
                    reason: 'codex_route',
                });
                return {
                    taskId,
                    state: 'CODEX_OWNED',
                    owner: 'codex',
                    nextAction: 'codex_work',
                    warnings: [],
                    reused: false,
                };
            }

            return {
                taskId,
                state: 'ROUTED',
                owner: 'gemini',
                nextAction: 'implement',
                warnings: [],
                reused: false,
            };
        }

        if (phase === 'implement') {
            if (store.hasSuccessfulPhase('implement')) {
                return {
                    taskId,
                    state: derivePublicState(store, runDir),
                    owner: 'gemini',
                    nextAction: 'scope',
                    warnings: [],
                    reused: true,
                };
            }

            const currentState = store.current();
            if (currentState !== 'ROUTED') {
                throw new DualOrchestratorError(
                    'DUAL_TRANSITION_INVALID',
                    `Cannot implement from state ${currentState}`,
                );
            }

            const route = JSON.parse(fs.readFileSync(path.join(runDir, 'route.json'), 'utf8'));
            if (route.owner !== 'gemini') {
                throw new DualOrchestratorError('DUAL_ROUTE_NOT_GEMINI', 'Cannot run implement on Codex-owned task');
            }

            baselineOps.assertBaseWorkspace({ repoRoot, expectedBaseline, excludedRunDir: runDir });

            const recovered = tryRecoverPhase({
                runDir,
                artifacts,
                store,
                phase: 'implement',
                taskId,
                expectedBaseline,
                schema: EvidenceSchema,
                toState: 'IMPLEMENT_VALID',
            });

            if (recovered) {
                const evidenceArt = artifacts.writeJsonAtomic('evidence.json', recovered.payload);
                store.append({
                    type: 'phase.completed',
                    phase: 'implement',
                    attempt: recovered.attempt,
                    from_state: 'ROUTED',
                    to_state: 'IMPLEMENT_VALID',
                    artifact_hashes: { 'evidence.json': evidenceArt.sha256 },
                    warnings: recovered.warnings,
                });
                return {
                    taskId,
                    state: 'IMPLEMENT_VALID',
                    owner: 'gemini',
                    nextAction: 'scope',
                    warnings: recovered.warnings,
                    reused: false,
                };
            }

            const spec = JSON.parse(fs.readFileSync(path.join(runDir, 'spec.json'), 'utf8'));
            const promptTemplate = loadPromptTemplate('implement');
            const attempt = store.nextAttempt('implement');
            const inputContent = `# Task: ${taskId}\n${baselineOps.formatPromptBaseline(expectedBaseline)}\n\n${promptTemplate}\n\n## Spec\nGoal: ${spec.goal}\nAllowed Files: ${spec.allowed_files.join(', ')}\n`;

            const inputArt = artifacts.writeImmutable(`raw/implement.${attempt}.input.md`, inputContent);
            const schemaObj = toDraft7Schema(EvidenceSchema, 'omni-dual-evidence-v1');
            const schemaArt = artifacts.writeJsonImmutable(`raw/implement.${attempt}.schema.json`, schemaObj);

            const asyncResult = await executeAgyWithRetry({
                repoRoot,
                runDir,
                artifacts,
                store,
                phase: 'implement',
                taskId,
                baseline: expectedBaseline,
                inputPath: inputArt.path,
                schemaPath: schemaArt.path,
                schema: EvidenceSchema,
                timeoutMs: defaultTimeoutMs,
            });

            const evidenceArt = artifacts.writeJsonAtomic('evidence.json', asyncResult.extracted.payload);
            store.append({
                type: 'phase.completed',
                phase: 'implement',
                attempt: asyncResult.attempt,
                from_state: 'ROUTED',
                to_state: 'IMPLEMENT_VALID',
                artifact_hashes: { 'evidence.json': evidenceArt.sha256 },
                warnings: asyncResult.extracted.warnings,
            });

            return {
                taskId,
                state: 'IMPLEMENT_VALID',
                owner: 'gemini',
                nextAction: 'scope',
                warnings: asyncResult.extracted.warnings,
                reused: false,
            };
        }

        if (phase === 'scope') {
            if (store.hasSuccessfulPhase('scope')) {
                return {
                    taskId,
                    state: derivePublicState(store, runDir),
                    owner: 'gemini',
                    nextAction: 'review',
                    warnings: [],
                    reused: true,
                };
            }

            const currentState = store.current();
            if (currentState !== 'IMPLEMENT_VALID') {
                throw new DualOrchestratorError(
                    'DUAL_TRANSITION_INVALID',
                    `Cannot scope from state ${currentState}`,
                );
            }

            const spec = JSON.parse(fs.readFileSync(path.join(runDir, 'spec.json'), 'utf8'));
            baselineOps.assertScope({
                repoRoot,
                baseline: expectedBaseline,
                allowedFiles: spec.allowed_files,
                denyPatterns: spec.deny_patterns || [],
                excludedPaths: [runDir],
            });

            const attempt = store.nextAttempt('scope');
            store.append({ type: 'phase.started', phase: 'scope', attempt });
            store.append({
                type: 'phase.completed',
                phase: 'scope',
                attempt,
                from_state: 'IMPLEMENT_VALID',
                to_state: 'SCOPE_VALID',
                artifact_hashes: {},
                warnings: [],
            });

            return {
                taskId,
                state: 'SCOPE_VALID',
                owner: 'gemini',
                nextAction: 'review',
                warnings: [],
                reused: false,
            };
        }

        if (phase === 'review') {
            if (store.hasSuccessfulPhase('review')) {
                return {
                    taskId,
                    state: 'CODEX_QC',
                    owner: 'codex',
                    nextAction: 'codex_qc',
                    warnings: [],
                    reused: true,
                };
            }

            const currentState = store.current();
            if (currentState !== 'SCOPE_VALID') {
                throw new DualOrchestratorError(
                    'DUAL_TRANSITION_INVALID',
                    `Cannot review from state ${currentState}`,
                );
            }

            const recovered = tryRecoverPhase({
                runDir,
                artifacts,
                store,
                phase: 'review',
                taskId,
                expectedBaseline,
                schema: ReviewSchema,
                toState: 'REVIEW_VALID',
            });

            if (recovered) {
                const reviewArt = artifacts.writeJsonAtomic('review.json', recovered.payload);
                store.append({
                    type: 'phase.completed',
                    phase: 'review',
                    attempt: recovered.attempt,
                    from_state: 'SCOPE_VALID',
                    to_state: 'REVIEW_VALID',
                    artifact_hashes: { 'review.json': reviewArt.sha256 },
                    warnings: recovered.warnings,
                });
                store.append({
                    type: 'handoff.completed',
                    owner: 'codex',
                    from_state: 'REVIEW_VALID',
                    to_state: 'CODEX_QC',
                    reason: 'final_qc',
                });
                return {
                    taskId,
                    state: 'CODEX_QC',
                    owner: 'codex',
                    nextAction: 'codex_qc',
                    warnings: recovered.warnings,
                    reused: false,
                };
            }

            const beforeDiff = baselineOps.captureDiffFingerprint({
                repoRoot,
                baseline: expectedBaseline,
                excludedPaths: [runDir],
            });

            const spec = JSON.parse(fs.readFileSync(path.join(runDir, 'spec.json'), 'utf8'));
            const promptTemplate = loadPromptTemplate('review');
            const attempt = store.nextAttempt('review');
            const inputContent = `# Task: ${taskId}\n${baselineOps.formatPromptBaseline(expectedBaseline)}\n\n${promptTemplate}\n\n## Spec\nGoal: ${spec.goal}\nAllowed Files: ${spec.allowed_files.join(', ')}\n`;

            const inputArt = artifacts.writeImmutable(`raw/review.${attempt}.input.md`, inputContent);
            const schemaObj = toDraft7Schema(ReviewSchema, 'omni-dual-review-v1');
            const schemaArt = artifacts.writeJsonImmutable(`raw/review.${attempt}.schema.json`, schemaObj);

            const asyncResult = await executeAgyWithRetry({
                repoRoot,
                runDir,
                artifacts,
                store,
                phase: 'review',
                taskId,
                baseline: expectedBaseline,
                inputPath: inputArt.path,
                schemaPath: schemaArt.path,
                schema: ReviewSchema,
                timeoutMs: defaultTimeoutMs,
            });

            const afterDiff = baselineOps.captureDiffFingerprint({
                repoRoot,
                baseline: expectedBaseline,
                excludedPaths: [runDir],
            });
            baselineOps.assertReviewUnchanged(beforeDiff, afterDiff);

            const reviewArt = artifacts.writeJsonAtomic('review.json', asyncResult.extracted.payload);
            store.append({
                type: 'phase.completed',
                phase: 'review',
                attempt: asyncResult.attempt,
                from_state: 'SCOPE_VALID',
                to_state: 'REVIEW_VALID',
                artifact_hashes: { 'review.json': reviewArt.sha256 },
                warnings: asyncResult.extracted.warnings,
            });
            store.append({
                type: 'handoff.completed',
                owner: 'codex',
                from_state: 'REVIEW_VALID',
                to_state: 'CODEX_QC',
                reason: 'final_qc',
            });

            return {
                taskId,
                state: 'CODEX_QC',
                owner: 'codex',
                nextAction: 'codex_qc',
                warnings: asyncResult.extracted.warnings,
                reused: false,
            };
        }

        throw new DualOrchestratorError('DUAL_UNKNOWN_PHASE', `Unknown phase: ${phase}`);
    }

    async function run(taskId) {
        const { runDir, store } = loadTask(taskId);

        while (true) {
            const rawState = store.current();
            if (rawState === 'NEW') {
                await runPhase('preflight', taskId);
                continue;
            }
            if (rawState === 'PREFLIGHT_SAFE') {
                await runPhase('scout', taskId);
                continue;
            }
            if (rawState === 'SCOUT_VALID') {
                const specPath = path.join(runDir, 'spec.json');
                if (!fs.existsSync(specPath)) {
                    return {
                        taskId,
                        state: 'SCOUT_VALID',
                        owner: 'codex',
                        nextAction: 'spec',
                        warnings: [],
                        reused: false,
                    };
                }
                await runPhase('spec', taskId);
                continue;
            }
            if (rawState === 'SPEC_VALID') {
                const routeResult = await runPhase('route', taskId);
                if (routeResult.owner === 'codex') {
                    return routeResult;
                }
                continue;
            }
            if (rawState === 'ROUTED') {
                const routePath = path.join(runDir, 'route.json');
                if (fs.existsSync(routePath)) {
                    const route = JSON.parse(fs.readFileSync(routePath, 'utf8'));
                    if (route.owner === 'codex') {
                        return {
                            taskId,
                            state: 'CODEX_OWNED',
                            owner: 'codex',
                            nextAction: 'codex_work',
                            warnings: [],
                            reused: false,
                        };
                    }
                }
                await runPhase('implement', taskId);
                continue;
            }
            if (rawState === 'IMPLEMENT_VALID') {
                await runPhase('scope', taskId);
                continue;
            }
            if (rawState === 'SCOPE_VALID') {
                await runPhase('review', taskId);
                continue;
            }
            if (rawState === 'REVIEW_VALID') {
                return {
                    taskId,
                    state: 'CODEX_QC',
                    owner: 'codex',
                    nextAction: 'codex_qc',
                    warnings: [],
                    reused: false,
                };
            }
            if (rawState === 'CODEX_OWNED') {
                return {
                    taskId,
                    state: 'CODEX_OWNED',
                    owner: 'codex',
                    nextAction: 'codex_work',
                    warnings: [],
                    reused: false,
                };
            }
            if (rawState === 'CODEX_QC') {
                return {
                    taskId,
                    state: 'CODEX_QC',
                    owner: 'codex',
                    nextAction: 'codex_qc',
                    warnings: [],
                    reused: false,
                };
            }

            break;
        }

        return status(taskId);
    }

    async function resume(taskId) {
        return run(taskId);
    }

    return {
        newTask,
        run,
        resume,
        status,
        runPhase,
    };
}

module.exports = {
    DualOrchestratorError,
    createBaselineOperations,
    createDualOrchestrator,
};
