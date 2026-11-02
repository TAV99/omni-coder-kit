'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('CLI add persists a book and list renders it', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookshelf-cli-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'books.json');
    const cli = (...args) => {
        const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/cli.js'), ...args, '--file', file], { encoding: 'utf8', timeout: 5000 });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
    };
    assert.equal(cli('list'), '');
    assert.equal(cli('add', '--id', 'a', '--title', 'Dune', '--author', 'Frank Herbert', '--price', '12', '--published-at', '1965-08-01'), 'Added a\n');
    assert.equal(cli('list'), 'a | Dune | Frank Herbert | 12.00 | 1965-08-01\n');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].id, 'a');
});
