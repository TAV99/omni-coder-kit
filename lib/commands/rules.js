'use strict';

const fs = require('fs');
const path = require('path');
const prompts = require('prompts');
const chalk = require('chalk');

const { parseRules, formatMarkdown, syncRulesToConfig } = require('../rules');
const { RULES_FILE, findConfigFile, writeFileSafe } = require('./helpers');

async function handleRules(action, options) {
    const projectDir = process.cwd();
    const rulesPath = path.join(projectDir, RULES_FILE);
    const configFile = findConfigFile();

    if (!action) {
        const { choice } = await prompts({
            type: 'select',
            name: 'choice',
            message: 'Personal Rules — chọn thao tác:',
            choices: [
                { title: '📋 Xem rules hiện tại', value: 'view' },
                { title: '✏️  Sửa rules', value: 'edit' },
                { title: '🔄 Sync vào config file', value: 'sync' },
                { title: '🗑️  Reset (xóa rules)', value: 'reset' },
            ],
        });
        action = choice;
    }

    if (!action) return;

    if (action === 'view') {
        if (!fs.existsSync(rulesPath)) {
            console.error(chalk.yellow(`\n⚠️  Chưa có personal rules. Chạy ${chalk.cyan('omni rules edit')} hoặc ${chalk.cyan('omni init')} để tạo.\n`));
            return;
        }
        console.log(chalk.cyan.bold('\n📋 Personal Rules:\n'));
        console.log(fs.readFileSync(rulesPath, 'utf-8'));
        return;
    }

    if (action === 'edit') {
        console.log(chalk.cyan.bold('\n✏️  Sửa Personal Rules') + chalk.gray(' (Enter để giữ nguyên)\n'));

        let existing = { language: '', codingStyle: '', forbidden: '', custom: '' };
        if (fs.existsSync(rulesPath)) {
            const content = fs.readFileSync(rulesPath, 'utf-8');
            const extractSection = (name) => {
                const regex = new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`);
                const match = content.match(regex);
                return match ? match[1].split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2)).join('; ') : '';
            };
            existing.language = extractSection('Ngôn ngữ');
            existing.codingStyle = extractSection('Coding Style');
            existing.forbidden = extractSection('Forbidden Patterns');
            existing.custom = extractSection('Custom Rules');
        }

        const rp = await prompts([
            { type: 'text', name: 'language', message: 'Ngôn ngữ giao tiếp? (VD: "Tiếng Việt", "English only")', initial: existing.language },
            { type: 'text', name: 'codingStyle', message: 'Coding style / conventions? (VD: "camelCase, 2-space indent, prefer const")', initial: existing.codingStyle },
            { type: 'text', name: 'forbidden', message: 'Forbidden patterns? (VD: "không dùng any, không inline styles")', initial: existing.forbidden },
            { type: 'text', name: 'custom', message: 'Custom rules (phân cách bằng ;)? (VD: "commit message tiếng Việt; luôn viết test")', initial: existing.custom },
        ]);

        const content = formatMarkdown(parseRules(rp));
        if (!content) {
            console.error(chalk.yellow('\n⚠️  Không có rules nào được nhập.\n'));
            return;
        }

        writeFileSafe(rulesPath, content);
        console.log(chalk.green.bold(`\n✅ Đã lưu ${RULES_FILE}`));

        if (configFile) {
            const syncResult = syncRulesToConfig(findConfigFile, projectDir);
            if (syncResult === 'corrupt') {
                console.error(chalk.red(`   ⚠️  ${configFile} có markers hỏng (chỉ có 1 trong 2 markers <!-- omni:rules -->). Sửa thủ công rồi chạy ${chalk.cyan('omni rules sync')}.\n`));
            } else if (syncResult) {
                console.log(chalk.green(`   ✅ Đã sync vào ${configFile}\n`));
            } else {
                console.error(chalk.yellow(`   ⚠️  Không thể sync vào ${configFile}. Chạy ${chalk.cyan('omni rules sync')} thủ công.\n`));
            }
        }
        return;
    }

    if (action === 'sync') {
        if (!fs.existsSync(rulesPath)) {
            console.error(chalk.red(`\n❌ Không tìm thấy ${RULES_FILE}. Chạy ${chalk.cyan('omni rules edit')} trước.\n`));
            return;
        }
        if (!configFile) {
            console.error(chalk.red(`\n❌ Không tìm thấy config file. Chạy ${chalk.cyan('omni init')} trước.\n`));
            return;
        }
        if (options.dryRun) {
            const result = syncRulesToConfig(findConfigFile, projectDir, { dryRun: true });
            if (result.action === 'corrupt') {
                console.error(chalk.red(`\n⚠️  ${configFile} có markers hỏng. Sửa thủ công trước khi sync.\n`));
            } else if (result.action === 'skip') {
                console.log(chalk.yellow(`\nKhông có gì để sync.\n`));
            } else {
                console.log(chalk.cyan.bold(`\n📋 Dry run — would ${result.action} rules in ${configFile}:\n`));
                console.log(result.preview);
                console.log(chalk.gray('\nNo files were changed.\n'));
            }
        } else {
            const syncResult = syncRulesToConfig(findConfigFile, projectDir);
            if (syncResult === 'corrupt') {
                console.error(chalk.red(`\n⚠️  ${configFile} có markers hỏng (chỉ có 1 trong 2 markers <!-- omni:rules -->). Sửa thủ công trước khi sync.\n`));
            } else if (syncResult) {
                console.log(chalk.green.bold(`\n✅ Đã sync ${RULES_FILE} → ${configFile}\n`));
            } else {
                console.error(chalk.red('\n❌ Sync thất bại.\n'));
            }
        }
        return;
    }

    if (action === 'reset') {
        if (!fs.existsSync(rulesPath)) {
            console.error(chalk.yellow('\n⚠️  Không có rules để xóa.\n'));
            return;
        }
        const { confirm } = await prompts({
            type: 'confirm',
            name: 'confirm',
            message: `Xóa ${RULES_FILE} và remove rules khỏi config file?`,
            initial: false,
        });
        if (!confirm) {
            console.error(chalk.yellow('\n⚠️  Hủy bỏ.\n'));
            return;
        }

        fs.unlinkSync(rulesPath);
        console.log(chalk.green(`   ✅ Đã xóa ${RULES_FILE}`));

        if (configFile) {
            const configPath = path.join(projectDir, configFile);
            let config = fs.readFileSync(configPath, 'utf-8');
            const startMarker = '<!-- omni:rules -->';
            const endMarker = '<!-- /omni:rules -->';
            if (config.includes(startMarker)) {
                const regex = new RegExp(`\\n*${startMarker}[\\s\\S]*?${endMarker}\\n*`, 'g');
                config = config.replace(regex, '\n');
                writeFileSafe(configPath, config);
                console.log(chalk.green(`   ✅ Đã remove rules khỏi ${configFile}`));
            }
        }
        console.log('');
        return;
    }

    console.error(chalk.red(`\n❌ Action không hợp lệ: ${action}. Dùng: view, edit, sync, reset\n`));
}

module.exports = { handleRules };
