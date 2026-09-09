'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { createCliResolver } = require('../lib/dual/setup-command');
const { resolveSetupInvocation } = require('../lib/dual/setup-runner');
const { preparePrivateDependencies, verifyPrivateDependencies, dependencyFingerprintAsync } = require('../lib/dual/private-dependencies');

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-private-deps-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'worker'));
    fs.writeFileSync(path.join(root, 'worker/package.json'), '{"name":"empty-private-fixture","version":"1.0.0"}');
    fs.writeFileSync(path.join(root, 'worker/package-lock.json'), JSON.stringify({
        name: 'empty-private-fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
        packages: { '': { name: 'empty-private-fixture', version: '1.0.0' } },
    }));
    return { workerRoot: path.join(root, 'worker'), artifactRoot: root, authorize: () => true, mode: 'npm-ci' };
}

test('locked private npm install uses its worker cwd and a durable fingerprint receipt', async (t) => {
    const input = fixture(t);
    const result = await preparePrivateDependencies(input);
    assert.equal(result.mode, 'npm-ci');
    assert.match(result.receiptSha256, /^[a-f0-9]{64}$/);
    assert.doesNotThrow(() => verifyPrivateDependencies({ ...input, reference: result }));
    assert.equal((await preparePrivateDependencies({ ...input, reference: result })).reused, true);
    assert.equal(fs.existsSync(path.join(input.artifactRoot, 'node_modules')), false);
});

test('reused private dependency references use the async verifier and cooperative authority ticks', async (t) => {
    const input = fixture(t);
    const reference = await preparePrivateDependencies(input);
    let ticks = 0;
    const reused = await preparePrivateDependencies({ ...input, reference, yieldEvery: 1, onTick: () => { ticks += 1; } });
    assert.equal(reused.reused, true);
    assert.equal(typeof ticks, 'number');
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'lib', 'dual', 'private-dependencies.js'), 'utf8'),
        /await verifyPrivateDependenciesAsync\(\{ workerRoot, artifactRoot, reference/);
});

test('async dependency hashing yields and aborts between large-file chunks', async (t) => {
    const input = fixture(t);
    const dependencyPath = path.join(input.workerRoot, 'node_modules', 'large-pkg');
    fs.mkdirSync(dependencyPath, { recursive: true });
    fs.writeFileSync(path.join(dependencyPath, 'payload.bin'), Buffer.alloc(4 * 1024 * 1024, 7));
    const controller = new AbortController();
    let ticks = 0;
    await assert.rejects(() => dependencyFingerprintAsync(input.workerRoot, {
        yieldEvery: 1,
        signal: controller.signal,
        onTick: () => { ticks += 1; controller.abort(); },
    }), (error) => error.code === 'DUAL_PRIVATE_SETUP_ABORTED');
    assert.ok(ticks >= 1);
});

test('fresh dependency install aborts during post-install hashing before writing a receipt', async (t) => {
    const input = fixture(t);
    const dependencyPath = path.join(input.workerRoot, 'node_modules', 'large-pkg', 'payload.bin');
    const controller = new AbortController();
    let ticks = 0;
    let authorizeCalls = 0;
    const spawnImpl = () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        process.nextTick(() => {
            fs.mkdirSync(path.dirname(dependencyPath), { recursive: true });
            fs.writeFileSync(dependencyPath, Buffer.alloc(2 * 1024 * 1024, 7));
            child.emit('close', 0, null);
        });
        return child;
    };

    await assert.rejects(() => preparePrivateDependencies({
        ...input,
        authorize: () => { authorizeCalls++; return true; },
        spawnImpl,
        yieldEvery: 1,
        signal: controller.signal,
        onTick: () => { ticks++; controller.abort(); },
    }), (error) => error.code === 'DUAL_PRIVATE_SETUP_ABORTED');
    assert.ok(ticks >= 1, 'caller onTick must run during fresh post-install hashing');
    assert.ok(authorizeCalls >= 3, 'authority guard must continue running during fresh post-install hashing');
    assert.equal(fs.existsSync(path.join(input.artifactRoot, 'dependency-setup.json')), false,
        'aborted dependency verification must not write a receipt');
});

