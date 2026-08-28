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

function detectBaselineBackend(root = process.cwd(), deps = {}) {
    const runner = deps.gitRunner || deps.execGit || execGit;
    let rawTopLevel;
    try {
        rawTopLevel = runner(['rev-parse', '--show-toplevel'], { cwd: root });
    } catch {
        return 'snapshot';
    }

    const topLevel = String(rawTopLevel || '').trim();
    if (!topLevel) {
        return 'snapshot';
    }

    let canonicalTopLevel;
    let canonicalRoot;
    try {
        canonicalTopLevel = fs.realpathSync.native(topLevel);
        if (fs.existsSync(root)) {
            canonicalRoot = fs.realpathSync.native(root);
        } else {
            canonicalRoot = path.resolve(root);
        }
    } catch {
        return 'snapshot';
    }

    if (!fs.existsSync(canonicalTopLevel) || !fs.statSync(canonicalTopLevel).isDirectory()) {
        return 'snapshot';
    }

    const relative = path.relative(canonicalTopLevel, canonicalRoot);
    const isInsideOrSame = relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    if (!isInsideOrSame) {
        return 'snapshot';
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
