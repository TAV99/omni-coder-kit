'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fsTool = require('../lib/harness/tools/fs');
const git = require('../lib/harness/tools/git');
const shell = require('../lib/harness/tools/shell');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-tools-')); }

// --- fs.js -----------------------------------------------------------------

test('fs.readFileSafe / writeFileSafe within .omni roundtrip', () => {
    const dir = tmp();
    fsTool.writeFileSafe(dir, '.omni/sdlc/todo.md', '- [ ] x\n');
    assert.strictEqual(fsTool.readFileSafe(dir, '.omni/sdlc/todo.md'), '- [ ] x\n');
});

test('fs.writeFileSafe blocks writing project source by default (scope lock)', () => {
    const dir = tmp();
    assert.throws(() => fsTool.writeFileSafe(dir, 'src/app.js', 'x'), /ngoài scope \.omni/);
    // explicit opt-in allowed
    assert.doesNotThrow(() => fsTool.writeFileSafe(dir, 'src/app.js', 'x', { allowOutsideSdlc: true }));
});

test('fs blocks path traversal outside projectDir', () => {
    const dir = tmp();
    assert.throws(() => fsTool.readFileSafe(dir, '../../etc/passwd'), /traversal/);
    assert.throws(() => fsTool.writeFileSafe(dir, '../escape.js', 'x', { allowOutsideSdlc: true }), /traversal/);
});

test('fs.applyPatch surgical replace', () => {
    const dir = tmp();
    fsTool.writeFileSafe(dir, 'src/x.js', 'const a = 1;\n', { allowOutsideSdlc: true });
    const r = fsTool.applyPatch(dir, 'src/x.js', { find: 'const a = 1;', replace: 'const a = 2;' });
    assert.strictEqual(r.changed, true);
    assert.match(fsTool.readFileSafe(dir, 'src/x.js'), /const a = 2;/);
    // no match → no change
    assert.strictEqual(fsTool.applyPatch(dir, 'src/x.js', { find: 'nope', replace: 'y' }).changed, false);
});

// --- git.js (injected runner — no real git) --------------------------------

test('git.status parses porcelain', () => {
    const runner = () => ({ exitCode: 0, stdout: ' M a.js\n?? b.js\n', stderr: '', timedOut: false });
    const s = git.status('/x', { runCommand: runner });
    assert.strictEqual(s.clean, false);
    assert.strictEqual(s.files.length, 2);
});

test('git.commit returns sha, never pushes', () => {
    const calls = [];
    const runner = (cmd) => {
        calls.push(cmd);
        if (cmd.startsWith('git rev-parse')) return { exitCode: 0, stdout: 'abc123\n', stderr: '', timedOut: false };
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };
    const r = git.commit('/x', 'feat: y', { addAll: true, runCommand: runner });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.sha, 'abc123');
    assert.ok(calls.some((c) => c.startsWith('git add -A')));
    assert.ok(!calls.some((c) => /git push/.test(c)), 'git.js must never push');
});

test('git module exposes no push function', () => {
    assert.strictEqual(typeof git.push, 'undefined');
});

// --- shell DENY now blocks any git push ------------------------------------

test('shell.isDenied blocks plain git push (no-push invariant)', () => {
    assert.ok(shell.isDenied('git push origin main'));
    assert.ok(shell.isDenied('git push --force origin main'));
    assert.ok(!shell.isDenied('git commit -m "x"'));
    assert.ok(!shell.isDenied('git status --porcelain'));
});

// --- shell.isAgentCommand for extended CLIs -------------------------------

test('shell.isAgentCommand recognizes extended CLIs', () => {
    assert.ok(shell.isAgentCommand('opencode'));
    assert.ok(shell.isAgentCommand('open-claude'));
    assert.ok(shell.isAgentCommand('openclaude'));
    assert.ok(shell.isAgentCommand('OpenCode')); // case-insensitive
    assert.ok(!shell.isAgentCommand('unknowncli'));
});

// --- PROMPT_PATTERNS --------------------------------------------------------

test('PROMPT_PATTERNS matches true positives', () => {
    const positives = [
        'Do you want to allow access? [y/N]',
        'Are you sure you want to continue?',
        'Proceed? (y/n)',
        'Press Y to continue',
        'Type "yes" to confirm deletion',
        'Allow network access? [y/N]',
        'approve this action? y/N',
    ];
    for (const input of positives) {
        assert.ok(shell.PROMPT_PATTERNS.some(re => re.test(input)), `Expected match for: ${input}`);
    }
});

test('PROMPT_PATTERNS rejects false positives', () => {
    const negatives = [
        'Tests confirmed passing',
        'Execute migration step 3...',
        'Make sure all files are saved',
        'Proceed to next step',
        '5 tests confirmed. All green.',
        'Permission denied: /usr/local/bin',
        'confirm: 5 records inserted',
        'Running execute_query()...',
    ];
    for (const input of negatives) {
        assert.ok(!shell.PROMPT_PATTERNS.some(re => re.test(input)), `Expected NO match for: ${input}`);
    }
});

// --- runCommandAsync auto-approve ------------------------------------------

test('runCommandAsync auto-approve writes y\\n to stdin on match', async () => {
    let stdinWritten = '';
    const fake = () => {
        const child = new (require('events').EventEmitter)();
        child.stdout = new (require('events').EventEmitter)();
        child.stderr = new (require('events').EventEmitter)();
        child.stdin = {
            writable: true,
            write: (data) => {
                stdinWritten += data;
            }
        };
        child.kill = () => {};
        setImmediate(() => {
            child.stdout.emit('data', Buffer.from('Are you sure? [y/N] '));
            child.emit('close', 0, null);
        });
        return child;
    };

    const res = await shell.runCommandAsync('echo hi', { spawnFn: fake, autoApprove: true });
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(stdinWritten, 'y\n');
});

test('runCommandAsync auto-approve disabled prevents auto-approve', async () => {
    let stdinWritten = '';
    const fake = () => {
        const child = new (require('events').EventEmitter)();
        child.stdout = new (require('events').EventEmitter)();
        child.stderr = new (require('events').EventEmitter)();
        child.stdin = {
            writable: true,
            write: (data) => {
                stdinWritten += data;
            }
        };
        child.kill = () => {};
        setImmediate(() => {
            child.stdout.emit('data', Buffer.from('Are you sure? [y/N] '));
            child.emit('close', 0, null);
        });
        return child;
    };

    const res = await shell.runCommandAsync('echo hi', { spawnFn: fake, autoApprove: false });
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(stdinWritten, '');
});

test('runCommandAsync auto-approve matches stderr prompts too', async () => {
    let stdinWritten = '';
    const fake = () => {
        const child = new (require('events').EventEmitter)();
        child.stdout = new (require('events').EventEmitter)();
        child.stderr = new (require('events').EventEmitter)();
        child.stdin = {
            writable: true,
            write: (data) => {
                stdinWritten += data;
            }
        };
        child.kill = () => {};
        setImmediate(() => {
            child.stderr.emit('data', Buffer.from('Allow connection? [y/N] '));
            child.emit('close', 0, null);
        });
        return child;
    };

    const res = await shell.runCommandAsync('echo hi', { spawnFn: fake, autoApprove: true });
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(stdinWritten, 'y\n');
});