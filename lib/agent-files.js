'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** Single source of truth for agent-related gitignore patterns (all IDEs). */
const AGENT_FILE_PATTERNS = [
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    '.cursorrules',
    '.windsurfrules',
    'SYSTEM_PROMPT.md',
    '.claude/',
    '.codex/',
    '.cursor/',
    '.windsurf/',
    '.gemini/',
    '.agents/',
];

const BLOCK_START = '# Omni-Coder Kit — agent files (hidden)';
const BLOCK_END = '# End Omni-Coder Kit — agent files';

const TRADEOFF_WARNING =
    'Agent files đã được thêm vào .gitignore. Clone máy khác sẽ không có rules — cần `omni init` lại.';

function gitignorePath(projectDir) {
    return path.join(projectDir || process.cwd(), '.gitignore');
}

function readGitignore(projectDir) {
    const p = gitignorePath(projectDir);
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf-8');
}

function writeGitignore(projectDir, content) {
    fs.writeFileSync(gitignorePath(projectDir), content, 'utf-8');
}

function hasHideBlock(content) {
    return content.includes(BLOCK_START);
}

/**
 * @param {string} [projectDir]
 * @returns {'visible'|'hidden'}
 */
function getAgentFilesVisibility(projectDir) {
    return hasHideBlock(readGitignore(projectDir)) ? 'hidden' : 'visible';
}

function buildHideBlock() {
    return `${BLOCK_START}\n${AGENT_FILE_PATTERNS.join('\n')}\n${BLOCK_END}\n`;
}

/**
 * Append the hide block if missing. Idempotent.
 * @returns {{ changed: boolean, patterns: string[] }}
 */
function hideAgentFiles(projectDir) {
    const existing = readGitignore(projectDir);
    if (hasHideBlock(existing)) {
        return { changed: false, patterns: [...AGENT_FILE_PATTERNS] };
    }
    if (!existing.trim()) {
        writeGitignore(projectDir, buildHideBlock());
        return { changed: true, patterns: [...AGENT_FILE_PATTERNS] };
    }
    const base = existing.endsWith('\n') ? existing : existing + '\n';
    writeGitignore(projectDir, base + '\n' + buildHideBlock());
    return { changed: true, patterns: [...AGENT_FILE_PATTERNS] };
}

/**
 * Remove the marked hide block if present. Does not touch other omni blocks.
 * @returns {{ changed: boolean }}
 */
function showAgentFiles(projectDir) {
    const existing = readGitignore(projectDir);
    if (!hasHideBlock(existing)) {
        return { changed: false };
    }
    if (!existing.includes(BLOCK_END)) {
        const err = new Error(
            `Khối agent-files trong .gitignore thiếu marker kết thúc "${BLOCK_END}". Sửa thủ công rồi chạy lại.`
        );
        err.code = 'AGENT_FILES_BLOCK_CORRUPT';
        throw err;
    }
    // Remove from BLOCK_START through BLOCK_END (inclusive), plus surrounding blank lines
    const re = new RegExp(
        `(?:\\n)?${escapeRegExp(BLOCK_START)}[\\s\\S]*?${escapeRegExp(BLOCK_END)}\\n?`,
        'g'
    );
    let next = existing.replace(re, '\n');
    next = next.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, '\n');
    if (next.trim() === '') {
        // Keep empty file rather than delete (predictable for tests)
        writeGitignore(projectDir, '');
    } else {
        writeGitignore(projectDir, next.endsWith('\n') ? next : next + '\n');
    }
    return { changed: true };
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Paths from AGENT_FILE_PATTERNS that git currently tracks (best-effort).
 * @returns {string[]}
 */
function listTrackedAgentFiles(projectDir) {
    const cwd = projectDir || process.cwd();
    let out = '';
    try {
        out = execFileSync('git', ['-C', cwd, 'ls-files', '-z', '--', ...AGENT_FILE_PATTERNS], {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch {
        return [];
    }
    if (!out) return [];
    return out.split('\0').filter(Boolean);
}

/**
 * @param {string} projectDir
 * @param {'visible'|'hidden'} visibility
 */
function applyVisibility(projectDir, visibility) {
    if (visibility === 'hidden') return hideAgentFiles(projectDir);
    if (visibility === 'visible') return showAgentFiles(projectDir);
    throw new Error(`Invalid visibility: ${visibility}`);
}

module.exports = {
    AGENT_FILE_PATTERNS,
    BLOCK_START,
    BLOCK_END,
    TRADEOFF_WARNING,
    getAgentFilesVisibility,
    hideAgentFiles,
    showAgentFiles,
    listTrackedAgentFiles,
    applyVisibility,
};
