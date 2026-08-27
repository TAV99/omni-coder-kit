'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    createConfiguredSnapshotBaseline,
    resolveSnapshotBuildOutputs,
} = require('../lib/dual/snapshot-policy');

function makeWorkspace(t, packageJson, manifest = null) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-snapshot-policy-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson), 'utf8');
    if (manifest) {
        fs.mkdirSync(path.join(root, '.omni'), { recursive: true });
        fs.writeFileSync(path.join(root, '.omni', 'manifest.json'), JSON.stringify(manifest), 'utf8');
    }
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('detects conservative build outputs from package tooling on every platform', (t) => {
    const viteRoot = makeWorkspace(t, {
        scripts: { build: 'tsc --noEmit && vite build' },
        devDependencies: { vite: '^8.0.0' },
    });
    assert.deepEqual(resolveSnapshotBuildOutputs(viteRoot), ['dist']);

    const nextRoot = makeWorkspace(t, {
        scripts: { build: 'next build' },
        dependencies: { next: '^16.0.0' },
    });
    assert.deepEqual(resolveSnapshotBuildOutputs(nextRoot), ['.next']);
});

test('merges strict explicit manifest outputs with detected outputs', (t) => {
    const root = makeWorkspace(t, {
        scripts: { build: 'vite build' },
        devDependencies: { vite: '^8.0.0' },
    }, {
        snapshotBuildOutputs: ['coverage', 'artifacts/site'],
    });

    assert.deepEqual(resolveSnapshotBuildOutputs(root), ['artifacts/site', 'coverage', 'dist']);
});

test('fails closed on unsafe or oversized snapshot policy input', (t) => {
    const traversalRoot = makeWorkspace(t, {}, { snapshotBuildOutputs: ['../outside'] });
    assert.throws(() => resolveSnapshotBuildOutputs(traversalRoot), { code: 'DUAL_PATH_ESCAPE' });

    const oversizedRoot = makeWorkspace(t, {});
    fs.mkdirSync(path.join(oversizedRoot, '.omni'), { recursive: true });
    fs.writeFileSync(path.join(oversizedRoot, '.omni', 'manifest.json'), ' '.repeat(256 * 1024 + 1), 'utf8');
    assert.throws(() => resolveSnapshotBuildOutputs(oversizedRoot), { code: 'DUAL_SNAPSHOT_POLICY_INVALID' });
});

test('configured snapshot fingerprints exclude detected generated outputs consistently', (t) => {
    const root = makeWorkspace(t, {
        scripts: { build: 'vite build' },
        devDependencies: { vite: '^8.0.0' },
    });
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'src', 'app.js'), 'before\n');
    fs.writeFileSync(path.join(root, 'dist', 'app.js'), 'generated before\n');

    const configured = createConfiguredSnapshotBaseline({ root });
    const initial = configured.baseline.capture();
    fs.writeFileSync(path.join(root, 'src', 'app.js'), 'after\n');
    fs.writeFileSync(path.join(root, 'dist', 'app.js'), 'generated after\n');

    const diff = configured.baseline.fingerprint(initial.identity, initial.manifest, {
        excludedPaths: configured.excludedPaths,
    });
    assert.deepEqual(diff.files, ['src/app.js']);
});
