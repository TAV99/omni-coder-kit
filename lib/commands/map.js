'use strict';

const path = require('path');
const chalk = require('chalk');

const { detectExistingProject, scanProject, generateMapSkeleton, refreshMap } = require('../scanner');
const { writeFileSafe, loadManifest, saveManifest } = require('./helpers');

function ensureMapDir(projectDir) {
    const fs = require('fs');
    const mapDir = path.join(projectDir, '.omni', 'knowledge');
    fs.mkdirSync(mapDir, { recursive: true });
    return path.join(mapDir, 'project-map.md');
}

function handleMap(options) {
    const projectDir = process.cwd();

    if (options.refresh) {
        const result = refreshMap(projectDir);
        if (!result) {
            console.error(chalk.red.bold('\n❌ Không tìm thấy .omni/knowledge/project-map.md. Chạy "omni map" hoặc "omni init" trước.\n'));
            return;
        }
        const mapPath = ensureMapDir(projectDir);
        if (!writeFileSafe(mapPath, result)) return;
        console.log(chalk.green.bold('\n🔄 Project Map refreshed: .omni/knowledge/project-map.md'));
        console.log(chalk.gray('   Các thay đổi cấu trúc đã được đánh dấu [NEW]/[DELETED].'));
        console.log(chalk.gray('   Chạy >om:map để AI cập nhật mô tả.\n'));
        return;
    }

    const detected = detectExistingProject(projectDir);
    if (!detected.detected) {
        console.error(chalk.yellow.bold('\n⚠️  Không phát hiện project (thiếu package.json, pyproject.toml, go.mod...).'));
        console.error(chalk.gray('   Chạy lệnh này trong thư mục gốc của dự án.\n'));
        return;
    }

    console.log(chalk.cyan.bold(`\n🔍 Đang quét project... (${detected.lang})`));
    const scan = scanProject(projectDir);
    const projectName = path.basename(projectDir);
    const skeleton = generateMapSkeleton(scan, projectName);

    const mapPath = ensureMapDir(projectDir);
    if (!writeFileSafe(mapPath, skeleton)) return;

    const manifest = loadManifest();
    manifest.projectMap = true;
    manifest.mapGeneratedAt = new Date().toISOString();
    saveManifest(manifest);

    console.log(chalk.green.bold('\n📁 Project Map skeleton: .omni/knowledge/project-map.md'));
    console.log(chalk.white(`   ${scan.stats.files} files | ${scan.stats.dirs} dirs | ~${scan.stats.loc} LOC`));
    console.log(chalk.white(`   ${scan.structure.filter(s => s.depth <= 2).length} directories mapped`));
    console.log(chalk.white(`   ${scan.entryPoints.length} entry points detected`));
    console.log(chalk.white(`   ${scan.landmines.length} landmines found`));
    console.log(chalk.cyan('\n   Chạy >om:map trong chat AI để điền mô tả chi tiết.\n'));
}

module.exports = { handleMap };
