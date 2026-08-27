'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ContextSchema } = require('../lib/dual/contracts');
const {
    buildAgyInvocation,
    runProcess,
    terminateProcessTree,
} = require('../lib/dual/agy-runner');
const { extractAgyPayload } = require('../lib/dual/agy-output');
const { resolveRegisteredAgyProjectId } = require('../lib/dual/agy-project');

const FAKE_AGY = path.join(__dirname, 'fixtures', 'codex-gemini', 'fake-agy.cjs');

function makeFixture(t) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dual-agy-'));
    const runDir = path.join(repoRoot, '.omni', 'dual', 'task');
    fs.mkdirSync(runDir, { recursive: true });
    const inputPath = path.join(runDir, 'scout.1.input.md');
    const schemaPath = path.join(runDir, 'scout.1.schema.json');
    fs.writeFileSync(inputPath, 'Inspect only the bounded repository scope.\n', 'utf8');
    fs.writeFileSync(schemaPath, '{}\n', 'utf8');
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    return { repoRoot, inputPath, schemaPath };
}

function fakeInvocation(t, behavior, timeoutMs = 2_000) {
    const fixture = makeFixture(t);
    return {
        invocation: buildAgyInvocation({
            agyCommand: process.execPath,
            agyPrefixArgs: [FAKE_AGY],
            ...fixture,
            phase: 'scout',
            timeoutMs,
        }),
        env: { ...process.env, FAKE_AGY_BEHAVIOR: behavior },
    };
}

test('builds a shell-free bounded Agy argv without embedding task content', (t) => {
    const { repoRoot, inputPath, schemaPath } = makeFixture(t);
    const invocation = buildAgyInvocation({
        agyCommand: process.execPath,
        agyPrefixArgs: [FAKE_AGY],
        repoRoot,
        phase: 'implement',
        inputPath,
        schemaPath,
        timeoutMs: 90_000,
    });

    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.args[0], FAKE_AGY);
    assert.deepEqual(invocation.args.slice(1, 17), [
        '--new-project',
        '--add-dir', repoRoot,
        '--model', 'gemini-3.7-flash-high',
        '--effort', 'high',
        '--mode', 'accept-edits',
        '--dangerously-skip-permissions',
        '--print-timeout', '1m',
        '--output-format', 'json',
        '--json-schema', schemaPath,
    ]);
    assert.match(invocation.args.at(-1), /^-p=Read /);
    assert.match(invocation.args.at(-1), /\.omni\/dual\/task\/scout\.1\.input\.md/);
    assert.doesNotMatch(invocation.args.at(-1), /Inspect only|\{.*\}/);
    assert.equal(invocation.cwd, repoRoot);
    assert.equal(invocation.timeoutMs, 90_000);
    assert.equal(invocation.args.includes('--disable-slash-commands'), false);
    assert.deepEqual(invocation.redactedArgs, invocation.args);
});

test('derives a long quality-first print timeout and adds only a bounded retry hint', (t) => {
    const fixture = makeFixture(t);
    const invocation = buildAgyInvocation({
        ...fixture,
        phase: 'review',
        timeoutMs: 1_230_000,
        retryHint: 'Previous output failed strict contract validation; re-read the evidence and return valid JSON.',
    });

    const timeoutIndex = invocation.args.indexOf('--print-timeout');
    assert.equal(invocation.args[timeoutIndex + 1], '20m');
    assert.match(invocation.args.at(-1), /Previous output failed strict contract validation/);
    assert.throws(
        () => buildAgyInvocation({
            ...fixture,
            phase: 'review',
            timeoutMs: 1_230_000,
            retryHint: 'x'.repeat(257),
        }),
        (error) => error.code === 'DUAL_AGY_RETRY_HINT_INVALID',
    );
});

test('reuses a registered AGY project instead of creating and indexing a new project per phase', (t) => {
    const fixture = makeFixture(t);
    const projectId = '8ac324ea-d79b-4c37-8301-cbddc3f0883f';
    const invocation = buildAgyInvocation({
        ...fixture,
        agyPrefixArgs: ['--project', projectId],
        phase: 'scout',
        timeoutMs: 120_000,
    });

    assert.deepEqual(invocation.args.slice(0, 2), ['--project', projectId]);
    assert.equal(invocation.args.includes('--new-project'), false);
    assert.equal(invocation.args.includes('--add-dir'), false);
});

