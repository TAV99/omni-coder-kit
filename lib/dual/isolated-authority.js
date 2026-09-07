'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { runIsolatedTask } = require('./isolated-runner');
const { collectTaskResult, readTaskBinding, validateTaskPath } = require('./task-workspace');
const { taskReadiness } = require('./task-scheduler');
const { unansweredQuestions } = require('./task-messages');
const { recordTaskOutcome } = require('./task-correction');
const { createTrackedSpawn, releaseSettledTaskLease } = require('./task-processes');

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const taskContract = (task) => JSON.stringify(['goal', 'owner', 'model', 'risk', 'execution_mode', 'allowed_files',
    'context_files', 'deny_patterns', 'validation_commands', 'depends_on', 'correction', 'dependency_mode'].map((key) => task[key]));

function readAuthorityHandoff(workspaceRoot, task, expected) {
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
        || JSON.stringify(binding.allowedFiles) !== JSON.stringify(task.allowed_files)) {
        fail('DUAL_ISOLATED_AUTHORITY_STALE', 'Handoff belongs to an earlier task revision or scope');
    }
    const contractPath = `${path.posix.dirname(task.isolatedWorkspace.reference.bindingPath)}/worker-contract.json`;
    validateTaskPath(workspaceRoot, contractPath);
    const contractBytes = fs.readFileSync(path.join(workspaceRoot, contractPath));
    if (sha(contractBytes) !== task.isolatedWorkspace.reference.workerContractSha256) {
        fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Prepared worker contract hash changed');
    }
    const contract = JSON.parse(contractBytes.toString('utf8'));
    if (contract.capability.model !== task.model || contract.capability.model !== expected.capability?.details?.agy_model
        || contract.capability.version !== expected.capability?.details?.agy_version
        || contract.spec.goal !== task.goal
        || JSON.stringify(contract.spec.allowed_files) !== JSON.stringify(task.allowed_files)
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
    if (collectTaskResult({ workspaceRoot, reference: task.isolatedWorkspace.reference }).resultSha256 !== record.result_sha256) {
        fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Worker files changed after handoff');
    }
    return { taskId: task.task_id, ...handoff, handoffPath: record.handoff_path, handoffSha256: record.handoff_sha256 };
}

