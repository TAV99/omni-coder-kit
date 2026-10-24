'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveConfiguredWorkerModel, resolveConfiguredWorkerEffort, workerConfigurationError } = require('./agy-model');
const { runIsolatedTask } = require('./isolated-runner');
const { collectTaskResult, collectTaskResultAsync, readTaskBinding, validateTaskPath } = require('./task-workspace');
const { taskReadiness } = require('./task-scheduler');
const { unansweredQuestions } = require('./task-messages');
const { recordTaskOutcome } = require('./task-correction');
const { createTrackedSpawn, releaseSettledTaskLease } = require('./task-processes');
const { assertOperationAuthorized } = require('./operation-lifecycle');

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const isCancellation = (error) => Boolean(error?.name === 'AbortError'
    || ['ABORT_ERR', 'ECANCELED', 'ERR_CANCELED', 'DUAL_PRIVATE_SETUP_ABORTED'].includes(error?.code));
const taskContract = (task) => JSON.stringify(['goal', 'owner', 'model', 'effort', 'risk', 'execution_mode', 'allowed_files',
    'generated_outputs', 'context_files', 'deny_patterns', 'validation_commands', 'depends_on', 'correction', 'dependency_mode'].map((key) => task[key]));

function readAuthorityHandoffWithResult(workspaceRoot, task, expected, result) {
    const record = task.isolatedHandoff;
    validateTaskPath(workspaceRoot, record.handoff_path);
    const bytes = fs.readFileSync(path.join(workspaceRoot, record.handoff_path));
    if (sha(bytes) !== record.handoff_sha256) fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Handoff changed since authority recorded it');
    const handoff = JSON.parse(bytes.toString('utf8'));
    if (handoff.result.resultSha256 !== record.result_sha256
        || handoff.reference.bindingSha256 !== task.isolatedWorkspace.reference.bindingSha256) {
        fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Handoff does not match prepared authority binding');
    }
    const { binding, workerRoot } = readTaskBinding(workspaceRoot, task.isolatedWorkspace.reference);
    if (!expected || binding.sessionId !== expected.sessionId || binding.planRevision !== expected.planRevision
        || binding.taskId !== task.task_id || binding.attempt !== record.attempt
        || JSON.stringify(binding.allowedFiles) !== JSON.stringify(task.allowed_files)
        || JSON.stringify(binding.generated_outputs || []) !== JSON.stringify(task.generated_outputs || [])) {
        fail('DUAL_ISOLATED_AUTHORITY_STALE', 'Handoff belongs to an earlier task revision or scope');
    }
    const contractPath = `${path.posix.dirname(task.isolatedWorkspace.reference.bindingPath)}/worker-contract.json`;
    validateTaskPath(workspaceRoot, contractPath);
    const contractBytes = fs.readFileSync(path.join(workspaceRoot, contractPath));
    if (sha(contractBytes) !== task.isolatedWorkspace.reference.workerContractSha256) {
        fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Prepared worker contract hash changed');
    }
    const contract = JSON.parse(contractBytes.toString('utf8'));
    const workerModel = resolveConfiguredWorkerModel(workspaceRoot, { model: task.model });
    const workerEffort = resolveConfiguredWorkerEffort(workspaceRoot, { effort: task.effort });
    const configurationError = workerConfigurationError(workerModel, workerEffort);
    if (configurationError) fail('DUAL_WORKER_CONFIG_MISSING', configurationError);
    if (contract.capability.effort !== workerEffort || contract.capability.model !== workerModel || contract.capability.model !== expected.capability?.details?.agy_model
        || contract.capability.version !== expected.capability?.details?.agy_version
        || contract.spec.goal !== task.goal
        || JSON.stringify(contract.spec.allowed_files) !== JSON.stringify(task.allowed_files)
        || JSON.stringify(contract.spec.generated_outputs || []) !== JSON.stringify(task.generated_outputs || [])
        || JSON.stringify(contract.spec.context_files || []) !== JSON.stringify(task.context_files || [])
        || JSON.stringify(contract.spec.deny_patterns) !== JSON.stringify(task.deny_patterns)
        || JSON.stringify(contract.spec.validation_commands) !== JSON.stringify(task.validation_commands)) {
        fail('DUAL_ISOLATED_AUTHORITY_STALE', 'Current task contract differs from completed private work');
    }
    if ((contract.spec.dependency_mode || 'none') !== (task.dependency_mode || 'none')) {
        fail('DUAL_ISOLATED_AUTHORITY_STALE', 'Dependency mode changed since the worker contract was prepared');
    }
    for (const [file, expected] of Object.entries(handoff.artifactHashes)) {
        const relative = `${handoff.artifactPath}/${file}`;
        validateTaskPath(workerRoot, relative);
        if (sha(fs.readFileSync(path.join(workerRoot, relative))) !== expected) {
            fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Worker evidence changed after handoff');
        }
    }
    if (result.resultSha256 !== record.result_sha256) {
        fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Worker files changed after handoff');
    }
    return { taskId: task.task_id, ...handoff, handoffPath: record.handoff_path, handoffSha256: record.handoff_sha256 };
}

