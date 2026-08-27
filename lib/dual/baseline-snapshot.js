'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
    BaselineIdentitySchema,
    parseContract,
} = require('./contracts');
const {
    DualWorkspaceError,
    normalizeRepoPath,
} = require('./workspace');
const {
    assertAllowedDiff,
} = require('./scope-guard');

const DEFAULT_IGNORED_DIRS = new Set(['.git', 'node_modules']);
const DEFAULT_IGNORED_FILENAMES = new Set([
    '.ds_store',
    'thumbs.db',
    'desktop.ini',
    'ehthumbs.db',
]);

function isDefaultIgnoredFile(fileName) {
    const lower = fileName.toLowerCase();
    if (DEFAULT_IGNORED_FILENAMES.has(lower)) {
        return true;
    }
    if (
        lower.endsWith('~') ||
        lower.endsWith('.swp') ||
        lower.endsWith('.swo') ||
        lower.endsWith('.tmp') ||
        lower.endsWith('.bak') ||
        lower.startsWith('.#')
    ) {
        return true;
    }
    return false;
}

function normalizePathPrefix(candidate, label = 'Path') {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
        throw new DualWorkspaceError(
            'DUAL_PATH_ESCAPE',
            `${label} ignore prefix must be a non-empty string without NUL bytes.`,
            { candidate }
        );
    }
    if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || path.posix.isAbsolute(candidate)) {
        throw new DualWorkspaceError(
            'DUAL_PATH_ESCAPE',
            `Absolute ignore path is forbidden: ${candidate}`,
            { candidate }
        );
    }

    const slashPath = candidate.replace(/\\/g, '/');
    const segments = slashPath.split('/');
    if (segments.some((segment) => segment === '..')) {
        throw new DualWorkspaceError(
            'DUAL_PATH_ESCAPE',
            `Path traversal in ignore pattern is forbidden: ${candidate}`,
            { candidate }
        );
    }

    const normalized = path.posix.normalize(slashPath).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!normalized || normalized === '.' || normalized.startsWith('../')) {
        throw new DualWorkspaceError(
            'DUAL_PATH_ESCAPE',
            `Invalid ignore pattern prefix: ${candidate}`,
            { candidate }
        );
    }
    return normalized;
}

