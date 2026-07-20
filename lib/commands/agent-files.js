'use strict';

const path = require('path');
const chalk = require('chalk');

const {
    AGENT_FILE_PATTERNS,
    TRADEOFF_WARNING,
    getAgentFilesVisibility,
    hideAgentFiles,
    showAgentFiles,
    listTrackedAgentFiles,
} = require('../agent-files');
const { loadManifest, saveManifest } = require('./helpers');

async function handleAgentFiles(action) {
    const projectDir = process.cwd();
    const act = (action || '').toLowerCase();

    if (!act || !['hide', 'show', 'status'].includes(act)) {
        console.error(chalk.red('\n❌ Dùng: omni agent-files <hide|show|status>\n'));
        console.error(chalk.gray('  hide   — ẩn file agent khỏi git (.gitignore)'));
        console.error(chalk.gray('  show   — gỡ block ẩn, cho phép commit lại'));
        console.error(chalk.gray('  status — xem trạng thái hiện tại\n'));
        process.exitCode = 1;
        return;
    }

    if (act === 'status') {
        const visibility = getAgentFilesVisibility(projectDir);
        console.log(chalk.cyan.bold('\n📁 Agent files visibility\n'));
        console.log(`   Status:   ${visibility === 'hidden' ? chalk.yellow('hidden') : chalk.green('visible')}`);
        console.log(`   Patterns: ${AGENT_FILE_PATTERNS.length}`);
        for (const p of AGENT_FILE_PATTERNS) {
            console.log(chalk.gray(`     - ${p}`));
        }
        console.log();
        return;
    }

    try {
        if (act === 'hide') {
            const result = hideAgentFiles(projectDir);
            if (!result.changed) {
                console.log(chalk.gray('\n✓ Agent files đã ở trạng thái hidden (no-op).\n'));
            } else {
                console.log(chalk.green.bold('\n✅ Đã ẩn agent files trong .gitignore'));
                console.log(chalk.yellow(`\n⚠️  ${TRADEOFF_WARNING}\n`));
            }
            const tracked = listTrackedAgentFiles(projectDir);
            if (tracked.length > 0) {
                console.log(chalk.yellow('⚠️  Các path sau vẫn đang được git track (gitignore không gỡ tracked files):'));
                for (const f of tracked.slice(0, 20)) {
                    console.log(chalk.gray(`     ${f}`));
                }
                if (tracked.length > 20) {
                    console.log(chalk.gray(`     … và ${tracked.length - 20} path khác`));
                }
                console.log(chalk.gray('   Gợi ý: git rm --cached -- <paths>  (không xoá file local)\n'));
            }
            const manifest = loadManifest();
            manifest.agentFilesVisibility = 'hidden';
            saveManifest(manifest);
            return;
        }

        // show
        const result = showAgentFiles(projectDir);
        if (!result.changed) {
            console.log(chalk.gray('\n✓ Agent files đã ở trạng thái visible (no-op).\n'));
        } else {
            console.log(chalk.green.bold('\n✅ Đã gỡ block ẩn agent files khỏi .gitignore'));
            console.log(chalk.gray('   File local không đổi. Commit thủ công nếu muốn share rules.\n'));
        }
        const manifest = loadManifest();
        manifest.agentFilesVisibility = 'visible';
        saveManifest(manifest);
    } catch (err) {
        if (err.code === 'AGENT_FILES_BLOCK_CORRUPT') {
            console.error(chalk.red(`\n❌ ${err.message}\n`));
            process.exitCode = 1;
            return;
        }
        throw err;
    }
}

module.exports = { handleAgentFiles };
