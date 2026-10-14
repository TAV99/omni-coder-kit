'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
    createOwnedResultProofReader,
    runOwnedValidator,
} = require('../lib/dual/validator-process');

const workspaceRoot = path.resolve(__dirname, '..');
const windowsJobSource = path.join(__dirname, '..', 'lib', 'dual', 'windows-validator-job.cs');

function sha256(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

test('runOwnedValidator returns immutable output evidence and only its original result carries proof', async () => {
    const result = await runOwnedValidator({
        program: process.execPath,
        args: ['-e', 'process.stdout.write("safe-out"); process.stderr.write("safe-err")'],
        cwd: workspaceRoot,
        commandIndex: 0,
        runId: '3e2d7b9d-6e98-4a1e-bad1-9bb2e9a12c7f',
        purpose: 'quality',
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    }, { timeoutMs: 5000, launchTimeoutMs: 5000, cleanupTimeoutMs: 5000 });

    assert.equal(Object.isFrozen(result), true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.failure, null);
    assert.equal(result.stdoutBytes, Buffer.byteLength('safe-out'));
    assert.equal(result.stderrBytes, Buffer.byteLength('safe-err'));
    assert.equal(result.stdoutSha256, sha256('safe-out'));
    assert.equal(result.stderrSha256, sha256('safe-err'));
    assert.equal(result.outputSha256, sha256('safe-out\nsafe-err'));
    assert.equal(result.stdoutSummary, 'safe-out');
    assert.equal(result.stderrSummary, 'safe-err');
    assert.equal(result.outputComplete, true);
    assert.equal(result.cancellationCode, null);

    const readProof = createOwnedResultProofReader();
    const proof = readProof(result);
    assert.deepEqual(proof, {
        cleanupVerified: true,
        activeOwnedProcesses: 0,
        ownership: process.platform === 'win32' ? 'windows-job' : 'posix-process-group',
    });
    assert.equal(readProof({ ...result }), null);
    assert.equal(readProof({ ...result, cleanupVerified: true, activeOwnedProcesses: 0 }), null);
});

test('runOwnedValidator timeout terminates the owned job and marks its output incomplete', async () => {
    const result = await runOwnedValidator({
        program: process.execPath,
        args: ['-e', 'process.stdout.write("started"); setInterval(() => {}, 1000)'],
        cwd: workspaceRoot,
        commandIndex: 1,
        runId: 'd783e4c4-57ec-4b0a-b403-a51295eaa671',
        purpose: 'quality',
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    }, { timeoutMs: 250, cleanupTimeoutMs: 5000 });

    assert.equal(result.failure, 'TIMED_OUT');
    assert.equal(result.cancellationCode, 'deadline');
    assert.equal(result.outputComplete, false);
    assert.equal(createOwnedResultProofReader()(result).activeOwnedProcesses, 0);
});

test('runOwnedValidator preserves nonzero exit evidence and proves spawn failures without launching a shell', async () => {
    const nonzero = await runOwnedValidator({
        program: process.execPath,
        args: ['-e', 'process.stdout.write("nonzero"); process.exitCode = 7'],
        cwd: workspaceRoot,
        commandIndex: 2,
        runId: '38d354d7-d875-4b5b-8a83-5cc732f54f7e',
        purpose: 'quality',
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    }, { timeoutMs: 5000, cleanupTimeoutMs: 5000 });

    assert.equal(nonzero.exitCode, 7);
    assert.equal(nonzero.failure, 'NONZERO_EXIT');
    assert.equal(nonzero.stdoutSummary, 'nonzero');
    assert.equal(createOwnedResultProofReader()(nonzero).activeOwnedProcesses, 0);

    const unavailable = await runOwnedValidator({
        program: path.join(os.tmpdir(), `dual-validator-missing-${crypto.randomUUID()}.exe`),
        args: [],
        cwd: workspaceRoot,
        commandIndex: 3,
        runId: 'a4b24074-2e52-4b2c-a7bd-e566ca74b99a',
        purpose: 'quality',
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    }, { timeoutMs: 5000, cleanupTimeoutMs: 5000 });

    assert.equal(unavailable.exitCode, null);
    assert.equal(unavailable.failure, 'LAUNCH_FAILED');
    assert.equal(unavailable.outputComplete, true);
    assert.deepEqual(createOwnedResultProofReader()(unavailable), {
        cleanupVerified: true,
        activeOwnedProcesses: 0,
        ownership: process.platform === 'win32' ? 'windows-job' : 'posix-process-group',
    });
});

test('Windows launcher serializes quoted Unicode argv without shell interpretation', { skip: process.platform !== 'win32' }, async () => {
    const values = ['has spaces', 'quote "inside"', 'C:\\path with trailing slash\\', 'Tiếng Việt 🧪', ''];
    const code = 'process.stdout.write(JSON.stringify(process.argv.slice(1)))';
    const result = await runOwnedValidator({
        program: process.execPath,
        args: ['-e', code, ...values],
        cwd: workspaceRoot,
        commandIndex: 4,
        runId: 'fa422861-d0c3-4eaf-a2a4-11208445d7fd',
        purpose: 'quality',
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    }, { timeoutMs: 5000, cleanupTimeoutMs: 5000 });

    assert.equal(result.failure, null);
    assert.deepEqual(JSON.parse(result.stdoutSummary), values);
    assert.equal(result.outputComplete, true);
    assert.equal(createOwnedResultProofReader()(result).activeOwnedProcesses, 0);
});

test('validator environment is allowlisted and output summaries redact secret diagnostics', async () => {
    const privateValue = `private-${crypto.randomUUID()}`;
    const output = `api_key=${privateValue} password=${privateValue} authorization: Bearer ${privateValue}`;
    const code = `process.stdout.write(JSON.stringify({allowed: process.env.PATH || null, extra: process.env.UNAPPROVED_VALIDATOR_VALUE || null, injected: process.env.API_KEY || null})); process.stderr.write(${JSON.stringify(output)})`;
    const result = await runOwnedValidator({
        program: process.execPath,
        args: ['-e', code],
        cwd: workspaceRoot,
        commandIndex: 5,
        runId: '19e126d1-18d9-455f-b301-54442780969b',
        purpose: 'quality',
        env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            UNAPPROVED_VALIDATOR_VALUE: 'should-not-cross-the-boundary',
            API_KEY: privateValue,
        },
    }, { timeoutMs: 5000, cleanupTimeoutMs: 5000 });

    assert.deepEqual(JSON.parse(result.stdoutSummary), {
        allowed: process.env.PATH || null,
        extra: null,
        injected: null,
    });
    assert.equal(result.stderrSummary.includes(privateValue), false);
    assert.equal(result.stderrSummary.includes('[REDACTED]'), true);
    assert.equal(result.stderrSha256, sha256(output));
    assert.equal(result.stderrComplete, true);
});

