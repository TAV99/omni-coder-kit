'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { bindingRef } = require('./contracts');
const { randomUUID } = require('node:crypto');
const { replayAuthorityEvents, computeLeaseStatus } = require('../authority-store');
const { runCapabilityPreflight, validateCapabilityResult, spawnBoundedProcess } = require('../capability-preflight');
const { resolveConfiguredWorkerModel } = require('../agy-model');

// authority is an async reader function (or an object with read(args)). It must
// return fresh { leaseEvents, expectedPlanRevision, expectedSnapshotSha256,
// sessionId }; leaseEvents are complete hash-chained envelopes, not bare payloads.
function createDaemonHostDeps(options = {}) {
    const { authority, preflight = {}, recoveryProbes = {}, now = Date.now } = options;
    const { trustedExecutionContext, signal, prespawnGuard } = options;
    const hooks = { ...(trustedExecutionContext ? {
        spawnImpl: trustedExecutionContext.spawnImpl, env: trustedExecutionContext.env,
    } : {}), signal, prespawnGuard };
    const ttlMs = preflight.ttlMs ?? 900000;

    async function readAuthority(args) {
        return typeof authority === 'function' ? authority(args) : authority.read(args);
    }

    function replay(state, time) {
        if (!Array.isArray(state.leaseEvents) || state.leaseEvents.length === 0
            || !Number.isSafeInteger(time) || time < 0) {
            throw new Error('Authority history or clock is missing');
        }
        return replayAuthorityEvents(state.leaseEvents, { clock: () => new Date(time) });
    }

    async function checkAuthority(args = {}) {
        try {
            const state = await readAuthority(args);
            const time = now();
            const derived = replay(state, time);
            const bindings = args.bindings ?? (args.binding ? [args.binding] : []);
            if (!state.sessionId || derived.sessionId !== state.sessionId
                || !Number.isSafeInteger(state.expectedPlanRevision) || state.expectedPlanRevision < 0
                || derived.planRevision !== state.expectedPlanRevision
                || typeof state.expectedSnapshotSha256 !== 'string'
                || !/^[a-f0-9]{64}$/.test(state.expectedSnapshotSha256)
                || !Array.isArray(bindings) || bindings.length === 0) return false;

            return bindings.every((binding) => binding
                && binding.session_id === state.sessionId
                && binding.plan_revision === state.expectedPlanRevision
                && binding.snapshot_sha256 === state.expectedSnapshotSha256
                && Object.values(derived.leases).some((lease) =>
                    lease.session_id === state.sessionId
                    && lease.task_id === binding.task_id
                    && lease.plan_revision === state.expectedPlanRevision
                    && Date.parse(lease.acquired_at) <= time
                    && computeLeaseStatus(lease, time) === 'active'));
        } catch {
            return false;
        }
    }

    async function defaultCodexProbe(args, workspaceRoot, executionHooks = hooks) {
        const result = await spawnBoundedProcess(preflight.codexPath ?? '/usr/bin/codex', ['--version'], {
            ...executionHooks, cwd: workspaceRoot, timeoutMs: preflight.timeoutMs ?? 15000,
        });
        if (result.ok !== true || result.code !== 0) return false;
        if (args.binding?.model) {
            let cache;
            try {
                cache = JSON.parse(await fs.readFile(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8'));
            } catch (error) {
                // The cache may not exist yet; in that case rely on the version probe alone.
                if (error.code === 'ENOENT') return true;
                return false;
            }
            return Array.isArray(cache?.models)
                && cache.models.some((model) => model?.slug === args.binding.model);
        }
        return true;
    }

    async function verifyCapability(args = {}) {
        let guardDenied = false;
        let guardFailure;
        const executionHooks = { ...hooks, prespawnGuard: prespawnGuard && (async (context) => {
            try { await prespawnGuard(context); }
            catch (error) { guardDenied = true; guardFailure = error; throw error; }
        }) };
        const evidence = {
            allowed: false, liveProfileVerified: false, evidenceId: randomUUID(),
            expiresAt: now() + ttlMs,
            bindingRef: args.bindingRef, provider: args.provider ?? args.binding?.provider,
            adapterId: args.adapterId, adapterVersion: args.adapterVersion,
            conversationId: args.binding?.conversation_id,
            snapshotSha256: args.snapshotSha256, stage: args.stage,
        };
        try {
            if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0
                || !Number.isSafeInteger(evidence.expiresAt)
                || !['codex', 'agy'].includes(evidence.provider)
                || evidence.provider !== args.binding?.provider
                || (args.binding && (args.bindingRef !== bindingRef(args.binding)
                    || args.snapshotSha256 !== args.binding.snapshot_sha256))) return evidence;
            const state = await readAuthority(args);
            const derived = replay(state, now());
            const workspaceRoot = trustedExecutionContext
                ? trustedExecutionContext.workerRoot : derived.workspaceRoot;
            // Session preflight proves environment sanity and the AGY profile;
            // Codex needs its own probe before claiming live profile evidence.
            const workerModel = resolveConfiguredWorkerModel(workspaceRoot,
                evidence.provider === 'agy' ? { workerModel: args.binding.model } : {});
            const result = await (preflight.run ?? runCapabilityPreflight)(workspaceRoot, {
                ...args, ...executionHooks, cwd: workspaceRoot, provider: evidence.provider, workerModel,
                authorityStore: { verifyIntegrity() {
                    replay(state, now());
                    return { valid: true };
                } },
            });
            if (validateCapabilityResult(result, workerModel).valid === true) {
                evidence.allowed = true;
                evidence.liveProfileVerified = evidence.provider === 'agy'
                    || await (preflight.codexProbe ?? defaultCodexProbe)(args, workspaceRoot, executionHooks) === true;
            }
        } catch {
            if (guardDenied) throw guardFailure;
            // Failed session preflight denies access; a failed Codex probe leaves live evidence false.
        }
        return evidence;
    }

    async function verifyRecoveryEvidence(args = {}) {
        const evidence = { allowed: false, processQuiescent: false, providerTerminal: false,
            providerOutcome: 'unknown', evidenceId: randomUUID(),
            bindingRef: args.bindingRef, invocationId: args.invocationId };
        // Provider observations are safe only after process quiescence is confirmed.
        for (const [name, field] of [['isProcessQuiescent', 'processQuiescent'],
            ['isProviderTerminal', 'providerTerminal'], ['providerOutcome', 'providerOutcome']]) {
            if (name !== 'isProcessQuiescent' && evidence.processQuiescent !== true) break;
            try {
                if (typeof recoveryProbes[name] === 'function') {
                    evidence[field] = await recoveryProbes[name](args);
                }
            } catch {
                // Preserve the fail-closed default for the failed probe.
            }
        }
        evidence.allowed = evidence.processQuiescent === true && evidence.providerTerminal === true
            && ['succeeded', 'failed'].includes(evidence.providerOutcome);
        return evidence;
    }

    return { checkAuthority, verifyCapability, verifyRecoveryEvidence };
}

module.exports = { createDaemonHostDeps };
