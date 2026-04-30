'use strict';

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const { writeFileSafe } = require('./helpers');

function handleCustomize(workflow) {
    const name = workflow.endsWith('.md') ? workflow : workflow + '.md';
    const pkgPath = path.join(__dirname, '..', '..', 'templates', 'workflows', name);

    if (!fs.existsSync(pkgPath)) {
        const available = fs.readdirSync(path.join(__dirname, '..', '..', 'templates', 'workflows'))
            .filter(f => f.endsWith('.md'))
            .map(f => f.replace('.md', ''));
        console.error(chalk.red(`\n❌ Workflow "${name}" không tồn tại.`));
        console.error(chalk.gray(`   Có sẵn: ${available.join(', ')}\n`));
        return;
    }

    const customDir = path.join(process.cwd(), '.omni', 'workflows');
    const customPath = path.join(customDir, name);

    if (fs.existsSync(customPath)) {
        console.error(chalk.yellow(`\n⚠️  .omni/workflows/${name} đã tồn tại — bỏ qua.\n`));
        return;
    }

    fs.mkdirSync(customDir, { recursive: true });
    const content = fs.readFileSync(pkgPath, 'utf-8');
    if (!writeFileSafe(customPath, content)) return;
    console.log(chalk.green(`\n✅ Đã copy ${name} → .omni/workflows/${name}`));
    console.log(chalk.gray(`   Chỉnh sửa file này. Omni sẽ ưu tiên bản custom.\n`));
}

module.exports = { handleCustomize };
