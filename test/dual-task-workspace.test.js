'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { prepareTaskWorkspace, collectTaskResult, isEphemeralWorkspaceArtifact } = require('../lib/dual/task-workspace');
const dualIndex = require('../lib/dual');

test('task workspace and integration primitives are exported from the Dual public index', () => {
    assert.equal(typeof dualIndex.prepareTaskWorkspace, 'function');
    assert.equal(typeof dualIndex.collectTaskResult, 'function');
    assert.equal(typeof dualIndex.integrateTaskResult, 'function');
});

function fixture(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-private-worker-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (file, text) => {
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
    };
    write('src/a.js', 'user uncommitted version\n');
    write('src/b.js', 'another feature\n');
    write('docs/spec.md', 'Only edit task files.\n');
    write('package.json', '{"name":"fixture"}');
    return { root, write, options: {
        workspaceRoot: root, sessionId: 'session-1', taskId: 'TASK-1', attempt: 1, planRevision: 1,
        allowedFiles: ['src/a.js', 'src/new.js'], contextFiles: ['docs/spec.md'], denyPatterns: [],
    } };
}

test('private task snapshots retain dirty source bytes without copying runtime or credentials', (t) => {
    const { root, write, options } = fixture(t);
    for (const file of ['.git/config', '.env', '.env.local', '.npmrc', '.codex/config.toml',
        '.omni/manifest.json', '.omni/runtime/dual/daemon.json', 'node_modules/pkg/index.js']) {
        write(file, 'DO-NOT-COPY');
    }
    const ref = prepareTaskWorkspace(options);
    assert.notEqual(ref.workerRoot, root);
    assert.equal(fs.readFileSync(path.join(ref.workerRoot, 'src/a.js'), 'utf8'), 'user uncommitted version\n');
    assert.equal(fs.readFileSync(path.join(ref.workerRoot, 'docs/spec.md'), 'utf8'), 'Only edit task files.\n');
    for (const file of ['.git', '.env', '.env.local', '.npmrc', '.codex', '.omni/manifest.json', 'node_modules']) {
        assert.equal(fs.existsSync(path.join(ref.workerRoot, file)), false, file);
    }
    fs.writeFileSync(path.join(ref.workerRoot, 'src/a.js'), 'worker edits\n');
    assert.equal(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), 'user uncommitted version\n');
    assert.throws(() => prepareTaskWorkspace(options), (error) => error.code === 'DUAL_TASK_WORKSPACE_EXISTS');
    assert.equal(fs.readFileSync(path.join(ref.workerRoot, 'src/a.js'), 'utf8'), 'worker edits\n');
});

