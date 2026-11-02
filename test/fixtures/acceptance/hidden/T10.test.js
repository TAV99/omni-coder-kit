'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

test('T10: byYear counts UTC years and groups missing/malformed dates as unknown', () => {
    const report = load('lib/report.js');
    const values = ['2020-02-29', '2020-12-31', '2021-01-01', undefined, null, '', 'nonsense', '2023-02-29', '2020-13-01', '2020-04-31', 2020, '2020', '2020-12-31T23:30:00-02:00'];
    const books = values.map((publishedAt) => ({ publishedAt }));
    const before = JSON.stringify(books);
    assert.deepEqual(report.byYear(books), { 2020: 2, 2021: 2, unknown: 9 });
    assert.equal(JSON.stringify(books), before);
    assert.deepEqual(report.byYear([]), {});
    assert.deepEqual(report.byYear([{ publishedAt: '2000-02-29' }, { publishedAt: '1900-02-29' }]), { 2000: 1, unknown: 1 });
    assert.deepEqual(report.byYear([{ publishedAt: '2020-01-01T00:00:00.123456Z' },
        { publishedAt: '2020-12-31T23:30-02:00' }]), { 2020: 1, 2021: 1 });
    for (const publishedAt of ['2020-01-01T24:00:00Z', '2020-01-01T00:60:00Z', '2020-01-01T00:00:60Z',
        '2020-01-01T00:00:00', '2020-01-01T00:00:00.Z', '01/01/2020']) {
        assert.deepEqual(report.byYear([{ publishedAt }]), { unknown: 1 }, publishedAt);
    }
});
