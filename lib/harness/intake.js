'use strict';

// ---------------------------------------------------------------------------
// Phase-4 intake — turn a customer spec / Q&A into an immutable requirements
// checklist (SPEC-PHASE-4-ACCEPTANCE-LOOP §2).
//
// Contract:
//   .omni/sdlc/customer-spec.md  ← verbatim copy of input (no paraphrase)
//   .omni/sdlc/requirements.md   ← atomic, verifiable checklist with metadata
//
// The loop only READS these files + flips status; never rewrites their text
// (artifact = hand-off, not paraphrase — orchestration-patterns).
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const { resolveWorkflow } = require('../workflows/resolve');

const SDLC_SUBDIR = path.join('.omni', 'sdlc');
const REQUIREMENTS_FILE = 'requirements.md';
const CUSTOMER_SPEC_FILE = 'customer-spec.md';

function sdlcDir(projectDir) {
    return path.join(projectDir || process.cwd(), SDLC_SUBDIR);
}

function requirementsPath(projectDir) {
    return path.join(sdlcDir(projectDir), REQUIREMENTS_FILE);
}

function customerSpecPath(projectDir) {
    return path.join(sdlcDir(projectDir), CUSTOMER_SPEC_FILE);
}

// Parse `- [ ] R1 | text | test: <cmd|agent>` lines into structured records.
// Tolerant: ignores blank lines, headings, and anything that isn't a checklist
// requirement row. `status`: 'pending' | 'met' | 'failed'.
function parseRequirements(projectDir) {
    const file = requirementsPath(projectDir);
    if (!fs.existsSync(file)) return [];
    const md = fs.readFileSync(file, 'utf-8');
    const out = [];
    for (const raw of md.split(/\r?\n/)) {
        const line = raw.trimEnd();
        if (!line.startsWith('- [')) continue;
        const m = line.match(/^- \[(.)\]\s*(.*)$/);
        if (!m) continue;
        const mark = m[1];
        let body = m[2];
        let status = 'pending';
        if (mark === 'x' || mark === 'X') status = 'met';
        else if (mark === '!') status = 'failed';
        // body example: "R1 | yêu cầu... | test: ./cmd | note: lý do"
        const parts = body.split('|').map((s) => s.trim());
        const idMatch = (parts[0] || '').match(/^(R\d+)/);
        if (!idMatch) continue;
        const id = idMatch[1];
        const text = (parts[1] || '').trim();
        let test = 'agent';
        let note = '';
        for (let i = 2; i < parts.length; i++) {
            const p = parts[i];
            if (/^test\s*:/i.test(p)) test = p.replace(/^test\s*:/i, '').trim() || 'agent';
            else if (/^note\s*:/i.test(p)) note = p.replace(/^note\s*:/i, '').trim();
        }
        out.push({ id, text, test, status, note });
    }
    return out;
}

// Flip a single requirement's status in-place. Preserves all other content.
function updateRequirementStatus(projectDir, id, status, note) {
    const file = requirementsPath(projectDir);
    if (!fs.existsSync(file)) return false;
    const mark = status === 'met' ? 'x' : status === 'failed' ? '!' : ' ';
    const md = fs.readFileSync(file, 'utf-8');
    const re = new RegExp(`^- \\[.\\](\\s*${id}\\b[^\\n]*)$`, 'm');
    if (!re.test(md)) return false;
    const next = md.replace(re, (_, rest) => {
        // Strip any pre-existing "| note: ..." then re-append if note given.
        const cleaned = rest.replace(/\s*\|\s*note\s*:[^|]*$/i, '');
        const tail = note ? ` | note: ${note}` : '';
        return `- [${mark}]${cleaned}${tail}`;
    });
    fs.writeFileSync(file, next, 'utf-8');
    return true;
}

function isDegenerate(items) {
    if (!items || items.length === 0) return true;
    if (items.length <= 1 && items.some(item => /TODO|định nghĩa yêu cầu/i.test(item.text))) return true;
    
    // Check if EVERY item text starts with '#', '>', '---', or is empty/spaces
    const allGarbage = items.every(item => {
        const t = item.text.trim();
        return !t || t.startsWith('#') || t.startsWith('>') || t.startsWith('---') || t.startsWith('***');
    });
    return allGarbage;
}

// Build requirements.md + customer-spec.md from a customer spec/Q&A blob via
// a provider's `intake` step. Provider returns a markdown checklist; we
// validate it has at least one `Rn |` row before writing.
//
// Idempotent: if requirements.md already exists, returns its count without
// touching either file (so callers can safely call on resume), UNLESS force is true
// or the existing file is degenerate.
async function buildRequirements({ projectDir, specText, provider, ide = 'claudecode', force = false }) {
    const dir = projectDir || process.cwd();
    fs.mkdirSync(sdlcDir(dir), { recursive: true });

    const exists = fs.existsSync(requirementsPath(dir));
    let degenerate = false;
    if (exists) {
        const items = parseRequirements(dir);
        degenerate = isDegenerate(items);
    }

    if (exists && !force && !degenerate) {
        const items = parseRequirements(dir);
        return { path: requirementsPath(dir), count: items.length, skipped: 'requirements.md already exists' };
    }

    const text = String(specText || '').trim();
    if (!text) throw new Error('intake: specText rỗng — cần nội dung spec/Q&A');

    // Keep the customer spec verbatim — debate/acceptance reads this as the
    // source-of-truth artifact (no paraphrase between agents).
    fs.writeFileSync(customerSpecPath(dir), text + (text.endsWith('\n') ? '' : '\n'), 'utf-8');

    const workflowPath = resolveWorkflow('intake.md', dir);
    let raw = '';
    if (provider && typeof provider.runStep === 'function') {
        const r = await provider.runStep('intake', { projectDir: dir, workflowPath, sharedBrief: text, ide });
        raw = (r && (r.output || r.summary)) || '';
    }

    const checklist = extractChecklist(raw) || deriveRequirements(dir, text);
    const header = `# Requirements — ${path.basename(dir)} (nguồn: customer Q&A / spec)\n\n`;
    fs.writeFileSync(requirementsPath(dir), header + checklist + (checklist.endsWith('\n') ? '' : '\n'), 'utf-8');
    const items = parseRequirements(dir);
    return { path: requirementsPath(dir), count: items.length };
}

