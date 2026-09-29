'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    cleanupEphemeralValidationArtifacts,
    manifestWorker,
    manifestWorkerAsync,
} = require('../lib/dual/isolated-qc');

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-manifest-integrity-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('async manifest detects equal-size mutation with restored mtime', async (t) => {
    const root = fixture(t);
    const file = path.join(root, 'source.js');
    const fixed = new Date('2023-11-14T22:13:20.000Z');
    fs.writeFileSync(file, 'AAAA');
    fs.utimesSync(file, fixed, fixed);

    const before = await manifestWorkerAsync(root);
    fs.writeFileSync(file, 'BBBB');
    fs.utimesSync(file, fixed, fixed);
    const after = await manifestWorkerAsync(root, { priorManifest: before });

    assert.equal(after.failures.length, 0);
    assert.equal(after.entries.get('source.js').size, before.entries.get('source.js').size);
    assert.equal(after.entries.get('source.js').mtimeMs, before.entries.get('source.js').mtimeMs);
    assert.notEqual(after.entries.get('source.js').sha256, before.entries.get('source.js').sha256);
    assert.equal(after.entries.get('source.js').sha256, manifestWorker(root).entries.get('source.js').sha256);
});

test('manifest skips only known dependency-root caches and reports unknown dot outputs as mutations', async (t) => {
    const root = fixture(t);
    fs.mkdirSync(path.join(root, 'node_modules/.vite'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/.vite/cache.js'), 'allowed');
    fs.mkdirSync(path.join(root, 'packages/pkg/node_modules/.cache'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages/pkg/node_modules/.cache/cache.js'), 'allowed');
    fs.mkdirSync(path.join(root, 'node_modules/.payload'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/.payload/data.bin'), 'before');

    const before = manifestWorker(root);
    const asyncBefore = await manifestWorkerAsync(root);
    assert.equal(before.failures.length, 0);
    assert.equal(asyncBefore.failures.length, 0);
    assert.deepEqual(
        [...asyncBefore.entries].map(([file, entry]) => [file, entry.sha256]).sort(),
        [...before.entries].map(([file, entry]) => [file, entry.sha256]).sort()
    );
    assert.equal(before.entries.has('node_modules/.vite/cache.js'), false);
    assert.equal(before.entries.has('packages/pkg/node_modules/.cache/cache.js'), false);
    assert.equal(before.entries.has('node_modules/.payload/data.bin'), true);

    fs.writeFileSync(path.join(root, 'node_modules/.payload/data.bin'), 'after');
    const result = cleanupEphemeralValidationArtifacts(root, { sourceFiles: [] }, { result: { changes: [] } }, { beforeManifest: before });
    assert.equal(result.ok, false);
    assert.deepEqual(result.dependency_mutations, ['node_modules/.payload/data.bin']);
});

test('manifest rejects symlinked cache roots instead of skipping them', (t) => {
    const root = fixture(t);
    const sibling = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-manifest-outside-')));
    t.after(() => fs.rmSync(sibling, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    try {
        fs.symlinkSync(sibling, path.join(root, 'node_modules/.cache'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
        t.skip(`symlink/junction unavailable: ${error.code || error.message}`);
        return;
    }

    const result = manifestWorker(root);
    assert.ok(result.failures.some((failure) => failure.includes('symlink/junction rejected: node_modules/.cache')));
});

test('cache cleanup failures are returned and make cleanup non-ok', (t) => {
    const root = fixture(t);
    fs.mkdirSync(path.join(root, 'node_modules/.cache'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/.cache/cache.json'), '{}');
    const before = manifestWorker(root);
    const originalRmSync = fs.rmSync;
    fs.rmSync = (target, ...args) => {
        if (String(target).replace(/\\/g, '/').includes('/node_modules/.cache')) {
            const error = new Error('cleanup denied');
            error.code = 'EACCES';
            throw error;
        }
        return originalRmSync(target, ...args);
    };
    t.after(() => { fs.rmSync = originalRmSync; });

    const result = cleanupEphemeralValidationArtifacts(root, { sourceFiles: [] }, { result: { changes: [] } }, { beforeManifest: before });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.includes('cleanup node_modules/.cache')));
});

test('async manifest hashes large files in bounded chunks and honors abort during hashing', async (t) => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'large.bin'), Buffer.alloc(4 * 1024 * 1024, 7));
    const controller = new AbortController();
    let ticks = 0;

    await assert.rejects(() => manifestWorkerAsync(root, {
        yieldEvery: 1,
        signal: controller.signal,
        onTick: () => {
            ticks += 1;
            if (ticks >= 3) controller.abort();
        },
    }), (error) => error.code === 'DUAL_PRIVATE_SETUP_ABORTED');
    assert.ok(ticks >= 3);
});

test('async manifest aborts when the final EOF read triggers cancellation', async (t) => {
    const root = fixture(t);
    fs.writeFileSync(path.join(root, 'source.js'), 'content');
    const controller = new AbortController();
    const originalOpen = fs.promises.open;
    fs.promises.open = async (...args) => {
        const fd = await originalOpen(...args);
        const originalRead = fd.read.bind(fd);
        fd.read = async (...readArgs) => {
            const result = await originalRead(...readArgs);
            if (result.bytesRead === 0) controller.abort();
            return result;
        };
        return fd;
    };
    t.after(() => { fs.promises.open = originalOpen; });

    await assert.rejects(() => manifestWorkerAsync(root, { signal: controller.signal }),
        (error) => error.code === 'DUAL_PRIVATE_SETUP_ABORTED');
});
