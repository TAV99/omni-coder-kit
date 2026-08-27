'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
    resolveWorkspace,
    normalizeRepoPath,
    assertBaseWorkspace,
} = require('../lib/dual/workspace');
const {
    matchesDenyPattern,
    captureDiffFingerprint,
    assertAllowedDiff,
    assertReviewUnchanged,
} = require('../lib/dual/scope-guard');

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
    const repo = makeTemp('omni-dual-repo-');
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

describe('dual workspace identity', () => {
    it('resolves the canonical repository and current base commit', () => {
        const repo = makeRepo();
        const nested = path.join(repo, 'src');
        fs.mkdirSync(nested);
        const workspace = resolveWorkspace(nested);
        assert.equal(workspace.repoRoot, fs.realpathSync.native(repo));
        assert.match(workspace.head, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
        assert.deepEqual(workspace.sourceChanges, []);
    });

    it('rejects traversal, Windows absolute paths, UNC paths, and NUL', () => {
        const repo = makeRepo();
        assert.equal(normalizeRepoPath(repo, 'tests/a.test.js'), 'tests/a.test.js');
        assert.throws(() => normalizeRepoPath(repo, '../outside.txt'), { code: 'DUAL_PATH_ESCAPE' });
        assert.throws(() => normalizeRepoPath(repo, 'C:\\scratch\\a.js'), { code: 'DUAL_PATH_ESCAPE' });
        assert.throws(() => normalizeRepoPath(repo, '\\\\server\\share\\a.js'), { code: 'DUAL_PATH_ESCAPE' });
        assert.throws(() => normalizeRepoPath(repo, 'a\0b.js'), { code: 'DUAL_PATH_ESCAPE' });
    });

    it('rejects symlink paths that resolve outside the repository', (t) => {
        const repo = makeRepo();
        const outside = makeTemp('omni-dual-outside-');
        const link = path.join(repo, 'linked-outside');
        try {
            fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
        } catch (error) {
            t.skip(`symlink/junction unavailable: ${error.code}`);
            return;
        }
        assert.throws(() => normalizeRepoPath(repo, 'linked-outside/new.js'), { code: 'DUAL_PATH_ESCAPE' });
    });

    it('requires the expected base and ignores only the active transaction directory', () => {
        const repo = makeRepo();
        const base = git(repo, ['rev-parse', 'HEAD']).trim();
        const runDir = path.join(repo, '.omni', 'codex-gemini', 'runs', 'TASK-1');
        fs.mkdirSync(runDir, { recursive: true });
        fs.writeFileSync(path.join(runDir, 'state.json'), '{}\n');

        assert.doesNotThrow(() => assertBaseWorkspace({
            repoRoot: repo,
            expectedBaseCommit: base,
            excludedRunDir: runDir,
        }));

        fs.writeFileSync(path.join(repo, 'outside.txt'), 'not allowed\n');
        assert.throws(() => assertBaseWorkspace({
            repoRoot: repo,
            expectedBaseCommit: base,
            excludedRunDir: runDir,
        }), { code: 'DUAL_WORKTREE_DIRTY' });
    });
});

describe('dual scope guard', () => {
    it('matches bounded deny globs without shell expansion', () => {
        assert.equal(matchesDenyPattern('config/.env.local', '**/.env*'), true);
        assert.equal(matchesDenyPattern('.env', '**/.env*'), true);
        assert.equal(matchesDenyPattern('src/app.js', '**/.env*'), false);
        assert.equal(matchesDenyPattern('src/app.js', 'src/*.js'), true);
        assert.equal(matchesDenyPattern('src/nested/app.js', 'src/*.js'), false);
        assert.equal(matchesDenyPattern('src/a.js', 'src/?.js'), true);
    });

    it('rejects files outside the allowlist and lets deny patterns win', () => {
        assert.throws(() => assertAllowedDiff({
            changedFiles: ['index.html', 'scratch.txt'],
            allowedFiles: ['index.html'],
            denyPatterns: [],
        }), { code: 'DUAL_SCOPE_VIOLATION' });

        assert.throws(() => assertAllowedDiff({
            changedFiles: ['config/.env.local'],
            allowedFiles: ['config/.env.local'],
            denyPatterns: ['**/.env*'],
        }), { code: 'DUAL_DENY_PATTERN' });

        assert.doesNotThrow(() => assertAllowedDiff({
            changedFiles: ['index.html', 'styles.css'],
            allowedFiles: ['index.html', 'styles.css'],
            denyPatterns: ['**/.env*'],
        }));
    });

    it('fingerprints tracked and untracked changes deterministically', () => {
        const repo = makeRepo();
        const base = git(repo, ['rev-parse', 'HEAD']).trim();
        fs.writeFileSync(path.join(repo, 'index.html'), '<main>changed</main>\n');
        fs.writeFileSync(path.join(repo, 'styles.css'), 'body {}\n');

        const first = captureDiffFingerprint({ repoRoot: repo, baseCommit: base });
        const second = captureDiffFingerprint({ repoRoot: repo, baseCommit: base });
        assert.deepEqual(first.files, ['index.html', 'styles.css']);
        assert.equal(first.patchSha256, second.patchSha256);
        assert.match(first.patchSha256, /^[0-9a-f]{64}$/);
    });

    it('excludes only explicit transaction paths from source fingerprints', () => {
        const repo = makeRepo();
        const base = git(repo, ['rev-parse', 'HEAD']).trim();
        fs.writeFileSync(path.join(repo, 'index.html'), '<main>changed</main>\n');
        fs.mkdirSync(path.join(repo, '.omni', 'codex-gemini', 'runs', 'TASK-1'), { recursive: true });
        fs.writeFileSync(
            path.join(repo, '.omni', 'codex-gemini', 'runs', 'TASK-1', 'review.stdout.json'),
            '{}\n',
        );

        const fingerprint = captureDiffFingerprint({
            repoRoot: repo,
            baseCommit: base,
            excludedPaths: ['.omni/codex-gemini/runs/TASK-1'],
        });

        assert.deepEqual(fingerprint.files, ['index.html']);
        fs.writeFileSync(
            path.join(repo, '.omni', 'codex-gemini', 'runs', 'TASK-1', 'review.stdout.json'),
            '{"changed":true}\n',
        );
        assert.deepEqual(captureDiffFingerprint({
            repoRoot: repo,
            baseCommit: base,
            excludedPaths: ['.omni/codex-gemini/runs/TASK-1'],
        }), fingerprint);
    });

    it('rejects any review-time diff mutation', () => {
        assert.throws(() => assertReviewUnchanged(
            { files: ['index.html'], patchSha256: 'a'.repeat(64) },
            { files: ['index.html'], patchSha256: 'b'.repeat(64) }
        ), { code: 'DUAL_REVIEW_MUTATION' });

        assert.doesNotThrow(() => assertReviewUnchanged(
            { files: ['index.html'], patchSha256: 'a'.repeat(64) },
            { files: ['index.html'], patchSha256: 'a'.repeat(64) }
        ));
    });
});
