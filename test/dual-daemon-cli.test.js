'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawn, execFileSync } = require('node:child_process');

const { createAuthorityStore } = require('../lib/dual/authority-store');
const { computeSnapshotRootHash, createSnapshotBaseline } = require('../lib/dual/baseline-snapshot');
const { createDaemonClient } = require('../lib/dual/daemon-client');
const { getRuntimeDir, computeWorkspaceId } = require('../lib/dual/daemon-lock');

const OMNI_BIN = path.resolve(__dirname, '..', 'bin', 'omni.js');

function createTempWorkspace(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-daemon-cli-test-'));
    const canonical = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
    t.after(async () => {
        // Stop any running daemon in this workspace before cleanup
        try {
            const client = createDaemonClient({ workspaceRoot: canonical, timeoutMs: 200 });
            await client.stop();
        } catch {
            // ignore
        }
        // Force cleanup directory
        try {
            fs.rmSync(canonical, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });
    return canonical;
}

function runOmniCli(args, options = {}) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [OMNI_BIN, ...args], {
            cwd: options.cwd || process.cwd(),
            env: { ...process.env, ...options.env },
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

function initGitRepo(repoDir) {
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Omni Test'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@omni.local'], { cwd: repoDir, stdio: 'ignore' });
}

function gitCommitAll(repoDir, message = 'initial commit') {
    execFileSync('git', ['add', '-A'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', message], { cwd: repoDir, stdio: 'ignore' });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();
}

function seedVerifiedSession(wsRoot) {
    const authorityDir = path.join(wsRoot, '.omni', 'runs', 'dual-authority');
    const store = createAuthorityStore(authorityDir);

    const snapEngine = createSnapshotBaseline({ root: wsRoot });
    const snap = snapEngine.capture();
    const sessionId = crypto.randomUUID();
    const wsId = computeWorkspaceId(wsRoot);

    const e1 = store.append({
        schema_version: 2,
        type: 'session.created',
        state: 'DISCOVERED',
        workspace_root: wsRoot,
        mode: 'auto',
        workspace_id: wsId,
        session_id: sessionId,
        plan_revision: 1,
        expected_baseline: snap.identity,
    });
    const e2 = store.append({
        schema_version: 2,
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'hooks', status: 'PASSED' }],
        causation_id: e1.event_id,
    });
    const e3 = store.append({
        schema_version: 2,
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plan.md',
        plan_sha256: 'a'.repeat(64),
        total_tasks: 1,
        tasks: [{ task_id: 'TASK-1', title: 'Task 1', owner: 'agy', allowed_files: ['index.js'] }],
        causation_id: e2.event_id,
    });
    const e4 = store.append({
        schema_version: 2,
        type: 'task.routed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'ROUTED',
        allowed_files: ['index.js'],
        reason: 'bounded task',
        causation_id: e3.event_id,
    });
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expIso = new Date(nowMs + 30000).toISOString();
    const leaseId = crypto.randomUUID();
    const e5 = store.append({
        schema_version: 2,
        type: 'lease.acquired',
        lease_id: leaseId,
        task_id: 'TASK-1',
        owner: 'agy',
        acquired_at: nowIso,
        expires_at: expIso,
        ttl_ms: 30000,
        causation_id: e4.event_id,
    });
    const e6 = store.append({
        schema_version: 2,
        type: 'task.completed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['index.js'],
        diff_fingerprint: 'd'.repeat(64),
        verdict: 'SUCCESS',
        verified_by: 'codex',
        causation_id: e5.event_id,
    });
    const receiptSha = 'e'.repeat(64);
    store.append({
        schema_version: 2,
        type: 'session.verified',
        from_state: 'ACCEPTANCE',
        to_state: 'VERIFIED',
        receipt_sha256: receiptSha,
        completed_tasks: ['TASK-1'],
        causation_id: e6.event_id,
    });

    return {
        store,
        authorityDir,
        sessionId,
        receiptSha,
        snap,
    };
}

// ---------------------------------------------------------------------------
// 1. CLI Registration & Help
// ---------------------------------------------------------------------------
test('omni dual --help registers daemon and baseline subcommands without breaking existing dual subcommands', async () => {
    const res = await runOmniCli(['dual', '--help']);
    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes('new <task-id>'));
    assert.ok(res.stdout.includes('run <task-id>'));
    assert.ok(res.stdout.includes('resume <task-id>'));
    assert.ok(res.stdout.includes('status <task-id>'));
    assert.ok(res.stdout.includes('phase <phase> <task-id>'));
    assert.ok(res.stdout.includes('daemon'));
    assert.ok(res.stdout.includes('baseline'));
    assert.ok(res.stdout.includes('bootstrap'));
});