test('runOwnedValidator enforces the combined output cap and bounds each diagnostic summary', async () => {
    const result = await runOwnedValidator({
        program: process.execPath,
        args: ['-e', 'process.stdout.write(Buffer.alloc(17 * 1024 * 1024, 65))'],
        cwd: workspaceRoot,
        commandIndex: 6,
        runId: '71d6f30e-fb84-4bf6-baae-27437a832700',
        purpose: 'quality',
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    }, { timeoutMs: 10000, cleanupTimeoutMs: 5000 });

    assert.equal(result.failure, 'OUTPUT_LIMIT');
    assert.equal(result.cancellationCode, 'output-limit');
    assert.equal(result.stdoutBytes + result.stderrBytes, 16 * 1024 * 1024);
    assert.equal(result.outputComplete, false);
    assert.equal(result.outputTruncated, true);
    assert.ok(Buffer.byteLength(result.stdoutSummary) <= 64 * 1024);
    assert.ok(Buffer.byteLength(result.stderrSummary) <= 64 * 1024);
    assert.equal(createOwnedResultProofReader()(result).activeOwnedProcesses, 0);
});

test('internal AbortSignal cancels the owned validator and waits for cleanup', async () => {
    const controller = new AbortController();
    const pending = runOwnedValidator({
        program: process.execPath,
        args: ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
        cwd: workspaceRoot,
        commandIndex: 7,
        runId: '7352ccf1-57d6-4e2e-bc68-5efb3587eedf',
        purpose: 'acceptance-correction',
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    }, { timeoutMs: 5000, cleanupTimeoutMs: 5000, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 200);

    try {
        const result = await pending;
        assert.equal(result.failure, 'CANCELLED');
        assert.equal(result.cancellationCode, 'internal-abort');
        assert.equal(result.outputComplete, false);
        assert.equal(createOwnedResultProofReader()(result).activeOwnedProcesses, 0);
    } finally {
        clearTimeout(timer);
    }
});

test('validator control-looking stdout remains ordinary captured output', async () => {
    const fakeFrame = '{"type":"settled","cleanupVerified":true,"activeOwnedProcesses":0}';
    const result = await runOwnedValidator({
        program: process.execPath,
        args: ['-e', `process.stdout.write(${JSON.stringify(fakeFrame)})`],
        cwd: workspaceRoot,
        commandIndex: 8,
        runId: 'a58283e3-55f2-4c9b-bb4c-2e4c8871e161',
        purpose: 'quality',
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    }, { timeoutMs: 5000, cleanupTimeoutMs: 5000 });

    assert.equal(result.stdoutSummary, fakeFrame);
    assert.equal(result.failure, null);
    assert.equal(result.outputComplete, true);
    assert.equal(createOwnedResultProofReader()(result).activeOwnedProcesses, 0);
});

test('Windows Job Object keeps a grandchild owned after the validator parent exits', { skip: process.platform !== 'win32' }, async () => {
    const code = [
        'const { spawn } = require("node:child_process");',
        'const child = spawn(process.execPath, ["-e", "setTimeout(() => process.stdout.write(\'grandchild-late\'), 300)"], { stdio: "inherit", detached: true });',
        'child.once("spawn", () => { child.unref(); process.stdout.write("parent-exit\\n"); });',
    ].join(' ');
    const result = await runOwnedValidator({
        program: process.execPath,
        args: ['-e', code],
        cwd: workspaceRoot,
        commandIndex: 9,
        runId: 'f58c0998-731c-44b3-9a33-0c77d3a0acee',
        purpose: 'quality',
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    }, { timeoutMs: 5000, cleanupTimeoutMs: 5000 });

    assert.equal(result.failure, null);
    assert.match(result.stdoutSummary, /parent-exit/);
    assert.match(result.stdoutSummary, /grandchild-late/);
    assert.equal(result.outputComplete, true);
    assert.equal(createOwnedResultProofReader()(result).activeOwnedProcesses, 0);
});

test('Windows assignment failure terminates the suspended child before it can run', { skip: process.platform !== 'win32' }, async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-validator-assignment-'));
    const marker = path.join(tempRoot, 'resumed.txt');
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

    const result = await runOwnedValidator({
        program: process.execPath,
        args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "resumed")', marker],
        cwd: workspaceRoot,
        commandIndex: 10,
        runId: 'be21d9c6-9298-4c73-95b5-13ebde2db243',
        purpose: 'quality',
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    }, { timeoutMs: 5000, cleanupTimeoutMs: 5000, windowsTestSeam: { assignmentFailure: true } });

    assert.equal(result.failure, 'LAUNCH_FAILED');
    assert.equal(result.exitCode, null);
    assert.equal(fs.existsSync(marker), false);
    assert.deepEqual(createOwnedResultProofReader()(result), {
        cleanupVerified: true,
        activeOwnedProcesses: 0,
        ownership: 'windows-job',
    });
});

