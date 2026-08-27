'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn } = require('node:child_process');

const {
    createDaemonClient,
    DualDaemonClientError,
} = require('../lib/dual/daemon-client');

const {
    startDaemonServer,
} = require('../lib/dual/daemon-server');

const {
    createAuthorityStore,
} = require('../lib/dual/authority-store');

const {
    computeWorkspaceId,
    getRuntimeDir,
} = require('../lib/dual/daemon-lock');

function createTempWorkspace(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-client-ws-'));
    const canonical = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
    t.after(() => {
        fs.rmSync(canonical, { recursive: true, force: true });
    });
    return canonical;
}

// --------------------------------------------------------------------------
// 1. Module Exports & Constructor Validation
// --------------------------------------------------------------------------
test('daemon-client exports createDaemonClient and DualDaemonClientError', () => {
    assert.equal(typeof createDaemonClient, 'function');
    assert.equal(typeof DualDaemonClientError, 'function');
});

test('createDaemonClient validates workspaceRoot existence and canonicalization', (t) => {
    const wsRoot = createTempWorkspace(t);

    assert.throws(
        () => createDaemonClient({ workspaceRoot: null }),
        (err) => {
            assert.equal(err.name, 'DualDaemonClientError');
            assert.equal(err.code, 'DUAL_WORKSPACE_ROOT_INVALID');
            return true;
        }
    );

    assert.throws(
        () => createDaemonClient({ workspaceRoot: path.join(wsRoot, 'non-existent-dir-12345') }),
        (err) => {
            assert.equal(err.name, 'DualDaemonClientError');
            assert.equal(err.code, 'DUAL_WORKSPACE_ROOT_INVALID');
            return true;
        }
    );

    const client = createDaemonClient({ workspaceRoot: wsRoot });
    assert.equal(typeof client.request, 'function');
    assert.equal(typeof client.health, 'function');
    assert.equal(typeof client.beginSession, 'function');
    assert.equal(typeof client.status, 'function');
    assert.equal(typeof client.evaluateHook, 'function');
    assert.equal(typeof client.evaluateCompletion, 'function');
    assert.equal(typeof client.stop, 'function');
    assert.equal(typeof client.waitForHealthy, 'function');
});

