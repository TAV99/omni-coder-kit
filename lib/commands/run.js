'use strict';

const chalk = require('chalk');
const { spawnSync } = require('child_process');

const { planRun, runHarness } = require('../harness/loop');
const { loadState, isValidState, STATES } = require('../harness/state');
const { lastStateFromEvents, readEvents } = require('../harness/events');
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

    // Preflight: host-cli needs the `claude` CLI. Fail fast with a clear message
    // instead of churning the whole pipeline returning exit 127 each step.
    if (provider === 'host-cli') {
        const probe = spawnSync('claude', ['--version'], { stdio: 'ignore' });
        if (probe.error && probe.error.code === 'ENOENT') {
            console.error(chalk.red('✗ Không tìm thấy `claude` CLI trên PATH (provider host-cli cần nó).'));
            console.error(chalk.gray('   Cài Claude Code, hoặc chạy thử bằng `--provider dry-run` / `--dry-run`.\n'));
            process.exitCode = 1;
            return;
        }
    }

    const budget = options.maxIterations ? { maxIterations: Number(options.maxIterations) } : undefined;

    console.log(chalk.cyan.bold('▶️  Bắt đầu execution...\n'));
    const onEvent = (e) => {
        if (e.type === 'transition') console.log(chalk.cyan(`   → ${e.from} → ${e.to}`) + (e.reason ? chalk.gray(`  (${e.reason})`) : ''));
        else if (e.type === 'gate') console.log((e.passed ? chalk.green('   ✓ gate PASS') : chalk.red(`   ✗ gate FAIL ${(e.failures || []).join(',')}`)));
        else if (e.type === 'provider') console.log(chalk.gray(`   · ${e.provider}:${e.action} exit=${e.exitCode}`));
        else if (e.type === 'blocked') console.log(chalk.red(`   ⛔ BLOCKED — ${e.reason}`));
        else if (e.type === 'pause') console.log(chalk.yellow(`   ⏸  PAUSE — ${e.reason}`));
    };

    const finalState = await runHarness(projectDir, { from, provider, yesShip: !!options.yesShip, budget, ide, onEvent });

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
    console.log(chalk.cyan.bold('\n🚦 omni gate — quality pipeline (P1–P3 live, P0/P4/P5 placeholder)\n'));
    const { passed, results, failures } = runPipeline(projectDir, { only });
    for (const r of results) {
        const icon = r.status === 'pass' ? chalk.green('✓') : r.status === 'fail' ? chalk.red('✗') : chalk.gray('–');
        const status = r.status === 'pass' ? chalk.green('PASS') : r.status === 'fail' ? chalk.red('FAIL') : chalk.gray('skipped');
        console.log(`   ${icon} ${r.id} ${r.name.padEnd(10)} ${status}${r.durationMs ? chalk.gray(`  ${r.durationMs}ms`) : ''}`);
        if (r.status === 'fail' && r.output) {
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

module.exports = { handleRun, handleTrace, handleGate };
