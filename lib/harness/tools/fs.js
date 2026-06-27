'use strict';

// ---------------------------------------------------------------------------
// Scope-locked filesystem tools (HARNESS-SPEC-PHASE-2 §2b).
//
// All paths resolve relative to projectDir and are blocked from escaping it
// (path traversal). writeFileSafe defaults to the .omni/ workspace only —
// writing real project source requires explicit allowOutsideSdlc:true. This
// prevents "write sprawl": the harness touches its own workspace unless a
// caller deliberately opts into editing the project tree.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

function resolveInside(projectDir, relPath) {
    const root = path.resolve(projectDir);
    const target = path.resolve(root, relPath);
    if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(`Path traversal bị chặn: '${relPath}' nằm ngoài projectDir`);
    }
    return { root, target };
}

function isInOmni(root, target) {
    const omni = path.join(root, '.omni');
    return target === omni || target.startsWith(omni + path.sep);
}

function readFileSafe(projectDir, relPath) {
    const { target } = resolveInside(projectDir, relPath);
    return fs.readFileSync(target, 'utf-8');
}

function writeFileSafe(projectDir, relPath, content, { allowOutsideSdlc = false } = {}) {
    const { root, target } = resolveInside(projectDir, relPath);
    if (!allowOutsideSdlc && !isInOmni(root, target)) {
        throw new Error(`Ghi ngoài scope .omni/ bị chặn: '${relPath}' (cần allowOutsideSdlc:true)`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf-8');
}

// Surgical edit: replace first occurrence of `find` with `replace`. Editing
// project source is an explicit action → allowed outside .omni/.
function applyPatch(projectDir, relPath, { find, replace }) {
    const original = readFileSafe(projectDir, relPath);
    if (typeof find !== 'string' || !original.includes(find)) {
        return { changed: false };
    }
    const updated = original.replace(find, replace);
    if (updated === original) return { changed: false };
    writeFileSafe(projectDir, relPath, updated, { allowOutsideSdlc: true });
    return { changed: true };
}

module.exports = { readFileSafe, writeFileSafe, applyPatch, resolveInside };
