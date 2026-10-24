'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { sha256Utf8, bindingRef } = require('./contracts');
const { createHostPorts } = require('./host-ports');
const { createDaemonHostDeps } = require('./daemon-ports');
const { resolveConfiguredWorkerModel, resolveConfiguredWorkerEffort } = require('../agy-model');
const { createDiscussionSession } = require('./session');

function identityError(message) {
    const error = new Error(message);
    error.code = 'DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID';
    error.kind = 'TERMINAL';
    error.category = 'TERMINAL';
    return error;
}

function canonicalRoot(root) {
    try { return fs.realpathSync.native(root); }
    catch { throw identityError('Discussion workspace root cannot be canonicalized'); }
}

// Journals are daemon-owned evidence. Never follow a symlink while creating
// their namespace, and never reopen an old execution with new seed IDs.
function safeDirectory(directory) {
    const absolute = path.resolve(directory);
    let current = path.parse(absolute).root;
    for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        if (!fs.existsSync(current)) fs.mkdirSync(current);
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw identityError('Unsafe discussion journal directory');
    }
    return absolute;
}

// Only stale, abandoned reservations may be removed. Audit evidence and
// complete executions are retained indefinitely, including legacy markers.
function pruneOrphanMarker(markerPath) {
    try {
        const stat = fs.lstatSync(markerPath);
        if (!stat.isFile() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs <= 5 * 60_000) return false;
        const manifestPath = markerPath.slice(0, -'.execution.json'.length) + '.manifest.json';
        try { fs.lstatSync(manifestPath); return false; }
        catch (error) { if (error.code !== 'ENOENT') return false; }
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        if (marker.status !== 'seeding' && marker.status !== undefined) return false;
        if (marker.pid !== undefined) {
            if (!Number.isInteger(marker.pid) || marker.pid <= 0) return false;
            try { process.kill(marker.pid, 0); return false; }
            catch (error) { if (error.code !== 'ESRCH') return false; }
        }
        fs.unlinkSync(markerPath);
        return true;
    } catch { return false; }
}

