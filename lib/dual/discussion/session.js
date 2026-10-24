'use strict';

const {
    DiscussionError, validateId, validateSafeNonNegativeInt,
    validateBinding, validateBindingPair, validateSnapshot,
} = require('./contracts');
const { resolveConfiguredWorkerModel, resolveConfiguredWorkerEffort, workerConfigurationError } = require('../agy-model');
const { createDiscussionRelay } = require('./relay');
const { createCodexAdapter, seedCodexConversation } = require('./live-codex-invoke');
const { createAgyAdapter, seedAgyConversation } = require('./live-agy-invoke');

// Returns the relay's ordered pair: Astra first, Argon second.
// Explicit provider profiles can also come from the configured workspace.
function resolveWorkerConfiguration(options) {
    const seedOptions = options.agy?.seedOptions ?? {};
    const root = options.workspaceRoot ?? seedOptions.cwd;
    const configured = { ...seedOptions, ...options,
        workerModel: options.models?.agy ?? options.workerModel ?? seedOptions.workerModel,
        workerEffort: options.efforts?.agy ?? options.workerEffort ?? seedOptions.workerEffort,
        model: seedOptions.model, effort: seedOptions.effort };
    const model = resolveConfiguredWorkerModel(root, configured);
    const effort = resolveConfiguredWorkerEffort(root, configured);
    const error = workerConfigurationError(model, effort);
    if (error) throw new DiscussionError('DUAL_WORKER_CONFIGURATION_MISSING', error);
    return { model, effort };
}
function buildBindings({ sessionId, taskId, planRevision, snapshotSha256,
    codexConversationId, agyConversationId, models = {}, efforts = {}, workspaceRoot, execution }) {
    const worker = resolveWorkerConfiguration({ models, efforts, workspaceRoot });
    const shared = {
        session_id: sessionId,
        task_id: taskId,
        plan_revision: planRevision,
        snapshot_sha256: snapshotSha256,
        ...(execution !== undefined ? { execution } : {}),
    };
    const astra = validateBinding({
        ...shared, provider: 'codex', role: 'astra',
        model: models.codex ?? 'gpt-6.1-sol', effort: 'medium',
        conversation_id: codexConversationId,
    });
    const argon = validateBinding({
        ...shared, provider: 'agy', role: 'argon',
        model: worker.model, effort: worker.effort,
        conversation_id: agyConversationId,
    });
    return validateBindingPair([astra, argon], snapshotSha256).bindings;
}

async function createDiscussionSession(options = {}) {
    if (options.enabled !== true) {
        return { enabled: false };
    }

    validateId(options.sessionId, 'sessionId');
    validateId(options.taskId, 'taskId');
    validateSafeNonNegativeInt(options.planRevision, 'planRevision');
    const hostPorts = options.hostPorts;
    if (!hostPorts || typeof hostPorts !== 'object'
        || !hostPorts.authority || typeof hostPorts.authority !== 'object'
        || typeof hostPorts.authority.check !== 'function'
        || !hostPorts.capabilityVerifier || typeof hostPorts.capabilityVerifier !== 'object'
        || typeof hostPorts.capabilityVerifier.verify !== 'function'
        || typeof hostPorts.capabilityVerifier.verifyRecovery !== 'function') {
        throw new DiscussionError('INVALID_INPUT', 'hostPorts requires authority.check() and capabilityVerifier.verify()/verifyRecovery()');
    }
    if (typeof options.stateDir !== 'string' || options.stateDir.trim().length === 0) {
        throw new DiscussionError('INVALID_INPUT', 'stateDir must be a non-empty string');
    }

    const snapshot = validateSnapshot(options.snapshot, options.limits);
    const codex = options.codex || {};
    const agy = options.agy || {};
    const seeds = options.seeds || {};
    const worker = resolveWorkerConfiguration(options);
    const conversationIds = {};
    try {
        conversationIds.codex = codex.conversationId
            ?? (await (seeds.codex ?? seedCodexConversation)(codex.seedOptions)).conversationId;
        conversationIds.agy = agy.conversationId
            ?? (await (seeds.agy ?? seedAgyConversation)({ ...agy.seedOptions, ...worker,
                workerModel: worker.model, workerEffort: worker.effort })).conversationId;
        const bindings = buildBindings({
            sessionId: options.sessionId,
            taskId: options.taskId,
            planRevision: options.planRevision,
            snapshotSha256: snapshot.sha256,
            codexConversationId: conversationIds.codex,
            agyConversationId: conversationIds.agy,
            models: { ...options.models, agy: worker.model },
            efforts: { ...options.efforts, agy: worker.effort },
            execution: options.execution,
        });
        const adapterOptions = options.adapterOptions || {};
        const adapters = options.adapters || {
            codex: createCodexAdapter(adapterOptions.codex),
            agy: createAgyAdapter(adapterOptions.agy),
        };
        const relay = await createDiscussionRelay({
            enabled: true,
            stateDir: options.stateDir,
            bindings,
            snapshot,
            adapters,
            authority: hostPorts.authority,
            capabilityVerifier: hostPorts.capabilityVerifier,
            limits: options.limits,
            clock: options.clock,
            syncHook: options.syncHook,
        });

        return {
            enabled: true,
            relay,
            bindings,
            conversationIds,
            async close() {
                await relay.close();
            },
        };
    } catch (err) {
        err.details = { ...(err.details || {}), conversationIds: { ...conversationIds } };
        throw err;
    }
}

module.exports = { createDiscussionSession, buildBindings };
