'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { fanout, CHECK_LENSES } = require('../lib/harness/fanout');
const hostCli = require('../lib/harness/providers/host-cli');
const { runHarness } = require('../lib/harness/loop');
const { readEvents } = require('../lib/harness/events');

function tmpProject() { return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-fan-')); }
function writeTodo(dir, body) {
    fs.mkdirSync(path.join(dir, '.omni', 'sdlc'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.omni', 'sdlc', 'todo.md'), body, 'utf-8');
}

// --- fanout utility --------------------------------------------------------

test('fanout: runs all lenses, preserves order', async () => {
    const lenses = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    const reports = await fanout(lenses, async (l) => ({ lens: l.name, ok: true, findings: [], durationMs: 1 }));
    assert.deepStrictEqual(reports.map((r) => r.lens), ['a', 'b', 'c']);
});

test('fanout: runs concurrently (bounded)', async () => {
    let active = 0, peak = 0;
    const lenses = Array.from({ length: 6 }, (_, i) => ({ name: `l${i}` }));
    await fanout(lenses, async () => {
        active++; peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { ok: true };
    }, { concurrency: 3 });
    assert.ok(peak <= 3, `peak ${peak} must respect concurrency 3`);
    assert.ok(peak > 1, 'should actually run in parallel');
});

test('fanout: a throwing lens becomes ok:false (not a crash)', async () => {
    const reports = await fanout([{ name: 'x' }], async () => { throw new Error('boom'); });
    assert.strictEqual(reports[0].ok, false);
    assert.match(reports[0].findings[0], /boom/);
});

test('fanout: default CHECK_LENSES = code-review/security/test', () => {
    assert.deepStrictEqual(CHECK_LENSES.map((l) => l.name), ['code-review', 'security', 'test']);
});

// --- host-cli multi-IDE command building -----------------------------------

test('host-cli.buildCommand per ide', () => {
    assert.match(hostCli.buildCommand('claudecode', 'do X').cmd, /^claude -p ".*" --permission-mode acceptEdits$/);
    assert.match(hostCli.buildCommand('gemini', 'do X').cmd, /^gemini --yolo -p ".*"$/);
    assert.match(hostCli.buildCommand('codex', 'do X').cmd, /^codex exec ".*"$/);
    assert.ok(hostCli.buildCommand('eclipse', 'do X').error, 'unknown ide → error');
});

test('host-cli.buildCommand --yolo bỏ qua mọi permission', () => {
    // claude: mặc định acceptEdits → yolo dùng --dangerously-skip-permissions
    assert.match(hostCli.buildCommand('claudecode', 'do X', { yolo: true }).cmd,
        /^claude -p ".*" --dangerously-skip-permissions$/);
    assert.doesNotMatch(hostCli.buildCommand('claudecode', 'do X', { yolo: true }).cmd, /acceptEdits/);
    // codex: yolo thêm bypass approvals/sandbox
    assert.match(hostCli.buildCommand('codex', 'do X', { yolo: true }).cmd,
        /^codex exec --dangerously-bypass-approvals-and-sandbox ".*"$/);
    // antigravity: đã skip sẵn, yolo không đổi
    assert.match(hostCli.buildCommand('antigravity', 'do X', { yolo: true }).cmd,
        /^agy --dangerously-skip-permissions -p ".*"$/);
    // mặc định (không yolo) vẫn an toàn
    assert.match(hostCli.buildCommand('claudecode', 'do X').cmd, /--permission-mode acceptEdits$/);
});

test('host-cli.create({yolo}) truyền cờ xuống runStep', () => {
    let captured = '';
    const runner = (cmd) => { captured = cmd; return { exitCode: 0, stdout: 'ok', stderr: '' }; };
    const p = hostCli.create({ ide: 'claudecode', runCommand: runner, yolo: true });
    p.runStep('cook', { projectDir: '/tmp', workflowPath: 'wf.md', sharedBrief: 'b' });
    assert.match(captured, /--dangerously-skip-permissions/);
});

test('host-cli.runStep uses injected runner + maps exit code', async () => {
    const captured = {};
    const runner = (cmd) => { captured.cmd = cmd; return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }; };
    const p = hostCli.create({ ide: 'gemini', runCommand: runner });
    const r = await p.runStep('cook', { projectDir: '/x', workflowPath: '/wf.md' });
    assert.strictEqual(r.ok, true);
    assert.match(captured.cmd, /^gemini --yolo -p/);
});

test('host-cli.runStep: claude not found → exit 127', async () => {
    const runner = () => ({ exitCode: 127, stdout: '', stderr: 'command not found', timedOut: false });
    const p = hostCli.create({ ide: 'claudecode', runCommand: runner });
    const r = await p.runStep('cook', {});
    assert.strictEqual(r.exitCode, 127);
});

// --- loop fan-out merge (depth=1) ------------------------------------------

const passGate = () => ({ passed: true, results: [], failures: [] });

test('loop: lens fail at CHECK routes to FIX (merged in loop) even when gate passes', async () => {
    const dir = tmpProject();
    writeTodo(dir, '- [x] a\n');
    const failSecurity = async (lens) => ({ lens: lens.name, ok: lens.name !== 'security', findings: ['x'], durationMs: 1 });
    const final = await runHarness(dir, {
        from: 'CHECK', provider: 'dry-run', runPipeline: passGate, runLens: failSecurity, budget: { maxFixAttempts: 1 },
    });
    assert.strictEqual(final.state, 'BLOCKED'); // lens keeps failing → exhausts fix → BLOCKED
    const evs = readEvents(dir);
    assert.ok(evs.some((e) => e.type === 'fanout' && e.phase === 'check'));
});

test('loop: all lenses pass + gate pass → DOC, pause before SHIP', async () => {
    const dir = tmpProject();
    writeTodo(dir, '- [x] a\n');
    const okLens = async (lens) => ({ lens: lens.name, ok: true, findings: [], durationMs: 1 });
    const final = await runHarness(dir, {
        from: 'CHECK', provider: 'dry-run', runPipeline: passGate, runLens: okLens,
    });
    assert.strictEqual(final.state, 'DOC');
    assert.strictEqual(final.status, 'paused');
    assert.ok(readEvents(dir).some((e) => e.type === 'fanout' && e.phase === 'check'));
});

test('loop: dry-run provider without injected runLens skips fan-out', async () => {
    const dir = tmpProject();
    writeTodo(dir, '- [x] a\n');
    const final = await runHarness(dir, { from: 'CHECK', provider: 'dry-run', runPipeline: passGate });
    assert.strictEqual(final.state, 'DOC');
    assert.ok(!readEvents(dir).some((e) => e.type === 'fanout'), 'no fan-out for plain dry-run');
});
