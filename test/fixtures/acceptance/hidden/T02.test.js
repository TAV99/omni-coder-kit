'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers.cjs');

test('T02: reject missing or blank titles with TypeError before adding a book', () => {
    const { Catalog } = load('lib/catalog.js');
    const catalog = new Catalog();
    for (const title of [undefined, null, '', '  ', 123]) {
        assert.throws(() => catalog.addBook({ id: 'bad', title }), TypeError);
        assert.deepEqual(catalog.list(), []);
    }
    catalog.addBook({ id: 'ok', title: ' Dune ' });
    assert.equal(catalog.findById('ok').title, ' Dune ');
});
