'use strict';

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { createManifest } = require('../helpers');

const MANIFEST_FILE = path.join('.omni', 'manifest.json');
const RULES_FILE = path.join('.omni', 'rules.md');

function findConfigFile() {
    const files = ['.cursorrules', '.windsurfrules', 'CLAUDE.md', 'GEMINI.md', 'AGENTS.md', 'SYSTEM_PROMPT.md'];
    for (const file of files) {
        if (fs.existsSync(path.join(process.cwd(), file))) return file;
    }
    return null;
}

const OMNI_GITIGNORE_PATTERNS = ['.omni/'];

function ensureGitignore(ide) {
    const gitignorePath = path.join(process.cwd(), '.gitignore');
    const patterns = [...OMNI_GITIGNORE_PATTERNS];
    if (ide === 'claudecode' || ide === 'dual') patterns.push('.claude/');
    if (ide === 'codex' || ide === 'dual') patterns.push('.codex/');
    if (ide === 'cursor') patterns.push('.cursor/');

    let existing = '';
    if (fs.existsSync(gitignorePath)) {
        existing = fs.readFileSync(gitignorePath, 'utf-8');
    }
    const existingLines = new Set(existing.split('\n').map(l => l.trim()));
    const missing = patterns.filter(p => !existingLines.has(p));
    if (missing.length === 0) return 0;

    const block = `\n# Omni-Coder Kit (generated)\n${missing.join('\n')}\n`;
    fs.writeFileSync(gitignorePath, existing.trimEnd() + '\n' + block, 'utf-8');
    return missing.length;
}

function writeFileSafe(filePath, content) {
    try {
        fs.writeFileSync(filePath, content, 'utf-8');
        return true;
    } catch (err) {
        console.log(chalk.red.bold(`\n❌ Lỗi khi ghi file: ${path.basename(filePath)}`));
        console.log(chalk.red(`   Chi tiết: ${err.message}\n`));
        return false;
    }
}

function loadManifest() {
    const p = path.join(process.cwd(), MANIFEST_FILE);
    if (fs.existsSync(p)) {
        try {
            return JSON.parse(fs.readFileSync(p, 'utf-8'));
        } catch {
            return createManifest();
        }
    }
    return createManifest();
}

function saveManifest(manifest) {
    const manifestPath = path.join(process.cwd(), MANIFEST_FILE);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    return writeFileSafe(manifestPath, JSON.stringify(manifest, null, 2));
}

function findSkillConflict(manifest, skillName) {
    const ext = manifest.skills.external.find(s => s.name === skillName);
    if (ext) {
        return { type: 'external', name: ext.name, source: ext.source };
    }
    return null;
}

module.exports = {
    MANIFEST_FILE, RULES_FILE,
    findConfigFile, ensureGitignore, writeFileSafe,
    loadManifest, saveManifest, findSkillConflict,
};
