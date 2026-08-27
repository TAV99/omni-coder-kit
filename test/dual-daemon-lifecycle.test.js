'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const {
    acquireDaemonLock,
    DualDaemonLockError,
    computeWorkspaceId,
    getRuntimeDir,
} = require('../lib/dual/daemon-lock');

const {
    startDaemonServer,
    DualDaemonServerError,
} = require('../lib/dual/daemon-server');

const {
    createAuthorityStore,
} = require('../lib/dual/authority-store');

function createTempWorkspace(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dual-ws-'));
    const canonical = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
    t.after(() => {
        fs.rmSync(canonical, { recursive: true, force: true });
    });
    return canonical;
}

function makeRpcRequest(serverAddress, payload, options = {}) {
    return new Promise((resolve, reject) => {
        const url = `http://${serverAddress.host}:${serverAddress.port}/rpc`;
        const postData = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const headers = {
            'Content-Type': options.contentType !== undefined ? options.contentType : 'application/json',
            'Content-Length': Buffer.byteLength(postData),
        };
        if (options.token) {
            headers['Authorization'] = `Bearer ${options.token}`;
        }
        if (options.headers) {
            Object.assign(headers, options.headers);
        }

        const req = http.request(url, {
            method: options.method || 'POST',
            headers,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const bodyStr = Buffer.concat(chunks).toString('utf8');
                let bodyJson = null;
                try {
                    bodyJson = JSON.parse(bodyStr);
                } catch {
                    bodyJson = bodyStr;
                }
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: bodyJson,
                });
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

function createFakeClock(startIso = '2026-08-25T00:00:00.000Z') {
    let currentMs = new Date(startIso).getTime();
    function clock() {
        return new Date(currentMs);
    }
    clock.advance = (ms) => {
        currentMs += ms;
        return clock();
    };
    clock.iso = () => new Date(currentMs).toISOString();
    return clock;
}

function initGitWorkspace(workspaceRoot) {
    let init = spawnSync('git', ['init', '-b', 'main'], { cwd: workspaceRoot, encoding: 'utf8' });
    if (init.status !== 0) {
        init = spawnSync('git', ['init'], { cwd: workspaceRoot, encoding: 'utf8' });
    }
    assert.equal(init.status, 0, init.stderr || 'git init failed');
    assert.equal(spawnSync('git', ['config', 'user.email', 'dual-test@example.invalid'], { cwd: workspaceRoot }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'Dual Test'], { cwd: workspaceRoot }).status, 0);
    fs.writeFileSync(path.join(workspaceRoot, 'fixture.txt'), 'initial\n', 'utf8');
    assert.equal(spawnSync('git', ['add', 'fixture.txt'], { cwd: workspaceRoot }).status, 0);
    assert.equal(spawnSync('git', ['commit', '-m', 'initial'], { cwd: workspaceRoot }).status, 0);
    return spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: workspaceRoot,
        encoding: 'utf8',
    }).stdout.trim();
}

// --------------------------------------------------------------------------
// 1. Module Exports
// --------------------------------------------------------------------------
test('daemon-lock and daemon-server export required interfaces and error classes', () => {
    assert.equal(typeof acquireDaemonLock, 'function');
    assert.equal(typeof DualDaemonLockError, 'function');
    assert.equal(typeof computeWorkspaceId, 'function');
    assert.equal(typeof getRuntimeDir, 'function');

    assert.equal(typeof startDaemonServer, 'function');
    assert.equal(typeof DualDaemonServerError, 'function');
});

// --------------------------------------------------------------------------
// 2. Loopback and dynamic port binding
// --------------------------------------------------------------------------
test('startDaemonServer binds dynamically to 127.0.0.1 and exposes lifecycle methods', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });
    t.after(() => daemon.close());

    assert.equal(daemon.address.host, '127.0.0.1');
    assert.ok(daemon.address.port > 0);
    assert.equal(daemon.workspaceId, computeWorkspaceId(wsRoot));
    assert.equal(daemon.workspaceRoot, wsRoot);
    assert.ok(daemon.token && daemon.token.length === 64);
    assert.equal(typeof daemon.close, 'function');
    assert.ok(daemon.stopped instanceof Promise);
});

test('startDaemonServer rejects non-loopback host configuration', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess'));

    await assert.rejects(
        () => startDaemonServer({
            workspaceRoot: wsRoot,
            authorityStore,
            host: '0.0.0.0',
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_SERVER_HOST_INVALID');
            return true;
        }
    );

    await assert.rejects(
        () => startDaemonServer({
            workspaceRoot: wsRoot,
            authorityStore,
            host: '192.168.1.1',
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_SERVER_HOST_INVALID');
            return true;
        }
    );
});

// --------------------------------------------------------------------------
// 3. Token rejection and constant-time-safe length mismatch
// --------------------------------------------------------------------------
test('rejects unauthenticated requests, wrong tokens, and safe length mismatches', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });
    t.after(() => daemon.close());

    const basePayload = {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        method: 'health',
    };

    // 1. Missing token
    const resNoToken = await makeRpcRequest(daemon.address, basePayload);
    assert.equal(resNoToken.statusCode, 401);
    assert.equal(resNoToken.body.error.code, 'DUAL_UNAUTHORIZED');

    // 2. Wrong token (same length 64 hex)
    const wrongSameLenToken = 'a'.repeat(64);
    const resWrongToken = await makeRpcRequest(daemon.address, {
        ...basePayload,
        token: wrongSameLenToken,
    });
    assert.equal(resWrongToken.statusCode, 401);
    assert.equal(resWrongToken.body.error.code, 'DUAL_UNAUTHORIZED');

    // 3. Wrong token (short length - must not throw timingSafeEqual buffer length error)
    const resShortToken = await makeRpcRequest(daemon.address, {
        ...basePayload,
        token: 'short',
    });
    assert.equal(resShortToken.statusCode, 401);
    assert.equal(resShortToken.body.error.code, 'DUAL_UNAUTHORIZED');

    // 4. Wrong token (longer length)
    const resLongToken = await makeRpcRequest(daemon.address, {
        ...basePayload,
        token: 'b'.repeat(128),
    });
    assert.equal(resLongToken.statusCode, 401);
    assert.equal(resLongToken.body.error.code, 'DUAL_UNAUTHORIZED');

    // 5. Valid token in body
    const resValidBody = await makeRpcRequest(daemon.address, {
        ...basePayload,
        token: daemon.token,
    });
    assert.equal(resValidBody.statusCode, 200);
    assert.equal(resValidBody.body.result.status, 'healthy');

    // 6. Valid token in Authorization Bearer header
    const resValidHeader = await makeRpcRequest(daemon.address, basePayload, {
        token: daemon.token,
    });
    assert.equal(resValidHeader.statusCode, 200);
    assert.equal(resValidHeader.body.result.status, 'healthy');
});

