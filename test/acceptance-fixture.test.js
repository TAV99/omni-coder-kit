'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DualPlanTaskSchema } = require('../lib/dual/contracts');

const FIXTURE = path.join(__dirname, 'fixtures', 'acceptance');
const PROJECT = path.join(FIXTURE, 'bookshelf');
const IDS = Array.from({ length: 10 }, (_, index) => `T${String(index + 1).padStart(2, '0')}`);
const SCOPES = [
    ['lib/catalog.js'], ['lib/catalog.js'], ['lib/csv.js', 'test/csv.test.js'],
    ['lib/catalog.js', 'bin/cli.js'], ['lib/format.js', 'lib/report.js', 'bin/cli.js'],
    ['test/format.test.js'], ['bin/cli.js', 'README.md'], ['lib/csv.js'],
    ['lib/report.js'], ['lib/report.js'],
];

function suite() {
    assert.ok(fs.existsSync(path.join(FIXTURE, 'tasks.json')), 'P7a task suite must exist');
    return JSON.parse(fs.readFileSync(path.join(FIXTURE, 'tasks.json'), 'utf8'));
}

function workspace(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-fixture-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    // The finance specification belongs to the controller until T08 asks for context.
    fs.cpSync(PROJECT, root, { recursive: true, filter: (file) => file !== path.join(PROJECT, 'plans', 'finance-format.md') });
    return root;
}

function command(root, program, args) {
    const env = { ...process.env, NODE_OPTIONS: '', FORCE_COLOR: '0', NO_COLOR: '1' };
    // A fresh runner must not inherit node:test's recursive-run sentinel.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', timeout: 30_000,
        env, maxBuffer: 2 * 1024 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, `${program} terminated: ${result.stderr}`);
    if (program === process.execPath) assert.match(result.stdout, /(?:#|ℹ) tests [1-9]\d*/, 'child runner must execute tests');
    return result;
}

function passes(result, label) {
    assert.equal(result.status, 0, `${label}\n${result.stdout}\n${result.stderr}`);
}

function installHidden(root, id) {
    fs.mkdirSync(path.join(root, 'hidden'));
    for (const name of ['helpers.cjs', `${id}.test.js`]) {
        fs.copyFileSync(path.join(FIXTURE, 'hidden', name), path.join(root, 'hidden', name));
    }
}

function rejects(result, label) {
    assert.equal(result.status, 1, `${label} must reject candidate\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /ERR_ASSERTION/, `${label} must fail an assertion, not a broken test`);
    assert.doesNotMatch(result.stdout + result.stderr, /MODULE_NOT_FOUND|SyntaxError/);
}

test('P7a v1: ten tasks have exact scopes and valid isolated metadata', () => {
    const data = suite();
    assert.equal(data.suite_version, 1);
    assert.deepEqual(data.tasks.map((task) => task.id), IDS);
    data.tasks.forEach((task, index) => {
        assert.deepEqual(task.allowed_files, SCOPES[index]);
        const { id, ...registration } = task;
        assert.equal(registration.task_id, id);
        DualPlanTaskSchema.parse(registration);
        assert.equal(registration.owner, 'worker');
        assert.equal(registration.execution_mode, 'isolated');
        assert.deepEqual(registration.validation_commands, [{ program: 'node', args: ['--test'], cwd: '.' }]);
        for (const file of task.context_files) assert.ok(fs.existsSync(path.join(PROJECT, file)), file);
        assert.ok(!task.context_files.includes('plans/finance-format.md'));
    });
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.test, 'node --test');
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        assert.equal(Object.keys(pkg[field] || {}).length, 0, `${field} must be empty`);
    }
});

for (const id of IDS) {
    test(`V46 ${id}: hidden red -> reference green; visible green; patch stays in scope`, (t) => {
        const task = suite().tasks.find((entry) => entry.id === id);
        const root = workspace(t);
        assert.ok(!fs.existsSync(path.join(root, 'hidden')));
        assert.ok(!fs.existsSync(path.join(root, 'plans', 'finance-format.md')));
        passes(command(root, process.execPath, ['--test']), `${id} baseline visible`);

        installHidden(root, id);
        const hidden = ['--test', `hidden/${id}.test.js`];
        const red = command(root, process.execPath, hidden);
        rejects(red, `${id} baseline`);

        const patch = path.join(FIXTURE, 'reference', `${id}.patch`);
        const touched = command(root, 'git', ['apply', '--numstat', patch]);
        passes(touched, `${id} patch scope`);
        const files = touched.stdout.trim().split('\n').map((line) => line.split('\t')[2]);
        assert.ok(files.length > 0);
        for (const file of files) assert.ok(task.allowed_files.includes(file), `${id} changed ${file}`);
        passes(command(root, 'git', ['apply', '--check', patch]), `${id} patch check`);
        passes(command(root, 'git', ['apply', patch]), `${id} apply`);
        passes(command(root, process.execPath, hidden), `${id} hidden with reference`);
        // Use explicit visible paths now that the hidden test is in the workspace.
        const visible = fs.readdirSync(path.join(root, 'test')).filter((name) => name.endsWith('.test.js'));
        passes(command(root, process.execPath, ['--test', ...visible.map((name) => `test/${name}`)]), `${id} reference visible`);
    });
}

test('T03 hidden rejects a correct parser without new visible regression tests', (t) => {
    const root = workspace(t);
    passes(command(root, 'git', ['apply', '--include=lib/csv.js', path.join(FIXTURE, 'reference/T03.patch')]), 'source-only T03 patch');
    passes(command(root, process.execPath, ['--test']), 'source-only T03 visible');
    installHidden(root, 'T03');
    const result = command(root, process.execPath, ['--test', 'hidden/T03.test.js']);
    rejects(result, 'T03 without regression tests');
    assert.match(result.stdout, /missed old comma-splitting CSV parser mutation/);
});

test('T06 hidden rejects weak tests that cover only zero, sign, one fraction and NaN', (t) => {
    const root = workspace(t);
    fs.appendFileSync(path.join(root, 'test/format.test.js'), `
test('incomplete edge coverage', () => {
    assert.equal(format.price(0), '0.00');
    assert.equal(format.price(-1), '-1.00');
    assert.equal(format.price(1.236), '1.24');
    assert.throws(() => format.price(NaN), TypeError);
});
`);
    passes(command(root, process.execPath, ['--test']), 'weak T06 visible');
    installHidden(root, 'T06');
    const result = command(root, process.execPath, ['--test', 'hidden/T06.test.js']);
    rejects(result, 'weak T06 tests');
    assert.match(result.stdout, /missed padding mutation/);
});

test('T06 sign probe cannot be satisfied by rejecting negative numeric strings', (t) => {
    const root = workspace(t);
    passes(command(root, 'git', ['apply', path.join(FIXTURE, 'reference/T06.patch')]), 'T06 reference');
    const file = path.join(root, 'test/format.test.js');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
        "assert.equal(format.price(-12.5), '-12.50');", "assert.throws(() => format.price('-12'), TypeError);"));
    passes(command(root, process.execPath, ['--test']), 'T06 without negative numeric coverage');
    installHidden(root, 'T06');
    const result = command(root, process.execPath, ['--test', 'hidden/T06.test.js']);
    rejects(result, 'T06 without negative numeric coverage');
    assert.match(result.stdout, /missed negative mutation/);
});
