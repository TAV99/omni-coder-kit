'use strict';

// `omni ui [--port N] [--no-open]` (SPEC-SQUAD-P6 §2, P6a): a read-only local
// web page for this squad project. It reads the squad files and the ledger
// directly, so the daemon need not be running.

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
    const ui = await startUiServer({ projectRoot: root, port });
    console.log(chalk.bold('omni ui (chỉ đọc)'));
    console.log(`   ${ui.url}`);
    console.log(chalk.gray('   Token nằm sau dấu #, không gửi lên server. Ctrl-C để tắt.'));
    if (options.open !== false && !openBrowser(ui.url)) console.log(chalk.yellow('   Không mở được trình duyệt — mở URL trên bằng tay.'));
    const stop = () => { ui.close().then(() => process.exit(0)); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return ui;
}

module.exports = { handleUi, openBrowser };
