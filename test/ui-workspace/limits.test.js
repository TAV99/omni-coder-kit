'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createLimitsService } = require('../../lib/ui/limits');
const { startUiServer } = require('../../lib/ui/server');

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

test('T14 limits: returns exact LimitObservation shape and honest unsupported/unavailable status', async () => {
    let now = 1000000;
    const service = createLimitsService({
        clock: { now: () => now, iso: () => new Date(now).toISOString() },
    });

    // 1. Read codex limits (honest unsupported, no fake numbers)
    const codexObs = await service.read('codex');
    assert.equal(codexObs.runtime, 'codex');
    assert.equal(codexObs.status, 'unsupported');
    assert.equal(codexObs.stale, false);
    assert.equal(codexObs.windows.length, 1);
    assert.equal(codexObs.windows[0].remaining, null); // Honest null!
    assert.ok(codexObs.explanation);

    // 2. Read claude limits (honest unavailable)
    const claudeObs = await service.read('claude');
    assert.equal(claudeObs.runtime, 'claude');
    assert.equal(claudeObs.status, 'unavailable');
    assert.equal(claudeObs.stale, false);
    assert.equal(claudeObs.windows[0].remaining, null);

    // 3. Read agy limits (honest unavailable)
    const agyObs = await service.read('agy');
    assert.equal(agyObs.runtime, 'agy');
    assert.equal(agyObs.status, 'unavailable');
    assert.equal(agyObs.stale, false);
});

test('T14 limits: coalesces rapid refreshes within 60s and marks stale after 120s', async () => {
    let now = 1000000;
    let providerReadCount = 0;

    const mockProvider = {
        async readLimits({ accountKey, clock }) {
            providerReadCount++;
            return {
                runtime: 'custom',
                accountKey,
                source: 'test-cli',
                status: 'available',
                observedAt: clock.iso(),
                windows: [
                    { id: 'rpm', label: 'RPM', unit: 'requests', remaining: 50, limit: 60 },
                ],
            };
        },
    };

    const service = createLimitsService({
        providers: { custom: mockProvider },
        clock: { now: () => now, iso: () => new Date(now).toISOString() },
        minIntervalMs: 60000,
        staleThresholdMs: 120000,
    });

    // 1. Initial read
    const obs1 = await service.refresh('custom', 'acct-1');
    assert.equal(providerReadCount, 1);
    assert.equal(obs1.stale, false);
    assert.equal(obs1.windows[0].remaining, 50);

    // 2. Rapid refresh at +10s coalesces without calling provider again
    now += 10000;
    const obs2 = await service.refresh('custom', 'acct-1');
    assert.equal(providerReadCount, 1); // Not increased!
    assert.equal(obs2.stale, false);

    // 3. Refresh after +70s (exceeds minIntervalMs 60s) calls provider
    now += 60000; // now = 1000000 + 70000
    const obs3 = await service.refresh('custom', 'acct-1');
    assert.equal(providerReadCount, 2); // Increased!
    assert.equal(obs3.stale, false);

    // 4. Stale check at +150s (without refresh)
    now += 150000;
    const obsStale = await service.read('custom', 'acct-1');
    assert.equal(obsStale.stale, true); // Stale threshold exceeded!
});

test('T14 limits: sanitizes accountKey and degrades gracefully on provider errors', async () => {
    const errorProvider = {
        async readLimits() {
            throw new Error('Injected network error contacting provider CLI');
        },
    };

    const service = createLimitsService({
        providers: { flaky: errorProvider },
    });

    // Sanitizes potential email / secret characters
    const obs = await service.read('flaky', 'user@domain.com:secretKey123');
    assert.equal(obs.accountKey, 'user-domain.com-secretKey123');
    assert.equal(obs.status, 'error');
    assert.equal(obs.errorCode, 'PROVIDER_READ_FAILED');
    assert.match(obs.explanation, /Injected network error/);
});

test('T14 limits routes: GET /api/limits and POST /api/limits/refresh', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-limits-server-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const serverInstance = await startUiServer({
        projectRoot: tmpDir,
        port: 0,
    });
    t.after(() => serverInstance.close());

    const token = serverInstance.token;
    const authHeaders = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    };

    // 1. GET /api/limits
    const listRes = await requestJson(
        `http://127.0.0.1:${serverInstance.port}/api/limits`,
        { headers: authHeaders }
    );
    assert.equal(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body));
    assert.ok(listRes.body.some(o => o.runtime === 'codex'));

    // 2. POST /api/limits/refresh
    const refreshRes = await requestJson(
        `http://127.0.0.1:${serverInstance.port}/api/limits/refresh`,
        { method: 'POST', headers: authHeaders },
        { runtime: 'claude', account_key: 'default' }
    );
    assert.equal(refreshRes.status, 200);
    assert.equal(refreshRes.body.runtime, 'claude');
    assert.equal(refreshRes.body.status, 'unavailable');
});
