'use strict';

// Squad runtime registry entry point (SPEC-SQUAD-P1 §7).

const { createRegistry } = require('./registry');
const contract = require('./contract');
const { resolveBinary } = require('./resolve-binary');
const { modelFamily } = require('./families');
const codex = require('./codex');
const agy = require('./agy');

const BUILTIN_RUNTIMES = Object.freeze([codex, agy]);
const defaultRegistry = createRegistry({ runtimes: BUILTIN_RUNTIMES });

module.exports = {
    ...contract,
    createRegistry,
    defaultRegistry,
    BUILTIN_RUNTIMES,
    resolveBinary,
    modelFamily,
};
