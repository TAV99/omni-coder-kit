'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const { createSnapshotBaseline, normalizeBuildOutputPrefix } = require('./baseline-snapshot');
const { DualWorkspaceError } = require('./workspace');

const MAX_POLICY_BYTES = 256 * 1024;

function readBoundedJson(filePath, label, fsImpl = fs) {
    if (!fsImpl.existsSync(filePath)) return null;
    const stat = fsImpl.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_POLICY_BYTES) {
        throw new DualWorkspaceError(
            'DUAL_SNAPSHOT_POLICY_INVALID',
            `${label} must be a regular JSON file no larger than ${MAX_POLICY_BYTES} bytes`,
            { filePath, size: stat.size },
        );
    }
    try {
        const value = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('root must be an object');
        return value;
    } catch (error) {
        if (error && error.code === 'DUAL_SNAPSHOT_POLICY_INVALID') throw error;
        throw new DualWorkspaceError(
            'DUAL_SNAPSHOT_POLICY_INVALID',
            `${label} is not valid JSON: ${error.message}`,
            { filePath },
        );
    }
}

function resolveSnapshotBuildOutputs(workspaceRoot, { fsImpl = fs } = {}) {
    const root = path.resolve(workspaceRoot);
    const packageJson = readBoundedJson(path.join(root, 'package.json'), 'package.json', fsImpl) || {};
    const manifest = readBoundedJson(path.join(root, '.omni', 'manifest.json'), '.omni/manifest.json', fsImpl) || {};
    const outputs = new Set();

    if (manifest.snapshotBuildOutputs !== undefined) {
        if (!Array.isArray(manifest.snapshotBuildOutputs)) {
            throw new DualWorkspaceError(
                'DUAL_SNAPSHOT_POLICY_INVALID',
                'snapshotBuildOutputs must be an array of repository-relative path prefixes',
            );
        }
        for (const entry of manifest.snapshotBuildOutputs) outputs.add(normalizeBuildOutputPrefix(entry));
    }

    const dependencies = {
        ...(packageJson.dependencies || {}),
        ...(packageJson.devDependencies || {}),
    };
    const scriptsText = Object.values(packageJson.scripts || {}).filter((value) => typeof value === 'string').join('\n');
    const hasTool = (dependencyName, expression) => Object.hasOwn(dependencies, dependencyName) || expression.test(scriptsText);

    if (hasTool('vite', /(?:^|[\s;&|])vite(?:\s|$)/m)) outputs.add('dist');
    if (hasTool('next', /(?:^|[\s;&|])next\s+(?:build|export)(?:\s|$)/m)) outputs.add('.next');
    if (hasTool('react-scripts', /(?:^|[\s;&|])react-scripts\s+build(?:\s|$)/m)) outputs.add('build');
    if (/\b(?:vitest|jest)\b[^\n]*--coverage\b|\bnyc\b/.test(scriptsText)) outputs.add('coverage');

    return [...outputs].map(normalizeBuildOutputPrefix).sort();
}

const DEFAULT_RUNTIME_EXCLUDES = [
    '.omni/runs',
    '.omni/runtime',
    '.omni/codex-gemini',
    '.omni/benchmarks',
    '.omni/v4',
    '.omni/run',
    '.omni/state',
];

function createConfiguredSnapshotBaseline({
    root,
    fsImpl = fs,
    cryptoImpl = crypto,
} = {}) {
    const rawExcluded = resolveSnapshotBuildOutputs(root, { fsImpl });
    const excludedSet = new Set([...DEFAULT_RUNTIME_EXCLUDES, ...rawExcluded]);
    const excludedPaths = [...excludedSet].sort();
    return {
        baseline: createSnapshotBaseline({
            root,
            fsImpl,
            cryptoImpl,
            ignorePolicy: { buildOutputs: excludedPaths },
        }),
        excludedPaths,
    };
}

module.exports = {
    MAX_POLICY_BYTES,
    createConfiguredSnapshotBaseline,
    resolveSnapshotBuildOutputs,
};