// --------------------------------------------------------------------------
// 4. Workspace mismatch
// --------------------------------------------------------------------------
test('rejects cross-workspace requests even with valid bearer token', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });
    t.after(() => daemon.close());

    const res = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: 'ws-different-workspace-id',
        token: daemon.token,
        method: 'health',
    });

    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error.code, 'DUAL_WORKSPACE_MISMATCH');
});

// --------------------------------------------------------------------------
// 5. Request size limit & content-type & method handling
// --------------------------------------------------------------------------
test('enforces 64 KiB max request size limit, POST only, and application/json content-type', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });
    t.after(() => daemon.close());

    // 1. Oversized payload (> 64 KiB)
    const largePad = 'x'.repeat(70 * 1024);
    const resOversize = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'health',
        padding: largePad,
    });
    assert.equal(resOversize.statusCode, 413);
    assert.equal(resOversize.body.error.code, 'DUAL_REQUEST_TOO_LARGE');

    // 2. Non-POST method (GET)
    const resGet = await makeRpcRequest(daemon.address, '', { method: 'GET' });
    assert.equal(resGet.statusCode, 405);
    assert.equal(resGet.body.error.code, 'DUAL_METHOD_NOT_ALLOWED');

    // 3. Invalid Content-Type
    const resBadContentType = await makeRpcRequest(daemon.address, JSON.stringify({
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'health',
    }), { contentType: 'text/plain' });
    assert.equal(resBadContentType.statusCode, 415);
    assert.equal(resBadContentType.body.error.code, 'DUAL_CONTENT_TYPE_INVALID');
});

// --------------------------------------------------------------------------
// 6. Malformed JSON & Method not found & Protocol version invalid
// --------------------------------------------------------------------------
test('rejects malformed JSON, unknown methods, and protocol version mismatches', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });
    t.after(() => daemon.close());

    // 1. Malformed JSON
    const resBadJson = await makeRpcRequest(daemon.address, '{"broken json: true', {
        contentType: 'application/json',
    });
    assert.equal(resBadJson.statusCode, 400);
    assert.equal(resBadJson.body.error.code, 'DUAL_MALFORMED_JSON');

    // 2. Unknown RPC method
    const resBadMethod = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'unknown.method.name',
    });
    assert.equal(resBadMethod.statusCode, 404);
    assert.equal(resBadMethod.body.error.code, 'DUAL_METHOD_NOT_FOUND');

    // 3. Invalid protocol version
    const resBadProto = await makeRpcRequest(daemon.address, {
        protocol_version: 99,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'health',
    });
    assert.equal(resBadProto.statusCode, 400);
    assert.equal(resBadProto.body.error.code, 'DUAL_PROTOCOL_VERSION_INVALID');
});

// --------------------------------------------------------------------------
// 7. Discovery file & No token leakage in results or errors
// --------------------------------------------------------------------------
test('writes atomic discovery file and never echoes token in health, status, or error messages', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });
    t.after(() => daemon.close());

    const runtimeDir = getRuntimeDir(wsRoot);
    const discoveryPath = path.join(runtimeDir, 'daemon.json');
    const lockPath = path.join(runtimeDir, 'daemon.lock');

    assert.ok(fs.existsSync(discoveryPath), 'Discovery file exists');
    assert.ok(fs.existsSync(lockPath), 'Lock file exists');

    const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
    assert.equal(discovery.protocol_version, 1);
    assert.equal(discovery.workspace_id, daemon.workspaceId);
    assert.equal(discovery.workspace_root, wsRoot);
    assert.equal(discovery.host, '127.0.0.1');
    assert.equal(discovery.port, daemon.address.port);
    assert.equal(discovery.token, daemon.token);

    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(lock.protocol_version, 1);
    assert.equal(lock.workspace_id, daemon.workspaceId);
    assert.equal(lock.token, undefined, 'Lock file must NEVER contain bearer token');

    // Call health: ensure no token in response
    const resHealth = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'health',
    });
    assert.equal(resHealth.statusCode, 200);
    assert.equal(resHealth.body.result.token, undefined);
    assert.equal(JSON.stringify(resHealth.body).includes(daemon.token), false);

    // Call session.status: ensure no token in response
    const resStatus = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'session.status',
    });
    assert.equal(resStatus.statusCode, 200);
    assert.equal(JSON.stringify(resStatus.body).includes(daemon.token), false);
});

// --------------------------------------------------------------------------
// 8. Single instance and live lock refusal
// --------------------------------------------------------------------------
test('single instance enforces lock and rejects second daemon instance with DUAL_DAEMON_ACTIVE', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore1 = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess-1'));
    const authorityStore2 = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess-2'));

    const daemon1 = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore: authorityStore1,
    });
    t.after(() => daemon1.close());

    // Attempt starting a second daemon in the exact same workspace
    await assert.rejects(
        () => startDaemonServer({
            workspaceRoot: wsRoot,
            authorityStore: authorityStore2,
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_DAEMON_ACTIVE');
            return true;
        }
    );
});

// --------------------------------------------------------------------------
// 9. Lock liveness, unverified PID refusal, and stale PID reclaim
// --------------------------------------------------------------------------
test('acquireDaemonLock refuses live lock when health probe succeeds', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const runtimeDir = getRuntimeDir(wsRoot);
    const workspaceId = computeWorkspaceId(wsRoot);

    const handle1 = await acquireDaemonLock({
        runtimeDir,
        workspaceId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
    });
    t.after(() => handle1.release());

    // Contender probe succeeds
    await assert.rejects(
        () => acquireDaemonLock({
            runtimeDir,
            workspaceId,
            pid: process.pid + 1,
            startedAt: new Date().toISOString(),
            healthProbe: async () => true, // live and healthy
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_DAEMON_ACTIVE');
            return true;
        }
    );
});

