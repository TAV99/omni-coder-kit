'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { z } = require('zod');

const {
    BaselineIdentitySchema,
    Sha256Schema,
    TaskIdSchema,
    DualContractError,
    parseContract,
} = require('./contracts');
const {
    createSnapshotBaseline,
    computeSnapshotRootHash,
    validateSnapshotIdentityAndManifest,
} = require('./baseline-snapshot');

const InitialSnapshotFileSchema = z.object({
    schema_version: z.literal(1),
    session_id: z.string().min(1),
    workspace_id: z.string().min(1),
    workspace_root: z.string().min(1),
    identity: z.object({
        kind: z.literal('snapshot'),
        id: Sha256Schema,
    }).strict(),
    manifest: z.object({
        schema_version: z.literal(1),
        files: z.array(z.object({
            path: z.string().min(1),
            type: z.literal('file'),
            size: z.number().int().nonnegative(),
            hash: Sha256Schema.optional(),
            sha256: Sha256Schema.optional(),
        }).strict()),
    }).strict(),
    content_sha256: Sha256Schema,
}).strict();

const AcceptedSnapshotFileSchema = z.object({
    schema_version: z.literal(1),
    session_id: z.string().min(1),
    workspace_id: z.string().min(1),
    workspace_root: z.string().min(1),
    plan_revision: z.number().int().positive(),
    completed_tasks: z.array(TaskIdSchema).min(1),
    diff_fingerprint: Sha256Schema,
    receipt_sha256: Sha256Schema,
    identity: z.object({
        kind: z.literal('snapshot'),
        id: Sha256Schema,
    }).strict(),
    manifest: z.object({
        schema_version: z.literal(1),
        files: z.array(z.object({
            path: z.string().min(1),
            type: z.literal('file'),
            size: z.number().int().nonnegative(),
            hash: Sha256Schema.optional(),
            sha256: Sha256Schema.optional(),
        }).strict()),
    }).strict(),
    content_sha256: Sha256Schema,
}).strict();

class DualSnapshotStoreError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DualSnapshotStoreError';
        this.code = code;
        this.details = details;
    }
}

function canonicalizePath(targetPath, fsImpl = fs) {
    if (!targetPath || typeof targetPath !== 'string') {
        throw new DualSnapshotStoreError('DUAL_SNAPSHOT_WORKSPACE_MISMATCH', 'Target path must be a non-empty string');
    }
    if (!fsImpl.existsSync(targetPath)) {
        throw new DualSnapshotStoreError('DUAL_SNAPSHOT_WORKSPACE_MISMATCH', 'Stored workspace root does not exist');
    }
    try {
        return fsImpl.realpathSync?.native
            ? fsImpl.realpathSync.native(targetPath)
            : (fsImpl.realpathSync ? fsImpl.realpathSync(targetPath) : path.resolve(targetPath));
    } catch (err) {
        throw new DualSnapshotStoreError('DUAL_SNAPSHOT_WORKSPACE_MISMATCH', `Failed to canonicalize workspace root: ${err.message}`);
    }
}

function computeEnvelopeContentHash(payload, cryptoImpl = crypto) {
    const copy = { ...payload };
    delete copy.content_sha256;
    const jsonStr = JSON.stringify(copy);
    return cryptoImpl.createHash('sha256').update(jsonStr, 'utf8').digest('hex');
}

