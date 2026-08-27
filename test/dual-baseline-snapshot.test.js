'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
    createSnapshotBaseline,
    computeSnapshotRootHash,
} = require('../lib/dual/baseline-snapshot');
const {
    BaselineIdentitySchema,
} = require('../lib/dual/contracts');

const tempDirs = [];

function makeTemp(prefix = 'omni-snapshot-') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors on busy Windows handles
        }
    }
});

describe('createSnapshotBaseline - initialization and validation', () => {
    it('validates root exists and is a directory', () => {
        const nonExistent = path.join(os.tmpdir(), `non-existent-${Date.now()}`);
        assert.throws(
            () => createSnapshotBaseline({ root: nonExistent }),
            { code: 'DUAL_SNAPSHOT_ROOT_INVALID' }
        );

        const tempDir = makeTemp();
        const filePath = path.join(tempDir, 'file.txt');
        fs.writeFileSync(filePath, 'hello');
        assert.throws(
            () => createSnapshotBaseline({ root: filePath }),
            { code: 'DUAL_NOT_DIRECTORY' }
        );
    });

    it('rejects invalid root argument types', () => {
        assert.throws(() => createSnapshotBaseline({ root: null }), { code: 'DUAL_SNAPSHOT_ROOT_INVALID' });
        assert.throws(() => createSnapshotBaseline({ root: '' }), { code: 'DUAL_SNAPSHOT_ROOT_INVALID' });
        assert.throws(() => createSnapshotBaseline({ root: 123 }), { code: 'DUAL_SNAPSHOT_ROOT_INVALID' });
    });

    it('rejects unsafe buildOutputs ignore patterns (traversal, absolute, NUL)', () => {
        const root = makeTemp();
        assert.throws(
            () => createSnapshotBaseline({ root, ignorePolicy: { buildOutputs: ['../outside'] } }),
            { code: 'DUAL_PATH_ESCAPE' }
        );
        assert.throws(
            () => createSnapshotBaseline({ root, ignorePolicy: { buildOutputs: ['dist\0bad'] } }),
            { code: 'DUAL_PATH_ESCAPE' }
        );
        const absPath = path.resolve(root, 'dist');
        assert.throws(
            () => createSnapshotBaseline({ root, ignorePolicy: { buildOutputs: [absPath] } }),
            { code: 'DUAL_PATH_ESCAPE' }
        );
    });
});

describe('createSnapshotBaseline - capture', () => {
    it('captures empty directory with stable identity and valid schema', () => {
        const root = makeTemp();
        const baseline = createSnapshotBaseline({ root });

        const first = baseline.capture();
        assert.equal(first.identity.kind, 'snapshot');
        assert.match(first.identity.id, /^[0-9a-f]{64}$/);
        assert.doesNotThrow(() => BaselineIdentitySchema.parse(first.identity));
        assert.deepEqual(first.manifest.files, []);

        const second = baseline.capture();
        assert.equal(first.identity.id, second.identity.id);
        assert.deepEqual(first.manifest, second.manifest);
    });

    it('captures files with normalized POSIX paths, types, byte sizes, and SHA-256 hashes', () => {
        const root = makeTemp();
        const subDir = path.join(root, 'src', 'utils');
        fs.mkdirSync(subDir, { recursive: true });
        const content = 'export const add = (a, b) => a + b;\n';
        fs.writeFileSync(path.join(subDir, 'math.js'), content, 'utf8');

        const expectedHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
        const expectedSize = Buffer.byteLength(content, 'utf8');

        const baseline = createSnapshotBaseline({ root });
        const { identity, manifest } = baseline.capture();

        assert.equal(identity.kind, 'snapshot');
        assert.equal(manifest.files.length, 1);
        const entry = manifest.files[0];
        assert.equal(entry.path, 'src/utils/math.js');
        assert.equal(entry.type, 'file');
        assert.equal(entry.size, expectedSize);
        assert.equal(entry.hash, expectedHash);
    });

    it('manifest is immutable and frozen', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'file.txt'), 'hello', 'utf8');
        const baseline = createSnapshotBaseline({ root });
        const { manifest } = baseline.capture();

        assert.ok(Object.isFrozen(manifest));
        assert.ok(Object.isFrozen(manifest.files));
        assert.ok(Object.isFrozen(manifest.files[0]));

        assert.throws(() => {
            manifest.files.push({ path: 'tampered.txt' });
        });
        assert.throws(() => {
            manifest.files[0].path = 'modified.txt';
        });
    });

    it('preserves spaces and Unicode characters in filenames', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'hello world with spaces.txt'), 'content 1\n', 'utf8');
        fs.writeFileSync(path.join(root, 'tést-ünicøde-日本語-🚀.txt'), 'unicode content\n', 'utf8');

        const baseline = createSnapshotBaseline({ root });
        const { manifest } = baseline.capture();

        const paths = manifest.files.map((e) => e.path);
        assert.ok(paths.includes('hello world with spaces.txt'));
        assert.ok(paths.includes('tést-ünicøde-日本語-🚀.txt'));
    });

    it('produces deterministically sorted entries regardless of directory creation order', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'z.txt'), 'z\n', 'utf8');
        fs.writeFileSync(path.join(root, 'a.txt'), 'a\n', 'utf8');
        fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(root, 'sub', 'm.txt'), 'm\n', 'utf8');
        fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'b\n', 'utf8');

        const baseline = createSnapshotBaseline({ root });
        const { manifest } = baseline.capture();

        const paths = manifest.files.map((e) => e.path);
        assert.deepEqual(paths, [
            'a.txt',
            'sub/b.txt',
            'sub/m.txt',
            'z.txt',
        ]);
    });
});

