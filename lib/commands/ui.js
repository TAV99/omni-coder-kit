'use strict';

// `omni ui [--port N] [--no-open] [--no-start] [--resume]` (SPEC-SQUAD-P6 §2,
// §5): a local web page for this squad project. It reads the squad files and the
// ledger directly, so the daemon need not be running, and runs the orchestrator
// CLI in a terminal pane when node-pty is installed.

const chalk = require('chalk');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectTrust } = require('../squad/trust');
const { readBinding } = require('../squad/bindings');
const { spawn } = require('node:child_process');

function openBrowser(url, { platform = process.platform, spawnImpl = spawn } = {}) {
    const [command, args] = platform === 'darwin' ? ['open', [url]]
        : platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : ['xdg-open', [url]];
    try {
        const child = spawnImpl(command, args, { stdio: 'ignore', detached: true });
        child.on('error', () => {});
        child.unref();
        return true;
    } catch {
        return false;
    }
}

async function handleUi(options = {}) {
    const { startUiServer } = require('../ui/server');
    const root = process.cwd();
    const port = options.port === undefined ? 0 : Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(chalk.red(`✗ --port không hợp lệ: ${options.port}`));
        process.exitCode = 1;
        return null;
    }
    const autoStart = options.start === false ? false : options.resume ? 'resume' : true;
    const lock = require('../ui/ui-lock').acquireUiLock(root);
    if (!lock.acquired) {
        const holder = lock.holder || {};
        console.error(chalk.red(`✗ omni ui đang chạy cho project này${holder.pid ? ` (pid ${holder.pid}${holder.port ? `, cổng ${holder.port}` : ''}, từ ${holder.started_at})` : ''}.`));
        console.error(chalk.gray('   Dùng tab trình duyệt của instance đó, hoặc tắt nó (Ctrl-C) rồi chạy lại. Hai orchestrator trên một phiên dual sẽ gửi chỉ dẫn chồng nhau.'));
        process.exitCode = 1;
        return null;
    }
    let ui;
    try {
        ui = await startUiServer({ projectRoot: root, port, autoStart, allowShell: options.allowShell === true });
    } catch (error) {
        lock.release();
        throw error;
    }
    try { lock.update({ port: Number(new URL(ui.url).port) || null }); } catch {}
    process.once('exit', () => lock.release());
    const pty = ui.pty.status();
    console.log(chalk.bold('omni ui'));
    console.log(`   ${ui.url}`);
    if (ui.mode() === 'setup') console.log(chalk.cyan('   Chưa có squad — chọn vai, CLI và model trên trang thiết lập.'));
    console.log(chalk.gray(`   Giao diện cũ (P6): ${ui.classicUrl}`));
    if (!pty.available) console.log(chalk.yellow(`   Không có terminal orchestrator (${pty.reason}) — trang chạy chế độ chỉ đọc.`));
    else if (pty.status === 'running') console.log(chalk.gray(`   Orchestrator ${pty.runtime} · ${pty.model} đang chạy trong trang.`));
    // O3: say why the orchestrator pane may open on a trust prompt (read-only).
    const orchestratorRuntime = pty.runtime || (() => { try { return readBinding(root)?.roles.orchestrator.runtime; } catch { return null; } })();
    if (pty.available && orchestratorRuntime) {
        const verdict = projectTrust(orchestratorRuntime, root, { homedir: os.homedir() });
        if (verdict.status === 'untrusted') console.log(chalk.yellow(`   ${orchestratorRuntime} chưa tin cậy ${verdict.key}: orchestrator sẽ hỏi trust trong trang — chọn "Yes" ở đó, hoặc ${verdict.fix}.`));
    }
    console.log(chalk.gray('   Token nằm sau dấu #, không gửi lên server. Ctrl-C để tắt.'));
    if (options.open !== false && !openBrowser(ui.url)) console.log(chalk.yellow('   Không mở được trình duyệt — mở URL trên bằng tay.'));
    const stop = () => { ui.close().then(() => { lock.release(); process.exit(0); }); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return ui;
}

module.exports = { handleUi, openBrowser };
