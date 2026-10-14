'use strict';

const { readValidatorLifecycleBinding } = require('./validator-lifecycle-capability');

function lifecycleError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function createValidatorLifecycleWriter(authorityStore) {
    const boundary = readValidatorLifecycleBinding(authorityStore);
    if (!boundary || typeof boundary.begin !== 'function' || typeof boundary.settle !== 'function') {
        throw lifecycleError('DUAL_VALIDATOR_CAPABILITY_REQUIRED', 'Private controller validator lifecycle capability required');
    }
    return Object.freeze({
        begin: (params) => boundary.begin(params),
        settle: (params) => boundary.settle(params),
    });
}

module.exports = { createValidatorLifecycleWriter };
