'use strict';

// `omni squad runtimes` (SPEC-SQUAD-P1 §8): probe agent CLIs on this machine and
// report version, sign-in state and models. Read-only: writes no files.

const chalk = require('chalk');
const { defaultRegistry } = require('../squad/runtimes');

const STATE_LABEL = {
    authenticated: 'đã đăng nhập',
    unauthenticated: 'chưa đăng nhập',
    unknown: 'không rõ',
};

function formatReport(report) {
    const lines = [];
    const status = report.ready ? chalk.green('● sẵn sàng') : chalk.yellow('● chưa sẵn sàng');
    lines.push(`${chalk.bold(report.displayName)} ${chalk.gray(`(${report.id})`)}  ${status}`);
    if (report.detect.found) {
        lines.push(chalk.gray(`   binary:     ${report.detect.path}`));
        if (report.version) lines.push(chalk.gray(`   version:    ${report.version.ok ? report.version.version : '—'}`));
        if (report.auth) {
            const method = report.auth.method ? ` (${report.auth.method})` : '';
            lines.push(chalk.gray(`   đăng nhập:  ${STATE_LABEL[report.auth.state] || report.auth.state}${method}`));
        }
        if (report.models && report.models.ok) {
            const ids = report.models.models.map((m) => m.id);
            const shown = ids.slice(0, 6).join(', ') + (ids.length > 6 ? `, … (+${ids.length - 6})` : '');
            lines.push(chalk.gray(`   model:      ${ids.length ? `${ids.length} · ${shown}` : (report.models.note || '0')}`));
        }
    }
    for (const p of report.problems) {
        lines.push(chalk.red(`   ✗ ${p.message}`) + (p.fix ? chalk.cyan(`  → ${p.fix}`) : ''));
    }
    return lines.join('\n');
}

async function runSquadRuntimes({ registry = defaultRegistry, runtime, timeoutMs, json = false, ctx = {}, write = console.log } = {}) {
    const timeout = timeoutMs === undefined ? undefined : Number(timeoutMs);
    if (timeout !== undefined && (!Number.isInteger(timeout) || timeout <= 0)) {
        write(json ? JSON.stringify({ error: 'invalid --timeout' }) : chalk.red('--timeout phải là số nguyên dương (ms)'));
        return { exitCode: 2, reports: [] };
    }
    const probeCtx = { ...ctx, ...(timeout ? { timeoutMs: timeout } : {}) };
    let reports;
    try {
        reports = runtime ? [await registry.probe(runtime, probeCtx)] : await registry.probeAll(probeCtx);
    } catch (error) {
        if (error && error.code === 'SQUAD_RUNTIME_UNKNOWN') {
            const known = registry.list().map((r) => r.id).join(', ');
            write(json ? JSON.stringify({ error: error.message }) : chalk.red(`${error.message}. Runtime có sẵn: ${known}`));
            return { exitCode: 2, reports: [] };
        }
        throw error;
    }
    if (json) {
        write(JSON.stringify(reports, null, 2));
    } else {
        write(reports.map(formatReport).join('\n\n'));
        const ready = reports.filter((r) => r.ready).length;
        write(chalk.gray(`\n${ready}/${reports.length} runtime sẵn sàng`));
    }
    return { exitCode: reports.some((r) => r.ready) ? 0 : 1, reports };
}

async function handleSquadRuntimes(options = {}) {
    const { exitCode } = await runSquadRuntimes({ runtime: options.runtime, timeoutMs: options.timeout, json: !!options.json });
    process.exitCode = exitCode;
}

// ---------------------------------------------------------------------------
// `omni squad setup` and `omni squad skills` (SPEC-SQUAD-P2 §8)
// ---------------------------------------------------------------------------

