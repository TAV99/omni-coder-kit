'use strict';

// omni ui page (P6a, read-only). Everything from the server is shown with
// textContent: agent output is data, never markup (SPEC-SQUAD-P6 §2.2).

const $ = (id) => document.getElementById(id);
const MAX_FEED = 2000;
const filters = { source: '', task: '' };

function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
}

function fill(list, items, render, empty) {
    list.replaceChildren(...(items.length ? items.map(render) : [el('li', empty, 'muted')]));
}

function stateClass(state) {
    if (/VERIFIED|DONE|APPROVED|COMPLETED/.test(state)) return 'ok';
    if (/FAIL|BLOCK|REJECT|EXHAUST|LOST/.test(state)) return 'bad';
    return 'warn';
}

function renderState(state) {
    $('project').textContent = `omni squad · ${state.project}${state.preset ? ` (${state.preset})` : ''}`;
    $('session').textContent = state.session ? `session ${state.session.id} · ${state.session.state} · plan r${state.session.plan_revision}` : 'no session yet';
    fill($('roles'), state.roles, (role) => {
        const li = el('li');
        li.append(el('strong', role.id), el('span', [role.runtime, role.model, role.effort].filter(Boolean).join(' · '), 'sub'));
        return li;
    }, 'no binding — run omni squad setup');
    fill($('pipeline'), state.pipeline || [], (phase) => el('li', `${phase.id} → ${phase.role}${phase.gate ? ` (gate: ${phase.gate})` : ''}`), 'no pipeline');
    fill($('gates'), state.gates, (gate) => {
        const li = el('li', null, 'gate');
        li.append(el('strong', `${gate.phase}${gate.task_id ? ` · ${gate.task_id}` : ''}`), el('span', gate.summary, 'sub'), el('code', gate.command));
        return li;
    }, 'nothing waiting');
    fill($('tasks'), state.tasks, (task) => {
        const li = el('li');
        li.append(el('strong', task.task_id), el('span', task.state, `state ${stateClass(task.state)}`));
        const parts = [task.title, task.worker || task.owner_role, `attempt ${task.attempt}`];
        if (task.qc_review) parts.push(`review: ${task.qc_review.verdict || task.qc_review.status}`);
        if (task.last_outcome) parts.push(`last: ${task.last_outcome.status}${task.last_outcome.code ? ` ${task.last_outcome.code}` : ''}`);
        li.append(el('span', parts.filter(Boolean).join(' · '), 'sub'));
        return li;
    }, 'no tasks');
    fill($('leases'), state.leases, (lease) => el('li', `${lease.task_id} · ${lease.owner_role || '?'} · until ${lease.expires_at}`), 'idle');
    fill($('messages'), state.messages || [], (message) => {
        const li = el('li');
        li.append(el('strong', `@${message.to}`), el('span', message.body, 'sub'));
        const done = message.delivered.map((d) => `${d.role} read it (${d.via})`);
        const waiting = message.waiting.length ? [`waiting for ${message.waiting.join(', ')}'s next turn`] : [];
        li.append(el('span', [...done, ...waiting].join(' · '), 'sub'));
        return li;
    }, 'none yet');
    renderRecipients(state.roles);
    $('errors').replaceChildren(...state.errors.map((text) => el('li', text)));
}

function entryClass(entry) {
    if (entry.source !== 'ledger') return 'discussion';
    if (/failed|rejected|blocked|lost/.test(entry.type)) return 'ledger bad';
    if (/verified|approved|completed|integrated/.test(entry.type)) return 'ledger ok';
    return 'ledger';
}

function visible(entry) {
    if (filters.source && entry.source !== filters.source) return false;
    if (filters.task && !String(entry.fields.task_id || entry.journal || '').includes(filters.task)) return false;
    return true;
}