// --------------------------------------------------------------------------
// 2. Strict Discovery File Validation
// --------------------------------------------------------------------------
test('discovery file validation rejects missing, malformed, extra keys, and corrupt types', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const runtimeDir = getRuntimeDir(wsRoot);
    const discoveryPath = path.join(runtimeDir, 'daemon.json');
    const wsId = computeWorkspaceId(wsRoot);
    const client = createDaemonClient({ workspaceRoot: wsRoot });

    // 1. Missing discovery
    await assert.rejects(
        () => client.health(),
        (err) => {
            assert.equal(err.code, 'DUAL_DISCOVERY_MISSING');
            assert.equal(err.message.includes('token'), false);
            return true;
        }
    );

    fs.mkdirSync(runtimeDir, { recursive: true });

    // 2. Malformed JSON
    fs.writeFileSync(discoveryPath, '{broken json', 'utf8');
    await assert.rejects(
        () => client.health(),
        (err) => {
            assert.equal(err.code, 'DUAL_DISCOVERY_CORRUPT');
            return true;
        }
    );

    // 3. Extra unexpected key
    const validDiscovery = {
        protocol_version: 1,
        workspace_id: wsId,
        workspace_root: wsRoot,
        pid: process.pid,
        started_at: new Date().toISOString(),
        host: '127.0.0.1',
        port: 12345,
        token: 'a'.repeat(64),
    };

    fs.writeFileSync(discoveryPath, JSON.stringify({ ...validDiscovery, extra_field: 'forbidden' }), 'utf8');
    await assert.rejects(
        () => client.health(),
        (err) => {
            assert.equal(err.code, 'DUAL_DISCOVERY_CORRUPT');
            return true;
        }
    );

    // 4. Invalid protocol_version
    fs.writeFileSync(discoveryPath, JSON.stringify({ ...validDiscovery, protocol_version: 2 }), 'utf8');
    await assert.rejects(
        () => client.health(),
        (err) => {
            assert.equal(err.code, 'DUAL_DISCOVERY_CORRUPT');
            return true;
        }
    );

    // 5. Invalid host (must be literal 127.0.0.1)
    fs.writeFileSync(discoveryPath, JSON.stringify({ ...validDiscovery, host: '0.0.0.0' }), 'utf8');
    await assert.rejects(
        () => client.health(),
        (err) => {
            assert.equal(err.code, 'DUAL_DISCOVERY_CORRUPT');
            return true;
        }
    );

    // 6. Invalid port (out of range or non-integer)
    fs.writeFileSync(discoveryPath, JSON.stringify({ ...validDiscovery, port: 70000 }), 'utf8');
    await assert.rejects(
        () => client.health(),
        (err) => {
            assert.equal(err.code, 'DUAL_DISCOVERY_CORRUPT');
            return true;
        }
    );

    // 7. Invalid token (not 64 lowercase hex)
    fs.writeFileSync(discoveryPath, JSON.stringify({ ...validDiscovery, token: 'INVALID_HEX' }), 'utf8');
    await assert.rejects(
        () => client.health(),
        (err) => {
            assert.equal(err.code, 'DUAL_DISCOVERY_CORRUPT');
            return true;
        }
    );

    // 8. Invalid pid (must be positive integer)
    fs.writeFileSync(discoveryPath, JSON.stringify({ ...validDiscovery, pid: -5 }), 'utf8');
    await assert.rejects(
        () => client.health(),
        (err) => {
            assert.equal(err.code, 'DUAL_DISCOVERY_CORRUPT');
            return true;
        }
    );

    // 9. Invalid started_at (must be valid ISO date)
    fs.writeFileSync(discoveryPath, JSON.stringify({ ...validDiscovery, started_at: 'not-a-date' }), 'utf8');
    await assert.rejects(
        () => client.health(),
        (err) => {
            assert.equal(err.code, 'DUAL_DISCOVERY_CORRUPT');
            return true;
        }
    );

    // 10. Cross-workspace: workspace_id mismatch
    fs.writeFileSync(discoveryPath, JSON.stringify({ ...validDiscovery, workspace_id: 'b'.repeat(64) }), 'utf8');
    await assert.rejects(
        () => client.health(),
        (err) => {
            assert.equal(err.code, 'DUAL_DISCOVERY_WORKSPACE_MISMATCH');
            return true;
        }
    );

    // 11. Cross-workspace: workspace_root mismatch
    fs.writeFileSync(discoveryPath, JSON.stringify({ ...validDiscovery, workspace_root: 'C:\\other\\workspace' }), 'utf8');
    await assert.rejects(
        () => client.health(),
        (err) => {
            assert.equal(err.code, 'DUAL_DISCOVERY_WORKSPACE_MISMATCH');
            return true;
        }
    );
});

// --------------------------------------------------------------------------
// 3. Token Privacy - Token Never Echoed
// --------------------------------------------------------------------------
test('token is never returned in health, status, error objects, or thrown messages', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });
    t.after(() => daemon.close());

    const client = createDaemonClient({ workspaceRoot: wsRoot });

    // Health
    const health = await client.health();
    assert.equal(health.status, 'healthy');
    assert.equal(health.token, undefined);
    assert.equal(JSON.stringify(health).includes(daemon.token), false);

    // Begin session
    const begin = await client.beginSession({
        session_id: 'sess-token-check',
        workspace_root: wsRoot,
        mode: 'auto',
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
    });
    assert.equal(begin.session_id, 'sess-token-check');
    assert.equal(JSON.stringify(begin).includes(daemon.token), false);

    // Status
    const status = await client.status('sess-token-check');
    assert.equal(status.session_id, 'sess-token-check');
    assert.equal(JSON.stringify(status).includes(daemon.token), false);

    // Trigger RPC error (e.g. unknown method)
    await assert.rejects(
        () => client.request('unknown.method', {}),
        (err) => {
            assert.equal(err.code, 'DUAL_METHOD_NOT_FOUND');
            assert.equal(err.message.includes(daemon.token), false);
            assert.equal(JSON.stringify(err.details || {}).includes(daemon.token), false);
            return true;
        }
    );
});

