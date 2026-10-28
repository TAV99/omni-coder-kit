'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareTaskWorkspace, collectTaskResultAsync, readTaskBinding, validateTaskPath } = require('./task-workspace');
const { resolveConfiguredWorkerModel, resolveConfiguredWorkerEffort, workerConfigurationError } = require('./agy-model');
const { createDualOrchestrator } = require('./orchestrator');
const { createStateStore } = require('./state-store');
const { createConfiguredSnapshotBaseline } = require('./snapshot-policy');
const { runProcess } = require('./agy-runner');
const { createArtifactStore } = require('./artifacts');
const { preparePrivateDependencies, verifyPrivateDependenciesAsync } = require('./private-dependencies');
const { ContextSchema, SpecSchema, RouteSchema, EventSchema, EvidenceSchema, ReviewSchema, parseContract, normalizeBaselineCorrelation,
    validateEventSequence, validatePhaseArtifactHashes } = require('./contracts');

function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    if (code === 'DUAL_ISOLATED_DISCUSSION_FACTORY_REQUIRED') error.category = 'PRECONDITION';
    if (code === 'DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID') error.category = 'TERMINAL';
    if (error.category) error.kind = error.category;
    throw error;
}

function validateRuntime(workerRoot, relativeRunDir) {
    let count = 0;
    function visit(file, depth) {
        if (++count > 2000 || depth > 8) fail('DUAL_ISOLATED_RUNTIME_INVALID', 'Worker runtime exceeds inspection bounds');
        validateTaskPath(workerRoot, file);
        const absolute = path.join(workerRoot, file);
        if (!fs.existsSync(absolute)) return;
        const stat = fs.lstatSync(absolute);
        if (stat.isDirectory()) {
            for (const child of fs.readdirSync(absolute)) visit(`${file}/${child}`, depth + 1);
        } else if (!stat.isFile()) fail('DUAL_ISOLATED_RUNTIME_INVALID', 'Worker runtime requires regular files');
    }
    visit(relativeRunDir, 0);
}

function normalizeCommandString(raw) {
    return String(raw || '')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/\b(npm|pnpm|yarn|bun|npx|node)\.(cmd|exe|bat)\b/gi, '$1')
        .replace(/\b(npm|pnpm|yarn|bun)\s+run\s+test\b/gi, '$1 test');
}