function promptAsk() {
    const prompts = require('prompts');
    const onCancel = () => { throw Object.assign(new Error('Hủy bỏ.'), { code: 'SQUAD_SETUP_CANCELLED' }); };
    return {
        async select({ message, choices, initial }) {
            const index = Math.max(0, choices.indexOf(initial));
            const { value } = await prompts({ type: 'select', name: 'value', message, initial: index,
                choices: choices.map((c) => ({ title: c, value: c })) }, { onCancel });
            return value;
        },
        async text({ message }) {
            const { value } = await prompts({ type: 'text', name: 'value', message }, { onCancel });
            return String(value || '').trim();
        },
        async confirm({ message, initial }) {
            const { value } = await prompts({ type: 'confirm', name: 'value', message, initial }, { onCancel });
            return Boolean(value);
        },
    };
}

function printSetup(result, write) {
    const { binding } = result;
    write(chalk.bold('\nVai → CLI → model → effort'));
    const line = (id, s) => write(`   ${id.padEnd(13)} ${s.runtime} · ${s.model}${s.effort ? ` · ${s.effort}` : ''}`);
    line('orchestrator', binding.roles.orchestrator);
    for (const w of binding.roles.worker) line(w.id, w);
    if (binding.roles.reviewer) line('reviewer', binding.roles.reviewer);
    for (const w of result.warnings) write(chalk.yellow(`   ⚠ ${w.message}`));
    if (!result.engine.supported) write(chalk.yellow(`   ⚠ chưa chạy được bằng "omni dual" cho tới P3: ${result.engine.reasons.join('; ')}`));
    if (result.created.length) write(chalk.gray(`   tạo mới: ${result.created.join(', ')}`));
    if (result.gitignore.migrated || result.gitignore.added.length) write(chalk.gray(`   .gitignore: ${[...result.gitignore.added, result.gitignore.migrated ? 'chuyển .omni/ → .omni/* + !.omni/squad/' : null].filter(Boolean).join(', ')}`));
    if (result.gitignore.warning) write(chalk.yellow(`   ⚠ ${result.gitignore.warning}`));
    write(chalk.gray(`   kho skill: +${result.imported.imported.length} mới, ${result.imported.same.length} trùng khớp${result.imported.conflicts.length ? `, ${result.imported.conflicts.length} xung đột (${result.imported.conflicts.join(', ')})` : ''}`));
    if (result.stackFilled.length) write(chalk.gray(`   stack.worker: ${result.stackFilled.join(', ')}`));
    for (const [role, list] of Object.entries(result.bundles)) write(chalk.gray(`   bộ skill ${role}: ${list.length}`));
    for (const o of result.overlaps) write(chalk.red(`   ✗ "${o.skill}" thuộc nhiều vai: ${o.roles.join(', ')}`));
    if (result.displaced.moved.length) write(chalk.gray(`   đã chuyển ${result.displaced.moved.length} skill không thuộc orchestrator sang ${result.displaced.to}`));
    if (result.mount) {
        const m = result.mount;
        write(chalk.gray(`   mount orchestrator: +${m.mounted.length}, cập nhật ${m.updated.length}, nhận ${m.adopted.length}, gỡ ${m.removed.length}, giữ ${m.unchanged.length}`));
        if (m.missing.length) write(chalk.yellow(`   ⚠ thiếu trong kho: ${m.missing.join(', ')}`));
        if (m.unmanaged.length) write(chalk.yellow(`   ⚠ skill không do omni quản lý vẫn nằm trong thư mục mount: ${m.unmanaged.join(', ')}`));
    }
}

async function handleSquadSetup(options = {}) {
    const { runSetup } = require('../squad/setup');
    const write = console.log;
    try {
        const result = await runSetup({
            projectRoot: process.cwd(),
            preset: options.preset || 'dual',
            workers: options.workers ? Number(options.workers) : 1,
            binds: options.bind || [],
            yes: Boolean(options.yes),
            displace: options.keepSkills ? false : undefined,
            ask: options.yes ? null : promptAsk(),
        });
        printSetup(result, write);
        write(chalk.gray('\n   Kiểm tra lại bất cứ lúc nào: omni skills doctor --offline\n'));
        process.exitCode = result.overlaps.length ? 1 : 0;
    } catch (error) {
        write(chalk.red(`\n✗ ${error.message}\n`));
        process.exitCode = error.code === 'SQUAD_SETUP_CANCELLED' ? 130 : 1;
    }
}

