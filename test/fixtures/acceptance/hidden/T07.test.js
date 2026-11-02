'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, cli } = require('./helpers.cjs');

test('T07: list --json preserves book values and has README instructions', (t) => {
    const books = [{ id: 'a', title: 'A "quote"', author: 'Reader', price: 0, publishedAt: null }];
    const output = cli(t, books, ['list', '--json']);
    assert.ok(output.trim().startsWith('['), 'list --json must emit a JSON array');
    assert.deepEqual(JSON.parse(output), books);
    assert.deepEqual(JSON.parse(cli(t, [], ['list', '--json'])), []);
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    assert.match(readme, /list[^\n]*--json/);
    assert.match(readme, /JSON/i);
});
