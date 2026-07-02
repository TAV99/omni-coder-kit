'use strict';

const chalk = require('chalk');
const { spawnSync } = require('child_process');

const { planRun, runHarness } = require('../harness/loop');
const { loadState, isValidState, STATES } = require('../harness/state');
const { lastStateFromEvents, readEvents, readEventsFrom, eventsByteLength, summarizeEvents } = require('../harness/events');
const { runPipeline } = require('../harness/gates/pipeline');
const {
    formatStepStart, formatStepEnd, formatTick, formatTimeout, TIMEOUT_HINTS, formatDuration,
} = require('../harness/observability');
const { parseTodo, nextTask } = require('../harness/tasks');
const { createSpinner } = require('../cli/spinner');
const { findConfigFile, loadManifest } = require('./helpers');

// ---------------------------------------------------------------------------
// Pure-ish event renderer (SPEC-OBSERVABILITY-HEARTBEAT). Maps one harness
// event → coloured terminal lines. chalk@4 emits plain text when stdout is not
// a TTY, so this stays assertable in tests. Returns string[] (0+ lines).
// ---------------------------------------------------------------------------
function renderRunEvent(e) {
    const out = [];
    switch (e.type) {
        case 'step-start':
            out.push(chalk.cyan('   ' + formatStepStart({ state: e.state, ide: e.ide, model: e.model, taskIdx: e.taskIdx, total: e.total, desc: e.desc })));
            break;
        case 'heartbeat':
            out.push(chalk.gray('   ' + formatTick(e.sec)));
            break;
        case 'step-end':
            if (e.timedOut) {
                out.push(chalk.red('   ' + formatTimeout({ state: e.state, timeoutMs: e.timeoutMs })));
                TIMEOUT_HINTS.forEach((h) => out.push(chalk.yellow('     ↳ ' + h)));
            } else if (e.exitCode === 0) {
                out.push(chalk.green('   ' + formatStepEnd({ state: e.state, sec: e.sec, exitCode: 0, files: e.files })));
            } else {
                out.push(chalk.red('   ' + formatStepEnd({ state: e.state, sec: e.sec, exitCode: e.exitCode })));
                if (e.stderrTail) {
                    out.push(chalk.red('     stderr:'));
                    String(e.stderrTail).split('\n').forEach((l) => out.push(chalk.gray('     ' + l)));
                }
            }
            break;
        case 'transition':
            out.push(chalk.cyan(`   → ${e.from} → ${e.to}`) + (e.reason ? chalk.gray(`  (${e.reason})`) : ''));
            break;
        case 'gate':
            out.push(e.passed ? chalk.green('   ✓ gate PASS') : chalk.red(`   ✗ gate FAIL ${(e.failures || []).join(',')}`));
            break;
        case 'provider':
            break; // superseded by step-start/step-end — stay quiet (no double line)
        case 'debate': {
            const consensus = String(e.consensus || 'unknown').toUpperCase();
            const round = typeof e.round === 'number' ? e.round + 1 : 1;
            const cIcon = consensus === 'AGREE' ? '✅' : (consensus === 'SPLIT' ? '⚔️' : '🔍');
            const W = 54;
            const hr = '─'.repeat(W);

            out.push(chalk.magenta(`   ┌${hr}┐`));
            const title = ` ${cIcon}  Debate Vòng ${round}`;
            const pad = W - title.length - consensus.length - 1;
            out.push(chalk.magenta(`   │${title}${' '.repeat(Math.max(1, pad))}${consensus} │`));
            out.push(chalk.magenta(`   ├${hr}┤`));

            for (const p of e.participants || []) {
                const color = p.verdict === 'pass' ? chalk.green : (p.verdict === 'fail' ? chalk.red : chalk.yellow);
                const mark = p.verdict === 'pass' ? '✓' : (p.verdict === 'fail' ? '✗' : '?');
                const name = (p.id || '?').padEnd(16);
                const verdict = p.verdict ? p.verdict.toUpperCase() : '?';
                out.push(color(`   │  ${mark} ${name} ${verdict.padEnd(W - name.length - 7)}│`));
                if (p.summary) {
                    const q = `    "${p.summary}"`;
                    const maxW = W - 2;
                    for (let i = 0; i < q.length; i += maxW) {
                        out.push(color(`   │ ${q.slice(i, i + maxW).padEnd(maxW)} │`));
                    }
                }
            }
            out.push(chalk.magenta(`   └${hr}┘`));
            break;
        }
        case 'debate-warning':
            out.push(chalk.yellow(`   ⚠ debate: ${e.reason}`));
            break;
        case 'learn':
            out.push(chalk.gray(`   📝 learn: lesson captured (cycle ${e.cycle})`));
            break;
        case 'intake':
            out.push(chalk.cyan(`   📥 intake: ${e.count || 0} requirements${e.skipped ? ` (${e.skipped})` : ''}`));
            break;
        case 'intake-warning':
            out.push(chalk.yellow(`   ⚠ ${e.reason}`));
            break;
        case 'fix-attempt':
            out.push(chalk.gray(`   ↻ fix-attempt: gate ${(e.failures || []).join(',') || '(lens)'}${e.noProgress ? ` · no-progress ×${e.noProgress}` : ''}`));
            break;
        case 'acceptance':
            out.push(chalk[e.allMet ? 'green' : 'yellow'](`   ⚖  requirements: ${e.met || 0}/${e.total || 0} đạt${e.failed && e.failed.length ? ` — chưa đạt: ${e.failed.join(', ')}` : ''}`));
            break;
        case 'blocked':
            out.push(chalk.red.bold(`   ⛔ BLOCKED — ${e.reason}`));
            out.push(chalk.yellow('      ↳ gỡ xong rồi tiếp tục: omni run --resume'));
            break;
        case 'pause':
            out.push(chalk.yellow(`   ⏸  PAUSE — ${e.reason}`));
            out.push(chalk.gray('      ↳ tiếp tục: omni run --resume'));
            break;
        default:
            break;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Spinner-driven event handler (SPEC-HEARTBEAT-SPINNER §3b). Replaces the
// stream-of-lines renderer for default `omni run`. Routes most events into
// the spinner label (silent), only stopAndLog'ing for things a user MUST see:
// task-done transitions, errors, blocked/pause, debate/intake warnings, and
// not-all-met acceptance. Heartbeat events are dropped (spinner self-counts).
//
// When `spinner` is null (--stream, --no-progress, or non-TTY fallback) we
// print the same surface lines directly via console.log — keeping logs clean
// while still surfacing errors + task transitions.
//
// `ctx` is a small mutable object owned by the caller:
//   { projectDir, prevCompleted, lastTaskDesc, lastStartedState }
// initialise via `createRunEventCtx(projectDir)`.
// ---------------------------------------------------------------------------
function createRunEventCtx(projectDir) {
    return {
        projectDir,
        prevCompleted: parseTodo(projectDir).completed || 0,
        lastTaskDesc: '',
        lastStartedState: null,
    };
}

function handleRunEvent(e, spinner, ctx) {
    const print = (line) => {
        if (line == null) return;
        if (spinner) { spinner.stopAndLog(line); spinner.resume(); }
        else console.log(line);
    };
    const hardStop = (line) => {
        if (line == null) return;
        if (spinner) spinner.stop();
        console.log(line);
    };

    switch (e.type) {
        case 'step-start': {
            ctx.lastTaskDesc = e.desc || '';
            ctx.lastStartedState = e.state;
            if (spinner) {
                let label = e.state || '';
                if (e.taskIdx && e.total) label += ` · task ${e.taskIdx}/${e.total}`;
                if (e.desc) label += ` "${e.desc}"`;
                else if (e.ide) label += ` · agent=${e.ide}`;
                spinner.setLabel(label);
            }
            break;
        }
        case 'heartbeat':
            // Spinner self-counts seconds; suppress to avoid line spam.
            break;
        case 'transition': {
            if (spinner) {
                spinner.setLabel(e.to || '');
            }
            // Suppress most transitions, but surface phase milestones as a
            // single tidy line so the user sees the SDLC moving.
            const MILESTONES = new Set(['ACCEPTANCE', 'DOC', 'SHIP', 'DONE']);
            if (e.to && MILESTONES.has(e.to)) {
                print(chalk.cyan(`▸ Chuyển sang ${e.to}`));
            }
            break;
        }
        case 'gate':
            if (e.passed === false) {
                print(chalk.red(`   ✗ gate FAIL ${(e.failures || []).join(',')}`));
            }
            // gate pass → suppress
            break;
        case 'debate': {
            if (e.consensus) {
                const lines = renderRunEvent(e);
                lines.forEach((l) => print(l));
            }
            break;
        }
        case 'provider':
        case 'fanout':
        case 'usage':
        case 'fix-attempt':
        case 'learn':
        case 'intake':
        case 'budget':
            // Suppressed — events.ndjson keeps them for `omni run log`.
            break;
        case 'step-end': {
            if (e.timedOut) {
                const lines = renderRunEvent(e).map((l) => l).join('\n');
                print(lines);
            } else if (e.exitCode !== 0) {
                const lines = renderRunEvent(e).map((l) => l).join('\n');
                print(lines);
            } else if (e.state === 'COOK') {
                // Task-done detection: COOK step-end OK AND completed count grew.
                let cur;
                try { cur = parseTodo(ctx.projectDir); } catch { cur = null; }
                if (cur && cur.completed > ctx.prevCompleted) {
                    const done = ctx.lastTaskDesc || '(task)';
                    let nextDesc = '(hết task)';
                    try {
                        const nt = nextTask(ctx.projectDir);
                        if (nt && nt.desc) nextDesc = nt.desc;
                        else if (cur.remaining === 0) nextDesc = '(hết task — sang ACCEPTANCE)';
                    } catch { /* keep default */ }
                    ctx.prevCompleted = cur.completed;
                    print(chalk.green(`✓ ${done} xong → tiếp: ${nextDesc}`));
                }
            }
            break;
        }
        case 'debate-warning':
            print(chalk.yellow(`   ⚠ debate: ${e.reason}`));
            break;
        case 'intake-warning':
            print(chalk.yellow(`   ⚠ ${e.reason}`));
            break;
        case 'acceptance':
            if (!e.allMet) {
                print(chalk.yellow(`   ⚖  requirements: ${e.met || 0}/${e.total || 0} đạt${e.failed && e.failed.length ? ` — chưa đạt: ${e.failed.join(', ')}` : ''}`));
            }
            break;
        case 'acceptance-req': {
            const statusSymbol = e.met ? chalk.green('✓') : chalk.red('✗');
            print(`   ${statusSymbol} ${e.id} [${e.method}]`);
            break;
        }
        case 'blocked': {
            hardStop(chalk.red.bold(`⛔ BLOCKED — ${e.reason}`));
            console.log(chalk.yellow('   ↳ gỡ xong rồi tiếp tục: omni run --resume'));
            break;
        }
        case 'pause': {
            hardStop(chalk.yellow(`⏸  PAUSE — ${e.reason}`));
            console.log(chalk.gray('   ↳ tiếp tục: omni run --resume'));
            break;
        }
        case 'done':
            if (spinner) spinner.stop();
            // Final summary is printed by handleRun (printRunSummary).
            break;
        default:
            // Unknown — suppress (still durable in events.ndjson).
            break;
    }
}

// `omni run` — Pha 1: drive the SDLC loop live (cook → check → fix), pause before SHIP.
async function handleRun(options = {}) {
    const projectDir = process.cwd();
    console.log(chalk.cyan.bold('\n🔁 omni run — harness loop\n'));

    if (!findConfigFile()) {
        console.log(chalk.yellow('⚠️  Chưa `omni init` ở đây. Harness lái vòng đời SDLC của một dự án đã init.\n'));
    }

    const dryRun = !!options.dryRun;
    const provider = dryRun ? 'dry-run' : (options.provider || 'host-cli');

    // Resolve starting state: --resume (state.json → events fallback) or --from.
    let from = 'INIT';
    if (options.resume) {
        const saved = loadState(projectDir);
        const recovered = saved ? saved.state : lastStateFromEvents(projectDir);
        if (recovered) {
            from = recovered;
            console.log(chalk.gray(`↩️  Resume từ ${saved ? 'state.json' : 'events.ndjson'}: state = ${chalk.white(from)}\n`));
        } else {
            console.log(chalk.gray('↩️  --resume nhưng không tìm thấy run trước → bắt đầu từ INIT.\n'));
        }
    } else if (options.from) {
        const requested = String(options.from).toUpperCase();
        if (!isValidState(requested)) {
            console.error(chalk.red(`✗ --from không hợp lệ: ${options.from}. Hợp lệ: ${STATES.join(', ')}\n`));
            process.exitCode = 1;
            return;
        }
        from = requested;
    }

    const plan = planRun({ from, provider });

    // Print the planned pipeline (artifact = hand-off, per orchestration-patterns).
    console.log(chalk.cyan.bold(`📋 Kế hoạch (provider: ${provider}, từ: ${from}):\n`));
    plan.sequence.forEach((p) => {
        console.log(`   ${chalk.white.bold(p.state.padEnd(11))} ${chalk.gray(p.agent.padEnd(13))} ${chalk.cyan(p.artifact)}`);
        console.log(`   ${' '.repeat(11)} ${chalk.gray(p.note)}`);
    });
    console.log(chalk.yellow(`\n   ⟳ ${plan.loopNote}\n`));

    if (dryRun) {
        console.log(chalk.green('✓ Dry-run — không thực thi, không ghi state.\n'));
        return;
    }

    const ide = (loadManifest() || {}).ide || 'claudecode';

    // Preflight: host-cli needs the host agent's CLI on PATH. Fail fast with a
    // clear message instead of churning the pipeline returning exit 127 per step.
    if (provider === 'host-cli') {
        const bin = { claudecode: 'claude', dual: 'claude', gemini: 'gemini', codex: 'codex', antigravity: 'agy', opencode: 'opencode', 'open-claude': 'open-claude', openclaude: 'openclaude' }[ide] || ide || 'claude';
        const probe = spawnSync(bin, ['--version'], { stdio: 'ignore' });
        if (probe.error && probe.error.code === 'ENOENT') {
            console.error(chalk.red(`✗ Không tìm thấy \`${bin}\` CLI trên PATH (provider host-cli, ide=${ide} cần nó).`));
            console.error(chalk.gray('   Cài CLI tương ứng, hoặc chạy thử bằng `--provider dry-run` / `--dry-run`.\n'));
            process.exitCode = 1;
            return;
        }
    }

    // Preflight: Warn if config file (AGENTS.md / CLAUDE.md) is too large (over 10KB)
    try {
        const fs = require('fs');
        const path = require('path');
        const configFiles = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];
        for (const file of configFiles) {
            const filePath = path.join(projectDir, file);
            if (fs.existsSync(filePath)) {
                const stat = fs.statSync(filePath);
                if (stat.size > 10240) { // 10KB
                    console.log(chalk.yellow(`⚠️  Cảnh báo: File cấu hình \`${file}\` có kích thước lớn (${Math.round(stat.size / 1024)}KB).`));
                    console.log(chalk.gray(`   Để tiết kiệm token và tăng tốc độ, hãy di chuyển các quy tắc chi tiết sang thư mục \`.agents/rules/\`.\n`));
                }
            }
        }
    } catch (_) {}

    let stepTimeoutMs;
    if (options.stepTimeout) {
        const val = Number(options.stepTimeout);
        if (!isNaN(val)) {
            stepTimeoutMs = Math.max(30, val * 60) * 1000;
        }
    }

    const budgetOverrides = {};
    if (options.maxIterations) budgetOverrides.maxIterations = Number(options.maxIterations);
    if (options.maxCost) budgetOverrides.maxCostUsd = Number(options.maxCost);
    if (options.maxAcceptRounds) budgetOverrides.maxAcceptanceRounds = Number(options.maxAcceptRounds);
    if (options.maxTime) {
        budgetOverrides.maxWallclockMs = Number(options.maxTime) * 60000;
    } else if (options.stepTimeout) {
        const val = Number(options.stepTimeout);
        if (!isNaN(val)) {
            budgetOverrides.maxWallclockMs = val * 3 * 60000;
        }
    }
    const budget = Object.keys(budgetOverrides).length ? budgetOverrides : undefined;

    const debate = options.debate ? String(options.debate).split(/[\s,]+/).filter(Boolean) : null;
    const debateOn = options.debateOn ? String(options.debateOn).split(/[\s,]+/).filter(Boolean) : (debate ? ['check'] : []);
    const debateRounds = options.debateRounds ? Number(options.debateRounds) : 2;
    if (debate) console.log(chalk.magenta(`   ⚔️  Debate: ${debate.join(' × ')} @ ${debateOn.join(',')} (${debateRounds} rounds)\n`));

    // Phase-4 acceptance options.
    const acceptSpecs = options.accept ? String(options.accept).split(/[\s,]+/).filter(Boolean) : null;
    if (options.spec) console.log(chalk.cyan(`   📝 Intake từ spec: ${options.spec}`));
    if (acceptSpecs && acceptSpecs.length) console.log(chalk.cyan(`   ⚖  Acceptance participants: ${acceptSpecs.join(' × ')}`));

    if (options.stream) console.log(chalk.gray('   📡 --stream BẬT: raw output agent (prefix │) — spinner heartbeat tắt.'));
    console.log(chalk.cyan.bold('▶️  Bắt đầu execution...\n'));

    // Spinner-driven heartbeat (SPEC-HEARTBEAT-SPINNER). Defaults ON, suppressed
    // by --stream (raw output cuộn), --no-progress/--quiet, or non-TTY.
    const noProgress = options.progress === false || !!options.quiet;
    const useSpinner = !options.stream && !noProgress && !!process.stdout.isTTY;
    const spinner = useSpinner ? createSpinner() : null;
    const ctx = createRunEventCtx(projectDir);
    if (spinner) {
        spinner.start('Khởi động…');
        // SIGINT mid-run would leave the cursor hidden; restore it.
        process.once('SIGINT', () => { try { spinner.stop(); } catch { /* noop */ } process.exit(130); });
    }
    const onEvent = (e) => handleRunEvent(e, spinner, ctx);

    let finalState;
    try {
        finalState = await runHarness(projectDir, {
            from, provider, yesShip: !!options.yesShip, budget, ide, onEvent,
            yolo: !!options.yolo,
            stream: !!options.stream,
            debate, debateOn, debateRounds,
            specFile: options.spec || null,
            acceptSpecs,
            stepTimeoutMs,
            freshStart: !!options.from && !options.resume,
            reintake: !!options.reintake,
        });
    } finally {
        if (spinner) spinner.stop();
    }

    console.log('');
    // OBS-5: one-line run total. host-cli has no usage → token/cost hidden.
    printRunSummary(projectDir);

    const s = finalState.status;
    if (s === 'done') console.log(chalk.green.bold(`✓ Hoàn tất — state DONE.\n`));
    else if (s === 'blocked') console.log(chalk.red.bold(`⛔ Dừng tại BLOCKED — cần người dùng gỡ rồi \`omni run --resume\`.\n`));
    else if (s === 'paused') console.log(chalk.yellow.bold(`⏸  Tạm dừng tại ${finalState.state}. Tiếp tục bằng \`omni run --resume\`${finalState.state === 'DOC' ? ' --yes-ship' : ''}.\n`));
    else console.log(chalk.gray(`Kết thúc ở state ${finalState.state} (status: ${s}).\n`));
}

// OBS-5: aggregate the just-finished run into one line. Token/cost shown only
// when a provider reported usage (claude-sdk); host-cli → steps + time only.
function printRunSummary(projectDir) {
    const { totals } = summarizeEvents(readEvents(projectDir));
    let line = `📊 ${totals.providerCalls} bước`;
    const tokens = (totals.inputTokens || 0) + (totals.outputTokens || 0);
    if (tokens) line += ` · ${tokens} tok`;
    if (totals.costUsd) line += ` · $${totals.costUsd.toFixed(2)}`;
    line += ` · ${formatDuration(totals.durationMs)}`;
    console.log(chalk.cyan.bold(`   ${line}\n`));
}

// One coloured trace line for an event (used by the static print + --follow).
function printTraceLine(e) {
    const ts = chalk.gray((e.ts || '').replace('T', ' ').replace(/\.\d+Z$/, ''));
    const detail = describeEvent(e);
    let typeColored;
    if (e.type === 'transition' || e.type === 'step-start') typeColored = chalk.cyan(e.type);
    else if (e.type === 'blocked' || (e.type === 'gate' && e.passed === false) || (e.type === 'step-end' && e.exitCode !== 0)) typeColored = chalk.red(e.type);
    else if (e.type === 'pause') typeColored = chalk.yellow(e.type);
    else typeColored = chalk.white(e.type);
    console.log(`   ${ts}  ${typeColored}  ${detail}`);
}

// `omni run log` — print the last N events from .omni/run/events.ndjson.
// With --follow, then tail new events as they are appended (Ctrl-C to stop),
// so a second terminal can watch a run live without touching core.
function handleTrace(options = {}) {
    const projectDir = process.cwd();
    const limit = Number(options.limit) > 0 ? Number(options.limit) : 50;
    const events = readEvents(projectDir);
    if (events.length === 0 && !options.follow) {
        console.log(chalk.gray('\n📭 Chưa có run nào (.omni/run/events.ndjson trống hoặc chưa tồn tại).\n'));
        return;
    }
    const slice = events.slice(-limit);
    console.log(chalk.cyan.bold(`\n🧾 omni run log — ${slice.length}/${events.length} event gần nhất\n`));
    for (const e of slice) printTraceLine(e);
    console.log('');

    if (options.follow) {
        let offset = eventsByteLength(projectDir);
        console.log(chalk.gray('   …following (Ctrl-C để dừng)\n'));
        const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : 1000;
        const timer = setInterval(() => {
            const { events: fresh, offset: next } = readEventsFrom(projectDir, offset);
            offset = next;
            for (const e of fresh) printTraceLine(e);
        }, intervalMs);
        process.on('SIGINT', () => { clearInterval(timer); console.log('\n👋 stop following.\n'); process.exit(0); });
    }
}

function describeEvent(e) {
    switch (e.type) {
        case 'transition': return chalk.white(`${e.from} → ${e.to}`) + (e.reason ? chalk.gray(`  (${e.reason})`) : '');
        case 'step-start': return chalk.white(formatStepStart({ state: e.state, ide: e.ide, model: e.model, taskIdx: e.taskIdx, total: e.total, desc: e.desc }));
        case 'step-end': return e.timedOut
            ? chalk.red(formatTimeout({ state: e.state, timeoutMs: e.timeoutMs }))
            : (e.exitCode === 0 ? chalk.green(formatStepEnd({ state: e.state, sec: e.sec, exitCode: 0, files: e.files }))
                : chalk.red(formatStepEnd({ state: e.state, sec: e.sec, exitCode: e.exitCode })));
        case 'heartbeat': return chalk.gray(formatTick(e.sec));
        case 'gate': return (e.passed ? chalk.green('PASS') : chalk.red('FAIL')) + chalk.gray(` ${e.failures && e.failures.length ? e.failures.join(',') : ''} ${e.durationMs != null ? e.durationMs + 'ms' : ''}`);
        case 'provider': return chalk.gray(`${e.provider}:${e.action || ''} exit=${e.exitCode} ${e.durationMs != null ? e.durationMs + 'ms' : ''}`);
        case 'acceptance': return (e.allMet ? chalk.green : chalk.yellow)(`${e.met || 0}/${e.total || 0} đạt${e.failed && e.failed.length ? ` — chưa đạt ${e.failed.join(',')}` : ''}`);
        case 'blocked': return chalk.red(e.reason || 'blocked');
        case 'pause': return chalk.yellow(e.reason || 'paused');
        case 'budget': return chalk.gray(`${e.event} ${e.iterations}/${e.maxIterations || ''}`);
        default: return chalk.gray(JSON.stringify({ ...e, ts: undefined, type: undefined }));
    }
}

// `omni gate [--only <ids>]` — run the quality pipeline, exit 0/1 (CI-friendly).
function handleGate(options = {}) {
    const projectDir = process.cwd();
    const only = options.only ? String(options.only).split(/[\s,]+/).filter(Boolean) : null;
    console.log(chalk.cyan.bold('\n🚦 omni gate — quality pipeline P0–P5 (P4/P5-low advisory)\n'));
    const { passed, results, failures } = runPipeline(projectDir, { only });
    for (const r of results) {
        let icon, status;
        if (r.status === 'pass') { icon = chalk.green('✓'); status = chalk.green('PASS'); }
        else if (r.status === 'fail') { icon = chalk.red('✗'); status = chalk.red('FAIL'); }
        else if (r.status === 'advisory') { icon = chalk.yellow('!'); status = chalk.yellow('ADVISORY'); }
        else { icon = chalk.gray('–'); status = chalk.gray('skipped'); }
        const sev = r.severity ? chalk.gray(` [${r.severity}]`) : '';
        console.log(`   ${icon} ${r.id} ${r.name.padEnd(10)} ${status}${sev}${r.durationMs ? chalk.gray(`  ${r.durationMs}ms`) : ''}`);
        if ((r.status === 'fail' || r.status === 'advisory') && r.output) {
            console.log(chalk.gray(r.output.split('\n').map((l) => '        ' + l).join('\n')));
        }
    }
    if (passed) {
        console.log(chalk.green.bold('\n✓ Gate PASS\n'));
        process.exitCode = 0;
    } else {
        console.log(chalk.red.bold(`\n✗ Gate FAIL — ${failures.join(', ')} → >om:fix\n`));
        process.exitCode = 1;
    }
}

// `omni stats` — aggregate token/cost/time per state from the event log.
function handleStats() {
    const projectDir = process.cwd();
    const events = readEvents(projectDir);
    if (events.length === 0) {
        console.log(chalk.gray('\n📭 Chưa có run nào (.omni/run/events.ndjson trống hoặc chưa tồn tại).\n'));
        return;
    }
    const { byState, totals } = summarizeEvents(events);
    console.log(chalk.cyan.bold('\n📊 omni stats — tổng hợp theo state\n'));
    console.log(chalk.gray('   State        calls    in_tok   out_tok    cost($)   time(ms)'));
    for (const [state, m] of Object.entries(byState)) {
        console.log(
            '   ' + chalk.white(state.padEnd(11)) +
            String(m.providerCalls).padStart(6) +
            String(m.inputTokens).padStart(10) +
            String(m.outputTokens).padStart(10) +
            ('  ' + m.costUsd.toFixed(4)).padStart(11) +
            String(m.durationMs).padStart(10)
        );
    }
    console.log(chalk.gray('   ' + '─'.repeat(58)));
    console.log(
        '   ' + chalk.white.bold('TOTAL'.padEnd(11)) +
        String(totals.providerCalls).padStart(6) +
        String(totals.inputTokens).padStart(10) +
        String(totals.outputTokens).padStart(10) +
        ('  ' + totals.costUsd.toFixed(4)).padStart(11) +
        String(totals.durationMs).padStart(10)
    );
    console.log(chalk.gray(`\n   ${totals.transitions} transitions · ${events.length} events\n`));
}

// `omni run accept` — run ACCEPTANCE state once on the current build (CI-friendly).
async function handleAccept(options = {}, cmd) {
    const projectDir = process.cwd();
    console.log(chalk.cyan.bold('\n⚖  omni run accept — acceptance loop (1 pass)\n'));

    if (!findConfigFile()) {
        console.log(chalk.yellow('⚠  Chưa `omni init` ở đây.\n'));
    }
    const ide = (loadManifest() || {}).ide || 'claudecode';

    const parentOpts = cmd && cmd.parent ? cmd.parent.opts() : {};
    const rawAccept = options.accept || parentOpts.accept;
    const acceptSpecs = rawAccept ? String(rawAccept).split(/[\s,]+/).filter(Boolean) : null;
    if (acceptSpecs && acceptSpecs.length) {
        console.log(chalk.cyan(`   ⚖  Participants: ${acceptSpecs.join(' × ')}\n`));
    } else {
        console.log(chalk.gray('   (no --accept specs — agent-judged requirements sẽ NOT-MET; nên truyền ≥2 provider khác model)\n'));
    }

    const noProgress = options.progress === false || !!options.quiet;
    const useSpinner = !noProgress && !!process.stdout.isTTY;
    const spinner = useSpinner ? createSpinner() : null;
    const ctx = createRunEventCtx(projectDir);
    if (spinner) {
        spinner.start('Acceptance…');
        process.once('SIGINT', () => { try { spinner.stop(); } catch { /* noop */ } process.exit(130); });
    }
    const onEvent = (e) => handleRunEvent(e, spinner, ctx);

    let stepTimeoutMs;
    if (options.stepTimeout) {
        const val = Number(options.stepTimeout);
        if (!isNaN(val)) {
            stepTimeoutMs = Math.max(30, val * 60) * 1000;
        }
    }

    const budgetOverrides = {};
    if (options.maxTime) {
        budgetOverrides.maxWallclockMs = Number(options.maxTime) * 60000;
    } else if (options.stepTimeout) {
        const val = Number(options.stepTimeout);
        if (!isNaN(val)) {
            budgetOverrides.maxWallclockMs = val * 3 * 60000;
        }
    }
    const budget = Object.keys(budgetOverrides).length ? budgetOverrides : undefined;

    // Force the state to ACCEPTANCE (or use whatever's saved), then run a single pass.
    const { loadState, createState, saveState } = require('../harness/state');
    let state = loadState(projectDir);
    if (!state || state.state !== 'ACCEPTANCE') {
        state = createState({ provider: 'host-cli', from: 'ACCEPTANCE' });
        saveState(projectDir, state);
    }
    let final;
    try {
        final = await runHarness(projectDir, {
            provider: 'host-cli', ide, acceptOnly: true, acceptSpecs,
            debate: acceptSpecs, debateRounds: 2,
            yolo: !!options.yolo,
            budget,
            stepTimeoutMs,
            onEvent,
        });
    } finally {
        if (spinner) spinner.stop();
    }
    console.log('');
    if (final.status === 'done') {
        console.log(chalk.green.bold('✓ Acceptance PASS — tất cả requirements đạt.\n'));
        process.exitCode = 0;
    } else if (final.status === 'paused') {
        console.log(chalk.yellow.bold('⏸  Acceptance còn requirement chưa đạt — xem .omni/sdlc/conformance.md.\n'));
        process.exitCode = 1;
    } else if (final.status === 'blocked') {
        console.log(chalk.red.bold('⛔ Acceptance BLOCKED — xem reason ở event log.\n'));
        process.exitCode = 1;
    } else {
        console.log(chalk.gray(`State: ${final.state} (status: ${final.status})\n`));
    }
}

module.exports = { handleRun, handleTrace, handleGate, handleStats, handleAccept, renderRunEvent, handleRunEvent, createRunEventCtx, printRunSummary };
