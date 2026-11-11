/**
 * Pure split-tree layout model for Omni UI Workspace (T01)
 *
 * Implements pure, immutable operations on LayoutNode trees.
 * Decoupled from DOM, PTY handles, and process lifecycles.
 */

const MIN_RATIO = 0.15;
const MAX_RATIO = 0.85;

function clampRatio(ratio) {
    if (typeof ratio !== 'number' || Number.isNaN(ratio)) return 0.5;
    return Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
}

/**
 * Validates a LayoutNode tree against a list of known Views.
 * Enforces node ID uniqueness, tab existence, and single-occurrence invariants.
 *
 * @param {unknown} value
 * @param {Array<{id: string}>} [views]
 * @returns {object} Validated LayoutNode
 */
export function validateLayout(value, views = []) {
    if (!value || typeof value !== 'object') {
        throw new Error('Layout must be a non-null object');
    }

    const seenNodeIds = new Set();
    const seenViewIds = new Set();
    const knownViewMap = new Map((views || []).map(v => [v.id, v]));

    function checkNode(node) {
        if (!node || typeof node !== 'object') {
            throw new Error('Invalid layout node');
        }

        if (typeof node.id !== 'string' || !node.id.trim()) {
            throw new Error('Layout node must have a non-empty string ID');
        }

        if (seenNodeIds.has(node.id)) {
            throw new Error(`Duplicate layout node ID: ${node.id}`);
        }
        seenNodeIds.add(node.id);

        if (node.type === 'group') {
            if (!Array.isArray(node.tabs)) {
                throw new Error(`Group node ${node.id} must have a tabs array`);
            }

            for (const viewId of node.tabs) {
                if (typeof viewId !== 'string') {
                    throw new Error(`Group node ${node.id} tab must be a string view ID`);
                }
                if (views && views.length > 0 && !knownViewMap.has(viewId)) {
                    throw new Error(`Unknown view ID in tabs: ${viewId}`);
                }
                if (seenViewIds.has(viewId)) {
                    throw new Error(`View occurs multiple times in layout: ${viewId}`);
                }
                seenViewIds.add(viewId);
            }

            let activeViewId = node.activeViewId;
            if (node.tabs.length === 0) {
                activeViewId = null;
            } else if (!activeViewId || !node.tabs.includes(activeViewId)) {
                activeViewId = node.tabs[0];
            }

            return {
                type: 'group',
                id: node.id,
                tabs: [...node.tabs],
                activeViewId,
            };
        }

        if (node.type === 'split') {
            const axis = node.axis === 'vertical' ? 'vertical' : 'horizontal';
            const ratio = clampRatio(node.ratio);
            if (!node.first || !node.second) {
                throw new Error(`Split node ${node.id} must have first and second children`);
            }

            const first = checkNode(node.first);
            const second = checkNode(node.second);

            return {
                type: 'split',
                id: node.id,
                axis,
                ratio,
                first,
                second,
            };
        }

        throw new Error(`Unknown layout node type: ${node.type}`);
    }

    return checkNode(value);
}

function findNodeById(root, id) {
    if (!root || typeof root !== 'object') return null;
    if (root.id === id) return root;
    if (root.type === 'split') {
        return findNodeById(root.first, id) || findNodeById(root.second, id);
    }
    return null;
}

function findParentSplit(root, childId) {
    if (!root || root.type !== 'split') return null;
    if (root.first.id === childId || root.second.id === childId) {
        return root;
    }
    return findParentSplit(root.first, childId) || findParentSplit(root.second, childId);
}

function findGroupByViewId(root, viewId) {
    if (!root) return null;
    if (root.type === 'group') {
        if (root.tabs && root.tabs.includes(viewId)) return root;
        return null;
    }
    if (root.type === 'split') {
        return findGroupByViewId(root.first, viewId) || findGroupByViewId(root.second, viewId);
    }
    return null;
}

function collectNodeIds(root, set = new Set()) {
    if (!root) return set;
    set.add(root.id);
    if (root.type === 'split') {
        collectNodeIds(root.first, set);
        collectNodeIds(root.second, set);
    }
    return set;
}

/**
 * Splits an existing group into two by replacing it with a split node.
 * Returns the layout unchanged if target group does not exist or added group has ID conflict.
 */