function squadContext(projectRoot) {
    const path = require('node:path');
    const { loadRoles } = require('../squad/roles');
    const { loadCatalog, resolveBundles } = require('../squad/skills-catalog');
    const { readBinding } = require('../squad/bindings');
    const { createSkillStore } = require('../squad/skill-store');
    const roles = loadRoles(path.join(projectRoot, '.omni', 'squad', 'roles'));
    const catalog = loadCatalog(path.join(projectRoot, '.omni', 'squad', 'skills.yaml'), roles);
    const binding = readBinding(projectRoot);
    if (!binding) throw new Error('chưa có binding — chạy "omni squad setup" trước');
    const { readPipelineIfAny } = require('../squad/pipeline');
    const pipeline = readPipelineIfAny(projectRoot, roles);
    const { bundles } = resolveBundles({ catalog, roles, reviewerBound: Boolean(binding.roles.reviewer), pipeline });
    const runtime = defaultRegistry.get(binding.roles.orchestrator.runtime);
    return { binding, bundles, runtime, store: createSkillStore(projectRoot) };
}

async function handleSquadSkills(action = 'status') {
    const { inspectMount } = require('../squad/mount');
    const projectRoot = process.cwd();
    try {
        const { bundles, runtime, store } = squadContext(projectRoot);
        if (typeof runtime.skillDirs !== 'function') throw new Error(`${runtime.id} chưa hỗ trợ mount skill`);
        const skillDir = runtime.skillDirs('project')[0];
        if (action === 'sync') {
            // `omni skills add` installs through the skills.sh CLI straight into the
            // project skill dir; pull such new skills into the store before mounting.
            const pulled = store.importFrom(require('node:path').join(projectRoot, skillDir));
            if (pulled.imported.length) console.log(`nhập vào kho: ${pulled.imported.join(', ')}`);
            if (pulled.conflicts.length) console.log(chalk.yellow(`⚠ khác bản trong kho, giữ bản kho: ${pulled.conflicts.join(', ')}`));
            const m = runtime.mountSkills({ store, root: projectRoot, skills: bundles.orchestrator, roleId: 'orchestrator' });
            console.log(`mount orchestrator (${skillDir}): +${m.mounted.length}, cập nhật ${m.updated.length}, nhận ${m.adopted.length}, gỡ ${m.removed.length}, giữ ${m.unchanged.length}`);
            if (m.missing.length) console.log(chalk.yellow(`⚠ thiếu trong kho: ${m.missing.join(', ')}`));
            if (m.unmanaged.length) console.log(chalk.yellow(`⚠ skill không do omni quản lý: ${m.unmanaged.join(', ')}`));
            return;
        }
        if (action !== 'status') throw new Error(`hành động không hỗ trợ: ${action} (status | sync)`);
        for (const [role, list] of Object.entries(bundles)) console.log(`${role.padEnd(13)} ${list.length} skill`);
        const r = inspectMount({ store, root: projectRoot, skillDir, skills: bundles.orchestrator, roleId: 'orchestrator' });
        console.log(`\n${skillDir} (orchestrator): khớp ${r.ok.length}, lệch ${r.drift.length}, chưa mount ${r.absent.length}, thừa ${r.extra.length}, không quản lý ${r.unmanaged.length}, thiếu trong kho ${r.missing.length}`);
        console.log(chalk.gray('Worker được mount bộ skill riêng mỗi lần chạy task.'));
    } catch (error) {
        console.log(chalk.red(`✗ ${error.message}`));
        process.exitCode = 1;
    }
}

