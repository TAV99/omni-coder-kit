// First-run squad setup page (SPEC-SQUAD-P8 §5.2). Shown while the server is in
// setup mode: choose a preset, then a CLI, model and effort for each role from
// what `omni squad runtimes` found on this machine, check, and save. Saving runs
// `omni squad setup` on the server; it decides no gate. Server data is shown
// with textContent only.

import { resolveTheme } from './theme.mjs';

export function slotIdsFor(preset, workers, presets) {
    const limits = presets?.[preset]?.workers || [1, 1];
    const count = Math.min(Math.max(Number(workers) || limits[0], limits[0]), limits[1]);
    return ['orchestrator', ...Array.from({ length: count }, (_, i) => `worker-${i + 1}`),
        ...(presets?.[preset]?.reviewer ? ['reviewer'] : [])];
}

// Why a CLI cannot be picked yet, or null when it is ready.
export function runtimeProblem(report) {
    if (!report) return 'không có trên máy';
    if (report.ready) return null;
    if (report.detect && report.detect.found === false) return 'chưa cài';
    if (report.auth && report.auth.state && report.auth.state !== 'authenticated') return 'chưa đăng nhập';
    return 'chưa sẵn sàng';
}

export function modelsOf(runtimes, runtimeId) {
    const report = (runtimes || []).find((r) => r.id === runtimeId);
    return report?.models?.ok ? (report.models.models || []) : [];
}

// Last-used slot for this preset (readUserDefaults shape), else the first ready CLI.
export function defaultSlot(id, { preset, defaults, runtimes }) {
    const last = defaults?.[preset];
    const previous = id.startsWith('worker-') ? (last?.worker || []).find((w) => w.id === id) : last?.[id];
    const ready = (runtimes || []).filter((r) => r.ready);
    const usable = previous && ready.some((r) => r.id === previous.runtime) ? previous : null;
    const runtime = usable ? usable.runtime : (ready[0]?.id || '');
    const models = modelsOf(runtimes, runtime);
    const model = usable && (models.length === 0 || models.some((m) => m.id === usable.model)) ? usable.model : (models[0]?.id || '');
    const efforts = models.find((m) => m.id === model)?.efforts || [];
    const effort = usable?.model === model && usable.effort && efforts.includes(usable.effort) ? usable.effort
        : (models.find((m) => m.id === model)?.defaultEffort || efforts[0] || '');
    return { runtime, model, effort };
}

export function applyBody(form, requestId) {
    const binds = {};
    for (const id of slotIdsFor(form.preset, form.workers, form.presets)) {
        const slot = form.slots[id] || {};
        binds[id] = { runtime: slot.runtime, model: slot.model, ...(slot.effort ? { effort: slot.effort } : {}) };
    }
    return { request_id: requestId, preset: form.preset, workers: Number(form.workers) || 1, binds, displace: form.displace !== false };
}

function el(doc, tag, text, className) {
    const node = doc.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
}

function option(doc, value, label, { selected = false, disabled = false } = {}) {
    const node = el(doc, 'option', label);
    node.value = value;
    node.selected = selected;
    node.disabled = disabled;
    return node;
}

