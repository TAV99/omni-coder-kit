'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, load, temp, cli } = require('./helpers.cjs');

test('T05: preserve date output and delegate both report and CLI to format.date', (t) => {
    const format = load('lib/format.js');
    assert.equal(typeof format.date, 'function', 'format.date must be shared');
    const dates = [undefined, null, '', 'invalid', '1965-08-01', '2020-01-01T23:30:00-02:00'];
    for (const value of dates) {
        const date = value ? new Date(value) : null;
        const expected = date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : 'unknown';
        assert.equal(format.date(value), expected);
        const book = { id: 'a', title: 'Dune', author: 'Frank', price: 12, publishedAt: value };
        assert.equal(load('lib/report.js').summary([book]), `Books: 1\nTotal: 12.00\nLatest: ${expected}\n`);
        assert.equal(cli(t, [book], ['list']), `a | Dune | Frank | 12.00 | ${expected}\n`);
    }
    const file = path.join(temp(t), 'books.json');
    const book = { id: 'a', title: 'Dune', author: 'Frank', price: 12, publishedAt: '1965-08-01' };
    fs.writeFileSync(file, JSON.stringify([book]));
    const original = format.date;
    t.after(() => { format.date = original; });
    format.date = () => 'shared-date';
    // Reload callers so destructuring the shared function is also valid.
    for (const file of ['lib/report.js', 'bin/cli.js']) delete require.cache[require.resolve(path.join(root, file))];
    assert.match(load('lib/report.js').summary([book]), /Latest: shared-date\n$/);
    assert.match(load('bin/cli.js').run(['list', '--file', file]), /shared-date\n$/);
});
