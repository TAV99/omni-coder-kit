'use strict';

// `omni ui` server (SPEC-SQUAD-P6 §2, P6a: read-only). Loopback only; every API
// call needs the per-run token (bearer header, or the HttpOnly cookie set by
// POST /api/login); Host and Origin must be this server, so another site or a
// DNS-rebound name cannot reach it. Timeline and terminal output go out as
// Server-Sent Events; keys, resize and start come back as JSON POSTs (Q-P6-1).
// The server writes under .omni/runs only through the daemon's inbox.post (a
// user message, P6c) and has no route that approves a gate.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { buildState } = require('./state');
const { readSince, decodeCursor } = require('./feed');
const { createPtyHost, loadNodePty } = require('./pty-host');
const { createTerminalRegistry } = require('./terminal-registry');
const { createTerminalRouter } = require('./terminal-routes');
const { createContextManager } = require('./contexts');
const { createPreferencesStore } = require('./preferences');
const { createRoleOutputSource } = require('./role-output');
const { createFileService } = require('./files');
const { createBindingService } = require('./binding-service');
const { createLimitsService } = require('./limits');
const { postViaDaemon } = require('./inbox-bridge');
const { createTranscriptSource } = require('./transcript-source');
const { createAuthorityStore } = require('../dual/authority-store');
const { readBinding } = require('../squad/bindings');

const STATIC_DIR = path.join(__dirname, 'static');
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/app.css': ['app.css', 'text/css; charset=utf-8'] };
// xterm.js comes from node_modules (optionalDependencies, offline, Q-P6-2).
const VENDOR = { '/vendor/xterm.js': ['@xterm/xterm', 'lib/xterm.js', 'text/javascript; charset=utf-8'],
    '/vendor/xterm.css': ['@xterm/xterm', 'css/xterm.css', 'text/css; charset=utf-8'],
    '/vendor/addon-fit.js': ['@xterm/addon-fit', 'lib/addon-fit.js', 'text/javascript; charset=utf-8'] };
const MAX_BODY = 128 * 1024;
const COOKIE = 'omni_ui';
const SECURITY_HEADERS = {
    // xterm.js adds <style> rules at runtime; scripts stay 'self' only.
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
};

function sameSecret(given, token) {
    if (typeof given !== 'string' || given.length !== token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

function cookieToken(header) {
    for (const part of String(header || '').split(';')) {
        const [name, ...rest] = part.trim().split('=');
        if (name === COOKIE) return rest.join('=');
    }
    return null;
}

function vendorFile(pathname, requireImpl = require) {
    const [pkg, file, type] = VENDOR[pathname];
    try { return [path.join(path.dirname(requireImpl.resolve(`${pkg}/package.json`)), file), type]; } catch { /* fall through */ }
    try {
        // Packages whose `exports` hide package.json: walk up from the main file.
        let dir = path.dirname(requireImpl.resolve(pkg));
        while (!fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
        return [path.join(dir, file), type];
    } catch { return null; }
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); }
        });
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
        });
        req.on('error', reject);
    });
}

const PTY_ERRORS = { UI_PTY_NOT_WRITER: 409, UI_PTY_RUNNING: 409, UI_PTY_STOPPED: 409, UI_PTY_CLIENT: 409, UI_PTY_INPUT: 400,
    UI_PTY_UNAVAILABLE: 503, UI_PTY_NO_BINDING: 409, UI_PTY_NOT_FOUND: 409, UI_PTY_NOT_INTERACTIVE: 409 };

