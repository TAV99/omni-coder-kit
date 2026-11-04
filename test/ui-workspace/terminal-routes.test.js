'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { startUiServer } = require('../../lib/ui/server');
const { writeBinding } = require('../../lib/squad/bindings');

const TEMPLATES = path.join(__dirname, '..', '..', 'templates', 'squad');
const TOKEN = 't'.repeat(43);

function setupProject() {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-term-routes-')));
    const squadDir = path.join(root, '.omni', 'squad');
    fs.mkdirSync(path.join(squadDir, 'roles'), { recursive: true });
    if (fs.existsSync(path.join(TEMPLATES, 'roles'))) {
        for (const name of fs.readdirSync(path.join(TEMPLATES, 'roles'))) {
            fs.copyFileSync(path.join(TEMPLATES, 'roles', name), path.join(squadDir, 'roles', name));
        }
    }
    if (fs.existsSync(path.join(TEMPLATES, 'pipelines', 'dual.yaml'))) {
        fs.copyFileSync(path.join(TEMPLATES, 'pipelines', 'dual.yaml'), path.join(squadDir, 'pipeline.yaml'));
    }
    writeBinding(root, {
        schema_version: 1, preset: 'dual', updated_at: '2026-11-04T00:00:00Z', roles: {
            orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
            worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }],
            reviewer: null,
        }
    });
    return root;
}

function fakePtyFactory() {
    let currentChild = null;
    const spawnPty = (command, args, options) => {
        let onDataCb = () => {};
        let onExitCb = () => {};
        const child = {
            pid: 9999,
            written: [],
            resized: [],
            write(d) { this.written.push(d); },
            resize(c, r) { this.resized.push({ c, r }); },
            kill() { onExitCb({ exitCode: 0 }); },
            onData(fn) { onDataCb = fn; },
            onExit(fn) { onExitCb = fn; },
            emitData(data) { onDataCb(data); },
        };
        currentChild = child;
        return child;
    };
    return { spawnPty, getChild: () => currentChild };
}

function req(port, pathname, { method = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
        const options = {
            hostname: '127.0.0.1',
            port,
            path: pathname,
            method,
            headers: {
                Host: `127.0.0.1:${port}`,
                Authorization: `Bearer ${TOKEN}`,
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...headers,
            },
        };
        const request = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch {}
                resolve({ status: res.statusCode, headers: res.headers, data, json });
            });
        });
        request.on('error', reject);
        if (payload) request.write(payload);
        request.end();
    });
}

test('T04: terminal HTTP and SSE routes', async (t) => {
    const root = setupProject();
    const fake = fakePtyFactory();
    let ui;

    try {
        ui = await startUiServer({
            projectRoot: root,
            token: TOKEN,
            pty: { spawnPty: fake.spawnPty },
        });

        await t.test('security: authentication and headers', async () => {
            // Missing auth -> 403
            const unauth = await req(ui.port, '/api/terminals', { headers: { Authorization: '' } });
            assert.equal(unauth.status, 403);

            // Wrong host -> 403
            const badHost = await req(ui.port, '/api/terminals', { headers: { Host: 'evil.com:1234' } });
            assert.equal(badHost.status, 403);
        });

        await t.test('GET /api/terminals: list terminals', async () => {
            const res = await req(ui.port, '/api/terminals');
            assert.equal(res.status, 200);
            assert.ok(Array.isArray(res.json.terminals));
        });

        let createdTerminalId;
        const requestId = crypto.randomUUID();

        await t.test('POST /api/terminals: create with idempotency', async () => {
            const body = {
                request_id: requestId,
                context_id: 'ctx-alpha',
                kind: 'user-shell',
            };

            // First creation -> 201
            const res1 = await req(ui.port, '/api/terminals', { method: 'POST', body });
            assert.equal(res1.status, 201);
            assert.ok(res1.json.id);
            assert.equal(res1.json.contextId, 'ctx-alpha');
            assert.equal(res1.json.kind, 'user-shell');
            createdTerminalId = res1.json.id;

            // Identical request_id replay -> 200 with same summary
            const res2 = await req(ui.port, '/api/terminals', { method: 'POST', body });
            assert.equal(res2.status, 200);
            assert.equal(res2.json.id, createdTerminalId);

            // Same request_id with different payload -> 409
            const resConflict = await req(ui.port, '/api/terminals', {
                method: 'POST',
                body: { ...body, context_id: 'different-context' }
            });
            assert.equal(resConflict.status, 409);
        });

        await t.test('POST /api/terminals: rejects path traversal in cwd_relative', async () => {
            const res = await req(ui.port, '/api/terminals', {
                method: 'POST',
                body: {
                    request_id: crypto.randomUUID(),
                    context_id: 'ctx-alpha',
                    cwd_relative: '../../../../../../etc',
                }
            });
            assert.equal(res.status, 403);
            assert.equal(res.json.code, 'TRAVERSAL_FORBIDDEN');
        });

        await t.test('POST /api/terminals/:id/claim and input', async () => {
            const session = ui.registry.get(createdTerminalId);
            const client = session.attach(() => {});

            // Input from client
            const inputRes = await req(ui.port, `/api/terminals/${createdTerminalId}/input`, {
                method: 'POST',
                body: { client_id: client.clientId, data: 'echo hi\n' }
            });
            assert.equal(inputRes.status, 200);

            // Resize
            const resizeRes = await req(ui.port, `/api/terminals/${createdTerminalId}/resize`, {
                method: 'POST',
                body: { client_id: client.clientId, cols: 80, rows: 24 }
            });
            assert.equal(resizeRes.status, 200);

            // Stop
            const stopRes = await req(ui.port, `/api/terminals/${createdTerminalId}/stop`, {
                method: 'POST',
                body: {}
            });
            assert.equal(stopRes.status, 200);
            assert.equal(session.summary().status, 'exited');
        });

        await t.test('GET /api/terminals/:id/stream: SSE connection', async () => {
            const term = ui.registry.create({ autoStart: true });
            const sseRes = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('SSE timeout')), 2000);
                const request = http.request({
                    hostname: '127.0.0.1',
                    port: ui.port,
                    path: `/api/terminals/${term.id}/stream`,
                    headers: {
                        Host: `127.0.0.1:${ui.port}`,
                        Authorization: `Bearer ${TOKEN}`,
                    }
                }, (response) => {
                    let receivedData = '';
                    response.on('data', (d) => {
                        receivedData += d.toString();
                        if (receivedData.includes('event: hello') && receivedData.includes('event: state')) {
                            clearTimeout(timer);
                            request.destroy();
                            resolve({ status: response.statusCode, receivedData });
                        }
                    });
                });
                request.on('error', () => {});
                request.end();
            });

            assert.equal(sseRes.status, 200);
            assert.ok(sseRes.receivedData.includes('event: hello'));
            assert.ok(sseRes.receivedData.includes('event: state'));
        });
    } finally {
        if (ui) await ui.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
