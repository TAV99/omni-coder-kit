'use strict';

const fs = require('fs');
const path = require('path');
const prompts = require('prompts');
const chalk = require('chalk');
const { execFileSync } = require('child_process');

const {
    parseSource, isValidSkillName, getAgentFlags,
    classifySource, getSkillDir, fetchContentSync, githubRawURL, detectDNA,
} = require('../helpers');
const { detectExistingProject, scanProject } = require('../scanner');
const { UNIVERSAL_SKILLS, UI_SKILLS, getTestSkillsForStack, getFESkillsForStack, getShipSkillsForStack, getQualitySkillsForStack, buildSearchSuggestion } = require('../skills');
const {
    MANIFEST_FILE, findConfigFile, writeFileSafe, loadManifest, saveManifest, findSkillConflict,
} = require('./helpers');

// ---------------------------------------------------------------------------
// Multi-source install helpers
// ---------------------------------------------------------------------------

function deriveSkillName(source, options) {
    if (options.name) return options.name;
    const raw = typeof source === 'string' ? source : (source.path || '');
    return raw.split('/').pop().replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || null;
}

function saveSkillFile(manifest, skillName, content) {
    const skillDir = getSkillDir(manifest);
    const targetDir = path.join(process.cwd(), skillDir, skillName);
    fs.mkdirSync(targetDir, { recursive: true });
    return writeFileSafe(path.join(targetDir, 'SKILL.md'), content);
}

function trackInManifest(manifest, skillName, source, sourceType) {
    const existing = manifest.skills.external.find(s => s.name === skillName);
    if (existing) {
        existing.source = source;
        existing.sourceType = sourceType;
        existing.installedAt = new Date().toISOString();
    } else {
        manifest.skills.external.push({
            name: skillName,
            source,
            sourceType,
            installedAt: new Date().toISOString(),
        });
    }
    manifest.configFile = findConfigFile();
    saveManifest(manifest);
}

function installFromRegistry(parsedSource, skillName, options) {
    const manifest = loadManifest();
    const conflict = findSkillConflict(manifest, skillName);
    if (conflict && !options.force) {
        console.error(chalk.yellow.bold(`\n⚠️  Kỹ năng "${skillName}" đã được cài trước đó. Dùng ${chalk.cyan('--force')} để ghi đè.\n`));
        return;
    }

    const agentFlags = getAgentFlags(manifest);
    console.log(chalk.cyan.bold(`\n🔧 Đang cài từ skills.sh: ${chalk.white(parsedSource)}`));
    if (agentFlags) console.log(chalk.gray(`   Target: ${agentFlags}`));
    console.log('');

    const isWin = process.platform === 'win32';
    try {
        const args = ['skills', 'add', parsedSource];
        if (agentFlags) args.push(...agentFlags.split(' '));
        execFileSync(isWin ? 'npx.cmd' : 'npx', args, { stdio: 'inherit', shell: isWin });
    } catch {
        console.error(chalk.red.bold(`\n❌ Cài đặt thất bại. Kiểm tra lại source hoặc mạng.\n`));
        return;
    }

    trackInManifest(manifest, skillName, parsedSource, 'registry');
    console.log(chalk.green.bold(`\n✅ [${skillName}] đã cài thành công!`));
    console.log(chalk.gray(`   Source: ${parsedSource} (skills.sh)`));
    console.log(chalk.gray(`   Manifest: ${MANIFEST_FILE}\n`));
}

function installFromURL(url, skillName, options) {
    const manifest = loadManifest();
    const conflict = findSkillConflict(manifest, skillName);
    if (conflict && !options.force) {
        console.error(chalk.yellow.bold(`\n⚠️  Kỹ năng "${skillName}" đã được cài trước đó. Dùng ${chalk.cyan('--force')} để ghi đè.\n`));
        return;
    }

    console.log(chalk.cyan.bold(`\n🌐 Đang tải từ URL: ${chalk.white(url)}`));
    let content;
    try {
        content = fetchContentSync(url);
    } catch {
        console.error(chalk.red.bold(`\n❌ Không thể tải nội dung từ URL.\n`));
        return;
    }

    if (!saveSkillFile(manifest, skillName, content)) return;

    trackInManifest(manifest, skillName, url, 'url');
    const skillDir = getSkillDir(manifest);
    console.log(chalk.green.bold(`\n✅ [${skillName}] đã cài thành công!`));
    console.log(chalk.gray(`   Source: ${url}`));
    console.log(chalk.gray(`   File: ${skillDir}/${skillName}/SKILL.md\n`));
}