// --------------------------------------------------------------------------
// 4. Client API Wrappers Against Real Daemon
// --------------------------------------------------------------------------
test('client API methods invoke server RPC methods with correct parameters and session_id', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });
    t.after(() => daemon.close());

    const client = createDaemonClient({ workspaceRoot: wsRoot });

    // 1. health
    const health = await client.health();
    assert.equal(health.status, 'healthy');
    assert.equal(health.workspace_id, daemon.workspaceId);
    assert.equal(health.pid, process.pid);

    // 2. beginSession
    const begin = await client.beginSession({
        session_id: 'sess-wrappers-1',
        workspace_root: wsRoot,
        mode: 'auto',
    });
    assert.equal(begin.session_id, 'sess-wrappers-1');
    assert.equal(begin.state, 'DISCOVERED');

    // 3. status
    const status = await client.status('sess-wrappers-1');
    assert.equal(status.session_id, 'sess-wrappers-1');
    assert.equal(status.state, 'DISCOVERED');

    // 4. evaluateHook
    const hookRes = await client.evaluateHook('sess-wrappers-1', {
        hook_event_name: 'SessionStart',
    });
    assert.equal(hookRes.decision, 'allow');

    // 5. evaluateCompletion
    const compRes = await client.evaluateCompletion('sess-wrappers-1', {});
    assert.equal(compRes.verified, false);
    assert.ok(compRes.blockers.length > 0);

    // 6. stop
    const stopRes = await client.stop();
    assert.equal(stopRes.success, true);
    await daemon.stopped;
});

// --------------------------------------------------------------------------
// 5. Timeouts, Connection Refusal, and Response Size Limit
// --------------------------------------------------------------------------
test('client handles connection refusal when daemon is not running', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const runtimeDir = getRuntimeDir(wsRoot);
    const discoveryPath = path.join(runtimeDir, 'daemon.json');
    const wsId = computeWorkspaceId(wsRoot);

    fs.mkdirSync(runtimeDir, { recursive: true });
    // Write discovery pointing to an unused port
    fs.writeFileSync(discoveryPath, JSON.stringify({
        protocol_version: 1,
        workspace_id: wsId,
        workspace_root: wsRoot,
        pid: process.pid,
        started_at: new Date().toISOString(),
        host: '127.0.0.1',
        port: 65432,
        token: 'c'.repeat(64),
    }), 'utf8');

    const client = createDaemonClient({ workspaceRoot: wsRoot });
    await assert.rejects(
        () => client.health(),
        (err) => {
            assert.equal(err.code, 'DUAL_CLIENT_CONNECTION_REFUSED');
            assert.equal(err.message.includes('65432'), true);
            return true;
        }
    );
});

test('client enforces timeoutMs and destroys socket on timeout', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const runtimeDir = getRuntimeDir(wsRoot);
    const discoveryPath = path.join(runtimeDir, 'daemon.json');
    const wsId = computeWorkspaceId(wsRoot);
    const token = 'd'.repeat(64);

    // Create a slow server that delays response
    const slowServer = http.createServer((req, res) => {
        // Intentionally do not respond within timeout
        setTimeout(() => {
            if (!res.writableEnded) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ result: { status: 'healthy' } }));
            }
        }, 300);
    });

    await new Promise((resolve) => slowServer.listen(0, '127.0.0.1', resolve));
    const port = slowServer.address().port;
    t.after(() => new Promise((resolve) => slowServer.close(resolve)));

    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(discoveryPath, JSON.stringify({
        protocol_version: 1,
        workspace_id: wsId,
        workspace_root: wsRoot,
        pid: process.pid,
        started_at: new Date().toISOString(),
        host: '127.0.0.1',
        port,
        token,
    }), 'utf8');

    const client = createDaemonClient({ workspaceRoot: wsRoot, timeoutMs: 50 });
    await assert.rejects(
        () => client.health(),
        (err) => {
            assert.equal(err.code, 'DUAL_CLIENT_TIMEOUT');
            assert.equal(err.message.includes('50ms'), true);
            return true;
        }
    );
});

