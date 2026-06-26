'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const chalk = require('chalk');

const { getSkillDir } = require('../helpers');
const { UNIVERSAL_SKILLS, TEST_SKILLS, FE_SKILLS } = require('../skills');
const { loadManifest, findConfigFile } = require('./helpers');

const MAX_DESCRIPTION_LENGTH = 1024;
const REQUEST_TIMEOUT_MS = 8000;
const CONCURRENCY = 6;

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable, no network / no fs side effects)
// ---------------------------------------------------------------------------

/**
 * Gom toàn bộ `source` từ 3 registry hardcode, dedupe, kèm danh sách skill dùng nguồn đó.
 * @returns {Array<{ source: string, skills: string[] }>}
 */
function collectRegistrySources() {
    const map = new Map();
    const add = (registry) => {
        for (const s of registry) {
            if (!s.source) continue;
            if (!map.has(s.source)) map.set(s.source, new Set());
            map.get(s.source).add(s.name);
        }
    };
    add(UNIVERSAL_SKILLS);
    add(TEST_SKILLS);
    add(FE_SKILLS);

    return [...map.entries()]
        .map(([source, skills]) => ({ source, skills: [...skills].sort() }))
        .sort((a, b) => a.source.localeCompare(b.source));
}

/**
 * Parse YAML-style frontmatter ở đầu file markdown.
 * Trả về object key→value, hoặc null nếu không có block frontmatter.
 * (Port từ addyosmani/agent-skills scripts/validate-skills.js — MIT.)
 */
function parseFrontmatter(content) {
    const match = content.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/);
    if (!match) return null;
    const result = {};
    for (const line of match[1].split(/\r?\n/)) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (key) result[key] = value;
    }
    return result;
}

/**
 * Validate nội dung một SKILL.md theo chuẩn skill-anatomy.
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateSkillContent(dirName, content) {
    const errors = [];
    const warnings = [];

    const fm = parseFrontmatter(content);
    if (!fm) {
        errors.push("Thiếu/sai YAML frontmatter (cần block --- ở đầu file)");
        return { errors, warnings };
    }
    if (!fm.name) {
        errors.push("Frontmatter thiếu field 'name'");
    } else if (dirName && fm.name !== dirName) {
        warnings.push(`Frontmatter name '${fm.name}' khác tên thư mục '${dirName}'`);
    }
    if (!fm.description) {
        errors.push("Frontmatter thiếu field 'description'");
    } else if (fm.description.length > MAX_DESCRIPTION_LENGTH) {
        errors.push(`Description ${fm.description.length} ký tự — vượt giới hạn ${MAX_DESCRIPTION_LENGTH}`);
    }
    return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Network check (GitHub repo liveness)
// ---------------------------------------------------------------------------

/**
 * Kiểm tra một repo GitHub `owner/repo` còn sống không.
 * Resolve { status, alive, redirectedTo|null, error|null }.
 */
function checkGitHubSource(source) {
    return new Promise((resolve) => {
        // Chỉ lấy phần owner/repo (bỏ path con nếu có)
        const repoSlug = source.split('/').slice(0, 2).join('/');
        const req = https.request(
            {
                method: 'HEAD',
                hostname: 'github.com',
                path: `/${repoSlug}`,
                headers: { 'User-Agent': 'omni-coder-kit-doctor' },
                timeout: REQUEST_TIMEOUT_MS,
            },
            (res) => {
                const status = res.statusCode;
                const location = res.headers.location || null;
                res.resume(); // drain
                const alive = status >= 200 && status < 400;
                let redirectedTo = null;
                if (location && /^https?:\/\/github\.com\//i.test(location)) {
                    const dest = location.replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
                    if (dest.toLowerCase() !== repoSlug.toLowerCase()) redirectedTo = dest;
                }
                resolve({ source, status, alive, redirectedTo, error: null });
            }
        );
        req.on('timeout', () => {
            req.destroy();
            resolve({ source, status: null, alive: null, redirectedTo: null, error: 'timeout' });
        });
        req.on('error', (err) => {
            resolve({ source, status: null, alive: null, redirectedTo: null, error: err.code || err.message });
        });
        req.end();
    });
}

async function runPool(items, worker, concurrency) {
    const results = [];
    let i = 0;
    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (i < items.length) {
            const idx = i++;
            results[idx] = await worker(items[idx], idx);
        }
    });
    await Promise.all(runners);
    return results;
}

// ---------------------------------------------------------------------------
// Local installed-skill scan
// ---------------------------------------------------------------------------