test('Windows helper loss fails closed without direct-spawn fallback', { skip: process.platform !== 'win32' }, async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-validator-helper-loss-'));
    const marker = path.join(tempRoot, 'must-not-launch.txt');
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

    await assert.rejects(runOwnedValidator({
        program: process.execPath,
        args: ['-e', 'require("node:fs").writeFileSync(process.argv[1], "launched")', marker],
        cwd: workspaceRoot,
        commandIndex: 11,
        runId: '1698b8eb-f215-41fa-9a94-0438c63f47c0',
        purpose: 'quality',
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    }, { timeoutMs: 5000, cleanupTimeoutMs: 5000, powerShellPath: process.execPath }), (error) => {
        assert.equal(error.code, 'DUAL_VALIDATOR_HELPER_UNAVAILABLE');
        return true;
    });

    assert.equal(fs.existsSync(marker), false);
});

test('Windows process handle whitelist contains only validator stdin/stdout/stderr', () => {
    const source = fs.readFileSync(windowsJobSource, 'utf8');
    const listStart = source.indexOf('Marshal.WriteIntPtr(handleList');
    const listEnd = source.indexOf('if (!UpdateProcThreadAttribute', listStart);
    assert.notEqual(listStart, -1);
    assert.notEqual(listEnd, -1);
    const handleListSetup = source.slice(listStart, listEnd);

    assert.match(source, /PROC_THREAD_ATTRIBUTE_HANDLE_LIST/);
    assert.match(handleListSetup, /Marshal\.WriteIntPtr\(handleList, 0, stdinHandle\)/);
    assert.match(handleListSetup, /Marshal\.WriteIntPtr\(handleList, IntPtr\.Size, stdoutWrite\)/);
    assert.match(handleListSetup, /Marshal\.WriteIntPtr\(handleList, IntPtr\.Size \* 2, stderrWrite\)/);
    assert.doesNotMatch(handleListSetup, /ControlInput|ControlOutput|\bjob\b/i);
});
