'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFileService, MAX_TEXT_BYTES } = require('../../lib/ui/files');

test('T07: bounded project file service', async (t) => {
    function tempDir() {
        return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-files-test-')));
    }

    await t.test('security: traversal attack matrix rejects with FORBIDDEN', () => {
        const root = tempDir();
        try {
            const service = createFileService({ projectRoot: root });

            const attacks = [
                '../outside.txt',
                '../../etc/passwd',
                '..%2foutside.txt',
                '%2e%2e/outside.txt',
                '/etc/passwd',
                'C:\\Windows\\System32',
                'foo/../../bar',
                'file.txt\0.js',
            ];

            for (const attack of attacks) {
                assert.throws(() => {
                    service.open(attack);
                }, (err) => err.code === 'TRAVERSAL_FORBIDDEN' || err.status === 403 || err.status === 400);
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('security: denied files (.env, .git, credentials, .omni/runs)', () => {
        const root = tempDir();
        try {
            fs.writeFileSync(path.join(root, '.env'), 'SECRET=123');
            fs.writeFileSync(path.join(root, '.env.local'), 'SECRET=456');
            fs.mkdirSync(path.join(root, '.git'), { recursive: true });
            fs.writeFileSync(path.join(root, '.git', 'config'), 'repo');
            fs.writeFileSync(path.join(root, 'id_rsa'), 'private key');
            fs.writeFileSync(path.join(root, 'server.pem'), 'cert');

            const service = createFileService({ projectRoot: root });

            const denied = [
                '.env',
                '.env.local',
                '.git/config',
                'id_rsa',
                'server.pem',
            ];

            for (const file of denied) {
                assert.throws(() => {
                    service.open(file);
                }, (err) => err.code === 'FILE_ACCESS_DENIED' || err.status === 403);
            }
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('security: symlink target escaping root is forbidden', () => {
        const root = tempDir();
        const outside = tempDir();
        try {
            fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
            try {
                fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
            } catch {
                return; // Skip on platforms without symlink permissions
            }

            const service = createFileService({ projectRoot: root });
            assert.throws(() => {
                service.open('link.txt');
            }, (err) => err.code === 'TRAVERSAL_FORBIDDEN' || err.status === 403);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(outside, { recursive: true, force: true });
        }
    });

    await t.test('size limits: rejects files exceeding byte bounds before read', () => {
        const root = tempDir();
        try {
            const heavyFile = path.join(root, 'large.md');
            // Write 2.5 MiB file
            const fd = fs.openSync(heavyFile, 'w');
            fs.writeSync(fd, Buffer.alloc(MAX_TEXT_BYTES + 1024));
            fs.closeSync(fd);

            const service = createFileService({ projectRoot: root });
            assert.throws(() => {
                service.open('large.md');
            }, (err) => err.code === 'FILE_TOO_LARGE' || err.status === 413);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('handles and readContent: opaque handles with revision check', () => {
        const root = tempDir();
        try {
            const docPath = path.join(root, 'test.md');
            fs.writeFileSync(docPath, '# Hello World\n');

            const service = createFileService({ projectRoot: root });
            const meta = service.open('test.md');

            assert.ok(meta.handle);
            assert.equal(meta.relativePath, 'test.md');
            assert.equal(meta.type, 'markdown');
            assert.ok(meta.revision);

            // Read content
            const content = service.readContent(meta.handle, meta.revision);
            assert.equal(content.toString('utf8'), '# Hello World\n');

            // Stale revision rejects
            assert.throws(() => {
                service.readContent(meta.handle, 'stale-revision-999');
            }, (err) => err.code === 'FILE_STALE_REVISION' || err.status === 409);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('listDirectory: ignores node_modules and hidden folders, supports limits', () => {
        const root = tempDir();
        try {
            fs.writeFileSync(path.join(root, 'file1.txt'), 'hi');
            fs.writeFileSync(path.join(root, 'file2.md'), 'hi');
            fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
            fs.writeFileSync(path.join(root, 'node_modules', 'mod.js'), 'hi');
            fs.mkdirSync(path.join(root, '.hidden'), { recursive: true });
            fs.writeFileSync(path.join(root, '.hidden', 'h.txt'), 'hi');

            const service = createFileService({ projectRoot: root });
            const listing = service.listDirectory('');

            const names = listing.entries.map(e => e.name);
            assert.ok(names.includes('file1.txt'));
            assert.ok(names.includes('file2.md'));
            assert.ok(!names.includes('node_modules'));
            assert.ok(!names.includes('.hidden'));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
