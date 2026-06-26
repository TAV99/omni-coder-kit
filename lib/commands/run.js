'use strict';

const chalk = require('chalk');

const { planRun, runHarness } = require('../harness/loop');
const { loadState, createState, saveState, isValidState, STATES } = require('../harness/state');
const { appendEvent, lastStateFromEvents } = require('../harness/events');
const { findConfigFile } = require('./helpers');

// `omni run` — Pha 0: dry-run planner + state/resume scaffolding.
function handleRun(options = {}) {
    const projectDir = process.cwd();
    console.log(chalk.cyan.bold('\n🔁 omni run — harness loop (Pha 0 skeleton)\n'));

    if (!findConfigFile()) {
        console.log(chalk.yellow('⚠️  Chưa `omni init` ở đây. Harness lái vòng đời SDLC của một dự án đã init.\n'));
    }

    const provider = options.provider || 'host-cli';

    // Resolve starting state: --resume (state.json → events fallback) or --from.
    let from = 'INIT';
    let resumed = false;
    if (options.resume) {
        const saved = loadState(projectDir);
        const recovered = saved ? saved.state : lastStateFromEvents(projectDir);
        if (recovered) {
            from = recovered;
            resumed = true;
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
    plan.sequence.forEach((p, i) => {
        const arrow = i < plan.sequence.length - 1 ? chalk.gray(' →') : '';
        console.log(`   ${chalk.white.bold(p.state.padEnd(11))} ${chalk.gray(p.agent.padEnd(13))} ${chalk.cyan(p.artifact)}`);
        console.log(`   ${' '.repeat(11)} ${chalk.gray(p.note)}${arrow}`);
    });
    console.log(chalk.yellow(`\n   ⟳ ${plan.loopNote}\n`));
    console.log(chalk.gray(`   Budget: ${plan.budget.maxIterations} iters · ${Math.round(plan.budget.maxWallclockMs / 60000)} phút · ${plan.budget.maxFixAttempts} fix/cycle\n`));

    if (options.dryRun) {
        console.log(chalk.green('✓ Dry-run — không thực thi, không ghi state.\n'));
        return;
    }

    // Live mode: Pha 0 refuses, but records the intent so --resume has an anchor.
    const result = runHarness({ dryRun: false, from, provider });
    if (!result.executed) {
        const state = resumed ? (loadState(projectDir) || createState({ provider, from })) : createState({ provider, from });
        saveState(projectDir, state);
        appendEvent(projectDir, { type: 'run-attempt', mode: 'live', from, provider, blocked: result.reason });
        console.log(chalk.yellow(`⏳ ${result.reason}\n`));
        console.log(chalk.gray(`   Đã lưu state khởi đầu (.omni/run/state.json) — dùng \`omni run --resume\` khi Pha 1 sẵn sàng.\n`));
    }
}

module.exports = { handleRun };