describe('createSnapshotBaseline - default and configured ignores', () => {
    it('ignores .git, node_modules, .omni/runtime, and OS/editor temporary files', () => {
        const root = makeTemp();

        // Files to ignore
        fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
        fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        fs.mkdirSync(path.join(root, 'node_modules', 'foo'), { recursive: true });
        fs.writeFileSync(path.join(root, 'node_modules', 'foo', 'index.js'), 'module.exports = {};\n');
        fs.mkdirSync(path.join(root, '.omni', 'runtime'), { recursive: true });
        fs.writeFileSync(path.join(root, '.omni', 'runtime', 'daemon.json'), '{"pid":123}\n');
        fs.writeFileSync(path.join(root, '.DS_Store'), 'ds_store');
        fs.writeFileSync(path.join(root, 'Thumbs.db'), 'thumbs');
        fs.writeFileSync(path.join(root, 'file.txt~'), 'backup');
        fs.writeFileSync(path.join(root, 'file.swp'), 'swap');
        fs.writeFileSync(path.join(root, 'temp.tmp'), 'temp');

        // Files to include
        fs.writeFileSync(path.join(root, 'index.js'), 'console.log("hello");\n');
        fs.mkdirSync(path.join(root, '.omni', 'sdlc'), { recursive: true });
        fs.writeFileSync(path.join(root, '.omni', 'sdlc', 'setup.json'), '{"program":"npm"}\n');

        const baseline = createSnapshotBaseline({ root });
        const { manifest } = baseline.capture();

        const paths = manifest.files.map((e) => e.path);
        assert.deepEqual(paths, [
            '.omni/sdlc/setup.json',
            'index.js',
        ]);
    });

    it('honors ignorePolicy.buildOutputs directory and file prefixes', () => {
        const root = makeTemp();
        fs.mkdirSync(path.join(root, 'dist', 'bundles'), { recursive: true });
        fs.writeFileSync(path.join(root, 'dist', 'bundles', 'app.min.js'), 'code');
        fs.mkdirSync(path.join(root, 'build'), { recursive: true });
        fs.writeFileSync(path.join(root, 'build', 'output.txt'), 'build output');
        fs.mkdirSync(path.join(root, 'src'), { recursive: true });
        fs.writeFileSync(path.join(root, 'src', 'index.js'), 'src code');

        const baseline = createSnapshotBaseline({
            root,
            ignorePolicy: {
                buildOutputs: ['dist', 'build/output.txt'],
            },
        });
        const { manifest } = baseline.capture();

        const paths = manifest.files.map((e) => e.path);
        assert.deepEqual(paths, ['src/index.js']);
    });
});