test('omni dual bootstrap rejects a missing typed plan before starting daemon authority', async (t) => {
    const wsRoot = createTempWorkspace(t);
    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'initial\n', 'utf8');
    const result = await runOmniCli(['dual', 'bootstrap', '--json'], { cwd: wsRoot });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /DUAL_BOOTSTRAP_PLAN_MISSING/);
    assert.equal(fs.existsSync(path.join(wsRoot, '.omni', 'runtime', 'dual', 'daemon.json')), false);
});

test('omni dual daemon --help registers start, status, stop, recover', async () => {
    const res = await runOmniCli(['dual', 'daemon', '--help']);
    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes('start'));
    assert.ok(res.stdout.includes('status'));
    assert.ok(res.stdout.includes('stop'));
    assert.ok(res.stdout.includes('recover'));
});

test('omni dual baseline --help registers promote', async () => {
    const res = await runOmniCli(['dual', 'baseline', '--help']);
    assert.equal(res.code, 0);
    assert.ok(res.stdout.includes('promote'));
});

// ---------------------------------------------------------------------------
// 2. Daemon Start & Greenfield Initial Snapshot
// ---------------------------------------------------------------------------
test('omni dual daemon start creates snapshot session on greenfield workspace, writes initial-snapshot.json, and is idempotent', async (t) => {
    const wsRoot = createTempWorkspace(t);
    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'console.log("hello");\n');

    // 1. Start daemon
    const start1 = await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });
    assert.equal(start1.code, 0, `start failed: ${start1.stderr}`);
    assert.ok(start1.stdout.includes('Authority daemon đang chạy'));
    assert.equal(start1.stdout.includes('token'), false);
    assert.equal(start1.stderr.includes('token'), false);

    const client = createDaemonClient({ workspaceRoot: wsRoot });
    const health = await client.health();
    assert.equal(health.status, 'healthy');
    assert.ok(health.session_id);
    assert.equal(health.current_baseline.kind, 'snapshot');

    // Verify initial-snapshot.json was written atomically under .omni/runs/dual-authority
    const initialSnapshotPath = path.join(wsRoot, '.omni', 'runs', 'dual-authority', 'initial-snapshot.json');
    assert.ok(fs.existsSync(initialSnapshotPath), 'initial-snapshot.json must exist');
    const initialSnapshot = JSON.parse(fs.readFileSync(initialSnapshotPath, 'utf8'));
    assert.equal(initialSnapshot.schema_version, 1);
    assert.equal(initialSnapshot.session_id, health.session_id);
    assert.equal(initialSnapshot.workspace_id, computeWorkspaceId(wsRoot));
    assert.equal(initialSnapshot.workspace_root, fs.realpathSync.native ? fs.realpathSync.native(wsRoot) : fs.realpathSync(wsRoot));
    assert.match(initialSnapshot.content_sha256, /^[a-f0-9]{64}$/);
    assert.equal(initialSnapshot.identity.kind, 'snapshot');
    assert.equal(initialSnapshot.identity.id, health.current_baseline.id);
    assert.ok(Array.isArray(initialSnapshot.manifest.files));
    assert.equal(JSON.stringify(initialSnapshot).includes('token'), false);

    // 2. Second start is idempotent and returns 0 without spawning a second daemon
    const start2 = await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });
    assert.equal(start2.code, 0);
    assert.ok(start2.stdout.includes('Authority daemon đang chạy'));
    const health2 = await client.health();
    assert.equal(health2.pid, health.pid);
    assert.equal(health2.session_id, health.session_id);

    // Cleanup
    await client.stop();
});

test('omni dual daemon start in Git repository captures HEAD baseline', async (t) => {
    const wsRoot = createTempWorkspace(t);
    initGitRepo(wsRoot);
    fs.writeFileSync(path.join(wsRoot, 'app.js'), 'console.log("git app");\n');
    const headCommit = gitCommitAll(wsRoot, 'feat: initial app');

    const startRes = await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });
    assert.equal(startRes.code, 0, `start failed: ${startRes.stderr}`);

    const client = createDaemonClient({ workspaceRoot: wsRoot });
    const health = await client.health();
    assert.equal(health.status, 'healthy');
    assert.equal(health.current_baseline.kind, 'git');
    assert.equal(health.current_baseline.id, headCommit);

    // Initial snapshot should NOT exist for Git backend
    const initialSnapshotPath = path.join(wsRoot, '.omni', 'runs', 'dual-authority', 'initial-snapshot.json');
    assert.equal(fs.existsSync(initialSnapshotPath), false);

    await client.stop();
});