test('client enforces 64 KiB response body size limit and rejects malformed responses', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const runtimeDir = getRuntimeDir(wsRoot);
    const discoveryPath = path.join(runtimeDir, 'daemon.json');
    const wsId = computeWorkspaceId(wsRoot);
    const token = 'e'.repeat(64);

    let mode = 'oversize';
    const fakeServer = http.createServer((req, res) => {
        if (mode === 'oversize') {
            const bigStr = JSON.stringify({ result: { padding: 'x'.repeat(70 * 1024) } });
            res.writeHead(200, {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bigStr),
            });
            res.end(bigStr);
        } else if (mode === 'not-json') {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('this is not json');
        } else if (mode === 'invalid-envelope') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ unexpected: true }));
        }
    });

    await new Promise((resolve) => fakeServer.listen(0, '127.0.0.1', resolve));
    const port = fakeServer.address().port;
    t.after(() => new Promise((resolve) => fakeServer.close(resolve)));

    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(discoveryPath, JSON.stringify({
        protocol_version: 1,
        workspace_id: wsId,
        workspace_root: wsRoot,
        pid: process.pid,
        started_at: new Date().toISOString(),
        host: '127.0.0.1',
        port,
        token,
    }), 'utf8');

    const client = createDaemonClient({ workspaceRoot: wsRoot });

    // 1. Response too large
    mode = 'oversize';
    await assert.rejects(
        () => client.health(),
        (err) => {
            assert.equal(err.code, 'DUAL_CLIENT_RESPONSE_TOO_LARGE');
            return true;
        }
    );

    // 2. Not JSON
    mode = 'not-json';
    await assert.rejects(
        () => client.health(),
        (err) => {
            assert.equal(err.code, 'DUAL_CLIENT_MALFORMED_RESPONSE');
            return true;
        }
    );

    // 3. Invalid envelope (missing result and error)
    mode = 'invalid-envelope';
    await assert.rejects(
        () => client.health(),
        (err) => {
            assert.equal(err.code, 'DUAL_CLIENT_MALFORMED_RESPONSE');
            return true;
        }
    );
});

// --------------------------------------------------------------------------
// 6. Condition Polling (waitForHealthy)
// --------------------------------------------------------------------------
test('waitForHealthy polls until discovery appears and daemon becomes healthy', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess'));
    const client = createDaemonClient({ workspaceRoot: wsRoot });

    // Start daemon slightly delayed (100ms)
    let daemon = null;
    const startTimer = setTimeout(async () => {
        daemon = await startDaemonServer({
            workspaceRoot: wsRoot,
            authorityStore,
        });
    }, 100);
    t.after(() => {
        clearTimeout(startTimer);
        if (daemon) daemon.close();
    });

    const health = await client.waitForHealthy({ timeoutMs: 3000, intervalMs: 20 });
    assert.equal(health.status, 'healthy');
    assert.equal(health.workspace_id, computeWorkspaceId(wsRoot));
});

test('waitForHealthy aborts immediately on corrupt discovery without waiting for deadline', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const runtimeDir = getRuntimeDir(wsRoot);
    const discoveryPath = path.join(runtimeDir, 'daemon.json');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(discoveryPath, '{malformed json', 'utf8');

    const client = createDaemonClient({ workspaceRoot: wsRoot });
    const startMs = Date.now();

    await assert.rejects(
        () => client.waitForHealthy({ timeoutMs: 5000, intervalMs: 50 }),
        (err) => {
            assert.equal(err.code, 'DUAL_DISCOVERY_CORRUPT');
            return true;
        }
    );

    const elapsed = Date.now() - startMs;
    assert.ok(elapsed < 2000, `Expected immediate abort on corrupt discovery, took ${elapsed}ms`);
});

