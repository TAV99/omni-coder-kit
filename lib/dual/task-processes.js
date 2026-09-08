'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function createTrackedSpawn({ authorityStore, taskId, leaseId, spawnImpl = spawn }) {
    return (command, args, options) => {
        const processId = crypto.randomUUID();
        const event = { schema_version: 2, task_id: taskId, lease_id: leaseId, process_id: processId };
        authorityStore.append({ ...event, type: 'task.process.intent' });
        let child;
        try { child = spawnImpl(command, args, options); }
        catch (error) { authorityStore.append({ ...event, type: 'task.process.exited', exit_code: null }); throw error; }
        if (Number.isSafeInteger(child.pid) && child.pid > 0) {
            try { authorityStore.append({ ...event, type: 'task.process.started', pid: child.pid }); }
            catch (error) { child.kill(); throw error; }
        }
        child.once('close', (exitCode) => {
            try {
                authorityStore.append({ ...event, type: 'task.process.exited', exit_code: exitCode });
                const execution = authorityStore.derive().tasks[taskId]?.executions?.[leaseId];
                if (execution?.release_reason) releaseSettledTaskLease({ authorityStore, taskId, leaseId, reason: execution.release_reason });
            }
            catch { /* Missing exit evidence remains conservative on recovery. */ }
        });
        return child;
    };
}

function confirmedDead(pid) {
    try { process.kill(pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
}

function recoverTaskLease({ workspaceRoot, authorityStore, sessionId, taskId, planRevision }) {
    const current = authorityStore.derive();
    if (current.sessionId !== sessionId || current.planRevision !== planRevision
        || fs.realpathSync.native(workspaceRoot) !== fs.realpathSync.native(current.workspaceRoot)) {
        const error = new Error('Recovery lineage mismatch'); error.code = 'DUAL_RECOVERY_UNSAFE'; throw error;
    }
    const task = current.tasks[taskId];
    if (!task || task.execution_mode !== 'isolated') { const error = new Error('Recovery requires isolated task'); error.code = 'DUAL_RECOVERY_UNSAFE'; throw error; }
    const leases = Object.values(current.leases).filter((lease) => lease.task_id === taskId && lease.status !== 'released');
    if (!leases.length) return { status: 'NO_RECOVERY_NEEDED', taskId };
    const recoveries = [];
    for (const lease of leases) {
        const execution = task.executions?.[lease.lease_id];
        if (!execution) return { status: 'NEEDS_PROCESS_EVIDENCE', taskId };
        const children = Object.values(execution.processes);
        if (children.some((child) => child.state === 'pending')) return { status: 'NEEDS_PROCESS_EVIDENCE', taskId };
        const pids = [...new Set([execution.controller_pid, ...children.filter((child) => child.state !== 'exited').map((child) => child.pid)])];
        if (pids.some((pid) => !confirmedDead(pid))) return { status: 'WAITING_FOR_PROCESS', taskId };
        if (children.some((child) => child.pid)) return { status: 'NEEDS_PROCESS_TREE_EVIDENCE', taskId };
        recoveries.push({ lease, pids });
    }
    for (const { lease, pids } of recoveries) authorityStore.append({ schema_version: 2, type: 'task.lease.recovered',
        task_id: taskId, lease_id: lease.lease_id, confirmed_dead_pids: pids });
    return { status: 'RECOVERED', taskId };
}

function releaseSettledTaskLease({ authorityStore, taskId, leaseId, reason }) {
    const current = authorityStore.derive();
    if (current.leases[leaseId]?.status === 'released') return true;
    const task = current.tasks[taskId];
    const lease = current.leases[leaseId];
    const execution = task?.executions?.[leaseId];
    if (execution && Object.values(execution.processes).some((child) => child.state !== 'exited')) {
        if (!execution.release_reason) authorityStore.append({ schema_version: 2, type: 'task.execution.release_requested',
            task_id: taskId, lease_id: leaseId, reason });
        return false;
    }
    if (lease?.status === 'expired') {
        const outcome = task?.lastOutcome;
        if (outcome?.status !== 'FAILED' || execution?.controller_pid !== process.pid) return false;
        const attempt = outcome.attempt;
        const finalization = authorityStore.recordFinalizationFailure({ taskId, leaseId, attempt,
            code: outcome.code, stage: task.finalization?.stage || 'unknown' });
        return finalization.settled === true;
    }
    authorityStore.releaseLease(leaseId, reason);
    return true;
}

module.exports = { createTrackedSpawn, recoverTaskLease, releaseSettledTaskLease };