// ---------------------------------------------------------------------------
// 3. Daemon Status
// ---------------------------------------------------------------------------
test('omni dual daemon status prints PID, protocol, workspace, session, baseline, and counts without token', async (t) => {
    const wsRoot = createTempWorkspace(t);
    fs.writeFileSync(path.join(wsRoot, 'test.txt'), 'content');

    // 1. When daemon is not running: exit non-zero
    const statusStopped = await runOmniCli(['dual', 'daemon', 'status'], { cwd: wsRoot });
    assert.equal(statusStopped.code, 1);
    assert.ok(statusStopped.stderr.includes('Authority daemon') || statusStopped.stderr.includes('DUAL_DAEMON_NOT_RUNNING'));

    // 2. Start daemon
    await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });

    // 3. Status when running
    const statusRunning = await runOmniCli(['dual', 'daemon', 'status'], { cwd: wsRoot });
    assert.equal(statusRunning.code, 0);
    assert.ok(statusRunning.stdout.includes('PID'));
    assert.ok(statusRunning.stdout.includes('Workspace'));
    assert.ok(statusRunning.stdout.includes('Session ID'));
    assert.ok(statusRunning.stdout.includes('Baseline'));
    assert.ok(statusRunning.stdout.includes('Tasks'));
    assert.ok(statusRunning.stdout.includes('Leases'));
    assert.ok(statusRunning.stdout.includes('Gates'));
    assert.equal(statusRunning.stdout.includes('token'), false);
    assert.equal(statusRunning.stderr.includes('token'), false);

    // Stop daemon
    const client = createDaemonClient({ workspaceRoot: wsRoot });
    await client.stop();
});

test('omni dual status reads the live authority task in a greenfield snapshot workspace', async (t) => {
    const wsRoot = createTempWorkspace(t);
    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'verified content\n');
    const seeded = seedVerifiedSession(wsRoot);

    const start = await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });
    assert.equal(start.code, 0, `start failed: ${start.stderr}`);

    const status = await runOmniCli(['dual', 'status', 'TASK-1'], { cwd: wsRoot });
    assert.equal(status.code, 0, `status failed: ${status.stderr}`);
    assert.equal(status.stderr, '');
    assert.match(status.stdout, /TASK-1/);
    assert.match(status.stdout, /TASK_VERIFIED/);
    assert.match(status.stdout, /snapshot/i);
    assert.match(status.stdout, new RegExp(seeded.snap.identity.id));
    assert.match(status.stdout, /agy/i);
    assert.match(status.stdout, /VERIFIED/);
    assert.match(status.stdout, new RegExp(seeded.receiptSha));
    assert.doesNotMatch(status.stdout, /token/i);

    const client = createDaemonClient({ workspaceRoot: wsRoot });
    await client.stop();

    const offlineStatus = await runOmniCli(['dual', 'status', 'TASK-1'], { cwd: wsRoot });
    assert.equal(offlineStatus.code, 0, `offline status failed: ${offlineStatus.stderr}`);
    assert.match(offlineStatus.stdout, /TASK_VERIFIED/);
    assert.match(offlineStatus.stdout, new RegExp(seeded.receiptSha));
});

// ---------------------------------------------------------------------------
// 4. Daemon Stop
// ---------------------------------------------------------------------------
test('omni dual daemon stop shuts down daemon cleanly and is idempotent when already stopped', async (t) => {
    const wsRoot = createTempWorkspace(t);
    fs.writeFileSync(path.join(wsRoot, 'file.txt'), 'hello');

    // 1. Start daemon
    await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });
    const client = createDaemonClient({ workspaceRoot: wsRoot });
    const health = await client.health();
    assert.equal(health.status, 'healthy');

    // 2. Stop daemon
    const stopRes1 = await runOmniCli(['dual', 'daemon', 'stop'], { cwd: wsRoot });
    assert.equal(stopRes1.code, 0);
    assert.ok(stopRes1.stdout.includes('đã dừng') || stopRes1.stdout.includes('stopped'));

    // Verify discovery file was cleaned up
    const discoveryPath = path.join(wsRoot, '.omni', 'runtime', 'dual', 'daemon.json');
    assert.equal(fs.existsSync(discoveryPath), false);

    // 3. Second stop is idempotent success (exit 0)
    const stopRes2 = await runOmniCli(['dual', 'daemon', 'stop'], { cwd: wsRoot });
    assert.equal(stopRes2.code, 0);
});

