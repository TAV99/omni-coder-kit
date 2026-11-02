'use strict';

// A daemon keeps running the code it started with. After omni is upgraded (or
// edited during development) a long-lived daemon would serve old code: new RPCs
// fail with "Method not found", fixes do not apply. The daemon reports a build id
// in `health`; callers that start daemons compare it with their own and restart
// an idle daemon, or warn while it is busy.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const CODE_DIRS = ['lib', 'bin'];

// Package version plus size and mtime of every source file under lib/ and bin/.
// Not cached: a long-lived caller (omni ui) must see code that changed under it.
function currentBuildId({ root = PACKAGE_ROOT, fsImpl = fs } = {}) {
    const hash = crypto.createHash('sha256');
    try { hash.update(JSON.parse(fsImpl.readFileSync(path.join(root, 'package.json'), 'utf8')).version || ''); } catch { /* no version */ }
    const walk = (dir) => {
        let entries;
        try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch { return; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
            if (!/\.(c?js|mjs|json)$/.test(entry.name)) continue;
            try {
                const stat = fsImpl.statSync(full);
                hash.update(`${path.relative(root, full)}:${stat.size}:${Math.trunc(stat.mtimeMs)}\n`);
            } catch { /* vanished */ }
        }
    };
    for (const dir of CODE_DIRS) walk(path.join(root, dir));
    return hash.digest('hex').slice(0, 16);
}

// A healthy daemon whose build differs from ours (or that predates build ids).
function isStale(health, buildId = currentBuildId()) {
    return Boolean(health && health.status === 'healthy' && health.build_id !== buildId);
}

const isIdle = (health) => !health.validator_active && !(health.active_leases > 0);

// Restarts a stale daemon when it is idle. Returns the health to use from here on
// and what happened: 'fresh' | 'restarted' | 'stale-busy' | 'restart-failed'.
async function ensureFreshDaemon({ client, health, spawnDaemon, buildId = currentBuildId(), waitMs = 10_000 }) {
    if (!isStale(health, buildId) || !client || typeof client.stop !== 'function') return { health, state: 'fresh' };
    if (!isIdle(health)) return { health, state: 'stale-busy' };
    try {
        await client.stop();
        const deadline = Date.now() + 5_000;
        // Wait for the old process to let go of its discovery file and port.
        while (Date.now() < deadline) {
            try { await client.health(); } catch { break; }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        spawnDaemon();
        const fresh = await client.waitForHealthy({ timeoutMs: waitMs, intervalMs: 100 });
        return { health: fresh, state: 'restarted' };
    } catch {
        let after = null;
        try { after = await client.health(); } catch { after = null; }
        return { health: after, state: 'restart-failed' };
    }
}

module.exports = { currentBuildId, isStale, ensureFreshDaemon };
