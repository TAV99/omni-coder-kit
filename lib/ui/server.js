'use strict';

// `omni ui` server (SPEC-SQUAD-P6 §2, P6a: read-only). Loopback only; every API
// call needs the per-run token (bearer header, or the HttpOnly cookie set by
// POST /api/login); Host and Origin must be this server, so another site or a
// DNS-rebound name cannot reach it. Timeline goes out as Server-Sent Events.
// The server never writes under .omni/runs and has no route that approves a gate.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { buildState } = require('./state');
const { readSince, decodeCursor } = require('./feed');

const STATIC_DIR = path.join(__dirname, 'static');
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/app.css': ['app.css', 'text/css; charset=utf-8'] };
const COOKIE = 'omni_ui';
const SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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

function startUiServer({ projectRoot, port = 0, token = crypto.randomBytes(32).toString('base64url'), pollMs = 1000, heartbeatMs = 15_000 } = {}) {
    const root = fs.realpathSync.native(projectRoot);
    const streams = new Set();
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

    function openStream(req, res) {
        let cursor = decodeCursor(req.headers['last-event-id']);
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        const flush = () => {
            const { entries, cursor: next } = readSince(root, cursor);
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

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (!allowedHosts().has(req.headers.host)) return deny(res);
        if (req.headers.origin !== undefined && !sameOrigin(req.headers.origin)) return deny(res);
        if (req.method === 'GET' && STATIC[url.pathname]) {
            const [file, type] = STATIC[url.pathname];
            return send(res, 200, fs.readFileSync(path.join(STATIC_DIR, file)), type);
        }
        if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
        if (!authorized(req)) return deny(res);
        if (req.method === 'POST' && url.pathname === '/api/login') {
            return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/` });
        }
        if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, buildState(root));
        if (req.method === 'GET' && url.pathname === '/api/events') return openStream(req, res);
        return send(res, 404, { error: 'not found' });
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            actualPort = server.address().port;
            resolve({
                port: actualPort, token, url: `http://127.0.0.1:${actualPort}/#token=${token}`,
                close: () => new Promise((done) => { for (const stream of streams) stream.close(); server.close(() => done()); }),
            });
        });
    });
}

module.exports = { startUiServer };
