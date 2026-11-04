'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('T01: layout.mjs pure split-tree model', async (t) => {
    // Dynamically import ESM layout module
    const {
        validateLayout,
        splitGroup,
        moveView,
        closeView,
        resizeSplit,
    } = await import('../../lib/ui/static/workspace/layout.mjs');

    const views = [
        { id: 'v-tasks', kind: 'tasks', contextId: 'ctx-1', resourceId: null },
        { id: 'v-md', kind: 'document', contextId: 'ctx-1', resourceId: 'doc-1' },
        { id: 'v-pdf', kind: 'document', contextId: 'ctx-1', resourceId: 'doc-2' },
        { id: 'v-shell', kind: 'terminal', contextId: 'ctx-1', resourceId: 'term-1' },
        { id: 'v-files', kind: 'files', contextId: 'ctx-1', resourceId: null },
    ];

    const baseGroup = {
        type: 'group',
        id: 'g-main',
        tabs: ['v-tasks', 'v-md'],
        activeViewId: 'v-tasks'
    };

    await t.test('validateLayout: validates simple group', () => {
        const validated = validateLayout(baseGroup, views);
        assert.deepEqual(validated, baseGroup);
    });

    await t.test('validateLayout: rejects duplicate group/split IDs', () => {
        const invalid = {
            type: 'split',
            id: 'node-1',
            axis: 'horizontal',
            ratio: 0.5,
            first: { type: 'group', id: 'node-1', tabs: ['v-tasks'], activeViewId: 'v-tasks' },
            second: { type: 'group', id: 'g-2', tabs: ['v-md'], activeViewId: 'v-md' }
        };
        assert.throws(() => validateLayout(invalid, views), /Duplicate layout node ID/);
    });

    await t.test('validateLayout: rejects unknown view ID in tabs', () => {
        const invalid = {
            type: 'group',
            id: 'g-1',
            tabs: ['v-unknown'],
            activeViewId: 'v-unknown'
        };
        assert.throws(() => validateLayout(invalid, views), /Unknown view ID/);
    });

    await t.test('validateLayout: rejects view appearing in multiple groups', () => {
        const invalid = {
            type: 'split',
            id: 's-1',
            axis: 'vertical',
            ratio: 0.5,
            first: { type: 'group', id: 'g-1', tabs: ['v-tasks'], activeViewId: 'v-tasks' },
            second: { type: 'group', id: 'g-2', tabs: ['v-tasks'], activeViewId: 'v-tasks' }
        };
        assert.throws(() => validateLayout(invalid, views), /View occurs multiple times/);
    });

    await t.test('validateLayout: clamps ratio to [0.15, 0.85]', () => {
        const unnormalRatio = {
            type: 'split',
            id: 's-1',
            axis: 'vertical',
            ratio: 0.05, // should be clamped to 0.15
            first: { type: 'group', id: 'g-1', tabs: ['v-tasks'], activeViewId: 'v-tasks' },
            second: { type: 'group', id: 'g-2', tabs: ['v-md'], activeViewId: 'v-md' }
        };
        const normalized = validateLayout(unnormalRatio, views);
        assert.equal(normalized.ratio, 0.15);
    });

    await t.test('splitGroup: creates split and leaves target group intact', () => {
        const addedGroup = {
            type: 'group',
            id: 'g-shell',
            tabs: ['v-shell'],
            activeViewId: 'v-shell'
        };
        const result = splitGroup(baseGroup, 'g-main', addedGroup, 'vertical', 0.6);
        assert.equal(result.type, 'split');
        assert.equal(result.axis, 'vertical');
        assert.equal(result.ratio, 0.6);
        assert.equal(result.first.id, 'g-main');
        assert.equal(result.second.id, 'g-shell');
    });

    await t.test('splitGroup: missing target returns unchanged layout (immutability)', () => {
        const addedGroup = { type: 'group', id: 'g-new', tabs: ['v-shell'], activeViewId: 'v-shell' };
        const before = structuredClone(baseGroup);
        const result = splitGroup(baseGroup, 'non-existent', addedGroup, 'horizontal', 0.5);
        assert.deepEqual(result, before);
        assert.deepEqual(baseGroup, before);
    });

    await t.test('moveView: moves tab from one group to another and updates activeViewId', () => {
        const layout = {
            type: 'split',
            id: 's-1',
            axis: 'horizontal',
            ratio: 0.5,
            first: { type: 'group', id: 'g-1', tabs: ['v-tasks', 'v-md'], activeViewId: 'v-md' },
            second: { type: 'group', id: 'g-2', tabs: ['v-shell'], activeViewId: 'v-shell' }
        };

        const moved = moveView(layout, 'v-md', 'g-2');
        assert.deepEqual(moved.first.tabs, ['v-tasks']);
        assert.equal(moved.first.activeViewId, 'v-tasks');
        assert.deepEqual(moved.second.tabs, ['v-shell', 'v-md']);
        assert.equal(moved.second.activeViewId, 'v-md');
    });

    await t.test('moveView: collapses split when source group becomes empty', () => {
        const layout = {
            type: 'split',
            id: 's-1',
            axis: 'horizontal',
            ratio: 0.5,
            first: { type: 'group', id: 'g-1', tabs: ['v-tasks'], activeViewId: 'v-tasks' },
            second: { type: 'group', id: 'g-2', tabs: ['v-shell'], activeViewId: 'v-shell' }
        };

        const moved = moveView(layout, 'v-tasks', 'g-2');
        // g-1 had only v-tasks, so moving it leaves g-1 empty.
        // The split s-1 collapses to its remaining non-empty sibling g-2.
        assert.equal(moved.type, 'group');
        assert.equal(moved.id, 'g-2');
        assert.deepEqual(moved.tabs, ['v-shell', 'v-tasks']);
        assert.equal(moved.activeViewId, 'v-tasks');
    });

    await t.test('moveView: missing target leaves layout unchanged', () => {
        const before = structuredClone(baseGroup);
        const after = moveView(baseGroup, 'v-tasks', 'missing-group');
        assert.deepEqual(after, before);
        assert.deepEqual(baseGroup, before);
    });

    await t.test('closeView: removes view and selects adjacent tab', () => {
        const group = {
            type: 'group',
            id: 'g-1',
            tabs: ['v-tasks', 'v-md', 'v-pdf'],
            activeViewId: 'v-md'
        };
        const closed = closeView(group, 'v-md');
        assert.deepEqual(closed.tabs, ['v-tasks', 'v-pdf']);
        // Selected previous tab
        assert.equal(closed.activeViewId, 'v-tasks');
    });

    await t.test('closeView: collapses split when closing the last tab in a group', () => {
        const layout = {
            type: 'split',
            id: 's-1',
            axis: 'vertical',
            ratio: 0.7,
            first: { type: 'group', id: 'g-1', tabs: ['v-tasks'], activeViewId: 'v-tasks' },
            second: { type: 'group', id: 'g-2', tabs: ['v-shell', 'v-pdf'], activeViewId: 'v-shell' }
        };
        const closed = closeView(layout, 'v-tasks');
        assert.equal(closed.type, 'group');
        assert.equal(closed.id, 'g-2');
        assert.deepEqual(closed.tabs, ['v-shell', 'v-pdf']);
    });

    await t.test('closeView: closing non-existent view returns unchanged layout', () => {
        const before = structuredClone(baseGroup);
        const after = closeView(baseGroup, 'v-missing');
        assert.deepEqual(after, before);
        assert.deepEqual(baseGroup, before);
    });

    await t.test('resizeSplit: clamps ratio to [0.15, 0.85] and updates ratio', () => {
        const layout = {
            type: 'split',
            id: 's-1',
            axis: 'horizontal',
            ratio: 0.5,
            first: { type: 'group', id: 'g-1', tabs: ['v-tasks'], activeViewId: 'v-tasks' },
            second: { type: 'group', id: 'g-2', tabs: ['v-shell'], activeViewId: 'v-shell' }
        };

        const resizedHigh = resizeSplit(layout, 's-1', 0.95);
        assert.equal(resizedHigh.ratio, 0.85);

        const resizedLow = resizeSplit(layout, 's-1', 0.05);
        assert.equal(resizedLow.ratio, 0.15);

        const resizedValid = resizeSplit(layout, 's-1', 0.35);
        assert.equal(resizedValid.ratio, 0.35);

        const missing = resizeSplit(layout, 's-missing', 0.4);
        assert.deepEqual(missing, layout);
    });

    await t.test('Invariants: sequence of 50 random/ordered operations preserves view uniqueness', () => {
        let currentLayout = {
            type: 'group',
            id: 'g-root',
            tabs: ['v-tasks', 'v-md'],
            activeViewId: 'v-tasks'
        };

        // Split 1
        currentLayout = splitGroup(currentLayout, 'g-root', {
            type: 'group',
            id: 'g-2',
            tabs: ['v-pdf'],
            activeViewId: 'v-pdf'
        }, 'horizontal', 0.5);

        // Split 2
        currentLayout = splitGroup(currentLayout, 'g-2', {
            type: 'group',
            id: 'g-3',
            tabs: ['v-shell'],
            activeViewId: 'v-shell'
        }, 'vertical', 0.6);

        // Move v-md to g-3
        currentLayout = moveView(currentLayout, 'v-md', 'g-3');

        // Resize splits
        currentLayout = resizeSplit(currentLayout, 'g-root-split', 0.4);

        // Close v-tasks from g-root
        currentLayout = closeView(currentLayout, 'v-tasks');

        // Validate final layout against views
        const validated = validateLayout(currentLayout, views);
        assert.ok(validated);

        // Check that every tab across all groups is unique
        const allTabs = [];
        function collect(node) {
            if (node.type === 'group') {
                allTabs.push(...node.tabs);
                if (node.tabs.length > 0) {
                    assert.ok(node.tabs.includes(node.activeViewId));
                }
            } else if (node.type === 'split') {
                assert.ok(node.ratio >= 0.15 && node.ratio <= 0.85);
                collect(node.first);
                collect(node.second);
            }
        }
        collect(validated);
        assert.equal(new Set(allTabs).size, allTabs.length);
    });
});