test('worker result binds create modify delete bytes to its original snapshot and exact scope', (t) => {
    const { root, options } = fixture(t);
    const ref = prepareTaskWorkspace({ ...options, allowedFiles: ['src/a.js', 'src/b.js', 'src/new.js'] });
    fs.writeFileSync(path.join(ref.workerRoot, 'src/a.js'), 'worker version\n');
    fs.unlinkSync(path.join(ref.workerRoot, 'src/b.js'));
    fs.writeFileSync(path.join(ref.workerRoot, 'src/new.js'), Buffer.from([0, 255, 10]));
    const result = collectTaskResult({ workspaceRoot: root, reference: ref });
    assert.deepEqual(result.changes.map(({ path: file, kind }) => [file, kind]), [
        ['src/a.js', 'modified'], ['src/b.js', 'deleted'], ['src/new.js', 'created'],
    ]);
    assert.equal(result.bindingSha256, ref.bindingSha256);
    assert.match(result.resultSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(Buffer.from(result.changes[2].contentBase64, 'base64'), Buffer.from([0, 255, 10]));
    assert.equal(fs.existsSync(path.join(root, 'src/b.js')), true);
    fs.writeFileSync(path.join(ref.workerRoot, 'docs/spec.md'), 'out of scope');
    assert.throws(() => collectTaskResult({ workspaceRoot: root, reference: ref }),
        (error) => error.code === 'DUAL_SCOPE_VIOLATION');
});

test('result collection rejects unmanaged node_modules before recursive dependency scanning', (t) => {
    const { root, options } = fixture(t);
    const ref = prepareTaskWorkspace(options);
    const dependency = path.join(ref.workerRoot, 'node_modules', 'unmanaged-package');
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(path.join(dependency, 'index.js'), 'must not be hashed or copied\n');
    fs.mkdirSync(path.join(ref.workerRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(ref.workerRoot, 'dist', 'bundle.js'), 'unapproved build output\n');
    assert.throws(() => collectTaskResult({ workspaceRoot: root, reference: ref }),
        (error) => error.code === 'DUAL_TASK_DEPENDENCY_MODE_REQUIRED');
});

test('independent task workspaces do not share files or overwrite another attempt', (t) => {
    const { options } = fixture(t);
    const first = prepareTaskWorkspace(options);
    const second = prepareTaskWorkspace({ ...options, taskId: 'TASK-2' });
    fs.writeFileSync(path.join(first.workerRoot, 'src/a.js'), 'first task');
    assert.equal(fs.readFileSync(path.join(second.workerRoot, 'src/a.js'), 'utf8'), 'user uncommitted version\n');
    assert.notEqual(first.bindingSha256, second.bindingSha256);
});

test('missing or excluded context and forbidden writable paths fail before staging', (t) => {
    const { options, write } = fixture(t);
    write('.env', 'private');
    for (const context of ['missing.md', '.env']) {
        assert.throws(() => prepareTaskWorkspace({ ...options, contextFiles: [context] }),
            (error) => error.code === 'DUAL_TASK_CONTEXT_UNAVAILABLE');
    }
    for (const file of ['../outside.js', 'C:/outside.js', '.omni/runtime/dual/daemon.json', '.env']) {
        assert.throws(() => prepareTaskWorkspace({ ...options, allowedFiles: [file] }));
    }
    const ref = prepareTaskWorkspace(options);
    assert.ok(fs.existsSync(ref.workerRoot), 'invalid inputs did not consume attempt');
});

test('tampered binding and storage junction escape are rejected without external writes', (t) => {
    const { root, options } = fixture(t);
    const ref = prepareTaskWorkspace(options);
    fs.appendFileSync(path.join(root, ref.bindingPath), ' ');
    assert.throws(() => collectTaskResult({ workspaceRoot: root, reference: ref }),
        (error) => error.code === 'DUAL_TASK_BINDING_INVALID');

    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-outside-worker-')));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const other = fixture(t);
    fs.mkdirSync(path.join(other.root, '.omni'), { recursive: true });
    fs.symlinkSync(outside, path.join(other.root, '.omni', 'runs'), 'junction');
    assert.throws(() => prepareTaskWorkspace(other.options), (error) => error.code === 'DUAL_PATH_ESCAPE');
    assert.deepEqual(fs.readdirSync(outside), []);
});

test('result collection rejects worker root redirected back to source via junction', (t) => {
    const { root, options } = fixture(t);
    const ref = prepareTaskWorkspace(options);
    fs.renameSync(ref.workerRoot, `${ref.workerRoot}-saved`);
    fs.symlinkSync(root, ref.workerRoot, 'junction');
    assert.throws(() => collectTaskResult({ workspaceRoot: root, reference: ref }),
        (error) => error.code === 'DUAL_PATH_ESCAPE');
});

test('source-copy exclusions do not hide worker-created credential or control files', (t) => {
    const { root, options } = fixture(t);
    for (const [i, file] of ['.env', '.omni/runtime/control.json', '.git/config'].entries()) {
        const ref = prepareTaskWorkspace({ ...options, attempt: i + 1 });
        const target = path.join(ref.workerRoot, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'worker-created forbidden file');
        assert.throws(() => collectTaskResult({ workspaceRoot: root, reference: ref }),
            (error) => error.code === 'DUAL_SCOPE_VIOLATION', file);
    }
});

test('worker environment prevents git from discovering the parent source repository', (t) => {
    const { root, options } = fixture(t);
    const initialized = spawnSync('git', ['init'], { cwd: root, shell: false, windowsHide: true, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const ref = prepareTaskWorkspace(options);
    assert.equal(ref.workerEnv?.GIT_CEILING_DIRECTORIES, path.dirname(ref.workerRoot).replace(/\\/g, '/'));
    const env = { ...process.env, ...ref.workerEnv };
    for (const key of ref.workerEnvUnset) delete env[key];
    const detected = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: ref.workerRoot, env, shell: false, windowsHide: true, encoding: 'utf8',
    });
    assert.notEqual(detected.status, 0, 'private snapshot must not resolve source Git repository');
    assert.equal(fs.existsSync(path.join(ref.workerRoot, '.git')), false);
});

test('isEphemeralWorkspaceArtifact identifies transient build and linter caches', () => {
    assert.equal(isEphemeralWorkspaceArtifact('tsconfig.tsbuildinfo'), true);
    assert.equal(isEphemeralWorkspaceArtifact('tsconfig.node.tsbuildinfo'), true);
    assert.equal(isEphemeralWorkspaceArtifact('.eslintcache'), true);
    assert.equal(isEphemeralWorkspaceArtifact('.prettiercache'), true);
    assert.equal(isEphemeralWorkspaceArtifact('coverage/lcov.info'), true);
    assert.equal(isEphemeralWorkspaceArtifact('.vitest-reports/junit.xml'), true);
    assert.equal(isEphemeralWorkspaceArtifact('.turbo/cache.json'), true);
    assert.equal(isEphemeralWorkspaceArtifact('src/index.js'), false);
    assert.equal(isEphemeralWorkspaceArtifact('package.json'), false);
});

test('collectTaskResult scrubs newly generated untracked caches and denied build outputs while preserving safety', (t) => {
    const { root, options } = fixture(t);
    const ref = prepareTaskWorkspace({
        ...options,
        allowedFiles: ['src/a.js'],
        denyPatterns: ['dist/**', 'build/**'],
    });

    fs.writeFileSync(path.join(ref.workerRoot, 'src/a.js'), 'updated code\n');
    fs.writeFileSync(path.join(ref.workerRoot, 'tsconfig.tsbuildinfo'), 'dummy-cache');
    fs.writeFileSync(path.join(ref.workerRoot, '.eslintcache'), 'dummy-cache');
    fs.mkdirSync(path.join(ref.workerRoot, 'coverage'), { recursive: true });
    fs.writeFileSync(path.join(ref.workerRoot, 'coverage/lcov.info'), 'TN:');
    fs.mkdirSync(path.join(ref.workerRoot, 'dist/nested'), { recursive: true });
    fs.writeFileSync(path.join(ref.workerRoot, 'dist/nested/bundle.js'), 'console.log(1)');

    const result = collectTaskResult({ workspaceRoot: root, reference: ref });
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].path, 'src/a.js');

    assert.equal(fs.existsSync(path.join(ref.workerRoot, 'tsconfig.tsbuildinfo')), false);
    assert.equal(fs.existsSync(path.join(ref.workerRoot, '.eslintcache')), false);
    assert.equal(fs.existsSync(path.join(ref.workerRoot, 'coverage')), false);
    assert.equal(fs.existsSync(path.join(ref.workerRoot, 'dist')), false);
});

test('collectTaskResult does not scrub existing baseline files modified outside allowed scope', (t) => {
    const { root, options } = fixture(t);
    const ref = prepareTaskWorkspace({
        ...options,
        allowedFiles: ['src/a.js'],
        denyPatterns: ['dist/**'],
    });

    fs.writeFileSync(path.join(ref.workerRoot, 'src/b.js'), 'unauthorized edit\n');

    assert.throws(
        () => collectTaskResult({ workspaceRoot: root, reference: ref }),
        (error) => error.code === 'DUAL_SCOPE_VIOLATION'
    );
});
