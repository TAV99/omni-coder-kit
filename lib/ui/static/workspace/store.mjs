/**
 * Pure workspace state store for Omni UI (T09/T10)
 *
 * Implements predictable state container with:
 * - getState() / dispatch(action) / subscribe(listener)
 * - Pure layout tree manipulation via layout.mjs
 * - Preferences state matching Spec 5
 * - Zero storage of process or DOM objects
 */

import {
    validateLayout,
    splitGroup,
    moveView,
    closeView,
    resizeSplit,
    createDefaultLayout,
} from './layout.mjs';

// One theme list for the page: the store accepts every theme the picker offers.
export { VALID_THEMES } from './theme.mjs';
import { VALID_THEMES } from './theme.mjs';
export const VALID_PRIORITIES = ['timeline', 'terminal'];

/**
 * Creates default context state if not present.
 */
function defaultContextState(contextId) {
    const defaultView = {
        id: `view-term-${contextId}`,
        kind: 'terminal',
        contextId,
        resourceId: null,
    };
    return {
        priority: 'terminal',
        layout: createDefaultLayout(defaultView.id),
        views: [defaultView],
    };
}

/**
 * Creates the initial workspace state.
 */
export function createInitialState(overrides = {}) {
    const defaultPrefs = {
        schemaVersion: 1,
        revision: 'initial',
        theme: 'graphite',
        sidebarCollapsed: false,
        sidebarWidth: 220,
        contextCollapsed: false,
        contextWidth: 340,
        selectedContextId: null,
        contexts: {},
    };

    const preferences = {
        ...defaultPrefs,
        ...(overrides.preferences || {}),
        contexts: {
            ...(defaultPrefs.contexts || {}),
            ...((overrides.preferences && overrides.preferences.contexts) || {}),
        },
    };

    return {
        preferences,
        contexts: overrides.contexts || [],
        terminals: overrides.terminals || [],
        limits: overrides.limits || [],
        roleOutputs: overrides.roleOutputs || {},
        selectedContextId: preferences.selectedContextId || (overrides.contexts && overrides.contexts[0]?.id) || null,
        activeGroupId: overrides.activeGroupId || null,
        saveStatus: 'idle', // 'idle' | 'saving' | 'saved' | 'conflict' | 'error'
        saveError: null,
        connectionStatus: 'connected', // 'connecting' | 'connected' | 'disconnected'
    };
}

/**
 * Creates a workspace store instance.
 *
 * @param {object} [initial={}]
 * @returns {object} Store with getState, dispatch, subscribe
 */
