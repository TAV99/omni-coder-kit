'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
    DualWorkspaceError,
    execGit,
} = require('./workspace');
const {
    createGitBaseline,
} = require('./baseline-git');

const SAFE_HEAD_REF_PATTERN = /^refs\/heads\//u;
const SAFE_BRANCH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;

function isSafeHeadRef(value) {
    if (typeof value !== 'string' || !SAFE_HEAD_REF_PATTERN.test(value)) return false;
    const branch = value.slice('refs/heads/'.length);
    if (branch.length === 0 || branch.length > 1024) return false;
    return branch.split('/').every((segment) => (
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.startsWith('.') &&
        !segment.endsWith('.') &&
        !segment.endsWith('.lock') &&
        SAFE_BRANCH_SEGMENT_PATTERN.test(segment)
    )) && !branch.includes('..');
}

function hasGitMetadata(root, fsImpl) {
    let current = path.resolve(root);
    while (true) {
        if (fsImpl.existsSync(path.join(current, '.git'))) return true;
        const parent = path.dirname(current);
        if (parent === current) return false;
        current = parent;
    }
}

function gitExitStatus(error) {
    const status = error && error.details && error.details.status;
    return Number.isInteger(status) ? status : null;
}

function gitProbeFailure(message, details = {}) {
    return new DualWorkspaceError('DUAL_GIT_PROBE_FAILED', message, details);
}

function detectBaselineBackend(root = process.cwd(), deps = {}) {
    const runner = deps.gitRunner || deps.execGit || execGit;
    const fsImpl = deps.fsImpl || fs;
    let rawTopLevel;
    try {
        rawTopLevel = runner(['rev-parse', '--show-toplevel'], { cwd: root });
    } catch (error) {
        if (hasGitMetadata(root, fsImpl)) {
            throw gitProbeFailure('Git repository metadata exists, but its top-level could not be verified.', {
                operation: 'rev-parse --show-toplevel',
                status: gitExitStatus(error),
            });
        }
        return 'snapshot';
    }

    const topLevel = String(rawTopLevel || '').trim();
    if (!topLevel) {
        if (hasGitMetadata(root, fsImpl)) {
            throw gitProbeFailure('Git repository metadata exists, but Git returned an empty root.', {
                operation: 'rev-parse --show-toplevel',
            });
        }
        return 'snapshot';
    }

    let canonicalTopLevel;
    let canonicalRoot;
    try {
        canonicalTopLevel = fsImpl.realpathSync.native(topLevel);
        if (fsImpl.existsSync(root)) {
            canonicalRoot = fsImpl.realpathSync.native(root);
        } else {
            canonicalRoot = path.resolve(root);
        }
    } catch (error) {
        if (hasGitMetadata(root, fsImpl)) {
            throw gitProbeFailure('Git repository metadata exists, but its root could not be canonicalized.', {
                operation: 'canonicalize Git root',
                status: gitExitStatus(error),
            });
        }
        return 'snapshot';
    }

    if (!fsImpl.existsSync(canonicalTopLevel) || !fsImpl.statSync(canonicalTopLevel).isDirectory()) {
        return 'snapshot';
    }

    const relative = path.relative(canonicalTopLevel, canonicalRoot);
    const isInsideOrSame = relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    if (!isInsideOrSame) {
        return 'snapshot';
    }

    // A repository with no commits still has a valid top-level directory. Git
    // must prove that this is the narrow, safe unborn case before snapshot
    // mode is selected; malformed refs and permission failures stay fatal.
    let rawHead;
    try {
        rawHead = runner(['rev-parse', 'HEAD'], { cwd: canonicalTopLevel });
    } catch (error) {
        if (gitExitStatus(error) !== 128) {
            throw gitProbeFailure('Unable to determine Git HEAD safely.', {
                operation: 'rev-parse HEAD',
                status: gitExitStatus(error),
            });
        }

        let rawRef;
        try {
            rawRef = runner(['symbolic-ref', '--quiet', 'HEAD'], { cwd: canonicalTopLevel });
        } catch (refError) {
            throw gitProbeFailure('Git HEAD is missing, but its symbolic branch could not be verified.', {
                operation: 'symbolic-ref HEAD',
                status: gitExitStatus(refError),
            });
        }

        const headRef = String(rawRef || '').trim();
        if (!isSafeHeadRef(headRef)) {
            throw gitProbeFailure('Git HEAD does not point to a safe refs/heads branch.', {
                operation: 'symbolic-ref HEAD',
                ref: headRef,
            });
        }

        try {
            runner(['show-ref', '--verify', '--quiet', headRef], { cwd: canonicalTopLevel });
        } catch (refError) {
            // `show-ref --verify --quiet` uses status 1 for an absent ref. Any
            // other status means the missing branch was not positively proven.
            if (gitExitStatus(refError) === 1) return 'snapshot';
            throw gitProbeFailure('Git HEAD branch could not be verified as genuinely absent.', {
                operation: 'show-ref --verify --quiet',
                ref: headRef,
                status: gitExitStatus(refError),
            });
        }

        throw gitProbeFailure('Git HEAD is missing while its symbolic branch exists.', {
            operation: 'show-ref --verify --quiet',
            ref: headRef,
            status: 0,
        });
    }

    if (!String(rawHead || '').trim()) {
        throw gitProbeFailure('Git HEAD probe returned no commit identity.', {
            operation: 'rev-parse HEAD',
        });
    }

    return 'git';
}

function createBaseline(options = {}) {
    const {
        root = process.cwd(),
        backend,
        gitRunner,
        execGit: customGit,
        snapshotFactory,
        ...rest
    } = options;

    const runner = gitRunner || customGit;
    const selectedBackend = backend || detectBaselineBackend(root, { gitRunner: runner, ...rest });

    if (selectedBackend === 'git') {
        return createGitBaseline({ root, gitRunner: runner, ...rest });
    }

    if (selectedBackend === 'snapshot') {
        if (typeof snapshotFactory === 'function') {
            return snapshotFactory({ root, ...rest });
        }
        throw new DualWorkspaceError(
            'DUAL_BASELINE_BACKEND_UNSUPPORTED',
            'Snapshot baseline backend is not configured or factory missing.',
            { backend: selectedBackend }
        );
    }

    throw new DualWorkspaceError(
        'DUAL_BASELINE_BACKEND_UNKNOWN',
        `Unknown baseline backend: ${selectedBackend}`,
        { backend: selectedBackend }
    );
}

module.exports = {
    detectBaselineBackend,
    createBaseline,
    createGitBaseline,
};