test('acquireDaemonLock fails closed when health probe fails but PID is alive and unverifiable', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const runtimeDir = getRuntimeDir(wsRoot);
    const workspaceId = computeWorkspaceId(wsRoot);

    const handle1 = await acquireDaemonLock({
        runtimeDir,
        workspaceId,
        pid: process.pid, // current PID is definitely alive
        startedAt: new Date().toISOString(),
    });
    t.after(() => handle1.release());

    // Contender probe fails health, but isProcessAlive returns true and identity cannot be disproved
    await assert.rejects(
        () => acquireDaemonLock({
            runtimeDir,
            workspaceId,
            pid: process.pid + 1,
            startedAt: new Date().toISOString(),
            healthProbe: async () => false, // probe failed
            isProcessAlive: () => true, // PID alive
            processIdentityMatches: () => true, // identity matches or unverifiable
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_DAEMON_ACTIVE');
            return true;
        }
    );
});

test('acquireDaemonLock reclaims stale lock when health probe fails AND PID is dead or identity mismatch', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const runtimeDir = getRuntimeDir(wsRoot);
    const workspaceId = computeWorkspaceId(wsRoot);

    // Create a stale lock on disk
    fs.mkdirSync(runtimeDir, { recursive: true });
    const staleLockPath = path.join(runtimeDir, 'daemon.lock');
    fs.writeFileSync(staleLockPath, JSON.stringify({
        protocol_version: 1,
        workspace_id: workspaceId,
        pid: 9999999, // non-existent PID
        started_at: '2026-08-24T00:00:00.000Z',
        endpoint: { host: '127.0.0.1', port: 12345 },
    }), 'utf8');

    const handle = await acquireDaemonLock({
        runtimeDir,
        workspaceId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        healthProbe: async () => false, // health probe fails
        isProcessAlive: () => false, // PID is dead
    });
    t.after(() => handle.release());

    assert.ok(handle, 'Successfully reclaimed stale lock');
    const lockContent = JSON.parse(fs.readFileSync(staleLockPath, 'utf8'));
    assert.equal(lockContent.pid, process.pid);
});

test('acquireDaemonLock fails closed on corrupt lock or workspace mismatch without silent deletion', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const runtimeDir = getRuntimeDir(wsRoot);
    const workspaceId = computeWorkspaceId(wsRoot);

    fs.mkdirSync(runtimeDir, { recursive: true });
    const lockPath = path.join(runtimeDir, 'daemon.lock');

    // 1. Corrupt lock
    fs.writeFileSync(lockPath, '{"broken-json', 'utf8');
    await assert.rejects(
        () => acquireDaemonLock({
            runtimeDir,
            workspaceId,
            pid: process.pid,
            startedAt: new Date().toISOString(),
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_LOCK_CORRUPT');
            return true;
        }
    );
    assert.ok(fs.existsSync(lockPath), 'Corrupt lock file was not silently deleted');

    // 2. Workspace mismatch
    fs.writeFileSync(lockPath, JSON.stringify({
        protocol_version: 1,
        workspace_id: 'ws-mismatched-other-workspace',
        pid: process.pid,
        started_at: new Date().toISOString(),
    }), 'utf8');

    await assert.rejects(
        () => acquireDaemonLock({
            runtimeDir,
            workspaceId,
            pid: process.pid,
            startedAt: new Date().toISOString(),
        }),
        (err) => {
            assert.equal(err.code, 'DUAL_LOCK_WORKSPACE_MISMATCH');
            return true;
        }
    );
    assert.ok(fs.existsSync(lockPath), 'Mismatched lock file was not silently deleted');
});

test('lock release only deletes its own lock on disk and refuses foreign lock unlinking', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const runtimeDir = getRuntimeDir(wsRoot);
    const workspaceId = computeWorkspaceId(wsRoot);

    const handle = await acquireDaemonLock({
        runtimeDir,
        workspaceId,
        pid: process.pid,
        startedAt: '2026-08-25T00:00:00.000Z',
    });

    const lockPath = path.join(runtimeDir, 'daemon.lock');
    assert.ok(fs.existsSync(lockPath));

    // Overwrite lock with another process's info
    fs.writeFileSync(lockPath, JSON.stringify({
        protocol_version: 1,
        workspace_id: workspaceId,
        pid: process.pid + 999, // foreign PID
        started_at: '2026-08-25T01:00:00.000Z',
    }), 'utf8');

    // Releasing the original handle must NOT remove the foreign lock
    await assert.rejects(
        () => handle.release(),
        (err) => {
            assert.equal(err.code, 'DUAL_LOCK_RELEASE_MISMATCH');
            return true;
        }
    );
    assert.ok(fs.existsSync(lockPath), 'Foreign lock remains intact on disk');
});

// --------------------------------------------------------------------------
// 10. session.begin - first begin, idempotency, and conflict
// --------------------------------------------------------------------------
test('session.begin handles initialization, idempotent retry, and conflict rejection', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });
    t.after(() => daemon.close());

    const beginParams = {
        session_id: 'sess-001',
        workspace_root: wsRoot,
        mode: 'auto',
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
    };

    // 1. First begin: creates session
    const res1 = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'session.begin',
        params: beginParams,
    });
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.body.result.session_id, 'sess-001');
    assert.equal(res1.body.result.state, 'DISCOVERED');

    // 2. Idempotent second begin with exact matching parameters
    const res2 = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'session.begin',
        params: beginParams,
    });
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.body.result.session_id, 'sess-001');

    // 3. Conflicting second begin (different session_id)
    const resConflictId = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'session.begin',
        params: {
            ...beginParams,
            session_id: 'sess-conflicting-different-id',
        },
    });
    assert.equal(resConflictId.statusCode, 409);
    assert.equal(resConflictId.body.error.code, 'DUAL_SESSION_CONFLICT');

    // 4. Conflicting second begin (different baseline)
    const resConflictBaseline = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'session.begin',
        params: {
            ...beginParams,
            expected_baseline: { kind: 'git', id: 'b'.repeat(40) },
        },
    });
    assert.equal(resConflictBaseline.statusCode, 409);
    assert.equal(resConflictBaseline.body.error.code, 'DUAL_SESSION_CONFLICT');
});

