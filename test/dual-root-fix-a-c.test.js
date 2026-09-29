'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runBoundedCommand, buildQualityPlan, executeQualityPlan } = require('../lib/dual/quality-runner');
const { cleanupEphemeralValidationArtifacts, cleanupEphemeralValidationArtifactsAsync, cleanEphemeralRunnerCaches, isEphemeralRunnerCache, manifestWorker, manifestWorkerAsync } = require('../lib/dual/isolated-qc');

function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-root-fix-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }

test('quality command preserves nonzero exit and rejects signal even when status is zero', () => {
    const nonzero = runBoundedCommand({ program: process.execPath, args: ['-e', 'process.exit(7)'] });
    assert.equal(nonzero.exit_code, 7); assert.equal(nonzero.ok, false);
    const signaled = runBoundedCommand({ program: 'fake', args: [] }, { spawnSyncImpl: () => ({ status: 0, signal: 'SIGTERM', stdout: '', stderr: '' }) });
    assert.equal(signaled.exit_code, 0); assert.equal(signaled.ok, false); assert.equal(signaled.failure, 'signal');
});

test('Windows npm uses node CLI invocation without shell wrappers', () => {
    const result = runBoundedCommand({ program: 'npm', args: ['--version'] }, { cwd: process.cwd(), workspaceRoot: process.cwd() });
    assert.equal(result.ok, true); assert.equal(result.exit_code, 0); assert.match(result.output, /\d+\./);
});

test('quality plan runs only existing or explicitly registered scripts', (t) => {
    const root = temp(t); fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const plan = buildQualityPlan(root); assert.deepEqual(plan.commands.map((item) => item.script).filter(Boolean), ['test']);
    const withRequired = buildQualityPlan(root, fs, { requiredScripts: ['typecheck'] });
    const typecheck = withRequired.commands.find((item) => item.script === 'typecheck'); assert.equal(typecheck.available, false);
    const executed = executeQualityPlan(plan, { cwd: root });
    assert.equal(executed.find((item) => item.script === 'test').ok, true);
});

test('isolated QC compares validator output to a pre-validator manifest and never restores source', (t) => {
    const root = temp(t); fs.writeFileSync(path.join(root, 'src.js'), 'before'); const before = manifestWorker(root);
    fs.mkdirSync(path.join(root, 'dist')); fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), 'generated'); fs.writeFileSync(path.join(root, 'src.js'), 'mutated');
    const result = cleanupEphemeralValidationArtifacts(root, { sourceFiles: [{ path: 'src.js' }], generated_outputs: ['dist'] }, { result: { changes: [] } }, { beforeManifest: before });
    assert.equal(result.ok, false); assert.deepEqual(fs.readFileSync(path.join(root, 'src.js'), 'utf8'), 'mutated'); assert.equal(fs.existsSync(path.join(root, 'dist')), true);
    fs.writeFileSync(path.join(root, 'src.js'), 'before'); const clean = cleanupEphemeralValidationArtifacts(root, { sourceFiles: [{ path: 'src.js' }], generated_outputs: ['dist'] }, { result: { changes: [] } }, { beforeManifest: manifestWorker(root) });
    assert.equal(clean.ok, true); assert.equal(fs.existsSync(path.join(root, 'dist')), false);
});

test('declared generated output cannot overlap handed-off source or control-plane paths', (t) => {
    const root = temp(t); fs.mkdirSync(path.join(root, 'src'), { recursive: true }); fs.writeFileSync(path.join(root, 'src', 'new.js'), 'source'); fs.mkdirSync(path.join(root, '.omni', 'runtime'), { recursive: true }); fs.writeFileSync(path.join(root, '.omni', 'runtime', 'lease'), 'keep');
    const before = manifestWorker(root);
    const sourceOverlap = cleanupEphemeralValidationArtifacts(root, { sourceFiles: [], generated_outputs: ['src'] }, { result: { changes: [{ path: 'src/new.js', kind: 'created' }] } }, { beforeManifest: before });
    assert.equal(sourceOverlap.ok, false); assert.equal(fs.existsSync(path.join(root, 'src', 'new.js')), true);
    const controlOverlap = cleanupEphemeralValidationArtifacts(root, { sourceFiles: [], generated_outputs: ['.omni'] }, { result: { changes: [] } }, { beforeManifest: before });
    assert.equal(controlOverlap.ok, false); assert.equal(fs.existsSync(path.join(root, '.omni', 'runtime', 'lease')), true);
});

