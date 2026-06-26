'use strict';

// ---------------------------------------------------------------------------
// P0 Security gate (HARNESS-SPEC-PHASE-2 §2a). Source rules: qa-testing.md P0.
//
// Checks: committed secrets / .env, dangerous code patterns in source, and
// `npm audit` high+ (via injectable runCommand). passed=false on any finding.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const { runCommand: realRun } = require('../tools/shell');

const SKIP_DIRS = new Set(['node_modules', '.git', '.omni', 'dist', 'build', 'coverage', '.next']);
const SCANNABLE = /\.(js|jsx|ts|tsx|vue|svelte|mjs|cjs|json|env|ya?ml|py|rb|php|go|java|sh)$/i;

const SECRET_PATTERNS = [
    { re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, what: 'private key' },
    { re: /AKIA[0-9A-Z]{16}/, what: 'AWS access key id' },
    { re: /(?:api[_-]?key|secret|token|passwd|password)\s*[:=]\s*['"][^'"\s]{12,}['"]/i, what: 'hardcoded credential' },
    { re: /gh[pousr]_[A-Za-z0-9]{30,}/, what: 'GitHub token' },
];

const DANGEROUS_PATTERNS = [
    { re: /\beval\s*\(/, what: 'eval(' },
    { re: /\.innerHTML\s*=/, what: 'innerHTML assignment (XSS risk)' },
    { re: /(?:SELECT|INSERT|UPDATE|DELETE)\b[^;'"`]*['"`]\s*\+\s*\w/i, what: 'string-concatenated SQL' },
];

function walk(dir, depth, acc) {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        if (e.name.startsWith('.git')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1, acc);
        } else if (SCANNABLE.test(e.name) || e.name === '.env') {
            acc.push(full);
        }
    }
}

function scanFiles(projectDir) {
    const findings = [];
    const files = [];
    walk(projectDir, 0, files);
    for (const file of files) {
        const rel = path.relative(projectDir, file);
        if (path.basename(file) === '.env') {
            findings.push(`${rel}: .env present in source tree (đảm bảo đã gitignore, không commit)`);
        }
        let content;
        try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
        if (content.length > 2 * 1024 * 1024) continue; // skip very large/binary-ish
        for (const { re, what } of SECRET_PATTERNS) {
            if (re.test(content)) findings.push(`${rel}: possible ${what}`);
        }
        for (const { re, what } of DANGEROUS_PATTERNS) {
            if (re.test(content)) findings.push(`${rel}: dangerous pattern ${what}`);
        }
    }
    return findings;
}

function runSecurity(projectDir, { runCommand = realRun } = {}) {
    const findings = scanFiles(projectDir);

    // npm audit high+ when a lockfile exists.
    const hasLock = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']
        .some((f) => fs.existsSync(path.join(projectDir, f)));
    if (hasLock && fs.existsSync(path.join(projectDir, 'package.json'))) {
        const r = runCommand('npm audit --audit-level=high', { cwd: projectDir, timeoutMs: 120000 });
        if (r && r.exitCode !== 0 && !r.timedOut) {
            findings.push('npm audit: lỗ hổng mức high+ (chạy `npm audit` để xem chi tiết)');
        }
    }

    return {
        ran: true,
        passed: findings.length === 0,
        output: findings.length ? findings.join('\n') : 'no security findings',
    };
}

module.exports = { runSecurity, scanFiles };
