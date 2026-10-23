'use strict';

const ON_VALUES = new Set(['1', 'true', 'on', 'yes']);
const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

// Shared value contract; callers choose their own default for unset.
function parseDiscussionEnv(raw) {
    const value = (raw ?? '').trim().toLowerCase();
    if (value === '') return 'unset';
    if (ON_VALUES.has(value)) return 'on';
    if (OFF_VALUES.has(value)) return 'off';
    return 'invalid';
}

module.exports = { parseDiscussionEnv };