describe('createSnapshotBaseline - diff', () => {
    it('detects created, modified, and deleted files with sorted unique output', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'keep.txt'), 'keep initial\n', 'utf8');
        fs.writeFileSync(path.join(root, 'modify.txt'), 'modify initial\n', 'utf8');
        fs.writeFileSync(path.join(root, 'delete.txt'), 'delete initial\n', 'utf8');

        const baseline = createSnapshotBaseline({ root });
        const initial = baseline.capture();

        // Perform mutations
        fs.writeFileSync(path.join(root, 'modify.txt'), 'modify changed\n', 'utf8');
        fs.unlinkSync(path.join(root, 'delete.txt'));
        fs.writeFileSync(path.join(root, 'create.txt'), 'create new\n', 'utf8');

        const changes = baseline.diff(initial.identity, initial.manifest);

        assert.deepEqual(changes, [
            { path: 'create.txt', change: 'created' },
            { path: 'delete.txt', change: 'deleted' },
            { path: 'modify.txt', change: 'modified' },
        ]);
    });

    it('returns empty array when workspace is unchanged', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'app.js'), 'const a = 1;\n', 'utf8');

        const baseline = createSnapshotBaseline({ root });
        const initial = baseline.capture();

        const changes = baseline.diff(initial.identity, initial.manifest);
        assert.deepEqual(changes, []);
    });

    it('detects modification when size is identical but content bytes changed', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'data.txt'), 'AAAAA', 'utf8');

        const baseline = createSnapshotBaseline({ root });
        const initial = baseline.capture();

        fs.writeFileSync(path.join(root, 'data.txt'), 'BBBBB', 'utf8');

        const changes = baseline.diff(initial.identity, initial.manifest);
        assert.deepEqual(changes, [
            { path: 'data.txt', change: 'modified' },
        ]);
    });

    it('preserves spaces and Unicode in diff output', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'hello world.txt'), 'v1\n', 'utf8');

        const baseline = createSnapshotBaseline({ root });
        const initial = baseline.capture();

        fs.writeFileSync(path.join(root, 'hello world.txt'), 'v2\n', 'utf8');
        fs.writeFileSync(path.join(root, 'tést-ünicøde-日本語-🚀.txt'), 'new unicode\n', 'utf8');

        const changes = baseline.diff(initial.identity, initial.manifest);
        assert.deepEqual(changes, [
            { path: 'hello world.txt', change: 'modified' },
            { path: 'tést-ünicøde-日本語-🚀.txt', change: 'created' },
        ]);
    });
});

describe('createSnapshotBaseline - validation and tampering defense', () => {
    it('rejects non-snapshot identity kinds', () => {
        const root = makeTemp();
        const baseline = createSnapshotBaseline({ root });
        const initial = baseline.capture();

        const gitIdentity = { kind: 'git', id: 'a'.repeat(40) };
        assert.throws(
            () => baseline.diff(gitIdentity, initial.manifest),
            { code: 'DUAL_BASELINE_KIND_INVALID' }
        );
    });

    it('rejects tampered manifest or identity mismatch before inspecting filesystem', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'file.txt'), 'content\n', 'utf8');
        const baseline = createSnapshotBaseline({ root });
        const initial = baseline.capture();

        // Tampered identity ID
        const fakeIdentity = { kind: 'snapshot', id: '0'.repeat(64) };
        assert.throws(
            () => baseline.diff(fakeIdentity, initial.manifest),
            { code: 'DUAL_SNAPSHOT_BASELINE_INVALID' }
        );

        // Tampered manifest files
        const tamperedManifest = {
            schema_version: 1,
            files: [
                { path: 'file.txt', type: 'file', size: 8, hash: 'f'.repeat(64) },
            ],
        };
        assert.throws(
            () => baseline.diff(initial.identity, tamperedManifest),
            { code: 'DUAL_SNAPSHOT_BASELINE_INVALID' }
        );
    });

    it('rejects missing or malformed manifest', () => {
        const root = makeTemp();
        const baseline = createSnapshotBaseline({ root });
        const initial = baseline.capture();

        assert.throws(
            () => baseline.diff(initial.identity, null),
            { code: 'DUAL_SNAPSHOT_BASELINE_INVALID' }
        );
        assert.throws(
            () => baseline.diff(initial.identity, {}),
            { code: 'DUAL_SNAPSHOT_BASELINE_INVALID' }
        );
    });
});