// --------------------------------------------------------------------------
// 11. Corrupt authority store handling
// --------------------------------------------------------------------------
test('health and status return blocking integrity error when authority store is corrupted', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const sessionDir = path.join(wsRoot, '.omni', 'sessions', 'test-sess');
    const authorityStore = createAuthorityStore(sessionDir);

    // Initialize session
    authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000001',
        causation_id: '10000000-0000-4000-8000-000000000001',
        sequence: 1,
        workspace_id: computeWorkspaceId(wsRoot),
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: '2026-08-25T00:00:00.000Z',
        type: 'session.created',
        state: 'DISCOVERED',
        workspace_root: wsRoot,
        mode: 'auto',
    });

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });
    t.after(() => daemon.close());

    // Corrupt the events.ndjson file directly
    const eventsPath = path.join(sessionDir, 'events.ndjson');
    fs.appendFileSync(eventsPath, '{"broken json line\n', 'utf8');

    // health must fail closed with error, never healthy
    const resHealth = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'health',
    });
    assert.equal(resHealth.statusCode, 500);
    assert.equal(resHealth.body.error.code, 'DUAL_INTEGRITY_CORRUPT');

    // session.status must also fail closed
    const resStatus = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'session.status',
        params: { session_id: 'sess-001' },
    });
    assert.equal(resStatus.statusCode, 500);
    assert.equal(resStatus.body.error.code, 'DUAL_INTEGRITY_CORRUPT');
});

// --------------------------------------------------------------------------
// 12. hook.evaluate - scope, owner, lease, read-only enforcement
// --------------------------------------------------------------------------
test('hook.evaluate enforces fail-closed decisions based on ledger state', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const sessionDir = path.join(wsRoot, '.omni', 'sessions', 'test-sess');
    const clock = createFakeClock();
    const authorityStore = createAuthorityStore(sessionDir, { clock });

    const wsId = computeWorkspaceId(wsRoot);
    const e1 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000001',
        causation_id: '10000000-0000-4000-8000-000000000001',
        sequence: 1,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: clock.iso(),
        type: 'session.created',
        state: 'DISCOVERED',
        workspace_root: wsRoot,
        mode: 'auto',
    });
    const e2 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000002',
        causation_id: e1.event_id,
        sequence: 2,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: clock.iso(),
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'hooks', status: 'PASSED' }],
    });
    const e3 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000003',
        causation_id: e2.event_id,
        sequence: 3,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: clock.iso(),
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plans/plan.md',
        plan_sha256: 'c'.repeat(64),
        total_tasks: 2,
        tasks: [
            { task_id: 'TASK-1', title: 'Agy task', owner: 'agy', allowed_files: ['lib/a.js'] },
            { task_id: 'TASK-2', title: 'Codex task', owner: 'codex', allowed_files: ['lib/b.js'] },
        ],
    });
    const e4 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000004',
        causation_id: e3.event_id,
        sequence: 4,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: clock.iso(),
        type: 'task.routed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'ROUTED',
        allowed_files: ['lib/a.js'],
        reason: 'bounded Agy task',
    });

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
        clock,
    });
    t.after(() => daemon.close());

    // 1. Read-only operation is explicitly allowed
    const resReadOnly = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            tool_name: 'view_file',
            operation: 'read',
        },
    });
    assert.equal(resReadOnly.statusCode, 200);
    assert.equal(resReadOnly.body.result.decision, 'allow');

    // 2. Non-mutating hook event (SessionStart, UserPromptSubmit, PostToolUse) allowed
    const resStart = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'SessionStart',
        },
    });
    assert.equal(resStart.statusCode, 200);
    assert.equal(resStart.body.result.decision, 'allow');

    // 3. Write attempt for unrouted task -> deny
    const resUnrouted = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'write',
            tool_name: 'apply_patch',
            task_id: 'TASK-2', // not routed yet
            owner: 'codex',
            file_path: 'lib/b.js',
        },
    });
    assert.equal(resUnrouted.statusCode, 200);
    assert.equal(resUnrouted.body.result.decision, 'deny');
    assert.ok(resUnrouted.body.result.reason.includes('not routed'));

    // 4. Write attempt for routed task without lease -> deny
    const resNoLease = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'write',
            tool_name: 'apply_patch',
            task_id: 'TASK-1',
            owner: 'agy',
            file_path: 'lib/a.js',
        },
    });
    assert.equal(resNoLease.statusCode, 200);
    assert.equal(resNoLease.body.result.decision, 'deny');
    assert.ok(resNoLease.body.result.reason.includes('no active lease'));

    // Acquire lease for TASK-1 by agy
    const lease = authorityStore.acquireLease('TASK-1', 'agy');

    // 5. Codex write attempt during AGY_OWNED task -> deny
    const resCodexMutateAgy = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'write',
            tool_name: 'apply_patch',
            task_id: 'TASK-1',
            owner: 'codex',
            file_path: 'lib/a.js',
        },
    });
    assert.equal(resCodexMutateAgy.statusCode, 200);
    assert.equal(resCodexMutateAgy.body.result.decision, 'deny');
    assert.ok(resCodexMutateAgy.body.result.reason.includes('AGY_OWNED') || resCodexMutateAgy.body.result.reason.includes('owner mismatch'));

    // 6. Agy write attempt to file outside allowed scope -> deny
    const resOutOfScope = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'write',
            tool_name: 'apply_patch',
            task_id: 'TASK-1',
            owner: 'agy',
            file_path: 'lib/unauthorized.js',
        },
    });
    assert.equal(resOutOfScope.statusCode, 200);
    assert.equal(resOutOfScope.body.result.decision, 'deny');
    assert.ok(resOutOfScope.body.result.reason.includes('scope'));

    // 7. Agy write attempt with active lease and allowed file -> allow
    const resAllowed = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'write',
            tool_name: 'apply_patch',
            task_id: 'TASK-1',
            owner: 'agy',
            file_path: 'lib/a.js',
        },
    });
    assert.equal(resAllowed.statusCode, 200);
    assert.equal(resAllowed.body.result.decision, 'allow');
});

