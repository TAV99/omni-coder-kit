'use strict';

const validatorLifecycleBindings = new WeakMap();

function bindValidatorLifecycle(store, boundary) {
    if (!store || validatorLifecycleBindings.has(store)) {
        throw new Error('Validator lifecycle store is already bound');
    }
    validatorLifecycleBindings.set(store, Object.freeze(boundary));
}

function readValidatorLifecycleBinding(store) {
    return validatorLifecycleBindings.get(store) || null;
}

module.exports = {
    bindValidatorLifecycle,
    readValidatorLifecycleBinding,
};