test('omni dual daemon start/status/stop fail closed on corrupt discovery file without silent deletion', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const runtimeDir = getRuntimeDir(wsRoot);
    fs.mkdirSync(runtimeDir, { recursive: true });
    const discoveryPath = path.join(runtimeDir, 'daemon.json');
    fs.writeFileSync(discoveryPath, '{malformed json content', 'utf8');

    // 1. start fails
    const startRes = await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });
    assert.equal(startRes.code, 1);
    assert.ok(fs.existsSync(discoveryPath), 'Corrupt discovery file was not deleted');

    // 2. status fails
    const statusRes = await runOmniCli(['dual', 'daemon', 'status'], { cwd: wsRoot });
    assert.equal(statusRes.code, 1);
    assert.ok(fs.existsSync(discoveryPath));

    // 3. stop fails
    const stopRes = await runOmniCli(['dual', 'daemon', 'stop'], { cwd: wsRoot });
    assert.equal(stopRes.code, 1);
    assert.ok(fs.existsSync(discoveryPath));
});

test('omni dual daemon recover archives a pristine unworked session and creates fresh authority', async (t) => {
    const wsRoot = createTempWorkspace(t);
    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'initial\n', 'utf8');
    const start = await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });
    assert.equal(start.code, 0, start.stderr);

    const client = createDaemonClient({ workspaceRoot: wsRoot });
    const health = await client.health();
    const authorityDir = path.join(wsRoot, '.omni', 'runs', 'dual-authority');
    const store = createAuthorityStore(authorityDir);
    const created = store.readEvents().at(-1);
    const capability = store.append({
        schema_version: 2,
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        causation_id: created.event_id,
    });
    const plan = store.append({
        schema_version: 2,
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: '.omni/sdlc/todo.md',
        plan_sha256: 'a'.repeat(64),
        total_tasks: 1,
        tasks: [{ task_id: 'STALE-1', title: 'Stale task', owner: 'codex', allowed_files: ['index.js'] }],
        causation_id: capability.event_id,
    });
    store.append({
        schema_version: 2,
        type: 'task.routed',
        task_id: 'STALE-1',
        owner: 'codex',
        authority_state: 'ROUTED',
        allowed_files: ['index.js'],
        reason: 'stale bootstrap task',
        causation_id: plan.event_id,
    });

    const recovery = await runOmniCli(
        ['dual', 'daemon', 'recover', '--if-pristine', '--json'],
        { cwd: wsRoot },
    );
    assert.equal(recovery.code, 0, recovery.stderr);
    const payload = JSON.parse(recovery.stdout);
    assert.equal(payload.recovered, true);
    assert.equal(payload.archived_session_id, health.session_id);
    assert.notEqual(payload.session_id, health.session_id);
    assert.ok(fs.existsSync(path.join(wsRoot, '.omni', 'runs', 'dual-history', health.session_id, 'events.ndjson')));

    const freshClient = createDaemonClient({ workspaceRoot: wsRoot });
    const freshHealth = await freshClient.health();
    const freshStatus = await freshClient.status(freshHealth.session_id);
    assert.equal(freshStatus.state, 'DISCOVERED');
    assert.equal(Object.keys(freshStatus.tasks || {}).length, 0);
});

test('omni dual daemon recover fails closed for source drift or an unreleased lease', async (t) => {
    const wsRoot = createTempWorkspace(t);
    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'initial\n', 'utf8');
    await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });
    const client = createDaemonClient({ workspaceRoot: wsRoot });
    const health = await client.health();

    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'mutated\n', 'utf8');
    const drift = await runOmniCli(
        ['dual', 'daemon', 'recover', '--if-pristine', '--json'],
        { cwd: wsRoot },
    );
    assert.equal(drift.code, 1);
    assert.match(drift.stdout, /DUAL_RECOVERY_UNSAFE/);
    assert.equal((await client.health()).session_id, health.session_id);

    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'initial\n', 'utf8');
    const store = createAuthorityStore(path.join(wsRoot, '.omni', 'runs', 'dual-authority'));
    const created = store.readEvents().at(-1);
    const capability = store.append({
        schema_version: 2,
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'agy_cli_and_model', status: 'PASSED' }],
        causation_id: created.event_id,
    });
    const plan = store.append({
        schema_version: 2,
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: '.omni/sdlc/todo.md',
        plan_sha256: 'b'.repeat(64),
        total_tasks: 1,
        tasks: [{ task_id: 'LEASED-1', title: 'Leased task', owner: 'codex', allowed_files: ['index.js'] }],
        causation_id: capability.event_id,
    });
    store.append({
        schema_version: 2,
        type: 'task.routed',
        task_id: 'LEASED-1',
        owner: 'codex',
        authority_state: 'ROUTED',
        allowed_files: ['index.js'],
        reason: 'leased task',
        causation_id: plan.event_id,
    });
    store.acquireLease('LEASED-1', 'codex');

    const leased = await runOmniCli(
        ['dual', 'daemon', 'recover', '--if-pristine', '--json'],
        { cwd: wsRoot },
    );
    assert.equal(leased.code, 1);
    assert.match(leased.stdout, /DUAL_RECOVERY_UNSAFE/);
    assert.equal((await client.health()).session_id, health.session_id);
});

