'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { createRoleOutputSource } = require('../../lib/ui/role-output');

test('T06: worker and reviewer read-only output', async (t) => {
    function tempDir() {
        return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-role-output-')));
    }

    const validRef = {
        contextId: 'squad',
        authoritySessionId: 'sess-1234',
        taskId: 'TASK-1',
        attempt: 1,
        executionId: 'exec-1',
        roleId: 'worker-1',
        channel: 'stdout',
    };

    await t.test('validation: rejects traversal, invalid channel, and missing fields', () => {
        const root = tempDir();
        try {
            const source = createRoleOutputSource({ projectRoot: root });

            assert.throws(() => {
                source.read({ ...validRef, taskId: '../../etc/passwd' }, 0);
            }, /traversal|invalid/i);

            assert.throws(() => {
                source.read({ ...validRef, channel: 'stdin' }, 0);
            }, /channel/i);

            assert.throws(() => {
                source.read({ ...validRef, attempt: -1 }, 0);
            }, /attempt/i);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('read: reads stream boundedly and advances cursor', () => {
        const root = tempDir();
        try {
            const source = createRoleOutputSource({ projectRoot: root });
            const logPath = source.resolveLogPath(validRef);
            fs.mkdirSync(path.dirname(logPath), { recursive: true });

            fs.writeFileSync(logPath, 'Line 1: Worker starting\nLine 2: Compiling assets\n');

            const res1 = source.read(validRef, 0);
            assert.equal(res1.data, 'Line 1: Worker starting\nLine 2: Compiling assets\n');
            assert.ok(res1.nextCursor > 0);
            assert.equal(res1.reset, false);

            // Append more
            fs.appendFileSync(logPath, 'Line 3: Finished successfully\n');
            const res2 = source.read(validRef, res1.nextCursor);
            assert.equal(res2.data, 'Line 3: Finished successfully\n');
            assert.ok(res2.nextCursor > res1.nextCursor);

            // Nothing new -> empty data, cursor unchanged
            const res3 = source.read(validRef, res2.nextCursor);
            assert.equal(res3.data, '');
            assert.equal(res3.nextCursor, res2.nextCursor);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('read: detects rotation / truncation and resets cursor', () => {
        const root = tempDir();
        try {
            const source = createRoleOutputSource({ projectRoot: root });
            const logPath = source.resolveLogPath(validRef);
            fs.mkdirSync(path.dirname(logPath), { recursive: true });

            fs.writeFileSync(logPath, 'Long text that will be truncated later.\n');
            const res1 = source.read(validRef, 0);
            assert.ok(res1.nextCursor > 10);

            // Truncate file
            fs.writeFileSync(logPath, 'Short\n');
            const res2 = source.read(validRef, res1.nextCursor);
            assert.equal(res2.reset, true);
            assert.equal(res2.data, 'Short\n');
            assert.equal(res2.nextCursor, Buffer.byteLength('Short\n'));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    await t.test('read-only policy: role output source exposes no write or input methods', () => {
        const root = tempDir();
        try {
            const source = createRoleOutputSource({ projectRoot: root });
            assert.equal(source.input, undefined);
            assert.equal(source.claim, undefined);
            assert.equal(source.resize, undefined);
            assert.equal(source.stop, undefined);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