// --------------------------------------------------------------------------
// 13. completion.evaluate - fail closed & verification criteria
// --------------------------------------------------------------------------
test('completion.evaluate returns verified: false with blockers until full criteria are durably met', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const baselineId = initGitWorkspace(wsRoot);
    const sessionDir = path.join(wsRoot, '.omni', 'sessions', 'test-sess');
    const clock = createFakeClock();
    const authorityStore = createAuthorityStore(sessionDir, { clock });

    const wsId = computeWorkspaceId(wsRoot);
    const e1 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000001',
        causation_id: '10000000-0000-4000-8000-000000000001',
        sequence: 1,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: baselineId },
        timestamp: clock.iso(),
        type: 'session.created',
        state: 'DISCOVERED',
        workspace_root: wsRoot,
        mode: 'auto',
    });

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
        clock,
    });
    t.after(() => daemon.close());

    // 1. DISCOVERED state -> not verified
    const res1 = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'completion.evaluate',
        params: { session_id: 'sess-001' },
    });
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.body.result.verified, false);
    assert.ok(res1.body.result.blockers.length > 0);

    // Advance session to acceptance and verified
    const e2 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000002',
        causation_id: e1.event_id,
        sequence: 2,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: baselineId },
        timestamp: clock.iso(),
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'hooks', status: 'PASSED' }],
    });
    const e3 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000003',
        causation_id: e2.event_id,
        sequence: 3,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: baselineId },
        timestamp: clock.iso(),
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plans/plan.md',
        plan_sha256: 'c'.repeat(64),
        total_tasks: 1,
        tasks: [
            { task_id: 'TASK-1', title: 'Task 1', owner: 'agy', allowed_files: ['lib/a.js'] },
        ],
    });
    const e4 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000004',
        causation_id: e3.event_id,
        sequence: 4,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: baselineId },
        timestamp: clock.iso(),
        type: 'task.routed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'ROUTED',
        allowed_files: ['lib/a.js'],
        reason: 'routed',
    });
    const lease = authorityStore.acquireLease('TASK-1', 'agy');
    const e5 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000006',
        causation_id: authorityStore.derive().lastEventId,
        sequence: 6,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: baselineId },
        timestamp: clock.iso(),
        type: 'task.completed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['lib/a.js'],
        diff_fingerprint: 'd'.repeat(64),
        verdict: 'SUCCESS',
        verified_by: 'codex',
    });
    authorityStore.releaseLease(lease.lease_id, 'task finished');
    const e6 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000008',
        causation_id: authorityStore.derive().lastEventId,
        sequence: 8,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: baselineId },
        timestamp: clock.iso(),
        type: 'session.verified',
        from_state: 'ACCEPTANCE',
        to_state: 'VERIFIED',
        receipt_sha256: 'e'.repeat(64),
        completed_tasks: ['TASK-1'],
    });

    // 2. Full verified criteria met -> verified: true
    const resVerified = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'completion.evaluate',
        params: { session_id: 'sess-001' },
    });
    assert.equal(resVerified.statusCode, 200);
    assert.equal(resVerified.body.result.verified, true);
    assert.deepEqual(resVerified.body.result.blockers, []);
    assert.ok(resVerified.body.result.receipt);
});

// --------------------------------------------------------------------------
// 14. daemon.stop
// --------------------------------------------------------------------------
test('daemon.stop shuts down the server and cleans discovery and lock files', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });

    const runtimeDir = getRuntimeDir(wsRoot);
    const discoveryPath = path.join(runtimeDir, 'daemon.json');
    const lockPath = path.join(runtimeDir, 'daemon.lock');

    assert.ok(fs.existsSync(discoveryPath));
    assert.ok(fs.existsSync(lockPath));

    const resStop = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'daemon.stop',
    });
    assert.equal(resStop.statusCode, 200);
    assert.equal(resStop.body.result.success, true);

    await daemon.stopped;

    assert.equal(fs.existsSync(discoveryPath), false, 'Discovery file unlinked on stop');
    assert.equal(fs.existsSync(lockPath), false, 'Lock file unlinked on stop');
});

// --------------------------------------------------------------------------
// 15. Idle shutdown without active lease & postponement with active lease
// --------------------------------------------------------------------------
test('idle timeout shuts down daemon without active lease, but postpones shutdown when lease is active', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const sessionDir = path.join(wsRoot, '.omni', 'sessions', 'test-sess');
    const clock = createFakeClock();
    const authorityStore = createAuthorityStore(sessionDir, { clock });

    const wsId = computeWorkspaceId(wsRoot);
    const e1 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000001',
        causation_id: '10000000-0000-4000-8000-000000000001',
        sequence: 1,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: clock.iso(),
        type: 'session.created',
        state: 'DISCOVERED',
        workspace_root: wsRoot,
        mode: 'auto',
    });
    const e2 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000002',
        causation_id: e1.event_id,
        sequence: 2,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: clock.iso(),
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'hooks', status: 'PASSED' }],
    });
    const e3 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000003',
        causation_id: e2.event_id,
        sequence: 3,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: clock.iso(),
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plans/plan.md',
        plan_sha256: 'c'.repeat(64),
        total_tasks: 1,
        tasks: [
            { task_id: 'TASK-1', title: 'Task 1', owner: 'agy', allowed_files: ['lib/a.js'] },
        ],
    });
    authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000004',
        causation_id: e3.event_id,
        sequence: 4,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: clock.iso(),
        type: 'task.routed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'ROUTED',
        allowed_files: ['lib/a.js'],
        reason: 'routed',
    });

    // 1. With active lease: idle timer does not stop daemon
    const lease = authorityStore.acquireLease('TASK-1', 'agy');
    const daemonWithLease = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
        clock,
        idleTimeoutMs: 60,
    });
    t.after(() => daemonWithLease.close());

    // Wait a bit to ensure it stays up while lease is active
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(daemonWithLease.isStopped, false, 'Daemon remains running when lease is active');

    // Release lease
    authorityStore.releaseLease(lease.lease_id, 'done');
    await daemonWithLease.close();

    // 2. Without active lease: idle timer triggers shutdown
    const wsRootIdle = createTempWorkspace(t);
    const authStoreIdle = createAuthorityStore(path.join(wsRootIdle, '.omni', 'sessions', 'test-sess'));
    const daemonIdle = await startDaemonServer({
        workspaceRoot: wsRootIdle,
        authorityStore,
        idleTimeoutMs: 60,
    });

    // Await stopped promise
    await daemonIdle.stopped;
    assert.equal(daemonIdle.isStopped, true, 'Daemon shut down after idle timeout');
});

