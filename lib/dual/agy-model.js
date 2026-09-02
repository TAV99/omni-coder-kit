'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_WORKER_MODEL = 'gemini-3.7-flash-high';
const DEFAULT_WORKER_EFFORT = 'high';
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
    if (process.env.OMNI_DUAL_WORKER_MODEL && process.env.OMNI_DUAL_WORKER_MODEL.trim()) {
        return process.env.OMNI_DUAL_WORKER_MODEL.trim();
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

    return DEFAULT_WORKER_MODEL;
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
    if (process.env.OMNI_DUAL_WORKER_EFFORT && process.env.OMNI_DUAL_WORKER_EFFORT.trim()) {
        return process.env.OMNI_DUAL_WORKER_EFFORT.trim();
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

    return DEFAULT_WORKER_EFFORT;
}

module.exports = {
    DEFAULT_WORKER_MODEL,
    DEFAULT_WORKER_EFFORT,
    resolveConfiguredWorkerModel,
    resolveConfiguredWorkerEffort,
};