export function createWorkspaceStore(initial = {}) {
    let state = createInitialState(initial);
    const listeners = new Set();

    function getState() {
        return state;
    }

    function notify() {
        for (const listener of listeners) {
            try {
                listener(state);
            } catch (err) {
                console.error('[workspace-store] Listener error:', err);
            }
        }
    }

    function updateContextPreferences(contextId, updater) {
        const existingContextPrefs = state.preferences.contexts[contextId] || defaultContextState(contextId);
        const updated = updater(structuredClone(existingContextPrefs));

        // Validate updated layout
        try {
            updated.layout = validateLayout(updated.layout, updated.views);
        } catch (err) {
            console.warn('[workspace-store] Layout validation error after update:', err.message);
            return;
        }

        state = {
            ...state,
            preferences: {
                ...state.preferences,
                contexts: {
                    ...state.preferences.contexts,
                    [contextId]: updated,
                },
            },
        };
    }

    function dispatch(action) {
        if (!action || typeof action.type !== 'string') {
            return;
        }

        switch (action.type) {
            case 'setPreferences': {
                if (!action.preferences || typeof action.preferences !== 'object') break;
                state = {
                    ...state,
                    preferences: {
                        ...state.preferences,
                        ...action.preferences,
                        contexts: {
                            ...state.preferences.contexts,
                            ...(action.preferences.contexts || {}),
                        },
                    },
                    selectedContextId: action.preferences.selectedContextId || state.selectedContextId,
                };
                notify();
                break;
            }

            case 'setContexts': {
                const contexts = Array.isArray(action.contexts) ? action.contexts : [];
                let selectedId = state.selectedContextId;
                if (!selectedId && contexts.length > 0) {
                    selectedId = contexts[0].id;
                }
                state = {
                    ...state,
                    contexts,
                    selectedContextId: selectedId,
                    preferences: {
                        ...state.preferences,
                        selectedContextId: selectedId,
                    },
                };
                notify();
                break;
            }

            case 'selectContext': {
                const contextId = action.contextId;
                if (!contextId || state.selectedContextId === contextId) break;
                state = {
                    ...state,
                    selectedContextId: contextId,
                    preferences: {
                        ...state.preferences,
                        selectedContextId: contextId,
                    },
                };
                notify();
                break;
            }

            case 'setPriority': {
                const { contextId, priority } = action;
                if (!contextId || !VALID_PRIORITIES.includes(priority)) break;
                updateContextPreferences(contextId, ctxPrefs => {
                    ctxPrefs.priority = priority;
                    return ctxPrefs;
                });
                notify();
                break;
            }

            case 'openView': {
                const { contextId, view, targetGroupId } = action;
                if (!contextId || !view || !view.id || !view.kind) break;

                updateContextPreferences(contextId, ctxPrefs => {
                    // Check if view already exists
                    const existingIndex = ctxPrefs.views.findIndex(v => v.id === view.id);
                    if (existingIndex === -1) {
                        ctxPrefs.views.push({
                            id: view.id,
                            kind: view.kind,
                            contextId,
                            resourceId: view.resourceId || null,
                            title: view.title || view.id,
                        });
                    }

                    // Attach to layout
                    function addViewToLayout(node) {
                        if (node.type === 'group') {
                            if (!targetGroupId || node.id === targetGroupId) {
                                if (!node.tabs.includes(view.id)) {
                                    node.tabs.push(view.id);
                                }
                                node.activeViewId = view.id;
                                return true;
                            }
                            return false;
                        }
                        if (node.type === 'split') {
                            return addViewToLayout(node.first) || addViewToLayout(node.second);
                        }
                        return false;
                    }

                    // If target group not found, add to the first group found
                    if (!addViewToLayout(ctxPrefs.layout)) {
                        function addToFirstGroup(node) {
                            if (node.type === 'group') {
                                if (!node.tabs.includes(view.id)) {
                                    node.tabs.push(view.id);
                                }
                                node.activeViewId = view.id;
                                return true;
                            }
                            if (node.type === 'split') {
                                return addToFirstGroup(node.first) || addToFirstGroup(node.second);
                            }
                            return false;
                        }
                        addToFirstGroup(ctxPrefs.layout);
                    }

                    return ctxPrefs;
                });
                notify();
                break;
            }

            case 'closeView': {
                const { contextId, viewId } = action;
                if (!contextId || !viewId) break;

                updateContextPreferences(contextId, ctxPrefs => {
                    ctxPrefs.layout = closeView(ctxPrefs.layout, viewId);
                    ctxPrefs.views = ctxPrefs.views.filter(v => v.id !== viewId);
                    return ctxPrefs;
                });
                notify();
                break;
            }

            case 'moveView': {
                const { contextId, viewId, targetGroupId } = action;
                if (!contextId || !viewId || !targetGroupId) break;

                updateContextPreferences(contextId, ctxPrefs => {
                    ctxPrefs.layout = moveView(ctxPrefs.layout, viewId, targetGroupId);
                    return ctxPrefs;
                });
                notify();
                break;
            }

            case 'splitGroup': {
                const { contextId, targetGroupId, addedGroup, axis, ratio } = action;
                if (!contextId || !targetGroupId || !addedGroup) break;

                updateContextPreferences(contextId, ctxPrefs => {
                    // Collect view IDs in addedGroup to prevent duplicates across groups
                    const addedViewIds = new Set();
                    function collectAddedViews(node) {
                        if (!node) return;
                        if (node.type === 'group') {
                            (node.tabs || []).forEach(t => addedViewIds.add(t));
                        } else if (node.type === 'split') {
                            collectAddedViews(node.first);
                            collectAddedViews(node.second);
                        }
                    }
                    collectAddedViews(addedGroup);

                    // Remove them from current layout tree before splitting so single-occurrence holds
                    function removeViews(node) {
                        if (!node) return;
                        if (node.type === 'group') {
                            node.tabs = node.tabs.filter(id => !addedViewIds.has(id));
                            if (node.activeViewId && !node.tabs.includes(node.activeViewId)) {
                                node.activeViewId = node.tabs[0] || null;
                            }
                        } else if (node.type === 'split') {
                            removeViews(node.first);
                            removeViews(node.second);
                        }
                    }
                    removeViews(ctxPrefs.layout);

                    ctxPrefs.layout = splitGroup(ctxPrefs.layout, targetGroupId, addedGroup, axis, ratio);
                    return ctxPrefs;
                });
                notify();
                break;
            }

            case 'resizeSplit': {
                const { contextId, splitId, ratio } = action;
                if (!contextId || !splitId || typeof ratio !== 'number') break;

                updateContextPreferences(contextId, ctxPrefs => {
                    ctxPrefs.layout = resizeSplit(ctxPrefs.layout, splitId, ratio);
                    return ctxPrefs;
                });
                notify();
                break;
            }

            case 'setActiveTab': {
                const { contextId, groupId, viewId } = action;
                if (!contextId || !groupId || !viewId) break;

                updateContextPreferences(contextId, ctxPrefs => {
                    function updateGroup(node) {
                        if (node.type === 'group' && node.id === groupId) {
                            if (node.tabs.includes(viewId)) {
                                node.activeViewId = viewId;
                            }
                            return;
                        }
                        if (node.type === 'split') {
                            updateGroup(node.first);
                            updateGroup(node.second);
                        }
                    }
                    updateGroup(ctxPrefs.layout);
                    return ctxPrefs;
                });
                notify();
                break;
            }

            case 'setTheme': {
                const theme = action.theme;
                if (!VALID_THEMES.includes(theme)) break;
                state = {
                    ...state,
                    preferences: {
                        ...state.preferences,
                        theme,
                    },
                };
                notify();
                break;
            }

            case 'setSidebarCollapsed': {
                state = {
                    ...state,
                    preferences: {
                        ...state.preferences,
                        sidebarCollapsed: Boolean(action.collapsed),
                    },
                };
                notify();
                break;
            }

            case 'setSidebarWidth': {
                const width = Math.max(160, Math.min(480, Number(action.width) || 220));
                state = {
                    ...state,
                    preferences: {
                        ...state.preferences,
                        sidebarWidth: width,
                    },
                };
                notify();
                break;
            }

            case 'setContextCollapsed': {
                state = {
                    ...state,
                    preferences: {
                        ...state.preferences,
                        contextCollapsed: Boolean(action.collapsed),
                    },
                };
                notify();
                break;
            }

            case 'setContextWidth': {
                const width = Math.max(240, Math.min(600, Number(action.width) || 340));
                state = {
                    ...state,
                    preferences: {
                        ...state.preferences,
                        contextWidth: width,
                    },
                };
                notify();
                break;
            }

            case 'setTerminals': {
                state = {
                    ...state,
                    terminals: Array.isArray(action.terminals) ? action.terminals : [],
                };
                notify();
                break;
            }

            case 'updateTerminal': {
                const { id, patch } = action;
                if (!id || !patch) break;
                state = {
                    ...state,
                    terminals: state.terminals.map(term =>
                        term.id === id ? { ...term, ...patch } : term
                    ),
                };
                notify();
                break;
            }

            case 'setLimits': {
                state = {
                    ...state,
                    limits: Array.isArray(action.limits) ? action.limits : [],
                };
                notify();
                break;
            }

            case 'setPreferencesStatus': {
                state = {
                    ...state,
                    saveStatus: action.status || 'idle',
                    saveError: action.error || null,
                };
                notify();
                break;
            }

            case 'setConnectionStatus': {
                state = {
                    ...state,
                    connectionStatus: action.status || 'connected',
                };
                notify();
                break;
            }

            default:
                break;
        }
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    return {
        getState,
        dispatch,
        subscribe,
    };
}
