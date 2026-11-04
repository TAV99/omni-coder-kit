'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createSingleLauncher } = require('../../lib/ui/single-session');
const { evaluateHook } = require('../../lib/dual/hook-bridge');

test('T13 single-session: starts, tracks nativeSessionId, and stores metadata in .omni/ui/single.json', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-single-test-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const mockTerminalRegistry = {
        created: [],
        stopped: [],
        create(spec) {
            this.created.push(spec);
            return { id: spec.id };
        },
        stop(id) {
            this.stopped.push(id);
        },
    };

    const launcher = createSingleLauncher({
        root: tmpDir,
        terminalRegistry: mockTerminalRegistry,
    });

    // 1. Start single session
    const session = await launcher.start('ctx-single-1', {
        runtime: 'codex',
        model: 'gpt-4o',
        effort: 'high',
    });

    assert.equal(session.contextId, 'ctx-single-1');
    assert.equal(session.runtime, 'codex');
    assert.equal(session.model, 'gpt-4o');
    assert.equal(session.status, 'running');
    assert.ok(session.nativeSessionId);

    // Verify .omni/ui/single.json written
    const singleJsonPath = path.join(tmpDir, '.omni', 'ui', 'single.json');
    assert.ok(fs.existsSync(singleJsonPath));
    const meta = JSON.parse(fs.readFileSync(singleJsonPath, 'utf8'));
    assert.equal(meta.lastSlot.runtime, 'codex');
    assert.equal(meta.sessions['ctx-single-1'].nativeSessionId, session.nativeSessionId);

    // Verify .omni/squad.local.json does NOT exist
    assert.equal(fs.existsSync(path.join(tmpDir, '.omni', 'squad.local.json')), false);

    // 2. Resume session preserves nativeSessionId
    const resumed = await launcher.start('ctx-single-1', {
        runtime: 'codex',
        model: 'gpt-4o',
    }, { resume: true });

    assert.equal(resumed.nativeSessionId, session.nativeSessionId);

    // 3. Stop session
    await launcher.stop('ctx-single-1');
    assert.ok(mockTerminalRegistry.stopped.includes(session.terminalId));
});

test('T13 single-session: warns if concurrent primary session is running', async (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-single-test-'));
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    const mockContexts = {
        list: () => [
            { id: 'ctx-squad-1', mode: 'squad', status: 'running' },
            { id: 'ctx-single-1', mode: 'single', status: 'idle' },
        ],
    };

    const launcher = createSingleLauncher({
        root: tmpDir,
        contexts: mockContexts,
    });

    const session = await launcher.start('ctx-single-1', {
        runtime: 'codex',
        model: 'gpt-4o',
    });

    assert.ok(session.warning);
    assert.match(session.warning, /Another primary session .* is currently running/);
});

test('T13 hook-bridge: single session mode bypasses squad authority but maintains gate guard', async () => {
    // 1. Tool execution in Single mode is allowed without daemon lookup
    const resAllow = await evaluateHook({
        session_id: 'sess-single-1',
        hook_event_name: 'PreToolUse',
        tool_name: 'read_file',
        tool_input: { path: 'README.md' },
        cwd: process.cwd(),
        session_mode: 'single',
    });

    // Steps aside: no decision, so the CLI's own permission prompts still apply.
    assert.deepEqual(resAllow, {});

    // 2. Human approval gate attempt in Single mode is STILL strictly denied!
    const resGateDeny = await evaluateHook({
        session_id: 'sess-single-1',
        hook_event_name: 'PreToolUse',
        tool_name: 'bash',
        tool_input: { command: 'omni squad approve gate-123' },
        cwd: process.cwd(),
        session_mode: 'single',
    });

    assert.equal(resGateDeny.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(resGateDeny.hookSpecificOutput?.permissionDecisionReason, /Chỉ người dùng được duyệt cổng/);
});
