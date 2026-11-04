'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('client-state: initializes with valid default state matching Spec 5', async () => {
    const { createWorkspaceStore } = await import('../../lib/ui/static/workspace/store.mjs');
    const store = createWorkspaceStore();
    const state = store.getState();

    assert.ok(state.preferences);
    assert.equal(state.preferences.schemaVersion, 1);
    assert.equal(state.preferences.theme, 'graphite');
    assert.equal(state.preferences.sidebarCollapsed, false);
    assert.equal(state.preferences.contextCollapsed, false);
    assert.equal(typeof state.preferences.sidebarWidth, 'number');
    assert.equal(typeof state.preferences.contextWidth, 'number');
    assert.deepEqual(state.contexts, []);
    assert.deepEqual(state.terminals, []);
    assert.equal(state.connectionStatus, 'connected');
    assert.equal(state.saveStatus, 'idle');
});

test('client-state: handles setContexts and selectContext', async () => {
    const { createWorkspaceStore } = await import('../../lib/ui/static/workspace/store.mjs');
    const store = createWorkspaceStore();
    const mockContexts = [
        { id: 'ctx-squad', mode: 'squad', status: 'running' },
        { id: 'ctx-single', mode: 'single', status: 'idle' },
    ];

    store.dispatch({ type: 'setContexts', contexts: mockContexts });
    assert.equal(store.getState().selectedContextId, 'ctx-squad');
    assert.equal(store.getState().contexts.length, 2);

    store.dispatch({ type: 'selectContext', contextId: 'ctx-single' });
    assert.equal(store.getState().selectedContextId, 'ctx-single');
    assert.equal(store.getState().preferences.selectedContextId, 'ctx-single');
});

test('client-state: manages view lifecycle (open, switch tab, move, close)', async () => {
    const { createWorkspaceStore } = await import('../../lib/ui/static/workspace/store.mjs');
    const store = createWorkspaceStore();
    const contextId = 'ctx-1';

    // 1. Open view
    store.dispatch({
        type: 'openView',
        contextId,
        view: { id: 'view-doc-1', kind: 'document', title: 'README.md' },
    });

    let ctxPrefs = store.getState().preferences.contexts[contextId];
    assert.ok(ctxPrefs);
    assert.equal(ctxPrefs.views.length, 2); // default view + new view
    assert.ok(ctxPrefs.views.some(v => v.id === 'view-doc-1'));

    // Check active tab
    assert.equal(ctxPrefs.layout.activeViewId, 'view-doc-1');

    // 2. Set active tab back to first view
    const firstViewId = ctxPrefs.views[0].id;
    store.dispatch({
        type: 'setActiveTab',
        contextId,
        groupId: ctxPrefs.layout.id,
        viewId: firstViewId,
    });
    ctxPrefs = store.getState().preferences.contexts[contextId];
    assert.equal(ctxPrefs.layout.activeViewId, firstViewId);

    // 3. Close view
    store.dispatch({
        type: 'closeView',
        contextId,
        viewId: 'view-doc-1',
    });
    ctxPrefs = store.getState().preferences.contexts[contextId];
    assert.equal(ctxPrefs.views.length, 1);
    assert.ok(!ctxPrefs.views.some(v => v.id === 'view-doc-1'));
});

test('client-state: manages split layout and resize', async () => {
    const { createWorkspaceStore } = await import('../../lib/ui/static/workspace/store.mjs');
    const store = createWorkspaceStore();
    const contextId = 'ctx-1';

    // Open two views
    store.dispatch({
        type: 'openView',
        contextId,
        view: { id: 'view-doc-1', kind: 'document' },
    });
    store.dispatch({
        type: 'openView',
        contextId,
        view: { id: 'view-term-2', kind: 'terminal' },
    });

    let ctxPrefs = store.getState().preferences.contexts[contextId];
    const initialGroupId = ctxPrefs.layout.id;

    // Split group
    store.dispatch({
        type: 'splitGroup',
        contextId,
        targetGroupId: initialGroupId,
        addedGroup: {
            type: 'group',
            id: 'group-right',
            tabs: ['view-term-2'],
            activeViewId: 'view-term-2',
        },
        axis: 'horizontal',
        ratio: 0.6,
    });

    ctxPrefs = store.getState().preferences.contexts[contextId];
    assert.equal(ctxPrefs.layout.type, 'split');
    assert.equal(ctxPrefs.layout.axis, 'horizontal');
    assert.equal(ctxPrefs.layout.ratio, 0.6);

    // Resize split
    store.dispatch({
        type: 'resizeSplit',
        contextId,
        splitId: ctxPrefs.layout.id,
        ratio: 0.4,
    });
    ctxPrefs = store.getState().preferences.contexts[contextId];
    assert.equal(ctxPrefs.layout.ratio, 0.4);
});

test('client-state: manages priority toggle (timeline vs terminal)', async () => {
    const { createWorkspaceStore } = await import('../../lib/ui/static/workspace/store.mjs');
    const store = createWorkspaceStore();
    const contextId = 'ctx-1';

    store.dispatch({ type: 'setPriority', contextId, priority: 'timeline' });
    let ctxPrefs = store.getState().preferences.contexts[contextId];
    assert.equal(ctxPrefs.priority, 'timeline');

    store.dispatch({ type: 'setPriority', contextId, priority: 'terminal' });
    ctxPrefs = store.getState().preferences.contexts[contextId];
    assert.equal(ctxPrefs.priority, 'terminal');

    // Invalid priority ignored
    store.dispatch({ type: 'setPriority', contextId, priority: 'invalid-priority' });
    ctxPrefs = store.getState().preferences.contexts[contextId];
    assert.equal(ctxPrefs.priority, 'terminal');
});

test('client-state: theme, sidebar, and context widths clamp to valid ranges', async () => {
    const { createWorkspaceStore } = await import('../../lib/ui/static/workspace/store.mjs');
    const store = createWorkspaceStore();

    store.dispatch({ type: 'setTheme', theme: 'midnight' });
    assert.equal(store.getState().preferences.theme, 'midnight');

    store.dispatch({ type: 'setSidebarWidth', width: 100 }); // Below 160
    assert.equal(store.getState().preferences.sidebarWidth, 160);

    store.dispatch({ type: 'setSidebarWidth', width: 999 }); // Above 480
    assert.equal(store.getState().preferences.sidebarWidth, 480);

    store.dispatch({ type: 'setContextWidth', width: 50 }); // Below 240
    assert.equal(store.getState().preferences.contextWidth, 240);

    store.dispatch({ type: 'setContextWidth', width: 1200 }); // Above 600
    assert.equal(store.getState().preferences.contextWidth, 600);
});

test('client-state: notifies subscribers on dispatch and handles unsubscribe', async () => {
    const { createWorkspaceStore } = await import('../../lib/ui/static/workspace/store.mjs');
    const store = createWorkspaceStore();
    let callCount = 0;
    const unsub = store.subscribe(() => {
        callCount++;
    });

    store.dispatch({ type: 'setTheme', theme: 'paper' });
    assert.equal(callCount, 1);

    store.dispatch({ type: 'setSidebarCollapsed', collapsed: true });
    assert.equal(callCount, 2);

    unsub();
    store.dispatch({ type: 'setTheme', theme: 'graphite' });
    assert.equal(callCount, 2); // Did not increase
});
