'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

function unavailable(message, cause) {
    return Object.assign(new Error(message, cause ? { cause } : undefined), {
        code: 'DUAL_WORKER_WRITE_FENCE_UNAVAILABLE', category: 'PRECONDITION', kind: 'PRECONDITION',
    });
}

function assertIndependentSourceTree(sourceRoot) {
    const pending = [sourceRoot];
    let inspected = 0;
    while (pending.length) {
        if (++inspected > 200000) throw unavailable('Source tree exceeds write-fence inspection bounds');
        const file = pending.pop();
        let stat;
        try { stat = fs.lstatSync(file); } catch (cause) {
            if (cause.code === 'ENOENT') continue; // A concurrently finalized artifact no longer aliases an inode.
            throw cause;
        }
        if (stat.isDirectory()) {
            let entries;
            try { entries = fs.readdirSync(file); } catch (cause) {
                if (cause.code === 'ENOENT') continue;
                throw cause;
            }
            for (const entry of entries) pending.push(path.join(file, entry));
        } else if (stat.isSymbolicLink()) {
            let target;
            try { target = fs.realpathSync.native(file); } catch (cause) {
                if (cause.code === 'ENOENT') {
                    try { fs.lstatSync(file); } catch (current) {
                        if (current.code === 'ENOENT') continue; // The link itself disappeared.
                        throw current;
                    }
                }
                throw cause; // An existing dangling link is still unsupported.
            }
            const relative = path.relative(sourceRoot, target);
            if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
                throw unavailable('Source tree contains an external symlink; refusing an outside write alias');
            }
        } else if (stat.isFile() && stat.nlink !== 1) {
            throw unavailable('Source tree contains a shared inode; refusing an existing hardlink write escape');
        }
    }
}

// This is a source-write fence, not a general host/network sandbox. Native CLI
// runtime storage keeps its existing permissions. The controller is not fenced.
function createWorkerWriteFence({ sourceRoot, workerRoot, platform = process.platform,
    spawn = cp.spawn, probe = cp.spawnSync } = {}) {
    let source, worker;
    try {
        source = fs.realpathSync.native(sourceRoot);
        worker = fs.realpathSync.native(workerRoot);
    } catch (cause) {
        throw unavailable('Cannot bind the worker write fence to existing directories', cause);
    }
    const relative = path.relative(source, worker);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw unavailable('Worker write fence requires a private subtree of the source root');
    }
    if (platform !== 'darwin') {
        throw unavailable(`No verified worker source-write fence is available on ${platform}; refusing unfenced execution`);
    }
    const sourceIdentity = fs.statSync(source);
    const workerIdentity = fs.statSync(worker);
    const anchors = new Set([worker]);
    for (let current = source; ; current = path.dirname(current)) {
        anchors.add(current);
        if (current === path.dirname(current)) break;
    }
    const anchorPaths = [...anchors];
    const profile = [
        '(version 1)', '(allow default)',
        '(deny file-write* (require-all (subpath (param "SOURCE_ROOT")) (require-not (subpath (param "WORKER_ROOT")))))',
        // A writable hardlink could otherwise alias a protected source inode.
        '(deny file-link)',
        '(deny file-write-unlink ' + anchorPaths.map((_, i) => `(literal (param "ANCHOR_${i}"))`).join(' ') + ')',
    ].join('\n');
    const args = ['-D', `SOURCE_ROOT=${source}`, '-D', `WORKER_ROOT=${worker}`,
        ...anchorPaths.flatMap((value, i) => ['-D', `ANCHOR_${i}=${value}`]), '-p', profile];
    try { assertIndependentSourceTree(source); } catch (cause) {
        if (cause.code === 'DUAL_WORKER_WRITE_FENCE_UNAVAILABLE') throw cause;
        throw unavailable('Cannot verify source-tree inode isolation', cause);
    }
    let check;
    try {
        check = probe(SANDBOX_EXEC, [...args, '/usr/bin/true'], {
            shell: false, stdio: 'pipe', timeout: 5000, maxBuffer: 16384,
        });
    } catch (cause) {
        throw unavailable('Cannot verify the worker source-write fence', cause);
    }
    if (check.error || check.status !== 0) {
        throw unavailable('Worker source-write fence is unavailable or its OS policy was rejected; refusing unfenced execution', check.error);
    }
    return Object.freeze({
        backend: 'macos-seatbelt', sourceRoot: source, workerRoot: worker,
        spawn(command, commandArgs, options = {}) {
            if (options.shell) throw unavailable('Worker source-write fence cannot use an outer shell');
            try {
                const currentSource = fs.statSync(source), currentWorker = fs.statSync(worker);
                if (fs.realpathSync.native(source) !== source || fs.realpathSync.native(worker) !== worker
                    || currentSource.dev !== sourceIdentity.dev || currentSource.ino !== sourceIdentity.ino
                    || currentWorker.dev !== workerIdentity.dev || currentWorker.ino !== workerIdentity.ino) {
                    throw new Error('Directory binding changed');
                }
                assertIndependentSourceTree(source);
            } catch (cause) {
                throw unavailable('Worker source-write fence directory binding changed', cause);
            }
            return spawn(SANDBOX_EXEC, [...args, command, ...commandArgs], { ...options, shell: false });
        },
    });
}

module.exports = { createWorkerWriteFence };
