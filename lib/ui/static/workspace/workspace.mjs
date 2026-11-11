/**
 * Full 3-Region Workspace mounting entrypoint for Omni UI (T09/T10)
 *
 * Implements:
 * - mountWorkspace({ root, api, store }) -> { dispose() }
 * - 3 regions: Sidebar, Main Work, Context Panel
 * - Responsive breakpoints and collapsible panels
 * - Debounced preferences saving with optimistic concurrency (CAS)
 * - Timeline and Terminal priority toggling
 * - Clean teardown on dispose()
 */

import { createWorkspaceStore } from './store.mjs';
import { createThemeManager } from './theme.mjs';
import { mountContextPanel } from './context-panel.mjs';
import { mountTimeline } from './timeline.mjs';
import { attachTerminalView } from './terminals.mjs';

/**
 * Mounts the full Omni UI Workspace.
 *
 * @param {object} options
 * @param {HTMLElement} options.root
 * @param {object} options.api Client API adapter
 * @param {object} [options.store] Optional store instance (creates one if not provided)
 * @param {object} [options.viewers] Viewers module
 * @returns {object} { dispose() }
 */
export function mountWorkspace({
    root,
    api = {},
    store = null,
    viewers = null,
} = {}) {
    if (!root) {
        throw new Error('root element is required');
    }

    const doc = root.ownerDocument || document;
    let disposed = false;
    const wsStore = store || createWorkspaceStore();

    // Setup Theme Manager
    const themeManager = createThemeManager({
        rootElement: root,
        onThemeChange: ({ theme }) => {
            // Can notify terminals or update stylesheets
        },
    });

    // Render 3-region skeleton
    root.innerHTML = `
        <div id="omni-web-final" data-theme="${wsStore.getState().preferences.theme}">
            <header class="os-top">
                <div class="os-brand">
                    <span class="os-mark">o</span>
                    <b>omni</b>
                    <span class="os-divider">/</span>
                    <span class="os-project-name">workspace</span>
                    <span class="os-branch">local / 3.2.0</span>
                </div>
                <div class="os-top-actions">
                    <label class="os-theme-label">
                        <span class="os-sr">Theme</span>
                        <select id="os-theme" aria-label="Theme">
                            <option value="system">System (Auto)</option>
                            <option value="graphite">Graphite (Light)</option>
                            <option value="paper">Paper (Warm Light)</option>
                            <option value="midnight">Midnight (Dark)</option>
                            <option value="nordic">Nordic (Arctic Dark)</option>
                            <option value="obsidian">Obsidian (OLED Black)</option>
                            <option value="emerald">Emerald (Forest Dark)</option>
                            <option value="tokyo">Tokyo Night (Neon)</option>
                        </select>
                    </label>
                    <button id="os-focus" type="button" aria-pressed="false" title="Ẩn/hiện context panel">Panel</button>
                </div>
            </header>
            <div class="os-layout">
                <aside class="os-sidebar">
                    <div class="os-project">
                        <div class="os-eyebrow">LOCAL WORKSPACE</div>
                        <h2 class="os-project-title">omni-coder-kit</h2>
                        <div class="os-mode" aria-label="Chế độ session">
                            <button data-mode="single" type="button">Single</button>
                            <button data-mode="squad" class="on" type="button">Squad</button>
                        </div>
                        <div class="os-session">
                            <span class="os-dot"></span>
                            <span id="os-session-id">Session Active</span>
                            <span id="os-session-status">Đang chạy</span>
                        </div>
                    </div>
                    <div class="os-side-section">
                        <div class="os-section-label" style="display:flex; justify-content:space-between; align-items:center;">
                            <span id="os-role-title">SQUAD ROLES</span>
                            <button id="os-add-role" type="button" title="Phân quyền & kết nối Agents" aria-label="Thêm vai trò / Phân quyền agents" style="background:none; border:none; cursor:pointer; color:var(--os-sub); font-size:14px; padding:0 4px;">+</button>
                        </div>
                        <div id="os-role-list">
                            <!-- Dynamic roles -->
                        </div>
                        <button id="os-manage-bindings" type="button" style="margin-top:10px; width:100%; padding:7px 10px; font-size:11px; font-weight:500; background:var(--os-soft); border:1px solid var(--os-line); border-radius:4px; color:var(--os-text); cursor:pointer; display:flex; align-items:center; justify-content:center; gap:6px;">
                            <span>⚙ Phân quyền Agents</span>
                        </button>
                    </div>
                    <div class="os-side-section os-rates">
                        <div class="os-section-label">RATE LIMITS</div>
                        <div id="os-limits-list">
                            <small>— Đang kiểm tra quota</small>
                        </div>
                    </div>
                    <div class="os-side-bottom">
                        <span class="os-dot"></span> Daemon online <span>LOCAL</span>
                    </div>
                </aside>

                <main class="os-main">
                    <div class="os-heading">
                        <div class="os-eyebrow" id="os-heading-meta">SESSION ACTIVE</div>
                        <h1 id="os-heading-title">Omni UI Workspace<span>.</span></h1>
                        <p id="os-description">Theo dõi công việc. Đối chiếu kết quả. Giữ tập trung.</p>
                    </div>
                    <div class="os-work-toolbar">
                        <div class="os-view-switch" aria-label="Ưu tiên workspace">
                            <button class="on" type="button" data-priority="timeline">Timeline</button>
                            <button type="button" data-priority="terminal">Terminal</button>
                        </div>
                        <span class="os-live"><span class="os-dot"></span> LIVE</span>
                    </div>
                    <div class="os-work-content" style="flex:1; min-height:280px; position:relative;">
                        <div id="os-timeline-container" style="height:100%;"></div>
                        <div id="os-terminal-container" style="height:100%; display:none;"></div>
                    </div>
                    <form class="os-composer" id="os-composer">
                        <label><span class="os-sr">Người nhận</span><select id="os-recipient"><option value="orchestrator">@orchestrator</option></select></label>
                        <textarea id="os-message" rows="2" placeholder="Trao đổi với squad…"></textarea>
                        <div class="os-composer-bottom">
                            <span>Giao qua inbox · không ngắt lượt đang chạy</span>
                            <button type="submit" aria-label="Gửi tin nhắn">↑</button>
                        </div>
                    </form>
                </main>

                <aside class="os-right" id="os-right-panel">
                    <!-- Mounted context panel -->
                </aside>
            </div>
            <footer class="os-footer">
                <span><span class="os-dot"></span> LOCAL WORKSPACE</span>
                <span id="os-save-status">Đã đồng bộ</span>
            </footer>
        </div>
    `;

    // Elements
    const themeSelect = root.querySelector('#os-theme');
    const panelFocusBtn = root.querySelector('#os-focus');
    const layoutContainer = root.querySelector('.os-layout');
    const rightPanel = root.querySelector('#os-right-panel');
    const modeButtons = root.querySelectorAll('[data-mode]');
    const priorityButtons = root.querySelectorAll('[data-priority]');
    const timelineContainer = root.querySelector('#os-timeline-container');
    const terminalContainer = root.querySelector('#os-terminal-container');
    const composerForm = root.querySelector('#os-composer');
    const messageInput = root.querySelector('#os-message');
    const roleList = root.querySelector('#os-role-list');
    const limitsList = root.querySelector('#os-limits-list');
    const saveStatusEl = root.querySelector('#os-save-status');

    // Theme selector
    if (themeSelect) {
        themeSelect.value = wsStore.getState().preferences.theme;
        themeSelect.addEventListener('change', e => {
            wsStore.dispatch({ type: 'setTheme', theme: e.target.value });
        });
    }

    // Mount Context Panel
    const contextPanelInstance = mountContextPanel({
        root: rightPanel,
        store: wsStore,
        viewers,
        api,
    });

    // Mount Timeline
    const timelineInstance = mountTimeline({
        contextId: wsStore.getState().selectedContextId || 'ctx-default',
        container: timelineContainer,
        events: [],
        onOpenResource: res => {
            if (res.kind === 'document' || res.kind === 'file') {
                contextPanelInstance.openView({
                    id: `view-${res.id || Date.now()}`,
                    kind: 'document',
                    resourceId: res.path || res.id,
                    title: res.title || res.path || res.id,
                });
            }
        },
    });

    // Mount Primary Terminal View
    // The controller may supply the primary terminal's transport
    // (api.primaryTerminal); a context without one shows the reason instead.
    let primaryTerminalInstance = null;
    let primaryTerminalKey = null;
    function ensurePrimaryTerminal(contextId, ctx) {
        const spec = typeof api.primaryTerminal === 'function'
            ? api.primaryTerminal(contextId, ctx)
            : { terminalId: ctx?.authoritySessionId || `term-${contextId}` };
        const key = spec ? `${contextId}:${spec.terminalId || ''}` : `${contextId}:none`;
        if (primaryTerminalKey === key) {
            primaryTerminalInstance?.fit();
            return;
        }
        if (primaryTerminalInstance) {
            primaryTerminalInstance.dispose();
            primaryTerminalInstance = null;
        }
        primaryTerminalKey = key;
        terminalContainer.replaceChildren();
        if (!spec || !spec.terminalId) {
            const note = doc.createElement('div');
            note.className = 'os-terminal-unavailable';
            note.style.padding = '24px 16px';
            note.style.fontSize = '12px';
            note.style.color = 'var(--os-sub, #66746e)';
            note.textContent = spec?.reason || 'Không có terminal cho context này.';
            terminalContainer.appendChild(note);
            return;
        }
        primaryTerminalInstance = attachTerminalView({
            terminalId: spec.terminalId,
            container: terminalContainer,
            transport: spec.transport || {},
            theme: wsStore.getState().preferences.theme,
            interactive: spec.interactive !== false,
            onState: spec.onState || null,
            onError: spec.onError || null,
        });
        if (typeof spec.onAttach === 'function') spec.onAttach(primaryTerminalInstance);
    }

    // Toggle Panel Focus
    if (panelFocusBtn) {
        panelFocusBtn.addEventListener('click', () => {
            const isCollapsed = wsStore.getState().preferences.contextCollapsed;
            wsStore.dispatch({ type: 'setContextCollapsed', collapsed: !isCollapsed });
        });
    }

    // Role Binding button triggers
    const addRoleBtn = root.querySelector('#os-add-role');
    const manageBindingsBtn = root.querySelector('#os-manage-bindings');
    const openBindingView = () => {
        const state = wsStore.getState();
        const contextId = state.selectedContextId;
        if (!contextId) return;
        contextPanelInstance.openView({
            id: 'view-role-binding',
            kind: 'binding',
            resourceId: null,
            title: 'Role Bindings',
        });
        if (state.preferences.contextCollapsed) {
            wsStore.dispatch({ type: 'setContextCollapsed', collapsed: false });
        }
    };
    if (addRoleBtn) addRoleBtn.addEventListener('click', openBindingView);
    if (manageBindingsBtn) manageBindingsBtn.addEventListener('click', openBindingView);

    // Mode Buttons
    modeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetMode = btn.dataset.mode;
            const contexts = wsStore.getState().contexts;
            const targetContext = contexts.find(c => c.mode === targetMode);
            if (targetContext) {
                wsStore.dispatch({ type: 'selectContext', contextId: targetContext.id });
            }
        });
    });

    // Priority Switcher (Timeline vs Terminal)
    priorityButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const contextId = wsStore.getState().selectedContextId;
            if (contextId) {
                wsStore.dispatch({ type: 'setPriority', contextId, priority: btn.dataset.priority });
            }
        });
    });

    // Message Composer: Enter sends, Shift+Enter is a new line. An IME
    // composition (Vietnamese Telex) keeps its own Enter.
    if (composerForm && messageInput) {
        messageInput.addEventListener('keydown', e => {
            if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            if (typeof composerForm.requestSubmit === 'function') composerForm.requestSubmit();
            else composerForm.dispatchEvent(new Event('submit', { cancelable: true }));
        });
    }
    if (composerForm) {
        composerForm.addEventListener('submit', async e => {
            e.preventDefault();
            const text = messageInput.value.trim();
            if (!text) return;

            if (!api.sendMessage) return;
            const sendBtn = composerForm.querySelector('button[type="submit"]');
            const statusEl = composerForm.querySelector('.os-composer-bottom span');
            if (sendBtn) sendBtn.disabled = true;
            try {
                const recipient = composerForm.querySelector('#os-recipient');
                const result = await api.sendMessage({ message: text, to: recipient ? recipient.value : 'orchestrator' });
                messageInput.value = '';
                if (statusEl) statusEl.textContent = result?.to ? `Đã gửi @${result.to} — đọc ở lượt kế tiếp` : 'Đã gửi';
            } catch (err) {
                // Keep the draft so nothing typed is lost.
                if (statusEl) statusEl.textContent = `Chưa gửi được: ${err.message}`;
            } finally {
                if (sendBtn) sendBtn.disabled = false;
            }
        });
    }

    // Preferences autosave debounce. Only a real change saves: the revision a
    // save returns is not a change, or every save would schedule the next.
    let saveTimeout = null;
    const prefsKey = prefs => JSON.stringify({ ...prefs, revision: undefined });
    let lastSavedKey = prefsKey(wsStore.getState().preferences);
    function scheduleSavePreferences() {
        const key = prefsKey(wsStore.getState().preferences);
        if (key === lastSavedKey) return;
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(async () => {
            if (disposed || !api.savePreferences) return;
            const prefs = wsStore.getState().preferences;
            lastSavedKey = prefsKey(prefs);
            try {
                wsStore.dispatch({ type: 'setPreferencesStatus', status: 'saving' });
                const res = await api.savePreferences(prefs);
                if (res && res.revision) {
                    wsStore.dispatch({
                        type: 'setPreferences',
                        preferences: { revision: res.revision },
                    });
                }
                wsStore.dispatch({ type: 'setPreferencesStatus', status: 'saved' });
            } catch (err) {
                console.warn('[workspace] Preferences save warning:', err.message);
                wsStore.dispatch({ type: 'setPreferencesStatus', status: 'error', error: err.message });
            }
        }, 500);
    }

    // Subscribe to store updates
    const unsubStore = wsStore.subscribe(state => {
        if (disposed) return;

        // Theme
        const theme = state.preferences.theme;
        themeManager.setTheme(theme);
        const appEl = root.querySelector('#omni-web-final');
        if (appEl && appEl.dataset.theme !== theme) appEl.dataset.theme = theme;
        primaryTerminalInstance?.setTheme(theme);
        if (themeSelect && themeSelect.value !== theme) {
            themeSelect.value = theme;
        }

        // Panel collapse
        const panelCollapsed = state.preferences.contextCollapsed;
        layoutContainer.classList.toggle('panel-hidden', panelCollapsed);
        if (panelFocusBtn) {
            panelFocusBtn.setAttribute('aria-pressed', String(!panelCollapsed));
        }

        // Selected Context
        const contextId = state.selectedContextId;
        const currentCtx = state.contexts.find(c => c.id === contextId);
        const mode = currentCtx ? currentCtx.mode : 'squad';

        modeButtons.forEach(btn => {
            const active = btn.dataset.mode === mode;
            btn.classList.toggle('on', active);
            btn.setAttribute('aria-pressed', String(active));
        });

        // Priority switch
        const ctxPrefs = state.preferences.contexts[contextId];
        const priority = ctxPrefs ? ctxPrefs.priority : 'timeline';
        priorityButtons.forEach(btn => {
            const active = btn.dataset.priority === priority;
            btn.classList.toggle('on', active);
            btn.setAttribute('aria-pressed', String(active));
        });

        if (priority === 'terminal') {
            timelineContainer.style.display = 'none';
            terminalContainer.style.display = 'block';
            ensurePrimaryTerminal(contextId, currentCtx);
        } else {
            timelineContainer.style.display = 'block';
            terminalContainer.style.display = 'none';
        }

        // Save status
        if (saveStatusEl) {
            saveStatusEl.textContent = state.saveStatus === 'saving' ? 'Đang lưu…' : state.saveStatus === 'error' ? 'Lỗi lưu cài đặt' : 'Đã đồng bộ';
        }

        scheduleSavePreferences();
    });

    return {
        store: wsStore,
        timeline: timelineInstance,
        contextPanel: contextPanelInstance,
        elements: { roleList, limitsList, root },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            if (saveTimeout) clearTimeout(saveTimeout);
            unsubStore();
            contextPanelInstance.dispose();
            timelineInstance.dispose();
            if (primaryTerminalInstance) {
                primaryTerminalInstance.dispose();
                primaryTerminalInstance = null;
            }
            root.replaceChildren();
        },
    };
}
