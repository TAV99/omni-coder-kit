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

// Build requirements.md + customer-spec.md from a customer spec/Q&A blob via
// a provider's `intake` step. Provider returns a markdown checklist; we
// validate it has at least one `Rn |` row before writing.
//
// Idempotent: if requirements.md already exists, returns its count without
// touching either file (so callers can safely call on resume).
async function buildRequirements({ projectDir, specText, provider, ide = 'claudecode' }) {
    const dir = projectDir || process.cwd();
    fs.mkdirSync(sdlcDir(dir), { recursive: true });

    if (fs.existsSync(requirementsPath(dir))) {
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

    const checklist = extractChecklist(raw) || fallbackChecklist(text);
    const header = `# Requirements — ${path.basename(dir)} (nguồn: customer Q&A / spec)\n\n`;
    fs.writeFileSync(requirementsPath(dir), header + checklist + (checklist.endsWith('\n') ? '' : '\n'), 'utf-8');
    const items = parseRequirements(dir);
    return { path: requirementsPath(dir), count: items.length };
}

// Pull `- [ ] R<id> | …` lines out of an LLM response. Accepts the response
// being prose-wrapped (we keep only checklist rows). Returns null if no
// recognisable row appears.
function extractChecklist(text) {
    if (!text) return null;
    const rows = [];
    for (const line of String(text).split(/\r?\n/)) {
        const trimmed = line.trimEnd();
        if (/^- \[.\]\s*R\d+\b/.test(trimmed)) rows.push(trimmed);
    }
    return rows.length ? rows.join('\n') : null;
}

// Last-resort scaffolding when no provider output exists (offline / dry-run /
// missing intake support). The user is expected to refine the file by hand;
// at minimum we promise a parseable requirements.md so the loop can advance.
function fallbackChecklist(specText) {
    const summary = String(specText).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 5);
    const rows = [];
    let i = 1;
    for (const line of summary) {
        const short = line.replace(/[`*_]/g, '').slice(0, 140);
        if (!short) continue;
        rows.push(`- [ ] R${i} | ${short} | test: agent`);
        i++;
    }
    if (!rows.length) rows.push('- [ ] R1 | (TODO: định nghĩa yêu cầu nguyên tử từ spec) | test: agent');
    return rows.join('\n');
}

module.exports = {
    SDLC_SUBDIR, REQUIREMENTS_FILE, CUSTOMER_SPEC_FILE,
    requirementsPath, customerSpecPath,
    parseRequirements, updateRequirementStatus, buildRequirements,
    extractChecklist, fallbackChecklist,
};