function atomicWriteFileSync(targetPath, content, { fsImpl = fs, cryptoImpl = crypto } = {}) {
    const dir = path.dirname(targetPath);
    fsImpl.mkdirSync(dir, { recursive: true });
    const randomHex = cryptoImpl.randomBytes ? cryptoImpl.randomBytes(8).toString('hex') : Math.random().toString(36).slice(2);
    const tempName = `.tmp-${path.basename(targetPath)}-${randomHex}`;
    const tempPath = path.join(dir, tempName);

    let fd;
    try {
        fd = fsImpl.openSync(tempPath, 'wx');
        fsImpl.writeFileSync(fd, content, 'utf8');
        // File fsync failure is fatal
        fsImpl.fsyncSync(fd);
        fsImpl.closeSync(fd);
        fd = null;

        fsImpl.renameSync(tempPath, targetPath);

        // Read exact bytes back to verify written content
        const readBack = fsImpl.readFileSync(targetPath, 'utf8');
        if (readBack !== content) {
            throw new Error('Partial or corrupt write detected upon read back verification');
        }

        // Best effort directory fsync when supported
        try {
            const dirFd = fsImpl.openSync(dir, 'r');
            try {
                fsImpl.fsyncSync(dirFd);
            } catch {
                // Directory fsync is best-effort on some platforms/filesystems
            }
            fsImpl.closeSync(dirFd);
        } catch {
            // Best-effort
        }
    } catch (err) {
        if (fd !== null && fd !== undefined) {
            try {
                fsImpl.closeSync(fd);
            } catch {}
        }
        try {
            if (fsImpl.existsSync(tempPath)) {
                fsImpl.unlinkSync(tempPath);
            }
        } catch {}
        throw err;
    }
}

function writeInitialSnapshot({
    authorityDir,
    sessionId,
    workspaceId,
    workspaceRoot,
    identity,
    manifest,
    fsImpl = fs,
    cryptoImpl = crypto,
}) {
    if (!authorityDir || !sessionId || !workspaceId || !workspaceRoot || !identity || !manifest) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_STORE_INVALID',
            'writeInitialSnapshot requires authorityDir, sessionId, workspaceId, workspaceRoot, identity, and manifest'
        );
    }

    if (identity.kind !== 'snapshot') {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_STORE_INVALID',
            `Invalid identity kind: ${identity.kind}, expected snapshot`
        );
    }

    // Validate manifest with strict baseline rules
    try {
        validateSnapshotIdentityAndManifest(identity, manifest, cryptoImpl);
    } catch (err) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_BASELINE_INVALID',
            `Invalid initial snapshot manifest: ${err.message}`
        );
    }

    const targetPath = path.join(authorityDir, 'initial-snapshot.json');

    // Check if initial-snapshot.json already exists
    if (fsImpl.existsSync(targetPath)) {
        let existing;
        try {
            existing = readInitialSnapshot({
                authorityDir,
                workspaceId,
                workspaceRoot,
                fsImpl,
                cryptoImpl,
            });
        } catch (err) {
            throw new DualSnapshotStoreError(
                'DUAL_SNAPSHOT_CONFLICT',
                `Initial snapshot already exists and is invalid/conflicting: ${err.message}`
            );
        }

        if (
            existing.session_id === sessionId &&
            existing.workspace_id === workspaceId &&
            existing.identity.id === identity.id
        ) {
            // Exactly matching idempotent envelope
            return existing;
        }

        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_CONFLICT',
            `Initial snapshot already exists for session ${existing.session_id} (identity ${existing.identity.id}), cannot overwrite with session ${sessionId} (identity ${identity.id})`
        );
    }

    const payload = {
        schema_version: 1,
        session_id: sessionId,
        workspace_id: workspaceId,
        workspace_root: workspaceRoot,
        identity: {
            kind: 'snapshot',
            id: identity.id,
        },
        manifest: {
            schema_version: 1,
            files: manifest.files.map((f) => ({
                path: f.path,
                type: 'file',
                size: f.size,
                hash: f.hash || f.sha256,
                sha256: f.sha256 || f.hash,
            })),
        },
    };

    const contentSha256 = computeEnvelopeContentHash(payload, cryptoImpl);
    payload.content_sha256 = contentSha256;

    parseContract(InitialSnapshotFileSchema, payload, 'initial snapshot envelope');

    const serialized = JSON.stringify(payload, null, 2) + '\n';
    atomicWriteFileSync(targetPath, serialized, { fsImpl, cryptoImpl });

    return payload;
}

