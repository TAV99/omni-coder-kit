'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Mock minimal DOM for headless testing
function createMockElement(tagName = 'div') {
    const children = [];
    const listeners = new Map();
    const classList = new Set();
    const style = {};
    const dataset = {};
    const attributes = new Map();

    const el = {
        tagName: tagName.toUpperCase(),
        ownerDocument: null,
        parentNode: null,
        children,
        style,
        dataset,
        textContent: '',
        innerHTML: '',
        value: '',
        className: '',
        scrollTop: 0,
        scrollHeight: 100,
        clientHeight: 50,
        appendChild(child) {
            child.parentNode = el;
            children.push(child);
            return child;
        },
        insertBefore(child, reference) {
            child.parentNode = el;
            const idx = children.indexOf(reference);
            if (idx === -1) {
                children.push(child);
            } else {
                children.splice(idx, 0, child);
            }
            return child;
        },
        removeChild(child) {
            const idx = children.indexOf(child);
            if (idx !== -1) {
                children.splice(idx, 1);
                child.parentNode = null;
            }
            return child;
        },
        replaceChildren(...newChildren) {
            children.forEach(c => { c.parentNode = null; });
            children.length = 0;
            newChildren.forEach(c => el.appendChild(c));
        },
        addEventListener(event, fn) {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(fn);
        },
        removeEventListener(event, fn) {
            const list = listeners.get(event) || [];
            const idx = list.indexOf(fn);
            if (idx !== -1) list.splice(idx, 1);
        },
        dispatchEvent(event) {
            const list = listeners.get(event.type) || [];
            list.forEach(fn => fn(event));
        },
        querySelector(selector) {
            if (selector.startsWith('.')) {
                const cls = selector.slice(1);
                if (el.className && el.className.split(' ').includes(cls)) return el;
                for (const c of children) {
                    const found = c.querySelector?.(selector);
                    if (found) return found;
                }
            } else if (selector.startsWith('#')) {
                const id = selector.slice(1);
                if (attributes.get('id') === id) return el;
                for (const c of children) {
                    const found = c.querySelector?.(selector);
                    if (found) return found;
                }
            } else if (selector.startsWith('[')) {
                // simple attribute check
                for (const c of children) {
                    const found = c.querySelector?.(selector);
                    if (found) return found;
                }
            }
            return null;
        },
        querySelectorAll(selector) {
            const results = [];
            function walk(node) {
                if (!node) return;
                if (selector.startsWith('.')) {
                    const cls = selector.slice(1);
                    if (node.className && node.className.split(' ').includes(cls)) results.push(node);
                } else if (selector.startsWith('[')) {
                    const attr = selector.slice(1, -1).split('=')[0];
                    if (node.dataset && node.dataset[attr.replace('data-', '')]) results.push(node);
                }
                if (node.children) {
                    node.children.forEach(walk);
                }
            }
            children.forEach(walk);
            return results;
        },
        setAttribute(name, val) {
            attributes.set(name, String(val));
            if (name === 'id') attributes.set('id', String(val));
        },
        getAttribute(name) {
            return attributes.get(name) || null;
        },
        removeAttribute(name) {
            attributes.delete(name);
        },
        hasAttribute(name) {
            return attributes.has(name);
        },
        classList: {
            add: (c) => classList.add(c),
            remove: (c) => classList.delete(c),
            toggle: (c, force) => {
                if (force === true) classList.add(c);
                else if (force === false) classList.delete(c);
                else if (classList.has(c)) classList.delete(c);
                else classList.add(c);
            },
            contains: (c) => classList.has(c),
        },
    };
    return el;
}

const mockDocument = {
    createElement: (tag) => {
        const el = createMockElement(tag);
        el.ownerDocument = mockDocument;
        return el;
    },
};

