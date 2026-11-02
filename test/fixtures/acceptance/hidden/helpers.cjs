'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const root = process.cwd();
const load = (file) => require(path.join(root, file));
function temp(t) {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bookshelf-hidden-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
function cli(t, books, args) {
    const file = path.join(temp(t), 'catalog.json');
    fs.writeFileSync(file, JSON.stringify(books));
    const result = spawnSync(process.execPath, [path.join(root, 'bin/cli.js'), ...args, '--file', file], { encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}
function rejectMutation(t, name, file, testFile, code) {
    const dir = temp(t);
    fs.cpSync(path.join(root, 'lib'), path.join(dir, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'test'));
    fs.copyFileSync(path.join(root, testFile), path.join(dir, testFile));
    fs.appendFileSync(path.join(dir, file), `\n(() => {\n${code}\n})();\n`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', testFile], { cwd: dir, env, encoding: 'utf8', timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1, `visible tests missed ${name} mutation\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /ERR_ASSERTION/, `mutation ${name} must be caught by an assertion`);
    assert.doesNotMatch(result.stdout + result.stderr, /SyntaxError|MODULE_NOT_FOUND/);
}
module.exports = { root, load, temp, cli, rejectMutation };