test('resolves a strict registered AGY project id from project manifest or legacy user mapping', (t) => {
    const { repoRoot } = makeFixture(t);
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-agy-home-'));
    t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
    const projectId = '8ac324ea-d79b-4c37-8301-cbddc3f0883f';

    const omniDir = path.join(repoRoot, '.omni');
    fs.mkdirSync(omniDir, { recursive: true });
    fs.writeFileSync(path.join(omniDir, 'manifest.json'), JSON.stringify({ agyProjectId: projectId }));
    assert.equal(resolveRegisteredAgyProjectId(repoRoot, { homeDir }), projectId);

    fs.unlinkSync(path.join(omniDir, 'manifest.json'));
    const geminiDir = path.join(homeDir, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    fs.writeFileSync(path.join(geminiDir, 'projects.json'), JSON.stringify({ projects: { [repoRoot]: projectId } }));
    assert.equal(resolveRegisteredAgyProjectId(repoRoot, { homeDir }), projectId);

    fs.writeFileSync(path.join(geminiDir, 'projects.json'), JSON.stringify({ projects: { [repoRoot]: 'unsafe id' } }));
    assert.equal(resolveRegisteredAgyProjectId(repoRoot, { homeDir }), null);
});

test('uses accept-edits only for implementation and plan mode for read-only phases', (t) => {
    const fixture = makeFixture(t);
    for (const [phase, expectedMode] of [
        ['implement', 'accept-edits'],
        ['scout', 'plan'],
        ['review', 'plan'],
    ]) {
        const invocation = buildAgyInvocation({ ...fixture, phase, timeoutMs: 1_000 });
        const modeIndex = invocation.args.indexOf('--mode');
        assert.equal(invocation.args[modeIndex + 1], expectedMode, phase);
    }
});

test('spawns with shell false and preserves Unicode output', async (t) => {
    const { invocation, env } = fakeInvocation(t, 'success');
    let spawnOptions;
    const result = await runProcess(invocation, {
        env,
        spawn(command, args, options) {
            spawnOptions = options;
            return childProcess.spawn(command, args, options);
        },
    });

    assert.equal(spawnOptions.shell, false);
    assert.equal(spawnOptions.windowsHide, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.match(result.stdout, /Phân tích hoàn tất/);
    assert.match(result.stderr, /cảnh báo Unicode/);
    assert.ok(result.startedAt instanceof Date);
    assert.ok(result.endedAt instanceof Date);
    assert.ok(result.durationMs >= 0);
});

test('extracts native structured output and validates its schema', async (t) => {
    const { invocation, env } = fakeInvocation(t, 'success');
    const result = await runProcess(invocation, { env });
    const extracted = extractAgyPayload(result, ContextSchema);

    assert.equal(extracted.payload.task_id, 'bootstrap-task');
    assert.equal(extracted.extractionMode, 'structured_output');
    assert.deepEqual(extracted.warnings, []);
});

test('accepts zero-exit compatibility payloads with explicit warnings', async (t) => {
    for (const [behavior, extractionMode, warning] of [
        ['outer_error_valid', 'structured_output', 'outer_error_valid_payload'],
        ['response_json', 'response_json', 'response_json'],
        ['fenced_json', 'legacy_fenced_json', 'legacy_fenced_json'],
    ]) {
        const { invocation, env } = fakeInvocation(t, behavior);
        const result = await runProcess(invocation, { env });
        const extracted = extractAgyPayload(result, ContextSchema);
        assert.equal(extracted.extractionMode, extractionMode);
        assert.ok(extracted.warnings.includes(warning));
        assert.equal(extracted.payload.summary, 'Phân tích hoàn tất');
    }
});

test('fails closed on malformed, empty, and non-zero output', async (t) => {
    for (const [behavior, code] of [
        ['malformed', 'DUAL_AGY_OUTPUT_MALFORMED'],
        ['empty', 'DUAL_AGY_EMPTY_OUTPUT'],
        ['nonzero', 'DUAL_AGY_EXIT_NONZERO'],
        ['permission_denied', 'DUAL_AGY_EXIT_NONZERO'],
    ]) {
        const { invocation, env } = fakeInvocation(t, behavior);
        const result = await runProcess(invocation, { env });
        assert.throws(
            () => extractAgyPayload(result, ContextSchema),
            (error) => error.code === code,
            behavior,
        );
    }
});

test('rejects a non-zero exit even when stdout contains a valid payload', async (t) => {
    const { invocation, env } = fakeInvocation(t, 'nonzero_valid');
    const result = await runProcess(invocation, { env });
    assert.match(result.stdout, /structured_output/);
    assert.throws(
        () => extractAgyPayload(result, ContextSchema),
        (error) => error.code === 'DUAL_AGY_EXIT_NONZERO',
    );
});

test('times out and terminates the fake worker process tree', async (t) => {
    const { invocation, env } = fakeInvocation(t, 'timeout', 80);
    const result = await runProcess(invocation, { env, terminationGraceMs: 20 });

    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.durationMs < 3_000);
});

test('uses taskkill.exe with shell false for Windows process trees', async () => {
    const calls = [];
    const helper = {
        once(event, callback) {
            if (event === 'close') queueMicrotask(() => callback(0));
            return helper;
        },
    };
    await terminateProcessTree({ pid: 321, exitCode: null }, {
        platform: 'win32',
        spawnHelper(command, args, options) {
            calls.push({ command, args, options });
            return helper;
        },
    });

    assert.deepEqual(calls, [{
        command: 'taskkill.exe',
        args: ['/PID', '321', '/T', '/F'],
        options: { shell: false, windowsHide: true, stdio: 'ignore' },
    }]);
});

test('uses bounded negative-PID signals for POSIX process groups', async () => {
    const signals = [];
    const child = { pid: 654, exitCode: null };
    await terminateProcessTree(child, {
        platform: 'linux',
        processKill(pid, signal) {
            signals.push([pid, signal]);
        },
        delay: async () => {},
    });

    assert.deepEqual(signals, [
        [-654, 'SIGTERM'],
        [-654, 'SIGKILL'],
    ]);
});