test('async dependency verifier does not use synchronous filesystem traversal or reads', async (t) => {
    const input = fixture(t);
    const reference = await preparePrivateDependencies(input);
    const originals = { readdirSync: fs.readdirSync, lstatSync: fs.lstatSync, readSync: fs.readSync };
    fs.readdirSync = () => { throw new Error('sync directory traversal is forbidden in async verifier'); };
    fs.lstatSync = () => { throw new Error('sync stat is forbidden in async verifier'); };
    fs.readSync = () => { throw new Error('sync file read is forbidden in async verifier'); };
    t.after(() => {
        fs.readdirSync = originals.readdirSync;
        fs.lstatSync = originals.lstatSync;
        fs.readSync = originals.readSync;
    });
    await assert.doesNotReject(() => require('../lib/dual/private-dependencies').verifyPrivateDependenciesAsync({
        ...input, reference, yieldEvery: 1,
    }));
});

test('dependency setup cannot run without a lockfile or current authority', async (t) => {
    const input = fixture(t);
    await assert.rejects(() => preparePrivateDependencies({ ...input, authorize: () => false }),
        (error) => error.code === 'DUAL_PRIVATE_SETUP_UNAUTHORIZED');
    fs.unlinkSync(path.join(input.workerRoot, 'package-lock.json'));
    await assert.rejects(() => preparePrivateDependencies(input),
        (error) => error.code === 'DUAL_PRIVATE_SETUP_INVALID');
});

test('receipt and dependency mutation are detected without rerunning installation', async (t) => {
    const input = fixture(t);
    const reference = await preparePrivateDependencies(input);
    fs.mkdirSync(path.join(input.workerRoot, 'node_modules/forged'), { recursive: true });
    fs.writeFileSync(path.join(input.workerRoot, 'node_modules/forged/index.js'), 'module.exports = "forged"');
    assert.throws(() => verifyPrivateDependencies({ ...input, reference }),
        (error) => error.code === 'DUAL_PRIVATE_SETUP_DRIFT');
    const original = fs.readFileSync(path.join(input.artifactRoot, reference.receiptPath));
    fs.writeFileSync(path.join(input.artifactRoot, reference.receiptPath), Buffer.concat([original, Buffer.from(' ')]));
    assert.throws(() => verifyPrivateDependencies({ ...input, reference }),
        (error) => error.code === 'DUAL_PRIVATE_SETUP_DRIFT');
});

test('private install makes a real locked local dependency usable without executing lifecycle scripts', async (t) => {
    const input = fixture(t);
    fs.mkdirSync(path.join(input.workerRoot, 'vendor/helper'), { recursive: true });
    fs.writeFileSync(path.join(input.workerRoot, 'vendor/helper/package.json'), JSON.stringify({ name: 'local-helper', version: '1.0.0', main: 'index.js',
        scripts: { postinstall: 'node -e "require(\'fs\').writeFileSync(\'script-ran\',\'yes\')"' } }));
    fs.writeFileSync(path.join(input.workerRoot, 'vendor/helper/index.js'), 'module.exports = 42;');
    fs.writeFileSync(path.join(input.workerRoot, 'package.json'), JSON.stringify({ name: 'private-fixture', version: '1.0.0',
        dependencies: { 'local-helper': 'file:vendor/helper' } }));
    const invocation = resolveSetupInvocation({ kind: 'package-manager', program: 'npm', cwd: '.',
        args: ['install', '--package-lock-only', '--ignore-scripts', '--install-links', '--no-audit', '--no-fund'] },
    { workspaceRoot: input.workerRoot, resolveExecutable: createCliResolver(input.workerRoot) });
    const lock = spawnSync(invocation.command, invocation.args, { cwd: input.workerRoot, shell: false, windowsHide: true, encoding: 'utf8', timeout: 30000 });
    assert.equal(lock.status, 0, lock.stderr);
    const reference = await preparePrivateDependencies(input);
    const execution = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(require("local-helper")))'], {
        cwd: input.workerRoot, shell: false, windowsHide: true, encoding: 'utf8',
    });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, '42');
    assert.equal(fs.existsSync(path.join(input.workerRoot, 'node_modules/local-helper/script-ran')), false);
    assert.equal(verifyPrivateDependencies({ ...input, reference }).mode, 'npm-ci');
});

