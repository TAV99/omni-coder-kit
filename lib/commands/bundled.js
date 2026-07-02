'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const { loadManifest, saveManifest } = require('./helpers');
const { getSkillDir, detectDNA } = require('../helpers');
const { UNIVERSAL_SKILLS, UI_SKILLS } = require('../skills');

function getGlobalCacheDir() {
    return process.env.OMNI_CACHE_DIR || path.join(os.homedir(), '.omni', 'skills-cache');
}

function getBundledDir() {
    return process.env.OMNI_BUNDLED_DIR || path.join(__dirname, '..', '..', 'templates', 'bundled-skills');
}

function installOfflineSkills() {
    const manifest = loadManifest();
    const skillDir = getSkillDir(manifest);
    const installed = manifest.skills.external.map(s => s.name);
    let countCache = 0;
    let countBundled = 0;
    let countSkip = 0;

    const cacheDir = getGlobalCacheDir();
    const bundledDir = getBundledDir();

    const dna = detectDNA(process.cwd());
    const skillsToInstall = [...UNIVERSAL_SKILLS];
    if (dna.hasUI) {
        skillsToInstall.push(...UI_SKILLS);
    }

    for (const skill of skillsToInstall) {
        if (installed.includes(skill.name)) {
            countSkip++;
            continue;
        }

        const slug = skill.source.replace(/\//g, '-');

        // Layer 2: Global cache (priority)
        let src = path.join(cacheDir, slug, skill.name, 'SKILL.md');
        let sourceType = 'cached';

        // Layer 3: Bundled fallback
        if (!fs.existsSync(src)) {
            src = path.join(bundledDir, slug, skill.name, 'SKILL.md');
            sourceType = 'bundled';
        }

        if (!fs.existsSync(src)) {
            console.log(chalk.gray(`   ⏭  ${skill.name} — không có sẵn`));
            continue;
        }

        const dest = path.join(process.cwd(), skillDir, skill.name, 'SKILL.md');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);

        manifest.skills.external.push({
            name: skill.name,
            source: skill.source,
            sourceType,
            installedAt: new Date().toISOString(),
        });

        const icon = sourceType === 'cached' ? '📦' : '📋';
        const label = sourceType === 'cached' ? 'cache' : 'bundled';
        console.log(chalk.green(`   ${icon} ${skill.name} (${label})`));
        if (sourceType === 'cached') {
            countCache++;
        } else {
            countBundled++;
        }
    }

    saveManifest(manifest);
    console.log(chalk.cyan(
        `   Tổng: ${countCache} từ cache, ${countBundled} từ bundled, ${countSkip} đã có`
    ));
}

function updateGlobalCache(manifest, projectDir = process.cwd()) {
    const skillDir = getSkillDir(manifest);
    const cacheDir = getGlobalCacheDir();
    let updated = 0;

    const dna = detectDNA(projectDir);
    const skillsToCache = [...UNIVERSAL_SKILLS];
    if (dna.hasUI) {
        skillsToCache.push(...UI_SKILLS);
    }

    for (const skill of skillsToCache) {
        const slug = skill.source.replace(/\//g, '-');
        const projectFile = path.join(projectDir, skillDir, skill.name, 'SKILL.md');

        if (!fs.existsSync(projectFile)) continue;

        const cacheDest = path.join(cacheDir, slug, skill.name, 'SKILL.md');
        fs.mkdirSync(path.dirname(cacheDest), { recursive: true });
        fs.copyFileSync(projectFile, cacheDest);
        updated++;
    }

    if (updated > 0) {
        console.log(chalk.gray(`   💾 Đã cập nhật ${updated} skills vào cache (${cacheDir})`));
    }
}

module.exports = { installOfflineSkills, updateGlobalCache, getGlobalCacheDir, getBundledDir };
