'use strict';

// `omni ui [--port N] [--no-open] [--no-start] [--resume]` (SPEC-SQUAD-P6 §2,
// §5): a local web page for this squad project. It reads the squad files and the
// ledger directly, so the daemon need not be running, and runs the orchestrator
// CLI in a terminal pane when node-pty is installed.

const chalk = require('chalk');
const fs = require('node:fs');
const path = require('node:path');
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
    if (!fs.existsSync(path.join(root, '.omni', 'squad'))) {
        console.error(chalk.red('✗ chưa có .omni/squad — chạy "omni squad setup" trước'));
        process.exitCode = 1;
        return null;
    }
    const port = options.port === undefined ? 0 : Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(chalk.red(`✗ --port không hợp lệ: ${options.port}`));
        process.exitCode = 1;
        return null;
    }
    const autoStart = options.start === false ? false : options.resume ? 'resume' : true;
    const ui = await startUiServer({ projectRoot: root, port, autoStart, allowShell: options.allowShell === true });
    const pty = ui.pty.status();
    console.log(chalk.bold('omni ui'));
    console.log(`   ${ui.url}`);
    if (!pty.available) console.log(chalk.yellow(`   Không có terminal orchestrator (${pty.reason}) — trang chạy chế độ chỉ đọc.`));
    else if (pty.status === 'running') console.log(chalk.gray(`   Orchestrator ${pty.runtime} · ${pty.model} đang chạy trong trang.`));
    console.log(chalk.gray('   Token nằm sau dấu #, không gửi lên server. Ctrl-C để tắt.'));
    if (options.open !== false && !openBrowser(ui.url)) console.log(chalk.yellow('   Không mở được trình duyệt — mở URL trên bằng tay.'));
    const stop = () => { ui.close().then(() => process.exit(0)); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return ui;
}

module.exports = { handleUi, openBrowser };
