'use strict';

// Daemon-Owned Binding Coordinator for Omni UI (T12)
//
// Implements:
// - Safe, exclusive binding application with quiescence barrier
// - Two-phase recoverable configuration transaction (binding + manifest + mounts)
// - Enforcement of stopped orchestrator proof from UI runtime
// - Non-user-approvable maintenance barrier during apply
// - Crash recovery and idempotency

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createActivityBarrier() {
    let exclusiveActive = false;
    let activeOperationsCount = 0;

    return {
        isBusy() {
            return exclusiveActive || activeOperationsCount > 0;
        },
        hasActiveOperations() {
            return activeOperationsCount > 0;
        },
        enterOperation() {
            if (exclusiveActive) {
                const err = new Error('Maintenance barrier active: binding application in progress');
                err.code = 'MAINTENANCE_BARRIER';
                err.status = 409;
                throw err;
            }
            activeOperationsCount++;
            let exited = false;
            return () => {
                if (!exited) {
                    exited = true;
                    activeOperationsCount = Math.max(0, activeOperationsCount - 1);
                }
            };
        },
        async runExclusive(fn) {
            if (exclusiveActive) {
                const err = new Error('Concurrent binding application already in progress');
                err.code = 'BARRIER_BUSY';
                err.status = 409;
                throw err;
            }
            if (activeOperationsCount > 0) {
                const err = new Error(`Cannot apply binding while ${activeOperationsCount} agent operation(s) are active`);
                err.code = 'ACTIVITY_ACTIVE';
                err.status = 409;
                throw err;
            }

            exclusiveActive = true;
            try {
                return await fn();
            } finally {
                exclusiveActive = false;
            }
        },
    };
}

function computeDigest(candidate) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(candidate))
        .digest('hex');
}

