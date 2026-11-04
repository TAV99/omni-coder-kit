/**
 * Context panel component for Omni UI Workspace (T10)
 *
 * Implements:
 * - mountContextPanel({ root, store, viewers, api }) -> { dispose(), openView(view), closeView(viewId) }
 * - Tab switching, closing, splitting, and new view creation
 * - Multi-viewer integration (document, terminal, tasks, files)
 * - Pure layout tree rendering (splits and groups)
 * - Safe resource cleanup on tab close without terminating processes
 */

import { attachTerminalView } from './terminals.mjs';
import { mountBindingEditor } from './binding-editor.mjs';

/**
 * Mounts the context panel in the specified root element.
 *
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {object} options.store Workspace store instance
 * @param {object} [options.viewers] Viewers module { openViewer, loadViewer }
 * @param {object} [options.api] Server API client methods
 * @returns {object} { dispose(), openView(view), closeView(viewId) }
 */
export function mountContextPanel({
    root,
    store,
    viewers = null,
    api = {},
} = {}) {
    if (!root) {
        throw new Error('root element is required');
    }
    if (!store) {
        throw new Error('store is required');
    }

    const doc = root.ownerDocument || document;
    let disposed = false;
    const activeViewers = new Map(); // viewId -> { dispose, ... }

    // Set up panel DOM structure
    root.innerHTML = `
        <div class="os-panel-resize" aria-label="Thay đổi kích thước context panel" tabindex="0"></div>
        <div class="os-panel-top">
            <span>CONTEXT / VIEWS</span>
            <div class="os-panel-actions">
                <button type="button" class="os-btn-close-view" title="Đóng tab hiện tại">×</button>
                <button type="button" class="os-btn-split" title="Chia đôi màn hình" aria-pressed="false">◫</button>
                <button type="button" class="os-btn-collapse-panel" title="Thu gọn panel">›</button>
            </div>
        </div>
        <div class="os-right-tabs" role="tablist">
            <!-- Dynamic tab buttons -->
            <button type="button" class="os-btn-new-tab" title="Mở view mới" style="margin-left:auto;">+</button>
        </div>
        <div class="os-open-menu" hidden style="display:none; padding:8px 12px; gap:6px; border-bottom:1px solid var(--os-line); flex-wrap:wrap;">
            <button type="button" data-kind="binding" style="font-size:11px; padding:4px 8px; color:var(--os-accent); font-weight:600;">⚡ Phân quyền Agents (Role Binding)</button>
            <button type="button" data-kind="document" data-ext="md" style="font-size:11px; padding:4px 8px;">Markdown</button>
            <button type="button" data-kind="document" data-ext="docx" style="font-size:11px; padding:4px 8px;">DOCX</button>
            <button type="button" data-kind="document" data-ext="pdf" style="font-size:11px; padding:4px 8px;">PDF</button>
            <button type="button" data-kind="document" data-ext="html" style="font-size:11px; padding:4px 8px;">HTML</button>
            <button type="button" data-kind="terminal" data-sub="shell" style="font-size:11px; padding:4px 8px;">Terminal Shell</button>
            <button type="button" data-kind="tasks" style="font-size:11px; padding:4px 8px;">Tasks</button>
            <button type="button" data-kind="files" style="font-size:11px; padding:4px 8px;">Files</button>
        </div>
        <div class="os-context-body" style="flex:1; overflow:auto; position:relative; min-height:200px;">
            <!-- Rendered views / split tree -->
        </div>
    `;

    const resizeHandle = root.querySelector('.os-panel-resize');
    const tabsContainer = root.querySelector('.os-right-tabs');
    const newTabBtn = root.querySelector('.os-btn-new-tab');
    const openMenu = root.querySelector('.os-open-menu');
    const bodyContainer = root.querySelector('.os-context-body');
    const closeViewBtn = root.querySelector('.os-btn-close-view');
    const splitBtn = root.querySelector('.os-btn-split');
    const collapsePanelBtn = root.querySelector('.os-btn-collapse-panel');

    // Toggle menu
    newTabBtn.addEventListener('click', () => {
        const isHidden = openMenu.style.display === 'none' || openMenu.hasAttribute('hidden');
        openMenu.style.display = isHidden ? 'flex' : 'none';
        if (isHidden) openMenu.removeAttribute('hidden');
        else openMenu.setAttribute('hidden', '');
    });

    // Handle menu choices
    openMenu.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', async () => {
            openMenu.style.display = 'none';
            openMenu.setAttribute('hidden', '');

            const kind = btn.dataset.kind;
            const ext = btn.dataset.ext;
            const sub = btn.dataset.sub;
            const state = store.getState();
            const contextId = state.selectedContextId;
            if (!contextId) return;

            if (sub === 'shell') {
                // Create user shell via API
                let terminalId = `shell-${Date.now()}`;
                if (api.createTerminal) {
                    try {
                        const term = await api.createTerminal({
                            context_id: contextId,
                            kind: 'user-shell',
                        });
                        terminalId = term.id;
                    } catch (err) {
                        console.error('[context-panel] Failed to create terminal shell:', err);
                    }
                }
                store.dispatch({
                    type: 'openView',
                    contextId,
                    view: {
                        id: `view-${terminalId}`,
                        kind: 'terminal',
                        resourceId: terminalId,
                        title: `Shell (${terminalId.slice(-4)})`,
                    },
                });
            } else if (kind === 'document') {
                const sampleTitles = { md: 'README.md', docx: 'spec.docx', pdf: 'architecture.pdf', html: 'preview.html' };
                store.dispatch({
                    type: 'openView',
                    contextId,
                    view: {
                        id: `view-doc-${ext}-${Date.now().toString(36)}`,
                        kind: 'document',
                        resourceId: `sample.${ext}`,
                        title: sampleTitles[ext] || `file.${ext}`,
                    },
                });
            } else {
                store.dispatch({
                    type: 'openView',
                    contextId,
                    view: {
                        id: `view-${kind}-${Date.now().toString(36)}`,
                        kind,
                        resourceId: null,
                        title: kind === 'binding' ? 'Role Bindings' : (kind.charAt(0).toUpperCase() + kind.slice(1)),
                    },
                });
            }
        });
    });

    // Close view button
    closeViewBtn.addEventListener('click', () => {
        const state = store.getState();
        const contextId = state.selectedContextId;
        const ctxPrefs = state.preferences.contexts[contextId];
        if (!ctxPrefs || !ctxPrefs.layout) return;

        // Find active view in main group
        const activeViewId = ctxPrefs.layout.activeViewId;
        if (activeViewId) {
            closeView(activeViewId);
        }
    });

    // Split button
    splitBtn.addEventListener('click', () => {
        const state = store.getState();
        const contextId = state.selectedContextId;
        const ctxPrefs = state.preferences.contexts[contextId];
        if (!ctxPrefs || !ctxPrefs.layout) return;

        if (ctxPrefs.layout.type === 'split') {
            // Already split, toggle back or do nothing
            return;
        }

        const currentGroupId = ctxPrefs.layout.id;
        const newGroupId = `group-${Date.now().toString(36)}`;
        const newShellView = {
            id: `view-shell-${Date.now().toString(36)}`,
            kind: 'terminal',
            contextId,
            resourceId: null,
            title: 'Shell',
        };

        // Open new view first
        store.dispatch({
            type: 'openView',
            contextId,
            view: newShellView,
        });

        // Split group
        store.dispatch({
            type: 'splitGroup',
            contextId,
            targetGroupId: currentGroupId,
            addedGroup: {
                type: 'group',
                id: newGroupId,
                tabs: [newShellView.id],
                activeViewId: newShellView.id,
            },
            axis: 'vertical',
            ratio: 0.5,
        });
    });

    // Collapse panel button
    collapsePanelBtn.addEventListener('click', () => {
        const state = store.getState();
        store.dispatch({
            type: 'setContextCollapsed',
            collapsed: !state.preferences.contextCollapsed,
        });
    });

    // Resize panel handle
    if (resizeHandle) {
        resizeHandle.addEventListener('pointerdown', e => {
            e.preventDefault();
            resizeHandle.setPointerCapture?.(e.pointerId);
            const startX = e.clientX;
            const startWidth = store.getState().preferences.contextWidth || 340;

            function onPointerMove(moveEvent) {
                const delta = startX - moveEvent.clientX;
                const newWidth = Math.max(240, Math.min(600, startWidth + delta));
                store.dispatch({ type: 'setContextWidth', width: newWidth });
            }

            function onPointerUp(upEvent) {
                resizeHandle.removeEventListener('pointermove', onPointerMove);
                resizeHandle.removeEventListener('pointerup', onPointerUp);
                resizeHandle.removeEventListener('pointercancel', onPointerUp);
            }

            resizeHandle.addEventListener('pointermove', onPointerMove);
            resizeHandle.addEventListener('pointerup', onPointerUp);
            resizeHandle.addEventListener('pointercancel', onPointerUp);
        });

        resizeHandle.addEventListener('keydown', e => {
            const currentWidth = store.getState().preferences.contextWidth || 340;
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                store.dispatch({ type: 'setContextWidth', width: currentWidth + 20 });
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                store.dispatch({ type: 'setContextWidth', width: currentWidth - 20 });
            }
        });
    }

    function renderViewContent(view, container) {
        container.replaceChildren();

        if (view.kind === 'terminal') {
            const termId = view.resourceId || 'shell-01';
            const termView = attachTerminalView({
                terminalId: termId,
                container,
                theme: store.getState().preferences.theme,
                interactive: true,
            });
            activeViewers.set(view.id, termView);
            return;
        }

        if (view.kind === 'document') {
            if (viewers && typeof viewers.openViewer === 'function') {
                const ext = (view.resourceId || '').split('.').pop() || 'md';
                const docWrapper = doc.createElement('div');
                docWrapper.style.height = '100%';
                docWrapper.style.padding = '12px';
                container.appendChild(docWrapper);

                viewers.openViewer({
                    kind: ext,
                    handle: { id: view.resourceId, name: view.title },
                    container: docWrapper,
                    api,
                }).then(viewerInstance => {
                    activeViewers.set(view.id, viewerInstance);
                }).catch(err => {
                    docWrapper.innerHTML = `<div style="padding:16px; color:var(--os-sub);">Không thể mở tài liệu: ${err.message}</div>`;
                });
            } else {
                container.innerHTML = `<div style="padding:16px; color:var(--os-sub);"><h3>${view.title || 'Document'}</h3><p>Tài liệu đang mở (chế độ xem ngoại tuyến).</p></div>`;
            }
            return;
        }

        if (view.kind === 'tasks') {
            container.innerHTML = `
                <div style="padding:16px;">
                    <div class="os-eyebrow" style="font-size:10px; color:var(--os-sub); text-transform:uppercase;">PLAN / TASKS</div>
                    <h3 style="margin:6px 0 12px; font-size:14px;">Tiến độ công việc</h3>
                    <div style="background:var(--os-line); height:4px; border-radius:2px; margin-bottom:12px;">
                        <div style="background:var(--os-accent); width:75%; height:100%;"></div>
                    </div>
                    <ul style="list-style:none; padding:0; margin:0; font-size:11px; line-height:1.8;">
                        <li>✓ Khởi động UI Server</li>
                        <li>✓ Xác thực & Loopback binding</li>
                        <li>✓ Bố cục 3 vùng chuẩn Spec</li>
                        <li>○ Tích hợp hoàn chỉnh (Đang chạy)</li>
                    </ul>
                </div>
            `;
            return;
        }

        if (view.kind === 'files') {
            container.innerHTML = `
                <div style="padding:16px;">
                    <div class="os-eyebrow" style="font-size:10px; color:var(--os-sub); text-transform:uppercase;">PROJECT / FILES</div>
                    <h3 style="margin:6px 0 12px; font-size:14px;">Tập tin dự án</h3>
                    <div class="os-file-tree" style="font-size:11px; line-height:2;">
                        <div>📄 README.md</div>
                        <div>📄 package.json</div>
                        <div>📁 lib/ui/</div>
                        <div>📁 test/</div>
                    </div>
                </div>
            `;
            return;
        }

        if (view.kind === 'binding') {
            const editorWrapper = doc.createElement('div');
            editorWrapper.style.height = '100%';
            editorWrapper.style.overflow = 'auto';
            container.appendChild(editorWrapper);

            try {
                const editorInstance = mountBindingEditor({
                    root: editorWrapper,
                    api,
                    onDraftSaved: (draft) => {
                        console.log('[context-panel] Binding draft saved:', draft);
                    },
                });
                activeViewers.set(view.id, editorInstance);
            } catch (err) {
                editorWrapper.innerHTML = `<div style="padding:16px; color:var(--os-sub);">Không thể mở cấu hình vai trò: ${err.message}</div>`;
            }
            return;
        }

        container.innerHTML = `<div style="padding:16px; color:var(--os-sub);">${view.title || view.id}</div>`;
    }

    function renderLayoutNode(node, container, ctxPrefs) {
        if (!node) return;

        if (node.type === 'group') {
            const groupEl = doc.createElement('div');
            groupEl.className = 'os-layout-group';
            groupEl.style.height = '100%';
            groupEl.style.display = 'flex';
            groupEl.style.flexDirection = 'column';

            const activeView = ctxPrefs.views.find(v => v.id === node.activeViewId);
            if (activeView) {
                renderViewContent(activeView, groupEl);
            } else {
                groupEl.innerHTML = `<div class="os-empty" style="padding:20px; text-align:center; color:var(--os-sub); font-size:11px;">Chưa có view nào được chọn.</div>`;
            }
            container.appendChild(groupEl);
            return;
        }

        if (node.type === 'split') {
            const splitEl = doc.createElement('div');
            splitEl.className = 'os-layout-split';
            splitEl.style.height = '100%';
            splitEl.style.display = 'flex';
            splitEl.style.flexDirection = node.axis === 'vertical' ? 'column' : 'row';

            const firstChild = doc.createElement('div');
            firstChild.style.flex = String(node.ratio);
            firstChild.style.overflow = 'hidden';
            firstChild.style.position = 'relative';

            const divider = doc.createElement('div');
            divider.className = 'os-split-divider';
            divider.style.flex = '0 0 6px';
            divider.style.background = 'var(--os-line, #dfe5e1)';
            divider.style.cursor = node.axis === 'vertical' ? 'row-resize' : 'col-resize';

            const secondChild = doc.createElement('div');
            secondChild.style.flex = String(1 - node.ratio);
            secondChild.style.overflow = 'hidden';
            secondChild.style.position = 'relative';

            splitEl.appendChild(firstChild);
            splitEl.appendChild(divider);
            splitEl.appendChild(secondChild);
            container.appendChild(splitEl);

            renderLayoutNode(node.first, firstChild, ctxPrefs);
            renderLayoutNode(node.second, secondChild, ctxPrefs);
        }
    }

    function render() {
        if (disposed) return;
        const state = store.getState();
        const contextId = state.selectedContextId;
        if (!contextId) return;

        const ctxPrefs = state.preferences.contexts[contextId];
        if (!ctxPrefs) return;

        // Render Tabs
        // Remove old tab buttons (except new-tab button)
        tabsContainer.querySelectorAll('.os-tab-btn').forEach(b => b.remove());
        const views = ctxPrefs.views || [];
        const activeViewId = ctxPrefs.layout.activeViewId;

        for (const view of views) {
            const tabBtn = doc.createElement('button');
            tabBtn.type = 'button';
            tabBtn.className = `os-tab-btn ${view.id === activeViewId ? 'on' : ''}`;
            tabBtn.textContent = view.title || view.id;
            tabBtn.style.padding = '8px 12px';
            tabBtn.style.fontSize = '11px';
            tabBtn.style.border = 'none';
            tabBtn.style.background = 'none';
            tabBtn.style.cursor = 'pointer';
            tabBtn.style.borderBottom = view.id === activeViewId ? '2px solid var(--os-accent)' : '2px solid transparent';
            tabBtn.style.color = view.id === activeViewId ? 'var(--os-text)' : 'var(--os-sub)';

            tabBtn.addEventListener('click', () => {
                store.dispatch({
                    type: 'setActiveTab',
                    contextId,
                    groupId: ctxPrefs.layout.id,
                    viewId: view.id,
                });
            });

            tabsContainer.insertBefore(tabBtn, newTabBtn);
        }

        // Render Layout Body
        bodyContainer.replaceChildren();
        renderLayoutNode(ctxPrefs.layout, bodyContainer, ctxPrefs);
    }

    const unsub = store.subscribe(() => {
        render();
    });

    render();

    function closeView(viewId) {
        const state = store.getState();
        const contextId = state.selectedContextId;
        if (!contextId) return;

        // Clean up active viewer if present
        const activeInstance = activeViewers.get(viewId);
        if (activeInstance && typeof activeInstance.dispose === 'function') {
            activeInstance.dispose();
            activeViewers.delete(viewId);
        }

        store.dispatch({
            type: 'closeView',
            contextId,
            viewId,
        });
    }

    return {
        dispose: () => {
            if (disposed) return;
            disposed = true;
            unsub();
            for (const [id, instance] of activeViewers) {
                if (instance && typeof instance.dispose === 'function') {
                    instance.dispose();
                }
            }
            activeViewers.clear();
            root.replaceChildren();
        },
        openView: view => {
            const contextId = store.getState().selectedContextId;
            if (contextId && view) {
                store.dispatch({ type: 'openView', contextId, view });
            }
        },
        closeView,
    };
}