// --------------------------------------------------------------------------
// 16. Codex Security Review Finding 1: session.begin workspace root authoritative
// --------------------------------------------------------------------------
test('Fix 1: session.begin requires authoritative workspace_root matching canonical server root and returns 403 on mismatch', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });
    t.after(() => daemon.close());

    // 1. Missing workspace_root -> 403 DUAL_WORKSPACE_MISMATCH and appends nothing
    const resNoRoot = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'session.begin',
        params: {
            session_id: 'sess-001',
            mode: 'auto',
            expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        },
    });
    assert.equal(resNoRoot.statusCode, 403);
    assert.equal(resNoRoot.body.error.code, 'DUAL_WORKSPACE_MISMATCH');
    assert.equal(authorityStore.derive().sessionId, null, 'Nothing appended on missing workspace_root');

    // 2. Relative '.' when process.cwd() is not wsRoot -> 403 DUAL_WORKSPACE_MISMATCH
    const resDot = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'session.begin',
        params: {
            session_id: 'sess-001',
            workspace_root: '.',
            mode: 'auto',
            expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        },
    });
    assert.equal(resDot.statusCode, 403);
    assert.equal(resDot.body.error.code, 'DUAL_WORKSPACE_MISMATCH');
    assert.equal(authorityStore.derive().sessionId, null, 'Nothing appended on relative dot workspace_root');

    // 3. Arbitrary foreign root -> 403 DUAL_WORKSPACE_MISMATCH
    const resForeign = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'session.begin',
        params: {
            session_id: 'sess-001',
            workspace_root: path.join(wsRoot, 'non-canonical-foreign-dir'),
            mode: 'auto',
            expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        },
    });
    assert.equal(resForeign.statusCode, 403);
    assert.equal(resForeign.body.error.code, 'DUAL_WORKSPACE_MISMATCH');
    assert.equal(authorityStore.derive().sessionId, null, 'Nothing appended on foreign workspace_root');

    // 4. Exact canonical workspace root -> 200 and stores canonical root
    const resValid = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'session.begin',
        params: {
            session_id: 'sess-001',
            workspace_root: wsRoot,
            mode: 'auto',
            expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        },
    });
    assert.equal(resValid.statusCode, 200);
    assert.equal(resValid.body.result.workspace_root, wsRoot);
    const derived = authorityStore.derive();
    assert.equal(derived.sessionId, 'sess-001');
    assert.equal(derived.workspaceRoot, wsRoot);
});

// --------------------------------------------------------------------------
// 17. Codex Security Review Finding 2: session_id required once session exists
// --------------------------------------------------------------------------
test('Fix 2: requires session_id for session.status, hook.evaluate, and completion.evaluate once session exists', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });
    t.after(() => daemon.close());

    // Before session initialized: session.status succeeds without session_id
    const resStatusBefore = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'session.status',
    });
    assert.equal(resStatusBefore.statusCode, 200);
    assert.equal(resStatusBefore.body.result.session_id, null);

    // Initialize session
    const resBegin = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'session.begin',
        params: {
            session_id: 'sess-active-001',
            workspace_root: wsRoot,
            mode: 'auto',
            expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        },
    });
    assert.equal(resBegin.statusCode, 200);

    // 1. session.status missing session_id -> 400 DUAL_SESSION_REQUIRED
    const resStatusNoId = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'session.status',
    });
    assert.equal(resStatusNoId.statusCode, 400);
    assert.equal(resStatusNoId.body.error.code, 'DUAL_SESSION_REQUIRED');

    // 2. session.status mismatched session_id -> 403 DUAL_SESSION_MISMATCH
    const resStatusWrongId = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'session.status',
        params: { session_id: 'sess-wrong-id' },
    });
    assert.equal(resStatusWrongId.statusCode, 403);
    assert.equal(resStatusWrongId.body.error.code, 'DUAL_SESSION_MISMATCH');

    // 3. session.status matching session_id -> 200
    const resStatusOk = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'session.status',
        params: { session_id: 'sess-active-001' },
    });
    assert.equal(resStatusOk.statusCode, 200);

    // 4. hook.evaluate missing session_id -> 400 DUAL_SESSION_REQUIRED
    const resHookNoId = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: { hook_event_name: 'PreToolUse', operation: 'read' },
    });
    assert.equal(resHookNoId.statusCode, 400);
    assert.equal(resHookNoId.body.error.code, 'DUAL_SESSION_REQUIRED');

    // 5. hook.evaluate mismatched session_id -> 403 DUAL_SESSION_MISMATCH
    const resHookWrongId = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: { session_id: 'sess-wrong-id', hook_event_name: 'PreToolUse', operation: 'read' },
    });
    assert.equal(resHookWrongId.statusCode, 403);
    assert.equal(resHookWrongId.body.error.code, 'DUAL_SESSION_MISMATCH');

    // 6. completion.evaluate missing session_id -> 400 DUAL_SESSION_REQUIRED
    const resCompNoId = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'completion.evaluate',
    });
    assert.equal(resCompNoId.statusCode, 400);
    assert.equal(resCompNoId.body.error.code, 'DUAL_SESSION_REQUIRED');

    // 7. completion.evaluate mismatched session_id -> 403 DUAL_SESSION_MISMATCH
    const resCompWrongId = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'completion.evaluate',
        params: { session_id: 'sess-wrong-id' },
    });
    assert.equal(resCompWrongId.statusCode, 403);
    assert.equal(resCompWrongId.body.error.code, 'DUAL_SESSION_MISMATCH');

    // 8. health remains exempt from session_id requirement
    const resHealth = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'health',
    });
    assert.equal(resHealth.statusCode, 200);
});