function createBindingCoordinator({
    authority = null,
    activityBarrier = null,
    readConfig,
    applyConfig,
    readDraft,
    verifyPreflight = null,
    journalDir = null,
    clock = { now: () => Date.now(), iso: () => new Date().toISOString() },
    fsImpl = fs,
} = {}) {
    if (typeof readConfig !== 'function') {
        throw new Error('readConfig function is required');
    }
    if (typeof applyConfig !== 'function') {
        throw new Error('applyConfig function is required');
    }
    if (typeof readDraft !== 'function') {
        throw new Error('readDraft function is required');
    }

    const barrier = activityBarrier || createActivityBarrier();
    const appliedRequests = new Map(); // requestId -> result

    function writeJournal(journalFile, data) {
        if (!journalDir) return;
        fsImpl.mkdirSync(journalDir, { recursive: true });
        const tmp = `${journalFile}.${process.pid}.tmp`;
        fsImpl.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        fsImpl.renameSync(tmp, journalFile);
    }

    /**
     * Applies a binding candidate atomically and exclusively.
     */
    async function apply({
        requestId,
        draftId,
        expectedRevision = null,
        preflightDigest = null,
        uiRuntimeProof = null,
    } = {}) {
        if (!requestId) {
            const err = new Error('requestId is required');
            err.code = 'INVALID_REQUEST';
            err.status = 400;
            throw err;
        }

        // 1. Idempotency check
        if (appliedRequests.has(requestId)) {
            return appliedRequests.get(requestId);
        }

        // 2. Orchestrator stopped proof verification
        if (!uiRuntimeProof || uiRuntimeProof.orchestratorStopped !== true) {
            const err = new Error('Orchestrator must be stopped to apply new role binding');
            err.code = 'ORCHESTRATOR_RUNNING';
            err.status = 409;
            throw err;
        }

        // 3. Quiescent serialization barrier
        return barrier.runExclusive(async () => {
            // Check authority for active tasks if authority is available
            if (authority) {
                const status = typeof authority.derive === 'function' ? authority.derive() : null;
                if (status && status.running_tasks && status.running_tasks.length > 0) {
                    const err = new Error('Cannot apply binding while tasks are running in authority');
                    err.code = 'AUTHORITY_BUSY';
                    err.status = 409;
                    throw err;
                }
            }

            // Read current config and revision
            const currentConfig = await readConfig();
            const currentRevision = currentConfig ? currentConfig.revision || 'initial' : 'initial';

            if (expectedRevision && currentRevision !== expectedRevision) {
                const err = new Error(`Configuration revision conflict: expected ${expectedRevision}, found ${currentRevision}`);
                err.code = 'CONFIG_CONFLICT';
                err.status = 409;
                throw err;
            }

            // Read draft
            const draft = await readDraft(draftId);
            if (!draft || !draft.candidate) {
                const err = new Error(`Binding draft not found: ${draftId}`);
                err.code = 'DRAFT_NOT_FOUND';
                err.status = 404;
                throw err;
            }

            // Verify preflight digest
            const candidateDigest = computeDigest(draft.candidate);
            if (preflightDigest && preflightDigest !== candidateDigest) {
                const err = new Error('Candidate does not match preflight digest');
                err.code = 'DIGEST_MISMATCH';
                err.status = 400;
                throw err;
            }

            if (typeof verifyPreflight === 'function') {
                const verified = await verifyPreflight(draft.candidate, preflightDigest);
                if (!verified || !verified.valid) {
                    const err = new Error('Candidate failed preflight verification');
                    err.code = 'PREFLIGHT_INVALID';
                    err.status = 400;
                    throw err;
                }
            }

            // Journal Phase 1: PREPARED
            const journalFile = journalDir ? path.join(journalDir, `apply-${requestId}.json`) : null;
            if (journalFile) {
                writeJournal(journalFile, {
                    phase: 'PREPARED',
                    requestId,
                    draftId,
                    previousConfig: currentConfig,
                    candidate: draft.candidate,
                    timestamp: clock.iso(),
                });
            }

            // Execute transaction
            let commitResult;
            try {
                commitResult = await applyConfig(draft.candidate);
            } catch (err) {
                // Injected or unexpected failure: rollback
                if (journalFile) {
                    try {
                        if (currentConfig && currentConfig.raw) {
                            await applyConfig(currentConfig.raw);
                        }
                        writeJournal(journalFile, {
                            phase: 'ROLLED_BACK',
                            requestId,
                            error: err.message,
                            timestamp: clock.iso(),
                        });
                    } catch (rollbackErr) {
                        writeJournal(journalFile, {
                            phase: 'CORRUPT_NEEDS_REPAIR',
                            requestId,
                            error: rollbackErr.message,
                            timestamp: clock.iso(),
                        });
                    }
                }
                throw err;
            }

            const newRevision = crypto.randomUUID().slice(0, 16);
            const result = {
                ok: true,
                requestId,
                draftId,
                revision: newRevision,
                applied_at: clock.iso(),
                commitResult,
            };

            // Journal Phase 2: COMMITTED
            if (journalFile) {
                writeJournal(journalFile, {
                    phase: 'COMMITTED',
                    requestId,
                    revision: newRevision,
                    timestamp: clock.iso(),
                });
            }

            appliedRequests.set(requestId, result);
            return result;
        });
    }

    /**
     * Recovers from any unfinished journal entries after a crash/restart.
     */
    async function recover() {
        if (!journalDir || !fsImpl.existsSync(journalDir)) {
            return { recovered: true, actions: [] };
        }

        const actions = [];
        const files = fsImpl.readdirSync(journalDir);
        for (const file of files) {
            if (!file.startsWith('apply-') || !file.endsWith('.json')) continue;
            const fullPath = path.join(journalDir, file);
            try {
                const journal = JSON.parse(fsImpl.readFileSync(fullPath, 'utf8'));
                if (journal.phase === 'PREPARED') {
                    // Rollback to previous config
                    if (journal.previousConfig && journal.previousConfig.raw) {
                        await applyConfig(journal.previousConfig.raw);
                    }
                    journal.phase = 'ROLLED_BACK';
                    fsImpl.writeFileSync(fullPath, JSON.stringify(journal, null, 2), 'utf8');
                    actions.push(`Rolled back uncommitted transaction ${journal.requestId}`);
                } else if (journal.phase === 'COMMITTED') {
                    actions.push(`Verified committed transaction ${journal.requestId}`);
                }
            } catch (err) {
                actions.push(`Error recovering ${file}: ${err.message}`);
            }
        }

        return { recovered: true, actions };
    }

    return {
        apply,
        recover,
        barrier,
        getBarrier: () => barrier,
    };
}

module.exports = {
    createActivityBarrier,
    createBindingCoordinator,
};
