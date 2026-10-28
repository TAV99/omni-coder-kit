'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const diagnostics = require.resolve('../lib/dual/daemon-diagnostics');

function child(source, executable) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-diagnostic-test-'));
    const out = path.join(root, 'stdout');
    const err = path.join(root, 'stderr');
    const stdout = fs.openSync(out, 'w');
    const stderr = fs.openSync(err, 'w');
    try {
        const preload = path.join(root, 'preload.cjs');
        fs.writeFileSync(preload, source);
        const args = executable ? ['--require', preload, executable] : [preload];
        const result = spawnSync(process.execPath, args, { stdio: ['ignore', stdout, stderr] });
        assert.ifError(result.error);
        return { ...result, stdout: fs.readFileSync(out, 'utf8'), stderr: fs.readFileSync(err, 'utf8') };
    } finally {
        fs.closeSync(stdout);
        fs.closeSync(stderr);
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('daemon diagnostics are bounded single-line JSON with redaction and no arbitrary payload', () => {
    const result = child(`require(${JSON.stringify(diagnostics)}).logDaemonDiagnostic('workerStart.failed', {
        task_id: 'task', revision_id: 'revision', code: 'ERR_TEST',
        message: 'failure\\ntoken=private-secret', contract: 'private-contract' });`);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    const lines = result.stderr.trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(new Date(entry.timestamp).toISOString(), entry.timestamp);
    assert.ok(entry.pid > 0);
    assert.equal(entry.event, 'workerStart.failed');
    assert.equal(entry.task_id, 'task');
    assert.equal(entry.revision_id, 'revision');
    assert.equal(entry.code, 'ERR_TEST');
    assert.match(entry.message, /REDACTED/);
    assert.doesNotMatch(result.stderr, /private-secret|private-contract/);
});

for (const event of ['uncaughtException', 'unhandledRejection']) {
    test(`daemon executable installs ${event} diagnostic before fatal exit`, () => {
        const executable = path.resolve(__dirname, '../bin/omni-daemon.js');
        // Invalid CLI arguments avoid starting providers; preload triggers a fatal event afterward.
        const result = child(`const error = Object.assign(new Error('token=private-secret'), { code: 'ERR_TEST' });
            ${event === 'uncaughtException' ? 'setImmediate(() => { throw error; });' : 'setImmediate(() => Promise.reject(error));'}`, executable);
        assert.equal(result.status, 1);
        const entry = JSON.parse(result.stderr.trim().split('\n').at(-1));
        assert.equal(entry.event, event);
        assert.equal(entry.code, 'ERR_TEST');
        assert.match(entry.message, /REDACTED/);
        assert.doesNotMatch(result.stderr, /private-secret/);
    });
}

test('importing daemon server as a library does not install fatal handlers', () => {
    const result = child(`const before = ['uncaughtException', 'unhandledRejection'].map(e => process.listenerCount(e));
        require(${JSON.stringify(require.resolve('../lib/dual/daemon-server'))});
        const after = ['uncaughtException', 'unhandledRejection'].map(e => process.listenerCount(e));
        require('node:assert/strict').deepEqual(after, before);`);
    assert.equal(result.status, 0, result.stderr);
});
