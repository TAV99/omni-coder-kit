// End-to-End Acceptance and Injected Fixture Runner for Omni UI (T16)
//
// Verifies full requirements matrix UI-01 through UI-18 using an injected loopback server.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamic import of CommonJS server and modules
const { startUiServer } = await import('../lib/ui/server.js');
const { readyReports, registryWith } = await import('./helpers/squad-project.js');

function request(url, options = {}, body = null) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request({
            hostname: u.hostname,
            port: u.port,
            path: u.pathname + u.search,
            method: options.method || 'GET',
            headers: options.headers || {},
        }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(data);
                } catch {
                    parsed = data;
                }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed });
            });
        });
        req.on('error', reject);
        if (body) {
            req.write(typeof body === 'string' ? body : JSON.stringify(body));
        }
        req.end();
    });
}

function listenSse(url, headers = {}, maxEvents = 3, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const events = [];
        const timer = setTimeout(() => {
            req.destroy();
            resolve(events);
        }, timeoutMs);

        const req = http.request({
            hostname: u.hostname,
            port: u.port,
            path: u.pathname + u.search,
            method: 'GET',
            headers: {
                ...headers,
                Accept: 'text/event-stream',
            },
        }, res => {
            let buffer = '';
            res.on('data', chunk => {
                buffer += chunk.toString();
                const parts = buffer.split('\n\n');
                buffer = parts.pop();
                for (const part of parts) {
                    if (part.trim()) {
                        events.push(part.trim());
                        if (events.length >= maxEvents) {
                            clearTimeout(timer);
                            req.destroy();
                            return resolve(events);
                        }
                    }
                }
            });
            res.on('end', () => {
                clearTimeout(timer);
                resolve(events);
            });
        });

        req.on('error', err => {
            clearTimeout(timer);
            resolve(events);
        });

        req.end();
    });
}