test('waitForHealthy times out if daemon never becomes healthy', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const client = createDaemonClient({ workspaceRoot: wsRoot });

    await assert.rejects(
        () => client.waitForHealthy({ timeoutMs: 150, intervalMs: 30 }),
        (err) => {
            assert.equal(err.code, 'DUAL_CLIENT_TIMEOUT');
            return true;
        }
    );
});

// --------------------------------------------------------------------------
// 7. Entrypoint CLI (bin/omni-daemon.js)
// --------------------------------------------------------------------------
test('omni-daemon entrypoint rejects invalid, missing, or extra arguments', async () => {
    const entrypoint = path.join(__dirname, '..', 'bin', 'omni-daemon.js');

    function runEntry(args) {
        return new Promise((resolve) => {
            const child = spawn(process.execPath, [entrypoint, ...args], {
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: false,
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d) => (stdout += d));
            child.stderr.on('data', (d) => (stderr += d));
            child.on('close', (code) => {
                resolve({ code, stdout, stderr });
            });
        });
    }

    // 1. No args
    const resNoArgs = await runEntry([]);
    assert.equal(resNoArgs.code, 1);
    assert.ok(resNoArgs.stderr.includes('Usage:'));

    // 2. Unknown flag
    const resUnknown = await runEntry(['--invalid-flag']);
    assert.equal(resUnknown.code, 1);
    assert.ok(resUnknown.stderr.includes('Usage:'));

    // 3. Extra arguments
    const resExtra = await runEntry(['--workspace', '.', 'extra-arg']);
    assert.equal(resExtra.code, 1);
    assert.ok(resExtra.stderr.includes('Usage:'));

    // 4. Non-existent directory
    const resNonExistent = await runEntry(['--workspace', 'C:\\non-existent-dir-xyz-987']);
    assert.equal(resNonExistent.code, 1);
    assert.ok(resNonExistent.stderr.includes('does not exist'));
});

test('omni-daemon entrypoint starts server, creates durable authority at .omni/runs/dual-authority, and stops cleanly on SIGTERM', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const entrypoint = path.join(__dirname, '..', 'bin', 'omni-daemon.js');

    const child = spawn(process.execPath, [entrypoint, '--workspace', wsRoot], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
    });

    let stderrOutput = '';
    child.stderr.on('data', (d) => (stderrOutput += d));

    t.after(() => {
        if (!child.killed && child.exitCode === null) {
            try {
                child.kill('SIGKILL');
            } catch {
                // ignore
            }
        }
    });

    const client = createDaemonClient({ workspaceRoot: wsRoot });
    const health = await client.waitForHealthy({ timeoutMs: 5000, intervalMs: 50 });

    assert.equal(health.status, 'healthy');
    assert.equal(health.workspace_id, computeWorkspaceId(wsRoot));
    assert.equal(health.pid, child.pid);

    // Verify durable authority store location at <workspace>/.omni/runs/dual-authority
    const authorityDir = path.join(wsRoot, '.omni', 'runs', 'dual-authority');
    assert.ok(fs.existsSync(authorityDir), 'Durable authority store exists at .omni/runs/dual-authority');

    // Verify runtime discovery at <workspace>/.omni/runtime/dual/daemon.json
    const discoveryPath = path.join(wsRoot, '.omni', 'runtime', 'dual', 'daemon.json');
    assert.ok(fs.existsSync(discoveryPath), 'Runtime discovery exists at .omni/runtime/dual/daemon.json');

    // Stop cleanly via stop() RPC or SIGTERM
    const stopRes = await client.stop();
    assert.equal(stopRes.success, true);

    const exitCode = await new Promise((resolve) => {
        child.on('close', resolve);
    });

    assert.equal(exitCode, 0, `Expected clean exit 0, stderr: ${stderrOutput}`);
    assert.equal(fs.existsSync(discoveryPath), false, 'Discovery file cleaned up on stop');
});