test('private setup rejects local dependency paths escaping its snapshot', async (t) => {
    const input = fixture(t);
    fs.writeFileSync(path.join(input.workerRoot, 'package.json'), JSON.stringify({ name: 'fixture', dependencies: { outside: 'file:../../outside' } }));
    await assert.rejects(() => preparePrivateDependencies(input), (error) => error.code === 'DUAL_PRIVATE_SETUP_INVALID');
    assert.equal(fs.existsSync(path.join(input.workerRoot, 'node_modules')), false);
});

test('npm shrinkwrap cannot replace the validated lockfile during setup or replay', async (t) => {
    const input = fixture(t);
    const reference = await preparePrivateDependencies(input);
    fs.writeFileSync(path.join(input.workerRoot, 'npm-shrinkwrap.json'), '{}');
    assert.throws(() => verifyPrivateDependencies({ ...input, reference }), (error) => error.code === 'DUAL_PRIVATE_SETUP_INVALID');
    const fresh = fixture(t);
    fs.writeFileSync(path.join(fresh.workerRoot, 'npm-shrinkwrap.json'), '{}');
    await assert.rejects(() => preparePrivateDependencies(fresh), (error) => error.code === 'DUAL_PRIVATE_SETUP_INVALID');
    assert.equal(fs.existsSync(path.join(fresh.workerRoot, 'node_modules')), false);
});

test('ephemeral build cache directories (.vite, .cache, .* caches) inside node_modules do not cause setup drift', async (t) => {
    const input = fixture(t);
    const reference = await preparePrivateDependencies(input);

    // Simulate vite build and generic build tool caches created during implement/validation
    fs.mkdirSync(path.join(input.workerRoot, 'node_modules/.vite/deps'), { recursive: true });
    fs.writeFileSync(path.join(input.workerRoot, 'node_modules/.vite/deps/chunk.js'), 'export default "cached"');
    fs.mkdirSync(path.join(input.workerRoot, 'node_modules/.cache/test-tool'), { recursive: true });
    fs.writeFileSync(path.join(input.workerRoot, 'node_modules/.cache/test-tool/meta.json'), '{"cache":true}');
    fs.mkdirSync(path.join(input.workerRoot, 'node_modules/.turbopack/cache'), { recursive: true });
    fs.writeFileSync(path.join(input.workerRoot, 'node_modules/.turbopack/cache/data.bin'), Buffer.alloc(64));
    fs.mkdirSync(path.join(input.workerRoot, 'node_modules/.custom-tool-cache'), { recursive: true });
    fs.writeFileSync(path.join(input.workerRoot, 'node_modules/.custom-tool-cache/index.json'), '{}');

    // Verification must pass despite any top-level ephemeral dot-cache presence
    assert.doesNotThrow(() => verifyPrivateDependencies({ ...input, reference }));

    // Real package mutation must still be rejected
    fs.mkdirSync(path.join(input.workerRoot, 'node_modules/forged-pkg'), { recursive: true });
    fs.writeFileSync(path.join(input.workerRoot, 'node_modules/forged-pkg/index.js'), 'module.exports = 1');
    assert.throws(() => verifyPrivateDependencies({ ...input, reference }),
        (error) => error.code === 'DUAL_PRIVATE_SETUP_DRIFT');
});
