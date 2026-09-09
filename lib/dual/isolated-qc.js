'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readAuthorityHandoffAsync } = require('./isolated-authority');
const { integrateTaskResultAsync } = require('./task-integration');
const { readTaskBinding, validateTaskPath, isExcludedTaskPath } = require('./task-workspace');
const { verifyPrivateDependenciesAsync } = require('./private-dependencies');
const { repoPathKey, repoPathsOverlap } = require('./workspace');
const { resolveSetupInvocation } = require('./setup-runner');
const { createCliResolver } = require('./setup-command');
const { spawnBoundedProcess } = require('./capability-preflight');
const { taskReadiness } = require('./task-scheduler');
const { recordTaskOutcome } = require('./task-correction');
const { createTrackedSpawn, releaseSettledTaskLease } = require('./task-processes');
const { evaluatePreIntegrationReview } = require('./acceptance-policy');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }

function validateIntegrationReceipt(root, task, handoff, derived) {
    const gate = derived.gates[`isolated-qc-${task.task_id}`];
    const receipt = gate?.details?.integration_receipt;
    if (!receipt || gate.status !== 'PASSED' || gate.details.result_sha256 !== handoff.result.resultSha256
        || gate.details.handoff_sha256 !== handoff.handoffSha256) {
        fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Verified task lacks matching integration evidence');
    }
    validateTaskPath(root, receipt);
    let bytes;
    try { bytes = fs.readFileSync(path.join(root, receipt)); }
    catch { fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Verified integration receipt is missing'); }
    if (sha(bytes) !== gate.evidence_sha256) fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Verified integration receipt changed');
}

async function integratedConflicts(root, handoff, history, { onTick, signal } = {}) {
    const files = [];
    const { binding } = readTaskBinding(root, handoff.reference);
    const expected = new Map(binding.contextFiles.map((file) => {
        const original = binding.sourceFiles.find((entry) => entry.path === file);
        return [file, { hash: original.sha256, mode: original.mode }];
    }));
    for (const change of handoff.result.changes) expected.set(change.path, { hash: change.afterSha256, mode: change.afterMode });
    if (history) {
        const completion = history.events.filter((event) => event.type === 'task.completed' && event.task_id === handoff.result.taskId).at(-1);
        if (!completion) fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Verified task lacks its completion event');
        for (const event of history.events) {
            if (event.type !== 'task.completed' || event.sequence <= completion.sequence) continue;
            if (!event.modified_files.some((file) => expected.has(file))) continue;
            const laterTask = history.derived.tasks[event.task_id];
            if (laterTask?.state !== 'TASK_VERIFIED' || laterTask.execution_mode !== 'isolated') {
                fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Later overlapping work lacks verified private evidence');
            }
            const later = await readAuthorityHandoffAsync(root, laterTask, history.derived, { onTick, signal });
            validateIntegrationReceipt(root, laterTask, later, history.derived);
            if (event.diff_fingerprint !== later.result.resultSha256) fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Later completion result mismatch');
            for (const change of later.result.changes) {
                if (!expected.has(change.path)) continue;
                const before = expected.get(change.path);
                if (before.hash !== change.beforeSha256 || before.mode !== change.beforeMode) {
                    fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Accepted overlapping edits do not form a continuous before/after chain');
                }
                expected.set(change.path, { hash: change.afterSha256, mode: change.afterMode });
            }
        }
    }
    for (const [file, original] of expected) {
        validateTaskPath(root, file);
        const target = path.join(root, file);
        if (!fs.existsSync(target)) { if (original.hash !== null) files.push(file); continue; }
        const stat = fs.lstatSync(target);
        if (original.hash === null || !stat.isFile() || (stat.mode & 0o777) !== original.mode
            || sha(fs.readFileSync(target)) !== original.hash) files.push(file);
    }
    return files;
}

function manifestWorker(workerRoot) {
    const root = fs.realpathSync.native ? fs.realpathSync.native(workerRoot) : fs.realpathSync(workerRoot);
    const entries = new Map();
    const failures = [];
    function walk(relative) {
        const absolute = relative ? path.join(root, relative) : root;
        let names;
        try { names = fs.readdirSync(absolute); } catch (error) { failures.push(`read ${relative || '.'}: ${error.message}`); return; }
        for (const name of names) {
            const file = relative ? `${relative}/${name}` : name;
            const target = path.join(root, file);
            let stat;
            try { stat = fs.lstatSync(target); } catch (error) { failures.push(`stat ${file}: ${error.message}`); continue; }
            if (stat.isSymbolicLink()) { failures.push(`symlink/junction rejected: ${file}`); continue; }
            if (stat.isDirectory()) { walk(file); continue; }
            if (!stat.isFile()) { failures.push(`non-regular output rejected: ${file}`); continue; }
            let canonicalFile;
            try { canonicalFile = validateTaskPath(root, file); }
            catch (error) { failures.push(`invalid output path ${file}: ${error.message}`); continue; }
            let bytes;
            try { bytes = fs.readFileSync(target); } catch (error) { failures.push(`read ${file}: ${error.message}`); continue; }
            entries.set(canonicalFile, { path: canonicalFile, sha256: sha(bytes), mode: stat.mode & 0o777, size: bytes.length });
        }
    }
    walk('');
    return { entries, failures };
}

function cleanDeclaredGenerated(workerRoot, generatedPaths, failures) {
    const root = fs.realpathSync.native ? fs.realpathSync.native(workerRoot) : fs.realpathSync(workerRoot);
    for (const relative of generatedPaths) {
        const target = path.join(root, relative);
        const normalized = path.relative(root, target);
        if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) {
            failures.push(`generated output escapes worker root: ${relative}`); continue;
        }
        try {
            const stat = fs.lstatSync(target);
            if (stat.isSymbolicLink()) { failures.push(`generated output is symlink/junction: ${relative}`); continue; }
            fs.rmSync(target, { recursive: true, force: false });
        } catch (error) { failures.push(`cleanup ${relative}: ${error.message}`); }
    }
}

