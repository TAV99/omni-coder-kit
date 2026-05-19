'use strict';

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const {
    detectExistingProject, scanProject, walkDir,
    generateMapSkeleton, refreshMap,
    analyzeCodePatterns, analyzeDeps, classifyStructureType,
    MAX_DEPTH,
} = require('../scanner');
const { handleInit } = require('./init');
const {
    MANIFEST_FILE, writeFileSafe, loadManifest, saveManifest,
} = require('./helpers');

const ONBOARD_REPORT = path.join('.omni', 'onboard-report.json');

function buildOnboardReport(dir, scanResult, codePatterns, deps, structureType) {
    const topDirs = scanResult.structure
        .filter(s => s.depth === 0 && s.path.endsWith('/'))
        .map(s => s.path.replace(/\/$/, ''));

    const landmineList = (scanResult.landmines || []).slice(0, 10);

    return {
        version: 1,
        scannedAt: new Date().toISOString(),
        project: {
            name: path.basename(dir),
            root: dir,
        },
        techStack: scanResult.techStack,
        stats: scanResult.stats,
        conventions: scanResult.conventions,
        codePatterns,
        structure: {
            type: structureType,
            keyDirs: topDirs.slice(0, 15),
            entryPoints: scanResult.entryPoints,
        },
        ci: scanResult.ci,
        docs: scanResult.docs,
        landmines: {
            count: landmineList.length,
            topIssues: landmineList.map(l => `${l.tag} in ${l.file}:${l.line} — ${l.text}`),
        },
        deps,
    };
}

async function handleOnboard(options) {
    const dir = process.cwd();

    const existing = detectExistingProject(dir);
    if (!existing.detected) {
        console.error(chalk.red.bold('\n❌ Không phát hiện project (thiếu package.json, pyproject.toml, go.mod...).'));
        console.error(chalk.red('   Chạy lệnh này trong thư mục gốc của dự án.\n'));
        return;
    }

    const manifestPath = path.join(dir, MANIFEST_FILE);
    if (!fs.existsSync(manifestPath) && !options.skipInit) {
        console.log(chalk.cyan('\n📦 Chưa init — đang chạy omni init...\n'));
        await handleInit({});
        console.log('');
    }

    const manifest = loadManifest();

    if (manifest.onboard && manifest.onboard.status === 'completed' && !options.refresh) {
        const date = new Date(manifest.onboard.onboardedAt).toLocaleDateString('vi-VN');
        console.log(chalk.cyan.bold('\n📊 Dự án đã được onboard'));
        console.log(chalk.white(`   Ngày     : ${date}`));
        console.log(chalk.white(`   Report   : ${ONBOARD_REPORT}`));
        console.log(chalk.yellow(`\n   Dùng --refresh để scan lại.\n`));
        return;
    }

    console.log(chalk.cyan.bold('\n🔍 Scanning project...\n'));

    const walked = walkDir(dir, dir, 0, MAX_DEPTH);
    const scanResult = scanProject(dir);
    const codePatterns = analyzeCodePatterns(dir, walked.allFiles);
    const deps = analyzeDeps(dir);
    const structureType = classifyStructureType(scanResult.structure);

    const report = buildOnboardReport(dir, scanResult, codePatterns, deps, structureType);

    const reportPath = path.join(dir, ONBOARD_REPORT);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSafe(reportPath, JSON.stringify(report, null, 2));

    const mapPath = path.join(dir, '.omni', 'knowledge', 'project-map.md');
    if (options.refresh || !fs.existsSync(mapPath)) {
        try {
            if (fs.existsSync(mapPath)) {
                refreshMap(dir);
            } else {
                generateMapSkeleton(dir);
            }
        } catch { /* map generation is best-effort */ }
    }

    const generated = {
        onboardReport: ONBOARD_REPORT,
        projectMap: '.omni/knowledge/project-map.md',
    };

    manifest.onboard = {
        status: 'completed',
        onboardedAt: new Date().toISOString(),
        scanVersion: report.version,
        generated,
    };
    saveManifest(manifest);

    const ts = report.techStack;
    const conv = report.conventions;
    const lm = report.landmines;

    console.log(chalk.cyan.bold('📊 Onboard Report\n'));
    console.log(chalk.white(`   Language   : ${ts.language || '(unknown)'}`));
    if (ts.framework) console.log(chalk.white(`   Framework  : ${ts.framework}`));
    if (ts.ui)        console.log(chalk.white(`   UI         : ${ts.ui}`));
    if (ts.db)        console.log(chalk.white(`   DB         : ${ts.db}`));
    if (ts.test)      console.log(chalk.white(`   Test       : ${ts.test}`));
    console.log(chalk.white(`   LOC        : ${report.stats.loc.toLocaleString()} (${report.stats.files} files)`));

    const convParts = [];
    if (conv.linter) convParts.push(conv.linter);
    if (conv.formatter && conv.formatter !== conv.linter) convParts.push(conv.formatter);
    if (conv.commitConvention) convParts.push(conv.commitConvention + ' commits');
    if (convParts.length > 0) {
        console.log(chalk.white(`   Conventions: ${convParts.join(' + ')}`));
    }

    console.log(chalk.white(`   Structure  : ${structureType}`));
    console.log(chalk.white(`   Patterns   : ${codePatterns.naming.files} files, ${codePatterns.imports.style} imports`));

    if (lm.count > 0) {
        console.log(chalk.yellow(`   Landmines  : ${lm.count} issues`));
    }

    console.log(chalk.green(`\n✅ Saved ${ONBOARD_REPORT}`));
    if (fs.existsSync(mapPath)) {
        console.log(chalk.green('✅ Updated project-map.md'));
    }
    console.log(chalk.cyan('\n💡 Tiếp theo: gõ >om:onboard trong chat AI để sinh rules & skills\n'));
}

module.exports = { handleOnboard, buildOnboardReport };
