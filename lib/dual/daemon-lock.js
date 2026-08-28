'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class DualDaemonLockError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'DualDaemonLockError';
        this.code = code;
        this.details = details;
    }
}

const ALLOWED_LOCK_RECORD_KEYS = new Set([
    'protocol_version',
    'workspace_id',
    'pid',
    'started_at',
    'endpoint',
]);

const ALLOWED_ENDPOINT_KEYS = new Set(['host', 'port']);

function validateLockRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new DualDaemonLockError('DUAL_LOCK_CORRUPT', 'Lock record must be a non-null object.');
    }
    const keys = Object.keys(record);
    for (const key of keys) {
        if (!ALLOWED_LOCK_RECORD_KEYS.has(key)) {
            throw new DualDaemonLockError(
                'DUAL_LOCK_CORRUPT',
                `Lock record contains unexpected key: ${key}`
            );
        }
    }
    if (record.protocol_version !== 1) {
        throw new DualDaemonLockError(
            'DUAL_LOCK_CORRUPT',
            `Unsupported lock protocol_version: ${record.protocol_version}`
        );
    }
    if (typeof record.workspace_id !== 'string' || record.workspace_id.trim().length === 0) {
        throw new DualDaemonLockError(
            'DUAL_LOCK_CORRUPT',
            'Lock record workspace_id must be a non-empty string.'
        );
    }
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) {
        throw new DualDaemonLockError(
            'DUAL_LOCK_CORRUPT',
            'Lock record pid must be a positive integer.'
        );
    }
    if (typeof record.started_at !== 'string' || isNaN(Date.parse(record.started_at))) {
        throw new DualDaemonLockError(
            'DUAL_LOCK_CORRUPT',
            'Lock record started_at must be a valid ISO date string.'
        );
    }
    if (record.endpoint !== null && record.endpoint !== undefined) {
        if (typeof record.endpoint !== 'object' || Array.isArray(record.endpoint)) {
            throw new DualDaemonLockError(
                'DUAL_LOCK_CORRUPT',
                'Lock record endpoint must be null or an object.'
            );
        }
        const epKeys = Object.keys(record.endpoint);
        for (const epKey of epKeys) {
            if (!ALLOWED_ENDPOINT_KEYS.has(epKey)) {
                throw new DualDaemonLockError(
                    'DUAL_LOCK_CORRUPT',
                    `Lock record endpoint contains unexpected key: ${epKey}`
                );
            }
        }
        if (typeof record.endpoint.host !== 'string' || record.endpoint.host.trim().length === 0) {
            throw new DualDaemonLockError(
                'DUAL_LOCK_CORRUPT',
                'Lock record endpoint.host must be a non-empty string.'
            );
        }
        if (
            typeof record.endpoint.port !== 'number' ||
            !Number.isInteger(record.endpoint.port) ||
            record.endpoint.port <= 0 ||
            record.endpoint.port > 65535
        ) {
            throw new DualDaemonLockError(
                'DUAL_LOCK_CORRUPT',
                'Lock record endpoint.port must be an integer between 1 and 65535.'
            );
        }
    }
    return record;
}

function computeWorkspaceId(canonicalRoot, cryptoImpl = crypto) {
    if (typeof canonicalRoot !== 'string' || canonicalRoot.length === 0) {
        throw new DualDaemonLockError('DUAL_WORKSPACE_ROOT_INVALID', 'canonicalRoot must be a non-empty string');
    }
    return cryptoImpl.createHash('sha256').update(canonicalRoot).digest('hex');
}

function getRuntimeDir(canonicalRoot) {
    return path.join(canonicalRoot, '.omni', 'runtime', 'dual');
}

function defaultIsProcessAlive(pid) {
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err.code === 'EPERM';
    }
}

function defaultProcessIdentityMatches() {
    // If PID is alive and identity cannot be disproved, return true to fail closed.
    return true;
}

