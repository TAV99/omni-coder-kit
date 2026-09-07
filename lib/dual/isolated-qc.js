'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readAuthorityHandoff } = require('./isolated-authority');
const { integrateTaskResult } = require('./task-integration');
const { readTaskBinding, validateTaskPath } = require('./task-workspace');
const { resolveSetupInvocation } = require('./setup-runner');
const { createCliResolver } = require('./setup-command');
const { spawnBoundedProcess } = require('./capability-preflight');
const { taskReadiness } = require('./task-scheduler');
const { recordTaskOutcome } = require('./task-correction');
const { createTrackedSpawn, releaseSettledTaskLease } = require('./task-processes');

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

function integratedConflicts(root, handoff, history) {
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
            const later = readAuthorityHandoff(root, laterTask, history.derived);
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

async function completeIsolatedTask({ workspaceRoot, authorityStore, sessionId, taskId, planRevision }) {
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
    const handoff = readAuthorityHandoff(root, task, initial);
    if (task.state === 'TASK_VERIFIED') {
        validateIntegrationReceipt(root, task, handoff, initial);
        const files = integratedConflicts(root, handoff, { derived: initial, events: authorityStore.readEvents() });
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
        const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(workerRoot).replace(/\\/g, '/') };
        for (const name of Object.keys(env)) {
            if (['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE'].includes(name.toUpperCase())) delete env[name];
        }
        if (!Array.isArray(task.validation_commands) || !task.validation_commands.length) {
            fail('DUAL_ISOLATED_QC_NOT_READY', 'Registered validation commands are required');
        }
        for (const command of task.validation_commands) {
            if (!guard()) fail('DUAL_ISOLATED_UNAUTHORIZED', 'QC authority was revoked');
            readAuthorityHandoff(root, task, authorityStore.derive());
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
        if (!guard()) fail('DUAL_ISOLATED_UNAUTHORIZED', 'QC authority was revoked');
        readAuthorityHandoff(root, task, authorityStore.derive());
        const integration = integrateTaskResult({ workspaceRoot: root, reference: handoff.reference,
            result: handoff.result, expectedResultSha256: task.isolatedHandoff.result_sha256, authorize: guard });
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
        const conflicts = integratedConflicts(root, handoff);
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

module.exports = { completeIsolatedTask };