function installFromGitHub(ghSource, skillName, options) {
    const manifest = loadManifest();
    const conflict = findSkillConflict(manifest, skillName);
    if (conflict && !options.force) {
        console.error(chalk.yellow.bold(`\n⚠️  Kỹ năng "${skillName}" đã được cài trước đó. Dùng ${chalk.cyan('--force')} để ghi đè.\n`));
        return;
    }

    const displaySource = `gh:${ghSource.owner}/${ghSource.repo}/${ghSource.path}`;
    console.log(chalk.cyan.bold(`\n📦 Đang tải từ GitHub: ${chalk.white(displaySource)}`));

    let content;
    try {
        content = fetchContentSync(githubRawURL(ghSource.owner, ghSource.repo, ghSource.path));
    } catch {
        try {
            content = fetchContentSync(githubRawURL(ghSource.owner, ghSource.repo, ghSource.path, 'master'));
        } catch {
            console.error(chalk.red.bold(`\n❌ Không thể tải từ GitHub. Kiểm tra owner/repo/path.\n`));
            return;
        }
    }

    if (!saveSkillFile(manifest, skillName, content)) return;

    trackInManifest(manifest, skillName, displaySource, 'github');
    const skillDir = getSkillDir(manifest);
    console.log(chalk.green.bold(`\n✅ [${skillName}] đã cài thành công!`));
    console.log(chalk.gray(`   Source: ${displaySource}`));
    console.log(chalk.gray(`   File: ${skillDir}/${skillName}/SKILL.md\n`));
}

function installFromLocal(filePath, skillName, options) {
    const manifest = loadManifest();
    const conflict = findSkillConflict(manifest, skillName);
    if (conflict && !options.force) {
        console.error(chalk.yellow.bold(`\n⚠️  Kỹ năng "${skillName}" đã được cài trước đó. Dùng ${chalk.cyan('--force')} để ghi đè.\n`));
        return;
    }

    if (!fs.existsSync(filePath)) {
        console.error(chalk.red.bold(`\n❌ File không tồn tại: ${filePath}\n`));
        return;
    }

    console.log(chalk.cyan.bold(`\n📄 Đang cài từ local: ${chalk.white(filePath)}`));
    const content = fs.readFileSync(filePath, 'utf-8');

    if (!saveSkillFile(manifest, skillName, content)) return;

    trackInManifest(manifest, skillName, `local:${filePath}`, 'local');
    const skillDir = getSkillDir(manifest);
    console.log(chalk.green.bold(`\n✅ [${skillName}] đã cài thành công!`));
    console.log(chalk.gray(`   Source: ${filePath}`));
    console.log(chalk.gray(`   File: ${skillDir}/${skillName}/SKILL.md\n`));
}

// ---------------------------------------------------------------------------
// Public handlers
// ---------------------------------------------------------------------------

async function handleEquip(source, options) {
    const classified = classifySource(source);
    if (!classified) {
        console.error(chalk.red.bold(`\n❌ Source không hợp lệ.`));
        console.log(chalk.gray(`   Hỗ trợ: owner/repo | https://url/skill.md | gh:owner/repo/path.md | ./local/path.md\n`));
        return;
    }

    const configFile = findConfigFile();
    if (!configFile) {
        console.error(chalk.red.bold('\n❌ Không tìm thấy file Omni. Hãy chạy "omni init" trước.\n'));
        return;
    }

    const skillName = deriveSkillName(classified.value, options);
    if (!skillName || !isValidSkillName(skillName)) {
        console.error(chalk.red.bold(`\n❌ Không thể xác định tên skill. Dùng --name <tên> để đặt tên thủ công.\n`));
        return;
    }

    switch (classified.type) {
        case 'registry': return installFromRegistry(classified.value, skillName, options);
        case 'url':      return installFromURL(classified.value, skillName, options);
        case 'github':   return installFromGitHub(classified.value, skillName, options);
        case 'local':    return installFromLocal(classified.value, skillName, options);
    }
}