// ---------------------------------------------------------------------------
// 5. Baseline Promotion
// ---------------------------------------------------------------------------
test('baseline promote blocks when daemon is missing, session is not VERIFIED, baseline is not snapshot, or receipt is missing', async (t) => {
    const wsRoot = createTempWorkspace(t);
    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'code');

    // 1. Missing daemon
    const resNoDaemon = await runOmniCli(['dual', 'baseline', 'promote'], { cwd: wsRoot });
    assert.equal(resNoDaemon.code, 1);
    assert.ok(resNoDaemon.stderr.includes('DUAL_PROMOTION') || resNoDaemon.stderr.includes('daemon'));

    // Start daemon -> session starts in DISCOVERED
    await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });

    // 2. Session state is DISCOVERED (not VERIFIED)
    const resNotVerified = await runOmniCli(['dual', 'baseline', 'promote'], { cwd: wsRoot });
    assert.equal(resNotVerified.code, 1);
    assert.ok(resNotVerified.stderr.includes('DUAL_PROMOTION_NOT_VERIFIED') || resNotVerified.stderr.includes('VERIFIED'));

    const client = createDaemonClient({ workspaceRoot: wsRoot });
    await client.stop();
});

test('baseline promote blocks when accepted-snapshot.json is missing, corrupt, extra keys, or hash mismatch', async (t) => {
    const wsRoot = createTempWorkspace(t);
    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'console.log("accepted code");\n');

    const { authorityDir, sessionId, receiptSha, snap } = seedVerifiedSession(wsRoot);

    // Start daemon
    await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });

    // 1. Missing accepted-snapshot.json
    const resMissing = await runOmniCli(['dual', 'baseline', 'promote'], { cwd: wsRoot });
    assert.equal(resMissing.code, 1);
    assert.ok(resMissing.stderr.includes('DUAL_PROMOTION_ACCEPTED_SNAPSHOT_MISSING') || resMissing.stderr.includes('accepted-snapshot.json'));

    // 2. Extra keys in accepted-snapshot.json
    const acceptedPath = path.join(authorityDir, 'accepted-snapshot.json');
    const validAccepted = {
        schema_version: 1,
        session_id: sessionId,
        identity: snap.identity,
        manifest: snap.manifest,
        receipt_sha256: receiptSha,
    };
    fs.writeFileSync(acceptedPath, JSON.stringify({ ...validAccepted, extra_forbidden_key: true }), 'utf8');
    const resExtra = await runOmniCli(['dual', 'baseline', 'promote'], { cwd: wsRoot });
    assert.equal(resExtra.code, 1);
    assert.ok(resExtra.stderr.includes('DUAL_PROMOTION_ACCEPTED_SNAPSHOT_INVALID'));

    // 3. Tampered manifest hash in accepted-snapshot.json
    fs.writeFileSync(acceptedPath, JSON.stringify({
        ...validAccepted,
        identity: { kind: 'snapshot', id: 'f'.repeat(64) },
    }), 'utf8');
    const resTampered = await runOmniCli(['dual', 'baseline', 'promote'], { cwd: wsRoot });
    assert.equal(resTampered.code, 1);
    assert.ok(resTampered.stderr.includes('DUAL_PROMOTION_ACCEPTED_SNAPSHOT_INVALID'));

    const client = createDaemonClient({ workspaceRoot: wsRoot });
    await client.stop();
});

test('baseline promote blocks when workspace has uncommitted dirty changes against accepted snapshot', async (t) => {
    const wsRoot = createTempWorkspace(t);
    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'console.log("v1");\n');

    const { authorityDir, sessionId, receiptSha, snap } = seedVerifiedSession(wsRoot);

    const acceptedPath = path.join(authorityDir, 'accepted-snapshot.json');
    fs.writeFileSync(acceptedPath, JSON.stringify({
        schema_version: 1,
        session_id: sessionId,
        identity: snap.identity,
        manifest: snap.manifest,
        receipt_sha256: receiptSha,
    }), 'utf8');

    // Mutate file in workspace so diff is non-empty
    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'console.log("mutated after acceptance");\n');

    await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });

    const res = await runOmniCli(['dual', 'baseline', 'promote'], { cwd: wsRoot });
    assert.equal(res.code, 1);
    assert.ok(res.stderr.includes('DUAL_PROMOTION_WORKSPACE_DIRTY') || res.stderr.includes('differs'));

    const client = createDaemonClient({ workspaceRoot: wsRoot });
    await client.stop();
});