function normalizeBuildOutputPrefix(candidate) {
    return normalizePathPrefix(candidate, 'Build output');
}

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function validateManifestEntry(file, seenPaths) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) {
        throw new DualWorkspaceError(
            'DUAL_SNAPSHOT_BASELINE_INVALID',
            'Manifest file entry must be a valid object.'
        );
    }

    const allowedEntryKeys = new Set(['path', 'type', 'size', 'hash', 'sha256']);
    for (const key of Object.keys(file)) {
        if (!allowedEntryKeys.has(key)) {
            throw new DualWorkspaceError(
                'DUAL_SNAPSHOT_BASELINE_INVALID',
                `Undeclared key in manifest file entry: ${key}`,
                { path: typeof file.path === 'string' ? file.path : undefined, key }
            );
        }
    }

    const filePath = file.path;
    if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
        throw new DualWorkspaceError(
            'DUAL_SNAPSHOT_BASELINE_INVALID',
            'Manifest entry path must be a non-empty string without NUL bytes.'
        );
    }

    if (
        filePath.includes('\\') ||
        filePath.startsWith('/') ||
        filePath.endsWith('/') ||
        /^[a-zA-Z]:/.test(filePath) ||
        filePath.startsWith('//')
    ) {
        throw new DualWorkspaceError(
            'DUAL_SNAPSHOT_BASELINE_INVALID',
            `Manifest entry path is not a safe normalized POSIX relative path: ${filePath}`,
            { path: filePath }
        );
    }

    const segments = filePath.split('/');
    if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
        throw new DualWorkspaceError(
            'DUAL_SNAPSHOT_BASELINE_INVALID',
            `Manifest entry path contains invalid traversal or empty segments: ${filePath}`,
            { path: filePath }
        );
    }

    if (path.posix.normalize(filePath) !== filePath) {
        throw new DualWorkspaceError(
            'DUAL_SNAPSHOT_BASELINE_INVALID',
            `Manifest entry path is not normalized: ${filePath}`,
            { path: filePath }
        );
    }

    if (seenPaths.has(filePath)) {
        throw new DualWorkspaceError(
            'DUAL_SNAPSHOT_BASELINE_INVALID',
            `Duplicate path in manifest: ${filePath}`,
            { path: filePath }
        );
    }
    seenPaths.add(filePath);

    if (file.type !== 'file') {
        throw new DualWorkspaceError(
            'DUAL_SNAPSHOT_BASELINE_INVALID',
            `Manifest entry type must be literal 'file', received: ${file.type}`,
            { path: filePath, type: file.type }
        );
    }

    if (
        typeof file.size !== 'number' ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0
    ) {
        throw new DualWorkspaceError(
            'DUAL_SNAPSHOT_BASELINE_INVALID',
            `Manifest entry size must be a safe non-negative integer, received: ${file.size}`,
            { path: filePath }
        );
    }

    const hash = file.hash;
    const sha256 = file.sha256;

    if (!hash && !sha256) {
        throw new DualWorkspaceError(
            'DUAL_SNAPSHOT_BASELINE_INVALID',
            `Manifest entry must contain hash or sha256: ${filePath}`,
            { path: filePath }
        );
    }

    if (hash !== undefined && (typeof hash !== 'string' || !SHA256_HEX_PATTERN.test(hash))) {
        throw new DualWorkspaceError(
            'DUAL_SNAPSHOT_BASELINE_INVALID',
            `Manifest entry hash must be a 64-character lowercase hex string: ${filePath}`,
            { path: filePath }
        );
    }

    if (sha256 !== undefined && (typeof sha256 !== 'string' || !SHA256_HEX_PATTERN.test(sha256))) {
        throw new DualWorkspaceError(
            'DUAL_SNAPSHOT_BASELINE_INVALID',
            `Manifest entry sha256 must be a 64-character lowercase hex string: ${filePath}`,
            { path: filePath }
        );
    }

    if (hash !== undefined && sha256 !== undefined && hash !== sha256) {
        throw new DualWorkspaceError(
            'DUAL_SNAPSHOT_BASELINE_INVALID',
            `Manifest entry hash and sha256 do not match: ${filePath}`,
            { path: filePath }
        );
    }
}

function ensureInsideRoot(canonicalRoot, targetPath, candidateDescription) {
    const relative = path.relative(canonicalRoot, targetPath);
    if (
        relative === '' ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    ) {
        return;
    }
    throw new DualWorkspaceError(
        'DUAL_PATH_ESCAPE',
        `Path escapes repository root: ${candidateDescription} -> ${targetPath}`,
        { candidate: candidateDescription, target: targetPath }
    );
}

function hashFileStreamSync(filePath, cryptoImpl, fsImpl, bufferSize = 64 * 1024) {
    const fd = fsImpl.openSync(filePath, 'r');
    const hash = cryptoImpl.createHash('sha256');
    const buffer = Buffer.alloc(bufferSize);
    let bytesRead = 0;
    try {
        while ((bytesRead = fsImpl.readSync(fd, buffer, 0, bufferSize, null)) > 0) {
            hash.update(buffer.subarray(0, bytesRead));
        }
    } finally {
        fsImpl.closeSync(fd);
    }
    return hash.digest('hex');
}

function computeSnapshotRootHash(entries, cryptoImpl = crypto) {
    const hash = cryptoImpl.createHash('sha256');
    hash.update('dual-snapshot-v1\0');
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const entry of sorted) {
        hash.update(entry.path);
        hash.update('\0');
        hash.update(String(entry.type || 'file'));
        hash.update('\0');
        hash.update(String(entry.size));
        hash.update('\0');
        hash.update(String(entry.hash || entry.sha256));
        hash.update('\0');
    }
    return hash.digest('hex');
}

