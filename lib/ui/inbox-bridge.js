'use strict';

// `omni ui` → daemon for the user inbox (SPEC-SQUAD-P6 §4.1). Posting needs the
// daemon (it owns the ledger); like the omni hook, start it when it is not running.

const path = require('node:path');
const { createDaemonClient } = require('../dual/daemon-client');

const DAEMON_ENTRYPOINT = path.resolve(__dirname, '..', '..', 'bin', 'omni-daemon.js');

async function healthyClient(root, { createClient = createDaemonClient, spawnDaemon, waitMs = 10_000 } = {}) {
    const client = createClient({ workspaceRoot: root, timeoutMs: 10_000 });
    let health = null;
    try { health = await client.health(); } catch { health = null; }
    if (health && health.status === 'healthy') return client;
    const start = spawnDaemon || ((workspaceRoot) => require('../dual/hook-bridge').spawnDaemonProcess({ workspaceRoot, daemonEntrypoint: DAEMON_ENTRYPOINT }));
    start(root);
    await client.waitForHealthy({ timeoutMs: waitMs, intervalMs: 100 });
    return client;
}

async function postViaDaemon(root, { sessionId, messageId, to, body }, options = {}) {
    const client = await healthyClient(root, options);
    return client.inboxPost(sessionId, { message_id: messageId, to, body, via: 'ui' });
}

module.exports = { postViaDaemon, healthyClient };
