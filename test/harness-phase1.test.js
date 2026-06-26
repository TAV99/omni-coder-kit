'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tasks = require('../lib/harness/tasks');
const shell = require('../lib/harness/tools/shell');
const buildTest = require('../lib/harness/tools/build-test');
const { runPipeline } = require('../lib/harness/gates/pipeline');

function tmpProject() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-p1-'));
}
function writeTodo(dir, body) {
    fs.mkdirSync(path.join(dir, '.omni', 'sdlc'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.omni', 'sdlc', 'todo.md'), body, 'utf-8');
}

// --- tasks.js --------------------------------------------------------------

test('tasks.parseTodo counts done / todo / blocked', () => {
    const dir = tmpProject();
    writeTodo(dir, [
        '# Todo',
        '- [x] task 1 done',
        '- [x] task 2 done',
        '- [ ] task 3 pending',
        '- [ ] [BLOCKED] task 4 stuck',
        'not a task line',
    ].join('\n'));
    const t = tasks.parseTodo(dir);
    assert.strictEqual(t.total, 4);
    assert.strictEqual(t.completed, 2);
    assert.strictEqual(t.blocked, 1);
    assert.strictEqual(t.remaining, 2);
});

test('tasks.parseTodo on missing file → zeros', () => {
    assert.deepStrictEqual(tasks.parseTodo(tmpProject()), { total: 0, completed: 0, blocked: 0, remaining: 0 });
});

test('tasks.computeCheckpoint = max(1, ceil(total/3))', () => {
    assert.strictEqual(tasks.computeCheckpoint(12), 4);
    assert.strictEqual(tasks.computeCheckpoint(1), 1);
    assert.strictEqual(tasks.computeCheckpoint(0), 1);
    assert.strictEqual(tasks.computeCheckpoint(10), 4);
});

// --- tools/shell.js --------------------------------------------------------

test('shell.isDenied blocks destructive commands, allows safe ones', () => {
    assert.ok(shell.isDenied('rm -rf /'));
    assert.ok(shell.isDenied('git push --force origin main'));
    assert.ok(shell.isDenied('git reset --hard HEAD~3'));
    assert.ok(shell.isDenied(':(){ :|:& };:'));
    assert.ok(!shell.isDenied('npm test'));
    assert.ok(!shell.isDenied('npm run build'));
    assert.ok(!shell.isDenied('claude -p "do the thing" --permission-mode acceptEdits'));
});

test('shell.runCommand throws on denied command (never executes)', () => {
    assert.throws(() => shell.runCommand('rm -rf /'), /deny-list/);
});

test('shell.runCommand runs a real harmless command', () => {
    const r = shell.runCommand('echo hello-harness');
    assert.strictEqual(r.exitCode, 0);
    assert.match(r.stdout, /hello-harness/);
    assert.strictEqual(r.timedOut, false);
});

// --- tools/build-test.js ---------------------------------------------------

test('build-test.detectCommands reads package.json scripts', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        scripts: { dev: 'vite', build: 'vite build', test: 'vitest', lint: 'eslint .' },
    }), 'utf-8');
    assert.deepStrictEqual(buildTest.detectCommands(dir), {
        dev: 'npm run dev', build: 'npm run build', test: 'npm test', lint: 'npm run lint',
    });
});

test('build-test.detectCommands on empty project → all null', () => {
    assert.deepStrictEqual(buildTest.detectCommands(tmpProject()), { dev: null, build: null, test: null, lint: null });
});

test('build-test.runGateCommand skips when no command', () => {
    const r = buildTest.runGateCommand(tmpProject(), 'test');
    assert.strictEqual(r.ran, false);
    assert.strictEqual(r.passed, true);
});

test('build-test.runGateCommand passes through injected runner', () => {
    const dir = tmpProject();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }), 'utf-8');
    const fakeRunner = () => ({ exitCode: 1, stdout: 'boom', stderr: '', timedOut: false });
    const r = buildTest.runGateCommand(dir, 'test', { runner: fakeRunner });
    assert.strictEqual(r.ran, true);
    assert.strictEqual(r.passed, false);
    assert.match(r.output, /boom/);
});

// --- gates/pipeline.js -----------------------------------------------------

test('gates.runPipeline: P3 fail → passed:false, failures:[P3]', () => {
    const fakeGate = (_dir, kind) => kind === 'test'
        ? { ran: true, passed: false, output: '1 failing', durationMs: 5 }
        : { ran: true, passed: true, output: 'ok', durationMs: 5 };
    const res = runPipeline('/x', { runGate: fakeGate });
    assert.strictEqual(res.passed, false);
    assert.deepStrictEqual(res.failures, ['P3']);
    // P0/P4/P5 are placeholders
    assert.strictEqual(res.results.find((r) => r.id === 'P0').status, 'skipped');
});

test('gates.runPipeline: all gates skipped (no commands) → passed:true', () => {
    const fakeGate = () => ({ ran: false, passed: true, output: 'no command', durationMs: 0 });
    const res = runPipeline('/x', { runGate: fakeGate });
    assert.strictEqual(res.passed, true);
    assert.strictEqual(res.failures.length, 0);
    assert.ok(res.results.every((r) => r.status === 'skipped'));
});

test('gates.runPipeline: --only filters by id', () => {
    const fakeGate = () => ({ ran: true, passed: true, output: 'ok', durationMs: 1 });
    const res = runPipeline('/x', { only: 'P3', runGate: fakeGate });
    assert.strictEqual(res.results.length, 1);
    assert.strictEqual(res.results[0].id, 'P3');
});