describe('createSnapshotBaseline - symlink and escape safety', () => {
    it('rejects symlink or junction escaping canonical root with DUAL_PATH_ESCAPE', (t) => {
        const root = makeTemp('omni-root-');
        const outside = makeTemp('omni-outside-');
        fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n', 'utf8');

        const linkPath = path.join(root, 'external-link');
        let linkCreated = false;

        // Try creating directory junction or symlink
        try {
            fs.symlinkSync(outside, linkPath, 'junction');
            linkCreated = true;
        } catch {
            try {
                fs.symlinkSync(outside, linkPath, 'dir');
                linkCreated = true;
            } catch {
                // Platform does not permit creating symlinks without privileges
            }
        }

        if (!linkCreated) {
            t.skip('Platform privileges do not permit symlink/junction creation in test environment');
            return;
        }

        const baseline = createSnapshotBaseline({ root });
        assert.throws(
            () => baseline.capture(),
            { code: 'DUAL_PATH_ESCAPE' }
        );
    });

    it('rejects file symlink escaping canonical root with DUAL_PATH_ESCAPE', (t) => {
        const root = makeTemp('omni-root-');
        const outside = makeTemp('omni-outside-');
        const outsideFile = path.join(outside, 'outside.txt');
        fs.writeFileSync(outsideFile, 'outside\n', 'utf8');

        const linkPath = path.join(root, 'escape-file.txt');
        let linkCreated = false;

        try {
            fs.symlinkSync(outsideFile, linkPath, 'file');
            linkCreated = true;
        } catch {
            // Platform permissions might prevent file symlink
        }

        if (!linkCreated) {
            t.skip('Platform privileges do not permit file symlink creation');
            return;
        }

        const baseline = createSnapshotBaseline({ root });
        assert.throws(
            () => baseline.capture(),
            { code: 'DUAL_PATH_ESCAPE' }
        );
    });
});

describe('createSnapshotBaseline - no Git side effects and non-mutating guarantee', () => {
    it('never initializes .git or runs git commands', () => {
        const root = makeTemp('omni-greenfield-');
        assert.equal(fs.existsSync(path.join(root, '.git')), false);

        const baseline = createSnapshotBaseline({ root });
        const { identity, manifest } = baseline.capture();
        fs.writeFileSync(path.join(root, 'test.txt'), 'hello\n', 'utf8');
        const diff = baseline.diff(identity, manifest);

        assert.equal(diff.length, 1);
        assert.equal(fs.existsSync(path.join(root, '.git')), false);
    });
});

describe('createSnapshotBaseline - fingerprint and assertScope parity', () => {
    it('fingerprint computes deterministic changed files list and patch hash', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'a.txt'), 'v1\n', 'utf8');

        const baseline = createSnapshotBaseline({ root });
        const initial = baseline.capture();

        fs.writeFileSync(path.join(root, 'a.txt'), 'v2\n', 'utf8');
        fs.writeFileSync(path.join(root, 'b.txt'), 'new\n', 'utf8');

        const fp = baseline.fingerprint(initial.identity, initial.manifest);
        assert.deepEqual(fp.files, ['a.txt', 'b.txt']);
        assert.match(fp.patchSha256, /^[0-9a-f]{64}$/);
    });

    it('assertScope enforces allowedFiles and denyPatterns', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'src.js'), 'code 1\n', 'utf8');

        const baseline = createSnapshotBaseline({ root });
        const initial = baseline.capture();

        fs.writeFileSync(path.join(root, 'src.js'), 'code 2\n', 'utf8');

        // Allowed diff passes
        const verdict = baseline.assertScope(initial.identity, initial.manifest, {
            allowedFiles: ['src.js'],
            denyPatterns: ['**/*.env'],
        });
        assert.deepEqual(verdict.changedFiles, ['src.js']);

        // Scope violation throws DUAL_SCOPE_VIOLATION
        assert.throws(
            () => baseline.assertScope(initial.identity, initial.manifest, {
                allowedFiles: ['other.js'],
            }),
            { code: 'DUAL_SCOPE_VIOLATION' }
        );

        // Deny pattern throws DUAL_DENY_PATTERN
        assert.throws(
            () => baseline.assertScope(initial.identity, initial.manifest, {
                allowedFiles: ['src.js'],
                denyPatterns: ['src.js'],
            }),
            { code: 'DUAL_DENY_PATTERN' }
        );
    });
});