async function acquireDaemonLock(options = {}) {
    const {
        runtimeDir,
        workspaceId,
        pid = process.pid,
        startedAt = new Date().toISOString(),
        healthProbe,
        isProcessAlive = defaultIsProcessAlive,
        processIdentityMatches = defaultProcessIdentityMatches,
        fsImpl = fs,
    } = options;

    if (!runtimeDir || typeof runtimeDir !== 'string') {
        throw new DualDaemonLockError('DUAL_LOCK_INVALID_CONFIG', 'runtimeDir is required and must be a string');
    }
    if (!workspaceId || typeof workspaceId !== 'string') {
        throw new DualDaemonLockError('DUAL_LOCK_INVALID_CONFIG', 'workspaceId is required and must be a string');
    }

    fsImpl.mkdirSync(runtimeDir, { recursive: true });
    const lockPath = path.join(runtimeDir, 'daemon.lock');

    function createLockPayload(endpoint = null) {
        return {
            protocol_version: 1,
            workspace_id: workspaceId,
            pid,
            started_at: startedAt,
            endpoint: endpoint || null,
        };
    }

    function tryCreateLockFile(endpoint = null) {
        const payload = createLockPayload(endpoint);
        validateLockRecord(payload);
        const content = JSON.stringify(payload, null, 2) + '\n';
        const buf = Buffer.from(content, 'utf8');
        const fd = fsImpl.openSync(lockPath, 'wx');
        try {
            let offset = 0;
            while (offset < buf.length) {
                const written = fsImpl.writeSync(fd, buf, offset, buf.length - offset, null);
                if (typeof written !== 'number' || written <= 0) {
                    throw new DualDaemonLockError('DUAL_LOCK_ERROR', 'fs.writeSync failed to write lock bytes');
                }
                offset += written;
            }
            fsImpl.fsyncSync(fd);
        } finally {
            fsImpl.closeSync(fd);
        }
    }

    function createLockHandle() {
        return {
            lockPath,
            workspaceId,
            pid,
            startedAt,
            attachEndpoint(endpoint) {
                if (!fsImpl.existsSync(lockPath)) {
                    throw new DualDaemonLockError(
                        'DUAL_LOCK_ERROR',
                        'Lock file does not exist on disk during attachEndpoint'
                    );
                }
                let rawOnDisk;
                try {
                    rawOnDisk = fsImpl.readFileSync(lockPath, 'utf8');
                } catch (err) {
                    throw new DualDaemonLockError(
                        'DUAL_LOCK_ERROR',
                        `Failed to read lock file during attachEndpoint: ${err.message}`
                    );
                }
                let onDisk;
                try {
                    onDisk = JSON.parse(rawOnDisk);
                } catch (err) {
                    throw new DualDaemonLockError(
                        'DUAL_LOCK_CORRUPT',
                        `Cannot parse lock on disk during attachEndpoint: ${err.message}`
                    );
                }
                validateLockRecord(onDisk);

                if (
                    onDisk.pid !== pid ||
                    onDisk.started_at !== startedAt ||
                    onDisk.workspace_id !== workspaceId
                ) {
                    throw new DualDaemonLockError(
                        'DUAL_LOCK_RELEASE_MISMATCH',
                        `Lock on disk belongs to PID ${onDisk.pid} (expected ${pid}), started at ${onDisk.started_at} (expected ${startedAt}), workspace ${onDisk.workspace_id} (expected ${workspaceId}). Refusing to overwrite foreign lock.`
                    );
                }

                const updatedPayload = {
                    protocol_version: 1,
                    workspace_id: workspaceId,
                    pid,
                    started_at: startedAt,
                    endpoint: endpoint || null,
                };
                validateLockRecord(updatedPayload);

                const tmpPath = path.join(
                    runtimeDir,
                    `daemon.lock.tmp.${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`
                );
                fsImpl.writeFileSync(tmpPath, JSON.stringify(updatedPayload, null, 2) + '\n', {
                    encoding: 'utf8',
                    mode: 0o600,
                });
                fsImpl.renameSync(tmpPath, lockPath);
            },
            async release() {
                if (!fsImpl.existsSync(lockPath)) {
                    return;
                }
                let rawContent;
                try {
                    rawContent = fsImpl.readFileSync(lockPath, 'utf8');
                } catch {
                    return;
                }
                let onDisk;
                try {
                    onDisk = JSON.parse(rawContent);
                } catch (err) {
                    throw new DualDaemonLockError(
                        'DUAL_LOCK_CORRUPT',
                        `Cannot parse lock on disk during release: ${err.message}`
                    );
                }
                validateLockRecord(onDisk);

                if (
                    !onDisk ||
                    onDisk.pid !== pid ||
                    onDisk.started_at !== startedAt ||
                    onDisk.workspace_id !== workspaceId
                ) {
                    throw new DualDaemonLockError(
                        'DUAL_LOCK_RELEASE_MISMATCH',
                        `Lock on disk belongs to PID ${onDisk ? onDisk.pid : 'unknown'} (expected ${pid}), started at ${onDisk ? onDisk.started_at : 'unknown'} (expected ${startedAt}), workspace ${onDisk ? onDisk.workspace_id : 'unknown'} (expected ${workspaceId}). Refusing to release foreign lock.`
                    );
                }
                try {
                    fsImpl.unlinkSync(lockPath);
                } catch (err) {
                    throw new DualDaemonLockError('DUAL_LOCK_ERROR', `Failed to unlink lock: ${err.message}`);
                }
            },
        };
    }

    let lockCreated = false;
    try {
        tryCreateLockFile();
        lockCreated = true;
    } catch (err) {
        if (err.code !== 'EEXIST') {
            throw new DualDaemonLockError('DUAL_LOCK_ERROR', `Failed to acquire daemon lock: ${err.message}`, {
                cause: err,
            });
        }
    }

    if (lockCreated) {
        return createLockHandle();
    }

    // Lock file already exists. Inspect existing lock.
    let rawExisting;
    try {
        rawExisting = fsImpl.readFileSync(lockPath, 'utf8');
    } catch (err) {
        throw new DualDaemonLockError(
            'DUAL_LOCK_CORRUPT',
            `Existing lock file exists but could not be read: ${err.message}`
        );
    }

    if (!rawExisting || rawExisting.trim().length === 0) {
        throw new DualDaemonLockError('DUAL_LOCK_CORRUPT', 'Existing lock file is empty.');
    }

    let existing;
    try {
        existing = JSON.parse(rawExisting);
    } catch (err) {
        throw new DualDaemonLockError(
            'DUAL_LOCK_CORRUPT',
            `Existing lock file is malformed JSON: ${err.message}`
        );
    }

    validateLockRecord(existing);

    if (existing.workspace_id !== workspaceId) {
        throw new DualDaemonLockError(
            'DUAL_LOCK_WORKSPACE_MISMATCH',
            `Existing lock workspace (${existing.workspace_id}) does not match current workspace (${workspaceId}).`
        );
    }

    // Existing lock belongs to same workspace. Probe for liveness.
    let isHealthy = false;
    if (typeof healthProbe === 'function') {
        try {
            isHealthy = await healthProbe(existing);
        } catch {
            isHealthy = false;
        }
    }

    if (isHealthy) {
        throw new DualDaemonLockError(
            'DUAL_DAEMON_ACTIVE',
            `Active daemon (PID ${existing.pid}) is running for workspace ${workspaceId}.`
        );
    }

    // Health probe failed. Check if process is alive.
    let alive = false;
    try {
        alive = await isProcessAlive(existing.pid);
    } catch {
        alive = true; // fail closed if liveness check fails
    }

    if (alive) {
        let identityMatches = true;
        if (typeof processIdentityMatches === 'function') {
            try {
                identityMatches = await processIdentityMatches(existing.pid, existing.started_at);
            } catch {
                identityMatches = true; // cannot disprove -> fail closed
            }
        }
        if (identityMatches !== false) {
            // PID is alive and identity cannot be disproved
            throw new DualDaemonLockError(
                'DUAL_DAEMON_ACTIVE',
                `Existing daemon process (PID ${existing.pid}) is alive and identity cannot be disproved.`
            );
        }
    }

    // Both conditions satisfied: health probe failed AND (PID dead OR process identity mismatch).
    // Reclaim stale lock.
    try {
        fsImpl.unlinkSync(lockPath);
    } catch (err) {
        throw new DualDaemonLockError(
            'DUAL_LOCK_ERROR',
            `Failed to remove stale lock file: ${err.message}`
        );
    }

    const discoveryPath = path.join(runtimeDir, 'daemon.json');
    if (fsImpl.existsSync(discoveryPath)) {
        try {
            fsImpl.unlinkSync(discoveryPath);
        } catch {
            // ignore failure on stale discovery
        }
    }

    // Retry acquiring the lock exclusively
    try {
        tryCreateLockFile();
    } catch (err) {
        throw new DualDaemonLockError(
            'DUAL_LOCK_ERROR',
            `Failed to acquire lock after reclaiming stale lock: ${err.message}`
        );
    }

    return createLockHandle();
}

module.exports = {
    DualDaemonLockError,
    computeWorkspaceId,
    getRuntimeDir,
    acquireDaemonLock,
};
