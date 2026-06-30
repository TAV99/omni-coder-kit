'use strict';

// SPEC-FIX-ANTIGRAVITY-WORKSPACE.md §5 — host-cli must scope agy to the
// project directory via --add-dir and align --print-timeout with the
// harness OS timeout so a real run does not silently lose track of the
// agent's work.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const hostCli = require('../lib/harness/providers/host-cli');
const { buildCommand, create } = hostCli;

describe('buildCommand — antigravity scoping (--add-dir + --print-timeout)', () => {
    test('with projectDir + printTimeoutSec → adds both flags + yolo + -p', () => {
        const { cmd } = buildCommand('antigravity', 'hello', {
            projectDir: '/x/y', printTimeoutSec: 570,
        });
        assert.match(cmd, /^agy /);
        assert.match(cmd, /--dangerously-skip-permissions/);
        assert.match(cmd, /--add-dir "\/x\/y"/);
        assert.match(cmd, /--print-timeout 570s/);
        assert.match(cmd, / -p "hello"$/);
        // --add-dir must precede the final -p (the prompt flag), so the
        // workspace is configured before the prompt is consumed.
        assert.ok(cmd.indexOf('--add-dir') < cmd.lastIndexOf(' -p '),
            '--add-dir should appear before the -p prompt flag');
    });

    test('without projectDir → no --add-dir (backward-safe), still has -p', () => {
        const { cmd } = buildCommand('antigravity', 'hi', {});
        assert.doesNotMatch(cmd, /--add-dir/);
        assert.match(cmd, /-p "hi"/);
    });

    test('without printTimeoutSec → no --print-timeout', () => {
        const { cmd } = buildCommand('antigravity', 'hi', { projectDir: '/x' });
        assert.doesNotMatch(cmd, /--print-timeout/);
        assert.match(cmd, /--add-dir "\/x"/);
    });

    test('model is still emitted alongside add-dir + print-timeout', () => {
        const { cmd } = buildCommand('antigravity', 'p', {
            projectDir: '/x', printTimeoutSec: 300, model: 'gemini-3-pro',
        });
        assert.match(cmd, /--model gemini-3-pro/);
        assert.match(cmd, /--add-dir "\/x"/);
        assert.match(cmd, /--print-timeout 300s/);
    });

    test('JSON-encoded projectDir handles spaces + special chars', () => {
        const { cmd } = buildCommand('antigravity', 'p', {
            projectDir: '/Users/me/My Project',
        });
        assert.match(cmd, /--add-dir "\/Users\/me\/My Project"/);
    });
});

describe('buildCommand — other IDEs untouched by the antigravity-specific opts', () => {
    test('claudecode ignores projectDir / printTimeoutSec', () => {
        const { cmd } = buildCommand('claudecode', 'p', {
            projectDir: '/x/y', printTimeoutSec: 600,
        });
        assert.doesNotMatch(cmd, /--add-dir/);
        assert.doesNotMatch(cmd, /--print-timeout/);
        assert.match(cmd, /^claude /);
    });

    test('codex ignores projectDir / printTimeoutSec', () => {
        const { cmd } = buildCommand('codex', 'p', { projectDir: '/x' });
        assert.doesNotMatch(cmd, /--add-dir/);
        assert.match(cmd, /^codex /);
    });

    test('gemini ignores projectDir', () => {
        const { cmd } = buildCommand('gemini', 'p', { projectDir: '/x' });
        assert.doesNotMatch(cmd, /--add-dir/);
        assert.match(cmd, /^gemini /);
    });
});

describe('create() — runStep wires printTimeoutSec = timeoutMs/1000 − 30', () => {
    test('runStep passes --add-dir + --print-timeout derived from timeoutMs', async () => {
        const seen = [];
        const fakeRun = (cmd) => { seen.push(cmd); return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }; };
        const prov = hostCli.create({ ide: 'antigravity', timeoutMs: 600000, runCommand: fakeRun });

        await prov.runStep('cook', { projectDir: '/work/proj' });
        assert.equal(seen.length, 1);
        const cmd = seen[0];
        // 600s − 30s = 570s.
        assert.match(cmd, /--print-timeout 570s/);
        assert.match(cmd, /--add-dir "\/work\/proj"/);
        // Confirms the prompt anchor line is also embedded.
        assert.match(cmd, /Your working directory is `\/work\/proj`/);
        assert.match(cmd, /do NOT use any scratch directory/);
    });

    test('floor: very small timeoutMs → printTimeoutSec stays ≥30s', async () => {
        const seen = [];
        const fakeRun = (cmd) => { seen.push(cmd); return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; };
        const prov = hostCli.create({ ide: 'antigravity', timeoutMs: 1000, runCommand: fakeRun });
        await prov.runStep('cook', { projectDir: '/p' });
        assert.match(seen[0], /--print-timeout 30s/);
    });

    test('buildCommand field (public) also receives projectDir + printTimeoutSec', () => {
        const prov = hostCli.create({ ide: 'antigravity', timeoutMs: 600000 });
        const built = prov.buildCommand('cook', { projectDir: '/p', workflowPath: '/wf' });
        assert.match(built.cmd, /--add-dir "\/p"/);
        assert.match(built.cmd, /--print-timeout 570s/);
    });

    test('claudecode runStep cmd has no add-dir / print-timeout', async () => {
        const seen = [];
        const fakeRun = (cmd) => { seen.push(cmd); return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; };
        const prov = hostCli.create({ ide: 'claudecode', timeoutMs: 600000, runCommand: fakeRun });
        await prov.runStep('cook', { projectDir: '/p' });
        assert.doesNotMatch(seen[0], /--add-dir/);
        assert.doesNotMatch(seen[0], /--print-timeout/);
    });
});

describe('promptFor anchoring (via runStep / buildCommand)', () => {
    test('with projectDir → "Your working directory is `<dir>`" + no-scratch line', () => {
        const prov = hostCli.create({ ide: 'antigravity', timeoutMs: 600000 });
        const built = prov.buildCommand('cook', { projectDir: '/abs/proj', workflowPath: '/wf.md' });
        assert.match(built.cmd, /Your working directory is `\/abs\/proj`/);
        assert.match(built.cmd, /do NOT use any scratch directory/);
    });

    test('without projectDir → no anchor line', () => {
        const prov = hostCli.create({ ide: 'antigravity', timeoutMs: 600000 });
        const built = prov.buildCommand('cook', { workflowPath: '/wf.md' });
        assert.doesNotMatch(built.cmd, /Your working directory is/);
        assert.doesNotMatch(built.cmd, /scratch directory/);
    });
});
