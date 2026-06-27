'use strict';

// ---------------------------------------------------------------------------
// P5 Content gate (HARNESS-SPEC-PHASE-2 §2a). Source rules: qa-testing.md P5.
//
// Cross-checks user-facing files against .omni/sdlc/content-source.md:
//  - Forbidden Content pattern present  → HIGH (block)
//  - Placeholder text (Lorem ipsum, …)  → LOW/MEDIUM (advisory)
// ran=false (skipped) when content-source.md is absent. passed=false only on HIGH.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const UI_EXT = /\.(html?|jsx?|tsx?|vue|svelte|md|mdx)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.omni', 'dist', 'build', 'coverage', '.next']);

const PLACEHOLDERS = [
    /lorem ipsum/i,
    /\bJohn Doe\b/,
    /example@(?:email|example)\.com/i,
    /\[Your Name\]/i,
    /\bTBD\b/,
    /\bComing soon\b/i,
];

// Parse a "## Section" block → list of non-empty item lines (line-based: robust
// vs regex end-of-string quirks; JS has no \Z).
function extractSection(md, heading) {
    const headRe = new RegExp(`^##\\s+${heading}\\s*$`, 'i');
    const out = [];
    let inSection = false;
    for (const line of md.split(/\r?\n/)) {
        if (headRe.test(line)) { inSection = true; continue; }
        if (inSection && /^##\s/.test(line)) break; // next section starts
        if (inSection) {
            const item = line.replace(/^[-*]\s+/, '').trim();
            if (item && !item.startsWith('#')) out.push(item);
        }
    }
    return out;
}

function collectUiFiles(dir, depth, acc) {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (e.name.startsWith('.git')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) collectUiFiles(full, depth + 1, acc);
        } else if (UI_EXT.test(e.name)) {
            acc.push(full);
        }
    }
}

function runContent(projectDir) {
    const sourceFile = path.join(projectDir, '.omni', 'sdlc', 'content-source.md');
    if (!fs.existsSync(sourceFile)) {
        return { ran: false, passed: true, output: 'no content-source.md', severity: null };
    }
    const md = fs.readFileSync(sourceFile, 'utf-8');
    const forbidden = extractSection(md, 'Forbidden Content');

    const files = [];
    collectUiFiles(projectDir, 0, files);

    const high = [];
    const low = [];
    for (const file of files) {
        const rel = path.relative(projectDir, file);
        let content;
        try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
        for (const phrase of forbidden) {
            if (phrase.length >= 3 && content.toLowerCase().includes(phrase.toLowerCase())) {
                high.push(`${rel}: chứa nội dung bị cấm — "${phrase}"`);
            }
        }
        for (const re of PLACEHOLDERS) {
            if (re.test(content)) low.push(`${rel}: placeholder ${re.source}`);
        }
    }

    const severity = high.length ? 'HIGH' : (low.length ? 'LOW' : null);
    const lines = [...high, ...low];
    return {
        ran: true,
        passed: high.length === 0, // only HIGH blocks
        output: lines.length ? lines.join('\n') : 'content OK',
        severity,
    };
}

module.exports = { runContent, extractSection };