function readInitialSnapshot({
    authorityDir,
    sessionId,
    workspaceId,
    workspaceRoot,
    fsImpl = fs,
    cryptoImpl = crypto,
} = {}) {
    if (!authorityDir) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_STORE_INVALID',
            'readInitialSnapshot requires authorityDir'
        );
    }

    const targetPath = path.join(authorityDir, 'initial-snapshot.json');
    if (!fsImpl.existsSync(targetPath)) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_NOT_FOUND',
            'initial-snapshot.json not found in authority directory'
        );
    }

    let raw;
    try {
        const text = fsImpl.readFileSync(targetPath, 'utf8');
        raw = JSON.parse(text);
    } catch (err) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_CORRUPT',
            `Failed to parse initial-snapshot.json: ${err.message}`
        );
    }

    let parsed;
    try {
        parsed = parseContract(InitialSnapshotFileSchema, raw, 'initial snapshot envelope');
    } catch (err) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_CORRUPT',
            `initial-snapshot.json failed schema validation: ${err.message}`
        );
    }

    const expectedContentSha = computeEnvelopeContentHash(parsed, cryptoImpl);
    if (parsed.content_sha256 !== expectedContentSha) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_CORRUPT',
            'initial-snapshot.json content_sha256 mismatch'
        );
    }

    try {
        validateSnapshotIdentityAndManifest(parsed.identity, parsed.manifest, cryptoImpl);
    } catch (err) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_CORRELATION_ERROR',
            `initial-snapshot.json manifest validation failed: ${err.message}`
        );
    }

    if (sessionId && parsed.session_id !== sessionId) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_SESSION_MISMATCH',
            'initial-snapshot.json session_id mismatch'
        );
    }

    if (workspaceId && parsed.workspace_id !== workspaceId) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_WORKSPACE_MISMATCH',
            'initial-snapshot.json workspace_id mismatch'
        );
    }

    if (workspaceRoot) {
        const expectedCanonical = canonicalizePath(workspaceRoot, fsImpl);
        const storedCanonical = canonicalizePath(parsed.workspace_root, fsImpl);
        if (expectedCanonical !== storedCanonical) {
            throw new DualSnapshotStoreError(
                'DUAL_SNAPSHOT_WORKSPACE_MISMATCH',
                'initial-snapshot.json workspace_root mismatch'
            );
        }
    }

    return parsed;
}

function validateCompletedTasks(tasks) {
    if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new DualSnapshotStoreError('DUAL_SNAPSHOT_STORE_INVALID', 'completed_tasks must be a non-empty array of strings');
    }
    for (let i = 0; i < tasks.length; i++) {
        if (typeof tasks[i] !== 'string' || !tasks[i].trim()) {
            throw new DualSnapshotStoreError('DUAL_SNAPSHOT_STORE_INVALID', 'completed_tasks must contain non-empty strings');
        }
        if (i > 0) {
            if (tasks[i] === tasks[i - 1]) {
                throw new DualSnapshotStoreError('DUAL_SNAPSHOT_STORE_INVALID', 'completed_tasks contains duplicate task IDs');
            }
            if (tasks[i] < tasks[i - 1]) {
                throw new DualSnapshotStoreError('DUAL_SNAPSHOT_STORE_INVALID', 'completed_tasks must be strictly sorted in ascending order');
            }
        }
    }
}

function buildReceiptObject({
    sessionId,
    workspaceId,
    planRevision,
    currentBaseline,
    completedTasks,
    diffFingerprint,
    acceptedSnapshotIdentity,
}) {
    if (!sessionId || !workspaceId || !planRevision || !currentBaseline || !completedTasks || !diffFingerprint) {
        throw new DualSnapshotStoreError('DUAL_SNAPSHOT_STORE_INVALID', 'buildReceiptObject requires all fields');
    }
    const sortedTasks = [...completedTasks].sort();
    return {
        session_id: sessionId,
        workspace_id: workspaceId,
        plan_revision: planRevision,
        current_baseline: currentBaseline,
        completed_tasks: sortedTasks,
        current_diff_fingerprint: diffFingerprint,
        ...(currentBaseline && currentBaseline.kind === 'snapshot' && acceptedSnapshotIdentity
            ? { accepted_snapshot_identity: acceptedSnapshotIdentity }
            : {}),
    };
}