function renderEntry(entry) {
    const li = el('li', null, entryClass(entry));
    li.dataset.source = entry.source;
    li.dataset.task = entry.fields.task_id || entry.journal || '';
    const time = entry.at ? new Date(entry.at).toLocaleTimeString([], { hour12: false }) : '';
    const { body, ...rest } = entry.fields;
    const summary = Object.entries(rest).map(([key, value]) => `${key}=${value}`).join('  ');
    li.append(el('span', time, 'muted mono'), el('span', entry.source, 'muted'), el('span', null, 'line'));
    const line = li.lastChild;
    line.append(el('span', entry.type, 'type'), el('span', summary ? `  ${summary}` : '', 'fields'));
    if (body) li.append(el('span', body, 'body'));
    li.hidden = !visible(entry);
    return li;
}

function applyFilters() {
    for (const li of $('feed').children) {
        li.hidden = (filters.source && li.dataset.source !== filters.source) || (filters.task && !li.dataset.task.includes(filters.task));
    }
}

async function refreshState() {
    const response = await fetch('/api/state', { credentials: 'same-origin' });
    if (response.ok) renderState(await response.json());
}

function openFeed() {
    const source = new EventSource('/api/events');
    source.addEventListener('open', () => { $('link').textContent = 'live'; $('link').className = 'pill live'; });
    source.addEventListener('error', () => { $('link').textContent = 'reconnecting…'; $('link').className = 'pill down'; });
    let pending = null;
    source.addEventListener('entry', (message) => {
        const feed = $('feed');
        feed.append(renderEntry(JSON.parse(message.data)));
        while (feed.children.length > MAX_FEED) feed.firstChild.remove();
        if (window.scrollY + window.innerHeight >= document.body.scrollHeight - 80) window.scrollTo(0, document.body.scrollHeight);
        // Ledger events move tasks and gates: refresh the sidebar once per burst.
        clearTimeout(pending);
        pending = setTimeout(refreshState, 250);
    });
}

// Orchestrator terminal (P6b). Keys go out in order through one queue; Enter
// is always its own write, because a CLI reads text + Enter in one burst as a
// paste and inserts a new line instead of submitting (V40).
const pty = { client: null, writer: false, term: null, fit: null, queue: Promise.resolve(), pending: '', timer: null, lastState: null };