export function mountSetup({ doc, root, api, project = '', uuid = () => crypto.randomUUID(), reload = () => location.reload(),
    systemDark = () => Boolean(doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)').matches) }) {
    // The workspace theme manager is not mounted here: follow the system light/dark setting.
    doc.documentElement.dataset.theme = resolveTheme('system', systemDark());
    const form = { preset: 'squad', workers: 1, presets: {}, slots: {}, displace: true };
    let catalog = { runtimes: [], defaults: {}, presets: {} };
    let busy = false;

    const page = el(doc, 'main', null, 'os-setup');
    const head = el(doc, 'header', null, 'os-setup-head');
    head.append(el(doc, 'h1', 'Thiết lập squad'), el(doc, 'p', `Dự án ${project}: chọn CLI, model và effort cho từng vai. Lưu xong, orchestrator sẽ khởi động ngay trong trang.`));
    const presetBox = el(doc, 'section', null, 'os-setup-preset');
    const rolesBox = el(doc, 'section', null, 'os-setup-roles');
    const report = el(doc, 'section', null, 'os-setup-report');
    report.setAttribute('aria-live', 'polite');
    const actions = el(doc, 'footer', null, 'os-setup-actions');
    page.append(head, presetBox, rolesBox, actions, report);
    root.replaceChildren(page);

    const showReport = (lines, kind = 'info') => {
        report.className = `os-setup-report ${kind}`;
        report.replaceChildren(...lines.map((line) => el(doc, 'p', line, line.startsWith('⚠') ? 'warn' : undefined)));
    };

    function renderPreset() {
        const presetSelect = el(doc, 'select');
        presetSelect.setAttribute('aria-label', 'Preset');
        presetSelect.append(option(doc, 'squad', 'Squad — orchestrator, worker, reviewer', { selected: form.preset === 'squad' }),
            option(doc, 'dual', 'Dual — orchestrator + 1 worker', { selected: form.preset === 'dual' }));
        presetSelect.addEventListener('change', () => { form.preset = presetSelect.value; form.workers = 1; resetSlots(); render(); });
        const label = el(doc, 'label', 'Preset ');
        label.append(presetSelect);
        presetBox.replaceChildren(label);
        const [min, max] = form.presets[form.preset]?.workers || [1, 1];
        if (max > min) {
            const workers = el(doc, 'select');
            workers.setAttribute('aria-label', 'Số worker');
            for (let n = min; n <= max; n += 1) workers.append(option(doc, String(n), String(n), { selected: Number(form.workers) === n }));
            workers.addEventListener('change', () => { form.workers = Number(workers.value); resetSlots(); render(); });
            const wl = el(doc, 'label', 'Số worker ');
            wl.append(workers);
            presetBox.append(wl);
        }
    }

    function resetSlots() {
        for (const id of slotIdsFor(form.preset, form.workers, form.presets)) {
            if (!form.slots[id]) form.slots[id] = defaultSlot(id, { preset: form.preset, defaults: catalog.defaults, runtimes: catalog.runtimes });
        }
    }

    function renderRoles() {
        if (!catalog.runtimes.length) {
            rolesBox.replaceChildren(el(doc, 'p', busy ? 'Đang dò các CLI trên máy…' : 'Chưa dò được CLI nào.', 'os-setup-hint'));
            return;
        }
        const rows = slotIdsFor(form.preset, form.workers, form.presets).map((id) => {
            const slot = form.slots[id] || { runtime: '', model: '', effort: '' };
            const row = el(doc, 'div', null, 'os-setup-row');
            row.append(el(doc, 'span', id, 'os-setup-role'));
            const cli = el(doc, 'select');
            cli.setAttribute('aria-label', `${id} CLI`);
            for (const r of catalog.runtimes) {
                const problem = runtimeProblem(r);
                cli.append(option(doc, r.id, problem ? `${r.id} (${problem})` : `${r.id} ${r.version?.version || ''}`.trim(),
                    { selected: slot.runtime === r.id, disabled: Boolean(problem) }));
            }
            cli.addEventListener('change', () => {
                const models = modelsOf(catalog.runtimes, cli.value);
                form.slots[id] = { runtime: cli.value, model: models[0]?.id || '', effort: models[0]?.defaultEffort || models[0]?.efforts?.[0] || '' };
                render();
            });
            const models = modelsOf(catalog.runtimes, slot.runtime);
            let modelInput;
            if (models.length) {
                modelInput = el(doc, 'select');
                for (const m of models) modelInput.append(option(doc, m.id, m.id, { selected: slot.model === m.id }));
                modelInput.addEventListener('change', () => {
                    const picked = models.find((m) => m.id === modelInput.value);
                    form.slots[id] = { ...form.slots[id], model: modelInput.value, effort: picked?.defaultEffort || picked?.efforts?.[0] || '' };
                    render();
                });
            } else {
                modelInput = el(doc, 'input');
                modelInput.type = 'text';
                modelInput.value = slot.model || '';
                modelInput.placeholder = 'model';
                modelInput.addEventListener('input', () => { form.slots[id] = { ...form.slots[id], model: modelInput.value.trim() }; });
            }
            modelInput.setAttribute('aria-label', `${id} model`);
            const efforts = models.find((m) => m.id === slot.model)?.efforts || [];
            const effort = el(doc, 'select');
            effort.setAttribute('aria-label', `${id} effort`);
            effort.disabled = efforts.length === 0;
            if (efforts.length === 0) effort.append(option(doc, '', '—'));
            for (const e of efforts) effort.append(option(doc, e, e, { selected: slot.effort === e }));
            effort.addEventListener('change', () => { form.slots[id] = { ...form.slots[id], effort: effort.value }; });
            row.append(cli, modelInput, effort);
            return row;
        });
        const notReady = catalog.runtimes.filter((r) => runtimeProblem(r));
        rolesBox.replaceChildren(...rows);
        if (notReady.length) {
            rolesBox.append(el(doc, 'p', `CLI chưa dùng được: ${notReady.map((r) => `${r.id} (${runtimeProblem(r)})`).join(', ')}. Chạy "omni squad runtimes" trong terminal để xem cách sửa, rồi bấm Dò lại.`, 'os-setup-hint'));
        }
    }

    function renderActions() {
        const refresh = el(doc, 'button', 'Dò lại CLI');
        refresh.type = 'button';
        refresh.addEventListener('click', () => load(true));
        const check = el(doc, 'button', 'Kiểm tra');
        check.type = 'button';
        check.addEventListener('click', () => preflight());
        const displace = el(doc, 'input');
        displace.type = 'checkbox';
        displace.checked = form.displace;
        displace.addEventListener('change', () => { form.displace = displace.checked; });
        const dl = el(doc, 'label', null, 'os-setup-displace');
        dl.append(displace, doc.createTextNode(' Chuyển skill không thuộc orchestrator vào .omni/skills/.displaced (không xoá)'));
        const save = el(doc, 'button', 'Lưu', 'os-setup-save');
        save.type = 'button';
        save.addEventListener('click', () => apply());
        for (const button of [refresh, check, save]) button.disabled = busy;
        actions.replaceChildren(refresh, check, dl, save);
    }

    function render() { renderPreset(); renderRoles(); renderActions(); }

    const lines = (result) => [
        ...(result.errors || []).map((e) => `✗ ${e.message}`),
        ...(result.warnings || []).map((w) => `⚠ ${w.message}`),
        ...(result.trust && result.trust.status === 'untrusted' ? [`⚠ Orchestrator chưa tin cậy thư mục này: lần đầu nó sẽ hỏi trust, chọn "Yes"${result.trust.fix ? ` (hoặc ${result.trust.fix})` : ''}.`] : []),
    ];

    async function load(refresh = false) {
        busy = true; renderActions(); renderRoles();
        try {
            catalog = await api.setupRuntimes(refresh);
            form.presets = catalog.presets || {};
            form.slots = {};
            resetSlots();
            render();
            if (!catalog.runtimes.some((r) => r.ready)) showReport(['Chưa có CLI nào sẵn sàng. Cài và đăng nhập claude, codex hoặc agy, rồi bấm Dò lại.'], 'error');
            else showReport([]);
        } catch (err) {
            showReport([`Không dò được CLI: ${err.message}`], 'error');
        } finally { busy = false; renderActions(); }
    }

    async function preflight() {
        busy = true; renderActions();
        try {
            const body = applyBody(form, 'preflight');
            delete body.request_id;
            const result = await api.setupPreflight(body);
            showReport(result.ok ? ['✓ Cấu hình hợp lệ.', ...lines(result)] : lines(result), result.ok ? 'ok' : 'error');
            return result;
        } catch (err) {
            showReport([`✗ ${err.message}`], 'error');
            return null;
        } finally { busy = false; renderActions(); }
    }

    async function apply() {
        const checked = await preflight();
        if (!checked || !checked.ok) return;
        busy = true; renderActions();
        try {
            const result = await api.setupApply(applyBody(form, uuid()));
            const done = el(doc, 'section', null, 'os-setup-done');
            done.append(el(doc, 'h2', 'Đã thiết lập squad'),
                el(doc, 'p', 'Commit các file vừa tạo (AGENTS.md, CLAUDE.md, .codex/, .claude/, .gitignore, .mcp.json, .omni/squad/) trước khi giao việc đầu tiên: bước dò của worker từ chối file chưa commit. omni không tự commit.'),
                ...((result.warnings || []).map((w) => el(doc, 'p', `⚠ ${w.message}`))));
            const open = el(doc, 'button', 'Mở workspace', 'os-setup-save');
            open.type = 'button';
            open.addEventListener('click', () => reload());
            done.append(open);
            page.replaceChildren(head, done);
        } catch (err) {
            showReport([`✗ Lưu thất bại: ${err.message}`], 'error');
        } finally { busy = false; }
    }

    render();
    load(false);
    return { form: () => form, load, preflight, apply };
}
