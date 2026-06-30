'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const hostCli = require('../lib/harness/providers/host-cli');
const { buildCommand, create } = hostCli;

describe('buildCommand — antigravity scoping (--add-dir + --print-timeout)', () => {
    test('with projectDir + printTimeoutSec → adds both flags + yolo + -p', () => {
        const { argv } = buildCommand('antigravity', 'hello', {
            projectDir: '/x/y', printTimeoutSec: 570,
        });
        assert.strictEqual(argv[0], 'agy');
        assert.ok(argv.includes('--dangerously-skip-permissions'));
        assert.ok(argv.includes('--add-dir'));
        assert.strictEqual(argv[argv.indexOf('--add-dir') + 1], '/x/y');
        assert.ok(argv.includes('--print-timeout'));
        assert.strictEqual(argv[argv.indexOf('--print-timeout') + 1], '570s');
        assert.strictEqual(argv[argv.length - 2], '-p');
        assert.strictEqual(argv[argv.length - 1], 'hello');
        
        // --add-dir must precede the final -p (the prompt flag)
        assert.ok(argv.indexOf('--add-dir') < argv.indexOf('-p'));
    });

    test('without projectDir → no --add-dir (backward-safe), still has -p', () => {
        const { argv } = buildCommand('antigravity', 'hi', {});
        assert.ok(!argv.includes('--add-dir'));
        assert.strictEqual(argv[argv.length - 2], '-p');
        assert.strictEqual(argv[argv.length - 1], 'hi');
    });

    test('without printTimeoutSec → no --print-timeout', () => {
        const { argv } = buildCommand('antigravity', 'hi', { projectDir: '/x' });
        assert.ok(!argv.includes('--print-timeout'));
        assert.ok(argv.includes('--add-dir'));
        assert.strictEqual(argv[argv.indexOf('--add-dir') + 1], '/x');
    });

    test('model is still emitted alongside add-dir + print-timeout', () => {
        const { argv } = buildCommand('antigravity', 'p', {
            projectDir: '/x', printTimeoutSec: 300, model: 'gemini-3-pro',
        });
        assert.ok(argv.includes('--model'));
        assert.strictEqual(argv[argv.indexOf('--model') + 1], 'gemini-3-pro');
        assert.ok(argv.includes('--add-dir'));
        assert.ok(argv.includes('--print-timeout'));
    });

    test('projectDir handles spaces + special chars literal', () => {
        const { argv } = buildCommand('antigravity', 'p', {
            projectDir: '/Users/me/My Project',
        });
        assert.ok(argv.includes('--add-dir'));
        assert.strictEqual(argv[argv.indexOf('--add-dir') + 1], '/Users/me/My Project');
    });
});

describe('buildCommand — other IDEs untouched by the antigravity-specific opts', () => {
    test('claudecode ignores projectDir / printTimeoutSec', () => {
        const { argv } = buildCommand('claudecode', 'p', {
            projectDir: '/x/y', printTimeoutSec: 600,
        });
        assert.ok(!argv.includes('--add-dir'));
        assert.ok(!argv.includes('--print-timeout'));
        assert.strictEqual(argv[0], 'claude');
    });

    test('codex ignores projectDir / printTimeoutSec', () => {
        const { argv } = buildCommand('codex', 'p', { projectDir: '/x' });
        assert.ok(!argv.includes('--add-dir'));
        assert.strictEqual(argv[0], 'codex');
    });

    test('gemini ignores projectDir', () => {
        const { argv } = buildCommand('gemini', 'p', { projectDir: '/x' });
        assert.ok(!argv.includes('--add-dir'));
        assert.strictEqual(argv[0], 'gemini');
    });
});

