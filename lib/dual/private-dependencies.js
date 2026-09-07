'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateTaskPath } = require('./task-workspace');
const { createArtifactStore } = require('./artifacts');
const { createCliResolver } = require('./setup-command');
const { resolveSetupInvocation } = require('./setup-runner');
const { spawnBoundedProcess } = require('./capability-preflight');

const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }

function inputs(workerRoot) {
    if (fs.existsSync(path.join(workerRoot, 'npm-shrinkwrap.json'))) {
        fail('DUAL_PRIVATE_SETUP_INVALID', 'Private npm-ci requires package-lock.json without a competing shrinkwrap');
    }
    const hashes = {};
    for (const file of ['package.json', 'package-lock.json']) {
        validateTaskPath(workerRoot, file);
        const target = path.join(workerRoot, file);
        if (!fs.existsSync(target) || !fs.statSync(target).isFile() || fs.statSync(target).size > 16 * 1024 * 1024) {
            fail('DUAL_PRIVATE_SETUP_INVALID', 'Private npm setup requires bounded package and lock files');
        }
        const bytes = fs.readFileSync(target);
        let data;
        try { data = JSON.parse(bytes.toString('utf8')); } catch { fail('DUAL_PRIVATE_SETUP_INVALID', 'Invalid private package JSON'); }
        if (file === 'package.json' && data.workspaces) fail('DUAL_PRIVATE_SETUP_INVALID', 'Private npm-ci currently requires a single-package lock');
        function checkReferences(value, key = '') {
            if (typeof value === 'string' && (value.startsWith('file:') || value.startsWith('link:'))) {
                let relative;
                try { relative = decodeURIComponent(value.slice(value.indexOf(':') + 1)); }
                catch { fail('DUAL_PRIVATE_SETUP_INVALID', 'Malformed local dependency reference'); }
                try { validateTaskPath(workerRoot, relative); }
                catch { fail('DUAL_PRIVATE_SETUP_INVALID', 'Local dependency escapes private snapshot'); }
            } else if (value && typeof value === 'object') {
                for (const [childKey, child] of Object.entries(value)) {
                    if (key === 'packages' && childKey) {
                        try { validateTaskPath(workerRoot, childKey); }
                        catch { fail('DUAL_PRIVATE_SETUP_INVALID', 'Unsafe package-lock path'); }
                    }
                    checkReferences(child, childKey);
                }
            }
        }
        checkReferences(data);
        hashes[file] = hash(bytes);
    }
    return hashes;
}

function dependencyFingerprint(workerRoot) {
    validateTaskPath(workerRoot, 'node_modules');
    const root = path.join(workerRoot, 'node_modules');
    const digest = crypto.createHash('sha256');
    const chunkBuffer = Buffer.alloc(1024 * 1024);
    const MAX_FILES = 50000;
    const MAX_DEPTH = 64;
    const MAX_FILE_BYTES = 256 * 1024 * 1024;
    const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
    let count = 0, total = 0;
    function walk(directory, relative, depth) {
        if (depth > MAX_DEPTH) fail('DUAL_PRIVATE_SETUP_LIMIT', `Dependency depth at ${relative || '.'}: observed=${depth}, cap=${MAX_DEPTH}`);
        for (const name of fs.readdirSync(directory).sort()) {
            const file = relative ? `${relative}/${name}` : name;
            const target = path.join(directory, name), stat = fs.lstatSync(target);
            // npm bin links may point to sibling packages, never outside node_modules.
            if (stat.isSymbolicLink()) {
                const real = fs.realpathSync.native(target);
                const contained = path.relative(root, real);
                if (contained.startsWith('..') || path.isAbsolute(contained)) fail('DUAL_PATH_ESCAPE', 'Dependency link escapes private install');
                digest.update(`${file}\0link\0${fs.readlinkSync(target)}\0`);
            } else if (stat.isDirectory()) walk(target, file, depth + 1);
            else if (stat.isFile()) {
                if (++count > MAX_FILES) {
                    fail('DUAL_PRIVATE_SETUP_LIMIT', `Dependency count at ${file}: observed=${count}, cap=${MAX_FILES}`);
                }
                if (stat.size > MAX_FILE_BYTES) {
                    fail('DUAL_PRIVATE_SETUP_LIMIT', `Dependency file at ${file}: observed=${stat.size}, cap=${MAX_FILE_BYTES}`);
                }
                const fd = fs.openSync(target, 'r');
                let fileSha256;
                try {
                    const before = fs.fstatSync(fd);
                    if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino
                        || before.size !== stat.size || before.mode !== stat.mode
                        || before.mtimeMs !== stat.mtimeMs || before.ctimeMs !== stat.ctimeMs) {
                        fail('DUAL_PRIVATE_SETUP_DRIFT', `Dependency changed before read at ${file}`);
                    }
                    const fileDigest = crypto.createHash('sha256');
                    let fileBytes = 0;
                    while (true) {
                        const bytesRead = fs.readSync(fd, chunkBuffer, 0, chunkBuffer.length, null);
                        if (bytesRead === 0) break;
                        fileBytes += bytesRead;
                        total += bytesRead;
                        if (fileBytes > MAX_FILE_BYTES) {
                            fail('DUAL_PRIVATE_SETUP_LIMIT', `Dependency file at ${file}: observed=${fileBytes}, cap=${MAX_FILE_BYTES}`);
                        }
                        if (total > MAX_TOTAL_BYTES) {
                            fail('DUAL_PRIVATE_SETUP_LIMIT', `Dependency total at ${file}: observed=${total}, cap=${MAX_TOTAL_BYTES}`);
                        }
                        fileDigest.update(chunkBuffer.subarray(0, bytesRead));
                    }
                    const after = fs.fstatSync(fd), current = fs.lstatSync(target);
                    if (fileBytes !== before.size || [after, current].some((value) => !value.isFile()
                        || value.dev !== before.dev || value.ino !== before.ino || value.size !== before.size
                        || value.mode !== before.mode || value.mtimeMs !== before.mtimeMs || value.ctimeMs !== before.ctimeMs)) {
                        fail('DUAL_PRIVATE_SETUP_DRIFT', `Dependency replaced or modified at ${file}`);
                    }
                    fileSha256 = fileDigest.digest('hex');
                } finally { fs.closeSync(fd); }
                digest.update(`${file}\0${stat.mode & 0o777}\0${fileSha256}\0`);
            } else fail('DUAL_PRIVATE_SETUP_INVALID', 'Dependency tree contains unsupported file type');
        }
    }
    if (fs.existsSync(root)) walk(root, '', 0);
    return digest.digest('hex');
}

