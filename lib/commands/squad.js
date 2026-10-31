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

module.exports = { handleSquadRuntimes, runSquadRuntimes };
