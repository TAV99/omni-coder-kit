'use strict';

const {
    DiscussionError,
    ERROR_CODES,
    CEILINGS,
    resolveLimits,
    validateBinding,
    bindingRef,
    validateBindingPair,
    validateSnapshot,
    validatePayload,
    validateEnvelope,
} = require('./contracts');
const {
    openJournal,
    inspectJournal,
} = require('./journal');
const {
    createDiscussionAdapter,
} = require('./adapter');
const {
    createDiscussionRelay,
} = require('./relay');

module.exports = Object.freeze({
    createDiscussionRelay,
    createDiscussionAdapter,
    openJournal,
    inspectJournal,
    DiscussionError,
    ERROR_CODES,
    CEILINGS,
    resolveLimits,
    validateBinding,
    bindingRef,
    validateBindingPair,
    validateSnapshot,
    validatePayload,
    validateEnvelope,
});
