'use strict';

const { readOperationLifecycleBinding } = require('./operation-lifecycle-capability');

function operationError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function createOperationLifecycleWriter(authorityStore) {
    const boundary = readOperationLifecycleBinding(authorityStore);
    if (!boundary || typeof boundary.begin !== 'function' || typeof boundary.settle !== 'function') {
        throw operationError('DUAL_OPERATION_CAPABILITY_REQUIRED', 'Private controller lifecycle capability required');
    }
    return Object.freeze({
        begin: (params) => boundary.begin(params),
        settle: (params) => boundary.settle(params),
    });
}

module.exports = { createOperationLifecycleWriter };