// `omni squad pipeline` (SPEC-SQUAD-P3 §2.4): the pipeline in use and whether the engine can run it.
function handleSquadPipeline() {
    const path = require('node:path');
    const { loadRoles } = require('../squad/roles');
    const { readPipelineIfAny, assertEngineSupports } = require('../squad/pipeline');
    try {
        const roles = loadRoles(path.join(process.cwd(), '.omni', 'squad', 'roles'));
        const pipeline = readPipelineIfAny(process.cwd(), roles);
        if (!pipeline) throw new Error('chưa có .omni/squad/pipeline.yaml — chạy "omni squad setup" (thêm --keep-skills nếu không muốn chuyển skill)');
        console.log(chalk.bold(`Pipeline ${pipeline.preset}`));
        for (const phase of pipeline.phases) {
            const gate = phase.gate === 'human-always' ? chalk.yellow('luôn chờ bạn duyệt')
                : phase.gate === 'human' ? chalk.yellow(`chờ bạn duyệt${phase.auto_ok ? ' (AUTO được bỏ qua)' : ''}`) : '';
            const fix = phase.on_needs_fix ? chalk.gray(` · NEEDS_FIX → ${phase.on_needs_fix} (tối đa ${phase.max_corrections ?? 3})`) : '';
            console.log(`   ${phase.id.padEnd(10)} ${phase.role.padEnd(13)} ${gate}${fix}`);
        }
        const engine = assertEngineSupports(pipeline);
        if (engine.supported) console.log(chalk.green('\n✓ engine hiện tại chạy được pipeline này'));
        else {
            console.log(chalk.yellow('\n⚠ engine hiện tại chưa chạy được pipeline này:'));
            for (const problem of engine.problems) console.log(chalk.yellow(`   - ${problem}`));
            process.exitCode = 1;
        }
    } catch (error) {
        console.log(chalk.red(`✗ ${error.message}`));
        process.exitCode = 1;
    }
}

// -- approval gates (SPEC-SQUAD-P3 §5.3) ---------------------------------------
// Only a person approves: these commands refuse to run without a terminal and
// ask for a short code printed on screen. Agents run shell commands without a
// TTY (V16) and the Codex hook blocks these command lines (V15).

class SquadGateCliError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

const realRoot = () => require('node:fs').realpathSync.native(process.cwd());

function assertTerminal(isTTY) {
    if (!isTTY) {
        throw new SquadGateCliError('SQUAD_GATE_TTY_REQUIRED',
            'Lệnh này cần người dùng gõ trên terminal (không chạy được từ agent hay pipe)');
    }
}

// Ledger access: through the daemon when it runs (it is the single writer),
// otherwise straight from the authority store on disk.
async function gateBackend(root) {
    const { createDaemonClient } = require('../dual/daemon-client');
    const client = createDaemonClient({ workspaceRoot: root, timeoutMs: 15_000 });
    try {
        const health = await client.health();
        if (health && health.status === 'healthy' && health.session_id) {
            return {
                approvals: async () => (await client.status(health.session_id)).approvals || {},
                decide: (decision) => client.request('gate.decide', { session_id: health.session_id, ...decision }),
            };
        }
    } catch (error) {
        // Only a missing or dead daemon hands writing back to us; a slow one may still be writing.
        if (!['DUAL_DISCOVERY_MISSING', 'DUAL_CLIENT_CONNECTION_REFUSED'].includes(error.code)) throw error;
    }
    const path = require('node:path');
    const authorityDir = path.join(root, '.omni', 'runs', 'dual-authority');
    if (!require('node:fs').existsSync(path.join(authorityDir, 'events.ndjson'))) {
        throw new SquadGateCliError('SQUAD_GATE_NO_SESSION', 'Chưa có phiên dual nào trong project này');
    }
    const store = require('../dual/authority-store').createAuthorityStore(authorityDir);
    const { decideGate } = require('../dual/approval-gates');
    return {
        approvals: async () => store.derive().approvals || {},
        decide: async ({ gate_id: gateId, approve, reason, code }) => ({ gate: decideGate(store, { gateId, approve, reason, code }) }),
    };
}