// ---------------------------------------------------------------------------
// Auto-equip
// ---------------------------------------------------------------------------

function generateRetryScript(failedSkills, agentFlags, isWin) {
    if (isWin) {
        let script = '@echo off\n';
        script += ':: Generated by Omni-Coder Kit - retry failed skills\n';
        script += `:: Failed: ${failedSkills.length} skills\n\n`;

        for (const skill of failedSkills) {
            const installCmd = agentFlags
                ? `npx -y skills add ${skill.source} ${agentFlags} --skill "*" -y`
                : `npx -y skills add ${skill.source} --all`;
            script += `echo [Retry] Dang cai: ${skill.name} (${skill.source})...\n`;
            script += `${installCmd}\n`;
            script += `echo    [OK] ${skill.name}\n\n`;
        }

        script += `echo.\necho Hoan tat! Da cai ${failedSkills.length} skills.\n`;
        script += `echo Chay "omni status" de xem trang thai.\n`;
        return script;
    }

    let script = '#!/bin/bash\n';
    script += '# Generated by Omni-Coder Kit — retry failed skills\n';
    script += `# Failed: ${failedSkills.length} skills\n\n`;
    script += 'set -e\n\n';

    for (const skill of failedSkills) {
        const installCmd = agentFlags
            ? `npx -y skills add ${skill.source} ${agentFlags} --skill '*' -y`
            : `npx -y skills add ${skill.source} --all`;
        script += `echo "🔧 Đang cài: ${skill.name} (${skill.source})..."\n`;
        script += `${installCmd}\n`;
        script += `echo "   ✓ ${skill.name}"\n\n`;
    }

    script += `echo ""\necho "✅ Hoàn tất! Đã cài ${failedSkills.length} skills."\n`;
    script += `echo "💡 Chạy 'omni status' để xem trạng thái."\n`;
    return script;
}