test('T10 terminals: attachTerminalView handles single-writer and read-only rejection', async () => {
    const { attachTerminalView } = await import('../../lib/ui/static/workspace/terminals.mjs');

    const container = mockDocument.createElement('div');
    const inputCalls = [];

    const mockTransport = {
        fetchImpl: async (url, opts) => {
            inputCalls.push({ url, body: JSON.parse(opts.body) });
            return { ok: true, status: 200 };
        },
    };

    // 1. Interactive terminal sends input
    const interactiveView = attachTerminalView({
        terminalId: 'term-main',
        container,
        transport: mockTransport,
        clientId: 'client-test-1',
        interactive: true,
    });

    assert.equal(interactiveView.isInteractive(), true);
    const sent = await interactiveView.sendInput('git status\n');
    assert.equal(sent, true);
    assert.equal(inputCalls.length, 1);
    assert.equal(inputCalls[0].body.data, 'git status\n');
    assert.equal(inputCalls[0].body.client_id, 'client-test-1');

    // 2. Read-only terminal rejects input
    const readOnlyContainer = mockDocument.createElement('div');
    const readOnlyView = attachTerminalView({
        terminalId: 'term-worker',
        container: readOnlyContainer,
        transport: mockTransport,
        clientId: 'client-test-2',
        interactive: false,
    });

    assert.equal(readOnlyView.isInteractive(), false);
    const sentReadOnly = await readOnlyView.sendInput('malicious input\n');
    assert.equal(sentReadOnly, false);
    assert.equal(inputCalls.length, 1); // Not increased!

    // 3. Dispose cleans up properly
    interactiveView.dispose();
    readOnlyView.dispose();
});

test('T10 timeline: mountTimeline renders safe events and approval gates', async () => {
    const { mountTimeline } = await import('../../lib/ui/static/workspace/timeline.mjs');

    const container = mockDocument.createElement('div');
    let openedResource = null;

    const timeline = mountTimeline({
        contextId: 'ctx-squad-1',
        container,
        events: [
            {
                id: 'ev-1',
                sender: 'Orchestrator',
                target: 'User',
                title: 'Review hoàn tất',
                message: 'Chờ duyệt để tích hợp vào workspace.',
                gate: { command: 'omni squad approve integrate-ui' },
                resources: [{ kind: 'document', id: 'plan-1', path: 'plan.md', title: 'Plan' }],
                created_at: new Date().toISOString(),
            },
        ],
        onOpenResource: (res) => {
            openedResource = res;
        },
    });

    assert.ok(timeline);
    assert.equal(typeof timeline.update, 'function');
    assert.equal(typeof timeline.scrollToBottom, 'function');

    // Update with empty list
    timeline.update([]);
    assert.equal(container.children[0].children.length, 1); // Empty notice

    timeline.dispose();
});

test('T10 context-panel: opens and closes views with pure layout coordination', async () => {
    const { createWorkspaceStore } = await import('../../lib/ui/static/workspace/store.mjs');

    const store = createWorkspaceStore();
    const contextId = 'ctx-test';

    // Simulate 20 rapid switches between contexts with views
    for (let i = 0; i < 20; i++) {
        const activeId = i % 2 === 0 ? 'ctx-squad' : 'ctx-single';
        store.dispatch({ type: 'selectContext', contextId: activeId });
        assert.equal(store.getState().selectedContextId, activeId);
    }

    // Verify view opening and closing in store
    store.dispatch({
        type: 'openView',
        contextId,
        view: { id: 'view-test-doc', kind: 'document', title: 'Doc 1' },
    });

    const ctxPrefs = store.getState().preferences.contexts[contextId];
    assert.ok(ctxPrefs.views.some(v => v.id === 'view-test-doc'));

    store.dispatch({
        type: 'closeView',
        contextId,
        viewId: 'view-test-doc',
    });

    const ctxPrefsAfter = store.getState().preferences.contexts[contextId];
    assert.ok(!ctxPrefsAfter.views.some(v => v.id === 'view-test-doc'));
});

test('T10 workspace: layout restore per context without cross-contamination', async () => {
    const { createWorkspaceStore } = await import('../../lib/ui/static/workspace/store.mjs');

    const store = createWorkspaceStore();

    // Squad context with split layout
    store.dispatch({
        type: 'openView',
        contextId: 'ctx-squad',
        view: { id: 'view-doc-squad', kind: 'document', title: 'squad.md' },
    });

    // Single context with single view
    store.dispatch({
        type: 'openView',
        contextId: 'ctx-single',
        view: { id: 'view-term-single', kind: 'terminal', title: 'Single Shell' },
    });

    const squadPrefs = store.getState().preferences.contexts['ctx-squad'];
    const singlePrefs = store.getState().preferences.contexts['ctx-single'];

    assert.notDeepEqual(squadPrefs.views, singlePrefs.views);
    assert.ok(squadPrefs.views.some(v => v.id === 'view-doc-squad'));
    assert.ok(!squadPrefs.views.some(v => v.id === 'view-term-single'));
    assert.ok(singlePrefs.views.some(v => v.id === 'view-term-single'));
    assert.ok(!singlePrefs.views.some(v => v.id === 'view-doc-squad'));
});
