'use strict';

// A daemon from before an omni upgrade keeps running old code. The build id in
// `health` lets the hook and `omni ui` restart it while idle, and warn while busy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { currentBuildId, isStale, ensureFreshDaemon } = require('../lib/dual/daemon-freshness');

test('build id follows the code: same files same id, an edited file a new id', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-build-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'lib', 'dual'), { recursive: true });
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '3.2.0' }));
    fs.writeFileSync(path.join(root, 'lib', 'dual', 'a.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'bin', 'omni.js'), '#!/usr/bin/env node\n');
    fs.writeFileSync(path.join(root, 'lib', 'notes.md'), 'ignored');
    const first = currentBuildId({ root });
    assert.match(first, /^[0-9a-f]{16}$/);
    assert.equal(currentBuildId({ root }), first);
    fs.writeFileSync(path.join(root, 'lib', 'notes.md'), 'still ignored');
    assert.equal(currentBuildId({ root }), first, 'only code files count');
    fs.writeFileSync(path.join(root, 'lib', 'dual', 'a.js'), 'module.exports = 22;\n');
    const edited = currentBuildId({ root });
    assert.notEqual(edited, first);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '3.2.1' }));
    assert.notEqual(currentBuildId({ root }), edited, 'a new version is a new build');
});

test('stale: a healthy daemon with another or no build id', () => {
    assert.equal(isStale({ status: 'healthy', build_id: 'b' }, 'b'), false);
    assert.equal(isStale({ status: 'healthy', build_id: 'a' }, 'b'), true);
    assert.equal(isStale({ status: 'healthy' }, 'b'), true, 'a daemon from before build ids is older code');
    assert.equal(isStale(null, 'b'), false);
    assert.equal(isStale({ status: 'starting' }, 'b'), false);
});

function fakeClient({ stopFails = false } = {}) {
    const calls = [];
    let alive = true;
    return {
        calls,
        stop: async () => { calls.push('stop'); if (stopFails) throw new Error('refused'); alive = false; },
        health: async () => { calls.push('health'); if (!alive) throw Object.assign(new Error('down'), { code: 'DUAL_CLIENT_CONNECTION_REFUSED' }); return { status: 'healthy', build_id: 'old' }; },
        waitForHealthy: async () => { calls.push('wait'); return { status: 'healthy', build_id: 'new' }; },
    };
}

test('ensureFreshDaemon: idle stale daemon is stopped and started again; busy or fresh is left alone', async () => {
    const idle = fakeClient();
    const spawned = [];
    const restarted = await ensureFreshDaemon({ client: idle, health: { status: 'healthy', build_id: 'old', active_leases: 0 },
        buildId: 'new', spawnDaemon: () => spawned.push('spawn') });
    assert.deepEqual([restarted.state, restarted.health.build_id, spawned.length], ['restarted', 'new', 1]);
    assert.deepEqual(idle.calls.slice(0, 2), ['stop', 'health'], 'waits for the old daemon to go away before starting');
    for (const health of [{ status: 'healthy', build_id: 'old', active_leases: 1 }, { status: 'healthy', build_id: 'old', validator_active: true }]) {
        const busy = fakeClient();
        const result = await ensureFreshDaemon({ client: busy, health, buildId: 'new', spawnDaemon: () => assert.fail('no spawn while busy') });
        assert.deepEqual([result.state, busy.calls], ['stale-busy', []]);
    }
    const fresh = fakeClient();
    assert.equal((await ensureFreshDaemon({ client: fresh, health: { status: 'healthy', build_id: 'new' }, buildId: 'new', spawnDaemon: () => {} })).state, 'fresh');
    assert.equal((await ensureFreshDaemon({ client: { health: async () => ({}) }, health: { status: 'healthy' }, buildId: 'new', spawnDaemon: () => {} })).state,
        'fresh', 'a client that cannot stop the daemon leaves it');
    const refused = fakeClient({ stopFails: true });
    const failed = await ensureFreshDaemon({ client: refused, health: { status: 'healthy', build_id: 'old' }, buildId: 'new', spawnDaemon: () => assert.fail('no spawn') });
    assert.deepEqual([failed.state, failed.health.build_id], ['restart-failed', 'old']);
});
