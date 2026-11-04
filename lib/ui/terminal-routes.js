'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const MAX_IDEMPOTENCY_ENTRIES = 1024;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID_REGEX = /^[0-9a-zA-Z_-]+$/;

const ERROR_STATUS = {
    TERMINAL_NOT_FOUND: 404,
    UI_PTY_CLIENT: 400,
    UI_PTY_NOT_WRITER: 403,
    UI_PTY_INPUT: 400,
    UI_PTY_STOPPED: 409,
    TERMINAL_LIMIT_EXCEEDED: 429,
};

function createTerminalRouter({
    registry,
    send,
    readJsonBody,
    streams = new Set(),
    heartbeatMs = 15000,
    SECURITY_HEADERS = {},
    projectRoot = process.cwd(),
}) {
    const idempotencyCache = new Map(); // request_id -> { digest, summary }

    function openTerminalStream(req, res, id) {
        const session = registry.get(id);
        if (!session) {
            return send(res, 404, { error: `Terminal ${id} not found`, code: 'TERMINAL_NOT_FOUND' });
        }

        res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': 'text/event-stream; charset=utf-8',
            Connection: 'keep-alive',
        });
        res.write('retry: 2000\n\n');

        const lastEventId = req.headers['last-event-id'];
        let after = { seq: 0, generation: 0 };
        if (lastEventId) {
            const parts = String(lastEventId).split(':');
            if (parts.length === 2) {
                after = { generation: Number(parts[0]) || 0, seq: Number(parts[1]) || 0 };
            } else {
                after = { generation: 0, seq: Number(lastEventId) || 0 };
            }
        }

        const listener = (event, payload) => {
            if (event === 'data') {
                res.write(`id: ${payload.generation}:${payload.seq}\ndata: ${JSON.stringify(payload.data)}\n\n`);
            } else if (event === 'state') {
                res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
            } else if (event === 'close') {
                res.end();
            }
        };

        const client = session.attach(listener, after);

        res.write(`event: hello\ndata: ${JSON.stringify({ client_id: client.clientId, reset: client.replay.reset, generation: client.replay.generation })}\n\n`);
        for (const chunk of client.replay.chunks) {
            res.write(`id: ${chunk.generation}:${chunk.seq}\ndata: ${JSON.stringify(chunk.data)}\n\n`);
        }
        res.write(`event: state\ndata: ${JSON.stringify(session.summary())}\n\n`);

        const beat = setInterval(() => res.write(': keep-alive\n\n'), heartbeatMs);
        const stream = { close() { clearInterval(beat); res.end(); } };
        streams.add(stream);

        req.on('close', () => {
            clearInterval(beat);
            streams.delete(stream);
            client.detach();
        });
    }

    async function handle(req, res, url) {
        if (!url.pathname.startsWith('/api/terminals')) {
            return false;
        }

        // GET /api/terminals?context_id=...
        if (req.method === 'GET' && url.pathname === '/api/terminals') {
            const contextId = url.searchParams.get('context_id');
            send(res, 200, { terminals: registry.list(contextId) });
            return true;
        }

        // POST /api/terminals
        if (req.method === 'POST' && url.pathname === '/api/terminals') {
            if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
                send(res, 415, { error: 'expected application/json' });
                return true;
            }

            let body;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                send(res, err.status || 400, { error: err.message });
                return true;
            }

            if (!body || typeof body !== 'object') {
                send(res, 400, { error: 'body must be a JSON object' });
                return true;
            }

            const requestId = body.request_id;
            if (typeof requestId !== 'string' || !UUID_REGEX.test(requestId)) {
                send(res, 400, { error: 'request_id must be a valid UUID', code: 'INVALID_REQUEST_ID' });
                return true;
            }

            const payloadFingerprint = JSON.stringify({
                context_id: body.context_id || 'default',
                kind: body.kind || 'user-shell',
                cwd_relative: body.cwd_relative || '',
            });
            const digest = crypto.createHash('sha256').update(payloadFingerprint).digest('hex');

            if (idempotencyCache.has(requestId)) {
                const recorded = idempotencyCache.get(requestId);
                if (recorded.digest === digest) {
                    send(res, 200, recorded.summary);
                    return true;
                }
                send(res, 409, { error: 'request_id reused with conflicting payload', code: 'TERMINAL_REQUEST_CONFLICT' });
                return true;
            }

            if (idempotencyCache.size >= MAX_IDEMPOTENCY_ENTRIES) {
                send(res, 429, { error: 'request capacity limit reached', code: 'REQUEST_CAPACITY' });
                return true;
            }

            const kind = body.kind;
            if (kind && !['primary', 'user-shell'].includes(kind)) {
                send(res, 400, { error: 'kind must be "primary" or "user-shell"', code: 'INVALID_TERMINAL_KIND' });
                return true;
            }

            let cwd = projectRoot;
            if (body.cwd_relative) {
                const resolved = path.resolve(projectRoot, body.cwd_relative);
                if (!resolved.startsWith(projectRoot)) {
                    send(res, 403, { error: 'cwd_relative escapes project root', code: 'TRAVERSAL_FORBIDDEN' });
                    return true;
                }
                cwd = resolved;
            }

            try {
                const summary = registry.create({
                    contextId: body.context_id || 'default',
                    kind: kind || 'user-shell',
                    cwd,
                    autoStart: true,
                });
                idempotencyCache.set(requestId, { digest, summary });
                send(res, 201, summary);
            } catch (err) {
                send(res, err.status || ERROR_STATUS[err.code] || 500, { error: err.message, code: err.code || null });
            }
            return true;
        }

        // Action or Stream routes: /api/terminals/:id/(stream|claim|input|resize|stop)
        const match = /^\/api\/terminals\/([^/]+)(?:\/(stream|claim|input|resize|stop))?$/.exec(url.pathname);
        if (!match) {
            return false;
        }

        const id = match[1];
        if (!SAFE_ID_REGEX.test(id)) {
            send(res, 400, { error: 'invalid terminal ID format' });
            return true;
        }

        const action = match[2];

        if (req.method === 'GET' && action === 'stream') {
            openTerminalStream(req, res, id);
            return true;
        }

        if (req.method === 'POST' && ['claim', 'input', 'resize', 'stop'].includes(action)) {
            if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
                send(res, 415, { error: 'expected application/json' });
                return true;
            }

            let body;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                send(res, err.status || 400, { error: err.message });
                return true;
            }

            try {
                if (action === 'claim') {
                    const result = registry.claim(id, body.client_id);
                    send(res, 200, result);
                } else if (action === 'input') {
                    registry.input(id, body.client_id, body.data);
                    send(res, 200, { ok: true });
                } else if (action === 'resize') {
                    registry.resize(id, body.client_id, body.cols, body.rows);
                    send(res, 200, { ok: true });
                } else if (action === 'stop') {
                    const result = registry.stop(id);
                    send(res, 200, result || { ok: true });
                }
            } catch (err) {
                send(res, err.status || ERROR_STATUS[err.code] || 500, { error: err.message, code: err.code || null });
            }
            return true;
        }

        return false;
    }

    return {
        handle,
        openTerminalStream,
        idempotencyCache,
    };
}

module.exports = {
    createTerminalRouter,
    MAX_IDEMPOTENCY_ENTRIES,
};