function startUiServer(options = {}) {
    const { projectRoot, port = 0, token = crypto.randomBytes(32).toString('base64url'), pollMs = 1000, heartbeatMs = 15_000,
        pty = null, autoStart = false, postMessage = postViaDaemon, transcriptOptions = null, allowShell = false } = options;
    const root = fs.realpathSync.native(projectRoot);
    const streams = new Set();
    const loaded = pty || loadNodePty();
    const host = createPtyHost({ projectRoot: root, spawnPty: loaded.spawnPty || null, unavailableReason: loaded.reason || null, ...(loaded.hostOptions || {}) });
    const registry = options.registry || createTerminalRegistry({ projectRoot: root, spawnPty: loaded.spawnPty || null, unavailableReason: loaded.reason || null });
    const preferencesStore = options.preferencesStore || createPreferencesStore({ root });
    const contextManager = options.contextManager || createContextManager({ projectRoot: root, registry, preferencesStore });
    const roleOutputSource = options.roleOutputSource || createRoleOutputSource({ projectRoot: root });
    const fileService = options.fileService || createFileService({ projectRoot: root });
    const bindingService = options.bindingService || createBindingService({ root, registry: options.squadRegistry || null, coordinator: options.coordinator || null });
    const limitsService = options.limitsService || createLimitsService();
    const transcript = createTranscriptSource({ projectRoot: root, sessionRef: () => host.sessionRef(),
        recordSession: (runtime, id) => host.recordSession(runtime, id), ...(transcriptOptions || {}) });
    let actualPort = port;

    const allowedHosts = () => new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
    const sameOrigin = (origin) => origin === `http://127.0.0.1:${actualPort}` || origin === `http://localhost:${actualPort}`;
    const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
        res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...extra });
        res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    const deny = (res) => send(res, 403, { error: 'forbidden' });
    const authorized = (req) => {
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
        return sameSecret(bearer ? bearer[1] : cookieToken(req.headers.cookie), token);
    };

    function openPtyStream(req, res) {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        const after = Number(req.headers['last-event-id'] || 0);
        const listener = (event, payload) => {
            if (event === 'data') res.write(`id: ${payload.seq}\ndata: ${JSON.stringify(payload.data)}\n\n`);
            else if (event === 'state') res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
            else if (event === 'close') res.end();
        };
        const client = host.attach(listener, after);
        res.write(`event: hello\ndata: ${JSON.stringify({ client_id: client.clientId, reset: client.replay.reset })}\n\n`);
        for (const chunk of client.replay.chunks) res.write(`id: ${chunk.seq}\ndata: ${JSON.stringify(chunk.data)}\n\n`);
        res.write(`event: state\ndata: ${JSON.stringify(host.status())}\n\n`);
        const beat = setInterval(() => res.write(': keep-alive\n\n'), heartbeatMs);
        const stream = { close() { clearInterval(beat); res.end(); } };
        streams.add(stream);
        req.on('close', () => { clearInterval(beat); streams.delete(stream); client.detach(); });
    }

    async function ptyAction(req, res, action) {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'expected application/json' });
        try {
            const body = await readJsonBody(req);
            if (action === 'start') return send(res, 200, host.start({ resume: body.resume === true }));
            if (action === 'claim') host.claim(body.client_id);
            if (action === 'input') host.input(body.client_id, body.data);
            if (action === 'resize') host.resize(body.client_id, body.cols, body.rows);
            return send(res, 200, { ok: true });
        } catch (error) {
            return send(res, error.status || PTY_ERRORS[error.code] || 500, { error: error.message, code: error.code || null });
        }
    }

    // POST /api/message (SPEC-SQUAD-P6 §4): a person's message to one role or all.
    async function handleMessage(req, res) {
        if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'expected application/json' });
        let body;
        try { body = await readJsonBody(req); } catch (error) { return send(res, error.status || 400, { error: error.message }); }
        const binding = (() => { try { return readBinding(root); } catch { return null; } })();
        const roles = binding ? ['orchestrator', ...binding.roles.worker.map((worker) => worker.id), ...(binding.roles.reviewer ? ['reviewer'] : [])] : [];
        if (![...roles, 'all'].includes(body.to)) return send(res, 400, { error: `unknown recipient "${body.to}"`, code: 'UI_MESSAGE_RECIPIENT' });
        if (typeof body.body !== 'string' || !body.body.trim() || Buffer.byteLength(body.body, 'utf8') > 8192) {
            return send(res, 400, { error: 'message must be 1..8192 bytes', code: 'UI_MESSAGE_BODY' });
        }
        if (typeof body.message_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.message_id)) {
            return send(res, 400, { error: 'message_id must be a UUID', code: 'UI_MESSAGE_ID' });
        }
        let sessionId = null;
        try { sessionId = createAuthorityStore(path.join(root, '.omni', 'runs', 'dual-authority')).derive().sessionId; } catch { sessionId = null; }
        if (!sessionId) {
            return send(res, 409, { error: 'no squad session yet — start one from the orchestrator first', code: 'UI_MESSAGE_NO_SESSION' });
        }
        try {
            const result = await postMessage(root, { sessionId, messageId: body.message_id, to: body.to, body: body.body });
            return send(res, 200, result);
        } catch (error) {
            const status = error.status === 409 || error.code === 'DUAL_INBOX_CONFLICT' ? 409 : error.code === 'DUAL_INBOX_INVALID' ? 400 : 502;
            // A daemon started before an upgrade does not know inbox.post yet.
            const message = /Method not found: inbox\./.test(error.message)
                ? 'the running omni daemon is older than this omni — run "omni dual daemon stop" in this project, then send again' : error.message;
            return send(res, status, { error: message, code: error.code || null });
        }
    }

    function openStream(req, res) {
        let cursor = decodeCursor(req.headers['last-event-id']);
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        const flush = () => {
            const { entries, cursor: next } = readSince(root, cursor, { transcript });
            for (const { cursor: id, ...entry } of entries) res.write(`id: ${id}\nevent: entry\ndata: ${JSON.stringify(entry)}\n\n`);
            cursor = next;
        };
        flush();
        const poll = setInterval(() => { try { flush(); } catch { /* a half-written file is read on the next tick */ } }, pollMs);
        const beat = setInterval(() => res.write(': keep-alive\n\n'), heartbeatMs);
        const stream = { close() { clearInterval(poll); clearInterval(beat); res.end(); } };
        streams.add(stream);
        req.on('close', () => { clearInterval(poll); clearInterval(beat); streams.delete(stream); });
    }

    const terminalRouter = createTerminalRouter({
        registry, send, readJsonBody, streams, heartbeatMs,
        SECURITY_HEADERS, projectRoot: root, allowShell,
    });

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (!allowedHosts().has(req.headers.host)) return deny(res);
        if (req.headers.origin !== undefined && !sameOrigin(req.headers.origin)) return deny(res);
        if (req.method === 'GET' && STATIC[url.pathname]) {
            const [file, type] = STATIC[url.pathname];
            return send(res, 200, fs.readFileSync(path.join(STATIC_DIR, file)), type);
        }
        if (req.method === 'GET' && VENDOR[url.pathname]) {
            const found = vendorFile(url.pathname);
            if (!found || !fs.existsSync(found[0])) return send(res, 404, { error: 'not installed' });
            return send(res, 200, fs.readFileSync(found[0]), found[1]);
        }
        if (req.method === 'GET' && url.pathname.startsWith('/workspace/')) {
            const rel = path.normalize(url.pathname.slice('/workspace/'.length)).replace(/^(\.\.[\/\\])+/, '');
            const filePath = path.join(STATIC_DIR, 'workspace', rel);
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const ext = path.extname(filePath);
                const types = {
                    '.mjs': 'text/javascript; charset=utf-8',
                    '.js': 'text/javascript; charset=utf-8',
                    '.css': 'text/css; charset=utf-8',
                    '.html': 'text/html; charset=utf-8',
                    '.json': 'application/json; charset=utf-8',
                };
                return send(res, 200, fs.readFileSync(filePath), types[ext] || 'text/plain');
            }
        }
        if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
        if (!authorized(req)) return deny(res);
        if (await terminalRouter.handle(req, res, url)) return;
        if (await contextManager.handleRoute(req, res, url, { send, readJsonBody })) return;
        if (await fileService.handleRoute(req, res, url, { send, readJsonBody })) return;
        if (req.method === 'GET' && url.pathname === '/api/preferences') {
            return send(res, 200, preferencesStore.read());
        }
        if (req.method === 'GET' && url.pathname === '/api/runtime-catalog') {
            const roleId = url.searchParams.get('role_id') || 'orchestrator';
            const cat = await bindingService.catalog(roleId);
            return send(res, 200, cat);
        }
        if (req.method === 'POST' && url.pathname === '/api/bindings/preflight') {
            if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'expected application/json' });
            try {
                const body = await readJsonBody(req);
                const result = await bindingService.preflight(body.candidate || body);
                return send(res, 200, result);
            } catch (err) {
                return send(res, 400, { error: err.message, code: 'PREFLIGHT_ERROR' });
            }
        }
        if (req.method === 'POST' && url.pathname === '/api/bindings/drafts') {
            if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'expected application/json' });
            try {
                const body = await readJsonBody(req);
                const saved = await bindingService.saveDraft(body.candidate || body, body.expected_revision);
                return send(res, 200, saved);
            } catch (err) {
                return send(res, err.status || 400, { error: err.message, code: err.code || null });
            }
        }
        if (req.method === 'POST' && url.pathname === '/api/bindings/apply') {
            if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'expected application/json' });
            try {
                const body = await readJsonBody(req);
                const applied = await bindingService.apply(body);
                return send(res, 200, applied);
            } catch (err) {
                return send(res, err.status || 503, { error: err.message, code: err.code || 'APPLY_FAILED' });
            }
        }
        if (req.method === 'GET' && url.pathname === '/api/limits') {
            const contextId = url.searchParams.get('context_id');
            const list = await limitsService.listAll(contextId);
            return send(res, 200, list);
        }
        if (req.method === 'POST' && url.pathname === '/api/limits/refresh') {
            if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'expected application/json' });
            const body = await readJsonBody(req);
            const obs = await limitsService.refresh(body.runtime || 'codex', body.account_key);
            return send(res, 200, obs);
        }
        if (req.method === 'PUT' && url.pathname === '/api/preferences') {
            if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'expected application/json' });
            try {
                const body = await readJsonBody(req);
                const written = preferencesStore.write(body.value || body, body.expected_revision);
                return send(res, 200, written);
            } catch (err) {
                return send(res, err.status || 400, { error: err.message, code: err.code || null });
            }
        }
        if (req.method === 'GET' && url.pathname === '/api/role-output') {
            const ref = {
                contextId: url.searchParams.get('context_id') || 'squad',
                authoritySessionId: url.searchParams.get('session_id') || '',
                taskId: url.searchParams.get('task_id') || '',
                attempt: Number(url.searchParams.get('attempt') || 1),
                executionId: url.searchParams.get('execution_id') || 'exec-1',
                roleId: url.searchParams.get('role_id') || 'worker-1',
                channel: url.searchParams.get('channel') || 'stdout',
            };
            try {
                roleOutputSource.openStream(req, res, ref, { pollMs, heartbeatMs, SECURITY_HEADERS, streams });
                return;
            } catch (err) {
                return send(res, 400, { error: err.message, code: 'INVALID_ROLE_OUTPUT_REF' });
            }
        }
        if (req.method === 'POST' && url.pathname === '/api/login') {
            return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/` });
        }
        if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { ...buildState(root), pty: host.status() });
        if (req.method === 'GET' && url.pathname === '/api/events') return openStream(req, res);
        if (req.method === 'GET' && url.pathname === '/api/pty/stream') return openPtyStream(req, res);
        if (req.method === 'POST' && url.pathname === '/api/message') return handleMessage(req, res);
        const action = /^\/api\/pty\/(start|claim|input|resize)$/.exec(url.pathname);
        if (req.method === 'POST' && action) return ptyAction(req, res, action[1]);
        return send(res, 404, { error: 'not found' });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            actualPort = server.address().port;
            if (autoStart && loaded.spawnPty) { try { host.start({ resume: autoStart === 'resume' }); } catch { /* shown in the pane */ } }
            resolve({
                port: actualPort, token, url: `http://127.0.0.1:${actualPort}/#token=${token}`,
                pty: host,
                registry,
                contextManager,
                preferencesStore,
                fileService,
                bindingService,
                limitsService,
                close: () => new Promise((done) => {
                    host.stop();
                    registry.closeAll();
                    for (const stream of streams) stream.close();
                    server.close(() => done());
                }),
            });
        });
    });
}

module.exports = { startUiServer };