function readAuthorityHandoff(workspaceRoot, task, expected, { readOnly = false } = {}) {
    return readAuthorityHandoffWithResult(workspaceRoot, task, expected,
        collectTaskResult({ workspaceRoot, reference: task.isolatedWorkspace.reference, readOnly }));
}

async function readAuthorityHandoffAsync(workspaceRoot, task, expected, { onTick, signal } = {}) {
    return readAuthorityHandoffWithResult(workspaceRoot, task, expected,
        await collectTaskResultAsync({ workspaceRoot, reference: task.isolatedWorkspace.reference, onTick, signal }));
}

async function executeIsolatedAuthorityTask(options) {
    const { workspaceRoot, authorityStore, taskId, expected, processRunner, agyCommand, agyPrefixArgs,
        operationWriter, setIntervalFn = setInterval, clearIntervalFn = clearInterval, leaseHeartbeatMs = 10000 } = options;
    if (!operationWriter || typeof operationWriter.begin !== 'function' || typeof operationWriter.settle !== 'function') {
        fail('DUAL_OPERATION_CAPABILITY_REQUIRED', 'Controller operation lifecycle writer is required');
    }
    const current = authorityStore.derive();
    if (!expected || fs.realpathSync.native(workspaceRoot) !== fs.realpathSync.native(current.workspaceRoot)
        || current.sessionId !== expected.sessionId || current.workspaceId !== expected.workspaceId
        || current.planRevision !== expected.planRevision
        || JSON.stringify(current.currentBaseline) !== JSON.stringify(expected.currentBaseline)) {
        fail('DUAL_ISOLATED_AUTHORITY_STALE', 'Caller lineage no longer matches authority');
    }
    const task = current.tasks[taskId];
    if (!task || task.owner !== 'agy' || task.execution_mode !== 'isolated' || task.state === 'TASK_VERIFIED') {
        fail('DUAL_ISOLATED_AUTHORITY_INVALID', 'Task is not an eligible isolated worker task');
    }
    if (current.sessionState !== 'EXECUTING') fail('DUAL_ISOLATED_AUTHORITY_INVALID', 'Session is not executing');
    if (options.signal?.aborted) fail('DUAL_PRIVATE_SETUP_ABORTED', 'Isolated worker execution was aborted');
    if (task.lastOutcome) return { taskId, ...task.lastOutcome };
    const handoffGuard = () => {
        if (options.signal?.aborted) fail('DUAL_PRIVATE_SETUP_ABORTED', 'Isolated handoff collection was aborted');
    };
    if (task.isolatedHandoff) return readAuthorityHandoffAsync(workspaceRoot, task, current,
        { onTick: handoffGuard, signal: options.signal });
    const questions = unansweredQuestions(task);
    if (questions.length) return { taskId, status: 'NEEDS_CONTEXT', questions };
    const readiness = taskReadiness(current, taskId);
    if (readiness.status !== 'READY') return { taskId, ...readiness };
    const workerModel = resolveConfiguredWorkerModel(workspaceRoot, { model: task.model });
    const workerEffort = resolveConfiguredWorkerEffort(workspaceRoot, { effort: task.effort });
    const configurationError = workerConfigurationError(workerModel, workerEffort);
    if (configurationError) fail('DUAL_WORKER_CONFIG_MISSING', configurationError);
    const cap = current.capability;
    const details = cap?.details;
    if (cap?.status !== 'PASSED' || !cap.checks?.some((check) => check.name === 'agy_cli_and_model' && check.status === 'PASSED')
        || !details?.agy_version || !details?.agy_model || workerModel !== details.agy_model) {
        fail('DUAL_ISOLATED_CAPABILITY_INVALID', 'Authority does not prove the routed worker capability');
    }
    const active = Object.values(current.leases).find((lease) => lease.task_id === taskId && lease.status !== 'released');
    if (active) return { taskId, status: active.status === 'active' ? 'AGY_IN_PROGRESS' : 'NEEDS_LEASE_RECOVERY' };
    const lease = authorityStore.acquireLease(taskId, 'agy', { ttlMs: 120000 });
    const operationId = crypto.randomUUID();
    try {
        authorityStore.append({ schema_version: 2, type: 'task.execution.started', task_id: taskId,
            lease_id: lease.lease_id, controller_pid: process.pid });
        // The durable operation begins only after the AGY execution owner is
        // committed, so operation-lifecycle can verify the exact lease lineage.
        operationWriter.begin({ taskId, leaseId: lease.lease_id, operationId });
    } catch (error) {
        try { releaseSettledTaskLease({ authorityStore, taskId, leaseId: lease.lease_id, reason: 'isolated_operation_start_failed' }); }
        catch {}
        throw error;
    }
    const trackedSpawn = createTrackedSpawn({ authorityStore, taskId, leaseId: lease.lease_id });
    const attempt = task.isolatedWorkspace?.attempt || task.correction?.attempt || 1;
    let renewalError;
    let operationSettled = false;
    let executionError;
    let completionReason = 'isolated_awaiting_codex_qc';
    const timer = setIntervalFn(() => {
        try { authorityStore.renewLease(lease.lease_id, { ttlMs: 120000 }); } catch (error) { renewalError = error; }
    }, leaseHeartbeatMs);
    timer?.unref?.();
    const authorize = () => {
        if (renewalError) return false;
        const now = authorityStore.derive();
        const lineageAuthorized = now.sessionId === current.sessionId && now.planRevision === current.planRevision
            && now.sessionState === 'EXECUTING' && now.tasks[taskId]?.owner === 'agy'
            && JSON.stringify(now.currentBaseline) === JSON.stringify(current.currentBaseline)
            && taskContract(now.tasks[taskId]) === taskContract(task)
            && taskReadiness(now, taskId).status === 'READY'
            && now.leases[lease.lease_id]?.status === 'active';
        if (!lineageAuthorized) return false;
        try {
            assertOperationAuthorized({ authorityStore, taskId, leaseId: lease.lease_id, operationId });
            return true;
        } catch { return false; }
    };
    const assertAuthorizedWrite = () => {
        if (!authorize()) fail('DUAL_ISOLATED_UNAUTHORIZED', 'Current controller task authority is required');
        assertOperationAuthorized({ authorityStore, taskId, leaseId: lease.lease_id, operationId });
    };
    const settleActiveOperation = (outcome) => {
        assertAuthorizedWrite();
        const settled = operationWriter.settle({ taskId, leaseId: lease.lease_id, operationId, outcome });
        operationSettled = true;
        return settled;
    };
    try {
        const handoff = await runIsolatedTask({ workspaceRoot, sessionId: current.sessionId, task,
            attempt, planRevision: current.planRevision, leaseId: lease.lease_id, operationId,
            discussion: options.discussion, signal: options.signal, spawnImpl: trackedSpawn,
            capability: { version: details.agy_version, model: details.agy_model },
            processRunner, agyCommand, agyPrefixArgs, authorize, reference: task.isolatedWorkspace?.reference, spawn: trackedSpawn,
            controllerReplies: (task.messages || []).filter((message) => message.kind === 'reply').map((message) => ({
                question: task.messages.find((question) => question.message_id === message.reply_to).body, answer: message.body,
            })),
            expectedQuestions: task.messages?.filter((message) => message.kind === 'question').map((message) => message.body),
            onDependenciesPrepared(reference) {
                if (authorityStore.derive().tasks[taskId].isolatedWorkspace.reference.workerDependencies) return;
                assertAuthorizedWrite();
                authorityStore.append({ schema_version: 2, type: 'task.dependencies.prepared', task_id: taskId,
                    lease_id: lease.lease_id, attempt, receipt_sha256: reference.receiptSha256 });
            },
            onPrepared(reference) {
                if (task.isolatedWorkspace) return;
                assertAuthorizedWrite();
                const { bindingPath, bindingSha256, workerBaselineSha256, workerContractSha256 } = reference;
                authorityStore.append({ schema_version: 2, type: 'task.workspace.prepared', task_id: taskId,
                    lease_id: lease.lease_id, attempt,
                    reference: { bindingPath, bindingSha256, workerBaselineSha256, workerContractSha256 } });
            },
        });
        if (handoff.status === 'NEEDS_CONTEXT') {
            completionReason = 'isolated_awaiting_context';
            assertAuthorizedWrite();
            authorityStore.append({ schema_version: 2, type: 'task.questions', task_id: taskId, lease_id: lease.lease_id,
                questions: handoff.questions.map((body, index) => ({
                    message_id: `q-${sha(`${taskId}:${attempt}:${index}:${body}`).slice(0, 60)}`, body,
                })) });
            return { taskId, status: 'NEEDS_CONTEXT', questions: unansweredQuestions(authorityStore.derive().tasks[taskId]) };
        }
        if (handoff.status !== 'AWAITING_CODEX_QC') fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Isolated worker needs controller correction');
        assertAuthorizedWrite();
        try { authorityStore.renewLease(lease.lease_id, { ttlMs: 120000 }); } catch {}
        try {
            assertAuthorizedWrite();
            authorityStore.append({ schema_version: 2, type: 'task.workspace.handoff', task_id: taskId,
                lease_id: lease.lease_id, attempt,
                handoff_path: handoff.handoffPath, handoff_sha256: handoff.handoffSha256,
                result_sha256: handoff.result.resultSha256 });
        } catch (error) {
            error.finalizationStage = 'outer_handoff';
            throw error;
        }
        return { taskId, ...handoff };
    } catch (error) {
        executionError = error;
        throw error;
    } finally {
        clearIntervalFn(timer);
        let cleanupError;
        try {
            const now = authorityStore.derive();
            const execution = now.tasks[taskId]?.executions?.[lease.lease_id];
            const outcome = executionError ? (isCancellation(executionError) ? 'cancelled' : 'failed') : 'completed';
            if (executionError && now.tasks[taskId] && now.leases[lease.lease_id]?.status === 'expired') {
                const failureCode = /^[A-Z0-9_]{1,128}$/.test(executionError.code || '')
                    ? executionError.code : 'DUAL_WORKER_EXECUTION_FAILED';
                const finalizationStage = ['unknown', 'post_worker_collection', 'outer_handoff'].includes(executionError.finalizationStage)
                    ? executionError.finalizationStage : 'unknown';
                const finalization = authorityStore.recordFinalizationFailure({ taskId, leaseId: lease.lease_id,
                    attempt, code: failureCode, stage: finalizationStage });
                executionError.finalizationDiagnostic = { stage: finalizationStage, recovery: finalization.recovery,
                    operation_id: operationId, operation_outcome: outcome, settled: operationSettled };
            } else {
                if (executionError?.discussionQuiescent === false
                    || Object.values(execution?.processes || {}).some((child) => child.state !== 'exited')) {
                    fail('DUAL_OPERATION_CHILDREN_ACTIVE',
                        'Isolated operation cannot settle while tracked children are pending or live');
                }
                settleActiveOperation(outcome);
                const precondition = executionError?.category === 'PRECONDITION'
                    || ['DUAL_ISOLATED_DISCUSSION_FACTORY_REQUIRED', 'DUAL_DISCUSSION_REQUIRED'].includes(executionError?.code);
                if (outcome === 'failed' && executionError && !precondition && now.tasks[taskId]) {
                    const failureCode = /^[A-Z0-9_]{1,128}$/.test(executionError.code || '')
                        ? executionError.code : 'DUAL_WORKER_EXECUTION_FAILED';
                    recordTaskOutcome({ authorityStore, taskId, leaseId: lease.lease_id, status: 'FAILED', code: failureCode,
                        summary: /^DUAL_PRIVATE_SETUP_/.test(executionError.code || '') || executionError.code === 'DUAL_ISOLATED_PROJECT_UNSAFE'
                            ? 'Preparation stopped before model invocation; inspect dependency policy and isolated arguments before bounded correction.'
                            : 'Worker stopped; inspect preserved attempt artifacts before a bounded correction.' });
                }
                const released = releaseSettledTaskLease({ authorityStore, taskId, leaseId: lease.lease_id,
                    reason: executionError?.code ? `isolated_${outcome}:${executionError.code}`
                        : completionReason });
                if (released !== true) fail('DUAL_OPERATION_SETTLEMENT_UNPROVEN',
                    'Isolated operation settled but its AGY lease release was not proven');
            }
        } catch (error) {
            cleanupError = error;
        }
        if (cleanupError) {
            if (executionError) {
                const recordedFinalization = authorityStore.derive().tasks[taskId]?.finalization;
                executionError.finalizationDiagnostic = { stage: executionError.finalizationDiagnostic?.stage
                    || recordedFinalization?.stage || 'unknown',
                    recovery: executionError.finalizationDiagnostic?.recovery
                        || recordedFinalization?.recovery || 'NEEDS_OPERATION_SETTLEMENT', operation_id: operationId,
                    operation_outcome: isCancellation(executionError) ? 'cancelled' : 'failed', settled: operationSettled };
                executionError.finalizationCleanupCode = /^[A-Z0-9_]{1,128}$/.test(cleanupError.code || '')
                    ? cleanupError.code : 'DUAL_OPERATION_SETTLEMENT_UNPROVEN';
            } else throw cleanupError;
        }
    }
}

module.exports = { executeIsolatedAuthorityTask, readAuthorityHandoff, readAuthorityHandoffAsync };
