'use strict';

const path = require('node:path');
const { sha256Utf8 } = require('./contracts');
const { createHostPorts } = require('./host-ports');
const { createDaemonHostDeps } = require('./daemon-ports');
const { createDiscussionSession } = require('./session');

function createDiscussionHost(options = {}) {
    const { stateDir, daemon, preflight, recoveryProbes, seeds, adapters, models, limits, enabled } = options;
    // Recovery must observe the same adapter instances that execute the turns.
    const probe = async ({ binding } = {}) => {
        const adapter = adapters?.[binding?.provider];
        if (typeof adapter?.probeRecovery !== 'function') return {};
        return await adapter.probeRecovery({ conversationId: binding.conversation_id });
    };
    const effectiveRecoveryProbes = recoveryProbes !== undefined ? recoveryProbes : {
        isProcessQuiescent: async (args) => (await probe(args))?.processQuiescent === true,
        isProviderTerminal: async (args) => (await probe(args))?.providerTerminal === true,
        providerOutcome: async (args) => (await probe(args))?.providerOutcome ?? 'unknown',
    };
    const cache = new Map();
    const registry = new Map();

    async function authorityReader(args = {}) {
        const taskId = args.bindings?.[0]?.task_id ?? args.binding?.task_id;
        return {
            leaseEvents: await daemon.readLeaseEvents(),
            expectedPlanRevision: daemon.getPlanRevision(),
            expectedSnapshotSha256: registry.get(taskId)?.snapshotSha256 ?? '',
            sessionId: daemon.sessionId,
        };
    }

    async function sessionResolver({ taskId, snapshotSha256 } = {}) {
        if (enabled !== true) return { enabled: false };
        const planRevision = daemon.getPlanRevision();
        const cacheKey = taskId + '|' + (snapshotSha256 ?? '') + '|' + planRevision;
        if (cache.has(cacheKey)) return cache.get(cacheKey);

        // The baseline identifies workspace state; bindings hash this discussion
        // text, including its task-state identity so superseded sessions go stale.
        const text = JSON.stringify({
            session_id: daemon.sessionId,
            task_id: taskId,
            objective: 'Dual discussion session for task ' + taskId,
            workspace_baseline_id: snapshotSha256 ?? '',
            plan_revision: planRevision,
        });
        // Reserve the newest task state before seeding, which can finish out of
        // order. Until it is ready, authority fails closed for this task.
        registry.set(taskId, { snapshotSha256: '', cacheKey });
        const pending = createDiscussionSession({
            enabled: true, sessionId: daemon.sessionId, taskId, planRevision,
            snapshot: { text, sha256: sha256Utf8(text) },
            stateDir: path.join(stateDir, encodeURIComponent(cacheKey)),
            hostPorts: createHostPorts(createDaemonHostDeps({ authority: authorityReader, preflight, recoveryProbes: effectiveRecoveryProbes })),
            codex: { seedOptions: { cwd: daemon.workspaceRoot } },
            agy: { seedOptions: { cwd: daemon.workspaceRoot } },
            seeds, adapters, models, limits,
        });
        cache.set(cacheKey, pending);
        try {
            const session = await pending;
            if (registry.get(taskId)?.cacheKey === cacheKey) {
                registry.set(taskId, { snapshotSha256: session.bindings[0].snapshot_sha256, cacheKey });
            }
            return session;
        } catch (error) {
            cache.delete(cacheKey);
            throw error;
        }
    }

    async function closeAll() {
        const sessions = await Promise.allSettled(cache.values());
        const closed = await Promise.allSettled(sessions.filter((s) => s.status === 'fulfilled')
            .map((s) => s.value.close()));
        cache.clear();
        registry.clear();
        const failure = closed.find((result) => result.status === 'rejected');
        if (failure) throw failure.reason;
    }

    return { sessionResolver, authorityReader, closeAll };
}

module.exports = { createDiscussionHost };
