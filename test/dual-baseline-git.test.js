'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
    detectBaselineBackend,
    createBaseline,
} = require('../lib/dual/baseline');
const {
    createGitBaseline,
} = require('../lib/dual/baseline-git');
const {
    resolveWorkspace,
    normalizeRepoPath,
    assertBaseWorkspace,
} = require('../lib/dual/workspace');
const {
    BaselineIdentitySchema,
} = require('../lib/dual/contracts');

const tempDirs = [];

function makeTemp(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function git(repo, args) {
    const result = spawnSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        shell: false,
    });
    assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
    return result.stdout;
}

function makeRepo() {
    const repo = makeTemp('omni-dual-git-');
    git(repo, ['init']);
    git(repo, ['config', 'user.name', 'Omni Test']);
    git(repo, ['config', 'user.email', 'omni@example.invalid']);
    fs.writeFileSync(path.join(repo, 'index.html'), '<main>base</main>\n', 'utf8');
    git(repo, ['add', 'index.html']);
    git(repo, ['commit', '-m', 'base']);
    return repo;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

describe('detectBaselineBackend', () => {
    it('detects git backend for an existing repository root and nested subdirectory', () => {
        const repo = makeRepo();
        assert.equal(detectBaselineBackend(repo), 'git');

        const nested = path.join(repo, 'src', 'components');
        fs.mkdirSync(nested, { recursive: true });
        assert.equal(detectBaselineBackend(nested), 'git');
    });

    it('detects snapshot backend for greenfield directory without mutating or running git init', () => {
        const greenfield = makeTemp('omni-greenfield-');
        assert.equal(fs.existsSync(path.join(greenfield, '.git')), false);

        const backend = detectBaselineBackend(greenfield);
        assert.equal(backend, 'snapshot');
        assert.equal(fs.existsSync(path.join(greenfield, '.git')), false);
    });

    it('detects snapshot backend if runner reports a top-level not containing root', () => {
        const fakeRunner = () => 'C:\\other\\unrelated\\repo\n';
        const temp = makeTemp('omni-probe-');
        const backend = detectBaselineBackend(temp, { gitRunner: fakeRunner });
        assert.equal(backend, 'snapshot');
    });
});

describe('createGitBaseline', () => {
    it('captures valid git identity conforming to BaselineIdentitySchema', () => {
        const repo = makeRepo();
        const expectedHead = git(repo, ['rev-parse', 'HEAD']).trim();
        const baseline = createGitBaseline({ root: repo });
        const identity = baseline.capture();

        assert.equal(identity.kind, 'git');
        assert.equal(identity.id, expectedHead);
        assert.doesNotThrow(() => BaselineIdentitySchema.parse(identity));
    });

    it('rejects capture on non-git directory or repo without commits', () => {
        const nonGit = makeTemp('omni-nongit-');
        assert.throws(
            () => createGitBaseline({ root: nonGit }).capture(),
            { code: 'DUAL_NOT_GIT_REPOSITORY' }
        );

        const emptyRepo = makeTemp('omni-empty-repo-');
        git(emptyRepo, ['init']);
        assert.throws(
            () => createGitBaseline({ root: emptyRepo }).capture(),
            { code: 'DUAL_GIT_HEAD_MISSING' }
        );
    });

    it('diff detects tracked modification, untracked file, and deletion appearing exactly once', () => {
        const repo = makeRepo();
        fs.writeFileSync(path.join(repo, 'tracked-file.txt'), 'tracked initial\n', 'utf8');
        fs.writeFileSync(path.join(repo, 'to-delete.txt'), 'will delete\n', 'utf8');
        git(repo, ['add', 'tracked-file.txt', 'to-delete.txt']);
        git(repo, ['commit', '-m', 'add files']);

        const baseline = createGitBaseline({ root: repo });
        const identity = baseline.capture();

        // 1. Tracked modification
        fs.writeFileSync(path.join(repo, 'tracked-file.txt'), 'tracked modified\n', 'utf8');
        // 2. Untracked file
        fs.writeFileSync(path.join(repo, 'untracked-file.txt'), 'untracked new\n', 'utf8');
        // 3. Deletion
        fs.unlinkSync(path.join(repo, 'to-delete.txt'));

        const diffs = baseline.diff(identity);
        const paths = diffs.map((entry) => entry.path);

        assert.deepEqual(paths, [
            'to-delete.txt',
            'tracked-file.txt',
            'untracked-file.txt',
        ]);
        // Tracked modification appears exactly once
        assert.equal(paths.filter((p) => p === 'tracked-file.txt').length, 1);
    });

    it('diff preserves spaces and Unicode characters in filenames', () => {
        const repo = makeRepo();
        const baseline = createGitBaseline({ root: repo });
        const identity = baseline.capture();

        fs.writeFileSync(path.join(repo, 'hello world with spaces.txt'), 'content\n', 'utf8');
        fs.writeFileSync(path.join(repo, 'tést-ünicøde-日本語-🚀.txt'), 'unicode content\n', 'utf8');

        const diffs = baseline.diff(identity);
        const paths = diffs.map((entry) => entry.path);

        assert.ok(paths.includes('hello world with spaces.txt'));
        assert.ok(paths.includes('tést-ünicøde-日本語-🚀.txt'));
    });

    it('diff produces deterministically sorted unique output with no duplicate entries', () => {
        const repo = makeRepo();
        fs.writeFileSync(path.join(repo, 'z-file.txt'), 'z\n', 'utf8');
        fs.writeFileSync(path.join(repo, 'a-file.txt'), 'a\n', 'utf8');
        git(repo, ['add', 'z-file.txt', 'a-file.txt']);
        git(repo, ['commit', '-m', 'add z and a']);

        const baseline = createGitBaseline({ root: repo });
        const identity = baseline.capture();

        fs.writeFileSync(path.join(repo, 'z-file.txt'), 'z modified\n', 'utf8');
        fs.writeFileSync(path.join(repo, 'm-untracked.txt'), 'm\n', 'utf8');
        fs.writeFileSync(path.join(repo, 'b-untracked.txt'), 'b\n', 'utf8');

        const diff1 = baseline.diff(identity);
        const diff2 = baseline.diff(identity);

        assert.deepEqual(diff1, diff2);
        assert.deepEqual(diff1.map((d) => d.path), [
            'b-untracked.txt',
            'm-untracked.txt',
            'z-file.txt',
        ]);
    });

    it('diff, fingerprint, and assertScope reject snapshot identity', () => {
        const repo = makeRepo();
        const baseline = createGitBaseline({ root: repo });
        const snapshotIdentity = { kind: 'snapshot', id: 'f'.repeat(64) };

        assert.throws(() => baseline.diff(snapshotIdentity), {
            code: 'DUAL_BASELINE_KIND_INVALID',
        });
        assert.throws(() => baseline.fingerprint(snapshotIdentity), {
            code: 'DUAL_BASELINE_KIND_INVALID',
        });
        assert.throws(() => baseline.assertScope(snapshotIdentity, { allowedFiles: ['index.html'] }), {
            code: 'DUAL_BASELINE_KIND_INVALID',
        });
    });

    it('diff, fingerprint, and assertScope detect stale HEAD with DUAL_BASE_COMMIT_STALE', () => {
        const repo = makeRepo();
        const baseline = createGitBaseline({ root: repo });
        const identity = baseline.capture();

        // Advance HEAD with a new commit
        fs.writeFileSync(path.join(repo, 'new-commit.txt'), 'new\n', 'utf8');
        git(repo, ['add', 'new-commit.txt']);
        git(repo, ['commit', '-m', 'stale advance']);

        assert.throws(() => baseline.diff(identity), {
            code: 'DUAL_BASE_COMMIT_STALE',
        });
        assert.throws(() => baseline.fingerprint(identity), {
            code: 'DUAL_BASE_COMMIT_STALE',
        });
        assert.throws(() => baseline.assertScope(identity, { allowedFiles: ['new-commit.txt'] }), {
            code: 'DUAL_BASE_COMMIT_STALE',
        });
    });

    it('fingerprint reuses scope-guard captureDiffFingerprint and honors excludedPaths', () => {
        const repo = makeRepo();
        const baseline = createGitBaseline({ root: repo });
        const identity = baseline.capture();

        fs.writeFileSync(path.join(repo, 'index.html'), '<main>updated</main>\n', 'utf8');
        const excludedDir = path.join(repo, '.omni', 'runs', 'TASK-1');
        fs.mkdirSync(excludedDir, { recursive: true });
        fs.writeFileSync(path.join(excludedDir, 'temp.json'), '{"ignore":true}\n', 'utf8');

        const fp = baseline.fingerprint(identity, {
            excludedPaths: ['.omni/runs/TASK-1'],
        });

        assert.deepEqual(fp.files, ['index.html']);
        assert.match(fp.patchSha256, /^[0-9a-f]{64}$/);
    });

    it('assertScope reuses assertAllowedDiff and handles allowlist, deny-patterns, and excludedPaths', () => {
        const repo = makeRepo();
        const baseline = createGitBaseline({ root: repo });
        const identity = baseline.capture();

        fs.writeFileSync(path.join(repo, 'index.html'), '<main>allowed</main>\n', 'utf8');
        fs.writeFileSync(path.join(repo, 'src.js'), 'console.log("ok");\n', 'utf8');

        // Allowed diff passes
        const verdict = baseline.assertScope(identity, {
            allowedFiles: ['index.html', 'src.js'],
            denyPatterns: ['**/.env*'],
        });
        assert.deepEqual(verdict.changedFiles, ['index.html', 'src.js']);

        // Scope violation throws
        assert.throws(() => baseline.assertScope(identity, {
            allowedFiles: ['index.html'],
            denyPatterns: [],
        }), { code: 'DUAL_SCOPE_VIOLATION' });

        // Deny pattern throws
        assert.throws(() => baseline.assertScope(identity, {
            allowedFiles: ['index.html', 'src.js'],
            denyPatterns: ['*.js'],
        }), { code: 'DUAL_DENY_PATTERN' });
    });

    it('assertScope requires valid git identity and rejects explicit changedFiles fallback', () => {
        const repo = makeRepo();
        const baseline = createGitBaseline({ root: repo });
        const identity = baseline.capture();

        // Must reject calls missing identity even if changedFiles is provided
        assert.throws(
            () => baseline.assertScope({ changedFiles: [], allowedFiles: [] }),
            { code: 'DUAL_SCOPE_IDENTITY_MISSING' }
        );
        assert.throws(
            () => baseline.assertScope(undefined, { changedFiles: [] }),
            { code: 'DUAL_SCOPE_IDENTITY_MISSING' }
        );

        // Verify both legitimate call forms work when valid identity is supplied
        fs.writeFileSync(path.join(repo, 'index.html'), '<main>allowed</main>\n', 'utf8');

        // Form 1: assertScope(identity, options)
        const verdict1 = baseline.assertScope(identity, {
            allowedFiles: ['index.html'],
        });
        assert.deepEqual(verdict1.changedFiles, ['index.html']);

        // Form 2: assertScope({ identity, ...options })
        const verdict2 = baseline.assertScope({
            identity,
            allowedFiles: ['index.html'],
        });
        assert.deepEqual(verdict2.changedFiles, ['index.html']);
    });

    it('createBaseline factory routes to git baseline without loading snapshot module', () => {
        const repo = makeRepo();
        const baseline = createBaseline({ root: repo });
        const identity = baseline.capture();
        assert.equal(identity.kind, 'git');

        const greenfield = makeTemp('omni-greenfield-factory-');
        assert.throws(() => createBaseline({ root: greenfield }), {
            code: 'DUAL_BASELINE_BACKEND_UNSUPPORTED',
        });
    });
});

describe('v1 workspace compatibility', () => {
    it('resolveWorkspace, normalizeRepoPath, and assertBaseWorkspace continue to function as expected', () => {
        const repo = makeRepo();
        const workspace = resolveWorkspace(repo);
        assert.equal(workspace.repoRoot, fs.realpathSync.native(repo));
        assert.match(workspace.head, /^[0-9a-f]{40}$/);

        assert.equal(normalizeRepoPath(repo, 'nested/file.txt'), 'nested/file.txt');
        assert.throws(() => normalizeRepoPath(repo, '../outside.txt'), { code: 'DUAL_PATH_ESCAPE' });

        assert.doesNotThrow(() => assertBaseWorkspace({
            repoRoot: repo,
            expectedBaseCommit: workspace.head,
        }));
    });
});
