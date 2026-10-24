'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { DualObserver, formatEvent } = require('../lib/dual/observer');
const { createAuthorityStore } = require('../lib/dual/authority-store');
const { inspectPrivateDependencyReadiness, inspectPrivateDependencyReadinessAsync } = require('../lib/dual/private-dependencies');
const { prepareTaskWorkspace } = require('../lib/dual/task-workspace');

test('observer: incremental cursor, partial line buffer, and file truncation semantics', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-obs-test-'));
    const ledgerDir = path.join(tmpDir, '.omni', 'runs', 'dual-authority');
    fs.mkdirSync(ledgerDir, { recursive: true });
    const ledgerPath = path.join(ledgerDir, 'events.ndjson');

    const observer = new DualObserver({ workspaceRoot: tmpDir, ledgerPath });

    // Step 1: Initial empty read
    const initial = observer.readIncremental();
    assert.equal(initial.newEvents.length, 0);
    assert.equal(observer.byteOffset, 0);

    // Step 2: Write 2 complete events
    const evt0 = { sequence: 0, type: 'session.created', session_id: 's-1', mode: 'isolated' };
    const evt1 = { sequence: 1, type: 'plan.registered', plan_revision: 1, total_tasks: 2 };
    fs.writeFileSync(ledgerPath, JSON.stringify(evt0) + '\n' + JSON.stringify(evt1) + '\n');

    const firstRead = observer.readIncremental();
    assert.equal(firstRead.newEvents.length, 2);
    assert.equal(firstRead.totalEvents, 2);
    assert.equal(observer.lastSequence, 1);
    assert.ok(observer.byteOffset > 0);

    // Step 3: No new data -> 0 new events
    const secondRead = observer.readIncremental();
    assert.equal(secondRead.newEvents.length, 0);
    assert.equal(secondRead.totalEvents, 2);

    // Step 4: Write partial line without trailing newline
    const partialEvt = '{"sequence":2,"type":"task.routed"';
    fs.appendFileSync(ledgerPath, partialEvt);

    const partialRead = observer.readIncremental();
    assert.equal(partialRead.newEvents.length, 0);
    assert.equal(partialRead.totalEvents, 2);

    // Complete the line
    fs.appendFileSync(ledgerPath, ',"owner":"codex","task_id":"T1"}\n');
    const completeRead = observer.readIncremental();
    assert.equal(completeRead.newEvents.length, 1);
    assert.equal(completeRead.newEvents[0].sequence, 2);
    assert.equal(completeRead.newEvents[0].owner, 'codex');
    assert.equal(completeRead.totalEvents, 3);
    assert.equal(observer.lastSequence, 2);

    // Step 5: Truncation / rewrite detection
    const freshEvt0 = { sequence: 0, type: 'session.created', session_id: 's-fresh', mode: 'isolated' };
    fs.writeFileSync(ledgerPath, JSON.stringify(freshEvt0) + '\n');

    const resetRead = observer.readIncremental();
    assert.equal(resetRead.newEvents.length, 1);
    assert.equal(resetRead.newEvents[0].session_id, 's-fresh');
    assert.equal(observer.lastSequence, 0);

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('observer: formatEvent renders acceptance correction, session blocking and lifecycle events', () => {
    const started = formatEvent({
        sequence: 4,
        type: 'acceptance.correction.started',
        task_id: 'TASK-1',
        attempt: 2,
        reason: 'Button contrast ratio failed'
    });
    assert.match(started, /#4/);
    assert.match(started, /TASK-1/);
    assert.match(started, /attempt 2/);
    assert.match(started, /Button contrast ratio failed/);

    const completed = formatEvent({
        sequence: 5,
        type: 'acceptance.correction.completed',
        task_id: 'TASK-1',
        attempt: 2,
        status: 'PASSED'
    });
    assert.match(completed, /PASSED/);

    const blocked = formatEvent({
        sequence: 6,
        type: 'session.blocked',
        blocker_code: 'BUDGET_EXHAUSTED',
        reason: 'Max attempts exceeded'
    });
    assert.match(blocked, /SESSION BLOCKED/);
    assert.match(blocked, /BUDGET_EXHAUSTED/);
    assert.match(blocked, /Max attempts exceeded/);

    const verified = formatEvent({
        sequence: 7,
        type: 'session.verified',
        receipt_sha256: 'abcdef1234567890abcdef'
    });
    assert.match(verified, /SESSION VERIFIED/);
});

test('observer: decodes and verifies real authority-store envelopes without projecting unknown events', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-obs-envelope-'));
    const authorityDir = path.join(tmpDir, '.omni', 'runs', 'dual-authority');
    const store = createAuthorityStore(authorityDir);
    store.append({
        type: 'session.created', state: 'DISCOVERED', workspace_root: tmpDir,
        workspace_id: 'ws-observer', session_id: 'sess-observer', plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) }, mode: 'auto',
    });
    store.append({
        type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE', status: 'PASSED',
        checks: [{ name: 'agy', status: 'PASSED' }],
    });
    const observer = new DualObserver({ workspaceRoot: tmpDir, ledgerPath: path.join(authorityDir, 'events.ndjson') });
    const result = observer.readIncremental();
    assert.equal(result.newEvents.length, 2);
    assert.deepEqual(result.newEvents.map((event) => event.type), ['session.created', 'capability.result']);
    assert.equal(result.integrity_error, undefined);
    assert.equal(observer.lastSequence, 2);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('observer: rejects raw records mixed into an enveloped ledger', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-obs-mixed-'));
    const authorityDir = path.join(tmpDir, '.omni', 'runs', 'dual-authority');
    const store = createAuthorityStore(authorityDir);
    store.append({
        type: 'session.created', state: 'DISCOVERED', workspace_root: tmpDir,
        workspace_id: 'ws-mixed', session_id: 'sess-mixed', plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) }, mode: 'auto',
    });
    fs.appendFileSync(path.join(authorityDir, 'events.ndjson'), JSON.stringify({
        sequence: 999, type: 'session.verified', session_id: 'sess-mixed',
    }) + '\n');
    const observer = new DualObserver({ workspaceRoot: tmpDir, ledgerPath: path.join(authorityDir, 'events.ndjson') });
    const result = observer.readIncremental();
    assert.equal(result.newEvents.length, 1);
    assert.equal(result.newEvents[0].type, 'session.created');
    assert.equal(result.integrity_error, 'DUAL_OBSERVER_LEDGER_FORMAT_MIXED');
    assert.equal(observer.knownEvents.some((event) => event.type === 'session.verified'), false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('observer: stops projection after an integrity error in the middle of a batch', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-obs-middle-'));
    const authorityDir = path.join(tmpDir, '.omni', 'runs', 'dual-authority');
    const store = createAuthorityStore(authorityDir);
    store.append({
        type: 'session.created', state: 'DISCOVERED', workspace_root: tmpDir,
        workspace_id: 'ws-middle', session_id: 'sess-middle', plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) }, mode: 'auto',
    });
    store.append({ type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE', status: 'PASSED', checks: [{ name: 'agy', status: 'PASSED' }] });
    store.append({ type: 'gate.result', gate_id: 'after-raw', status: 'PASSED', evidence_sha256: 'b'.repeat(64), reason: 'later' });
    const lines = fs.readFileSync(path.join(authorityDir, 'events.ndjson'), 'utf8').trimEnd().split('\n');
    fs.writeFileSync(path.join(authorityDir, 'events.ndjson'), `${lines[0]}\n${JSON.stringify({ sequence: 999, type: 'raw.injected' })}\n${lines[2]}\n`);
    const observer = new DualObserver({ workspaceRoot: tmpDir, ledgerPath: path.join(authorityDir, 'events.ndjson') });
    const result = observer.readIncremental();
    assert.equal(result.integrity_error, 'DUAL_OBSERVER_LEDGER_FORMAT_MIXED');
    assert.deepEqual(result.newEvents.map((event) => event.type), ['session.created']);
    assert.equal(observer.knownEvents.some((event) => event.type === 'gate.result'), false);
    const second = observer.readIncremental();
    assert.equal(second.newEvents.length, 0, 'A corrupt batch must not resume projection without an explicit reset');
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('observer: detects same-size rewrites beyond the first 4096 bytes', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-obs-rewrite-'));
    const authorityDir = path.join(tmpDir, '.omni', 'runs', 'dual-authority');
    const store = createAuthorityStore(authorityDir);
    store.append({
        type: 'session.created', state: 'DISCOVERED', workspace_root: tmpDir,
        workspace_id: 'ws-rewrite', session_id: 'sess-rewrite', plan_revision: 1,
        expected_baseline: { kind: 'git', id: 'a'.repeat(40) }, mode: 'auto',
    });
    store.append({ type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE', status: 'PASSED', checks: [{ name: 'agy', status: 'PASSED' }] });
    for (let i = 0; i < 100; i++) {
        store.append({ type: 'gate.result', gate_id: `gate-${i}`, status: 'PASSED', evidence_sha256: 'b'.repeat(64), reason: `stable-${'x'.repeat(80)}-${i}` });
    }
    const ledgerPath = path.join(authorityDir, 'events.ndjson');
    const observer = new DualObserver({ workspaceRoot: tmpDir, ledgerPath });
    const initial = observer.readIncremental();
    assert.equal(initial.integrity_error, undefined);
    assert.ok(observer.byteOffset > 4096);
    const original = fs.readFileSync(ledgerPath);
    const replacement = Buffer.from(original);
    const marker = Buffer.from('stable-');
    const markerIndex = replacement.lastIndexOf(marker);
    assert.ok(markerIndex > 4096);
    replacement[markerIndex + marker.length] = replacement[markerIndex + marker.length] === 120 ? 121 : 120;
    fs.writeFileSync(ledgerPath, replacement);
    const reread = observer.readIncremental();
    assert.equal(reread.integrity_error, 'DUAL_OBSERVER_PREFIX_REWRITE');
    assert.equal(observer.knownEvents.length, initial.totalEvents);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('observer: rejects consumed-prefix rewrite before reading appended records', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-obs-prefix-growth-'));
    const ledgerPath = path.join(tmpDir, 'events.ndjson');
    const first = JSON.stringify({ sequence: 0, type: 'session.created', session_id: 'prefix-a' });
    const second = JSON.stringify({ sequence: 1, type: 'capability.result' });
    fs.writeFileSync(ledgerPath, `${first}\n`);
    const observer = new DualObserver({ workspaceRoot: tmpDir, ledgerPath });
    assert.equal(observer.readIncremental().newEvents.length, 1);
    const rewritten = Buffer.from(`${first.slice(0, -2)}X"}\n${second}\n`);
    fs.writeFileSync(ledgerPath, rewritten);
    const result = observer.readIncremental();
    assert.equal(result.integrity_error, 'DUAL_OBSERVER_PREFIX_REWRITE');
    assert.equal(observer.knownEvents.length, 1);
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('async dependency readiness: non-blocking lease-safe inspection matches synchronous fingerprint', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-dep-test-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'dep-test', version: '1.0.0' }));
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), JSON.stringify({ name: 'dep-test', lockfileVersion: 3 }));
    const nm = path.join(tmpDir, 'node_modules');
    fs.mkdirSync(path.join(nm, 'pkg-a'), { recursive: true });
    fs.writeFileSync(path.join(nm, 'pkg-a', 'index.js'), 'module.exports = "a";');

    const syncResult = inspectPrivateDependencyReadiness(tmpDir);
    assert.equal(syncResult.installed, true);
    assert.ok(syncResult.dependencySha256);

    let tickCount = 0;
    const asyncResult = await inspectPrivateDependencyReadinessAsync(tmpDir, {
        yieldEvery: 1,
        onTick: () => { tickCount++; }
    });

    assert.equal(asyncResult.installed, true);
    assert.equal(asyncResult.dependencySha256, syncResult.dependencySha256);
    assert.ok(tickCount >= 1, 'onTick must be invoked to yield execution and prevent lease starvation');

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('async dependency verifier awaits cooperative lease heartbeat callbacks', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-dep-heartbeat-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'dep-heartbeat', version: '1.0.0' }));
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), JSON.stringify({ name: 'dep-heartbeat', lockfileVersion: 3 }));
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;');

    let heartbeatCompleted = false;
    await inspectPrivateDependencyReadinessAsync(tmpDir, {
        yieldEvery: 1,
        onTick: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            heartbeatCompleted = true;
        },
    });

    assert.equal(heartbeatCompleted, true, 'lease heartbeat must complete before verifier resolves');
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('isolated worker and QC hot paths use the async dependency verifier', () => {
    for (const sourcePath of ['lib/dual/isolated-runner.js', 'lib/dual/isolated-qc.js']) {
        const source = fs.readFileSync(path.join(__dirname, '..', sourcePath), 'utf8');
        assert.match(source, /verifyPrivateDependenciesAsync/);
        assert.doesNotMatch(source, /\bverifyPrivateDependencies\s*\(/, `${sourcePath} must not call the blocking verifier`);
    }
});

test('path and collision preflight: generated outputs cannot overlap existing repository source files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-collision-test-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'source.js'), 'console.log("hello");');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

    // Attempting to declare generated_output 'src' overlapping existing repository file 'src/source.js'
    assert.throws(() => {
        prepareTaskWorkspace({
            workspaceRoot: tmpDir,
            sessionId: '00000000-0000-4000-8000-000000000001',
            taskId: 'TASK-COLLIDE',
            attempt: 1,
            planRevision: 1,
            allowedFiles: ['package.json'],
            generatedOutputs: ['src'],
            contextFiles: [],
            denyPatterns: [],
            dependencyMode: 'none',
        });
    }, (err) => {
        assert.equal(err.code, 'DUAL_TASK_SCOPE_INVALID');
        assert.match(err.message, /overlaps repository source file/);
        return true;
    });

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('path and collision preflight: case-colliding task paths are rejected fail-closed', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-case-test-'));
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'source.js'), 'console.log("hello");');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

    // Case collision between allowed files
    assert.throws(() => {
        prepareTaskWorkspace({
            workspaceRoot: tmpDir,
            sessionId: '00000000-0000-4000-8000-000000000001',
            taskId: 'TASK-CASE',
            attempt: 1,
            planRevision: 1,
            allowedFiles: ['package.json', 'PACKAGE.JSON'],
            generatedOutputs: [],
            contextFiles: [],
            denyPatterns: [],
            dependencyMode: 'none',
        });
    }, (err) => {
        assert.equal(err.code, 'DUAL_TASK_SCOPE_INVALID');
        assert.match(err.message, /Case-colliding task paths detected/);
        return true;
    });

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});


test('path and collision preflight: allowed path case-colliding with snapshot source is rejected', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-snapshot-case-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    assert.throws(() => prepareTaskWorkspace({
        workspaceRoot: root, sessionId: 'case-snapshot', taskId: 'TASK-CASE',
        attempt: 1, planRevision: 1, allowedFiles: ['PACKAGE.JSON'],
        generatedOutputs: [], contextFiles: [], denyPatterns: [], dependencyMode: 'none',
    }), { code: 'DUAL_TASK_SCOPE_INVALID' });
});