/**
 * Validators may produce only explicitly declared generated outputs. Source and
 * dependency mutations are evidence failures; they are never restored away.
 */
function cleanupEphemeralValidationArtifacts(workerRoot, binding, handoff, options = {}) {
    const before = options.beforeManifest;
    if (!before || !(before.entries instanceof Map) || !Array.isArray(before.failures)) {
        return { ok: false, before: [], after: [], after_cleanup: [], declared_generated_outputs: [], source_mutations: [], dependency_mutations: [], unexpected_outputs: [], failures: ['validator pre-manifest is required'] };
    }
    const declared = new Set([
        ...(binding.generated_outputs || binding.generatedOutputs || []),
    ]);
    const generatedPaths = [];
    const failures = [...before.failures];
    for (const raw of declared) {
        if (typeof raw !== 'string' || !raw || raw.includes('\\') || raw.includes(':') || raw.split('/').some((part) => !part || part === '..')) {
            failures.push(`invalid generated output declaration: ${String(raw)}`); continue;
        }
        try { generatedPaths.push(validateTaskPath(workerRoot, raw.replace(/\/$/, ''))); }
        catch (error) { failures.push(`invalid generated output declaration: ${raw}: ${error.message}`); }
    }
    const after = manifestWorker(workerRoot);
    failures.push(...after.failures);
    const sourcePaths = new Set();
    for (const entry of (binding.sourceFiles || [])) {
        try { sourcePaths.add(validateTaskPath(workerRoot, entry.path)); }
        catch (error) { failures.push(`invalid protected source path: ${entry.path}: ${error.message}`); }
    }
    for (const change of (handoff.result?.changes || [])) {
        if (change.kind !== 'deleted') {
            try { sourcePaths.add(validateTaskPath(workerRoot, change.path)); }
            catch (error) { failures.push(`invalid handed-off source path: ${change.path}: ${error.message}`); }
        }
    }
    const protectedPrefixes = ['node_modules', '.omni', ...(binding.runtimePath ? [binding.runtimePath] : [])];
    for (const generated of generatedPaths) {
        if ([...sourcePaths].some((source) => repoPathsOverlap(generated, source))
            || isExcludedTaskPath(generated)
            || protectedPrefixes.some((prefix) => repoPathsOverlap(generated, prefix))) {
            failures.push(`generated output overlaps protected source/dependency/runtime path: ${generated}`);
        }
    }
    const beforeFiles = before.entries;
    const afterFiles = after.entries;
    const sourceMutations = [], dependencyMutations = [], unexpectedOutputs = [];
    const isGenerated = (file) => generatedPaths.some((prefix) => repoPathsOverlap(file, prefix));
    const isDependency = (file) => repoPathsOverlap(file, 'node_modules');
    const allFiles = new Set([...beforeFiles.keys(), ...afterFiles.keys()]);
    for (const file of allFiles) {
        const oldEntry = beforeFiles.get(file), newEntry = afterFiles.get(file);
        if (oldEntry && newEntry && oldEntry.sha256 === newEntry.sha256 && oldEntry.mode === newEntry.mode) continue;
        if (isDependency(file)) { dependencyMutations.push(file); continue; }
        if ([...sourcePaths].some((source) => repoPathKey(source) === repoPathKey(file))) { sourceMutations.push(file); continue; }
        if (!oldEntry && isGenerated(file)) continue;
        if (!oldEntry || !newEntry) unexpectedOutputs.push(file);
    }
    if (failures.length === 0 && sourceMutations.length === 0 && dependencyMutations.length === 0 && unexpectedOutputs.length === 0) {
        cleanDeclaredGenerated(workerRoot, generatedPaths, failures);
    }
    const afterCleanup = manifestWorker(workerRoot);
    failures.push(...afterCleanup.failures);
    return {
        ok: failures.length === 0 && sourceMutations.length === 0 && dependencyMutations.length === 0 && unexpectedOutputs.length === 0,
        before: [...beforeFiles.values()], after: [...afterFiles.values()], after_cleanup: [...afterCleanup.entries.values()],
        declared_generated_outputs: generatedPaths, source_mutations: sourceMutations,
        dependency_mutations: dependencyMutations, unexpected_outputs: unexpectedOutputs, failures,
    };
}