export function splitGroup(layout, targetGroupId, addedGroup, axis = 'horizontal', ratio = 0.5) {
    const cloned = structuredClone(layout);
    const target = findNodeById(cloned, targetGroupId);
    if (!target || target.type !== 'group') {
        return layout;
    }

    // Check for ID conflict with addedGroup
    const existingIds = collectNodeIds(cloned);
    const addedIds = collectNodeIds(addedGroup);
    for (const id of addedIds) {
        if (existingIds.has(id)) {
            return layout;
        }
    }

    const splitAxis = axis === 'vertical' ? 'vertical' : 'horizontal';
    const splitRatio = clampRatio(ratio);
    const splitId = `${targetGroupId}-split-${Date.now().toString(36)}`;

    const newSplit = {
        type: 'split',
        id: splitId,
        axis: splitAxis,
        ratio: splitRatio,
        first: structuredClone(target),
        second: structuredClone(addedGroup),
    };

    function replaceInTree(node) {
        if (node.id === targetGroupId) {
            return newSplit;
        }
        if (node.type === 'split') {
            return {
                ...node,
                first: replaceInTree(node.first),
                second: replaceInTree(node.second),
            };
        }
        return node;
    }

    return replaceInTree(cloned);
}

/**
 * Closes (removes) a view from its group.
 * If the group becomes empty and has a parent split, collapses the split to the sibling group.
 */
export function closeView(layout, viewId) {
    const cloned = structuredClone(layout);
    const group = findGroupByViewId(cloned, viewId);
    if (!group) {
        return layout;
    }

    const tabIdx = group.tabs.indexOf(viewId);
    if (tabIdx === -1) {
        return layout;
    }

    group.tabs.splice(tabIdx, 1);
    if (group.activeViewId === viewId) {
        if (group.tabs.length === 0) {
            group.activeViewId = null;
        } else {
            const nextIdx = Math.max(0, tabIdx - 1);
            group.activeViewId = group.tabs[nextIdx];
        }
    }

    // Check if group is empty
    if (group.tabs.length === 0) {
        return collapseEmptyNodes(cloned);
    }

    return cloned;
}

/**
 * Recursively collapses empty groups inside splits to their non-empty siblings.
 */
function collapseEmptyNodes(node) {
    if (!node) return null;
    if (node.type === 'group') {
        return node;
    }

    if (node.type === 'split') {
        const first = collapseEmptyNodes(node.first);
        const second = collapseEmptyNodes(node.second);

        // If first is empty group, collapse to second
        if (first.type === 'group' && first.tabs.length === 0) {
            return second;
        }
        // If second is empty group, collapse to first
        if (second.type === 'group' && second.tabs.length === 0) {
            return first;
        }

        return {
            ...node,
            first,
            second,
        };
    }

    return node;
}

/**
 * Moves a view from its current group to targetGroupId.
 * Appends viewId to target group tabs and sets target activeViewId to viewId.
 * Collapses source group's parent split if source becomes empty.
 */
export function moveView(layout, viewId, targetGroupId) {
    const cloned = structuredClone(layout);
    const targetGroup = findNodeById(cloned, targetGroupId);
    if (!targetGroup || targetGroup.type !== 'group') {
        return layout;
    }

    const sourceGroup = findGroupByViewId(cloned, viewId);
    if (!sourceGroup) {
        return layout;
    }

    if (sourceGroup.id === targetGroupId) {
        return layout;
    }

    // Remove from source
    const srcIdx = sourceGroup.tabs.indexOf(viewId);
    sourceGroup.tabs.splice(srcIdx, 1);
    if (sourceGroup.activeViewId === viewId) {
        if (sourceGroup.tabs.length === 0) {
            sourceGroup.activeViewId = null;
        } else {
            const nextIdx = Math.max(0, srcIdx - 1);
            sourceGroup.activeViewId = sourceGroup.tabs[nextIdx];
        }
    }

    // Add to target
    targetGroup.tabs.push(viewId);
    targetGroup.activeViewId = viewId;

    // If source group became empty, collapse
    if (sourceGroup.tabs.length === 0) {
        return collapseEmptyNodes(cloned);
    }

    return cloned;
}

/**
 * Creates a minimal valid default layout with a single group.
 */
export function createDefaultLayout(primaryViewId = 'view-default') {
    return {
        type: 'group',
        id: 'group-main',
        tabs: [primaryViewId],
        activeViewId: primaryViewId,
    };
}

/**
 * Resizes a split node by updating its ratio (clamped to [0.15, 0.85]).
 * Returns layout unchanged if splitId is not found.
 */
export function resizeSplit(layout, splitId, ratio) {
    const cloned = structuredClone(layout);
    const split = findNodeById(cloned, splitId);
    if (!split || split.type !== 'split') {
        return layout;
    }

    const clamped = clampRatio(ratio);

    function updateSplit(node) {
        if (node.id === splitId && node.type === 'split') {
            return {
                ...node,
                ratio: clamped,
            };
        }
        if (node.type === 'split') {
            return {
                ...node,
                first: updateSplit(node.first),
                second: updateSplit(node.second),
            };
        }
        return node;
    }

    return updateSplit(cloned);
}
