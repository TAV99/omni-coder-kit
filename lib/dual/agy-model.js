'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suffixEffort, rejectsEffort, effortConflict } = require('../squad/runtimes/agy-effort');

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

// Effort is required only where the model leaves it open: a level suffix
// (`-high`) already fixes it and Claude models via agy refuse it (SPEC-SQUAD-P3 H7).
function workerConfigurationError(model, effort) {
    const hasModel = typeof model === 'string' && model.trim().length > 0;
    const hasEffort = typeof effort === 'string' && effort.trim().length > 0;
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
    return typeof effort === 'string' && effort.trim() ? ['--effort', effort.trim()] : [];
}

module.exports = {
    workerConfigurationError,
    workerEffortArgs,
    resolveConfiguredWorkerModel,
    resolveConfiguredWorkerEffort,
};
