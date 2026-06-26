'use strict';

// ---------------------------------------------------------------------------
// P4 Bundle gate (HARNESS-SPEC-PHASE-2 §2a) — ADVISORY, never blocks.
//
// Reports build-output size over a soft threshold. ran=false when there is no
// build output to analyze (gate shows 'skipped').
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const DEFAULT_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5 MB soft cap
const OUTPUT_DIRS = ['dist', 'build', '.next', 'out'];

function dirSize(dir, depth = 0) {
    if (depth > 8) return 0;
    let total = 0;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) total += dirSize(full, depth + 1);
        else {
            try { total += fs.statSync(full).size; } catch { /* ignore */ }
        }
    }
    return total;
}

function runBundle(projectDir, { thresholdBytes = DEFAULT_THRESHOLD_BYTES } = {}) {
    const found = OUTPUT_DIRS.map((d) => path.join(projectDir, d)).filter((p) => fs.existsSync(p));
    if (found.length === 0) {
        return { ran: false, passed: true, output: 'no build output to analyze' };
    }
    const total = found.reduce((s, d) => s + dirSize(d), 0);
    const mb = (total / (1024 * 1024)).toFixed(1);
    const over = total > thresholdBytes;
    return {
        ran: true,
        passed: !over, // advisory: pipeline never blocks on P4
        output: over
            ? `bundle ${mb} MB vượt ngưỡng ${(thresholdBytes / (1024 * 1024)).toFixed(0)} MB (advisory)`
            : `bundle ${mb} MB OK`,
    };
}

module.exports = { runBundle, DEFAULT_THRESHOLD_BYTES };
