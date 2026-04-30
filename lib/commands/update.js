'use strict';

const chalk = require('chalk');
const { execFileSync } = require('child_process');

const PKG = require('../../package.json');

function handleUpdate() {
    const current = PKG.version;
    console.log(chalk.cyan(`\n🔍 Phiên bản hiện tại: ${chalk.white.bold('v' + current)}`));
    console.log(chalk.gray('   Đang kiểm tra phiên bản mới trên npm...\n'));

    let latest;
    try {
        latest = execFileSync('npm', ['view', 'omni-coder-kit', 'version'], { encoding: 'utf-8' }).trim();
    } catch {
        console.error(chalk.red.bold('❌ Không thể kiểm tra npm. Kiểm tra kết nối mạng.\n'));
        return;
    }

    if (current === latest) {
        console.log(chalk.green.bold(`✅ Đã là phiên bản mới nhất (v${current}).\n`));
        return;
    }

    console.log(chalk.yellow(`   Phiên bản mới: ${chalk.white.bold('v' + latest)} (hiện tại: v${current})\n`));
    console.log(chalk.cyan('   Đang cập nhật...'));

    try {
        execFileSync('npm', ['install', '-g', 'omni-coder-kit@latest'], { stdio: 'inherit', timeout: 60000 });
        console.log(chalk.green.bold(`\n✅ Đã cập nhật lên v${latest}!\n`));
    } catch {
        console.error(chalk.red.bold('\n❌ Cập nhật thất bại. Thử chạy thủ công:'));
        console.error(chalk.cyan('   npm install -g omni-coder-kit@latest\n'));
    }
}

module.exports = { handleUpdate };
