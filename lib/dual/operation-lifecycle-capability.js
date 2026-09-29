'use strict';

// Internal-only registry shared by the authority store and controller writer.
// The capability stays in this module's WeakMap: it is not a property that a
// caller can discover by reflecting over a public/reopened store.
const lifecycleBindings = new WeakMap();

function bindOperationLifecycle(store, boundary) {
    if (!store || lifecycleBindings.has(store)) throw new Error('Operation lifecycle store is already bound');
    lifecycleBindings.set(store, Object.freeze(boundary));
}

function readOperationLifecycleBinding(store) {
    return lifecycleBindings.get(store) || null;
}

module.exports = { bindOperationLifecycle, readOperationLifecycleBinding };
