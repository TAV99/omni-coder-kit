'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const format = require('../lib/format');

test('price has two decimal places for a positive integer', () => {
    assert.equal(format.price(12), '12.00');
});
