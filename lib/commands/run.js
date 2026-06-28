'use strict';

const chalk = require('chalk');
const { spawnSync } = require('child_process');

const { planRun, runHarness } = require('../harness/loop');
const { loadState, isValidState, STATES } = require('../harness/state');
const { lastStateFromEvents, readEvents, summarizeEvents } = require('../harness/events');
const { runPipeline } = require('../harness/gates/pipeline');
const { findConfigFile, loadManifest } = require('./helpers');

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
        const bin = { claudecode: 'claude', dual: 'claude', gemini: 'gemini', codex: 'codex', antigravity: 'agy' }[ide] || 'claude';
        const probe = spawnSync(bin, ['--version'], { stdio: 'ignore' });
        if (probe.error && probe.error.code === 'ENOENT') {
            console.error(chalk.red(`✗ Không tìm thấy \`${bin}\` CLI trên PATH (provider host-cli, ide=${ide} cần nó).`));
            console.error(chalk.gray('   Cài CLI tương ứng, hoặc chạy thử bằng `--provider dry-run` / `--dry-run`.\n'));
            process.exitCode = 1;
            return;
        }
    }

    const budgetOverrides = {};
    if (options.maxIterations) budgetOverrides.maxIterations = Number(options.maxIterations);
    if (options.maxCost) budgetOverrides.maxCostUsd = Number(options.maxCost);
    const budget = Object.keys(budgetOverrides).length ? budgetOverrides : undefined;

    const debate = options.debate ? String(options.debate).split(/[\s,]+/).filter(Boolean) : null;
    const debateOn = options.debateOn ? String(options.debateOn).split(/[\s,]+/).filter(Boolean) : (debate ? ['check'] : []);
    const debateRounds = options.debateRounds ? Number(options.debateRounds) : 2;
    if (debate) console.log(chalk.magenta(`   ⚔️  Debate: ${debate.join(' × ')} @ ${debateOn.join(',')} (${debateRounds} rounds)\n`));

    console.log(chalk.cyan.bold('▶️  Bắt đầu execution...\n'));
    const onEvent = (e) => {
        if (e.type === 'transition') console.log(chalk.cyan(`   → ${e.from} → ${e.to}`) + (e.reason ? chalk.gray(`  (${e.reason})`) : ''));
        else if (e.type === 'gate') console.log((e.passed ? chalk.green('   ✓ gate PASS') : chalk.red(`   ✗ gate FAIL ${(e.failures || []).join(',')}`)));
        else if (e.type === 'provider') console.log(chalk.gray(`   · ${e.provider}:${e.action} exit=${e.exitCode}`));
        else if (e.type === 'debate') console.log(chalk.magenta(`   ⚔️  debate round ${e.round}: ${e.consensus}`));
        else if (e.type === 'debate-warning') console.log(chalk.yellow(`   ⚠ debate: ${e.reason}`));
        else if (e.type === 'learn') console.log(chalk.gray(`   📝 learn: lesson captured (cycle ${e.cycle})`));
        else if (e.type === 'blocked') console.log(chalk.red(`   ⛔ BLOCKED — ${e.reason}`));
        else if (e.type === 'pause') console.log(chalk.yellow(`   ⏸  PAUSE — ${e.reason}`));
    };

    const finalState = await runHarness(projectDir, {
        from, provider, yesShip: !!options.yesShip, budget, ide, onEvent,
        debate, debateOn, debateRounds,
    });

    console.log('');
    const s = finalState.status;
    if (s === 'done') console.log(chalk.green.bold(`✓ Hoàn tất — state DONE.\n`));
    else if (s === 'blocked') console.log(chalk.red.bold(`⛔ Dừng tại BLOCKED — cần người dùng gỡ rồi \`omni run --resume\`.\n`));
    else if (s === 'paused') console.log(chalk.yellow.bold(`⏸  Tạm dừng tại ${finalState.state}. Tiếp tục bằng \`omni run --resume\`${finalState.state === 'DOC' ? ' --yes-ship' : ''}.\n`));
    else console.log(chalk.gray(`Kết thúc ở state ${finalState.state} (status: ${s}).\n`));
}

// `omni trace` — print the last N events from .omni/run/events.ndjson.
function handleTrace(options = {}) {
    const projectDir = process.cwd();
    const limit = Number(options.limit) > 0 ? Number(options.limit) : 50;
    const events = readEvents(projectDir);
    if (events.length === 0) {
        console.log(chalk.gray('\n📭 Chưa có run nào (.omni/run/events.ndjson trống hoặc chưa tồn tại).\n'));
        return;
    }
    const slice = events.slice(-limit);
    console.log(chalk.cyan.bold(`\n🧾 omni trace — ${slice.length}/${events.length} event gần nhất\n`));
    for (const e of slice) {
        const ts = chalk.gray((e.ts || '').replace('T', ' ').replace(/\.\d+Z$/, ''));
        const detail = describeEvent(e);
        let typeColored;
        if (e.type === 'transition') typeColored = chalk.cyan(e.type);
        else if (e.type === 'blocked' || (e.type === 'gate' && e.passed === false)) typeColored = chalk.red(e.type);
        else if (e.type === 'pause') typeColored = chalk.yellow(e.type);
        else typeColored = chalk.white(e.type);
        console.log(`   ${ts}  ${typeColored}  ${detail}`);
    }
    console.log('');
}

function describeEvent(e) {
    switch (e.type) {
        case 'transition': return chalk.white(`${e.from} → ${e.to}`) + (e.reason ? chalk.gray(`  (${e.reason})`) : '');
        case 'gate': return (e.passed ? chalk.green('PASS') : chalk.red('FAIL')) + chalk.gray(` ${e.failures && e.failures.length ? e.failures.join(',') : ''} ${e.durationMs != null ? e.durationMs + 'ms' : ''}`);
        case 'provider': return chalk.gray(`${e.provider}:${e.action || ''} exit=${e.exitCode} ${e.durationMs != null ? e.durationMs + 'ms' : ''}`);
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

module.exports = { handleRun, handleTrace, handleGate, handleStats };