function ptyPost(action, body) {
    const send = () => fetch(`/api/pty/${action}`, { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    pty.queue = pty.queue.then(send, send);
    return pty.queue;
}

function flushKeys() {
    clearTimeout(pty.timer);
    if (pty.pending) { ptyPost('input', { client_id: pty.client, data: pty.pending }); pty.pending = ''; }
}

function typeKeys(data) {
    if (!pty.writer || !pty.client) return;
    for (const part of data.split(/(\r)/)) {
        if (!part) continue;
        if (part === '\r') { flushKeys(); ptyPost('input', { client_id: pty.client, data: '\r' }); continue; }
        pty.pending += part;
    }
    clearTimeout(pty.timer);
    pty.timer = setTimeout(flushKeys, 16);
}

function sendSize() {
    if (!pty.term || !pty.fit) return;
    pty.fit.fit();
    if (pty.writer && pty.client) ptyPost('resize', { client_id: pty.client, cols: pty.term.cols, rows: pty.term.rows });
}

function showTermHelp(reason, state) {
    $('term').hidden = true;
    $('term-help').hidden = false;
    $('term-help-reason').textContent = reason;
    const orchestrator = (state.roles || []).find((role) => role.id === 'orchestrator');
    $('term-help-command').textContent = orchestrator ? `${orchestrator.runtime} --model ${orchestrator.model}` : 'omni squad setup';
}

function renderPty(status) {
    pty.lastState = status;
    pty.writer = status.writer === pty.client;
    const parts = [];
    if (status.status === 'running') parts.push(`${status.runtime} · ${status.model} · running`);
    else if (status.status === 'exited') parts.push(`orchestrator exited (code ${status.exit_code})`);
    else if (status.status === 'failed') parts.push(`could not start: ${status.error}`);
    else parts.push('not started');
    if (status.clients > 1) parts.push(pty.writer ? 'you are typing' : 'another tab is typing');
    $('pty-status').textContent = parts.join(' · ');
    const stopped = status.status !== 'running';
    $('pty-start').hidden = !stopped;
    $('pty-start').textContent = status.status === 'idle' ? 'Start' : 'Start again';
    $('pty-resume').hidden = !stopped || !status.resumable;
    $('pty-claim').hidden = pty.writer || !pty.client;
    $('term').classList.toggle('readonly', !pty.writer);
}

function openTerminal(state) {
    if (!state.pty || !state.pty.available) return showTermHelp(`Terminal unavailable: ${state.pty ? state.pty.reason : 'unknown'}.`, state);
    if (typeof window.Terminal !== 'function' || !window.FitAddon) return showTermHelp('Terminal unavailable: xterm.js is not installed.', state);
    pty.term = new window.Terminal({ cursorBlink: true, scrollback: 5000, fontSize: 13 });
    pty.fit = new window.FitAddon.FitAddon();
    pty.term.loadAddon(pty.fit);
    pty.term.open($('term'));
    pty.fit.fit();
    pty.term.onData(typeKeys);
    window.addEventListener('resize', () => { clearTimeout(pty.resizeTimer); pty.resizeTimer = setTimeout(sendSize, 100); });
    const source = new EventSource('/api/pty/stream');
    source.addEventListener('hello', (message) => {
        const hello = JSON.parse(message.data);
        pty.client = hello.client_id;
        if (hello.reset) pty.term.reset();
    });
    source.addEventListener('state', (message) => {
        const wasWriter = pty.writer;
        renderPty(JSON.parse(message.data));
        if (pty.writer && !wasWriter) sendSize();
    });
    source.addEventListener('message', (message) => pty.term.write(JSON.parse(message.data)));
    $('pty-start').addEventListener('click', () => { sendSize(); ptyPost('start', { resume: false }); });
    $('pty-resume').addEventListener('click', () => { sendSize(); ptyPost('start', { resume: true }); });
    $('pty-claim').addEventListener('click', () => ptyPost('claim', { client_id: pty.client }));
}

// Composer (SPEC-SQUAD-P6 §4): one message to one role or to all; the role
// reads it on its next turn. A retry reuses the message id, so it is not doubled.
let draftId = null;

function renderRecipients(roles) {
    const select = $('msg-to');
    const wanted = [...roles.map((role) => role.id), 'all'];
    if ([...select.options].map((option) => option.value).join() === wanted.join()) return;
    const current = select.value;
    select.replaceChildren(...wanted.map((id) => { const option = el('option', `@${id}`); option.value = id; return option; }));
    if (wanted.includes(current)) select.value = current;
}

async function sendMessage(event) {
    event.preventDefault();
    const body = $('msg-body').value;
    if (!body.trim()) return;
    draftId = draftId || crypto.randomUUID();
    $('msg-send').disabled = true;
    $('msg-status').textContent = 'sending…';
    try {
        const response = await fetch('/api/message', { method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message_id: draftId, to: $('msg-to').value, body }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        $('msg-status').textContent = `sent to @${result.to} — read on its next turn`;
        $('msg-body').value = '';
        draftId = null;
        refreshState();
    } catch (error) {
        $('msg-status').textContent = `not sent: ${error.message}`;
    } finally {
        $('msg-send').disabled = false;
    }
}

$('composer').addEventListener('submit', sendMessage);
$('msg-body').addEventListener('input', () => { draftId = null; });
$('msg-body').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) $('composer').requestSubmit();
});

async function start() {
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    if (token) {
        // Trade the fragment token for an HttpOnly cookie, then drop it from the address bar.
        await fetch('/api/login', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, credentials: 'same-origin' });
        history.replaceState(null, '', location.pathname);
    }
    const response = await fetch('/api/state', { credentials: 'same-origin' });
    if (!response.ok) {
        $('link').textContent = 'not signed in — open the URL omni ui printed';
        $('link').className = 'pill down';
        return;
    }
    const state = await response.json();
    renderState(state);
    openTerminal(state);
    openFeed();
    setInterval(refreshState, 5000);
}

$('source').addEventListener('change', (event) => { filters.source = event.target.value; applyFilters(); });
$('task').addEventListener('input', (event) => { filters.task = event.target.value.trim(); applyFilters(); });
start();