async function executeIsolatedAuthorityTask(options) {
    const { workspaceRoot, authorityStore, taskId, expected, processRunner, agyCommand, agyPrefixArgs,
        setIntervalFn = setInterval, clearIntervalFn = clearInterval, leaseHeartbeatMs = 10000 } = options;
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
    if (task.lastOutcome) return { taskId, ...task.lastOutcome };
    if (task.isolatedHandoff) return readAuthorityHandoff(workspaceRoot, task, current);
    const questions = unansweredQuestions(task);
    if (questions.length) return { taskId, status: 'NEEDS_CONTEXT', questions };
    const readiness = taskReadiness(current, taskId);
    if (readiness.status !== 'READY') return { taskId, ...readiness };
    const cap = current.capability;
    const details = cap?.details;
    if (cap?.status !== 'PASSED' || !cap.checks?.some((check) => check.name === 'agy_cli_and_model' && check.status === 'PASSED')
        || !details?.agy_version || !details?.agy_model || task.model !== details.agy_model) {
        fail('DUAL_ISOLATED_CAPABILITY_INVALID', 'Authority does not prove the routed worker capability');
    }
    const active = Object.values(current.leases).find((lease) => lease.task_id === taskId && lease.status !== 'released');
    if (active) return { taskId, status: active.status === 'active' ? 'AGY_IN_PROGRESS' : 'NEEDS_LEASE_RECOVERY' };
    const lease = authorityStore.acquireLease(taskId, 'agy');
    authorityStore.append({ schema_version: 2, type: 'task.execution.started', task_id: taskId,
        lease_id: lease.lease_id, controller_pid: process.pid });
    const trackedSpawn = createTrackedSpawn({ authorityStore, taskId, leaseId: lease.lease_id });
    const attempt = task.isolatedWorkspace?.attempt || task.correction?.attempt || 1;
    let renewalError;
    const timer = setIntervalFn(() => {
        try { authorityStore.renewLease(lease.lease_id); } catch (error) { renewalError = error; }
    }, leaseHeartbeatMs);
    timer?.unref?.();
    const authorize = () => {
        if (renewalError) return false;
        const now = authorityStore.derive();
        return now.sessionId === current.sessionId && now.planRevision === current.planRevision
            && now.sessionState === 'EXECUTING' && now.tasks[taskId]?.owner === 'agy'
            && JSON.stringify(now.currentBaseline) === JSON.stringify(current.currentBaseline)
            && taskContract(now.tasks[taskId]) === taskContract(task)
            && taskReadiness(now, taskId).status === 'READY'
            && now.leases[lease.lease_id]?.status === 'active';
    };
    try {
        const handoff = await runIsolatedTask({ workspaceRoot, sessionId: current.sessionId, task,
            attempt, planRevision: current.planRevision,
            capability: { version: details.agy_version, model: details.agy_model },
            processRunner, agyCommand, agyPrefixArgs, authorize, reference: task.isolatedWorkspace?.reference, spawn: trackedSpawn,
            controllerReplies: (task.messages || []).filter((message) => message.kind === 'reply').map((message) => ({
                question: task.messages.find((question) => question.message_id === message.reply_to).body, answer: message.body,
            })),
            expectedQuestions: task.messages?.filter((message) => message.kind === 'question').map((message) => message.body),
            onDependenciesPrepared(reference) {
                if (authorityStore.derive().tasks[taskId].isolatedWorkspace.reference.workerDependencies) return;
                authorityStore.append({ schema_version: 2, type: 'task.dependencies.prepared', task_id: taskId,
                    lease_id: lease.lease_id, attempt, receipt_sha256: reference.receiptSha256 });
            },
            onPrepared(reference) {
                if (task.isolatedWorkspace) return;
                const { bindingPath, bindingSha256, workerBaselineSha256, workerContractSha256 } = reference;
                authorityStore.append({ schema_version: 2, type: 'task.workspace.prepared', task_id: taskId,
                    lease_id: lease.lease_id, attempt,
                    reference: { bindingPath, bindingSha256, workerBaselineSha256, workerContractSha256 } });
            },
        });
        if (handoff.status === 'NEEDS_CONTEXT') {
            authorityStore.append({ schema_version: 2, type: 'task.questions', task_id: taskId, lease_id: lease.lease_id,
                questions: handoff.questions.map((body, index) => ({
                    message_id: `q-${sha(`${taskId}:${attempt}:${index}:${body}`).slice(0, 60)}`, body,
                })) });
            releaseSettledTaskLease({ authorityStore, taskId, leaseId: lease.lease_id, reason: 'isolated_awaiting_context' });
            return { taskId, status: 'NEEDS_CONTEXT', questions: unansweredQuestions(authorityStore.derive().tasks[taskId]) };
        }
        if (handoff.status !== 'AWAITING_CODEX_QC') fail('DUAL_ISOLATED_EVIDENCE_INVALID', 'Isolated worker needs controller correction');
        authorityStore.append({ schema_version: 2, type: 'task.workspace.handoff', task_id: taskId,
            lease_id: lease.lease_id, attempt,
            handoff_path: handoff.handoffPath, handoff_sha256: handoff.handoffSha256,
            result_sha256: handoff.result.resultSha256 });
        releaseSettledTaskLease({ authorityStore, taskId, leaseId: lease.lease_id, reason: 'isolated_awaiting_codex_qc' });
        return { taskId, ...handoff };
    } catch (error) {
        const now = authorityStore.derive();
        if (now.tasks[taskId] && now.leases[lease.lease_id]?.status === 'active') {
            recordTaskOutcome({ authorityStore, taskId, leaseId: lease.lease_id, status: 'FAILED',
                code: /^[A-Z0-9_]{1,128}$/.test(error.code || '') ? error.code : 'DUAL_WORKER_EXECUTION_FAILED',
                summary: /^DUAL_PRIVATE_SETUP_/.test(error.code || '') || error.code === 'DUAL_ISOLATED_PROJECT_UNSAFE'
                    ? 'Preparation stopped before model invocation; inspect dependency policy and isolated arguments before bounded correction.'
                    : 'Worker stopped; inspect preserved attempt artifacts before a bounded correction.' });
        }
        releaseSettledTaskLease({ authorityStore, taskId, leaseId: lease.lease_id, reason: `isolated_failed:${error.code || 'UNKNOWN'}` });
        throw error;
    } finally { clearIntervalFn(timer); }
}

module.exports = { executeIsolatedAuthorityTask, readAuthorityHandoff };