function createDiscussionHost(options = {}) {
    const { stateDir, daemon, preflight, recoveryProbes, seeds, adapters, models, efforts, limits, enabled } = options;
    if (stateDir && fs.existsSync(path.join(stateDir, 'isolated'))) {
        const directory = safeDirectory(path.join(stateDir, 'isolated'));
        for (const name of fs.readdirSync(directory)) {
            if (name.endsWith('.execution.json')) pruneOrphanMarker(path.join(directory, name));
        }
    }
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
    const children = new Set();
    const activeExecutions = new Map();
    const scopedChildren = new Map();
    let isolatedClosing = false;

    async function authorityReader(args = {}) {
        const taskId = args.bindings?.[0]?.task_id ?? args.binding?.task_id;
        return {
            leaseEvents: await daemon.readLeaseEvents(),
            ...(daemon.readOperationRecords ? { operationRecords: await daemon.readOperationRecords() } : {}),
            ...(daemon.readOperationLedger ? { operationLedger: await daemon.readOperationLedger() } : {}),
            expectedPlanRevision: daemon.getPlanRevision(),
            expectedSnapshotSha256: registry.get(taskId)?.snapshotSha256 ?? '',
            sessionId: daemon.sessionId,
        };
    }

    async function sessionResolver({ taskId, snapshotSha256, workspaceRoot, workerModel, workerEffort } = {}) {
        if (enabled !== true) return { enabled: false };
        const root = canonicalRoot(daemon.workspaceRoot);
        if (workspaceRoot !== undefined && canonicalRoot(workspaceRoot) !== root) {
            throw identityError('A private workspace requires an isolated discussion factory');
        }
        const planRevision = daemon.getPlanRevision();
        const cacheKey = taskId + '|' + (snapshotSha256 ?? '') + '|' + planRevision
            + '|' + (workerModel ?? '') + '|' + (workerEffort ?? '');
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
            codex: { seedOptions: { cwd: root } },
            agy: { seedOptions: { cwd: root } },
            seeds, adapters,
            models: { ...models, agy: workerModel ?? models?.agy },
            efforts: { ...efforts, agy: workerEffort ?? efforts?.agy }, limits, workspaceRoot: root,
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

    async function createIsolatedDiscussion(context = {}) {
        if (isolatedClosing) throw identityError('Discussion host is shutting down');
        const workerRoot = canonicalRoot(context.workerRoot);
        if (workerRoot === canonicalRoot(daemon.workspaceRoot)
            || context.sessionId !== daemon.sessionId
            || context.planRevision !== daemon.getPlanRevision()
            || typeof context.authorize !== 'function'
            || !context.leaseId || !context.operationId
            || !context.taskId || !Number.isSafeInteger(context.attempt)
            || !/^[a-f0-9]{64}$/.test(context.reference?.bindingSha256 ?? '')
            || !/^[a-f0-9]{64}$/.test(context.workerContractSha256 ?? '')
            || context.workerContractSha256 !== context.reference.workerContractSha256
            || (context.reference.workerRoot && canonicalRoot(context.reference.workerRoot) !== workerRoot)
            || typeof context.workerBaselineId !== 'string' || !context.workerBaselineId) {
            throw identityError('Isolated discussion execution identity does not match authority');
        }
        const executionKey = sha256Utf8(JSON.stringify(['isolated', context.sessionId,
            context.taskId, context.planRevision, workerRoot, context.attempt,
            context.reference.bindingSha256, context.workerBaselineId, context.operationId]));
        const scope = JSON.stringify([context.sessionId, context.taskId]);
        const scopeChildren = scopedChildren.get(scope) ?? new Set();
        scopedChildren.set(scope, scopeChildren);
        const previousChildren = [...scopeChildren];
        const controller = new AbortController();
        const abort = () => controller.abort(context.signal?.reason);
        if (context.signal?.aborted) abort();
        else context.signal?.addEventListener('abort', abort, { once: true });
        let closing = false;
        let closePromise;
        let sessionPromise;
        let preparation;
        let snapshotSha256 = '';
        let bindings;
        const check = async () => {
            if (closing || controller.signal.aborted) throw identityError('Isolated discussion is closing');
            if (activeExecutions.get(scope) !== executionKey
                || daemon.sessionId !== context.sessionId
                || daemon.getPlanRevision() !== context.planRevision
                || await context.authorize() !== true) throw identityError('Isolated discussion execution is stale');
            if (canonicalRoot(context.workerRoot) !== workerRoot) throw identityError('Isolated discussion root changed');
            await (context.guards?.check ?? context.prespawnGuard)?.();
        };
        async function childAuthorityReader(args = {}) {
            let current = true;
            try { await check(); } catch { current = false; }
            const supplied = args.bindings ?? (args.binding ? [args.binding] : []);
            if (!bindings || supplied.length === 0 || supplied.some((binding) =>
                !bindings.some((expected) => bindingRef(expected) === bindingRef(binding)))) current = false;
            return { leaseEvents: await daemon.readLeaseEvents(),
                ...(daemon.readOperationRecords ? { operationRecords: await daemon.readOperationRecords() } : {}),
                ...(daemon.readOperationLedger ? { operationLedger: await daemon.readOperationLedger() } : {}),
                sessionId: context.sessionId,
                expectedPlanRevision: context.planRevision,
                expectedSnapshotSha256: current ? snapshotSha256 : '' };
        }
        const child = {
            enabled: true, executionKey, authorityReader: childAuthorityReader,
            async sessionResolver(request = {}) {
                await preparation;
                await check();
                if (!request.workspaceRoot || canonicalRoot(request.workspaceRoot) !== workerRoot
                    || request.taskId !== context.taskId || request.snapshotSha256 !== context.workerBaselineId) {
                    throw identityError('Isolated resolver request does not match its captured execution');
                }
                if (!sessionPromise) {
                    sessionPromise = seedSession();
                    // close() observes this promise even if its caller abandons it.
                    sessionPromise.catch(() => {});
                }
                return sessionPromise;
            },
            close() {
                if (closePromise) return closePromise;
                closing = true;
                controller.abort();
                closePromise = (async () => {
                    // Closing during asynchronous factory setup aborts it before
                    // seeds; that expected rejection is already observed by the
                    // factory caller and is not a quiescence failure.
                    try { await preparation; } catch (error) { child.seedFailure = error; }
                    if (sessionPromise) {
                        let session;
                        try { session = await sessionPromise; }
                        catch (error) {
                            // A failed seed has returned only after its tracked
                            // process drains; preserve its partial-ID diagnostics.
                            child.seedFailure = error;
                        }
                        if (session) await session.close();
                    }
                    await executionOptions?.assertQuiescent?.();
                    context.signal?.removeEventListener('abort', abort);
                    children.delete(child);
                    if (activeExecutions.get(scope) === executionKey) activeExecutions.delete(scope);
                    scopeChildren.delete(child);
                    if (scopeChildren.size === 0) scopedChildren.delete(scope);
                })();
                return closePromise;
            },
        };
        children.add(child);
        activeExecutions.set(scope, executionKey);
        scopeChildren.add(child);
        let executionOptions;
        preparation = (async () => {
            // Fence first, then wait for the old generation to abort/drain. New
            // seeds cannot start while an older execution is still pending.
            const previousResults = await Promise.allSettled(previousChildren.map((previous) => previous.close()));
            const previousFailure = previousResults.find((result) => result.status === 'rejected');
            if (previousFailure) throw previousFailure.reason;
            await check();
            executionOptions = await options.createExecutionOptions?.({ ...context, workerRoot,
                signal: controller.signal, prespawnGuard: check });
            if (!executionOptions?.trustedExecutionContext
                || canonicalRoot(executionOptions.trustedExecutionContext.workerRoot) !== workerRoot
                || typeof executionOptions.trustedExecutionContext.spawnImpl !== 'function'
                || typeof executionOptions.trustedExecutionContext.env?.GIT_CEILING_DIRECTORIES !== 'string'
                || !executionOptions.trustedExecutionContext.env.GIT_CEILING_DIRECTORIES
                || Object.keys(executionOptions.trustedExecutionContext.env).some((name) =>
                    ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'].includes(name.toUpperCase()))) {
                throw identityError('Isolated discussion requires a verified execution context');
            }
            await check();
        })();
        async function seedSession() {
            await check();
            const directory = safeDirectory(path.join(stateDir, 'isolated', executionKey));
            const text = JSON.stringify({ namespace: 'isolated', session_id: context.sessionId,
                task_id: context.taskId, plan_revision: context.planRevision, worker_root: workerRoot,
                workspace_baseline_id: context.workerBaselineId, attempt: context.attempt,
                workspace_binding_sha256: context.reference.bindingSha256,
                worker_contract_sha256: context.workerContractSha256, operation_id: context.operationId,
                lease_id: context.leaseId });
            const markerPath = directory + '.execution.json';
            const marker = { ...JSON.parse(text), status: 'seeding', pid: process.pid,
                createdAt: new Date().toISOString() };
            try {
                try { fs.writeFileSync(markerPath, JSON.stringify(marker), { flag: 'wx' }); }
                catch (error) {
                    if (error.code !== 'EEXIST' || !pruneOrphanMarker(markerPath)) throw error;
                    fs.writeFileSync(markerPath, JSON.stringify(marker), { flag: 'wx' });
                }
            } catch { throw identityError('Isolated generation already exists; recovery is required before reseeding'); }
            const partialConversationIds = {};
            const bracketSeed = (provider, seed) => {
                const recordSeed = async (args) => {
                    const result = await seed(args);
                    partialConversationIds[provider] = result.conversationId;
                    return result;
                };
                const guarded = context.guards?.wrapSeed ? context.guards.wrapSeed(recordSeed) : recordSeed;
                return async (args) => {
                    await check();
                    let failure;
                    try { return await guarded(args); }
                    catch (error) { failure = error; throw error; }
                    finally {
                        try { await check(); }
                        catch (error) {
                            if (failure) failure.guardError = error;
                            else throw error;
                        }
                    }
                };
            };
            const childSeeds = Object.fromEntries(['codex', 'agy'].map((provider) => {
                const seed = executionOptions.seeds?.[provider];
                if (typeof seed !== 'function') throw identityError('Missing isolated seed adapter');
                return [provider, bracketSeed(provider, seed)];
            }));
            const childAdapters = executionOptions.adapters;
            const probe = async ({ binding } = {}) => childAdapters?.[binding?.provider]
                ?.probeRecovery?.({ conversationId: binding.conversation_id }) ?? {};
            const childRecovery = executionOptions.recoveryProbes ?? {
                isProcessQuiescent: async (args) => (await probe(args)).processQuiescent === true,
                isProviderTerminal: async (args) => (await probe(args)).providerTerminal === true,
                providerOutcome: async (args) => (await probe(args)).providerOutcome ?? 'unknown',
            };
            let session;
            try { session = await createDiscussionSession({ enabled: true,
                sessionId: context.sessionId, taskId: context.taskId, planRevision: context.planRevision,
                snapshot: { text, sha256: sha256Utf8(text) }, stateDir: directory,
                execution: { attempt: context.attempt, workspace_binding_sha256: context.reference.bindingSha256 },
                hostPorts: createHostPorts(createDaemonHostDeps({ ...executionOptions,
                    authority: childAuthorityReader, authorize: context.authorize,
                    leaseId: context.leaseId, signal: controller.signal, prespawnGuard: check,
                    recoveryProbes: childRecovery })),
                codex: { seedOptions: { cwd: workerRoot } }, agy: { seedOptions: { cwd: workerRoot } },
                seeds: childSeeds, adapters: childAdapters,
                workspaceRoot: daemon.workspaceRoot,
                models: { ...(executionOptions.models ?? models), agy: context.workerModel
                    ?? resolveConfiguredWorkerModel(daemon.workspaceRoot, { ...options, model: executionOptions.models?.agy ?? models?.agy }) },
                efforts: { ...(executionOptions.efforts ?? efforts), agy: context.workerEffort
                    ?? resolveConfiguredWorkerEffort(daemon.workspaceRoot, { ...options, effort: executionOptions.efforts?.agy ?? efforts?.agy }) }, limits }); }
            catch (error) {
                error.details = { ...error.details, conversationIds: {
                    ...partialConversationIds, ...error.details?.conversationIds,
                } };
                try {
                    fs.writeFileSync(directory + '.seed-failure.json', JSON.stringify({
                        code: error.code ?? 'SEED_FAILED', conversation_ids: error.details?.conversationIds ?? {},
                    }), { flag: 'wx' });
                } catch (evidenceError) { error.evidenceError = evidenceError; }
                throw error;
            }
            try {
                await check();
                fs.writeFileSync(directory + '.manifest.json', JSON.stringify({
                    ...JSON.parse(text), discussion_snapshot_sha256: session.bindings[0].snapshot_sha256,
                    conversation_ids: session.conversationIds }), { flag: 'wx' });
                fs.writeFileSync(markerPath, JSON.stringify({ ...marker, status: 'complete' }));
                bindings = session.bindings;
                snapshotSha256 = session.bindings[0].snapshot_sha256;
                return session;
            } catch (error) {
                await session.close();
                throw error;
            }
        }
        try { await preparation; return child; }
        catch (error) {
            // No seed can have started while execution options are pending.
            children.delete(child);
            if (activeExecutions.get(scope) === executionKey) activeExecutions.delete(scope);
            scopeChildren.delete(child);
            if (scopeChildren.size === 0) scopedChildren.delete(scope);
            context.signal?.removeEventListener('abort', abort);
            throw error;
        }
    }

    async function closeAll() {
        isolatedClosing = true;
        const childResults = await Promise.allSettled([...children].map((child) => child.close()));
        const sessions = await Promise.allSettled(cache.values());
        const closed = await Promise.allSettled(sessions.filter((s) => s.status === 'fulfilled')
            .map((s) => s.value.close()));
        cache.clear();
        registry.clear();
        const failure = closed.find((result) => result.status === 'rejected');
        const childFailure = childResults.find((result) => result.status === 'rejected');
        if (childFailure) throw childFailure.reason;
        if (failure) throw failure.reason;
    }

    return { sessionResolver, authorityReader, createIsolatedDiscussion, closeAll };
}

module.exports = { createDiscussionHost };
