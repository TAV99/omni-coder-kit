'use strict';

// P3e (SPEC-SQUAD-P3 §6): `omni squad run|resume|status|bootstrap|qc` are the
// same commands as `omni dual …`; dual keeps working and agents see no change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.resolve(__dirname, '../bin/omni.js');
const SESSION = ['run', 'resume', 'status', 'bootstrap', 'qc'];

function repo(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-squad-alias-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test User');
    git('config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(root, 'index.html'), '<html><body>Hello</body></html>\n');
    git('add', '.');
    git('commit', '-m', 'initial commit');
    return root;
}

const cli = (args, cwd) => {
    const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', shell: false, windowsHide: true,
        env: { ...process.env, OMNI_DUAL_WORKER_MODEL: 'gemini-3.7-flash-high', OMNI_DUAL_WORKER_EFFORT: 'high' } });
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
};

test('squad lists the session commands with the same options as dual', () => {
    const help = (group) => cli([group, '--help'], process.cwd()).stdout;
    for (const name of SESSION) {
        assert.match(help('squad'), new RegExp(`^  ${name}\\b`, 'm'), `squad ${name}`);
        assert.match(help('dual'), new RegExp(`^  ${name}\\b`, 'm'), `dual ${name}`);
    }
    for (const name of ['qc', 'bootstrap']) {
        const options = (group) => cli([group, name, '--help'], process.cwd()).stdout.replace(/^Usage: omni \w+/m, 'Usage: omni X');
        assert.equal(options('squad'), options('dual'), `${name} options match`);
    }
});

test('omni squad status and omni dual status give the same result on the same task', (t) => {
    const root = repo(t);
    assert.equal(cli(['dual', 'new', 'TASK-ALIAS-1'], root).exitCode, 0);
    const viaSquad = cli(['squad', 'status', 'TASK-ALIAS-1'], root);
    const viaDual = cli(['dual', 'status', 'TASK-ALIAS-1'], root);
    assert.equal(viaSquad.exitCode, 0);
    assert.deepEqual(viaSquad, viaDual, 'same stdout, stderr and exit code');
    assert.match(viaSquad.stdout, /TASK-ALIAS-1/);
    const missing = [cli(['squad', 'status', 'NOPE'], root), cli(['dual', 'status', 'NOPE'], root)];
    assert.deepEqual(missing[0], missing[1]);
    assert.match(missing[0].stderr, /DUAL_TASK_NOT_FOUND/);
});

test('without a terminal the dual alias hint stays out of every stream', (t) => {
    const root = repo(t);
    cli(['dual', 'new', 'TASK-ALIAS-2'], root);
    const status = cli(['dual', 'status', 'TASK-ALIAS-2'], root);
    assert.equal(status.stderr, '');
    assert.doesNotMatch(status.stdout, /omni squad status/);
});
