'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { preparePrivateDependencies, verifyPrivateDependencies, dependencyFingerprint, inspectPrivateDependencyReadiness } = require('../lib/dual/private-dependencies');

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-incident-deps-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'worker'));
    fs.writeFileSync(path.join(root, 'worker/package.json'), '{"name":"incident-fixture","version":"1.0.0"}');
    fs.writeFileSync(path.join(root, 'worker/package-lock.json'), JSON.stringify({
        name: 'incident-fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
        packages: { '': { name: 'incident-fixture', version: '1.0.0' } },
    }));
    return { workerRoot: path.join(root, 'worker'), artifactRoot: root, authorize: () => true, mode: 'npm-ci' };
}

test('74882048-byte native binary prepares and verifies without whole-file reads', async (t) => {
    const input = fixture(t);
    const target = path.join(input.workerRoot, 'node_modules/@vendor/binary/native.node');
    const original = fs.readFileSync;
    let wholeFileRead = false;
    fs.readFileSync = function (file, ...args) {
        if (file === target) wholeFileRead = true;
        return original.call(fs, file, ...args);
    };
    t.after(() => { fs.readFileSync = original; });
    const spawnImpl = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        process.nextTick(() => {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            const fd = fs.openSync(target, 'w');
            try { fs.ftruncateSync(fd, 74882048); } finally { fs.closeSync(fd); }
            child.emit('close', 0, null);
        });
        return child;
    };
    const reference = await preparePrivateDependencies({ ...input, spawnImpl });
    assert.equal(reference.mode, 'npm-ci');
    assert.match(reference.receiptSha256, /^[a-f0-9]{64}$/);
    assert.equal(verifyPrivateDependencies({ ...input, reference }).workerRoot, input.workerRoot);
    assert.equal(wholeFileRead, false);
    const fd = fs.openSync(target, 'r+');
    try { fs.writeSync(fd, Buffer.from([1]), 0, 1, 74882047); } finally { fs.closeSync(fd); }
    assert.throws(() => verifyPrivateDependencies({ ...input, reference }), { code: 'DUAL_PRIVATE_SETUP_DRIFT' });
});

test('file above 256MiB rejects with relative path and exact resource limit', (t) => {
    const input = fixture(t);
    const target = path.join(input.workerRoot, 'node_modules/oversized-pkg/oversized.bin');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = fs.openSync(target, 'w');
    try { fs.ftruncateSync(fd, 256 * 1024 * 1024 + 1); } finally { fs.closeSync(fd); }
    assert.throws(() => dependencyFingerprint(input.workerRoot), (error) => {
        assert.equal(error.code, 'DUAL_PRIVATE_SETUP_LIMIT');
        assert.match(error.message, /268435457/);
        assert.match(error.message, /268435456/);
        assert.match(error.message, /oversized-pkg\/oversized\.bin/);
        assert.equal(error.message.includes(input.workerRoot), false);
        return true;
    });
});

test('fingerprint remains deterministic and detects changed dependency content', (t) => {
    const input = fixture(t);
    const target = path.join(input.workerRoot, 'node_modules/tracked-pkg/index.js');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'module.exports = 1;');
    const first = dependencyFingerprint(input.workerRoot);
    const crypto = require('node:crypto');
    const expected = crypto.createHash('sha256').update(`tracked-pkg/index.js\0${fs.statSync(target).mode & 0o777}\0${crypto.createHash('sha256').update('module.exports = 1;').digest('hex')}\0`).digest('hex');
    assert.equal(first, expected, 'old fingerprint wire encoding stays compatible');
    assert.equal(dependencyFingerprint(input.workerRoot), first);
    fs.writeFileSync(target, 'module.exports = 2;');
    assert.notEqual(dependencyFingerprint(input.workerRoot), first);
});

test('bounded read detects mid-read growth and closes descriptor', (t) => {
    const input = fixture(t);
    const target = path.join(input.workerRoot, 'node_modules/grow.bin');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.alloc(2 * 1024 * 1024));
    const read = fs.readSync, close = fs.closeSync;
    let observedFd, closed = false, changed = false;
    fs.readSync = function (fd, buffer, offset, length, position) {
        observedFd = fd;
        assert.ok(length <= 1024 * 1024);
        const bytes = read.call(fs, fd, buffer, offset, length, position);
        if (!changed) { changed = true; fs.appendFileSync(target, 'growth'); }
        return bytes;
    };
    fs.closeSync = function (fd) { if (fd === observedFd) closed = true; return close.call(fs, fd); };
    t.after(() => { fs.readSync = read; fs.closeSync = close; });
    assert.throws(() => dependencyFingerprint(input.workerRoot), { code: 'DUAL_PRIVATE_SETUP_DRIFT' });
    assert.equal(closed, true);
});

test('256MiB file boundary passes and directory depth 65 fails', (t) => {
    const input = fixture(t);
    const target = path.join(input.workerRoot, 'node_modules/boundary.bin');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const fd = fs.openSync(target, 'w');
    try { fs.ftruncateSync(fd, 256 * 1024 * 1024); } finally { fs.closeSync(fd); }
    assert.match(dependencyFingerprint(input.workerRoot), /^[a-f0-9]{64}$/);
    fs.unlinkSync(target);
    let dir = path.dirname(target);
    for (let i = 0; i < 64; i++) { dir = path.join(dir, 'd'); fs.mkdirSync(dir); }
    assert.match(dependencyFingerprint(input.workerRoot), /^[a-f0-9]{64}$/);
    fs.mkdirSync(path.join(dir, 'd'));
    assert.throws(() => dependencyFingerprint(input.workerRoot), { code: 'DUAL_PRIVATE_SETUP_LIMIT' });
});

test('read-only readiness without installed dependencies does not fabricate a receipt', (t) => {
    const input = fixture(t);
    const result = inspectPrivateDependencyReadiness(input.workerRoot);
    assert.equal(result.installed, false);
    assert.equal(result.dependencySha256, null);
    assert.match(result.inputs['package-lock.json'], /^[a-f0-9]{64}$/);
    assert.equal(fs.existsSync(path.join(input.artifactRoot, 'dependency-setup.json')), false);
});