function verifyPrivateDependencies({ workerRoot, artifactRoot, reference }) {
    if (!reference || reference.receiptPath !== 'dependency-setup.json' || !/^[a-f0-9]{64}$/.test(reference.receiptSha256 || '')) {
        fail('DUAL_PRIVATE_SETUP_DRIFT', 'Expected an anchored dependency receipt');
    }
    validateTaskPath(artifactRoot, reference.receiptPath);
    const bytes = fs.readFileSync(path.join(artifactRoot, reference.receiptPath));
    if (hash(bytes) !== reference.receiptSha256) fail('DUAL_PRIVATE_SETUP_DRIFT', 'Dependency receipt hash changed');
    const receipt = JSON.parse(bytes.toString('utf8'));
    if (receipt.workerRoot !== fs.realpathSync.native(workerRoot) || receipt.mode !== 'npm-ci'
        || JSON.stringify(receipt.inputs) !== JSON.stringify(inputs(workerRoot))
        || receipt.dependencySha256 !== dependencyFingerprint(workerRoot)) {
        fail('DUAL_PRIVATE_SETUP_DRIFT', 'Private dependency tree or package contract changed');
    }
    return receipt;
}

async function preparePrivateDependencies({ workerRoot, artifactRoot, authorize, mode, reference, env = process.env, spawnImpl }) {
    const guard = () => {
        if (typeof authorize !== 'function' || authorize() !== true) fail('DUAL_PRIVATE_SETUP_UNAUTHORIZED', 'Current controller setup authority is required');
    };
    guard();
    if (mode !== 'npm-ci') fail('DUAL_PRIVATE_SETUP_INVALID', 'Unsupported private dependency setup mode');
    if (reference) {
        verifyPrivateDependencies({ workerRoot, artifactRoot, reference });
        return { ...reference, reused: true };
    }
    const before = inputs(workerRoot);
    validateTaskPath(workerRoot, 'node_modules');
    if (fs.existsSync(path.join(workerRoot, 'node_modules'))) fail('DUAL_PRIVATE_SETUP_INVALID', 'Fresh dependency setup cannot overwrite an existing install');
    const invocation = resolveSetupInvocation({ kind: 'package-manager', program: 'npm',
        args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--install-links'], cwd: '.' }, {
        workspaceRoot: workerRoot, env, resolveExecutable: createCliResolver(workerRoot, { env }),
    });
    const result = await spawnBoundedProcess(invocation.command, invocation.args, {
        cwd: workerRoot, env, timeoutMs: 120000, maxOutputBytes: 128 * 1024, ...(spawnImpl ? { spawnImpl } : {}),
    });
    guard();
    if (!result.ok || result.code !== 0) fail('DUAL_PRIVATE_SETUP_FAILED', 'Locked private npm installation failed; model was not invoked');
    if (JSON.stringify(before) !== JSON.stringify(inputs(workerRoot))) fail('DUAL_PRIVATE_SETUP_DRIFT', 'Dependency install changed the registered package or lock file');
    const receipt = { schema_version: 1, mode, workerRoot: fs.realpathSync.native(workerRoot), inputs: before,
        dependencySha256: dependencyFingerprint(workerRoot), command: 'npm ci --ignore-scripts --no-audit --no-fund --install-links' };
    const stored = createArtifactStore(artifactRoot).writeJsonImmutable('dependency-setup.json', receipt);
    return { mode, receiptPath: 'dependency-setup.json', receiptSha256: stored.sha256 };
}

function inspectPrivateDependencyReadiness(workerRoot) {
    const inputHashes = inputs(workerRoot);
    validateTaskPath(workerRoot, 'node_modules');
    const installed = fs.existsSync(path.join(workerRoot, 'node_modules'));
    return { inputs: inputHashes, installed, dependencySha256: installed ? dependencyFingerprint(workerRoot) : null };
}

module.exports = { preparePrivateDependencies, verifyPrivateDependencies, dependencyFingerprint, inspectPrivateDependencyReadiness };