function computeReceiptSha256(receiptObj, cryptoImpl = crypto) {
    const jsonStr = JSON.stringify(receiptObj);
    return cryptoImpl.createHash('sha256').update(jsonStr, 'utf8').digest('hex');
}

function writeAcceptedSnapshot({
    authorityDir,
    sessionId,
    workspaceId,
    workspaceRoot,
    planRevision,
    completedTasks,
    diffFingerprint,
    receiptSha256,
    identity,
    manifest,
    fsImpl = fs,
    cryptoImpl = crypto,
}) {
    if (
        !authorityDir ||
        !sessionId ||
        !workspaceId ||
        !workspaceRoot ||
        !planRevision ||
        !completedTasks ||
        !diffFingerprint ||
        !receiptSha256 ||
        !identity ||
        !manifest
    ) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_STORE_INVALID',
            'writeAcceptedSnapshot requires authorityDir, sessionId, workspaceId, workspaceRoot, planRevision, completedTasks, diffFingerprint, receiptSha256, identity, and manifest'
        );
    }

    validateCompletedTasks(completedTasks);

    // Validate manifest with strict baseline rules
    try {
        validateSnapshotIdentityAndManifest(identity, manifest, cryptoImpl);
    } catch (err) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_BASELINE_INVALID',
            `Invalid accepted snapshot manifest: ${err.message}`
        );
    }

    const targetPath = path.join(authorityDir, 'accepted-snapshot.json');

    if (fsImpl.existsSync(targetPath)) {
        let existing;
        try {
            existing = readAcceptedSnapshot({
                authorityDir,
                workspaceId,
                workspaceRoot,
                fsImpl,
                cryptoImpl,
            });
        } catch (err) {
            throw new DualSnapshotStoreError(
                'DUAL_SNAPSHOT_CONFLICT',
                `accepted-snapshot.json already exists and is invalid/conflicting: ${err.message}`
            );
        }

        if (
            existing.session_id === sessionId &&
            existing.workspace_id === workspaceId &&
            existing.plan_revision === planRevision &&
            existing.identity.id === identity.id &&
            existing.identity.kind === identity.kind &&
            existing.receipt_sha256 === receiptSha256 &&
            existing.diff_fingerprint === diffFingerprint &&
            JSON.stringify(existing.completed_tasks) === JSON.stringify(completedTasks) &&
            canonicalizePath(existing.workspace_root, fsImpl) === canonicalizePath(workspaceRoot, fsImpl)
        ) {
            return existing;
        }

        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_CONFLICT',
            `accepted-snapshot.json already exists with conflicting data for session ${existing.session_id}`
        );
    }

    const payload = {
        schema_version: 1,
        session_id: sessionId,
        workspace_id: workspaceId,
        workspace_root: workspaceRoot,
        plan_revision: planRevision,
        completed_tasks: completedTasks,
        diff_fingerprint: diffFingerprint,
        receipt_sha256: receiptSha256,
        identity: {
            kind: 'snapshot',
            id: identity.id,
        },
        manifest: {
            schema_version: 1,
            files: manifest.files.map((f) => ({
                path: f.path,
                type: 'file',
                size: f.size,
                hash: f.hash || f.sha256,
                sha256: f.sha256 || f.hash,
            })),
        },
    };

    const contentSha256 = computeEnvelopeContentHash(payload, cryptoImpl);
    payload.content_sha256 = contentSha256;

    parseContract(AcceptedSnapshotFileSchema, payload, 'accepted snapshot envelope');

    const serialized = JSON.stringify(payload, null, 2) + '\n';
    atomicWriteFileSync(targetPath, serialized, { fsImpl, cryptoImpl });

    return payload;
}

