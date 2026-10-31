'use strict';

// D10 gitignore patterns (SPEC-SQUAD-P2 §10): runtime state under .omni/ stays
// ignored while .omni/squad/ (roles, skill catalog) is committed. Git cannot
// re-include a path under an ignored directory, so the base pattern must be
// `.omni/*` rather than `.omni/`.

const fs = require('node:fs');
const path = require('node:path');

const OMNI_PATTERNS = Object.freeze(['.omni/*', '!.omni/squad/']);
const LEGACY_PATTERN = '.omni/';
const BLOCK_HEADER = '# Omni-Coder Kit (generated)';

// Replaces a legacy `.omni/` line only inside omni's generated block; a
// user-written `.omni/` elsewhere is left alone and reported.
function migrateLegacyOmniLine(text) {
    const lines = text.split('\n');
    let inBlock = false;
    let migrated = false;
    let userLine = false;
    const out = [];
    for (const line of lines) {
        const trimmed = line.trim();
        // The generated block runs from its header to the next blank line or comment.
        if (trimmed === BLOCK_HEADER) {
            inBlock = true;
            out.push(line);
            continue;
        }
        if (trimmed === '' || trimmed.startsWith('#')) inBlock = false;
        if (trimmed === LEGACY_PATTERN) {
            if (inBlock) {
                out.push(...OMNI_PATTERNS);
                migrated = true;
                continue;
            }
            userLine = true;
        }
        out.push(line);
    }
    return { text: out.join('\n'), migrated, userLine };
}

// Ensures the given patterns (OMNI_PATTERNS first) exist; returns
// { added, migrated, warning }.
function applyGitignore(projectRoot, extraPatterns = [], { fsImpl = fs } = {}) {
    const file = path.join(projectRoot, '.gitignore');
    let text = fsImpl.existsSync(file) ? fsImpl.readFileSync(file, 'utf8') : '';
    const migration = migrateLegacyOmniLine(text);
    text = migration.text;
    const present = new Set(text.split('\n').map((line) => line.trim()));
    const wanted = migration.userLine ? extraPatterns : [...OMNI_PATTERNS, ...extraPatterns];
    const added = wanted.filter((pattern) => !present.has(pattern));
    if (added.length > 0) {
        text = `${text.trimEnd()}${text.trim() ? '\n' : ''}\n${BLOCK_HEADER}\n${added.join('\n')}\n`;
    }
    if (added.length > 0 || migration.migrated) fsImpl.writeFileSync(file, text, 'utf8');
    return {
        added,
        migrated: migration.migrated,
        warning: migration.userLine
            ? `.gitignore có dòng ".omni/" do bạn tự viết; thay bằng "${OMNI_PATTERNS.join('" và "')}" để commit được .omni/squad/`
            : null,
    };
}

module.exports = { OMNI_PATTERNS, LEGACY_PATTERN, BLOCK_HEADER, applyGitignore, migrateLegacyOmniLine };