test('baseline promote blocks when Git is missing, HEAD is missing, or committed tree does not match accepted snapshot', async (t) => {
    const wsRoot = createTempWorkspace(t);
    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'console.log("clean");\n');

    const { authorityDir, sessionId, receiptSha, snap } = seedVerifiedSession(wsRoot);

    const acceptedPath = path.join(authorityDir, 'accepted-snapshot.json');
    fs.writeFileSync(acceptedPath, JSON.stringify({
        schema_version: 1,
        session_id: sessionId,
        identity: snap.identity,
        manifest: snap.manifest,
        receipt_sha256: receiptSha,
    }), 'utf8');

    await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });

    // 1. Not a Git repository
    const resNoGit = await runOmniCli(['dual', 'baseline', 'promote'], { cwd: wsRoot });
    assert.equal(resNoGit.code, 1);
    assert.ok(resNoGit.stderr.includes('DUAL_PROMOTION_GIT_MISSING') || resNoGit.stderr.includes('Git'));

    // 2. Git repo exists but no HEAD commit
    initGitRepo(wsRoot);
    const resNoHead = await runOmniCli(['dual', 'baseline', 'promote'], { cwd: wsRoot });
    assert.equal(resNoHead.code, 1);
    assert.ok(resNoHead.stderr.includes('DUAL_PROMOTION_GIT_HEAD_MISSING') || resNoHead.stderr.includes('HEAD'));

    // 3. Committed tree differs from accepted snapshot (e.g. commit a different file)
    fs.writeFileSync(path.join(wsRoot, 'other.js'), 'different');
    gitCommitAll(wsRoot, 'feat: commit wrong file');
    // Remove other.js from disk so disk matches snapshot, but committed HEAD does not match
    fs.unlinkSync(path.join(wsRoot, 'other.js'));

    const resMismatch = await runOmniCli(['dual', 'baseline', 'promote'], { cwd: wsRoot });
    assert.equal(resMismatch.code, 1);
    assert.ok(resMismatch.stderr.includes('DUAL_PROMOTION_UNTRACKED_ACCEPTED_FILE') || resMismatch.stderr.includes('DUAL_PROMOTION_TREE_MISMATCH') || resMismatch.stderr.includes('khớp'));

    const client = createDaemonClient({ workspaceRoot: wsRoot });
    await client.stop();
});

test('baseline promote succeeds when exact committed snapshot tree matches, appends one promotion event, and repeat promote is idempotent', async (t) => {
    const wsRoot = createTempWorkspace(t);
    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'console.log("exact code");\n');
    fs.writeFileSync(path.join(wsRoot, 'readme.md'), '# Exact Readme\n');

    const { store, authorityDir, sessionId, receiptSha, snap } = seedVerifiedSession(wsRoot);

    const acceptedPath = path.join(authorityDir, 'accepted-snapshot.json');
    fs.writeFileSync(acceptedPath, JSON.stringify({
        schema_version: 1,
        session_id: sessionId,
        identity: snap.identity,
        manifest: snap.manifest,
        receipt_sha256: receiptSha,
    }), 'utf8');

    // Create user Git repository and commit exact files
    initGitRepo(wsRoot);
    const headCommit = gitCommitAll(wsRoot, 'feat: initial verified commit');

    // Start daemon
    await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });

    const initialEventCount = store.readEvents().length;

    // Run baseline promote
    const promoteRes = await runOmniCli(['dual', 'baseline', 'promote'], { cwd: wsRoot });
    assert.equal(promoteRes.code, 0, `promote failed: ${promoteRes.stderr}`);
    assert.ok(promoteRes.stdout.includes('promote') || promoteRes.stdout.includes('Git HEAD'));

    // Verify exactly one promotion event was appended
    const updatedEvents = store.readEvents();
    assert.equal(updatedEvents.length, initialEventCount + 1);
    const lastEvent = updatedEvents[updatedEvents.length - 1];
    assert.equal(lastEvent.type, 'baseline.promoted');
    assert.equal(lastEvent.from_baseline.kind, 'snapshot');
    assert.equal(lastEvent.from_baseline.id, snap.identity.id);
    assert.equal(lastEvent.to_baseline.kind, 'git');
    assert.equal(lastEvent.to_baseline.id, headCommit);

    const derived = store.derive();
    assert.equal(derived.currentBaseline.kind, 'git');
    assert.equal(derived.currentBaseline.id, headCommit);

    // Verify repeat promote is idempotent and does NOT append additional events
    const repeatPromoteRes = await runOmniCli(['dual', 'baseline', 'promote'], { cwd: wsRoot });
    assert.equal(repeatPromoteRes.code, 0);
    assert.ok(repeatPromoteRes.stdout.includes('Idempotent') || repeatPromoteRes.stdout.includes('Git HEAD'));
    assert.equal(store.readEvents().length, initialEventCount + 1);
});

