'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suffixEffort, rejectsEffort, effortConflict } = require('../squad/runtimes/agy-effort');
const claudeRuntime = require('../squad/runtimes/claude');
const { readBinding } = require('../squad/bindings');

const MAX_CONFIG_BYTES = 64 * 1024;

function readBoundedJson(filePath, fsImpl = fs) {
    try {
        const stat = fsImpl.statSync(filePath);
        if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
        const value = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

function canonicalRoot(workspaceRoot, fsImpl) {
    try {
        return fsImpl.realpathSync?.native ? fsImpl.realpathSync.native(workspaceRoot)
            : (fsImpl.realpathSync ? fsImpl.realpathSync(workspaceRoot) : path.resolve(workspaceRoot));
    } catch {
        return path.resolve(workspaceRoot);
    }
}

// The squad binding of a named worker (SPEC-SQUAD-P5 §3.1): a plan task's
// `worker` picks its runtime/model/effort. null when unnamed or not bound, so
// legacy projects keep the manifest (worker-1) path.
function boundWorker(workspaceRoot, workerId, fsImpl = fs) {
    if (typeof workerId !== 'string' || !workerId.trim() || !workspaceRoot) return null;
    try {
        return readBinding(canonicalRoot(workspaceRoot, fsImpl), { fsImpl })?.roles.worker.find((w) => w.id === workerId.trim()) || null;
    } catch {
        return null;
    }
}

// Verified capability for a task's worker: extra workers are probed at plan
// registration into details.workers; the primary worker keeps the agy_* fields.
function workerCapability(details, workerId) {
    const extra = typeof workerId === 'string' && details?.workers?.[workerId];
    return extra ? { version: extra.version, model: extra.model } : { version: details?.agy_version, model: details?.agy_model };
}

function resolveConfiguredWorkerModel(workspaceRoot, options = {}) {
    const fsImpl = options.fsImpl || fs;

    if (options.workerModel && typeof options.workerModel === 'string' && options.workerModel.trim()) {
        return options.workerModel.trim();
    }
    if (options.targetModel && typeof options.targetModel === 'string' && options.targetModel.trim()) {
        return options.targetModel.trim();
    }
    if (options.model && typeof options.model === 'string' && options.model.trim()) {
        return options.model.trim();
    }
    const bound = boundWorker(workspaceRoot, options.worker, fsImpl);
    if (bound) return bound.model;

    if (workspaceRoot) {
        let canonicalRoot;
        try {
            canonicalRoot = fsImpl.realpathSync?.native
                ? fsImpl.realpathSync.native(workspaceRoot)
                : (fsImpl.realpathSync ? fsImpl.realpathSync(workspaceRoot) : path.resolve(workspaceRoot));
        } catch {
            canonicalRoot = path.resolve(workspaceRoot);
        }

        const manifest = readBoundedJson(path.join(canonicalRoot, '.omni', 'manifest.json'), fsImpl);
        if (manifest && typeof manifest.workerModel === 'string' && manifest.workerModel.trim()) {
            return manifest.workerModel.trim();
        }
    }

    if (process.env.OMNI_DUAL_WORKER_MODEL && process.env.OMNI_DUAL_WORKER_MODEL.trim()) {
        return process.env.OMNI_DUAL_WORKER_MODEL.trim();
    }

    return null;
}

function resolveConfiguredWorkerEffort(workspaceRoot, options = {}) {
    const fsImpl = options.fsImpl || fs;

    if (options.workerEffort && typeof options.workerEffort === 'string' && options.workerEffort.trim()) {
        return options.workerEffort.trim();
    }
    if (options.targetEffort && typeof options.targetEffort === 'string' && options.targetEffort.trim()) {
        return options.targetEffort.trim();
    }
    if (options.effort && typeof options.effort === 'string' && options.effort.trim()) {
        return options.effort.trim();
    }
    const bound = boundWorker(workspaceRoot, options.worker, fsImpl);
    if (bound) return bound.effort ?? null;

    if (workspaceRoot) {
        let canonicalRoot;
        try {
            canonicalRoot = fsImpl.realpathSync?.native
                ? fsImpl.realpathSync.native(workspaceRoot)
                : (fsImpl.realpathSync ? fsImpl.realpathSync(workspaceRoot) : path.resolve(workspaceRoot));
        } catch {
            canonicalRoot = path.resolve(workspaceRoot);
        }

        const manifest = readBoundedJson(path.join(canonicalRoot, '.omni', 'manifest.json'), fsImpl);
        if (manifest && typeof manifest.workerEffort === 'string' && manifest.workerEffort.trim()) {
            return manifest.workerEffort.trim();
        }
    }

    if (process.env.OMNI_DUAL_WORKER_EFFORT && process.env.OMNI_DUAL_WORKER_EFFORT.trim()) {
        return process.env.OMNI_DUAL_WORKER_EFFORT.trim();
    }

    return null;
}

// Which CLI fills the worker slot (SPEC-SQUAD-P3 §4.4). Same precedence as the
// model: explicit option, .omni/manifest.json workerRuntime, env, then agy.
function resolveConfiguredWorkerRuntime(workspaceRoot, options = {}) {
    const fsImpl = options.fsImpl || fs;
    if (typeof options.workerRuntime === 'string' && options.workerRuntime.trim()) return options.workerRuntime.trim();
    const bound = boundWorker(workspaceRoot, options.worker, fsImpl);
    if (bound) return bound.runtime;
    if (workspaceRoot) {
        let canonicalRoot;
        try {
            canonicalRoot = fsImpl.realpathSync?.native
                ? fsImpl.realpathSync.native(workspaceRoot)
                : (fsImpl.realpathSync ? fsImpl.realpathSync(workspaceRoot) : path.resolve(workspaceRoot));
        } catch {
            canonicalRoot = path.resolve(workspaceRoot);
        }
        const manifest = readBoundedJson(path.join(canonicalRoot, '.omni', 'manifest.json'), fsImpl);
        if (manifest && typeof manifest.workerRuntime === 'string' && manifest.workerRuntime.trim()) {
            return manifest.workerRuntime.trim();
        }
    }
    if (process.env.OMNI_DUAL_WORKER_RUNTIME && process.env.OMNI_DUAL_WORKER_RUNTIME.trim()) {
        return process.env.OMNI_DUAL_WORKER_RUNTIME.trim();
    }
    return 'agy';
}

// Discussion bindings always carry an effort string; a model that takes none
// (agy Claude) records this marker, which never reaches argv.
// The CLI bound to the orchestrator slot (SPEC-SQUAD-P4 §5): option, then
// .omni/manifest.json orchestratorRuntime/Model/Effort, then env, then codex.
// Only a claude orchestrator carries a model; codex keeps its built-in default.
function resolveConfiguredOrchestrator(workspaceRoot, options = {}) {
    const fsImpl = options.fsImpl || fs;
    let manifest = null;
    if (workspaceRoot) {
        let canonicalRoot;
        try {
            canonicalRoot = fsImpl.realpathSync?.native ? fsImpl.realpathSync.native(workspaceRoot) : path.resolve(workspaceRoot);
        } catch {
            canonicalRoot = path.resolve(workspaceRoot);
        }
        manifest = readBoundedJson(path.join(canonicalRoot, '.omni', 'manifest.json'), fsImpl);
    }
    const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
    const runtime = text(options.orchestratorRuntime) || text(manifest?.orchestratorRuntime)
        || text(process.env.OMNI_DUAL_ORCHESTRATOR_RUNTIME) || 'codex';
    if (runtime !== 'claude') return { runtime };
    return { runtime, model: text(manifest?.orchestratorModel) || 'sonnet', effort: text(manifest?.orchestratorEffort) };
}

const MODEL_DEFAULT_EFFORT = 'model-default';

const configuredEffort = (effort) => (typeof effort === 'string' && effort.trim() && effort.trim() !== MODEL_DEFAULT_EFFORT
    ? effort.trim() : null);

// Effort to record for a worker turn: the configured one, else the model's level
// suffix, else the marker.
function effectiveWorkerEffort(model, effort, runtime = 'agy') {
    const suffix = runtime === 'agy' && typeof model === 'string' && suffixEffort(model.trim());
    return configuredEffort(effort) || suffix || MODEL_DEFAULT_EFFORT;
}

// Effort is required only where the model leaves it open: a level suffix
// (`-high`) already fixes it and Claude models via agy refuse it (SPEC-SQUAD-P3 H7).
// Those are agy rules; a claude worker takes any model with an optional effort
// from its own list (SPEC-SQUAD-P4 §4).
function workerConfigurationError(model, effort, runtime = 'agy') {
    const hasModel = typeof model === 'string' && model.trim().length > 0;
    const hasEffort = configuredEffort(effort) !== null;
    if (runtime === 'claude') {
        if (!hasModel) return 'Missing claude worker model. Configure task.model, .omni/manifest.json workerModel or OMNI_DUAL_WORKER_MODEL.';
        return hasEffort && !claudeRuntime.efforts.includes(effort.trim())
            ? `claude does not accept effort "${effort.trim()}" (${claudeRuntime.efforts.join(', ')}). Change or clear task.effort, .omni/manifest.json workerEffort or OMNI_DUAL_WORKER_EFFORT.`
            : null;
    }
    const missing = [];
    if (!hasModel) missing.push('model');
    if (!hasEffort && !(hasModel && (suffixEffort(model.trim()) || rejectsEffort(model.trim())))) missing.push('effort');
    if (missing.length) {
        return `Missing AGY worker ${missing.join(' and ')}. Configure task.model / task.effort, .omni/manifest.json workerModel / workerEffort, or OMNI_DUAL_WORKER_MODEL / OMNI_DUAL_WORKER_EFFORT.`;
    }
    const conflict = hasEffort ? effortConflict(model.trim(), effort.trim()) : null;
    return conflict ? `${conflict}. Change or clear task.effort, .omni/manifest.json workerEffort or OMNI_DUAL_WORKER_EFFORT.` : null;
}

// --effort for a dual worker call. A matching suffix effort is still passed so
// argv stays as before; a missing one is simply left out.
function workerEffortArgs(effort) {
    const value = configuredEffort(effort);
    return value ? ['--effort', value] : [];
}

module.exports = {
    MODEL_DEFAULT_EFFORT,
    effectiveWorkerEffort,
    workerConfigurationError,
    workerEffortArgs,
    resolveConfiguredWorkerModel,
    resolveConfiguredWorkerEffort,
    resolveConfiguredWorkerRuntime,
    resolveConfiguredOrchestrator,
    boundWorker,
    workerCapability,
};