describe('create() — runStep wires printTimeoutSec = timeoutMs/1000 − 30', () => {
    test('runStep passes --add-dir + --print-timeout derived from timeoutMs', async () => {
        const seen = [];
        const fakeRun = (argv) => { seen.push(argv); return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }; };
        const prov = hostCli.create({ ide: 'antigravity', timeoutMs: 600000, runCommand: fakeRun });

        await prov.runStep('cook', { projectDir: '/work/proj' });
        assert.strictEqual(seen.length, 1);
        const argv = seen[0];
        // 600s − 30s = 570s.
        assert.ok(argv.includes('570s'));
        assert.ok(argv.includes('/work/proj'));
        // Confirms the prompt anchor line is also embedded.
        const prompt = argv[argv.length - 1];
        assert.match(prompt, /Your working directory is `\/work\/proj`/);
        assert.match(prompt, /do NOT use any scratch directory/);
    });

    test('floor: very small timeoutMs → printTimeoutSec stays ≥30s', async () => {
        const seen = [];
        const fakeRun = (argv) => { seen.push(argv); return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; };
        const prov = hostCli.create({ ide: 'antigravity', timeoutMs: 1000, runCommand: fakeRun });
        await prov.runStep('cook', { projectDir: '/p' });
        assert.ok(seen[0].includes('30s'));
    });

    test('buildCommand field (public) also receives projectDir + printTimeoutSec', () => {
        const prov = hostCli.create({ ide: 'antigravity', timeoutMs: 600000 });
        const built = prov.buildCommand('cook', { projectDir: '/p', workflowPath: '/wf' });
        assert.ok(built.argv.includes('/p'));
        assert.ok(built.argv.includes('570s'));
    });

    test('claudecode runStep cmd has no add-dir / print-timeout', async () => {
        const seen = [];
        const fakeRun = (argv) => { seen.push(argv); return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; };
        const prov = hostCli.create({ ide: 'claudecode', timeoutMs: 600000, runCommand: fakeRun });
        await prov.runStep('cook', { projectDir: '/p' });
        assert.ok(!seen[0].includes('--add-dir'));
        assert.ok(!seen[0].includes('--print-timeout'));
    });
});

describe('promptFor anchoring (via runStep / buildCommand)', () => {
    test('with projectDir → "Your working directory is `<dir>`" + no-scratch line', () => {
        const prov = hostCli.create({ ide: 'antigravity', timeoutMs: 600000 });
        const built = prov.buildCommand('cook', { projectDir: '/abs/proj', workflowPath: '/wf.md' });
        const prompt = built.argv[built.argv.length - 1];
        assert.match(prompt, /Your working directory is `\/abs\/proj`/);
        assert.match(prompt, /do NOT use any scratch directory/);
    });

    test('without projectDir → no anchor line', () => {
        const prov = hostCli.create({ ide: 'antigravity', timeoutMs: 600000 });
        const built = prov.buildCommand('cook', { workflowPath: '/wf.md' });
        const prompt = built.argv[built.argv.length - 1];
        assert.doesNotMatch(prompt, /Your working directory is/);
        assert.doesNotMatch(prompt, /scratch directory/);
    });
});

describe('promptFor wording - playbook instruction', () => {
    test('promptFor contains read & do NOT execute instructions, drops execute wording', () => {
        const prompt = hostCli.promptFor('fix', {
            workflowPath: '.omni/workflows/debugger-workflow.md',
            projectDir: '/p',
            sharedBrief: 'my brief'
        });

        // KHÔNG chứa wording cũ
        assert.doesNotMatch(prompt, /run ALL files/);
        assert.doesNotMatch(prompt, /execute the >om:/);

        // CÓ chứa wording mới để ngăn chặn execution của .md
        assert.match(prompt, /do NOT run or execute that file/i);
        assert.match(prompt, /READ/);
        assert.match(prompt, /FOLLOWING/);

        // Vẫn chứa các thông tin quan trọng khác
        assert.match(prompt, /\.omni\/workflows\/debugger-workflow\.md/);
        assert.match(prompt, /\/p/);
        assert.match(prompt, /do NOT use any scratch/);
        assert.match(prompt, /Do not summarize/);
        assert.match(prompt, /my brief/);
    });

    test('promptFor without projectDir has no dirLine but still has READ/do NOT run/FOLLOW', () => {
        const prompt = hostCli.promptFor('cook', {
            workflowPath: '.omni/workflows/coder-execution.md'
        });

        assert.doesNotMatch(prompt, /Your working directory is/);
        assert.match(prompt, /READ/);
        assert.match(prompt, /do NOT run or execute/i);
        assert.match(prompt, /FOLLOW/);
    });
});
