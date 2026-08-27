'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_CONFIG_BYTES = 64 * 1024;
const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readBoundedJson(filePath, fsImpl) {
    try {
        const stat = fsImpl.statSync(filePath);
        if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
        const value = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
        return null;
    }
}

function normalizeForComparison(value) {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function validProjectId(value) {
    return typeof value === 'string' && PROJECT_ID_PATTERN.test(value) ? value : null;
}

function resolveRegisteredAgyProjectId(workspaceRoot, options = {}) {
    const fsImpl = options.fsImpl || fs;
    const homeDir = options.homeDir || os.homedir();
    const canonicalRoot = fsImpl.realpathSync?.native
        ? fsImpl.realpathSync.native(workspaceRoot)
        : fsImpl.realpathSync(workspaceRoot);

    const manifest = readBoundedJson(path.join(canonicalRoot, '.omni', 'manifest.json'), fsImpl);
    const manifestId = validProjectId(manifest?.agyProjectId);
    if (manifestId) return manifestId;

    const projects = readBoundedJson(path.join(homeDir, '.gemini', 'projects.json'), fsImpl)?.projects;
    if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return null;

    const expectedRoot = normalizeForComparison(canonicalRoot);
    for (const [registeredRoot, projectId] of Object.entries(projects)) {
        if (normalizeForComparison(registeredRoot) === expectedRoot) {
            return validProjectId(projectId);
        }
    }
    return null;
}

module.exports = {
    resolveRegisteredAgyProjectId,
};
