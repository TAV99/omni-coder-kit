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
    renderState(await response.json());
    openFeed();
    setInterval(refreshState, 5000);
}

$('source').addEventListener('change', (event) => { filters.source = event.target.value; applyFilters(); });
$('task').addEventListener('input', (event) => { filters.task = event.target.value.trim(); applyFilters(); });
start();