// --------------------------------------------------------------------------
// 18. Codex Security Review Finding 3: Hook fail-closed, operation enum, and strict path validation
// --------------------------------------------------------------------------
test('Fix 3: hook.evaluate fail-closed operation enum, write allowlist, execute declared_paths, and path security', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const sessionDir = path.join(wsRoot, '.omni', 'sessions', 'test-sess');
    const clock = createFakeClock();
    const authorityStore = createAuthorityStore(sessionDir, { clock });
    const wsId = computeWorkspaceId(wsRoot);

    const e1 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000001',
        causation_id: '10000000-0000-4000-8000-000000000001',
        sequence: 1,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: clock.iso(),
        type: 'session.created',
        state: 'DISCOVERED',
        workspace_root: wsRoot,
        mode: 'auto',
    });
    const e2 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000002',
        causation_id: e1.event_id,
        sequence: 2,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: clock.iso(),
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'hooks', status: 'PASSED' }],
    });
    const e3 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000003',
        causation_id: e2.event_id,
        sequence: 3,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: clock.iso(),
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plans/plan.md',
        plan_sha256: 'c'.repeat(64),
        total_tasks: 1,
        tasks: [
            { task_id: 'TASK-1', title: 'Task 1', owner: 'agy', allowed_files: ['lib/a.js'] },
        ],
    });
    authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000004',
        causation_id: e3.event_id,
        sequence: 4,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) },
        timestamp: clock.iso(),
        type: 'task.routed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'ROUTED',
        allowed_files: ['lib/a.js'],
        reason: 'routed',
    });
    const lease = authorityStore.acquireLease('TASK-1', 'agy');

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
        clock,
    });
    t.after(() => daemon.close());

    // 1. Generic read_only: true with mutating operation ('write') does NOT bypass -> must evaluate task/file/lease
    const resFakeReadOnly = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'write',
            read_only: true, // caller attempts spoofing read_only
            task_id: 'TASK-1',
            owner: 'agy',
            file_path: 'lib/unauthorized.js', // outside scope
        },
    });
    assert.equal(resFakeReadOnly.statusCode, 200);
    assert.equal(resFakeReadOnly.body.result.decision, 'deny', 'Spoofed read_only boolean on write must NOT bypass scope');

    // 2. Generic read_only: true with missing or unknown operation -> denies
    const resNoOpReadOnly = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            read_only: true,
        },
    });
    assert.equal(resNoOpReadOnly.statusCode, 200);
    assert.equal(resNoOpReadOnly.body.result.decision, 'deny');

    // 3. operation: 'unknown' -> denies
    const resUnknownOp = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'unknown',
        },
    });
    assert.equal(resUnknownOp.statusCode, 200);
    assert.equal(resUnknownOp.body.result.decision, 'deny');

    // 4. operation: 'read' -> allows
    const resRead = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'read',
            tool_name: 'view_file',
        },
    });
    assert.equal(resRead.statusCode, 200);
    assert.equal(resRead.body.result.decision, 'allow');

    // 5. write operation missing file_path -> denies
    const resWriteNoPath = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'write',
            task_id: 'TASK-1',
            owner: 'agy',
        },
    });
    assert.equal(resWriteNoPath.statusCode, 200);
    assert.equal(resWriteNoPath.body.result.decision, 'deny');

    // 6. write operation with absolute path -> denies
    const resWriteAbs = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'write',
            task_id: 'TASK-1',
            owner: 'agy',
            file_path: '/etc/passwd',
        },
    });
    assert.equal(resWriteAbs.statusCode, 200);
    assert.equal(resWriteAbs.body.result.decision, 'deny');

    // 7. write operation with path traversal -> denies
    const resWriteTraversal = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'write',
            task_id: 'TASK-1',
            owner: 'agy',
            file_path: '../secret.txt',
        },
    });
    assert.equal(resWriteTraversal.statusCode, 200);
    assert.equal(resWriteTraversal.body.result.decision, 'deny');

    // 8. write operation with NUL byte -> denies
    const resWriteNul = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'write',
            task_id: 'TASK-1',
            owner: 'agy',
            file_path: 'lib/a.js\0.txt',
        },
    });
    assert.equal(resWriteNul.statusCode, 200);
    assert.equal(resWriteNul.body.result.decision, 'deny');

    // 9. write operation with valid allowlisted path -> allows
    const resWriteOk = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'write',
            task_id: 'TASK-1',
            owner: 'agy',
            file_path: 'lib/a.js',
        },
    });
    assert.equal(resWriteOk.statusCode, 200);
    assert.equal(resWriteOk.body.result.decision, 'allow');

    // 10. execute operation without declared_paths -> denies
    const resExecNoPaths = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'execute',
            task_id: 'TASK-1',
            owner: 'agy',
            command: 'node --test',
        },
    });
    assert.equal(resExecNoPaths.statusCode, 200);
    assert.equal(resExecNoPaths.body.result.decision, 'deny');

    // 11. execute operation with empty declared_paths -> denies
    const resExecEmptyPaths = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'execute',
            task_id: 'TASK-1',
            owner: 'agy',
            declared_paths: [],
        },
    });
    assert.equal(resExecEmptyPaths.statusCode, 200);
    assert.equal(resExecEmptyPaths.body.result.decision, 'deny');

    // 12. execute operation with non-allowlisted declared path -> denies
    const resExecUnauth = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'execute',
            task_id: 'TASK-1',
            owner: 'agy',
            declared_paths: ['lib/unauthorized.js'],
        },
    });
    assert.equal(resExecUnauth.statusCode, 200);
    assert.equal(resExecUnauth.body.result.decision, 'deny');

    // 13. execute operation with allowlisted declared_paths -> allows
    const resExecOk = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'hook.evaluate',
        params: {
            session_id: 'sess-001',
            hook_event_name: 'PreToolUse',
            operation: 'execute',
            task_id: 'TASK-1',
            owner: 'agy',
            declared_paths: ['lib/a.js'],
        },
    });
    assert.equal(resExecOk.statusCode, 200);
    assert.equal(resExecOk.body.result.decision, 'allow');
});

// --------------------------------------------------------------------------
// 19. Codex Security Review Finding 4: completion.evaluate blocker for expired unreleased lease
// --------------------------------------------------------------------------
test('Fix 4: completion.evaluate adds EXPIRED_UNRELEASED_LEASE blocker for expired unreleased lease', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const baselineId = initGitWorkspace(wsRoot);
    const sessionDir = path.join(wsRoot, '.omni', 'sessions', 'test-sess');
    const clock = createFakeClock();
    const authorityStore = createAuthorityStore(sessionDir, { clock });
    const wsId = computeWorkspaceId(wsRoot);

    const e1 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000001',
        causation_id: '10000000-0000-4000-8000-000000000001',
        sequence: 1,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: baselineId },
        timestamp: clock.iso(),
        type: 'session.created',
        state: 'DISCOVERED',
        workspace_root: wsRoot,
        mode: 'auto',
    });
    const e2 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000002',
        causation_id: e1.event_id,
        sequence: 2,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: baselineId },
        timestamp: clock.iso(),
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'hooks', status: 'PASSED' }],
    });
    const e3 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000003',
        causation_id: e2.event_id,
        sequence: 3,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: baselineId },
        timestamp: clock.iso(),
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plans/plan.md',
        plan_sha256: 'c'.repeat(64),
        total_tasks: 1,
        tasks: [
            { task_id: 'TASK-1', title: 'Task 1', owner: 'agy', allowed_files: ['lib/a.js'] },
        ],
    });
    const e4 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000004',
        causation_id: e3.event_id,
        sequence: 4,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: baselineId },
        timestamp: clock.iso(),
        type: 'task.routed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'ROUTED',
        allowed_files: ['lib/a.js'],
        reason: 'routed',
    });
    const lease = authorityStore.acquireLease('TASK-1', 'agy');
    const e5 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000006',
        causation_id: authorityStore.derive().lastEventId,
        sequence: 6,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: baselineId },
        timestamp: clock.iso(),
        type: 'task.completed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['lib/a.js'],
        diff_fingerprint: 'd'.repeat(64),
        verdict: 'SUCCESS',
        verified_by: 'codex',
    });
    // Session is verified but lease is NOT released
    const e6 = authorityStore.append({
        schema_version: 2,
        event_id: '10000000-0000-4000-8000-000000000007',
        causation_id: e5.event_id,
        sequence: 7,
        workspace_id: wsId,
        session_id: 'sess-001',
        plan_revision: 1,
        expected_baseline: { kind: 'git', id: baselineId },
        timestamp: clock.iso(),
        type: 'session.verified',
        from_state: 'ACCEPTANCE',
        to_state: 'VERIFIED',
        receipt_sha256: 'e'.repeat(64),
        completed_tasks: ['TASK-1'],
    });

    // Advance clock past lease TTL (ttl is 300_000 ms) so lease expires without release
    clock.advance(350_000);

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
        clock,
    });
    t.after(() => daemon.close());

    // 1. completion.evaluate must report EXPIRED_UNRELEASED_LEASE
    const resExpired = await makeRpcRequest(daemon.address, {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        token: daemon.token,
        method: 'completion.evaluate',
        params: { session_id: 'sess-001' },
    });
    assert.equal(resExpired.statusCode, 200);
    assert.equal(resExpired.body.result.verified, false);
    const hasExpiredBlocker = resExpired.body.result.blockers.some((b) => b.includes('EXPIRED_UNRELEASED_LEASE'));
    assert.ok(hasExpiredBlocker, `Blockers should include EXPIRED_UNRELEASED_LEASE: ${JSON.stringify(resExpired.body.result.blockers)}`);
});

