'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseDiscussionEnv } = require('../lib/dual/discussion/env-flag');

const cases = [
    [undefined, 'unset'], ['', 'unset'], ['   ', 'unset'],
    ['0', 'off'], ['false', 'off'], ['off', 'off'], ['no', 'off'],
    ['1', 'on'], ['true', 'on'], ['on', 'on'], ['yes', 'on'],
    ['banana', 'invalid'], ['01', 'invalid'],
    [' 0 ', 'off'], [' FALSE ', 'off'], [' Off ', 'off'], [' NO ', 'off'],
    [' 1 ', 'on'], [' TRUE ', 'on'], [' On ', 'on'], [' YES ', 'on'],
];

for (const [raw, expected] of cases) {
    test(`discussion env ${JSON.stringify(raw)} parses as ${expected}`, () => {
        assert.equal(parseDiscussionEnv(raw), expected);
    });
}