async function completeIsolatedTask({ workspaceRoot, authorityStore, sessionId, taskId, planRevision, reviewEvidence, signal }) {
    const root = fs.realpathSync.native(workspaceRoot);
    const initial = authorityStore.derive();
    if (initial.sessionId !== sessionId || initial.planRevision !== planRevision
        || fs.realpathSync.native(initial.workspaceRoot) !== root) {
        fail('DUAL_ISOLATED_AUTHORITY_STALE', 'QC request does not match current authority');
    }
    const task = initial.tasks[taskId];
    if (!task || task.execution_mode !== 'isolated' || !task.isolatedHandoff) {
        fail('DUAL_ISOLATED_QC_NOT_READY', 'An isolated handoff is required before Codex QC');
    }
    const heartbeat = () => {
        if (signal?.aborted) fail('DUAL_PRIVATE_SETUP_ABORTED', 'Isolated QC was aborted');
    };
    const handoff = await readAuthorityHandoffAsync(root, task, initial, { onTick: heartbeat, signal });
    if (task.state === 'TASK_VERIFIED') {
        validateIntegrationReceipt(root, task, handoff, initial);
        const files = await integratedConflicts(root, handoff, { derived: initial, events: authorityStore.readEvents() }, { onTick: heartbeat, signal });
        return files.length ? { status: 'CONFLICT', files } : { status: 'TASK_VERIFIED', taskId, alreadyVerified: true };
    }
    if (initial.sessionState !== 'EXECUTING') fail('DUAL_ISOLATED_QC_NOT_READY', 'Session is not executing');
    const readiness = taskReadiness(initial, taskId);
    if (readiness.status !== 'READY') return { taskId, ...readiness };
    // Until per-file reservations land, exclude any other source writer.
    if (Object.values(initial.leases).some((lease) => lease.status !== 'released')) return { status: 'WAITING_FOR_LEASE' };
    const lease = authorityStore.acquireLease(taskId, 'codex');
    authorityStore.append({ schema_version: 2, type: 'task.execution.started', task_id: taskId,
        lease_id: lease.lease_id, controller_pid: process.pid });
    const trackedSpawn = createTrackedSpawn({ authorityStore, taskId, leaseId: lease.lease_id });
    let renewalError;
    const timer = setInterval(() => {
        try { authorityStore.renewLease(lease.lease_id); } catch (error) { renewalError = error; }
    }, 10000);
    timer.unref();
    const guard = () => {
        const now = authorityStore.derive();
        return !renewalError && now.sessionId === sessionId && now.planRevision === planRevision
            && now.sessionState === 'EXECUTING' && now.leases[lease.lease_id]?.status === 'active'
            && JSON.stringify(now.currentBaseline) === JSON.stringify(initial.currentBaseline)
            && JSON.stringify({ ...now.tasks[taskId], executions: undefined }) === JSON.stringify({ ...task, executions: undefined })
            && taskReadiness(now, taskId).status === 'READY'
            && !Object.values(now.leases).some((other) => other.lease_id !== lease.lease_id && other.status !== 'released');
    };
    const commands = [];
    try {
        const workerRoot = handoff.reference.workerRoot;
        if (handoff.reference.workerDependencies) {
            await verifyPrivateDependenciesAsync({
                workerRoot,
                artifactRoot: path.dirname(path.join(root, handoff.reference.bindingPath)),
                reference: handoff.reference.workerDependencies,
                onTick: () => { if (!guard()) fail('DUAL_ISOLATED_UNAUTHORIZED', 'QC authority was revoked'); },
                signal,
            });
        }
        const validationBeforeManifest = manifestWorker(workerRoot);
        if (validationBeforeManifest.failures.length) {
            fail('DUAL_QC_WORKSPACE_MANIFEST_FAILED', `Cannot capture validator baseline: ${validationBeforeManifest.failures.join('; ')}`);
        }
        const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(workerRoot).replace(/\\/g, '/') };
        for (const name of Object.keys(env)) {
            if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'].includes(name.toUpperCase())) delete env[name];
        }
        if (!Array.isArray(task.validation_commands) || !task.validation_commands.length) {
            fail('DUAL_ISOLATED_QC_NOT_READY', 'Registered validation commands are required');
        }
        for (const command of task.validation_commands) {
            if (!guard()) fail('DUAL_ISOLATED_UNAUTHORIZED', 'QC authority was revoked');
            await readAuthorityHandoffAsync(root, task, authorityStore.derive(), { onTick: heartbeat, signal });
            const kind = ['npm', 'pnpm', 'yarn', 'bun'].includes(command.program) ? 'package-manager' : 'native';
            const invocation = resolveSetupInvocation({ kind, ...command }, {
                workspaceRoot: workerRoot, env, resolveExecutable: createCliResolver(workerRoot, { env }),
            });
            const started = Date.now();
            const output = await spawnBoundedProcess(invocation.command, invocation.args, {
                cwd: invocation.cwd, env, timeoutMs: 60000, maxOutputBytes: 64 * 1024, spawnImpl: trackedSpawn,
            });
            commands.push({ command: `${command.program} ${command.args.join(' ')}`.trim(),
                exit_code: output.code ?? 1, duration_ms: Math.max(1, Date.now() - started),
                output_sha256: sha(`${output.stdout || ''}\0${output.stderr || ''}`) });
            if (!output.ok || output.code !== 0) {
                recordTaskOutcome({ authorityStore, taskId, leaseId: lease.lease_id, status: 'NEEDS_FIX',
                    code: 'DUAL_QC_VALIDATION_FAILED', summary: `Registered command failed: ${commands.at(-1).command}; exit ${output.code ?? 'unavailable'}` });
                return { status: 'NEEDS_FIX', taskId, commands };
            }
        }
        const { binding } = readTaskBinding(root, task.isolatedWorkspace.reference);
        const cleanup = cleanupEphemeralValidationArtifacts(workerRoot, binding, handoff, { beforeManifest: validationBeforeManifest });
        if (!cleanup.ok) {
            const detail = JSON.stringify({ source_mutations: cleanup.source_mutations, dependency_mutations: cleanup.dependency_mutations,
                unexpected_outputs: cleanup.unexpected_outputs, failures: cleanup.failures }).slice(0, 1800);
            recordTaskOutcome({ authorityStore, taskId, leaseId: lease.lease_id, status: 'NEEDS_FIX',
                code: 'DUAL_QC_WORKSPACE_MUTATION', summary: `Validator workspace mutation rejected: ${detail}` });
            return { status: 'NEEDS_FIX', taskId, commands, cleanup };
        }
        if (!guard()) fail('DUAL_ISOLATED_UNAUTHORIZED', 'QC authority was revoked');
        await readAuthorityHandoffAsync(root, task, authorityStore.derive(), { onTick: heartbeat, signal });

        const currentDerived = authorityStore.derive();
        const acceptancePolicy = currentDerived.plan?.acceptance_policy || currentDerived.plan?.acceptancePolicy;
        if (acceptancePolicy && Array.isArray(acceptancePolicy.checks)) {
            const preIntegrationChecks = acceptancePolicy.checks.filter(
                (check) => check.phase === 'pre_integration' && check.task_id === taskId
            );
            if (preIntegrationChecks.length > 0) {
                let candidateEvidence = reviewEvidence;
                if (!candidateEvidence) {
                    const reviewEvidenceFile = path.join(workerRoot, handoff.artifactPath, 'review-evidence.json');
                    if (fs.existsSync(reviewEvidenceFile)) {
                        try {
                            candidateEvidence = JSON.parse(fs.readFileSync(reviewEvidenceFile, 'utf8'));
                        } catch (err) {
                            fail('DUAL_ISOLATED_EVIDENCE_INVALID', `Failed to parse review-evidence.json: ${err.message}`);
                        }
                    } else if (handoff.artifactHashes['review.json']) {
                        const reviewFile = path.join(workerRoot, handoff.artifactPath, 'review.json');
                        try {
                            const parsedReview = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
                            if (parsedReview && parsedReview.policy_sha256 && parsedReview.check_results) {
                                candidateEvidence = parsedReview;
                            }
                        } catch {}
                    }
                }

                if (!candidateEvidence) {
                    return { status: 'NEEDS_REVIEW', taskId, commands, missing: preIntegrationChecks.map((c) => c.id) };
                }

                let evalResult;
                try {
                    evalResult = evaluatePreIntegrationReview(acceptancePolicy, candidateEvidence, {
                        taskId,
                        resultSha256: task.isolatedHandoff.result_sha256,
                    });
                } catch (err) {
                    recordTaskOutcome({ authorityStore, taskId, leaseId: lease.lease_id, status: 'NEEDS_FIX',
                        code: err.code || 'DUAL_ACCEPTANCE_EVIDENCE_INVALID', summary: `Pre-integration acceptance review rejected: ${err.message}` });
                    return { status: 'NEEDS_FIX', taskId, commands, error: err.message };
                }

                if (evalResult.status === 'NEEDS_FIX') {
                    recordTaskOutcome({ authorityStore, taskId, leaseId: lease.lease_id, status: 'NEEDS_FIX',
                        code: 'DUAL_ACCEPTANCE_PREINTEGRATION_FAILED',
                        summary: `Pre-integration acceptance check failed: ${evalResult.failed.map((f) => `${f.check_id} (${f.status})`).join(', ')}` });
                    return { status: 'NEEDS_FIX', taskId, commands, failed: evalResult.failed };
                }

                if (evalResult.status === 'NEEDS_REVIEW') {
                    return { status: 'NEEDS_REVIEW', taskId, commands, missing: evalResult.missing };
                }

                const checksById = new Map(preIntegrationChecks.map((check) => [check.id, check]));
                for (const checkResult of candidateEvidence.check_results) {
                    const registeredCheck = checksById.get(checkResult.check_id);
                    if (!registeredCheck) continue;
                    const gateStatus = checkResult.status === 'PASS' ? 'PASSED'
                        : checkResult.status === 'FAIL' ? 'FAILED'
                            : checkResult.status;
                    authorityStore.append({
                        schema_version: 2,
                        type: 'gate.result',
                        gate_id: `acceptance-${checkResult.check_id}`,
                        task_id: taskId,
                        status: gateStatus,
                        evidence_sha256: candidateEvidence.evidence_sha256,
                        reason: checkResult.findings.length
                            ? checkResult.findings.join('; ').slice(0, 256)
                            : `Independent pre-integration acceptance check ${checkResult.status.toLowerCase()}`,
                        details: {
                            required: registeredCheck.required,
                            check_id: checkResult.check_id,
                            policy_sha256: candidateEvidence.policy_sha256,
                            result_sha256: candidateEvidence.result_sha256,
                        },
                    });
                }
            }
        }

        const integration = await integrateTaskResultAsync({ workspaceRoot: root, reference: handoff.reference,
            result: handoff.result, expectedResultSha256: task.isolatedHandoff.result_sha256, authorize: guard,
            onTick: () => { if (!guard()) fail('DUAL_ISOLATED_UNAUTHORIZED', 'QC authority was revoked'); }, signal });
        if (!['INTEGRATED', 'ALREADY_INTEGRATED'].includes(integration.status)) {
            if (integration.status === 'CONFLICT') recordTaskOutcome({ authorityStore, taskId, leaseId: lease.lease_id,
                status: 'CONFLICT', code: 'DUAL_SOURCE_CONFLICT', summary: `Source conflict: ${integration.files.join(', ')}` });
            return { ...integration, taskId, commands };
        }
        const integrationSha = sha(fs.readFileSync(path.join(root, integration.receiptPath)));
        for (const [name, digest] of [
            ['delegation', handoff.handoffSha256],
            ['scope', handoff.result.resultSha256],
            ['review', handoff.artifactHashes['review.json']],
        ]) {
            authorityStore.append({ schema_version: 2, type: 'gate.result', gate_id: `${name}-${taskId}`,
                task_id: taskId, status: 'PASSED', evidence_sha256: digest,
                reason: `Isolated ${name} evidence validated against anchored handoff and integrated result`,
                details: { required: true, handoff_sha256: handoff.handoffSha256,
                    result_sha256: handoff.result.resultSha256, integration_receipt: integration.receiptPath } });
        }
        authorityStore.append({ schema_version: 2, type: 'gate.result', gate_id: `isolated-qc-${taskId}`,
            task_id: taskId, status: 'PASSED', evidence_sha256: integrationSha,
            reason: 'Independent registered validation passed and controller integrated the anchored private result',
            details: { required: true, handoff_sha256: task.isolatedHandoff.handoff_sha256,
                result_sha256: task.isolatedHandoff.result_sha256, integration_receipt: integration.receiptPath, commands } });
        const conflicts = await integratedConflicts(root, handoff);
        if (conflicts.length) return { status: 'CONFLICT', taskId, files: conflicts, commands };
        if (!guard()) fail('DUAL_ISOLATED_UNAUTHORIZED', 'QC authority changed before task completion');
        authorityStore.append({ schema_version: 2, type: 'task.completed', task_id: taskId, owner: 'agy',
            authority_state: 'TASK_VERIFIED', modified_files: handoff.result.changes.map((change) => change.path),
            diff_fingerprint: handoff.result.resultSha256, verdict: 'SUCCESS', verified_by: 'codex' });
        return { status: 'TASK_VERIFIED', taskId, commands, integrationReceipt: integration.receiptPath };
    } finally {
        clearInterval(timer);
        releaseSettledTaskLease({ authorityStore, taskId, leaseId: lease.lease_id, reason: 'isolated_codex_qc_finished' });
    }
}

module.exports = { completeIsolatedTask, cleanupEphemeralValidationArtifacts, manifestWorker };