// --------------------------------------------------------------------------
// 20. Codex Security Review Finding 5: Lock attachEndpoint verification and strict validator
// --------------------------------------------------------------------------
test('Fix 5: attachEndpoint verifies on-disk ownership with strict validator and refuses corrupt/foreign lock', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const runtimeDir = getRuntimeDir(wsRoot);
    const workspaceId = computeWorkspaceId(wsRoot);

    const handle = await acquireDaemonLock({
        runtimeDir,
        workspaceId,
        pid: process.pid,
        startedAt: '2026-08-25T00:00:00.000Z',
    });

    const lockPath = path.join(runtimeDir, 'daemon.lock');
    assert.ok(fs.existsSync(lockPath));

    // Overwrite lock with foreign PID before attachEndpoint
    fs.writeFileSync(lockPath, JSON.stringify({
        protocol_version: 1,
        workspace_id: workspaceId,
        pid: process.pid + 888,
        started_at: '2026-08-25T01:00:00.000Z',
        endpoint: null,
    }), 'utf8');

    // attachEndpoint must fail closed and refuse to overwrite foreign lock
    assert.throws(
        () => handle.attachEndpoint({ host: '127.0.0.1', port: 12345 }),
        (err) => {
            assert.ok(err instanceof DualDaemonLockError);
            return true;
        }
    );

    const onDiskAfter = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(onDiskAfter.pid, process.pid + 888, 'Foreign lock on disk was not overwritten');

    // Overwrite with corrupt lock containing extra keys
    fs.writeFileSync(lockPath, JSON.stringify({
        protocol_version: 1,
        workspace_id: workspaceId,
        pid: process.pid,
        started_at: '2026-08-25T00:00:00.000Z',
        endpoint: null,
        forbidden_extra_key: 'malicious',
    }), 'utf8');

    assert.throws(
        () => handle.attachEndpoint({ host: '127.0.0.1', port: 12345 }),
        (err) => {
            assert.equal(err.code, 'DUAL_LOCK_CORRUPT');
            return true;
        }
    );
});

// --------------------------------------------------------------------------
// 21. Codex Security Review Finding 6: Server startup cleanup and retry
// --------------------------------------------------------------------------
test('Fix 6: server startup failure cleans listener and lock, enabling clean restart', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess'));

    // Inject fs error on discovery write
    const customFs = {
        ...fs,
        writeFileSync(filePath, data, options) {
            if (String(filePath).includes('daemon.json.tmp')) {
                throw new Error('Injected disk failure during discovery write');
            }
            return fs.writeFileSync(filePath, data, options);
        },
    };

    await assert.rejects(
        () => startDaemonServer({
            workspaceRoot: wsRoot,
            authorityStore,
            fsImpl: customFs,
        }),
        (err) => {
            assert.ok(err.message.includes('Injected disk failure'));
            return true;
        }
    );

    const runtimeDir = getRuntimeDir(wsRoot);
    const lockPath = path.join(runtimeDir, 'daemon.lock');
    assert.equal(fs.existsSync(lockPath), false, 'Lock must be released on startup failure');

    // Immediately retry starting daemon -> succeeds without DUAL_DAEMON_ACTIVE
    const daemonRetry = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });
    t.after(() => daemonRetry.close());

    assert.ok(daemonRetry.address.port > 0);
    assert.equal(fs.existsSync(lockPath), true);
});

// --------------------------------------------------------------------------
// 22. Codex Security Review Finding 7: Discovery cleanup on close verifies ownership
// --------------------------------------------------------------------------
test('Fix 7: discovery cleanup on close never deletes replacement daemon discovery file', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const authorityStore = createAuthorityStore(path.join(wsRoot, '.omni', 'sessions', 'test-sess'));

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore,
    });

    const runtimeDir = getRuntimeDir(wsRoot);
    const discoveryPath = path.join(runtimeDir, 'daemon.json');
    assert.ok(fs.existsSync(discoveryPath));

    // Overwrite discovery with replacement daemon ownership
    const replacementPayload = {
        protocol_version: 1,
        workspace_id: daemon.workspaceId,
        workspace_root: wsRoot,
        pid: process.pid + 777,
        started_at: '2026-08-25T02:00:00.000Z',
        host: '127.0.0.1',
        port: 54321,
        token: 'f'.repeat(64),
    };
    fs.writeFileSync(discoveryPath, JSON.stringify(replacementPayload, null, 2) + '\n', 'utf8');

    // Close daemon 1
    await daemon.close();

    // Replacement discovery must still exist
    assert.ok(fs.existsSync(discoveryPath), 'Replacement daemon discovery must not be unlinked');
    const onDiskDiscovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
    assert.equal(onDiskDiscovery.pid, process.pid + 777);
});
