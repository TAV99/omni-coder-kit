// omni ui workspace page controller. It signs in, loads the workspace from
// the server and feeds the mounted modules with real data: roles, gates,
// tasks, the ledger/discussion/transcript timeline (/api/events), provider
// limits and the orchestrator terminal (/api/pty, the one process `omni ui`
// started — never a second one). Everything from the server is data: it is
// shown with textContent, never as markup (SPEC-SQUAD-P6 §2.2).

import { mountWorkspace } from './workspace.mjs';
import { createWorkspaceStore } from './store.mjs';
import { mountLimitsView } from './limits.mjs';
import { renderTextViewer } from './viewers/text.mjs';
import { mountBindingEditor } from './binding-editor.mjs';

const MAX_EVENTS = 600;
const SPEAKERS = { user: 'Bạn', assistant: 'Orchestrator', tool: 'Tool' };

export class ApiError extends Error {
    constructor(message, { status = 0, code = null } = {}) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

// Old routes answer { error: 'text', code }, new ones { error: { code, message } }.
export function errorFrom(status, body) {
    const err = body && body.error;
    if (err && typeof err === 'object') return new ApiError(err.message || `HTTP ${status}`, { status, code: err.code || null });
    return new ApiError(typeof err === 'string' ? err : `HTTP ${status}`, { status, code: (body && body.code) || null });
}

export function createApiClient({ fetchImpl = (...args) => fetch(...args), uuid = () => crypto.randomUUID() } = {}) {
    async function call(method, url, body) {
        const init = { method, credentials: 'same-origin', headers: {} };
        if (body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        const res = await fetchImpl(url, init);
        const text = await res.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        if (!res.ok) throw errorFrom(res.status, parsed);
        return parsed;
    }
    return {
        call,
        login: (token) => fetchImpl('/api/login', { method: 'POST', credentials: 'same-origin', headers: { Authorization: `Bearer ${token}` } }),
        state: () => call('GET', '/api/state'),
        workspace: () => call('GET', '/api/workspace'),
        preferences: () => call('GET', '/api/preferences'),
        limits: () => call('GET', '/api/limits'),
        listFiles: (directory = '') => call('GET', `/api/files?directory=${encodeURIComponent(directory)}`),
        openFile: (relativePath) => call('POST', '/api/files/open', { relative_path: relativePath }),
        fileContent: async (handle, revision) => {
            const res = await fetchImpl(`/api/files/${encodeURIComponent(handle)}/content?revision=${encodeURIComponent(revision)}`, { credentials: 'same-origin' });
            if (!res.ok) {
                let body = null;
                try { body = await res.json(); } catch { body = null; }
                throw errorFrom(res.status, body);
            }
            return res.text();
        },
        savePreferences: (prefs) => call('PUT', '/api/preferences', { value: prefs, expected_revision: prefs.revision }),
        // A retry reuses the message id, so the daemon does not take it twice.
        sendMessage: ({ message, to = 'orchestrator', messageId = uuid() }) => call('POST', '/api/message', { message_id: messageId, to, body: message }),
        createTerminal: ({ context_id, kind = 'user-shell', cwd_relative }) => call('POST', '/api/terminals', { request_id: uuid(), context_id, kind, ...(cwd_relative ? { cwd_relative } : {}) }),
        preflightBinding: (candidate) => call('POST', '/api/bindings/preflight', { candidate }),
        saveBindingDraft: (candidate) => call('POST', '/api/bindings/drafts', { candidate }),
        ptyStart: (resume) => call('POST', '/api/pty/start', { resume }),
        ptyClaim: (clientId) => call('POST', '/api/pty/claim', { client_id: clientId }),
    };
}

function shortJson(fields) {
    return Object.entries(fields).filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`).join('  ');
}

// One /api/events entry (feed.js) as a timeline event (timeline.mjs).
export function timelineEvent(entry) {
    const fields = entry.fields || {};
    const { body, ...rest } = fields;
    if (entry.source === 'transcript') {
        const phase = rest.phase && rest.phase !== 'final_answer' ? rest.phase : '';
        return { sender: SPEAKERS[entry.type] || entry.type, target: entry.type === 'user' ? 'Orchestrator' : null,
            timestamp: entry.at, title: phase || null, message: body || '' };
    }
    if (entry.source === 'discussion') {
        return { sender: fields.from || fields.role || 'discussion', target: fields.to || null, timestamp: entry.at,
            title: entry.type, message: body || shortJson(rest) };
    }
    return { sender: fields.role || fields.owner_role || 'ledger', target: null, timestamp: entry.at,
        title: entry.type, message: [body, shortJson(rest)].filter(Boolean).join('\n') };
}

export function gateEvents(gates = []) {
    return gates.map((gate) => ({ sender: 'omni', target: 'Bạn', title: `Chờ duyệt: ${gate.phase}${gate.task_id ? ` · ${gate.task_id}` : ''}`,
        message: gate.summary || '', gate: { command: gate.command } }));
}

// The binding the project runs now, as the editor's starting candidate.
export function bindingCandidate(state) {
    const roles = state?.roles || [];
    if (!roles.length) return null;
    const slot = (role) => ({ runtime: role.runtime, model: role.model, ...(role.effort ? { effort: role.effort } : {}) });
    const orchestrator = roles.find((role) => role.id === 'orchestrator');
    const reviewer = roles.find((role) => role.id === 'reviewer');
    return {
        schema_version: 1,
        preset: state.preset || 'squad',
        roles: {
            ...(orchestrator ? { orchestrator: slot(orchestrator) } : {}),
            worker: roles.filter((role) => role.id !== 'orchestrator' && role.id !== 'reviewer').map((role) => ({ id: role.id, ...slot(role) })),
            ...(reviewer ? { reviewer: slot(reviewer) } : {}),
        },
    };
}

function el(doc, tag, text, className) {
    const node = doc.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
}

function roleSymbol(id) {
    if (id === 'orchestrator') return 'O';
    if (id === 'reviewer') return 'R';
    const n = /(\d+)$/.exec(id);
    return n ? `W${n[1]}` : id.slice(0, 2).toUpperCase();
}

export function renderRoles(doc, container, roles = [], leases = []) {
    const busy = new Set(leases.map((lease) => lease.owner_role).filter(Boolean));
    if (!roles.length) {
        container.replaceChildren(el(doc, 'small', 'Chưa có binding — chạy omni squad setup', 'os-empty'));
        return;
    }
    container.replaceChildren(...roles.map((role) => {
        const row = el(doc, 'div', null, `os-role${role.id === 'orchestrator' ? ' current' : ' os-squad'}`);
        const text = el(doc, 'span');
        text.append(el(doc, 'b', role.id), el(doc, 'small', [role.runtime, role.model, role.effort].filter(Boolean).join(' · ')));
        const dot = el(doc, 'span', null, busy.has(role.id) ? 'os-dot' : 'os-ring');
        dot.title = busy.has(role.id) ? 'đang chạy' : 'rảnh';
        row.append(el(doc, 'span', roleSymbol(role.id), 'os-role-symbol'), text, dot);
        return row;
    }));
}

export function renderTasks(doc, container, state) {
    container.replaceChildren();
    const wrap = el(doc, 'div', null, 'os-view-pad');
    wrap.append(el(doc, 'div', 'PLAN / TASKS', 'os-eyebrow'));
    const tasks = state?.tasks || [];
    const done = tasks.filter((task) => /VERIFIED|DONE|INTEGRATED|COMPLETED/.test(task.state)).length;
    wrap.append(el(doc, 'h3', tasks.length ? `${done}/${tasks.length} task xong` : 'Chưa có task'));
    if (state?.session) wrap.append(el(doc, 'p', `session ${state.session.id} · ${state.session.state} · plan r${state.session.plan_revision}`, 'os-panel-notice'));
    for (const task of tasks) {
        const row = el(doc, 'div', null, 'os-task-row');
        row.append(el(doc, 'b', task.task_id), el(doc, 'span', task.state, 'os-task-state'));
        const parts = [task.title, task.worker || task.owner_role, `attempt ${task.attempt}`];
        if (task.qc_review) parts.push(`review: ${task.qc_review.verdict || task.qc_review.status}`);
        if (task.last_outcome) parts.push(`last: ${task.last_outcome.status}${task.last_outcome.code ? ` ${task.last_outcome.code}` : ''}`);
        row.append(el(doc, 'small', parts.filter(Boolean).join(' · ')));
        wrap.append(row);
    }
    if (state?.gates?.length) {
        wrap.append(el(doc, 'div', 'CHỜ BẠN DUYỆT', 'os-eyebrow'));
        for (const gate of state.gates) {
            const box = el(doc, 'div', null, 'os-approval');
            box.append(el(doc, 'span', `${gate.phase}${gate.task_id ? ` · ${gate.task_id}` : ''}`, 'os-eyebrow'), el(doc, 'code', gate.command),
                el(doc, 'small', 'Duyệt trong terminal của bạn (TTY), không duyệt từ trang này.'));
            wrap.append(box);
        }
    }
    container.append(wrap);
    return { dispose() { container.replaceChildren(); } };
}

function mountFileBrowser(doc, container, api) {
    let disposed = false;
    let viewer = null;
    const wrap = el(doc, 'div', null, 'os-view-pad');
    container.replaceChildren(wrap);

    async function showDir(directory) {
        if (disposed) return;
        viewer?.dispose();
        viewer = null;
        wrap.replaceChildren(el(doc, 'div', `PROJECT / ${directory || '.'}`, 'os-eyebrow'), el(doc, 'p', 'Đang tải…', 'os-panel-notice'));
        try {
            const listing = await api.listFiles(directory);
            if (disposed) return;
            wrap.lastChild.remove();
            if (directory) {
                const up = el(doc, 'button', '↰ ..', 'os-file-row');
                up.type = 'button';
                up.addEventListener('click', () => showDir(directory.split('/').slice(0, -1).join('/')));
                wrap.append(up);
            }
            for (const entry of listing.entries || []) {
                const rel = directory ? `${directory}/${entry.name}` : entry.name;
                const row = el(doc, 'button', null, 'os-file-row');
                row.type = 'button';
                row.append(el(doc, 'span', `${entry.isDirectory ? '📁' : '📄'} ${entry.name}`), el(doc, 'small', entry.isDirectory ? '' : entry.type));
                row.addEventListener('click', () => (entry.isDirectory ? showDir(rel) : showFile(rel, directory)));
                wrap.append(row);
            }
            if (listing.nextCursor !== null && listing.nextCursor !== undefined) wrap.append(el(doc, 'p', `… còn ${listing.total - listing.entries.length} mục`, 'os-panel-notice'));
        } catch (err) {
            wrap.lastChild.textContent = `Không đọc được thư mục: ${err.message}`;
        }
    }

    async function showFile(rel, directory) {
        wrap.replaceChildren(el(doc, 'div', rel, 'os-eyebrow'));
        const back = el(doc, 'button', '↰ quay lại', 'os-file-row');
        back.type = 'button';
        back.addEventListener('click', () => showDir(directory));
        const body = el(doc, 'div');
        wrap.append(back, body);
        try {
            const meta = await api.openFile(rel);
            if (!['text', 'markdown', 'html'].includes(meta.type)) {
                body.append(el(doc, 'p', `Tệp ${meta.type} (${meta.size} byte) — xem trực tiếp chưa hỗ trợ ở đây.`, 'os-panel-notice'));
                return;
            }
            const content = await api.fileContent(meta.handle, meta.revision);
            if (disposed) return;
            // Shown as text: a file in the project may be agent-written.
            viewer = renderTextViewer({ content, container: body });
        } catch (err) {
            body.append(el(doc, 'p', `Không mở được: ${err.message}`, 'os-panel-notice'));
        }
    }

    showDir('');
    return { dispose() { disposed = true; viewer?.dispose(); container.replaceChildren(); } };
}

function notice(doc, container, text) {
    container.replaceChildren(el(doc, 'p', text, 'os-view-pad os-panel-notice'));
    return { dispose() { container.replaceChildren(); } };
}

export async function start({ doc = document, win = window, api = createApiClient() } = {}) {
    const rootEl = doc.getElementById('omni-root');
    const token = new URLSearchParams(win.location.hash.slice(1)).get('token');
    if (token) {
        // Trade the fragment token for an HttpOnly cookie, then drop it from the address bar.
        await api.login(token);
        win.history.replaceState(null, '', win.location.pathname);
    }
    let state;
    try {
        state = await api.state();
    } catch (err) {
        rootEl.replaceChildren(el(doc, 'p', err.status === 403 ? 'Chưa đăng nhập — mở đúng URL mà "omni ui" in ra.' : `Không tải được: ${err.message}`, 'os-boot'));
        return null;
    }
    const [workspace, preferences, limits] = await Promise.all([
        api.workspace().catch(() => ({ contexts: [], selectedContextId: 'squad' })),
        api.preferences().catch(() => null),
        api.limits().catch(() => []),
    ]);
    const prefs = preferences ? { ...preferences } : {};
    // Single sessions are not served by this page yet: open on Squad.
    prefs.selectedContextId = 'squad';
    const store = createWorkspaceStore({ preferences: prefs, contexts: workspace.contexts || [], limits });
    const pty = { status: state.pty || { available: false, reason: 'unknown' }, view: null, clientId: null };

    const adapter = {
        ...api,
        primaryTerminal(contextId) {
            if (contextId !== 'squad') return { reason: 'Chế độ Single chưa có trong trang này — dùng "omni" trong terminal của bạn.' };
            if (!pty.status.available) return { reason: `Không có terminal orchestrator: ${pty.status.reason}. Phần còn lại của trang vẫn chạy.` };
            if (typeof win.Terminal !== 'function') return { reason: 'Không có terminal: chưa cài xterm.js (npm i @xterm/xterm @xterm/addon-fit).' };
            return {
                terminalId: 'orchestrator',
                transport: { streamUrl: '/api/pty/stream', inputUrl: '/api/pty/input', claimUrl: '/api/pty/claim', resizeUrl: '/api/pty/resize' },
                onAttach: (view) => { pty.view = view; },
                onState: (status, clientId) => {
                    const wasWriter = pty.status.writer === pty.clientId;
                    pty.status = { ...pty.status, ...status, available: true };
                    pty.clientId = clientId;
                    renderPtyBar();
                    if (status.writer === clientId && !wasWriter && pty.view) pty.view.syncSize();
                },
            };
        },
        renderView(view, container) {
            if (view.kind === 'tasks') {
                const handle = renderTasks(doc, container, latestState);
                taskViews.add(container);
                return { dispose() { taskViews.delete(container); handle.dispose(); } };
            }
            if (view.kind === 'files' || view.kind === 'document') return mountFileBrowser(doc, container, api);
            if (view.kind === 'binding') {
                const wrap = el(doc, 'div');
                wrap.style.height = '100%';
                wrap.style.overflow = 'auto';
                container.append(wrap);
                return mountBindingEditor({ root: wrap, api: adapter, initialCandidate: bindingCandidate(latestState) });
            }
            if (view.kind === 'terminal' && !view.resourceId) return notice(doc, container, 'Terminal orchestrator nằm ở vùng giữa (nút Terminal). Mở shell riêng bằng nút + → Terminal Shell (cần omni ui --allow-shell).');
            return null;
        },
    };

    let latestState = state;
    const taskViews = new Set();
    rootEl.replaceChildren();
    const ws = mountWorkspace({ root: rootEl, api: adapter, store });

    // Header and sidebar from the real project.
    const q = (selector) => rootEl.querySelector(selector);
    const singleBtn = q('[data-mode="single"]');
    if (singleBtn) { singleBtn.disabled = true; singleBtn.title = 'Chế độ Single chưa có trong trang này'; }
    const daemonLine = q('.os-side-bottom');
    const livePill = q('.os-live');

    // Orchestrator controls beside the Timeline/Terminal switch.
    const ptyBar = el(doc, 'span', null, 'os-pty-bar');
    const ptyStatus = el(doc, 'span', '', 'os-pty-status');
    const mkBtn = (text, onClick) => { const b = el(doc, 'button', text, 'os-pty-btn'); b.type = 'button'; b.addEventListener('click', onClick); return b; };
    const startBtn = mkBtn('Start', () => api.ptyStart(false).catch((err) => { ptyStatus.textContent = err.message; }));
    const resumeBtn = mkBtn('Resume', () => api.ptyStart(true).catch((err) => { ptyStatus.textContent = err.message; }));
    const claimBtn = mkBtn('Gõ ở tab này', () => pty.clientId && api.ptyClaim(pty.clientId).catch((err) => { ptyStatus.textContent = err.message; }));
    ptyBar.append(ptyStatus, startBtn, resumeBtn, claimBtn);
    q('.os-work-toolbar')?.insertBefore(ptyBar, livePill);
    // Clicking into the terminal is the person choosing to type here: take
    // the writer seat, as the "Gõ ở tab này" button does (one writer stays).
    q('#os-terminal-container')?.addEventListener('mousedown', () => {
        const s = pty.status;
        if (!pty.clientId || s.status !== 'running' || s.writer === pty.clientId) return;
        api.ptyClaim(pty.clientId).catch((err) => { ptyStatus.textContent = err.message; });
    });

    function renderPtyBar() {
        const s = pty.status;
        const stopped = s.status !== 'running';
        const writer = pty.clientId && s.writer === pty.clientId;
        const parts = [];
        if (!s.available) parts.push('orchestrator: không có terminal');
        else if (s.status === 'running') parts.push(`${s.runtime} · ${s.model} · đang chạy`);
        else if (s.status === 'exited') parts.push(`orchestrator đã thoát (code ${s.exit_code})`);
        else if (s.status === 'failed') parts.push(`không khởi động được: ${s.error}`);
        else parts.push('orchestrator chưa chạy');
        if (s.clients > 1) parts.push(writer ? 'bạn đang gõ' : 'tab khác đang gõ');
        ptyStatus.textContent = parts.join(' · ');
        startBtn.hidden = !s.available || !stopped;
        startBtn.textContent = s.status === 'idle' ? 'Start' : 'Start lại';
        resumeBtn.hidden = !s.available || !stopped || !s.resumable;
        claimBtn.hidden = !s.available || stopped || !pty.clientId || writer;
    }

    function renderState(next) {
        latestState = next;
        const project = next.project || 'project';
        for (const node of rootEl.querySelectorAll('.os-project-name, .os-project-title')) node.textContent = project;
        const branch = q('.os-branch');
        if (branch) branch.textContent = `local${next.preset ? ` / ${next.preset}` : ''}`;
        const session = next.session;
        q('#os-session-id').textContent = session ? `session ${session.id}` : 'chưa có session';
        q('#os-session-status').textContent = session ? session.state : '';
        q('#os-heading-meta').textContent = session ? `SESSION ${session.id} / SQUAD · PLAN R${session.plan_revision}` : 'CHƯA CÓ SESSION / SQUAD';
        const title = q('#os-heading-title');
        title.replaceChildren(doc.createTextNode(project), el(doc, 'span', '.'));
        const gates = next.gates || [];
        q('#os-description').textContent = gates.length ? `${gates.length} cổng đang chờ bạn duyệt trong terminal (omni squad approve).`
            : `${(next.tasks || []).length} task · ${(next.leases || []).length} đang chạy`;
        renderRoles(doc, ws.elements.roleList, next.roles || [], next.leases || []);
        const recipient = q('#os-recipient');
        const wanted = [...(next.roles || []).map((role) => role.id), 'all'];
        if (recipient && [...recipient.options].map((o) => o.value).join() !== wanted.join()) {
            const current = recipient.value;
            recipient.replaceChildren(...wanted.map((id) => { const o = el(doc, 'option', `@${id}`); o.value = id; return o; }));
            if (wanted.includes(current)) recipient.value = current;
        }
        for (const container of taskViews) renderTasks(doc, container, next);
        renderTimeline();
    }

    // Timeline: feed entries plus the gates waiting now.
    const events = [];
    let timelineTimer = null;
    function renderTimeline() {
        clearTimeout(timelineTimer);
        timelineTimer = setTimeout(() => ws.timeline.update([...events, ...gateEvents(latestState.gates)]), 120);
    }

    let stateTimer = null;
    const refreshState = () => api.state().then(renderState).catch(() => {});
    const source = new win.EventSource('/api/events');
    source.addEventListener('open', () => { livePill?.classList.remove('down'); if (livePill) livePill.lastChild.textContent = ' LIVE'; });
    source.addEventListener('error', () => { livePill?.classList.add('down'); if (livePill) livePill.lastChild.textContent = ' đang kết nối lại…'; });
    source.addEventListener('entry', (message) => {
        try { events.push(timelineEvent(JSON.parse(message.data))); } catch { return; }
        if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
        renderTimeline();
        // Ledger events move tasks and gates: refresh the sidebar once per burst.
        clearTimeout(stateTimer);
        stateTimer = setTimeout(refreshState, 250);
    });

    const limitsView = mountLimitsView({ container: ws.elements.limitsList, limits });
    const limitsTimer = setInterval(() => api.limits().then((list) => limitsView.update(list)).catch(() => {}), 60_000);
    const stateInterval = setInterval(refreshState, 5000);
    if (daemonLine) daemonLine.replaceChildren(el(doc, 'span', null, 'os-dot'), doc.createTextNode(' omni ui · loopback'), el(doc, 'span', 'LOCAL'));

    renderState(state);
    renderPtyBar();
    // A first visit opens the real task list instead of an empty panel.
    const squadPrefs = store.getState().preferences.contexts.squad;
    if (!squadPrefs || !squadPrefs.views?.some((view) => view.kind !== 'terminal' || view.resourceId)) {
        store.dispatch({ type: 'openView', contextId: 'squad', view: { id: 'view-tasks', kind: 'tasks', resourceId: null, title: 'Tasks' } });
    }
    win.addEventListener('resize', () => pty.view?.fit());
    return { ws, store, dispose() { source.close(); clearInterval(limitsTimer); clearInterval(stateInterval); ws.dispose(); } };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById('omni-root')) start();