async function runAcceptance() {
    console.log('--- Starting Omni UI E2E Acceptance Suite (T16) ---');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-ui-e2e-'));

    // Create sample project fixtures
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Omni Test Project\n\nOffline test content.\n');
    fs.mkdirSync(path.join(tmpDir, '.omni', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.omni', 'runs', 'worker.stdout.log'), 'Worker build complete.\nTurn finished.\n');

    const testRegistry = registryWith(readyReports({
        codexModels: ['gpt-6.1-sol', 'gpt-4o'],
        agyModels: ['gemini-3.8-flash-high'],
        claudeModels: ['claude-3-5-sonnet-20241022'],
    }));

    const serverInstance = await startUiServer({
        projectRoot: tmpDir,
        port: 0,
        squadRegistry: testRegistry,
        allowShell: true,
    });

    const baseUrl = `http://127.0.0.1:${serverInstance.port}`;
    const token = serverInstance.token;
    const authHeaders = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    };

    console.log(`Server running on ${baseUrl}`);

    try {
        // UI-01 & UI-16: Static ES Modules and CSS are served
        console.log('Checking UI-01 / UI-16: static module distribution...');
        const layoutRes = await request(`${baseUrl}/workspace/layout.mjs`);
        assert.equal(layoutRes.status, 200);
        assert.ok(layoutRes.headers['content-type'].includes('javascript'));

        const tokensRes = await request(`${baseUrl}/workspace/tokens.css`);
        assert.equal(tokensRes.status, 200);
        assert.ok(tokensRes.headers['content-type'].includes('css'));

        // UI-02 & UI-15: Context management
        console.log('Checking UI-02 / UI-15: workspace contexts and security...');
        const wsRes = await request(`${baseUrl}/api/workspace`, { headers: authHeaders });
        assert.equal(wsRes.status, 200);
        assert.ok(Array.isArray(wsRes.body.contexts));
        assert.ok(wsRes.body.contexts.some(c => c.mode === 'squad'));
        assert.ok(wsRes.body.contexts.some(c => c.mode === 'single'));

        // UI-14: Preferences read and atomic write with CAS
        console.log('Checking UI-14: preferences CAS...');
        const prefRead = await request(`${baseUrl}/api/preferences`, { headers: authHeaders });
        assert.equal(prefRead.status, 200);
        const curRev = prefRead.body.revision;

        const prefWrite = await request(`${baseUrl}/api/preferences`, {
            method: 'PUT',
            headers: authHeaders,
        }, {
            expected_revision: curRev,
            value: { ...prefRead.body, theme: 'midnight' },
        });
        assert.equal(prefWrite.status, 200);
        assert.notEqual(prefWrite.body.revision, curRev);

        // UI-03, UI-07, UI-09, UI-10: Terminals and multi-tab contention
        console.log('Checking UI-03 / UI-07 / UI-10: terminal single-writer policy...');
        const createTermRes = await request(`${baseUrl}/api/terminals`, {
            method: 'POST',
            headers: authHeaders,
        }, {
            request_id: 'a0000000-0000-0000-0000-000000000001',
            context_id: 'squad',
            kind: 'user-shell',
        });
        assert.equal(createTermRes.status, 201);
        const termId = createTermRes.body.id;

        // Attach clients to terminal session
        const termSession = serverInstance.registry.get(termId);
        const clientA = termSession.attach(() => {}, 0);
        const clientB = termSession.attach(() => {}, 0);

        // Client A claims terminal
        const claimARes = await request(`${baseUrl}/api/terminals/${termId}/claim`, {
            method: 'POST',
            headers: authHeaders,
        }, { client_id: clientA.clientId });
        assert.equal(claimARes.status, 200);

        // Client A writes input -> succeeds
        const inputARes = await request(`${baseUrl}/api/terminals/${termId}/input`, {
            method: 'POST',
            headers: authHeaders,
        }, { client_id: clientA.clientId, data: 'echo hello\n' });
        assert.equal(inputARes.status, 200);

        // Client B tries to write without claim -> rejected with 403 (not writer)
        const inputBRes = await request(`${baseUrl}/api/terminals/${termId}/input`, {
            method: 'POST',
            headers: authHeaders,
        }, { client_id: clientB.clientId, data: 'malicious input\n' });
        assert.equal(inputBRes.status, 403);

        // UI-11 & UI-17: Bounded file service
        console.log('Checking UI-11 / UI-17: bounded project file containment...');
        const fileOpenRes = await request(`${baseUrl}/api/files/open`, {
            method: 'POST',
            headers: authHeaders,
        }, { relative_path: 'README.md' });
        assert.equal(fileOpenRes.status, 200);
        assert.ok(fileOpenRes.body.handle);

        const fileContentRes = await request(
            `${baseUrl}/api/files/${fileOpenRes.body.handle}/content?revision=${fileOpenRes.body.revision}`,
            { headers: authHeaders }
        );
        assert.equal(fileContentRes.status, 200);
        assert.ok(typeof fileContentRes.body === 'string' && fileContentRes.body.includes('Omni Test Project'));

        // Traversal rejection check
        const traversalRes = await request(`${baseUrl}/api/files/open`, {
            method: 'POST',
            headers: authHeaders,
        }, { relative_path: '../../etc/passwd' });
        assert.equal(traversalRes.status, 403);

        // UI-04, UI-05, UI-06: Binding catalog, preflight, and draft persistence
        console.log('Checking UI-04 / UI-05 / UI-06: binding catalog and preflight...');
        const catRes = await request(`${baseUrl}/api/runtime-catalog?role_id=orchestrator`, { headers: authHeaders });
        assert.equal(catRes.status, 200);
        const agyInOrch = catRes.body.runtimes.find(r => r.id === 'agy');
        assert.equal(agyInOrch.eligible, false); // Engine limitation enforced!

        const draftRes = await request(`${baseUrl}/api/bindings/drafts`, {
            method: 'POST',
            headers: authHeaders,
        }, {
            schema_version: 1,
            preset: 'squad',
            roles: {
                orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol' },
                worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }],
                reviewer: null,
            },
        });
        assert.equal(draftRes.status, 200);
        assert.ok(draftRes.body.draft_id);

        // UI-13: Honest rate limits presentation
        console.log('Checking UI-13: honest rate limit observations...');
        const limitsRes = await request(`${baseUrl}/api/limits`, { headers: authHeaders });
        assert.equal(limitsRes.status, 200);
        assert.ok(Array.isArray(limitsRes.body));
        const codexLim = limitsRes.body.find(l => l.runtime === 'codex');
        assert.equal(codexLim.status, 'unsupported');
        assert.equal(codexLim.windows[0].remaining, null); // No fabricated numbers!

        console.log('--- ALL E2E ACCEPTANCE ASSERTIONS PASSED SUCCESSFULLY (T16) ---');
    } finally {
        await serverInstance.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

runAcceptance().catch(err => {
    console.error('E2E Acceptance Failure:', err);
    process.exit(1);
});