function computeSnapshotManifestFingerprint(
    initialIdentity,
    initialManifest,
    currentIdentity,
    currentManifest,
    { excludedPaths = [], cryptoImpl = crypto } = {}
) {
    const snap = createSnapshotBaseline({ root: process.cwd(), cryptoImpl });
    const baselineFiles = snap.validateSnapshotIdentityAndManifest(initialIdentity, initialManifest);
    const currentFiles = snap.validateSnapshotIdentityAndManifest(currentIdentity, currentManifest);

    if (excludedPaths !== undefined && excludedPaths !== null) {
        if (!Array.isArray(excludedPaths)) {
            throw new DualWorkspaceError(
                'DUAL_PATH_ESCAPE',
                'excludedPaths option must be an array of path prefixes.',
                { excludedPaths }
            );
        }
    }

    const excludedList = (excludedPaths || []).map((item) =>
        normalizePathPrefix(item, 'Excluded')
    );
    const isExcluded = (filePath) =>
        excludedList.some((prefix) => filePath === prefix || filePath.startsWith(`${prefix}/`));

    const baselineMap = new Map();
    for (const file of baselineFiles) {
        baselineMap.set(file.path, file);
    }

    const currentMap = new Map();
    for (const file of currentFiles) {
        currentMap.set(file.path, file);
    }

    const changes = [];

    for (const [posixPath, baseFile] of baselineMap.entries()) {
        if (isExcluded(posixPath)) {
            continue;
        }
        if (!currentMap.has(posixPath)) {
            changes.push({ path: posixPath, change: 'deleted', initial: baseFile });
        } else {
            const currFile = currentMap.get(posixPath);
            if (
                currFile.hash !== (baseFile.hash || baseFile.sha256) ||
                currFile.size !== baseFile.size ||
                currFile.type !== baseFile.type
            ) {
                changes.push({ path: posixPath, change: 'modified', initial: baseFile, current: currFile });
            }
        }
    }

    for (const [posixPath, currFile] of currentMap.entries()) {
        if (isExcluded(posixPath)) {
            continue;
        }
        if (!baselineMap.has(posixPath)) {
            changes.push({ path: posixPath, change: 'created', current: currFile });
        }
    }

    changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const hash = cryptoImpl.createHash('sha256');
    hash.update(String(initialIdentity.id));
    hash.update('\0');

    for (const item of changes) {
        hash.update(item.path);
        hash.update('\0');
        hash.update(item.change);
        hash.update('\0');

        if (item.change === 'deleted') {
            hash.update(item.initial.type);
            hash.update('\0');
            hash.update(String(item.initial.size));
            hash.update('\0');
            hash.update(String(item.initial.hash || item.initial.sha256));
            hash.update('\0');
        } else {
            hash.update(item.current.type);
            hash.update('\0');
            hash.update(String(item.current.size));
            hash.update('\0');
            hash.update(String(item.current.hash || item.current.sha256));
            hash.update('\0');
        }
    }

    return {
        files: changes.map((c) => c.path),
        patchSha256: hash.digest('hex'),
    };
}

