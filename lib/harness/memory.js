'use strict';

// ---------------------------------------------------------------------------
// Persistent memory (HARNESS-SPEC-PHASE-2 §2e). Integrates the >om-memo
// knowledge base (.omni/knowledge/knowledge-base.md) into the harness loop:
// lessons matching the files being touched are injected into the shared brief
// before COOK/FIX, and a successful fix appends a new lesson (auto >om-memo).
//
// Entry format (matches templates/workflows/knowledge-learn.md):
//   ## [YYYY-MM-DD] Short title
//   **Scope:** path/to/file.js
//   **Pattern:** what went wrong
//   **Fix:** what solved it
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const KB_REL = path.join('.omni', 'knowledge', 'knowledge-base.md');
const HEADER = '# Knowledge Base — Project Lessons\n> Auto-captured by >om-memo. Max 20 entries — oldest removed when full.\n';
const MAX_ENTRIES = 20;

function kbPath(projectDir) {
    return path.join(projectDir || process.cwd(), KB_REL);
}

// Split a KB document into entries ({ raw, scope }), preserving order.
function parseEntries(content) {
    const parts = content.split(/^## /m).slice(1); // drop header
    return parts.map((p) => {
        const raw = '## ' + p.trimEnd();
        const scopeMatch = raw.match(/^\*\*Scope:\*\*\s*(.+)$/im);
        return { raw, scope: scopeMatch ? scopeMatch[1].trim() : '' };
    });
}

// Return lessons whose Scope mentions any of `files` (by full path or basename).
// `files` empty/omitted → return all lessons (capped). Returns a markdown block
// or '' if none.
function readLessonsFor(projectDir, files = []) {
    const file = kbPath(projectDir);
    if (!fs.existsSync(file)) return '';
    const entries = parseEntries(fs.readFileSync(file, 'utf-8'));
    if (entries.length === 0) return '';

    const wanted = (files || []).filter(Boolean);
    let matched;
    if (wanted.length === 0) {
        matched = entries;
    } else {
        const bases = wanted.map((f) => path.basename(f));
        matched = entries.filter((e) =>
            wanted.some((f) => e.scope.includes(f)) || bases.some((b) => e.scope.includes(b)));
    }
    if (matched.length === 0) return '';
    return '--- Relevant lessons (knowledge-base) ---\n' + matched.map((e) => e.raw).join('\n\n');
}

// Append a lesson, enforcing the 20-entry cap (drop oldest). `lesson` =
// { title, scope, pattern, fix }. Creates the KB with header if absent.
function appendLesson(projectDir, lesson = {}) {
    const file = kbPath(projectDir);
    const { title = 'Lesson', scope = '', pattern = '', fix = '', date = '' } = lesson;
    const entry = `## [${date}] ${title}\n**Scope:** ${scope}\n**Pattern:** ${pattern}\n**Fix:** ${fix}`;

    let content = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : HEADER;
    if (!content.trimEnd().endsWith('---') && !/\n$/.test(content)) content += '\n';
    content = content.trimEnd() + '\n\n' + entry + '\n';

    // Enforce max entries: keep header + last MAX_ENTRIES blocks.
    const entries = parseEntries(content);
    if (entries.length > MAX_ENTRIES) {
        const kept = entries.slice(entries.length - MAX_ENTRIES);
        content = HEADER + '\n' + kept.map((e) => e.raw).join('\n\n') + '\n';
    }

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf-8');
}

module.exports = { readLessonsFor, appendLesson, parseEntries, KB_REL, MAX_ENTRIES };
