'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createBindingService } = require('../../lib/ui/binding-service');
const { startUiServer } = require('../../lib/ui/server');
const { readyReports, registryWith } = require('../helpers/squad-project');

function createTestRegistry() {
    const reports = readyReports({
        codexModels: ['gpt-6.1-sol', 'gpt-4o'],
        agyModels: ['gemini-3.8-flash-high', 'claude-sonnet-4-6'],
        claudeModels: ['claude-3-5-sonnet-20241022'],
    });
    return registryWith(reports);
}

function requestJson(url, options = {}, body = null) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request({
            hostname: u.hostname,
            port: u.port,
            path: u.pathname + u.search,
            method: options.method || 'GET',
            headers: options.headers || {},
        }, (res) => {
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

test('T11 binding-service: catalog enforces role capability and engineSupport', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-bind-test-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const registry = createTestRegistry();
    const service = createBindingService({
        root: tmpDir,
        registry,
    });

    // 1. Orchestrator catalog: only codex and claude are eligible. AGY must NOT be eligible!
    const orchCatalog = await service.catalog('orchestrator');
    assert.equal(orchCatalog.supported, true);
    assert.equal(orchCatalog.roleId, 'orchestrator');

    const codexEntry = orchCatalog.runtimes.find(r => r.id === 'codex');
    const claudeEntry = orchCatalog.runtimes.find(r => r.id === 'claude');
    const agyEntry = orchCatalog.runtimes.find(r => r.id === 'agy');

    assert.ok(codexEntry.eligible);
    assert.ok(claudeEntry.eligible);
    assert.equal(agyEntry.eligible, false);
    assert.ok(agyEntry.issues.some(i => i.includes('engine limitation')));

    // 2. Worker catalog: AGY, codex, claude are all eligible
    const workerCatalog = await service.catalog('worker');
    assert.equal(workerCatalog.supported, true);
    const workerAgy = workerCatalog.runtimes.find(r => r.id === 'agy');
    assert.ok(workerAgy.eligible);

    // 3. Unknown role
    const unknownCatalog = await service.catalog('unregistered-role');
    assert.equal(unknownCatalog.supported, false);
});

test('T11 binding-service: preflight computes digest, checks expiration, and validates', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-bind-test-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const registry = createTestRegistry();
    let currentTime = 100000;
    const service = createBindingService({
        root: tmpDir,
        registry,
        clock: {
            now: () => currentTime,
            iso: () => new Date(currentTime).toISOString(),
        },
    });

    const validCandidate = {
        schema_version: 1,
        preset: 'squad',
        roles: {
            orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
            worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' }],
            reviewer: { runtime: 'claude', model: 'claude-3-5-sonnet-20241022' },
        },
        auto: false,
    };

    // 1. Valid preflight
    const pf1 = await service.preflight(validCandidate);
    assert.equal(pf1.valid, true);
    assert.ok(pf1.digest);
    assert.equal(pf1.errors.length, 0);
    assert.equal(new Date(pf1.expires_at).getTime(), currentTime + 60000);

    // 2. Invalidate: invalid engine role (AGY as orchestrator)
    const invalidCandidate = {
        ...validCandidate,
        roles: {
            ...validCandidate.roles,
            orchestrator: { runtime: 'agy', model: 'gemini-3.8-flash-high', effort: 'high' },
        },
    };
    const pf2 = await service.preflight(invalidCandidate);
    assert.equal(pf2.valid, false);
    assert.ok(pf2.errors.some(e => e.message.includes('orchestrator must be codex or claude')));
});

test('T11 binding-service: saveDraft persists atomically and does not alter active binding', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-bind-test-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const registry = createTestRegistry();
    const service = createBindingService({
        root: tmpDir,
        registry,
    });

    const draft = {
        schema_version: 1,
        preset: 'squad',
        roles: {
            orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol' },
            worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }],
            reviewer: null,
        },
    };

    // 1. Save draft
    const saved = await service.saveDraft(draft);
    assert.ok(saved.draft_id);
    assert.ok(saved.revision);

    // Active squad.local.json must NOT exist!
    assert.equal(fs.existsSync(path.join(tmpDir, '.omni', 'squad.local.json')), false);

    // Draft file must exist
    const draftFromFile = service.getDraft();
    assert.equal(draftFromFile.revision, saved.revision);
    assert.equal(draftFromFile.candidate.preset, 'squad');

    // 2. Conflict on stale revision
    await assert.rejects(
        async () => {
            await service.saveDraft(draft, 'wrong-revision');
        },
        /Draft revision conflict/
    );
});

test('T11 server routes: /api/runtime-catalog, /api/bindings/preflight, /api/bindings/drafts', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-bind-test-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const registry = createTestRegistry();
    const serverInstance = await startUiServer({
        projectRoot: tmpDir,
        port: 0,
        squadRegistry: registry,
    });
    t.after(() => serverInstance.close());

    const token = serverInstance.token;
    const authHeaders = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    };

    // 1. GET /api/runtime-catalog
    const catRes = await requestJson(
        `http://127.0.0.1:${serverInstance.port}/api/runtime-catalog?role_id=orchestrator`,
        { headers: authHeaders }
    );
    assert.equal(catRes.status, 200);
    assert.equal(catRes.body.roleId, 'orchestrator');

    // 2. POST /api/bindings/preflight
    const pfRes = await requestJson(
        `http://127.0.0.1:${serverInstance.port}/api/bindings/preflight`,
        { method: 'POST', headers: authHeaders },
        {
            schema_version: 1,
            preset: 'squad',
            roles: {
                orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol' },
                worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }],
                reviewer: null,
            },
        }
    );
    assert.equal(pfRes.status, 200);
    assert.ok(pfRes.body.digest);

    // 3. POST /api/bindings/drafts
    const draftRes = await requestJson(
        `http://127.0.0.1:${serverInstance.port}/api/bindings/drafts`,
        { method: 'POST', headers: authHeaders },
        {
            schema_version: 1,
            preset: 'squad',
            roles: {
                orchestrator: { runtime: 'codex', model: 'gpt-6.1-sol' },
                worker: [{ id: 'worker-1', runtime: 'agy', model: 'gemini-3.8-flash-high' }],
                reviewer: null,
            },
        }
    );
    assert.equal(draftRes.status, 200);
    assert.ok(draftRes.body.draft_id);

    // 4. POST /api/bindings/apply returns 503 unavailable
    const applyRes = await requestJson(
        `http://127.0.0.1:${serverInstance.port}/api/bindings/apply`,
        { method: 'POST', headers: authHeaders },
        { draft_id: draftRes.body.draft_id }
    );
    assert.equal(applyRes.status, 503);
});