function readAcceptedSnapshot({
    authorityDir,
    sessionId,
    workspaceId,
    workspaceRoot,
    planRevision,
    receiptSha256,
    diffFingerprint,
    completedTasks,
    identity,
    fsImpl = fs,
    cryptoImpl = crypto,
} = {}) {
    if (!authorityDir) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_STORE_INVALID',
            'readAcceptedSnapshot requires authorityDir'
        );
    }

    const targetPath = path.join(authorityDir, 'accepted-snapshot.json');
    if (!fsImpl.existsSync(targetPath)) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_NOT_FOUND',
            'accepted-snapshot.json not found in authority directory'
        );
    }

    let raw;
    try {
        const text = fsImpl.readFileSync(targetPath, 'utf8');
        raw = JSON.parse(text);
    } catch (err) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_CORRUPT',
            `Failed to parse accepted-snapshot.json: ${err.message}`
        );
    }

    let parsed;
    try {
        parsed = parseContract(AcceptedSnapshotFileSchema, raw, 'accepted snapshot envelope');
    } catch (err) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_CORRUPT',
            `accepted-snapshot.json failed schema validation: ${err.message}`
        );
    }

    const expectedContentSha = computeEnvelopeContentHash(parsed, cryptoImpl);
    if (parsed.content_sha256 !== expectedContentSha) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_CORRUPT',
            'accepted-snapshot.json content_sha256 mismatch'
        );
    }

    try {
        validateSnapshotIdentityAndManifest(parsed.identity, parsed.manifest, cryptoImpl);
    } catch (err) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_CORRELATION_ERROR',
            `accepted-snapshot.json manifest validation failed: ${err.message}`
        );
    }

    if (sessionId && parsed.session_id !== sessionId) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_SESSION_MISMATCH',
            'accepted-snapshot.json session_id mismatch'
        );
    }

    if (workspaceId && parsed.workspace_id !== workspaceId) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_WORKSPACE_MISMATCH',
            'accepted-snapshot.json workspace_id mismatch'
        );
    }

    if (planRevision && parsed.plan_revision !== planRevision) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_PLAN_MISMATCH',
            'accepted-snapshot.json plan_revision mismatch'
        );
    }

    if (receiptSha256 && parsed.receipt_sha256 !== receiptSha256) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_RECEIPT_MISMATCH',
            'accepted-snapshot.json receipt_sha256 mismatch'
        );
    }

    if (diffFingerprint && parsed.diff_fingerprint !== diffFingerprint) {
        throw new DualSnapshotStoreError(
            'DUAL_SNAPSHOT_DIFF_MISMATCH',
            'accepted-snapshot.json diff_fingerprint mismatch'
        );
    }

    if (completedTasks) {
        if (JSON.stringify(parsed.completed_tasks) !== JSON.stringify(completedTasks)) {
            throw new DualSnapshotStoreError(
                'DUAL_SNAPSHOT_TASKS_MISMATCH',
                'accepted-snapshot.json completed_tasks mismatch'
            );
        }
    }

    if (identity) {
        if (parsed.identity.id !== identity.id || parsed.identity.kind !== identity.kind) {
            throw new DualSnapshotStoreError(
                'DUAL_SNAPSHOT_IDENTITY_MISMATCH',
                'accepted-snapshot.json identity mismatch'
            );
        }
    }

    if (workspaceRoot) {
        const expectedCanonical = canonicalizePath(workspaceRoot, fsImpl);
        const storedCanonical = canonicalizePath(parsed.workspace_root, fsImpl);
        if (expectedCanonical !== storedCanonical) {
            throw new DualSnapshotStoreError(
                'DUAL_SNAPSHOT_WORKSPACE_MISMATCH',
                'accepted-snapshot.json workspace_root mismatch'
            );
        }
    }

    return parsed;
}

module.exports = {
    DualSnapshotStoreError,
    InitialSnapshotFileSchema,
    AcceptedSnapshotFileSchema,
    computeEnvelopeContentHash,
    validateCompletedTasks,
    buildReceiptObject,
    computeReceiptSha256,
    writeInitialSnapshot,
    readInitialSnapshot,
    writeAcceptedSnapshot,
    readAcceptedSnapshot,
};

