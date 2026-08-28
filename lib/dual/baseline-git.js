'use strict';

const fs = require('node:fs');

const {
    BaselineIdentitySchema,
    parseContract,
} = require('./contracts');
const {
    DualWorkspaceError,
    execGit,
    readNulPaths,
    normalizeRepoPath,
} = require('./workspace');
const {
    captureDiffFingerprint,
    assertAllowedDiff,
} = require('./scope-guard');

function resolveCanonicalRoot(root, runner) {
    let rawRoot;
    try {
        rawRoot = String(runner(['rev-parse', '--show-toplevel'], { cwd: root })).trim();
    } catch (error) {
        throw new DualWorkspaceError(
            'DUAL_NOT_GIT_REPOSITORY',
            'Current directory is not inside a Git repository.',
            { cause: error.code || error.message }
        );
    }
    if (!rawRoot) {
        throw new DualWorkspaceError('DUAL_NOT_GIT_REPOSITORY', 'Current directory is not inside a Git repository.');
    }
    return fs.realpathSync.native(rawRoot);
}

function validateGitIdentityAndHead(identity, canonicalRoot, runner) {
    if (!identity || typeof identity !== 'object' || identity.kind !== 'git') {
        throw new DualWorkspaceError(
            'DUAL_BASELINE_KIND_INVALID',
            `Git baseline requires git identity kind, received: ${identity ? identity.kind : typeof identity}`,
            { identity }
        );
    }
    parseContract(BaselineIdentitySchema, identity, 'baseline identity');

    let currentHead;
    try {
        currentHead = String(runner(['rev-parse', 'HEAD'], { cwd: canonicalRoot })).trim();
    } catch (error) {
        throw new DualWorkspaceError(
            'DUAL_GIT_HEAD_MISSING',
            'Git repository must have an initial commit.',
            { cause: error.code || error.message }
        );
    }
    if (currentHead !== identity.id) {
        throw new DualWorkspaceError(
            'DUAL_BASE_COMMIT_STALE',
            `Repository HEAD changed from ${identity.id} to ${currentHead}.`,
            { expectedBaseCommit: identity.id, head: currentHead }
        );
    }
    return { canonicalRoot, head: currentHead };
}

function createGitBaseline({ root = process.cwd(), gitRunner, execGit: customGit, excludedPaths: defaultExcludedPaths = [] } = {}) {
    const runner = gitRunner || customGit || execGit;

    function capture() {
        const canonicalRoot = resolveCanonicalRoot(root, runner);
        let head;
        try {
            head = String(runner(['rev-parse', 'HEAD'], { cwd: canonicalRoot })).trim();
        } catch (error) {
            throw new DualWorkspaceError(
                'DUAL_GIT_HEAD_MISSING',
                'Git repository must have an initial commit.',
                { cause: error.code || error.message }
            );
        }
        const identity = { kind: 'git', id: head };
        return parseContract(BaselineIdentitySchema, identity, 'baseline identity');
    }

    function diff(identity, options = {}) {
        const canonicalRoot = resolveCanonicalRoot(root, runner);
        validateGitIdentityAndHead(identity, canonicalRoot, runner);

        const excludedList = options.excludedPaths !== undefined ? options.excludedPaths : defaultExcludedPaths;
        const excluded = (excludedList || []).map((item) => String(item).replace(/\\/g, '/').replace(/\/+$/, ''));
        const isExcluded = (file) => excluded.some((prefix) => file === prefix || file.startsWith(`${prefix}/`));

        const pathspecs = ['.'];
        for (const prefix of excluded) {
            pathspecs.push(`:(exclude)${prefix}`, `:(exclude)${prefix}/**`);
        }

        const trackedRaw = runner(
            ['diff', '--name-only', '-z', identity.id, '--', ...pathspecs],
            { cwd: canonicalRoot, encoding: null }
        );
        const untrackedRaw = runner(
            ['ls-files', '--others', '--exclude-standard', '-z'],
            { cwd: canonicalRoot, encoding: null }
        );

        const trackedNames = readNulPaths(trackedRaw).filter((file) => !isExcluded(file));
        const untrackedNames = readNulPaths(untrackedRaw).filter((file) => !isExcluded(file));

        const allFiles = [...new Set([...trackedNames, ...untrackedNames])];
        const normalized = allFiles.map((file) => normalizeRepoPath(canonicalRoot, file));
        const uniqueNormalized = [...new Set(normalized)].sort();

        return uniqueNormalized.map((file) => ({ path: file }));
    }

    function fingerprint(identity, options = {}) {
        const canonicalRoot = resolveCanonicalRoot(root, runner);
        validateGitIdentityAndHead(identity, canonicalRoot, runner);

        const excludedPaths = options.excludedPaths !== undefined ? options.excludedPaths : defaultExcludedPaths;
        return captureDiffFingerprint({
            repoRoot: canonicalRoot,
            baseCommit: identity.id,
            excludedPaths,
            execGit: runner,
        });
    }

    function assertScope(identityOrOptions, maybeOptions = {}) {
        let identity;
        let opts;
        if (identityOrOptions && typeof identityOrOptions === 'object' && 'kind' in identityOrOptions) {
            identity = identityOrOptions;
            opts = maybeOptions || {};
        } else if (identityOrOptions && typeof identityOrOptions === 'object') {
            identity = identityOrOptions.identity;
            opts = identityOrOptions;
        } else {
            opts = maybeOptions || {};
        }

        if (!identity) {
            throw new DualWorkspaceError(
                'DUAL_SCOPE_IDENTITY_MISSING',
                'assertScope requires a valid Git baseline identity.'
            );
        }

        const diffResults = diff(identity, { excludedPaths: opts.excludedPaths });
        const changedFiles = diffResults.map((entry) => entry.path);

        return assertAllowedDiff({
            changedFiles,
            allowedFiles: opts.allowedFiles || [],
            denyPatterns: opts.denyPatterns || [],
        });
    }

    return {
        root,
        backend: 'git',
        capture,
        diff,
        fingerprint,
        assertScope,
    };
}

module.exports = {
    createGitBaseline,
    resolveCanonicalRoot,
    validateGitIdentityAndHead,
};