test('manifestWorkerAsync yields and rehashes content instead of trusting prior metadata', async (t) => {
    const root = temp(t);
    fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pkg', 'a.js'), 'content-a');
    fs.writeFileSync(path.join(root, 'pkg', 'b.js'), 'content-b');
    let ticks = 0;
    const initial = await manifestWorkerAsync(root, { yieldEvery: 1, onTick: () => { ticks++; } });
    assert.equal(initial.entries.size, 2);
    assert.equal(initial.failures.length, 0);
    assert.ok(ticks >= 2);
    assert.equal(initial.entries.get('pkg/a.js').sha256, manifestWorker(root).entries.get('pkg/a.js').sha256);

    // Second run reuses prior sha256
    const cached = await manifestWorkerAsync(root, { priorManifest: initial });
    assert.equal(cached.entries.get('pkg/a.js').sha256, initial.entries.get('pkg/a.js').sha256);
    assert.equal(cached.entries.get('pkg/b.js').sha256, initial.entries.get('pkg/b.js').sha256);
});

test('cleanupEphemeralValidationArtifactsAsync removes declared outputs and checks mutations', async (t) => {
    const root = temp(t);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.js'), 'code');
    const before = await manifestWorkerAsync(root);
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'output.js'), 'built');
    const clean = await cleanupEphemeralValidationArtifactsAsync(root,
        { sourceFiles: [{ path: 'src/app.js' }], generated_outputs: ['dist'] },
        { result: { changes: [] } },
        { beforeManifest: before }
    );
    assert.equal(clean.ok, true);
    assert.equal(fs.existsSync(path.join(root, 'dist')), false);
});

test('isEphemeralRunnerCache correctly identifies tool runner caches inside node_modules', () => {
    assert.equal(isEphemeralRunnerCache('node_modules/.vite'), true);
    assert.equal(isEphemeralRunnerCache('node_modules/.vite/vitest/results.json'), true);
    assert.equal(isEphemeralRunnerCache('node_modules/.cache/jest/cache.json'), true);
    assert.equal(isEphemeralRunnerCache('node_modules/.vitest/results.json'), true);
    assert.equal(isEphemeralRunnerCache('packages/foo/node_modules/.vite/deps/chunk.js'), true);
    assert.equal(isEphemeralRunnerCache('node_modules'), false);
    assert.equal(isEphemeralRunnerCache('node_modules/.bin'), false);
    assert.equal(isEphemeralRunnerCache('node_modules/.bin/vitest'), false);
    assert.equal(isEphemeralRunnerCache('node_modules/.package-lock.json'), false);
    assert.equal(isEphemeralRunnerCache('node_modules/lodash/index.js'), false);
    assert.equal(isEphemeralRunnerCache('src/index.js'), false);
});

test('isolated QC allows and cleans ephemeral test runner caches in node_modules without workspace mutation error', async (t) => {
    const root = temp(t);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.js'), 'code');
    fs.mkdirSync(path.join(root, 'node_modules', 'existing-lib'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'existing-lib', 'index.js'), 'module.exports = 1;');

    const before = await manifestWorkerAsync(root);
    assert.equal(before.entries.has('node_modules/existing-lib/index.js'), true);

    // Simulate Vitest running during validation and writing results.json into node_modules/.vite
    fs.mkdirSync(path.join(root, 'node_modules', '.vite', 'vitest', 'hash123'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', '.vite', 'vitest', 'hash123', 'results.json'), JSON.stringify({ passed: true }));
    fs.mkdirSync(path.join(root, 'node_modules', '.cache', 'eslint'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', '.cache', 'eslint', 'cache.json'), '{}');

    // Ephemeral caches should be skipped by manifestWorker and manifestWorkerAsync
    const after = manifestWorker(root);
    assert.equal(after.entries.has('node_modules/.vite/vitest/hash123/results.json'), false);
    assert.equal(after.entries.has('node_modules/.cache/eslint/cache.json'), false);

    // Cleanup should succeed: no dependency_mutations, no unexpected_outputs
    const clean = await cleanupEphemeralValidationArtifactsAsync(root,
        { sourceFiles: [{ path: 'src/app.js' }] },
        { result: { changes: [] } },
        { beforeManifest: before }
    );
    assert.equal(clean.ok, true);
    assert.deepEqual(clean.dependency_mutations, []);
    assert.deepEqual(clean.unexpected_outputs, []);
    assert.deepEqual(clean.source_mutations, []);

    // Ephemeral runner caches were cleaned from worker sandbox
    assert.equal(fs.existsSync(path.join(root, 'node_modules', '.vite')), false);
    assert.equal(fs.existsSync(path.join(root, 'node_modules', '.cache')), false);
    // Real library was preserved intact
    assert.equal(fs.existsSync(path.join(root, 'node_modules', 'existing-lib', 'index.js')), true);

    // Real package mutation inside node_modules must still be rejected
    fs.writeFileSync(path.join(root, 'node_modules', 'existing-lib', 'index.js'), 'mutated');
    const mutated = await cleanupEphemeralValidationArtifactsAsync(root,
        { sourceFiles: [{ path: 'src/app.js' }] },
        { result: { changes: [] } },
        { beforeManifest: before }
    );
    assert.equal(mutated.ok, false);
    assert.ok(mutated.dependency_mutations.includes('node_modules/existing-lib/index.js'));
});