describe('createSnapshotBaseline - Codex review finding regression tests', () => {
    it('throws DUAL_FILE_STAT_ERROR when lstatSync fails during scan', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'failing.txt'), 'content\n', 'utf8');
        fs.writeFileSync(path.join(root, 'good.txt'), 'content\n', 'utf8');

        const failingFs = {
            ...fs,
            lstatSync(targetPath, ...args) {
                if (String(targetPath).includes('failing.txt')) {
                    const err = new Error('EACCES: permission denied');
                    err.code = 'EACCES';
                    throw err;
                }
                return fs.lstatSync(targetPath, ...args);
            },
        };

        const baseline = createSnapshotBaseline({ root, fsImpl: failingFs });
        assert.throws(
            () => baseline.capture(),
            (err) => {
                assert.equal(err.code, 'DUAL_FILE_STAT_ERROR');
                assert.equal(err.details?.path, 'failing.txt');
                return true;
            }
        );
    });

    it('rejects malformed, duplicate, or unsafe manifest entries', () => {
        const root = makeTemp();
        const baseline = createSnapshotBaseline({ root });
        const dummySha = 'a'.repeat(64);
        const validIdentity = { kind: 'snapshot', id: dummySha };

        const testCases = [
            // Unsafe paths
            { desc: 'absolute posix path', file: { path: '/etc/passwd', type: 'file', size: 10, hash: dummySha } },
            { desc: 'windows drive path', file: { path: 'C:/secret.txt', type: 'file', size: 10, hash: dummySha } },
            { desc: 'unc path', file: { path: '//server/share/file.txt', type: 'file', size: 10, hash: dummySha } },
            { desc: 'path traversal ..', file: { path: '../secret.txt', type: 'file', size: 10, hash: dummySha } },
            { desc: 'nested traversal', file: { path: 'foo/../bar.txt', type: 'file', size: 10, hash: dummySha } },
            { desc: 'backslash path', file: { path: 'foo\\bar.txt', type: 'file', size: 10, hash: dummySha } },
            { desc: 'leading slash', file: { path: '/foo.txt', type: 'file', size: 10, hash: dummySha } },
            { desc: 'trailing slash', file: { path: 'foo/', type: 'file', size: 10, hash: dummySha } },
            { desc: 'empty path segment', file: { path: 'foo//bar.txt', type: 'file', size: 10, hash: dummySha } },
            { desc: 'dot path segment', file: { path: 'foo/./bar.txt', type: 'file', size: 10, hash: dummySha } },
            { desc: 'NUL byte in path', file: { path: 'foo\0bar.txt', type: 'file', size: 10, hash: dummySha } },
            { desc: 'empty string path', file: { path: '', type: 'file', size: 10, hash: dummySha } },
            { desc: 'non-string path', file: { path: 123, type: 'file', size: 10, hash: dummySha } },

            // Invalid type
            { desc: 'directory type', file: { path: 'dir', type: 'directory', size: 0, hash: dummySha } },
            { desc: 'symlink type', file: { path: 'link', type: 'symlink', size: 10, hash: dummySha } },
            { desc: 'missing type', file: { path: 'file.txt', size: 10, hash: dummySha } },

            // Invalid size
            { desc: 'negative size', file: { path: 'file.txt', type: 'file', size: -1, hash: dummySha } },
            { desc: 'NaN size', file: { path: 'file.txt', type: 'file', size: NaN, hash: dummySha } },
            { desc: 'Infinity size', file: { path: 'file.txt', type: 'file', size: Infinity, hash: dummySha } },
            { desc: 'float size', file: { path: 'file.txt', type: 'file', size: 1.5, hash: dummySha } },
            { desc: 'string size', file: { path: 'file.txt', type: 'file', size: '10', hash: dummySha } },

            // Invalid hash / sha256
            { desc: 'non-hex hash', file: { path: 'file.txt', type: 'file', size: 10, hash: 'not-hex' } },
            { desc: 'uppercase hex hash', file: { path: 'file.txt', type: 'file', size: 10, hash: 'A'.repeat(64) } },
            { desc: 'short hash', file: { path: 'file.txt', type: 'file', size: 10, hash: 'a'.repeat(63) } },
            { desc: 'mismatched hash and sha256', file: { path: 'file.txt', type: 'file', size: 10, hash: 'a'.repeat(64), sha256: 'b'.repeat(64) } },
            { desc: 'missing both hash and sha256', file: { path: 'file.txt', type: 'file', size: 10 } },
        ];

        for (const tc of testCases) {
            const manifest = {
                schema_version: 1,
                files: [tc.file],
            };
            let id;
            try {
                id = computeSnapshotRootHash(manifest.files);
            } catch {
                id = dummySha;
            }
            assert.throws(
                () => baseline.diff({ kind: 'snapshot', id }, manifest),
                { code: 'DUAL_SNAPSHOT_BASELINE_INVALID' },
                `Expected rejection for ${tc.desc}`
            );
        }
    });

    it('rejects duplicate paths in manifest', () => {
        const root = makeTemp();
        const baseline = createSnapshotBaseline({ root });
        const dummySha = 'a'.repeat(64);
        const manifest = {
            schema_version: 1,
            files: [
                { path: 'file.txt', type: 'file', size: 5, hash: dummySha },
                { path: 'file.txt', type: 'file', size: 5, hash: dummySha },
            ],
        };
        const id = computeSnapshotRootHash(manifest.files);
        assert.throws(
            () => baseline.diff({ kind: 'snapshot', id }, manifest),
            { code: 'DUAL_SNAPSHOT_BASELINE_INVALID' }
        );
    });

    it('rejects manifests with invalid schema_version or undeclared top-level keys', () => {
        const root = makeTemp();
        const baseline = createSnapshotBaseline({ root });
        const emptyId = computeSnapshotRootHash([]);
        const identity = { kind: 'snapshot', id: emptyId };

        // Wrong schema_version
        assert.throws(
            () => baseline.diff(identity, { schema_version: 2, files: [] }),
            { code: 'DUAL_SNAPSHOT_BASELINE_INVALID' }
        );
        assert.throws(
            () => baseline.diff(identity, { files: [] }),
            { code: 'DUAL_SNAPSHOT_BASELINE_INVALID' }
        );

        // Undeclared top-level keys
        assert.throws(
            () => baseline.diff(identity, { schema_version: 1, files: [], extraKey: 'bad' }),
            { code: 'DUAL_SNAPSHOT_BASELINE_INVALID' }
        );

        // Raw array manifest rejected
        assert.throws(
            () => baseline.diff(identity, []),
            { code: 'DUAL_SNAPSHOT_BASELINE_INVALID' }
        );
    });

    it('unsorted injected directory order yields identical identity and manifest', () => {
        const root = makeTemp();
        fs.mkdirSync(path.join(root, 'dir-b'), { recursive: true });
        fs.writeFileSync(path.join(root, 'dir-b', 'b1.txt'), 'b1\n');
        fs.writeFileSync(path.join(root, 'dir-b', 'b2.txt'), 'b2\n');
        fs.mkdirSync(path.join(root, 'dir-a'), { recursive: true });
        fs.writeFileSync(path.join(root, 'dir-a', 'a1.txt'), 'a1\n');
        fs.writeFileSync(path.join(root, 'dir-a', 'a2.txt'), 'a2\n');
        fs.writeFileSync(path.join(root, 'root-z.txt'), 'z\n');
        fs.writeFileSync(path.join(root, 'root-a.txt'), 'a\n');

        const reversedFs = {
            ...fs,
            readdirSync(p, opts) {
                const res = fs.readdirSync(p, opts);
                return Array.isArray(res) ? [...res].reverse() : res;
            },
        };

        const forwardFs = {
            ...fs,
            readdirSync(p, opts) {
                const res = fs.readdirSync(p, opts);
                return Array.isArray(res) ? [...res] : res;
            },
        };

        const baselineRev = createSnapshotBaseline({ root, fsImpl: reversedFs });
        const baselineFwd = createSnapshotBaseline({ root, fsImpl: forwardFs });

        const capRev = baselineRev.capture();
        const capFwd = baselineFwd.capture();

        assert.equal(capRev.identity.id, capFwd.identity.id);
        assert.deepEqual(capRev.manifest, capFwd.manifest);
    });

    it('ignores .omni/runs while retaining .omni/sdlc and other .omni config', () => {
        const root = makeTemp();
        fs.mkdirSync(path.join(root, '.omni', 'runs', 'txn-001'), { recursive: true });
        fs.writeFileSync(path.join(root, '.omni', 'runs', 'txn-001', 'events.ndjson'), '{"event":1}\n');
        fs.writeFileSync(path.join(root, '.omni', 'runs', 'txn-001', 'raw-output.json'), '{"raw":true}\n');

        fs.mkdirSync(path.join(root, '.omni', 'runtime'), { recursive: true });
        fs.writeFileSync(path.join(root, '.omni', 'runtime', 'daemon.json'), '{"pid":99}\n');

        fs.mkdirSync(path.join(root, '.omni', 'sdlc'), { recursive: true });
        fs.writeFileSync(path.join(root, '.omni', 'sdlc', 'policy.json'), '{"strict":true}\n');

        fs.writeFileSync(path.join(root, '.omni', 'config.json'), '{"mode":"dual"}\n');
        fs.writeFileSync(path.join(root, 'index.js'), 'console.log(1);\n');

        const baseline = createSnapshotBaseline({ root });
        const { manifest } = baseline.capture();

        const paths = manifest.files.map((e) => e.path);
        assert.deepEqual(paths, [
            '.omni/config.json',
            '.omni/sdlc/policy.json',
            'index.js',
        ]);
    });

    it('rejects unsafe excludedPaths with DUAL_PATH_ESCAPE in diff, fingerprint, and assertScope', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'file.txt'), 'hello\n');
        const baseline = createSnapshotBaseline({ root });
        const initial = baseline.capture();

        const unsafePatterns = [
            '../traversal',
            'foo/../bar',
            'bad\0nul',
            path.resolve(root, 'file.txt'),
            '',
            123,
        ];

        for (const unsafe of unsafePatterns) {
            assert.throws(
                () => baseline.diff(initial.identity, initial.manifest, { excludedPaths: [unsafe] }),
                { code: 'DUAL_PATH_ESCAPE' },
                `diff should reject excludedPath: ${unsafe}`
            );
            assert.throws(
                () => baseline.fingerprint(initial.identity, initial.manifest, { excludedPaths: [unsafe] }),
                { code: 'DUAL_PATH_ESCAPE' },
                `fingerprint should reject excludedPath: ${unsafe}`
            );
            assert.throws(
                () => baseline.assertScope(initial.identity, initial.manifest, {
                    excludedPaths: [unsafe],
                    allowedFiles: ['file.txt'],
                }),
                { code: 'DUAL_PATH_ESCAPE' },
                `assertScope should reject excludedPath: ${unsafe}`
            );
        }
    });
});

