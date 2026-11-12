'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

function unavailable(message, cause) {
    const hint = ' (set OMNI_WORKER_WRITE_FENCE=off to accept unfenced workers)';
    return Object.assign(new Error(message + hint, cause ? { cause } : undefined), {
        code: 'DUAL_WORKER_WRITE_FENCE_UNAVAILABLE', category: 'PRECONDITION', kind: 'PRECONDITION',
    });
}

// Where the kernel would create a file written through a dangling symlink.
// Existing components are followed with realpath (so a symlinked directory is
// resolved as the kernel does). Below the first missing component the rest is
// purely lexical and stays under that existing prefix, unless a later '..'
// climbs out of it, which returns null (refused).
function danglingTarget(link) {
    let raw;
    try { raw = fs.readlinkSync(link); } catch { return null; }
    let current = path.isAbsolute(raw) ? path.parse(raw).root : fs.realpathSync.native(path.dirname(link));
    const parts = raw.split(/[\\/]+/).filter((part) => part && part !== '.');
    let missing = false;
    for (const part of parts) {
        if (part === '..') {
            if (missing) return null;
            current = path.dirname(current); continue;
        }
        const next = path.join(current, part);
        if (missing) { current = next; continue; }
        try { current = fs.realpathSync.native(next); } catch (cause) {
            if (cause.code !== 'ENOENT') return null;
            current = next; missing = true;
        }
    }
    return current;
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
                if (cause.code !== 'ENOENT') throw cause;
                try { fs.lstatSync(file); } catch (current) {
                    if (current.code === 'ENOENT') continue; // The link itself disappeared.
                    throw current;
                }
                // A dangling link (e.g. a removed skill still linked from
                // .claude/skills). Resolve where a write through it would land.
                target = danglingTarget(file);
                if (!target) {
                    throw unavailable(`Source tree contains an unresolvable dangling symlink (${path.relative(sourceRoot, file)}); refusing a possible outside write alias`);
                }
            }
            const relative = path.relative(sourceRoot, target);
            if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
                throw unavailable(`Source tree contains an external symlink (${path.relative(sourceRoot, file)}); refusing an outside write alias`);
            }
        } else if (stat.isFile() && stat.nlink !== 1) {
            throw unavailable('Source tree contains a shared inode; refusing an existing hardlink write escape');
        }
    }
}

// Explicit, informed opt-out (3.2.0): run workers and private validation
// without an OS source-write fence, as 3.1 did. Needed where no verified fence
// exists yet (Linux, Windows) or where the macOS fence refuses the tree
// (hardlinked dependency stores such as pnpm, very large trees). Integration
// still refuses conflicting source changes; nothing else is relaxed.
const OPT_OUT_ENV = 'OMNI_WORKER_WRITE_FENCE';
function fenceOptedOut(env) {
    return String(env?.[OPT_OUT_ENV] ?? '').trim().toLowerCase() === 'off';
}

// This is a source-write fence, not a general host/network sandbox. Native CLI
// runtime storage keeps its existing permissions. The controller is not fenced.
function createWorkerWriteFence({ sourceRoot, workerRoot, platform = process.platform,
    spawn = cp.spawn, probe = cp.spawnSync, env = process.env } = {}) {
    if (fenceOptedOut(env)) {
        return Object.freeze({
            backend: 'none', sourceRoot, workerRoot,
            spawn(command, commandArgs, options = {}) { return spawn(command, commandArgs, options); },
        });
    }
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
