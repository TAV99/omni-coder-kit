'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createDualOrchestrator } = require('./orchestrator');
const { captureDiffFingerprint } = require('./scope-guard');
const {
    createConfiguredSnapshotBaseline,
} = require('./snapshot-policy');
const {
    readInitialSnapshot,
} = require('./snapshot-store');
const {
    normalizeRepoPath,
    execGit,
    resolveWorkspace,
} = require('./workspace');

const {
    parseContract,
    ContextSchema,
    SpecSchema,
    RouteSchema,
    EvidenceSchema,
    ReviewSchema,
    EventSchema,
    normalizeBaselineCorrelation,
    emitBaselineCorrelation,
    validateEventSequence,
    validatePhaseArtifactHashes,
} = require('./contracts');

function createOrchestratorAdapter(options = {}) {
    const {
        workspaceRoot,
        authorityStore,
        gitRunner = execGit,
        agyCommand = 'agy',
        agyPrefixArgs = [],
        processRunner,
        clock = () => new Date(),
        setIntervalFn = setInterval,
        clearIntervalFn = clearInterval,
        leaseHeartbeatMs = 10_000,
    } = options;

    if (!workspaceRoot || typeof workspaceRoot !== 'string') {
        throw new Error('workspaceRoot is required for orchestrator adapter');
    }

    async function runTask(derived) {
        if (!derived || !derived.tasks) return null;

        const results = [];
        for (const [taskId, task] of Object.entries(derived.tasks)) {
            if (task.owner === 'agy' && (task.state === 'ROUTED' || task.state === 'AGY_IMPLEMENT')) {
                const res = await executeAgyTask(taskId, task, derived);
                results.push(res);
            }
        }
        return results;
    }

    async function executeAgyTask(taskId, task, derived) {
        if (!authorityStore) {
            throw new Error('authorityStore is required to execute task');
        }

        if (!derived || !derived.currentBaseline || !derived.currentBaseline.id) {
            throw new Error('Task execution requires an initialized baseline in derived state');
        }

        const currentBaseline = derived.currentBaseline;
        const isSnapshot = currentBaseline.kind === 'snapshot';
        const isGit = currentBaseline.kind === 'git';

        if (!isSnapshot && !isGit) {
            throw new Error(`Unsupported baseline kind: ${currentBaseline.kind}`);
        }

        let initialSnapshot = null;
        if (isSnapshot) {
            const authorityDir = path.join(workspaceRoot, '.omni', 'runs', 'dual-authority');
            initialSnapshot = readInitialSnapshot({
                authorityDir,
                sessionId: derived.sessionId,
                workspaceId: derived.workspaceId,
                workspaceRoot,
            });
        } else {
            // Verify current Git baseline before any model call
            const ws = resolveWorkspace(workspaceRoot, gitRunner);
            let canonicalWsRoot;
            try {
                canonicalWsRoot = fs.realpathSync.native(workspaceRoot);
            } catch {
                canonicalWsRoot = path.resolve(workspaceRoot);
            }
            if (ws.repoRoot !== canonicalWsRoot) {
                const err = new Error(`DUAL_BASE_COMMIT_STALE: Git root mismatch (${ws.repoRoot} !== ${canonicalWsRoot})`);
                err.code = 'DUAL_BASE_COMMIT_STALE';
                throw err;
            }
            if (ws.head !== currentBaseline.id) {
                const err = new Error(`DUAL_BASE_COMMIT_STALE: Current Git HEAD (${ws.head}) does not match derived baseline (${currentBaseline.id})`);
                err.code = 'DUAL_BASE_COMMIT_STALE';
                throw err;
            }
        }

        // Strict registered task input validation
        if (!task.owner || task.owner !== 'agy') {
            throw new Error(`Task ${taskId} owner is '${task.owner}', expected 'agy'`);
        }
        const taskRisk = typeof task.risk === 'string' ? task.risk.toLowerCase() : task.risk;
        if (taskRisk && taskRisk !== 'low') {
            throw new Error(`Task ${taskId} has residual non-low risk '${task.risk}'`);
        }

        const goal = task.goal || task.title;
        if (!goal || typeof goal !== 'string' || !goal.trim()) {
            throw new Error(`Task ${taskId} is missing a non-empty goal/title`);
        }

        if (!Array.isArray(task.allowed_files) || task.allowed_files.length === 0) {
            throw new Error(`Task ${taskId} is missing non-empty allowed_files`);
        }
        for (const file of task.allowed_files) {
            if (typeof file !== 'string' || !file.trim()) {
                throw new Error(`Task ${taskId} has invalid allowed_file`);
            }
            normalizeRepoPath(workspaceRoot, file);
        }
        const allowedFiles = task.allowed_files;

        if (!Array.isArray(task.validation_commands) || task.validation_commands.length === 0) {
            throw new Error(`Task ${taskId} is missing non-empty validation_commands`);
        }
        for (const cmd of task.validation_commands) {
            if (typeof cmd === 'string') {
                throw new Error('String validation commands are forbidden; use typed { program, args, cwd }');
            }
            if (!cmd || typeof cmd !== 'object' || typeof cmd.program !== 'string' || !cmd.program.trim()) {
                throw new Error('Validation command must be a typed object with non-empty program');
            }
            if (!Array.isArray(cmd.args) || !cmd.args.every((a) => typeof a === 'string')) {
                throw new Error('Validation command must contain an explicit args array of strings');
            }
            if (typeof cmd.cwd !== 'string' || !cmd.cwd.trim()) {
                throw new Error('Validation command must contain an explicit repo-relative cwd string');
            }
            if (cmd.cwd !== '.') {
                normalizeRepoPath(workspaceRoot, cmd.cwd);
            }
        }
        const validationCmds = task.validation_commands.map((cmd) => ({
            program: cmd.program,
            args: cmd.args,
            cwd: cmd.cwd,
        }));

        if (!Array.isArray(task.deny_patterns)) {
            throw new Error(`Task ${taskId} is missing an explicit deny_patterns array`);
        }
        for (const pattern of task.deny_patterns) {
            if (typeof pattern !== 'string') {
                throw new Error(`Task ${taskId} has invalid deny_pattern`);
            }
        }
        const denyPatterns = task.deny_patterns;
        const riskFlags = [];

        // Validate the task contract before capability evidence so malformed task
        // diagnostics remain precise. Capability is still required before leases or
        // any AGY subprocess/model phase.
        let authoritativeDerived;
        try {
            authoritativeDerived = authorityStore.derive();
        } catch (cause) {
            const err = new Error(`DUAL_AUTHORITY_CAPABILITY_INVALID: Unable to derive authoritative capability evidence: ${cause.message}`);
            err.code = 'DUAL_AUTHORITY_CAPABILITY_INVALID';
            throw err;
        }
        if (!authoritativeDerived?.sessionId) {
            const err = new Error('DUAL_AUTHORITY_CAPABILITY_INVALID: Authority ledger has no initialized session');
            err.code = 'DUAL_AUTHORITY_CAPABILITY_INVALID';
            throw err;
        }
        if (
            derived.sessionId !== authoritativeDerived.sessionId ||
            derived.workspaceId !== authoritativeDerived.workspaceId ||
            derived.planRevision !== authoritativeDerived.planRevision ||
            currentBaseline.kind !== authoritativeDerived.currentBaseline?.kind ||
            currentBaseline.id !== authoritativeDerived.currentBaseline?.id
        ) {
            const err = new Error('DUAL_AUTHORITY_CAPABILITY_INVALID: Caller state does not match hash-chained authority lineage');
            err.code = 'DUAL_AUTHORITY_CAPABILITY_INVALID';
            throw err;
        }

        if (!authoritativeDerived.capability) {
            const err = new Error('DUAL_AUTHORITY_CAPABILITY_INVALID: Authoritative capability evidence is missing in derived state');
            err.code = 'DUAL_AUTHORITY_CAPABILITY_INVALID';
            throw err;
        }

        const cap = authoritativeDerived.capability;
        const toState = cap.to_state || cap.toState;
        if (cap.status !== 'PASSED' || toState !== 'CAPABILITY_SAFE') {
            const err = new Error(`DUAL_AUTHORITY_CAPABILITY_INVALID: Authoritative capability status is '${cap.status}', expected 'PASSED' (to_state '${toState}')`);
            err.code = 'DUAL_AUTHORITY_CAPABILITY_INVALID';
            throw err;
        }

        const agyCheck = Array.isArray(cap.checks) && cap.checks.find((c) => c.name === 'agy_cli_and_model');
        if (!agyCheck || agyCheck.status !== 'PASSED') {
            const err = new Error('DUAL_AUTHORITY_CAPABILITY_INVALID: Authoritative agy_cli_and_model check did not PASS');
            err.code = 'DUAL_AUTHORITY_CAPABILITY_INVALID';
            throw err;
        }

        const authDetails = cap.details || {};
        const authVersion = authDetails.agy_version || authDetails.agy_cli_version || authDetails.agy_evidence?.version;
        const authModel = authDetails.agy_model || authDetails.agy_evidence?.model;
        if (typeof authVersion !== 'string' || !authVersion.trim()) {
            const err = new Error('DUAL_AUTHORITY_CAPABILITY_INVALID: Authoritative capability evidence missing actual non-empty version');
            err.code = 'DUAL_AUTHORITY_CAPABILITY_INVALID';
            throw err;
        }
        if (authModel !== 'gemini-3.7-flash-high') {
            const err = new Error(`DUAL_AUTHORITY_CAPABILITY_INVALID: Authoritative model '${authModel}' is not exact gemini-3.7-flash-high`);
            err.code = 'DUAL_AUTHORITY_CAPABILITY_INVALID';
            throw err;
        }

        const taskOrchestrator = createDualOrchestrator({
            cwd: workspaceRoot,
            backend: isSnapshot ? 'snapshot' : 'git',
            initialSnapshot,
            gitRunner,
            agyCommand,
            agyPrefixArgs,
            processRunner,
            clock,
            authoritativeCapabilityEvidence: {
                version: authVersion.trim(),
                model: 'gemini-3.7-flash-high',
            },
        });

        // Acquire lease
        let lease;
        try {
            lease = authorityStore.acquireLease(taskId, 'agy');
        } catch (err) {
            return { taskId, skipped: true, reason: err.message };
        }

        let leaseHeartbeatError = null;
        const leaseHeartbeat = setIntervalFn(() => {
            if (leaseHeartbeatError) return;
            try {
                authorityStore.renewLease(lease.lease_id);
            } catch (err) {
                leaseHeartbeatError = err;
            }
        }, leaseHeartbeatMs);
        if (leaseHeartbeat && typeof leaseHeartbeat.unref === 'function') {
            leaseHeartbeat.unref();
        }

        const taskRunDir = path.join(workspaceRoot, '.omni', 'codex-gemini', 'runs', taskId);
        const eventsPath = path.join(taskRunDir, 'events.ndjson');

        try {
            // Validate existing artifacts before reuse; clean stale run directory if from a different session baseline
            const specPath = path.join(taskRunDir, 'spec.json');
            if (fs.existsSync(specPath)) {
                let existingSpec;
                let specBaseline;
                try {
                    existingSpec = parseContract(SpecSchema, JSON.parse(fs.readFileSync(specPath, 'utf8')), 'existing spec');
                    specBaseline = normalizeBaselineCorrelation(existingSpec);
                } catch {
                    fs.rmSync(taskRunDir, { recursive: true, force: true });
                    existingSpec = null;
                }

                if (existingSpec) {
                    if (specBaseline.kind !== currentBaseline.kind || specBaseline.id !== currentBaseline.id) {
                        // Leftover artifact from previous session baseline; reset taskRunDir for fresh execution
                        fs.rmSync(taskRunDir, { recursive: true, force: true });
                    } else {
                        if (existingSpec.task_id !== taskId) {
                            throw new Error(`Existing spec.json correlation failure for task ${taskId}`);
                        }
                        if (existingSpec.goal !== goal) {
                            throw new Error(`Existing spec.json goal mismatch for task ${taskId}`);
                        }
                        if (JSON.stringify(existingSpec.allowed_files) !== JSON.stringify(allowedFiles)) {
                            throw new Error(`Existing spec.json allowed_files mismatch for task ${taskId}`);
                        }
                        if (JSON.stringify(existingSpec.deny_patterns) !== JSON.stringify(denyPatterns)) {
                            throw new Error(`Existing spec.json deny_patterns mismatch for task ${taskId}`);
                        }
                        if (existingSpec.validation_commands.length !== validationCmds.length) {
                            throw new Error(`Existing spec.json validation_commands length mismatch for task ${taskId}`);
                        }
                        for (let i = 0; i < validationCmds.length; i++) {
                            const evc = existingSpec.validation_commands[i];
                            const tvc = validationCmds[i];
                            if (evc.program !== tvc.program || JSON.stringify(evc.args) !== JSON.stringify(tvc.args) || evc.cwd !== tvc.cwd) {
                                throw new Error(`Existing spec.json validation_commands mismatch at index ${i} for task ${taskId}`);
                            }
                        }
                        if (JSON.stringify(existingSpec.risk_flags) !== JSON.stringify(riskFlags)) {
                            throw new Error(`Existing spec.json risk_flags mismatch for task ${taskId}`);
                        }
                        if (existingSpec.permission_authority !== 'dual-init-dangerous-auto-v1') {
                            throw new Error(`Existing spec.json permission_authority mismatch for task ${taskId}`);
                        }
                    }
                }
            }

            if (fs.existsSync(eventsPath)) {
                const rawEvents = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
                for (const ev of rawEvents) {
                    parseContract(EventSchema, ev, 'existing event log');
                    const evBaseline = normalizeBaselineCorrelation(ev);
                    if (evBaseline.kind !== currentBaseline.kind || evBaseline.id !== currentBaseline.id) {
                        fs.rmSync(taskRunDir, { recursive: true, force: true });
                        break;
                    }
                }
            }

            // Initialize task in orchestrator if needed
            if (!fs.existsSync(eventsPath)) {
                taskOrchestrator.newTask(taskId);
            }

            // Ensure spec.json is written with exact registered task info
            if (!fs.existsSync(specPath)) {
                const specPayload = {
                    schema_version: 1,
                    task_id: taskId,
                    ...emitBaselineCorrelation(currentBaseline),
                    goal: goal,
                    allowed_files: allowedFiles,
                    deny_patterns: denyPatterns,
                    validation_commands: validationCmds,
                    risk_flags: riskFlags,
                    permission_authority: 'dual-init-dangerous-auto-v1',
                };
                parseContract(SpecSchema, specPayload, 'spec');
                fs.mkdirSync(taskRunDir, { recursive: true });
                fs.writeFileSync(specPath, JSON.stringify(specPayload, null, 2) + '\n', 'utf8');
            }

            // Run through orchestrator phases (scout -> spec -> route -> implement -> scope -> review)
            const orchResult = await taskOrchestrator.run(taskId);
            if (leaseHeartbeatError) {
                throw new Error(`Lease heartbeat failed for task ${taskId}: ${leaseHeartbeatError.message}`);
            }

            // If successful (reached CODEX_QC or REVIEW_VALID), validate all artifacts strictly
            if (orchResult && (orchResult.state === 'CODEX_QC' || orchResult.state === 'REVIEW_VALID')) {
                const contextPath = path.join(taskRunDir, 'context.json');
                if (!fs.existsSync(contextPath)) {
                    throw new Error(`context.json missing for task ${taskId}`);
                }
                const rawContext = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
                const parsedContext = parseContract(ContextSchema, rawContext, 'context');
                const contextBase = normalizeBaselineCorrelation(parsedContext);
                if (
                    parsedContext.task_id !== taskId ||
                    contextBase.kind !== currentBaseline.kind ||
                    contextBase.id !== currentBaseline.id
                ) {
                    throw new Error(`context.json correlation error for task ${taskId}`);
                }

                const routePath = path.join(taskRunDir, 'route.json');
                if (!fs.existsSync(routePath)) {
                    throw new Error(`route.json missing for task ${taskId}`);
                }
                const rawRoute = JSON.parse(fs.readFileSync(routePath, 'utf8'));
                const parsedRoute = parseContract(RouteSchema, rawRoute, 'route');
                const routeBase = normalizeBaselineCorrelation(parsedRoute);
                if (
                    parsedRoute.task_id !== taskId ||
                    routeBase.kind !== currentBaseline.kind ||
                    routeBase.id !== currentBaseline.id ||
                    parsedRoute.owner !== 'gemini' ||
                    parsedRoute.model !== 'gemini-3.7-flash-high' ||
                    parsedRoute.effort !== 'high'
                ) {
                    throw new Error(`route.json validation failure for task ${taskId}`);
                }
                if (JSON.stringify(parsedRoute.allowed_files) !== JSON.stringify(allowedFiles)) {
                    throw new Error(`route.json allowed_files mismatch for task ${taskId}`);
                }

                const evidencePath = path.join(taskRunDir, 'evidence.json');
                if (!fs.existsSync(evidencePath)) {
                    throw new Error(`evidence.json missing for task ${taskId}`);
                }
                const rawEvidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
                const parsedEvidence = parseContract(EvidenceSchema, rawEvidence, 'evidence');
                const evidenceBase = normalizeBaselineCorrelation(parsedEvidence);
                if (
                    parsedEvidence.task_id !== taskId ||
                    evidenceBase.kind !== currentBaseline.kind ||
                    evidenceBase.id !== currentBaseline.id ||
                    parsedEvidence.status !== 'SUCCESS'
                ) {
                    throw new Error(`evidence.json invalid or not SUCCESS for task ${taskId}`);
                }
                if (!Array.isArray(parsedEvidence.command_outputs) || parsedEvidence.command_outputs.length === 0) {
                    throw new Error(`evidence.json command_outputs must be non-empty for task ${taskId}`);
                }
                for (const cmd of parsedEvidence.command_outputs) {
                    if (typeof cmd.exit_code !== 'number' || cmd.exit_code !== 0) {
                        throw new Error(`evidence.json command '${cmd.command}' exited non-zero (${cmd.exit_code})`);
                    }
                }

                const reviewPath = path.join(taskRunDir, 'review.json');
                if (!fs.existsSync(reviewPath)) {
                    throw new Error(`review.json missing for task ${taskId}`);
                }
                const rawReview = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
                const parsedReview = parseContract(ReviewSchema, rawReview, 'review');
                const reviewBase = normalizeBaselineCorrelation(parsedReview);
                if (
                    parsedReview.task_id !== taskId ||
                    reviewBase.kind !== currentBaseline.kind ||
                    reviewBase.id !== currentBaseline.id ||
                    parsedReview.recommendation !== 'APPROVE'
                ) {
                    authorityStore.releaseLease(lease.lease_id, `review_recommendation_${parsedReview.recommendation}`);
                    return { taskId, status: 'FAILED_REVIEW', recommendation: parsedReview.recommendation, orchResult };
                }

                if (!fs.existsSync(eventsPath)) {
                    throw new Error(`events.ndjson missing for task ${taskId}`);
                }
                const eventLines = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean);
                const parsedEvents = [];
                for (const line of eventLines) {
                    parsedEvents.push(parseContract(EventSchema, JSON.parse(line), 'event log'));
                }
                validateEventSequence(parsedEvents, taskId, currentBaseline);
                validatePhaseArtifactHashes(taskRunDir, parsedEvents);

                const relativeRunDir = path.relative(workspaceRoot, taskRunDir).replace(/\\/g, '/');

                let diffInfo;
                if (isSnapshot) {
                    const {
                        baseline: snapBaseline,
                        excludedPaths: configuredExcludedPaths,
                    } = createConfiguredSnapshotBaseline({ root: workspaceRoot });
                    diffInfo = snapBaseline.fingerprint(initialSnapshot.identity, initialSnapshot.manifest, {
                        excludedPaths: [...configuredExcludedPaths, relativeRunDir],
                    });
                } else {
                    diffInfo = captureDiffFingerprint({
                        repoRoot: workspaceRoot,
                        baseCommit: currentBaseline.id,
                        excludedPaths: [relativeRunDir],
                        execGit: gitRunner,
                    });
                }

                const measuredFilesSorted = [...diffInfo.files].sort();
                const evidenceFilesSorted = [...parsedEvidence.modified_files].sort();
                if (
                    measuredFilesSorted.length !== evidenceFilesSorted.length ||
                    !measuredFilesSorted.every((f, i) => f === evidenceFilesSorted[i])
                ) {
                    throw new Error(`evidence.json modified_files do not match measured diff files for task ${taskId}`);
                }

                // Task successfully finished AGY phases; release lease and leave awaiting Codex QC
                authorityStore.releaseLease(lease.lease_id, 'agy_reviewed_awaiting_codex_qc');
                return {
                    taskId,
                    status: 'AWAITING_CODEX_QC',
                    diffFingerprint: diffInfo.patchSha256,
                    modifiedFiles: diffInfo.files,
                    orchResult,
                };
            } else {
                authorityStore.releaseLease(lease.lease_id, 'task_incomplete');
                return { taskId, status: 'INCOMPLETE', orchResult };
            }
        } catch (err) {
            if (lease) {
                try {
                    authorityStore.releaseLease(lease.lease_id, `error: ${err.message}`);
                } catch (releaseErr) {
                    throw new Error(`Execution error: ${err.message}; lease release also failed: ${releaseErr.message}`);
                }
            }
            throw err;
        } finally {
            clearIntervalFn(leaseHeartbeat);
        }
    }

    return {
        runTask,
        executeAgyTask,
    };
}

module.exports = {
    createOrchestratorAdapter,
};