async function runSquadApprove({ root, gateId, reject = false, reason, isTTY, ask, backend, log = console.log }) {
    assertTerminal(isTTY);
    const { confirmationCode } = require('../dual/approval-gates');
    const gates = backend || await gateBackend(root);
    const pending = Object.values(await gates.approvals()).filter((gate) => gate.status === 'pending');
    if (!gateId) {
        if (!pending.length) log(chalk.green('Không có cổng nào đang chờ duyệt.'));
        for (const gate of pending) {
            log(`${chalk.bold(gate.gate_id)}  ${chalk.gray(`[${gate.phase}]`)}  ${gate.summary}`);
            log(chalk.gray(`   digest ${gate.digest.slice(0, 16)}…  → omni squad approve ${gate.gate_id}`));
        }
        return { listed: pending };
    }
    const gate = pending.find((candidate) => candidate.gate_id === gateId);
    if (!gate) throw new SquadGateCliError('SQUAD_GATE_NOT_PENDING', `Cổng ${gateId} không đang chờ duyệt`);
    const code = confirmationCode(gate);
    log(`${chalk.bold(reject ? 'Từ chối' : 'Duyệt')} ${gate.gate_id} ${chalk.gray(`[${gate.phase}]`)}`);
    log(`   ${gate.summary}`);
    log(chalk.gray(`   digest ${gate.digest}`));
    const typed = await ask(`Gõ mã ${chalk.bold(code)} để xác nhận:`);
    if (String(typed || '').trim() !== code) throw new SquadGateCliError('SQUAD_GATE_CODE_MISMATCH', 'Mã xác nhận không khớp, không ghi gì');
    const result = await gates.decide({ gate_id: gate.gate_id, approve: !reject, reason, code });
    log(reject ? chalk.yellow(`✓ Đã từ chối ${gate.gate_id}`) : chalk.green(`✓ Đã duyệt ${gate.gate_id}`));
    return result;
}

async function promptText(message) {
    const prompts = require('prompts');
    const { value } = await prompts({ type: 'text', name: 'value', message });
    return value;
}

async function handleSquadApprove(gateId, options = {}) {
    try {
        await runSquadApprove({ root: realRoot(), gateId, reject: options.reject === true, reason: options.reason,
            isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY), ask: promptText });
    } catch (error) {
        console.log(chalk.red(`✗ ${error.code ? `${error.code}: ` : ''}${error.message}`));
        process.exitCode = 1;
    }
}

// AUTO (D8) lets auto_ok gates pass by themselves; integrate never does.
function runSquadAuto({ root, value, isTTY, log = console.log }) {
    const { readBinding, writeBinding } = require('../squad/bindings');
    const binding = readBinding(root);
    if (!binding) throw new SquadGateCliError('SQUAD_BINDING_MISSING', 'Chưa có .omni/squad.local.json — chạy omni squad setup');
    if (value === undefined) {
        log(`AUTO: ${binding.auto === true ? 'bật' : 'tắt'}  ${chalk.gray('(chỉ bỏ cổng có auto_ok; cổng integrate luôn chờ người)')}`);
        return binding.auto === true;
    }
    if (!['on', 'off'].includes(value)) throw new SquadGateCliError('SQUAD_AUTO_INVALID', 'Dùng: omni squad auto [on|off]');
    assertTerminal(isTTY);
    writeBinding(root, { ...binding, auto: value === 'on', updated_at: new Date().toISOString() });
    log(chalk.green(`✓ AUTO ${value === 'on' ? 'bật' : 'tắt'}`));
    return value === 'on';
}

function handleSquadAuto(value) {
    try {
        runSquadAuto({ root: realRoot(), value, isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
    } catch (error) {
        console.log(chalk.red(`✗ ${error.code ? `${error.code}: ` : ''}${error.message}`));
        process.exitCode = 1;
    }
}

module.exports = { handleSquadRuntimes, runSquadRuntimes, handleSquadSetup, handleSquadSkills, handleSquadPipeline,
    handleSquadApprove, runSquadApprove, handleSquadAuto, runSquadAuto, SquadGateCliError };