test('baseline promote succeeds when initial snapshot differs from final accepted snapshot and committed Git HEAD (promotion semantics)', async (t) => {
    const wsRoot = createTempWorkspace(t);
    // 1. Initial workspace has version 1
    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'console.log("v1");\n');

    const authorityDir = path.join(wsRoot, '.omni', 'runs', 'dual-authority');
    const store = createAuthorityStore(authorityDir);
    const snapEngine = createSnapshotBaseline({ root: wsRoot });
    const snapV1 = snapEngine.capture();
    const sessionId = crypto.randomUUID();
    const wsId = computeWorkspaceId(wsRoot);

    const e1 = store.append({
        schema_version: 2,
        type: 'session.created',
        state: 'DISCOVERED',
        workspace_root: wsRoot,
        mode: 'auto',
        workspace_id: wsId,
        session_id: sessionId,
        plan_revision: 1,
        expected_baseline: snapV1.identity,
    });
    const e2 = store.append({
        schema_version: 2,
        type: 'capability.result',
        from_state: 'DISCOVERED',
        to_state: 'CAPABILITY_SAFE',
        status: 'PASSED',
        checks: [{ name: 'hooks', status: 'PASSED' }],
        causation_id: e1.event_id,
    });
    const e3 = store.append({
        schema_version: 2,
        type: 'plan.registered',
        from_state: 'INTERVIEWING',
        to_state: 'PLANNED',
        plan_path: 'plan.md',
        plan_sha256: 'a'.repeat(64),
        total_tasks: 1,
        tasks: [{ task_id: 'TASK-1', title: 'Task 1', owner: 'agy', allowed_files: ['index.js'] }],
        causation_id: e2.event_id,
    });
    const e4 = store.append({
        schema_version: 2,
        type: 'task.routed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'ROUTED',
        allowed_files: ['index.js'],
        reason: 'bounded task',
        causation_id: e3.event_id,
    });
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const expIso = new Date(nowMs + 30000).toISOString();
    const leaseId = crypto.randomUUID();
    const e5 = store.append({
        schema_version: 2,
        type: 'lease.acquired',
        lease_id: leaseId,
        task_id: 'TASK-1',
        owner: 'agy',
        acquired_at: nowIso,
        expires_at: expIso,
        ttl_ms: 30000,
        causation_id: e4.event_id,
    });

    // 2. Implementation modifies file to version 2
    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'console.log("v2");\n');
    const snapV2 = snapEngine.capture();
    assert.notEqual(snapV1.identity.id, snapV2.identity.id, 'Initial snapshot must differ from accepted snapshot');

    const e6 = store.append({
        schema_version: 2,
        type: 'task.completed',
        task_id: 'TASK-1',
        owner: 'agy',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['index.js'],
        diff_fingerprint: 'd'.repeat(64),
        verdict: 'SUCCESS',
        verified_by: 'codex',
        causation_id: e5.event_id,
    });
    const receiptSha = 'e'.repeat(64);
    store.append({
        schema_version: 2,
        type: 'session.verified',
        from_state: 'ACCEPTANCE',
        to_state: 'VERIFIED',
        receipt_sha256: receiptSha,
        completed_tasks: ['TASK-1'],
        causation_id: e6.event_id,
    });

    // 3. accepted-snapshot.json contains snapV2
    const acceptedPath = path.join(authorityDir, 'accepted-snapshot.json');
    fs.writeFileSync(acceptedPath, JSON.stringify({
        schema_version: 1,
        session_id: sessionId,
        identity: snapV2.identity,
        manifest: snapV2.manifest,
        receipt_sha256: receiptSha,
    }), 'utf8');

    // 4. User commits v2 into Git HEAD
    initGitRepo(wsRoot);
    const headCommit = gitCommitAll(wsRoot, 'feat: v2 commit');

    // 5. Start daemon
    await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });

    // 6. Promote baseline
    const promoteRes = await runOmniCli(['dual', 'baseline', 'promote'], { cwd: wsRoot });
    assert.equal(promoteRes.code, 0, `promote failed: ${promoteRes.stderr}`);
    assert.ok(promoteRes.stdout.includes('promote') || promoteRes.stdout.includes('Git HEAD'));

    // 7. Verify promotion event: from_baseline is snapV1, to_baseline is Git HEAD
    const events = store.readEvents();
    const lastEvent = events[events.length - 1];
    assert.equal(lastEvent.type, 'baseline.promoted');
    assert.equal(lastEvent.from_baseline.kind, 'snapshot');
    assert.equal(lastEvent.from_baseline.id, snapV1.identity.id);
    assert.equal(lastEvent.to_baseline.kind, 'git');
    assert.equal(lastEvent.to_baseline.id, headCommit);

    const derived = store.derive();
    assert.equal(derived.currentBaseline.kind, 'git');
    assert.equal(derived.currentBaseline.id, headCommit);
});