describe('computeSnapshotManifestFingerprint - pure helper and deterministic derivation', () => {
    const { computeSnapshotManifestFingerprint } = require('../lib/dual/baseline-snapshot');

    it('computes exact diff files and patchSha256 for created, modified, and deleted files without filesystem reads', () => {
        const fileA = { path: 'a.txt', type: 'file', size: 10, hash: 'a'.repeat(64), sha256: 'a'.repeat(64) };
        const fileB = { path: 'b.txt', type: 'file', size: 20, hash: 'b'.repeat(64), sha256: 'b'.repeat(64) };
        const fileC = { path: 'c.txt', type: 'file', size: 30, hash: 'c'.repeat(64), sha256: 'c'.repeat(64) };

        const initialFiles = [fileA, fileB];
        const initialRoot = computeSnapshotRootHash(initialFiles);
        const initialIdentity = { kind: 'snapshot', id: initialRoot };
        const initialManifest = { schema_version: 1, files: initialFiles };

        // current: fileA modified, fileB deleted, fileC created
        const fileAMod = { path: 'a.txt', type: 'file', size: 15, hash: '1'.repeat(64), sha256: '1'.repeat(64) };
        const currentFiles = [fileAMod, fileC];
        const currentRoot = computeSnapshotRootHash(currentFiles);
        const currentIdentity = { kind: 'snapshot', id: currentRoot };
        const currentManifest = { schema_version: 1, files: currentFiles };

        const result = computeSnapshotManifestFingerprint(
            initialIdentity,
            initialManifest,
            currentIdentity,
            currentManifest
        );

        assert.deepEqual(result.files, ['a.txt', 'b.txt', 'c.txt']);
        assert.match(result.patchSha256, /^[0-9a-f]{64}$/);

        // Determinism: same input produces exact same hash
        const repeat = computeSnapshotManifestFingerprint(
            initialIdentity,
            initialManifest,
            currentIdentity,
            currentManifest
        );
        assert.equal(result.patchSha256, repeat.patchSha256);
    });

    it('is sensitive to content hash, size, file type, change kind, and excludedPaths', () => {
        const fileA = { path: 'a.txt', type: 'file', size: 10, hash: 'a'.repeat(64), sha256: 'a'.repeat(64) };
        const initialFiles = [fileA];
        const initialRoot = computeSnapshotRootHash(initialFiles);
        const initialIdentity = { kind: 'snapshot', id: initialRoot };
        const initialManifest = { schema_version: 1, files: initialFiles };

        // Mutation 1: changed hash
        const mod1 = [{ path: 'a.txt', type: 'file', size: 10, hash: '1'.repeat(64), sha256: '1'.repeat(64) }];
        const fp1 = computeSnapshotManifestFingerprint(
            initialIdentity,
            initialManifest,
            { kind: 'snapshot', id: computeSnapshotRootHash(mod1) },
            { schema_version: 1, files: mod1 }
        );

        // Mutation 2: changed size
        const mod2 = [{ path: 'a.txt', type: 'file', size: 99, hash: '1'.repeat(64), sha256: '1'.repeat(64) }];
        const fp2 = computeSnapshotManifestFingerprint(
            initialIdentity,
            initialManifest,
            { kind: 'snapshot', id: computeSnapshotRootHash(mod2) },
            { schema_version: 1, files: mod2 }
        );

        // Mutation 3: deleted instead of modified
        const mod3 = [];
        const fp3 = computeSnapshotManifestFingerprint(
            initialIdentity,
            initialManifest,
            { kind: 'snapshot', id: computeSnapshotRootHash(mod3) },
            { schema_version: 1, files: mod3 }
        );

        assert.notEqual(fp1.patchSha256, fp2.patchSha256);
        assert.notEqual(fp1.patchSha256, fp3.patchSha256);
        assert.notEqual(fp2.patchSha256, fp3.patchSha256);

        // Excluded path
        const fileB = { path: 'ex/b.txt', type: 'file', size: 20, hash: 'b'.repeat(64), sha256: 'b'.repeat(64) };
        const mod4 = [fileA, fileB];
        const fp4 = computeSnapshotManifestFingerprint(
            initialIdentity,
            initialManifest,
            { kind: 'snapshot', id: computeSnapshotRootHash(mod4) },
            { schema_version: 1, files: mod4 },
            { excludedPaths: ['ex'] }
        );
        // With 'ex' excluded, diff is empty
        assert.deepEqual(fp4.files, []);
    });

    it('rejects malformed manifests, non-safe integers, or invalid identity correlation', () => {
        const validFile = { path: 'a.txt', type: 'file', size: 10, hash: 'a'.repeat(64), sha256: 'a'.repeat(64) };
        const validInitial = {
            identity: { kind: 'snapshot', id: computeSnapshotRootHash([validFile]) },
            manifest: { schema_version: 1, files: [validFile] },
        };

        // Unsorted current manifest
        const unsortedFiles = [
            { path: 'z.txt', type: 'file', size: 10, hash: 'a'.repeat(64), sha256: 'a'.repeat(64) },
            { path: 'a.txt', type: 'file', size: 10, hash: 'b'.repeat(64), sha256: 'b'.repeat(64) },
        ];
        assert.throws(
            () => computeSnapshotManifestFingerprint(
                validInitial.identity,
                validInitial.manifest,
                { kind: 'snapshot', id: computeSnapshotRootHash(unsortedFiles) },
                { schema_version: 1, files: unsortedFiles }
            ),
            /DUAL_SNAPSHOT_BASELINE_INVALID|manifest/i
        );

        // Non-safe integer size
        const unsafeSizeFiles = [
            { path: 'a.txt', type: 'file', size: Number.MAX_SAFE_INTEGER + 10, hash: 'a'.repeat(64), sha256: 'a'.repeat(64) },
        ];
        assert.throws(
            () => computeSnapshotManifestFingerprint(
                validInitial.identity,
                validInitial.manifest,
                { kind: 'snapshot', id: computeSnapshotRootHash(unsafeSizeFiles) },
                { schema_version: 1, files: unsafeSizeFiles }
            ),
            /DUAL_SNAPSHOT_BASELINE_INVALID|manifest|size/i
        );
    });

    it('instance fingerprint() matches pure computeSnapshotManifestFingerprint exactly', () => {
        const root = makeTemp();
        fs.writeFileSync(path.join(root, 'index.html'), 'hello\n');
        const baseline = createSnapshotBaseline({ root });
        const initial = baseline.capture();

        fs.writeFileSync(path.join(root, 'index.html'), 'hello updated\n');
        fs.writeFileSync(path.join(root, 'extra.txt'), 'extra\n');

        const instanceFp = baseline.fingerprint(initial.identity, initial.manifest);
        const current = baseline.capture();
        const pureFp = computeSnapshotManifestFingerprint(
            initial.identity,
            initial.manifest,
            current.identity,
            current.manifest
        );

        assert.deepEqual(instanceFp.files, pureFp.files);
        assert.equal(instanceFp.patchSha256, pureFp.patchSha256);
    });
});