async function handleAutoEquip(options) {
    const projectDir = process.cwd();
    const configFile = findConfigFile();
    if (!configFile) {
        console.error(chalk.red.bold('\n❌ Không tìm thấy file Omni. Hãy chạy "omni init" trước.\n'));
        return;
    }

    const manifest = loadManifest();
    const alreadyInstalled = manifest.skills.external.map(s => s.name);

    const dna = detectDNA(projectDir);
    const baseUniversal = [...UNIVERSAL_SKILLS];
    if (dna.hasUI) {
        baseUniversal.push(...UI_SKILLS);
    }
    const toInstall = baseUniversal.filter(s => !alreadyInstalled.includes(s.name));

    if (toInstall.length === 0) {
        console.log(chalk.green.bold('\n✅ Tất cả universal skills đã được cài! Kiểm tra FE/test skills...\n'));
    } else {
        console.log(chalk.cyan.bold('📦 Danh sách universal skills sẽ được cài từ skills.sh:\n'));
        toInstall.forEach((s, i) => {
            console.log(chalk.white(`   ${i + 1}. ${chalk.bold(s.name)} ${chalk.green('MỚI')}`));
            console.log(chalk.gray(`      └─ ${s.desc} (${s.source})`));
        });
        console.log('');

        const agentFlags = getAgentFlags(manifest);

        if (!options.yes) {
            const { confirmed } = await prompts({
                type: 'confirm',
                name: 'confirmed',
                message: `Cài đặt ${toInstall.length} universal skills? (y/N)`,
                initial: false
            });
            if (!confirmed) {
                console.error(chalk.yellow('\n⚠️  Hủy bỏ.\n'));
                return;
            }
        } else {
            console.log(chalk.green(`⚡ Auto-install: ${toInstall.length} skills (project-level)\n`));
        }

        const isWin = process.platform === 'win32';
        let installed = 0;
        let failed = 0;
        if (agentFlags) console.log(chalk.gray(`   Target: ${agentFlags}\n`));

        for (const skill of toInstall) {
            console.log(chalk.cyan(`\n🔧 [${installed + failed + 1}/${toInstall.length}] Đang cài: ${chalk.white(skill.name)}...`));
            try {
                const skillArgs = ['-y', 'skills', 'add', skill.source];
                if (agentFlags) {
                    skillArgs.push(...agentFlags.split(' '), '--skill', '*', '-y');
                } else if (options.yes) {
                    skillArgs.push('--all');
                }
                execFileSync(isWin ? 'npx.cmd' : 'npx', skillArgs, { stdio: 'inherit', timeout: 60000, shell: isWin });
                manifest.skills.external.push({
                    name: skill.name,
                    source: skill.source,
                    sourceType: 'registry',
                    installedAt: new Date().toISOString()
                });
                installed++;
                console.log(chalk.green(`   ✓ ${skill.name}`));
            } catch {
                failed++;
                console.error(chalk.red(`   ✗ ${skill.name} — thất bại, bỏ qua`));
            }
        }

        manifest.configFile = configFile;
        saveManifest(manifest);

        console.log(chalk.cyan.bold('\n' + '─'.repeat(45)));
        console.log(chalk.green.bold(`   ✅ Thành công: ${installed}/${toInstall.length} skills`));
        if (failed > 0) {
            console.error(chalk.red(`   ❌ Thất bại: ${failed} skills`));
            const failedSkills = toInstall.filter(s => !manifest.skills.external.some(e => e.name === s.name));
            if (failedSkills.length > 0) {
                const isWin = process.platform === 'win32';
                const scriptName = isWin ? 'install-skills.cmd' : 'install-skills.sh';
                const scriptPath = path.join(projectDir, scriptName);
                const script = generateRetryScript(failedSkills, agentFlags, isWin);
                if (writeFileSafe(scriptPath, script)) {
                    if (!isWin) { try { fs.chmodSync(scriptPath, '755'); } catch {} }
                    console.log(chalk.yellow(`\n   💡 Đã tạo ${chalk.white(scriptName)} cho ${failedSkills.length} skill thất bại.`));
                    console.log(chalk.white(`      Chạy ngoài sandbox: `) + chalk.cyan.bold(isWin ? `.\\${scriptName}` : `bash ${scriptName}`));
                }
            }
        }
        console.log(chalk.gray(`   Manifest: ${MANIFEST_FILE}`));
        console.log(chalk.cyan.bold('─'.repeat(45) + '\n'));
    }

    // Phase 2 & 3: Detect tech stack → propose test skills + FE skills
    const detected = detectExistingProject(projectDir);
    if (!detected.detected) {
        console.error(chalk.gray('   ⚠️ Không phát hiện project — bỏ qua đề xuất skills.\n'));
        return;
    }

    const scan = scanProject(projectDir);
    if (!scan.techStack || !scan.techStack.language) {
        console.log(chalk.gray('   ℹ️ Không xác định được ngôn ngữ chính — bỏ qua.\n'));
        return;
    }

    const agentFlags = getAgentFlags(manifest);
    const installedNames = manifest.skills.external.map(s => s.name);

    // Phase 2: Test skills
    await proposeAndInstallSkills({
        skills: getTestSkillsForStack(scan.techStack),
        installedNames,
        label: '🧪 Test Skills',
        stackLabel: [scan.techStack.language, scan.techStack.test].filter(Boolean).join(' + '),
        fallbackMsg: buildNoSkillMsg(scan.techStack),
        manifest,
        agentFlags,
        options,
        category: 'testing',
    });

    // Phase 3: FE skills
    const updatedInstalledNames = manifest.skills.external.map(s => s.name);
    await proposeAndInstallSkills({
        skills: getFESkillsForStack(scan.techStack, projectDir),
        installedNames: updatedInstalledNames,
        label: '🎨 Frontend Skills',
        stackLabel: [scan.techStack.ui, scan.techStack.framework].filter(Boolean).join(' + '),
        fallbackMsg: null,
        manifest,
        agentFlags,
        options,
        category: 'frontend',
    });

    // Phase 4: Ship skills (deploy lifecycle — universal)
    const installedAfterFE = manifest.skills.external.map(s => s.name);
    await proposeAndInstallSkills({
        skills: getShipSkillsForStack(scan.techStack),
        installedNames: installedAfterFE,
        label: '🚀 Ship Skills',
        stackLabel: scan.techStack.language,
        fallbackMsg: null,
        manifest,
        agentFlags,
        options,
        category: 'ship',
    });

    // Phase 5: Quality skills (Tier-2 BUILD/VERIFY/REVIEW — universal)
    const installedAfterShip = manifest.skills.external.map(s => s.name);
    await proposeAndInstallSkills({
        skills: getQualitySkillsForStack(scan.techStack),
        installedNames: installedAfterShip,
        label: '🔬 Quality Skills',
        stackLabel: scan.techStack.language,
        fallbackMsg: null,
        manifest,
        agentFlags,
        options,
        category: 'quality',
    });
}

