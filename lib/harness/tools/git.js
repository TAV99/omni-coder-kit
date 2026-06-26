'use strict';

// ---------------------------------------------------------------------------
// Git tools (HARNESS-SPEC-PHASE-2 §2b). All commands route through
// shell.runCommand (inherits the DENY list — `git push` is blocked there).
//
// This module deliberately exposes NO push/deploy. The harness commits as a
// save-point only; publishing is always the user's explicit action.
// ---------------------------------------------------------------------------

const { runCommand: realRun } = require('./shell');

function status(projectDir, { runCommand = realRun } = {}) {
    const r = runCommand('git status --porcelain', { cwd: projectDir, timeoutMs: 30000 });
    const files = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return { clean: files.length === 0, files };
}

function diffStat(projectDir, { runCommand = realRun } = {}) {
    const r = runCommand('git diff --stat', { cwd: projectDir, timeoutMs: 30000 });
    return (r.stdout || '').trim();
}

function commit(projectDir, message, { addAll = false, runCommand = realRun } = {}) {
    if (addAll) runCommand('git add -A', { cwd: projectDir, timeoutMs: 30000 });
    const safeMsg = String(message).replace(/"/g, '\\"');
    const r = runCommand(`git commit -m "${safeMsg}"`, { cwd: projectDir, timeoutMs: 30000 });
    if (r.exitCode !== 0) {
        return { ok: false, sha: null, output: (r.stdout || '') + (r.stderr || '') };
    }
    const sha = (runCommand('git rev-parse HEAD', { cwd: projectDir, timeoutMs: 30000 }).stdout || '').trim();
    return { ok: true, sha };
}

// Used before COOK: stash uncommitted work so the coder starts clean.
function ensureCleanOrStash(projectDir, { runCommand = realRun } = {}) {
    if (status(projectDir, { runCommand }).clean) return { stashed: false };
    runCommand('git stash push -u -m "omni-harness pre-cook"', { cwd: projectDir, timeoutMs: 30000 });
    return { stashed: true };
}

module.exports = { status, diffStat, commit, ensureCleanOrStash };