function createSnapshotBaseline({
    root = process.cwd(),
    fsImpl = fs,
    cryptoImpl = crypto,
    ignorePolicy = {},
} = {}) {
    if (!root || typeof root !== 'string' || root.trim().length === 0) {
        throw new DualWorkspaceError(
            'DUAL_SNAPSHOT_ROOT_INVALID',
            'Snapshot root must be a non-empty string path.',
            { root }
        );
    }

    let canonicalRoot;
    try {
        if (!fsImpl.existsSync(root)) {
            throw new DualWorkspaceError(
                'DUAL_SNAPSHOT_ROOT_INVALID',
                `Snapshot root directory does not exist: ${root}`,
                { root }
            );
        }
        canonicalRoot = fsImpl.realpathSync.native
            ? fsImpl.realpathSync.native(root)
            : fsImpl.realpathSync(root);
    } catch (err) {
        if (err instanceof DualWorkspaceError) throw err;
        throw new DualWorkspaceError(
            'DUAL_SNAPSHOT_ROOT_INVALID',
            `Failed to canonicalize snapshot root: ${root}`,
            { cause: err.code || err.message, root }
        );
    }

    const rootStat = fsImpl.statSync(canonicalRoot);
    if (!rootStat.isDirectory()) {
        throw new DualWorkspaceError(
            'DUAL_NOT_DIRECTORY',
            `Snapshot root must be a directory: ${root}`,
            { root }
        );
    }

    const buildOutputIgnores = (ignorePolicy.buildOutputs || []).map(normalizeBuildOutputPrefix);

    function isPathIgnored(posixRelativePath, isDir, fileName) {
        if (isDir && DEFAULT_IGNORED_DIRS.has(fileName)) {
            return true;
        }
        if (
            posixRelativePath === '.omni/runtime' ||
            posixRelativePath.startsWith('.omni/runtime/') ||
            posixRelativePath === '.omni/runs' ||
            posixRelativePath.startsWith('.omni/runs/') ||
            posixRelativePath === '.omni/codex-gemini/runs' ||
            posixRelativePath.startsWith('.omni/codex-gemini/runs/')
        ) {
            return true;
        }
        for (const buildPrefix of buildOutputIgnores) {
            if (posixRelativePath === buildPrefix || posixRelativePath.startsWith(`${buildPrefix}/`)) {
                return true;
            }
        }
        if (!isDir && isDefaultIgnoredFile(fileName)) {
            return true;
        }
        return false;
    }

    function scanWorkspaceFiles() {
        const fileEntries = [];
        const visitedDirs = new Set([canonicalRoot]);

        function traverse(currentDir, currentRelPath) {
            let dirents;
            try {
                dirents = fsImpl.readdirSync(currentDir, { withFileTypes: true });
            } catch (err) {
                throw new DualWorkspaceError(
                    'DUAL_DIRECTORY_READ_ERROR',
                    `Failed to read directory: ${currentDir}`,
                    { cause: err.code || err.message, path: currentRelPath }
                );
            }

            const sortedDirents = [...dirents].sort((a, b) =>
                a.name < b.name ? -1 : a.name > b.name ? 1 : 0
            );

            for (const dirent of sortedDirents) {
                const name = dirent.name;
                const fullPath = path.join(currentDir, name);
                const posixRel = currentRelPath ? `${currentRelPath}/${name}` : name;

                let lstat;
                try {
                    lstat = fsImpl.lstatSync(fullPath);
                } catch (err) {
                    if (err instanceof DualWorkspaceError) throw err;
                    throw new DualWorkspaceError(
                        'DUAL_FILE_STAT_ERROR',
                        `Failed to stat file or directory: ${posixRel}`,
                        { path: posixRel, cause: err.code || err.message }
                    );
                }

                if (lstat.isSymbolicLink()) {
                    let realTarget;
                    try {
                        realTarget = fsImpl.realpathSync.native
                            ? fsImpl.realpathSync.native(fullPath)
                            : fsImpl.realpathSync(fullPath);
                    } catch (err) {
                        throw new DualWorkspaceError(
                            'DUAL_PATH_ESCAPE',
                            `Cannot resolve symlink target: ${posixRel}`,
                            { path: posixRel, cause: err.code || err.message }
                        );
                    }

                    ensureInsideRoot(canonicalRoot, realTarget, posixRel);

                    let targetStat;
                    try {
                        targetStat = fsImpl.statSync(realTarget);
                    } catch (err) {
                        throw new DualWorkspaceError(
                            'DUAL_PATH_ESCAPE',
                            `Failed to stat symlink target: ${posixRel} -> ${realTarget}`,
                            { path: posixRel, target: realTarget, cause: err.code || err.message }
                        );
                    }

                    if (targetStat.isDirectory()) {
                        if (isPathIgnored(posixRel, true, name)) {
                            continue;
                        }
                        if (visitedDirs.has(realTarget)) {
                            continue;
                        }
                        visitedDirs.add(realTarget);
                        traverse(fullPath, posixRel);
                    } else if (targetStat.isFile()) {
                        if (isPathIgnored(posixRel, false, name)) {
                            continue;
                        }
                        const hash = hashFileStreamSync(fullPath, cryptoImpl, fsImpl);
                        fileEntries.push({
                            path: posixRel,
                            type: 'file',
                            size: targetStat.size,
                            hash,
                            sha256: hash,
                        });
                    }
                } else if (lstat.isDirectory()) {
                    if (isPathIgnored(posixRel, true, name)) {
                        continue;
                    }
                    let canonicalSubDir;
                    try {
                        canonicalSubDir = fsImpl.realpathSync.native
                            ? fsImpl.realpathSync.native(fullPath)
                            : fsImpl.realpathSync(fullPath);
                    } catch {
                        canonicalSubDir = path.resolve(fullPath);
                    }
                    ensureInsideRoot(canonicalRoot, canonicalSubDir, posixRel);
                    if (visitedDirs.has(canonicalSubDir)) {
                        continue;
                    }
                    visitedDirs.add(canonicalSubDir);
                    traverse(fullPath, posixRel);
                } else if (lstat.isFile()) {
                    if (isPathIgnored(posixRel, false, name)) {
                        continue;
                    }
                    const hash = hashFileStreamSync(fullPath, cryptoImpl, fsImpl);
                    fileEntries.push({
                        path: posixRel,
                        type: 'file',
                        size: lstat.size,
                        hash,
                        sha256: hash,
                    });
                }
            }
        }

        traverse(canonicalRoot, '');
        return fileEntries;
    }

    function capture() {
        const rawEntries = scanWorkspaceFiles();
        const sortedEntries = rawEntries.sort((a, b) =>
            a.path < b.path ? -1 : a.path > b.path ? 1 : 0
        );

        const frozenEntries = sortedEntries.map((e) =>
            Object.freeze({
                path: e.path,
                type: e.type,
                size: e.size,
                hash: e.hash,
                sha256: e.hash,
            })
        );

        const manifest = Object.freeze({
            schema_version: 1,
            files: Object.freeze(frozenEntries),
        });

        const rootHash = computeSnapshotRootHash(frozenEntries, cryptoImpl);
        const identity = Object.freeze(
            parseContract(
                BaselineIdentitySchema,
                { kind: 'snapshot', id: rootHash },
                'baseline identity'
            )
        );

        return {
            identity,
            manifest,
        };
    }

    function validateSnapshotIdentityAndManifest(identity, manifest) {
        if (!identity || typeof identity !== 'object' || identity.kind !== 'snapshot') {
            throw new DualWorkspaceError(
                'DUAL_BASELINE_KIND_INVALID',
                `Snapshot baseline requires snapshot identity kind, received: ${identity ? identity.kind : typeof identity}`,
                { identity }
            );
        }
        parseContract(BaselineIdentitySchema, identity, 'baseline identity');

        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
            throw new DualWorkspaceError(
                'DUAL_SNAPSHOT_BASELINE_INVALID',
                'Snapshot baseline requires a valid manifest object with schema_version 1 and files array.',
                { manifest: typeof manifest }
            );
        }

        if (manifest.schema_version !== 1) {
            throw new DualWorkspaceError(
                'DUAL_SNAPSHOT_BASELINE_INVALID',
                `Snapshot manifest schema_version must be 1, received: ${manifest.schema_version}`,
                { schema_version: manifest.schema_version }
            );
        }

        if (!Array.isArray(manifest.files)) {
            throw new DualWorkspaceError(
                'DUAL_SNAPSHOT_BASELINE_INVALID',
                'Snapshot manifest must contain a files array.',
                { files: typeof manifest.files }
            );
        }

        const allowedManifestKeys = new Set(['schema_version', 'files']);
        for (const key of Object.keys(manifest)) {
            if (!allowedManifestKeys.has(key)) {
                throw new DualWorkspaceError(
                    'DUAL_SNAPSHOT_BASELINE_INVALID',
                    `Undeclared top-level key in manifest: ${key}`,
                    { key }
                );
            }
        }

        const manifestFiles = manifest.files;
        const seenPaths = new Set();
        for (const file of manifestFiles) {
            validateManifestEntry(file, seenPaths);
        }

        for (let i = 1; i < manifestFiles.length; i++) {
            if (manifestFiles[i - 1].path >= manifestFiles[i].path) {
                throw new DualWorkspaceError(
                    'DUAL_SNAPSHOT_BASELINE_INVALID',
                    `Manifest entries must be unique and sorted in POSIX ascending order: ${manifestFiles[i - 1].path} >= ${manifestFiles[i].path}`,
                    { path: manifestFiles[i].path }
                );
            }
        }

        const expectedRootHash = computeSnapshotRootHash(manifestFiles, cryptoImpl);
        if (expectedRootHash !== identity.id) {
            throw new DualWorkspaceError(
                'DUAL_SNAPSHOT_BASELINE_INVALID',
                `Snapshot identity ${identity.id} does not match manifest hash ${expectedRootHash}.`,
                { identityId: identity.id, expectedId: expectedRootHash }
            );
        }

        return manifestFiles;
    }

    function diff(identity, manifest, options = {}) {
        const baselineFiles = validateSnapshotIdentityAndManifest(identity, manifest);
        const currentFiles = scanWorkspaceFiles();

        if (options.excludedPaths !== undefined && options.excludedPaths !== null) {
            if (!Array.isArray(options.excludedPaths)) {
                throw new DualWorkspaceError(
                    'DUAL_PATH_ESCAPE',
                    'excludedPaths option must be an array of path prefixes.',
                    { excludedPaths: options.excludedPaths }
                );
            }
        }
        const excludedList = (options.excludedPaths || []).map((item) =>
            normalizePathPrefix(item, 'Excluded')
        );
        const isExcluded = (filePath) =>
            excludedList.some((prefix) => filePath === prefix || filePath.startsWith(`${prefix}/`));

        const baselineMap = new Map();
        for (const file of baselineFiles) {
            baselineMap.set(file.path, file);
        }

        const currentMap = new Map();
        for (const file of currentFiles) {
            currentMap.set(file.path, file);
        }

        const changes = [];

        for (const [posixPath, baseFile] of baselineMap.entries()) {
            if (isExcluded(posixPath)) {
                continue;
            }
            if (!currentMap.has(posixPath)) {
                changes.push({ path: posixPath, change: 'deleted' });
            } else {
                const currFile = currentMap.get(posixPath);
                if (
                    currFile.hash !== (baseFile.hash || baseFile.sha256) ||
                    currFile.size !== baseFile.size ||
                    currFile.type !== baseFile.type
                ) {
                    changes.push({ path: posixPath, change: 'modified' });
                }
            }
        }

        for (const [posixPath] of currentMap.entries()) {
            if (isExcluded(posixPath)) {
                continue;
            }
            if (!baselineMap.has(posixPath)) {
                changes.push({ path: posixPath, change: 'created' });
            }
        }

        changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        return changes;
    }

    function fingerprint(identity, manifest, options = {}) {
        const currentSnapshot = capture();
        return computeSnapshotManifestFingerprint(
            identity,
            manifest,
            currentSnapshot.identity,
            currentSnapshot.manifest,
            {
                excludedPaths: options.excludedPaths,
                cryptoImpl,
            }
        );
    }

    function assertScope(identityOrOptions, maybeManifestOrOptions, maybeOptions = {}) {
        let identity;
        let manifest;
        let opts;

        if (identityOrOptions && typeof identityOrOptions === 'object' && identityOrOptions.kind === 'snapshot') {
            identity = identityOrOptions;
            manifest = maybeManifestOrOptions;
            opts = maybeOptions || {};
        } else if (identityOrOptions && typeof identityOrOptions === 'object' && identityOrOptions.identity) {
            identity = identityOrOptions.identity;
            manifest = identityOrOptions.manifest || maybeManifestOrOptions;
            opts = identityOrOptions;
        } else {
            opts = maybeOptions || {};
        }

        if (!identity) {
            throw new DualWorkspaceError(
                'DUAL_SCOPE_IDENTITY_MISSING',
                'assertScope requires a valid snapshot baseline identity.'
            );
        }

        if (!manifest) {
            throw new DualWorkspaceError(
                'DUAL_SNAPSHOT_BASELINE_INVALID',
                'assertScope requires a valid snapshot baseline manifest.'
            );
        }

        const diffResults = diff(identity, manifest, { excludedPaths: opts.excludedPaths });
        const changedFiles = diffResults.map((entry) => entry.path);

        return assertAllowedDiff({
            changedFiles,
            allowedFiles: opts.allowedFiles || [],
            denyPatterns: opts.denyPatterns || [],
        });
    }

    return {
        root: canonicalRoot,
        backend: 'snapshot',
        capture,
        diff,
        fingerprint,
        assertScope,
        validateSnapshotIdentityAndManifest,
        computeSnapshotManifestFingerprint,
    };
}

module.exports = {
    createSnapshotBaseline,
    computeSnapshotRootHash,
    computeSnapshotManifestFingerprint,
    validateSnapshotIdentityAndManifest: (identity, manifest, cryptoImpl = crypto) => {
        const snap = createSnapshotBaseline({ root: process.cwd(), cryptoImpl });
        return snap.validateSnapshotIdentityAndManifest(identity, manifest);
    },
    validateManifestEntry,
    isDefaultIgnoredFile,
    normalizeBuildOutputPrefix,
};
