'use strict';

// ---------------------------------------------------------------------------
// Project-file SCOPE — the SINGLE source of truth for "what counts as product
// source" (docs/SPEC-FIX-GATE-SCOPE-AND-FIXLOOP.md FIX 1).
//
// Every gate/scan lists files through here, so a finding can ONLY come from
// code the user/agent wrote for the product. Omni's own infrastructure
// (.agents, .omni, .claude …), dependencies and build output are excluded
// once, centrally — no more per-gate SKIP_DIRS drifting apart.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

// Infra / generated / dependency dirs — NOT product code. Excluded everywhere.
const INFRA_DIRS = new Set([
    '.git', 'node_modules', '.agents', '.omni', '.claude', '.codex', '.cursor', '.windsurf',
    'dist', 'build', 'out', '.next', 'coverage', '.turbo', '.cache', 'vendor', '.venv', '__pycache__',
]);

// Parse .gitignore (if any) into a matcher. Intentionally simple (spec §8: no
// full glob engine) — handles the common cases: bare dir/file names, `*.ext`,
// and plain path fragments. Leading `!` (un-ignore) and comments are skipped.
function loadIgnore(projectDir) {
    const file = path.join(projectDir || process.cwd(), '.gitignore');
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/); } catch { /* no .gitignore */ }

    const names = new Set();   // bare dir/file names (no slash, no glob)
    const exts = new Set();    // ".log" from "*.log"
    const fragments = [];      // path substrings (everything else, glob stars stripped)

    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        const p = line.replace(/^\/+/, '').replace(/\/+$/, '');
        if (!p) continue;
        if (/^\*\.[A-Za-z0-9]+$/.test(p)) { exts.add(p.slice(1).toLowerCase()); continue; }
        if (!p.includes('/') && !p.includes('*')) { names.add(p); continue; }
        fragments.push(p.replace(/\*/g, ''));
    }

    return function ignored(relPath) {
        const rel = String(relPath).split(path.sep).join('/');
        const segs = rel.split('/').filter(Boolean);
        const base = segs[segs.length - 1] || '';
        if (segs.some((s) => names.has(s))) return true;
        const dot = base.lastIndexOf('.');
        const ext = dot >= 0 ? base.slice(dot).toLowerCase() : '';
        if (ext && exts.has(ext)) return true;
        if (fragments.some((f) => f && rel.includes(f))) return true;
        return false;
    };
}

// List PRODUCT files: recurse from projectDir, skipping INFRA_DIRS + .gitignore.
// `exts` (array, with or without leading dot) filters by extension; null = all.
// Returns absolute paths.
function listProjectFiles(projectDir, { exts = null, maxDepth = 8 } = {}) {
    const root = projectDir || process.cwd();
    const ignored = loadIgnore(root);
    const extSet = exts ? new Set(exts.map((e) => String(e).toLowerCase().replace(/^\./, ''))) : null;
    const out = [];

    const walk = (dir, depth) => {
        if (depth > maxDepth) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (INFRA_DIRS.has(e.name)) continue;
            const full = path.join(dir, e.name);
            const rel = path.relative(root, full);
            if (ignored(rel)) continue;
            if (e.isDirectory()) {
                walk(full, depth + 1);
            } else if (e.isFile()) {
                if (extSet) {
                    const dot = e.name.lastIndexOf('.');
                    const ext = dot >= 0 ? e.name.slice(dot + 1).toLowerCase() : '';
                    if (!extSet.has(ext)) continue;
                }
                out.push(full);
            }
        }
    };
    walk(root, 0);
    return out;
}

// True if absPath is product source (inside projectDir, not infra, not ignored).
function isProjectFile(projectDir, absPath) {
    const root = projectDir || process.cwd();
    const rel = path.relative(root, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false; // outside the project
    const segs = rel.split(path.sep).filter(Boolean);
    if (segs.some((s) => INFRA_DIRS.has(s))) return false;
    if (loadIgnore(root)(rel.split(path.sep).join('/'))) return false;
    return true;
}

module.exports = { INFRA_DIRS, loadIgnore, listProjectFiles, isProjectFile };
