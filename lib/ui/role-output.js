'use strict';

// Role Output Source for Omni UI (T06)
// Streams read-only correlated stdout/stderr/progress for worker and reviewer roles.
// Strictly read-only: no write, claim, resize, or stop operations.

const fs = require('node:fs');
const path = require('node:path');

const MAX_CHUNK_BYTES = 256 * 1024; // 256 KiB
const VALID_CHANNELS = new Set(['stdout', 'stderr', 'progress']);
const SAFE_ID_REGEX = /^[0-9a-zA-Z_-]+$/;

function validateRoleOutputRef(ref) {
    if (!ref || typeof ref !== 'object') {
        throw new Error('Role output ref must be a non-null object');
    }

    if (!ref.contextId || typeof ref.contextId !== 'string') {
        throw new Error('contextId is required');
    }
    if (!ref.taskId || typeof ref.taskId !== 'string' || !SAFE_ID_REGEX.test(ref.taskId)) {
        throw new Error(`Invalid taskId: ${ref.taskId}. Traversal characters forbidden.`);
    }
    if (!ref.roleId || typeof ref.roleId !== 'string' || !SAFE_ID_REGEX.test(ref.roleId)) {
        throw new Error(`Invalid roleId: ${ref.roleId}. Traversal characters forbidden.`);
    }
    if (ref.executionId && !SAFE_ID_REGEX.test(ref.executionId)) {
        throw new Error(`Invalid executionId: ${ref.executionId}. Traversal characters forbidden.`);
    }
    if (!Number.isInteger(ref.attempt) || ref.attempt < 1) {
        throw new Error(`attempt must be a positive integer >= 1 (got ${ref.attempt})`);
    }
    if (!VALID_CHANNELS.has(ref.channel)) {
        throw new Error(`Invalid channel: ${ref.channel}. Must be one of: ${Array.from(VALID_CHANNELS).join(', ')}`);
    }
}

function createRoleOutputSource({
    projectRoot,
    fsImpl = fs,
}) {
    const runsRoot = path.join(projectRoot, '.omni', 'runs');

    function resolveLogPath(ref) {
        validateRoleOutputRef(ref);

        const targetDir = path.join(runsRoot, 'logs', ref.taskId, `attempt-${ref.attempt}`);
        const logFile = path.join(targetDir, `${ref.roleId}-${ref.channel}.log`);

        const resolved = path.resolve(logFile);
        if (!resolved.startsWith(runsRoot)) {
            throw new Error(`Resolved path escapes .omni/runs directory: ${resolved}`);
        }
        return resolved;
    }

    function read(ref, cursor = 0, { maxBytes = MAX_CHUNK_BYTES } = {}) {
        const logPath = resolveLogPath(ref);
        const numericCursor = Number(cursor) || 0;

        if (!fsImpl.existsSync(logPath)) {
            return {
                data: '',
                nextCursor: numericCursor,
                eof: true,
                reset: false,
            };
        }

        let stat;
        try {
            stat = fsImpl.statSync(logPath);
        } catch {
            return { data: '', nextCursor: numericCursor, eof: true, reset: false };
        }

        // Detect rotation or truncation
        if (stat.size < numericCursor) {
            const readLen = Math.min(stat.size, maxBytes);
            let buffer = Buffer.alloc(readLen);
            const fd = fsImpl.openSync(logPath, 'r');
            try {
                fsImpl.readSync(fd, buffer, 0, readLen, 0);
            } finally {
                fsImpl.closeSync(fd);
            }
            return {
                data: buffer.toString('utf8'),
                nextCursor: readLen,
                eof: readLen >= stat.size,
                reset: true,
            };
        }

        if (stat.size === numericCursor) {
            return {
                data: '',
                nextCursor: numericCursor,
                eof: true,
                reset: false,
            };
        }

        const readLen = Math.min(stat.size - numericCursor, maxBytes);
        const buffer = Buffer.alloc(readLen);
        const fd = fsImpl.openSync(logPath, 'r');
        try {
            fsImpl.readSync(fd, buffer, 0, readLen, numericCursor);
        } finally {
            fsImpl.closeSync(fd);
        }

        return {
            data: buffer.toString('utf8'),
            nextCursor: numericCursor + readLen,
            eof: (numericCursor + readLen >= stat.size),
            reset: false,
        };
    }

    function openStream(req, res, ref, {
        pollMs = 500,
        heartbeatMs = 15000,
        SECURITY_HEADERS = {},
        streams = new Set(),
    } = {}) {
        validateRoleOutputRef(ref);

        res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': 'text/event-stream; charset=utf-8',
            Connection: 'keep-alive',
        });
        res.write('retry: 2000\n\n');
        res.write(`event: hello\ndata: ${JSON.stringify({ ref })}\n\n`);

        let cursor = Number(req.headers['last-event-id']) || 0;

        const poll = setInterval(() => {
            try {
                const result = read(ref, cursor);
                if (result.reset) {
                    res.write(`event: reset\ndata: ${JSON.stringify({ nextCursor: result.nextCursor })}\n\n`);
                    cursor = result.nextCursor;
                } else if (result.data) {
                    res.write(`id: ${result.nextCursor}\nevent: output\ndata: ${JSON.stringify(result.data)}\n\n`);
                    cursor = result.nextCursor;
                }
            } catch {}
        }, pollMs);

        const beat = setInterval(() => res.write(': keep-alive\n\n'), heartbeatMs);
        const stream = {
            close() {
                clearInterval(poll);
                clearInterval(beat);
                res.end();
            }
        };
        streams.add(stream);

        req.on('close', () => {
            clearInterval(poll);
            clearInterval(beat);
            streams.delete(stream);
        });
    }

    return {
        read,
        openStream,
        resolveLogPath,
        validateRef: validateRoleOutputRef,
    };
}

module.exports = {
    createRoleOutputSource,
    validateRoleOutputRef,
    MAX_CHUNK_BYTES,
};