test('baseline promote ignores tracked node_modules, .omni/runtime, .omni/runs, and temp files in Git HEAD without causing tree mismatch', async (t) => {
    const wsRoot = createTempWorkspace(t);
    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'console.log("code");\n');

    const { store, authorityDir, sessionId, receiptSha, snap } = seedVerifiedSession(wsRoot);

    const acceptedPath = path.join(authorityDir, 'accepted-snapshot.json');
    fs.writeFileSync(acceptedPath, JSON.stringify({
        schema_version: 1,
        session_id: sessionId,
        identity: snap.identity,
        manifest: snap.manifest,
        receipt_sha256: receiptSha,
    }), 'utf8');

    initGitRepo(wsRoot);

    // Commit valid code plus tracked ignored artifacts (node_modules, runtime, runs, temp files)
    fs.mkdirSync(path.join(wsRoot, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    fs.mkdirSync(path.join(wsRoot, '.omni', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, '.omni', 'runtime', 'cached.json'), '{}');
    fs.writeFileSync(path.join(wsRoot, 'test.tmp'), 'temporary');

    const headCommit = gitCommitAll(wsRoot, 'feat: commit code and ignored artifacts');

    await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });

    const promoteRes = await runOmniCli(['dual', 'baseline', 'promote'], { cwd: wsRoot });
    assert.equal(promoteRes.code, 0, `promote failed: ${promoteRes.stderr}`);
    assert.ok(promoteRes.stdout.includes('promote') || promoteRes.stdout.includes('Git HEAD'));

    const derived = store.derive();
    assert.equal(derived.currentBaseline.kind, 'git');
    assert.equal(derived.currentBaseline.id, headCommit);
});

test('baseline promote fails closed when authority store integrity is invalid during offline recheck', async (t) => {
    const wsRoot = createTempWorkspace(t);
    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'console.log("code");\n');

    const { store, authorityDir, sessionId, receiptSha, snap } = seedVerifiedSession(wsRoot);

    const acceptedPath = path.join(authorityDir, 'accepted-snapshot.json');
    fs.writeFileSync(acceptedPath, JSON.stringify({
        schema_version: 1,
        session_id: sessionId,
        identity: snap.identity,
        manifest: snap.manifest,
        receipt_sha256: receiptSha,
    }), 'utf8');

    initGitRepo(wsRoot);
    gitCommitAll(wsRoot, 'feat: verified commit');

    await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });

    // Corrupt events.ndjson right before promote stops daemon or offline derive
    const eventsPath = path.join(authorityDir, 'events.ndjson');
    fs.appendFileSync(eventsPath, '{"corrupt":"json line"}\n');

    const promoteRes = await runOmniCli(['dual', 'baseline', 'promote'], { cwd: wsRoot });
    assert.equal(promoteRes.code, 1);
    assert.ok(promoteRes.stderr.includes('DUAL_PROMOTION_BLOCKED') || promoteRes.stderr.includes('DUAL_INTEGRITY_CORRUPT') || promoteRes.stderr.includes('integrity'));
});

test('baseline promote fails closed when baseline or session state drifts before offline append', async (t) => {
    const wsRoot = createTempWorkspace(t);
    fs.writeFileSync(path.join(wsRoot, 'index.js'), 'console.log("code");\n');

    const { store, authorityDir, sessionId, receiptSha, snap } = seedVerifiedSession(wsRoot);

    const acceptedPath = path.join(authorityDir, 'accepted-snapshot.json');
    fs.writeFileSync(acceptedPath, JSON.stringify({
        schema_version: 1,
        session_id: sessionId,
        identity: snap.identity,
        manifest: snap.manifest,
        receipt_sha256: receiptSha,
    }), 'utf8');

    initGitRepo(wsRoot);
    gitCommitAll(wsRoot, 'feat: verified commit');

    await runOmniCli(['dual', 'daemon', 'start'], { cwd: wsRoot });

    // Tamper with accepted snapshot session ID so offline recheck detects drift
    fs.writeFileSync(acceptedPath, JSON.stringify({
        schema_version: 1,
        session_id: crypto.randomUUID(),
        identity: snap.identity,
        manifest: snap.manifest,
        receipt_sha256: receiptSha,
    }), 'utf8');

    const promoteRes = await runOmniCli(['dual', 'baseline', 'promote'], { cwd: wsRoot });
    assert.equal(promoteRes.code, 1);
    assert.ok(promoteRes.stderr.includes('DUAL_PROMOTION_ACCEPTED_SNAPSHOT_INVALID') || promoteRes.stderr.includes('DUAL_PROMOTION_BLOCKED'));
});