function scanInstalledSkills(projectDir, manifest) {
    const skillDir = path.join(projectDir, getSkillDir(manifest));
    if (!fs.existsSync(skillDir)) return { skillDir, results: [] };

    const entries = fs.readdirSync(skillDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();

    const results = entries.map((name) => {
        const skillPath = path.join(skillDir, name, 'SKILL.md');
        if (!fs.existsSync(skillPath)) {
            return { name, errors: ['Thiếu SKILL.md'], warnings: [] };
        }
        let content;
        try {
            content = fs.readFileSync(skillPath, 'utf-8');
        } catch (err) {
            return { name, errors: [`Không đọc được SKILL.md: ${err.message}`], warnings: [] };
        }
        return { name, ...validateSkillContent(name, content) };
    });

    return { skillDir, results };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handleDoctor(options = {}) {
    const projectDir = process.cwd();
    console.log(chalk.cyan.bold('\n🩺 omni skills:doctor — kiểm tra sức khỏe registry & skill đã cài\n'));

    // --- 1. Network: kiểm tra nguồn registry hardcode ---
    const sources = collectRegistrySources();
    if (!options.offline) {
        console.log(chalk.cyan.bold(`📡 Nguồn registry hardcode (${sources.length} nguồn):\n`));
        const checks = await runPool(sources, (s) => checkGitHubSource(s.source), CONCURRENCY);

        let alive = 0, dead = 0, unknown = 0, renamed = 0;
        for (const r of checks) {
            const meta = sources.find((s) => s.source === r.source);
            const used = chalk.gray(`(${meta.skills.join(', ')})`);
            if (r.error) {
                unknown++;
                console.log(`   ${chalk.yellow('?')}  ${r.source.padEnd(38)} ${chalk.yellow('mạng?')} ${chalk.gray(r.error)} ${used}`);
            } else if (r.redirectedTo) {
                renamed++; alive++;
                console.log(`   ${chalk.yellow('↪')}  ${r.source.padEnd(38)} ${chalk.yellow(`đổi tên → ${r.redirectedTo}`)} ${used}`);
            } else if (r.alive) {
                alive++;
                console.log(`   ${chalk.green('✓')}  ${r.source.padEnd(38)} ${chalk.green(r.status)} ${used}`);
            } else {
                dead++;
                console.log(`   ${chalk.red('✗')}  ${r.source.padEnd(38)} ${chalk.red(`${r.status} CHẾT`)} ${used}`);
            }
        }
        console.log(chalk.gray(`\n   → ${alive} sống${renamed ? ` (${renamed} đổi tên)` : ''}, ${dead} chết, ${unknown} không rõ\n`));
        if (dead > 0) {
            console.log(chalk.red.bold('   ⚠ Có nguồn đã chết — cập nhật `source` trong lib/skills.js hoặc thay bằng dynamic find-skills.\n'));
        }
        if (renamed > 0) {
            console.log(chalk.yellow('   ℹ Nguồn đổi tên vẫn cài được (GitHub redirect) nhưng nên cập nhật cho đúng.\n'));
        }
    } else {
        console.log(chalk.gray('📡 Bỏ qua kiểm tra mạng (--offline).\n'));
        console.log(chalk.gray(`   ${sources.length} nguồn trong registry: ${sources.map((s) => s.source).join(', ')}\n`));
    }

    // --- 2. Local: validate skill đã cài trong project ---
    const configFile = findConfigFile();
    if (!configFile) {
        console.log(chalk.gray('📂 Chưa `omni init` ở đây — bỏ qua kiểm tra skill đã cài.\n'));
    } else {
        const manifest = loadManifest();
        const { skillDir, results } = scanInstalledSkills(projectDir, manifest);
        if (results.length === 0) {
            console.log(chalk.gray(`📂 Không có skill nào trong ${getSkillDir(manifest)}.\n`));
        } else {
            console.log(chalk.cyan.bold(`📂 Skill đã cài (${getSkillDir(manifest)}) — ${results.length} skill:\n`));
            let ok = 0, errs = 0, warns = 0;
            for (const r of results) {
                if (r.errors.length === 0 && r.warnings.length === 0) {
                    ok++;
                    console.log(`   ${chalk.green('✓')}  ${r.name}`);
                } else {
                    const icon = r.errors.length > 0 ? chalk.red('✗') : chalk.yellow('⚠');
                    console.log(`   ${icon}  ${r.name}`);
                    for (const m of r.errors) { errs++; console.log(chalk.red(`        ERROR: ${m}`)); }
                    for (const m of r.warnings) { warns++; console.log(chalk.yellow(`        WARN:  ${m}`)); }
                }
            }
            console.log(chalk.gray(`\n   → ${ok} ổn, ${errs} lỗi, ${warns} cảnh báo\n`));
        }
    }

    console.log(chalk.cyan.bold('─'.repeat(50)));
    console.log(chalk.white('   Mẹo: chạy ') + chalk.cyan('omni skills:doctor --offline') + chalk.white(' để chỉ validate skill local.'));
    console.log(chalk.cyan.bold('─'.repeat(50) + '\n'));
}

module.exports = {
    handleDoctor,
    // export hàm thuần để test
    collectRegistrySources,
    parseFrontmatter,
    validateSkillContent,
    MAX_DESCRIPTION_LENGTH,
};