// The authority adapter owns leases and must supply a guard backed by its live
// ledger. This runner never integrates source or self-certifies Codex QC.
async function runIsolatedTask(options) {
    const { workspaceRoot, sessionId, attempt, planRevision, task, capability, authorize,
        agyCommand = 'agy', agyPrefixArgs = [], processRunner = runProcess } = options;
    const guard = () => {
        if (typeof authorize !== 'function' || authorize({ sessionId, taskId: task?.task_id, planRevision }) !== true) {
            fail('DUAL_ISOLATED_UNAUTHORIZED', 'Current controller task authority is required');
        }
    };
    guard();
    if (!Array.isArray(agyPrefixArgs) || agyPrefixArgs.some((arg) => typeof arg !== 'string' || arg.startsWith('-'))) {
        fail('DUAL_ISOLATED_PROJECT_UNSAFE', 'Isolated workers cannot inherit project, conversation or directory flags');
    }
    if (!capability || typeof capability.version !== 'string' || !capability.version.trim()
        || typeof capability.model !== 'string' || !capability.model.trim()) {
        fail('DUAL_ISOLATED_CAPABILITY_INVALID', 'Verified worker version and model are required');
    }
    const workerModel = resolveConfiguredWorkerModel(workspaceRoot, { model: task.model });
    const workerEffort = resolveConfiguredWorkerEffort(workspaceRoot, { effort: task.effort });
    const configurationError = workerConfigurationError(workerModel, workerEffort);
    if (configurationError) fail('DUAL_WORKER_CONFIG_MISSING', configurationError);
    if (capability.model.trim() !== workerModel) {
        fail('DUAL_ISOLATED_CAPABILITY_INVALID', 'Verified capability model differs from configured worker model');
    }
    const spec = parseContract(SpecSchema, {
        schema_version: 1, task_id: task.task_id, expected_baseline: { kind: 'snapshot', id: '0'.repeat(64) },
        goal: task.goal, allowed_files: task.allowed_files, generated_outputs: task.generated_outputs || [], context_files: task.context_files || [],
        ...(task.dependency_mode ? { dependency_mode: task.dependency_mode } : {}),
        deny_patterns: task.deny_patterns, validation_commands: task.validation_commands,
        ...(task.behavior_commands !== undefined ? { behavior_commands: task.behavior_commands } : {}),
        ...(task.qc_evidence !== undefined ? { qc_evidence: task.qc_evidence } : {}),
        risk_flags: task.risk_flags || [], permission_authority: 'dual-init-dangerous-auto-v1',
        ...(task.correction ? { correction_context: { attempt: task.correction.attempt, reason: task.correction.reason,
            previous_binding_sha256: task.correction.previous_binding_sha256, outcome_code: task.correction.outcome_code } } : {}),
    }, 'isolated registered task');
    const prepareWorkspace = task.revision_id ? require('./task-revision-integration').prepareRevisionWorkspace : prepareTaskWorkspace;
    const prepared = options.reference || prepareWorkspace({ workspaceRoot, sessionId, taskId: task.task_id, attempt, planRevision,
        ...(task.revision_id ? { revisionId: task.revision_id, contractDigest: task.contract_sha256,
            expectedSourceFingerprint: task.source_fingerprint } : {}),
        allowedFiles: spec.allowed_files, generatedOutputs: spec.generated_outputs || [], contextFiles: spec.context_files, denyPatterns: spec.deny_patterns,
        managedRuntime: true, dependencyMode: task.dependency_mode });
    let verifiedBinding;
    try { verifiedBinding = readTaskBinding(workspaceRoot, prepared); }
    catch (error) {
        if (error.code === 'DUAL_TASK_BINDING_INVALID') {
            fail('DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID', 'Task binding differs from the authority reference');
        }
        throw error;
    }
    const { binding, workerRoot: boundRoot } = verifiedBinding;
    const workerRoot = fs.realpathSync.native(boundRoot);
    if (prepared.workerRoot) {
        let referenceRoot;
        try { referenceRoot = fs.realpathSync.native(prepared.workerRoot); }
        catch { fail('DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID', 'Authority worker root cannot be canonicalized'); }
        if (referenceRoot !== workerRoot) {
            fail('DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID', 'Worker root differs from the authority reference');
        }
    }
    if (binding.revisionId !== task.revision_id || binding.contractDigest !== task.contract_sha256
        || binding.sessionId !== sessionId || binding.taskId !== task.task_id || binding.attempt !== attempt
        || binding.planRevision !== planRevision || binding.runtimePath !== `.omni/codex-gemini/runs/${task.task_id}`
        || (binding.dependencyMode || 'none') !== (task.dependency_mode || 'none')
        || JSON.stringify(binding.allowedFiles) !== JSON.stringify(spec.allowed_files)
        || JSON.stringify(binding.generated_outputs || []) !== JSON.stringify(spec.generated_outputs || [])
        || JSON.stringify(binding.contextFiles) !== JSON.stringify(spec.context_files)
        || JSON.stringify(binding.denyPatterns) !== JSON.stringify(spec.deny_patterns)) {
        fail('DUAL_ISOLATED_WORKSPACE_MISMATCH', 'Private workspace binding does not match registered task');
    }
    const reference = { bindingPath: prepared.bindingPath, bindingSha256: prepared.bindingSha256, workerRoot,
        ...(prepared.workerBaselineSha256 ? { workerBaselineSha256: prepared.workerBaselineSha256 } : {}),
        ...(prepared.workerContractSha256 ? { workerContractSha256: prepared.workerContractSha256 } : {}),
        ...(prepared.workerDependencies ? { workerDependencies: prepared.workerDependencies } : {}) };
    const attemptDir = path.dirname(path.join(workspaceRoot, reference.bindingPath));
    const attemptArtifacts = createArtifactStore(attemptDir);
    const baselinePath = path.join(attemptDir, 'worker-baseline.json');
    let initialSnapshot;
    if (options.reference) {
        validateTaskPath(workspaceRoot, path.relative(workspaceRoot, baselinePath).replace(/\\/g, '/'));
        const bytes = fs.readFileSync(baselinePath);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== reference.workerBaselineSha256) {
            fail('DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID', 'Private baseline does not match saved controller reference');
        }
        initialSnapshot = JSON.parse(bytes.toString('utf8'));
    } else {
        initialSnapshot = createConfiguredSnapshotBaseline({ root: workerRoot }).baseline.capture();
        reference.workerBaselineSha256 = attemptArtifacts.writeJsonImmutable('worker-baseline.json', initialSnapshot).sha256;
    }
    spec.expected_baseline = initialSnapshot.identity;
    const workerContract = { schema_version: 1, spec,
        capability: { version: capability.version.trim(), model: capability.model.trim(), effort: workerEffort } };
    const contractPath = path.join(attemptDir, 'worker-contract.json');
    if (options.reference) {
        validateTaskPath(workspaceRoot, path.relative(workspaceRoot, contractPath).replace(/\\/g, '/'));
        const bytes = fs.readFileSync(contractPath);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== reference.workerContractSha256) {
            fail('DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID', 'Worker contract differs from the authority reference');
        }
        if (JSON.stringify(JSON.parse(bytes.toString('utf8'))) !== JSON.stringify(workerContract)) {
            fail('DUAL_SPEC_CORRELATION', 'Prepared task or model changed before resume');
        }
    } else reference.workerContractSha256 = attemptArtifacts.writeJsonImmutable('worker-contract.json', workerContract).sha256;
    const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(workerRoot).replace(/\\/g, '/') };
    for (const name of Object.keys(env)) {
        if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'].includes(name.toUpperCase())) delete env[name];
    }
    if (options.onPrepared) await options.onPrepared(reference);
    if (task.dependency_mode === 'npm-ci') {
        const deps = await preparePrivateDependencies({ workerRoot, artifactRoot: attemptDir, authorize: () => { guard(); return true; },
            mode: 'npm-ci', reference: reference.workerDependencies, env, spawnImpl: options.spawn, onTick: guard, signal: options.signal });
        reference.workerDependencies = { mode: deps.mode, receiptPath: deps.receiptPath, receiptSha256: deps.receiptSha256 };
        if (options.onDependenciesPrepared) await options.onDependenciesPrepared(reference.workerDependencies);
    }
    const relativeRunDir = `.omni/codex-gemini/runs/${task.task_id}`;
    let expectedReplyBytes = null;
    const validateReplies = () => {
        if (expectedReplyBytes === null && fs.existsSync(path.join(workerRoot, relativeRunDir, 'controller-context.json'))) {
            fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Worker cannot invent controller clarification');
        }
        if (expectedReplyBytes !== null && fs.readFileSync(path.join(workerRoot, relativeRunDir, 'controller-context.json'), 'utf8') !== expectedReplyBytes) {
            fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Worker changed controller clarification data');
        }
    };
    // Restore the exact controller-owned context before a resumed generation seeds.
    const savedReplyPath = path.join(workerRoot, relativeRunDir, 'controller-context.json');
    if (fs.existsSync(savedReplyPath) && options.controllerReplies?.length) {
        expectedReplyBytes = `${JSON.stringify({ task_id: task.task_id, plan_revision: planRevision,
            replies: options.controllerReplies }, null, 2)}\n`;
    }
    let guardFailure;
    const executionController = new AbortController();
    const signal = options.signal ?? executionController.signal;
    const check = async (context = {}) => {
        if (guardFailure) throw guardFailure;
        try {
            guard();
            if (signal.aborted) {
                const error = new Error('Isolated execution aborted', { cause: signal.reason });
                error.code = 'ABORT_ERR';
                throw error;
            }
            if (context.cwd && fs.realpathSync.native(context.cwd) !== workerRoot) {
                fail('DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID', 'Discussion cwd differs from the worker');
            }
            const current = readTaskBinding(workspaceRoot, reference);
            if (fs.realpathSync.native(current.workerRoot) !== workerRoot) {
                fail('DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID', 'Worker root was redirected');
            }
            for (const [file, hash] of [[baselinePath, reference.workerBaselineSha256],
                [contractPath, reference.workerContractSha256]]) {
                validateTaskPath(workspaceRoot, path.relative(workspaceRoot, file).replace(/\\/g, '/'));
                if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== hash) {
                    fail('DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID', 'Execution reference evidence changed');
                }
            }
            validateRuntime(workerRoot, relativeRunDir);
            validateReplies();
            if (reference.workerDependencies) await verifyPrivateDependenciesAsync({ workerRoot,
                artifactRoot: attemptDir, reference: reference.workerDependencies, onTick: guard, signal });
        } catch (error) { guardFailure = error; throw error; }
    };
    const bracket = (operation) => async (...args) => {
        await check();
        let originalError;
        try { return await operation(...args); }
        catch (error) { originalError = error; throw error; }
        finally {
            try { await check(); }
            catch (error) {
                if (originalError) originalError.guardDiagnostic = { code: error.code, message: error.message };
                else throw error;
            }
        }
    };
    guard();
    validateRuntime(workerRoot, relativeRunDir);
    let child;
    let executionError;
    try {
    if (options.discussion?.enabled === true) {
        if (typeof options.discussion.createIsolatedDiscussion !== 'function') {
            fail('DUAL_ISOLATED_DISCUSSION_FACTORY_REQUIRED', 'Isolated discussion requires an execution factory');
        }
        await check();
        child = await options.discussion.createIsolatedDiscussion({ workerRoot, reference,
            workerBaselineId: initialSnapshot.identity.id, workerContractSha256: reference.workerContractSha256,
            sessionId, taskId: task.task_id, planRevision, attempt, leaseId: options.leaseId,
            operationId: options.operationId, authorize, capability, workerModel, workerEffort,
            guards: { check, wrapSeed: bracket }, prespawnGuard: check, env,
            spawnImpl: options.spawnImpl ?? options.spawn, signal });
        if (child?.enabled !== true || typeof child.sessionResolver !== 'function' || typeof child.close !== 'function') {
            fail('DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID', 'Factory did not supply an isolated execution handle');
        }
        await check();
    }
    const discussion = child ? { enabled: true, sessionResolver: bracket(async (context) => {
        const session = await child.sessionResolver(context);
        const relay = { ...session.relay };
        for (const method of ['receive', 'dispatch', 'reconcile', 'inspect']) {
            relay[method] = bracket((...args) => session.relay[method](...args));
        }
        return { ...session, relay };
    }) } : options.discussion;
    const orchestrator = createDualOrchestrator({
        coverageRoot: workspaceRoot, coverageContext: options.coverageContext || (() => ({ plan: options.plan, session_id: sessionId, baseline: options.coverageBaseline })),
        cwd: workerRoot, backend: 'snapshot', initialSnapshot, env, agyCommand, agyPrefixArgs, spawn: options.spawn,
        workerModel, workerEffort, authoritativeCapabilityEvidence: capability, discussion,
        processRunner: async (invocation, deps) => {
            guard();
            if (reference.workerDependencies) await verifyPrivateDependenciesAsync({ workerRoot, artifactRoot: attemptDir, reference: reference.workerDependencies,
                onTick: guard, signal: options.signal });
            validateRuntime(workerRoot, relativeRunDir);
            validateReplies();
            if (invocation.cwd !== workerRoot) fail('DUAL_ISOLATED_WORKSPACE_MISMATCH', 'Worker cwd changed');
            const result = await processRunner(invocation, deps);
            validateRuntime(workerRoot, relativeRunDir);
            validateReplies();
            guard();
            return result;
        },
    });
    const runDir = path.join(workerRoot, relativeRunDir);
    if (!fs.existsSync(path.join(runDir, 'events.ndjson'))) {
        orchestrator.newTask(task.task_id);
    } else {
        const resumeStore = createStateStore(runDir, { taskId: task.task_id, expectedBaseline: initialSnapshot.identity });
        for (const phase of resumeStore.activeAttempts().keys()) {
            resumeStore.settleOrphanedAttempt(phase);
        }
    }
    const artifacts = createArtifactStore(runDir);
    if (fs.existsSync(path.join(runDir, 'spec.json'))) {
        const saved = parseContract(SpecSchema, JSON.parse(fs.readFileSync(path.join(runDir, 'spec.json'), 'utf8')), 'saved isolated spec');
        if (JSON.stringify(saved) !== JSON.stringify(spec)) fail('DUAL_SPEC_CORRELATION', 'Isolated spec changed before resume');
    } else artifacts.writeJsonImmutable('spec.json', spec);
    const state = orchestrator.status(task.task_id).state;
    if (state === 'NEW') await orchestrator.runPhase('preflight', task.task_id);
    if (['NEW', 'PREFLIGHT_SAFE'].includes(state)) await orchestrator.runPhase('scout', task.task_id);
    const scoutPath = path.join(runDir, 'context.json');
    const scout = parseContract(ContextSchema, JSON.parse(fs.readFileSync(scoutPath, 'utf8')), 'isolated scout');
    const scoutBaseline = normalizeBaselineCorrelation(scout);
    if (scout.task_id !== task.task_id || scoutBaseline.id !== initialSnapshot.identity.id || scoutBaseline.kind !== 'snapshot') {
        fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Scout does not match private task baseline');
    }
    // Reconnaissance is explicitly read-only and stops before spec routing or implementation.
    if (options.reconnaissanceOnly === true) return { status: 'SCOUT_VALID', reference, scout };
    const questions = scout.open_questions;
    if (options.expectedQuestions && JSON.stringify(options.expectedQuestions) !== JSON.stringify(questions)) {
        fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Scout questions changed after authority recorded them');
    }
    if (questions.length > 20 || questions.some((question) => !question.trim() || question.length > 4096)) {
        fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Scout questions exceed supported bounds');
    }
    const replies = options.controllerReplies || [];
    if (!Array.isArray(replies) || replies.length > 20 || replies.some((reply) => !reply
        || typeof reply.question !== 'string' || typeof reply.answer !== 'string'
        || !reply.answer.trim() || reply.answer.length > 4096 || !questions.includes(reply.question))) {
        fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Controller replies must be bounded answers to scout questions');
    }
    if (questions.some((question) => !replies.some((reply) => reply.question === question))) {
        return { status: 'NEEDS_CONTEXT', reference, questions };
    }
    if (questions.length) {
        const replyPayload = { task_id: task.task_id, plan_revision: planRevision, replies };
        expectedReplyBytes = `${JSON.stringify(replyPayload, null, 2)}\n`;
        const replyPath = path.join(runDir, 'controller-context.json');
        if (fs.existsSync(replyPath)) {
            if (JSON.stringify(JSON.parse(fs.readFileSync(replyPath, 'utf8'))) !== JSON.stringify(replyPayload)) {
                fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Controller context changed after it was consumed');
            }
        } else artifacts.writeJsonImmutable('controller-context.json', replyPayload);
        validateReplies();
    }
    const outcome = await orchestrator.run(task.task_id);
    try { await check(); }
    catch (error) { error.finalizationStage = 'post_worker_collection'; throw error; }
    if (outcome.state !== 'CODEX_QC') {
        return { status: 'NEEDS_CONTROLLER', reference, outcome };
    }
    try {
    const artifactHashes = {};
    for (const file of ['events.ndjson', 'context.json', 'spec.json', 'route.json', 'evidence.json', 'review.json',
        ...(questions.length ? ['controller-context.json'] : []),
        ...(['coverage-input.json', 'decision-log.json'].filter((file) => fs.existsSync(path.join(runDir, file))))]) {
        validateTaskPath(workerRoot, `${relativeRunDir}/${file}`);
        artifactHashes[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(runDir, file))).digest('hex');
    }
    const events = fs.readFileSync(path.join(runDir, 'events.ndjson'), 'utf8').trim().split('\n')
        .map((line) => parseContract(EventSchema, JSON.parse(line), 'isolated phase event'));
    validateEventSequence(events, task.task_id, initialSnapshot.identity);
    validatePhaseArtifactHashes(runDir, events);
    const schemas = { 'context.json': ContextSchema, 'spec.json': SpecSchema, 'route.json': RouteSchema,
        'evidence.json': EvidenceSchema, 'review.json': ReviewSchema };
    const semantic = {};
    for (const [file, schema] of Object.entries(schemas)) {
        const artifact = parseContract(schema, JSON.parse(fs.readFileSync(path.join(runDir, file), 'utf8')), 'isolated artifact');
        const baseline = normalizeBaselineCorrelation(artifact);
        if (artifact.task_id !== task.task_id || baseline.kind !== initialSnapshot.identity.kind || baseline.id !== initialSnapshot.identity.id) {
            fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Worker artifact belongs to another task or baseline');
        }
        semantic[file] = artifact;
    }
    if (JSON.stringify(semantic['spec.json']) !== JSON.stringify(spec)
        || semantic['route.json'].owner !== 'gemini' || semantic['route.json'].model !== workerModel || semantic['route.json'].effort !== workerEffort
        || JSON.stringify(semantic['route.json'].allowed_files) !== JSON.stringify(spec.allowed_files)) {
        fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Worker spec or route does not match registered contract');
    }
    const evidence = semantic['evidence.json'];
    const review = semantic['review.json'];
    if (evidence.status !== 'SUCCESS' || review.recommendation !== 'APPROVE'
        || !evidence.command_outputs || !evidence.command_outputs.length
        || evidence.command_outputs.some((command) => command.exit_code !== 0)
        || spec.validation_commands.some((command) => {
            const expectedCmd = normalizeCommandString(`${command.program} ${command.args.join(' ')}`);
            return !evidence.command_outputs.some((output) => {
                const actualCmd = normalizeCommandString(output.command);
                return actualCmd === expectedCmd || actualCmd === expectedCmd.trim() || actualCmd.endsWith(expectedCmd);
            });
        })) {
        fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Worker evidence is not ready for independent Codex QC');
    }
    let result;
    try { result = await collectTaskResultAsync({ workspaceRoot, reference, onTick: guard, signal: options.signal }); }
    catch (error) { error.finalizationStage = 'post_worker_collection'; throw error; }
    if (JSON.stringify(result.changes.map((change) => change.path).sort()) !== JSON.stringify([...evidence.modified_files].sort())) {
        fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Worker claimed files differ from measured private workspace changes');
    }
    await check();
    const handoff = { schema_version: 1, status: 'AWAITING_CODEX_QC', reference, result,
        workerBaseline: initialSnapshot.identity, artifactPath: relativeRunDir, artifactHashes };
    const handoffFile = path.join(attemptDir, 'worker-handoff.json');
    let stored;
    if (fs.existsSync(handoffFile)) {
        const bytes = fs.readFileSync(handoffFile);
        if (JSON.stringify(JSON.parse(bytes.toString('utf8'))) !== JSON.stringify(handoff)) {
            fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Existing isolated handoff changed');
        }
        stored = { path: handoffFile };
    } else stored = attemptArtifacts.writeJsonImmutable('worker-handoff.json', handoff);
    return { ...handoff, handoffPath: path.relative(workspaceRoot, stored.path).replace(/\\/g, '/'),
        handoffSha256: crypto.createHash('sha256').update(fs.readFileSync(stored.path)).digest('hex') };
    } catch (error) {
        if (error && typeof error === 'object' && !error.finalizationStage) error.finalizationStage = 'post_worker_collection';
        throw error;
    }
    } catch (error) { executionError = error; throw error; }
    finally {
        if (typeof child?.close === 'function') {
            try { await child.close(); }
            catch (error) {
                error.discussionQuiescent = false;
                if (executionError) {
                    executionError.discussionQuiescent = false;
                    executionError.discussionCleanupError = error;
                } else throw error;
            }
        }
    }
}

module.exports = { runIsolatedTask, normalizeCommandString };
