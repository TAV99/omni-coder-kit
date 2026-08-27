'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');

const {
    writeInitialSnapshot,
    readInitialSnapshot,
    writeAcceptedSnapshot,
    readAcceptedSnapshot,
    computeEnvelopeContentHash,
} = require('../lib/dual/snapshot-store');
const {
    createSnapshotBaseline,
} = require('../lib/dual/baseline-snapshot');

function createTempDir(prefix = 'omni-snap-store-test-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmDir(dir) {
    if (!dir || !fs.existsSync(dir)) return;
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
}

describe('Snapshot Store', () => {
    let tmpDir;
    let authorityDir;

    beforeEach(() => {
        tmpDir = createTempDir();
        authorityDir = path.join(tmpDir, '.omni', 'runs', 'dual-authority');
        fs.mkdirSync(authorityDir, { recursive: true });
    });

    afterEach(() => {
        rmDir(tmpDir);
    });

    it('writes initial snapshot atomically and reads it back cleanly', () => {
        fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'world\n');
        const snapBaseline = createSnapshotBaseline({ root: tmpDir });
        const { identity, manifest } = snapBaseline.capture();

        const written = writeInitialSnapshot({
            authorityDir,
            sessionId: 'sess-1',
            workspaceId: 'ws-1',
            workspaceRoot: tmpDir,
            identity,
            manifest,
        });

        assert.equal(written.schema_version, 1);
        assert.equal(written.session_id, 'sess-1');
        assert.equal(written.identity.id, identity.id);
        assert.ok(written.content_sha256);

        const targetPath = path.join(authorityDir, 'initial-snapshot.json');
        assert.ok(fs.existsSync(targetPath));

        const readBack = readInitialSnapshot({
            authorityDir,
            sessionId: 'sess-1',
            workspaceId: 'ws-1',
            workspaceRoot: tmpDir,
        });

        assert.deepEqual(readBack, written);
    });

    it('idempotent write with identical parameters returns existing envelope', () => {
        fs.writeFileSync(path.join(tmpDir, 'file.js'), 'console.log("hi");\n');
        const snapBaseline = createSnapshotBaseline({ root: tmpDir });
        const { identity, manifest } = snapBaseline.capture();

        const first = writeInitialSnapshot({
            authorityDir,
            sessionId: 'sess-idem',
            workspaceId: 'ws-idem',
            workspaceRoot: tmpDir,
            identity,
            manifest,
        });

        const second = writeInitialSnapshot({
            authorityDir,
            sessionId: 'sess-idem',
            workspaceId: 'ws-idem',
            workspaceRoot: tmpDir,
            identity,
            manifest,
        });

        assert.deepEqual(first, second);
    });

    it('write rejects conflicting session or mismatched identity', () => {
        fs.writeFileSync(path.join(tmpDir, 'file.js'), 'console.log("hi");\n');
        const snapBaseline = createSnapshotBaseline({ root: tmpDir });
        const { identity, manifest } = snapBaseline.capture();

        writeInitialSnapshot({
            authorityDir,
            sessionId: 'sess-orig',
            workspaceId: 'ws-1',
            workspaceRoot: tmpDir,
            identity,
            manifest,
        });

        // Conflicting session
        assert.throws(
            () => writeInitialSnapshot({
                authorityDir,
                sessionId: 'sess-conflict',
                workspaceId: 'ws-1',
                workspaceRoot: tmpDir,
                identity,
                manifest,
            }),
            /already exists for session sess-orig/
        );
    });

    it('read rejects corrupt JSON, tampered content_sha256, or mismatched manifest hash', () => {
        fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'content\n');
        const snapBaseline = createSnapshotBaseline({ root: tmpDir });
        const { identity, manifest } = snapBaseline.capture();

        writeInitialSnapshot({
            authorityDir,
            sessionId: 'sess-tamper',
            workspaceId: 'ws-1',
            workspaceRoot: tmpDir,
            identity,
            manifest,
        });

        const targetPath = path.join(authorityDir, 'initial-snapshot.json');
        const originalContent = JSON.parse(fs.readFileSync(targetPath, 'utf8'));

        // Tamper manifest file content without updating content_sha256
        const tampered = { ...originalContent };
        tampered.manifest.files[0].size = 999;
        fs.writeFileSync(targetPath, JSON.stringify(tampered), 'utf8');

        assert.throws(
            () => readInitialSnapshot({ authorityDir, sessionId: 'sess-tamper' }),
            /content_sha256 mismatch/
        );

        // Tamper content_sha256 as well to match payload, but now manifest hash does not match identity
        const newHash = computeEnvelopeContentHash(tampered);
        tampered.content_sha256 = newHash;
        fs.writeFileSync(targetPath, JSON.stringify(tampered), 'utf8');

        assert.throws(
            () => readInitialSnapshot({ authorityDir, sessionId: 'sess-tamper' }),
            /manifest validation failed|does not match manifest hash|manifest root hash/i
        );
    });

    it('writes and reads accepted snapshot with receipt correlation', () => {
        fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'content\n');
        const snapBaseline = createSnapshotBaseline({ root: tmpDir });
        const { identity, manifest } = snapBaseline.capture();

        const receiptSha256 = 'a'.repeat(64);
        const diffFingerprint = 'b'.repeat(64);
        const accepted = writeAcceptedSnapshot({
            authorityDir,
            sessionId: 'sess-acc',
            workspaceId: 'ws-1',
            workspaceRoot: tmpDir,
            planRevision: 1,
            completedTasks: ['TASK-1'],
            diffFingerprint,
            receiptSha256,
            identity,
            manifest,
        });

        assert.equal(accepted.schema_version, 1);
        assert.equal(accepted.receipt_sha256, receiptSha256);
        assert.equal(accepted.diff_fingerprint, diffFingerprint);
        assert.deepEqual(accepted.completed_tasks, ['TASK-1']);

        const readBack = readAcceptedSnapshot({
            authorityDir,
            sessionId: 'sess-acc',
            workspaceId: 'ws-1',
            workspaceRoot: tmpDir,
            planRevision: 1,
        });

        assert.deepEqual(readBack, accepted);
    });

    it('file fsync failure is fatal, cleans exact temp file, and does not create target file', () => {
        fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'content\n');
        const snapBaseline = createSnapshotBaseline({ root: tmpDir });
        const { identity, manifest } = snapBaseline.capture();

        const customFs = {
            ...fs,
            fsyncSync(fd) {
                throw new Error('EIO: file fsync simulated hardware failure');
            },
        };

        assert.throws(
            () => writeInitialSnapshot({
                authorityDir,
                sessionId: 'sess-fsync-fail',
                workspaceId: 'ws-1',
                workspaceRoot: tmpDir,
                identity,
                manifest,
                fsImpl: customFs,
            }),
            /simulated hardware failure/
        );

        // Verify no leftover temp file or target file
        const files = fs.readdirSync(authorityDir);
        assert.equal(files.filter(f => f.startsWith('.tmp-')).length, 0, 'Temp file must be cleaned up on fsync failure');
        assert.equal(fs.existsSync(path.join(authorityDir, 'initial-snapshot.json')), false);
    });

    it('partial write simulation throws upon read back verification and cleans temp file', () => {
        fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'content\n');
        const snapBaseline = createSnapshotBaseline({ root: tmpDir });
        const { identity, manifest } = snapBaseline.capture();

        let readCount = 0;
        const customFs = {
            ...fs,
            readFileSync(filePath, options) {
                if (filePath.endsWith('initial-snapshot.json') && readCount === 0) {
                    readCount++;
                    return '{"partial": true}'; // Simulated truncated read back after write
                }
                return fs.readFileSync(filePath, options);
            },
        };

        assert.throws(
            () => writeInitialSnapshot({
                authorityDir,
                sessionId: 'sess-partial-fail',
                workspaceId: 'ws-1',
                workspaceRoot: tmpDir,
                identity,
                manifest,
                fsImpl: customFs,
            }),
            /Partial or corrupt write detected/
        );
    });

    it('manifest validation rejects unsorted files array or invalid entries', () => {
        const customManifest = {
            schema_version: 1,
            files: [
                { path: 'z.txt', type: 'file', size: 10, hash: 'a'.repeat(64), sha256: 'a'.repeat(64) },
                { path: 'a.txt', type: 'file', size: 10, hash: 'b'.repeat(64), sha256: 'b'.repeat(64) },
            ],
        };
        const identity = { kind: 'snapshot', id: 'c'.repeat(64) };

        assert.throws(
            () => writeInitialSnapshot({
                authorityDir,
                sessionId: 'sess-unsorted',
                workspaceId: 'ws-1',
                workspaceRoot: tmpDir,
                identity,
                manifest: customManifest,
            }),
            /DUAL_SNAPSHOT_BASELINE_INVALID|manifest/i
        );
    });

    it('readAcceptedSnapshot strictly validates workspaceRoot and receipt mismatch', () => {
        fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'content\n');
        const snapBaseline = createSnapshotBaseline({ root: tmpDir });
        const { identity, manifest } = snapBaseline.capture();

        writeAcceptedSnapshot({
            authorityDir,
            sessionId: 'sess-acc-strict',
            workspaceId: 'ws-1',
            workspaceRoot: tmpDir,
            planRevision: 1,
            completedTasks: ['TASK-1'],
            diffFingerprint: '0'.repeat(64),
            receiptSha256: '1'.repeat(64),
            identity,
            manifest,
        });

        const otherDir = path.join(tmpDir, 'other-dir');
        fs.mkdirSync(otherDir, { recursive: true });

        // Workspace mismatch
        assert.throws(
            () => readAcceptedSnapshot({
                authorityDir,
                sessionId: 'sess-acc-strict',
                workspaceId: 'ws-1',
                workspaceRoot: otherDir,
                planRevision: 1,
            }),
            /workspace_root mismatch/i
        );

        // Plan revision mismatch
        assert.throws(
            () => readAcceptedSnapshot({
                authorityDir,
                sessionId: 'sess-acc-strict',
                workspaceId: 'ws-1',
                workspaceRoot: tmpDir,
                planRevision: 2,
            }),
            /plan_revision mismatch/i
        );

        // Expected receipt mismatch
        assert.throws(
            () => readAcceptedSnapshot({
                authorityDir,
                sessionId: 'sess-acc-strict',
                workspaceId: 'ws-1',
                workspaceRoot: tmpDir,
                receiptSha256: '2'.repeat(64),
            }),
            /receipt_sha256 mismatch|DUAL_SNAPSHOT_RECEIPT_MISMATCH/i
        );

        // Expected diff fingerprint mismatch
        assert.throws(
            () => readAcceptedSnapshot({
                authorityDir,
                sessionId: 'sess-acc-strict',
                workspaceId: 'ws-1',
                workspaceRoot: tmpDir,
                diffFingerprint: '3'.repeat(64),
            }),
            /diff_fingerprint mismatch|DUAL_SNAPSHOT_DIFF_MISMATCH/i
        );

        // Expected completed tasks mismatch
        assert.throws(
            () => readAcceptedSnapshot({
                authorityDir,
                sessionId: 'sess-acc-strict',
                workspaceId: 'ws-1',
                workspaceRoot: tmpDir,
                completedTasks: ['TASK-OTHER'],
            }),
            /completed_tasks mismatch|DUAL_SNAPSHOT_TASKS_MISMATCH/i
        );

        // Expected identity mismatch
        assert.throws(
            () => readAcceptedSnapshot({
                authorityDir,
                sessionId: 'sess-acc-strict',
                workspaceId: 'ws-1',
                workspaceRoot: tmpDir,
                identity: { kind: 'snapshot', id: '4'.repeat(64) },
            }),
            /identity mismatch|DUAL_SNAPSHOT_IDENTITY_MISMATCH/i
        );
    });

    it('writeAcceptedSnapshot rejects unsorted or duplicate completed_tasks', () => {
        fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'content\n');
        const snapBaseline = createSnapshotBaseline({ root: tmpDir });
        const { identity, manifest } = snapBaseline.capture();

        // Duplicate tasks
        assert.throws(
            () => writeAcceptedSnapshot({
                authorityDir,
                sessionId: 'sess-dup',
                workspaceId: 'ws-1',
                workspaceRoot: tmpDir,
                planRevision: 1,
                completedTasks: ['TASK-1', 'TASK-1'],
                diffFingerprint: '0'.repeat(64),
                receiptSha256: '1'.repeat(64),
                identity,
                manifest,
            }),
            /duplicate|DUAL_SNAPSHOT_STORE_INVALID/i
        );

        // Unsorted tasks
        assert.throws(
            () => writeAcceptedSnapshot({
                authorityDir,
                sessionId: 'sess-unsort-tasks',
                workspaceId: 'ws-1',
                workspaceRoot: tmpDir,
                planRevision: 1,
                completedTasks: ['TASK-2', 'TASK-1'],
                diffFingerprint: '0'.repeat(64),
                receiptSha256: '1'.repeat(64),
                identity,
                manifest,
            }),
            /sorted|DUAL_SNAPSHOT_STORE_INVALID/i
        );
    });

    it('buildReceiptObject and computeReceiptSha256 produce deterministic canonical hash', () => {
        const { buildReceiptObject, computeReceiptSha256 } = require('../lib/dual/snapshot-store');

        const obj1 = buildReceiptObject({
            sessionId: 'sess-rec',
            workspaceId: 'ws-rec',
            planRevision: 1,
            currentBaseline: { kind: 'snapshot', id: 'a'.repeat(64) },
            completedTasks: ['TASK-2', 'TASK-1'],
            diffFingerprint: 'b'.repeat(64),
            acceptedSnapshotIdentity: { kind: 'snapshot', id: 'c'.repeat(64) },
        });

        // Completed tasks are sorted
        assert.deepEqual(obj1.completed_tasks, ['TASK-1', 'TASK-2']);
        const hash1 = computeReceiptSha256(obj1);
        assert.match(hash1, /^[0-9a-f]{64}$/);

        const obj2 = buildReceiptObject({
            sessionId: 'sess-rec',
            workspaceId: 'ws-rec',
            planRevision: 1,
            currentBaseline: { kind: 'snapshot', id: 'a'.repeat(64) },
            completedTasks: ['TASK-1', 'TASK-2'],
            diffFingerprint: 'b'.repeat(64),
            acceptedSnapshotIdentity: { kind: 'snapshot', id: 'c'.repeat(64) },
        });
        const hash2 = computeReceiptSha256(obj2);
        assert.equal(hash1, hash2);
    });
});