function buildNoSkillMsg(techStack) {
    const keyword = buildSearchSuggestion(techStack.language, techStack.test);
    return {
        line1: `Chưa có curated test skill cho ${techStack.language}.`,
        line2: `Gợi ý: dùng >om-skill hoặc tìm: npx skills search "${keyword}"`,
    };
}

async function proposeAndInstallSkills({ skills, installedNames, label, stackLabel, fallbackMsg, manifest, agentFlags, options, category }) {
    if (skills.length === 0) {
        if (fallbackMsg) {
            console.log(chalk.yellow(`\n   🔍 ${fallbackMsg.line1}`));
            console.log(chalk.gray(`      ${fallbackMsg.line2}\n`));
        }
        return;
    }

    const toInstall = skills.filter(s => !installedNames.includes(s.name));
    if (toInstall.length === 0) return;

    console.log(chalk.cyan.bold(`\n${label} — phát hiện: ${chalk.white(stackLabel || 'auto')}\n`));
    toInstall.forEach((s, i) => {
        console.log(chalk.white(`   ${i + 1}. ${chalk.bold(s.name)} ${chalk.green('MỚI')}`));
        console.log(chalk.gray(`      └─ ${s.desc} (${s.source})`));
    });
    console.log('');

    if (!options.yes) {
        const { confirmed } = await prompts({
            type: 'confirm',
            name: 'confirmed',
            message: `Cài ${toInstall.length} ${category} skill${toInstall.length > 1 ? 's' : ''}? (y/N)`,
            initial: false,
        });
        if (!confirmed) return;
    } else {
        console.log(chalk.green(`⚡ Auto-install: ${toInstall.length} ${category} skill(s)\n`));
    }

    const isWin = process.platform === 'win32';
    let count = 0;
    for (const skill of toInstall) {
        console.log(chalk.cyan(`\n${label.slice(0, 2)} Đang cài: ${chalk.white(skill.name)}...`));
        try {
            const skillArgs = ['-y', 'skills', 'add', skill.source];
            if (agentFlags) {
                skillArgs.push(...agentFlags.split(' '), '--skill', skill.name, '-y');
            } else {
                skillArgs.push('--skill', skill.name, '-y');
            }
            execFileSync(isWin ? 'npx.cmd' : 'npx', skillArgs, { stdio: 'inherit', timeout: 60000, shell: isWin });
            manifest.skills.external.push({
                name: skill.name,
                source: skill.source,
                sourceType: 'registry',
                installedAt: new Date().toISOString(),
                category,
            });
            count++;
            console.log(chalk.green(`   ✓ ${skill.name}`));
        } catch {
            console.error(chalk.red(`   ✗ ${skill.name} — thất bại, bỏ qua`));
        }
    }

    if (count > 0) {
        saveManifest(manifest);
        console.log(chalk.green.bold(`\n   ${label}: ${count}/${toInstall.length} cài thành công\n`));
    }
}

module.exports = { handleEquip, handleAutoEquip };
