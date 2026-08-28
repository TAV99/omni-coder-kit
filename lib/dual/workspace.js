'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

class DualWorkspaceError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DualWorkspaceError';
        this.code = code;
        this.details = details;
    }
}

function execGit(args, { cwd, encoding = 'utf8' } = {}) {
    const result = spawnSync('git', args, {
        cwd,
        encoding,
        shell: false,
        windowsHide: true,
    });
    if (result.error || result.status !== 0) {
        const stderr = result.stderr ? String(result.stderr).trim() : '';
        throw new DualWorkspaceError(
            'DUAL_GIT_ERROR',
            `Git command failed: git ${args.join(' ')}${stderr ? ` (${stderr})` : ''}`,
            { args, status: result.status }
        );
    }
    return result.stdout;
}

function parsePorcelainZ(text) {
    const records = String(text || '').split('\0');
    const paths = [];
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (!record) continue;
        const status = record.slice(0, 2);
        const file = record.slice(3);
        if (file) paths.push(file.replace(/\\/g, '/'));
        if (status.includes('R') || status.includes('C')) index += 1;
    }
    return paths;
}

function ensureInside(root, target, candidate) {
    const relative = path.relative(root, target);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        return;
    }
    throw new DualWorkspaceError(
        'DUAL_PATH_ESCAPE',
        `Path escapes repository: ${candidate}`,
        { candidate }
    );
}

function normalizeRepoPath(repoRoot, candidate) {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.includes('\0')) {
        throw new DualWorkspaceError('DUAL_PATH_ESCAPE', 'Repository path must be a non-empty string without NUL bytes.');
    }
    if (path.isAbsolute(candidate) || path.win32.isAbsolute(candidate) || path.posix.isAbsolute(candidate)) {
        throw new DualWorkspaceError('DUAL_PATH_ESCAPE', `Absolute repository path is forbidden: ${candidate}`);
    }

    const slashPath = candidate.replace(/\\/g, '/');
    const segments = slashPath.split('/');
    if (segments.some((segment) => segment === '..')) {
        throw new DualWorkspaceError('DUAL_PATH_ESCAPE', `Path traversal is forbidden: ${candidate}`);
    }

    const normalized = path.posix.normalize(slashPath).replace(/^\.\//, '');
    if (!normalized || normalized === '.' || normalized.startsWith('../')) {
        throw new DualWorkspaceError('DUAL_PATH_ESCAPE', `Invalid repository path: ${candidate}`);
    }

    const canonicalRoot = fs.realpathSync.native(repoRoot);
    const absoluteTarget = path.resolve(canonicalRoot, ...normalized.split('/'));
    ensureInside(canonicalRoot, absoluteTarget, candidate);

    let existing = absoluteTarget;
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) {
            throw new DualWorkspaceError('DUAL_PATH_ESCAPE', `Cannot resolve repository parent for: ${candidate}`);
        }
        existing = parent;
    }
    const canonicalExisting = fs.realpathSync.native(existing);
    ensureInside(canonicalRoot, canonicalExisting, candidate);

    if (fs.existsSync(absoluteTarget)) {
        ensureInside(canonicalRoot, fs.realpathSync.native(absoluteTarget), candidate);
    }
    return normalized;
}

function resolveWorkspace(cwd = process.cwd(), git = execGit) {
    let rawRoot;
    try {
        rawRoot = String(git(['rev-parse', '--show-toplevel'], { cwd })).trim();
    } catch (error) {
        throw new DualWorkspaceError('DUAL_NOT_GIT_REPOSITORY', 'Current directory is not inside a Git repository.', { cause: error.code });
    }
    const repoRoot = fs.realpathSync.native(rawRoot);

    let head;
    try {
        head = String(git(['rev-parse', 'HEAD'], { cwd: repoRoot })).trim();
    } catch (error) {
        throw new DualWorkspaceError('DUAL_GIT_HEAD_MISSING', 'Git repository must have an initial commit.', { cause: error.code });
    }

    const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repoRoot });
    const allChanges = parsePorcelainZ(status);
    const sourceChanges = allChanges.filter((file) => !file.startsWith('.omni/') && file !== '.omni').sort();
    return {
        repoRoot,
        head,
        sourceChanges,
    };
}

function assertBaseWorkspace({ repoRoot, expectedBaseCommit, excludedRunDir, execGit: git = execGit }) {
    const canonicalRoot = fs.realpathSync.native(repoRoot);
    const head = String(git(['rev-parse', 'HEAD'], { cwd: canonicalRoot })).trim();
    if (head !== expectedBaseCommit) {
        throw new DualWorkspaceError(
            'DUAL_BASE_COMMIT_STALE',
            `Repository HEAD changed from ${expectedBaseCommit} to ${head}.`,
            { expectedBaseCommit, head }
        );
    }

    const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: canonicalRoot });
    const excluded = excludedRunDir
        ? path.relative(canonicalRoot, path.resolve(excludedRunDir)).replace(/\\/g, '/').replace(/\/$/, '')
        : null;
    const changes = parsePorcelainZ(status)
        .filter((file) => !file.startsWith('.omni/') && file !== '.omni' && (!excluded || (file !== excluded && !file.startsWith(`${excluded}/`))))
        .sort();

    if (changes.length > 0) {
        throw new DualWorkspaceError(
            'DUAL_WORKTREE_DIRTY',
            `Source tree has changes outside the active transaction: ${changes.join(', ')}`,
            { changes }
        );
    }
    return { repoRoot: canonicalRoot, head, sourceChanges: [] };
}

function readNulPaths(bufferOrString) {
    if (!bufferOrString) return [];
    const text = Buffer.isBuffer(bufferOrString) ? bufferOrString.toString('utf8') : String(bufferOrString);
    return text.split('\0').filter(Boolean).map((file) => file.replace(/\\/g, '/'));
}

module.exports = {
    DualWorkspaceError,
    execGit,
    parsePorcelainZ,
    readNulPaths,
    resolveWorkspace,
    normalizeRepoPath,
    assertBaseWorkspace,
};