// Pull `- [ ] R<id> | …` lines out of an LLM response. Accepts the response
// being prose-wrapped (we keep only checklist rows). Returns null if no
// recognisable row appears.
//
// Filters out any rows that look like comments, headers, or metadata.
function extractChecklist(text) {
    if (!text) return null;
    const rows = [];
    for (const line of String(text).split(/\r?\n/)) {
        const trimmed = line.trimEnd();
        if (/^- \[.\]\s*R\d+\b/.test(trimmed)) {
            // Ensure the text of the requirement is not degenerate / garbage
            const parts = trimmed.split('|').map(s => s.trim());
            const textContent = parts[1] || '';
            const isGarbage = !textContent || textContent.startsWith('#') || textContent.startsWith('>') || textContent.startsWith('---') || textContent.startsWith('***');
            if (!isGarbage) {
                rows.push(trimmed);
            }
        }
    }
    return rows.length ? rows.join('\n') : null;
}

// Better fallback trích xuất real requirements from design-spec.md or specText
// without header/hr garbage.
function deriveRequirements(projectDir, specText) {
    const dsFile = path.join(sdlcDir(projectDir), 'design-spec.md');
    const rows = [];
    let i = 1;

    // (1) design-spec.md if exists
    if (fs.existsSync(dsFile)) {
        try {
            const dsContent = fs.readFileSync(dsFile, 'utf-8');
            for (const line of dsContent.split(/\r?\n/)) {
                const m = line.trim().match(/^- \[(\w+)\]\s*(.+)$/);
                if (m) {
                    const tag = m[1];
                    const rawText = m[2].replace(/[`*_]/g, '').trim();
                    if (rawText) {
                        const short = rawText.slice(0, 200);
                        rows.push(`- [ ] R${i} | [${tag}] ${short} | test: agent`);
                        i++;
                        if (i > 200) break; // ceiling of 200 items
                    }
                }
            }
        } catch {
            // fallback if read fails
        }
    }

    // (2) fallback to parsing specText if no rows derived from design-spec
    if (rows.length === 0) {
        const lines = String(specText || '').split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            // Filters/discards:
            if (/^#{1,6}\s/.test(trimmed)) continue; // heading
            if (/^>/.test(trimmed)) continue; // blockquote
            if (/^([-*])\1{2,}\s*$/.test(trimmed) || /^\*{3,}\s*$/.test(trimmed)) continue; // horizontal rule (--- or ***)
            if (/^>?\s*\*?\*?(Mục đích|Nguồn|Cập nhật|Commit|Updated|Source|Mục tiêu|Tài liệu)\b/i.test(trimmed)) continue; // metadata
            if (/^\|?[\s|:-]+\|?$/.test(trimmed)) continue; // table separators/borders

            // Select only lines that look like actual requirement bullets, list items, or table rows
            let textContent = '';
            const bulletMatch = trimmed.match(/^\s*[-*+]\s+(.+)$/);
            const numberedMatch = trimmed.match(/^\s*\d+[.)]\s+(.+)$/);
            const tableMatch = trimmed.match(/^\|(.+)\|$/);

            if (bulletMatch) {
                textContent = bulletMatch[1].trim();
            } else if (numberedMatch) {
                textContent = numberedMatch[1].trim();
            } else if (tableMatch) {
                const cells = tableMatch[1].split('|').map(c => c.trim()).filter(Boolean);
                if (cells.length > 0 && !cells.every(c => /^[-:\s]+$/.test(c))) {
                    textContent = cells.join(' | ');
                }
            }

            if (textContent) {
                const short = textContent.replace(/[`*_]/g, '').slice(0, 200).trim();
                if (short) {
                    rows.push(`- [ ] R${i} | ${short} | test: agent`);
                    i++;
                    if (i > 200) break; // ceiling of 200 items
                }
            }
        }
    }

    // (3) last resort fallback guard
    if (rows.length === 0) {
        rows.push('- [ ] R1 | (TODO: định nghĩa yêu cầu nguyên tử từ spec) | test: agent');
    }

    return rows.join('\n');
}

module.exports = {
    SDLC_SUBDIR, REQUIREMENTS_FILE, CUSTOMER_SPEC_FILE,
    requirementsPath, customerSpecPath,
    parseRequirements, updateRequirementStatus, buildRequirements,
    extractChecklist, deriveRequirements, isDegenerate,
};
