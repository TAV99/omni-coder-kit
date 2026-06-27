'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runSecurity } = require('../lib/harness/gates/security');
const { runBundle } = require('../lib/harness/gates/bundle');
const { runContent } = require('../lib/harness/gates/content');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-gate-')); }
function write(dir, rel, body) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body, 'utf-8');
    return f;
}

// --- P0 security -----------------------------------------------------------

test('security: hardcoded credential → fail', () => {
    const dir = tmp();
    write(dir, 'src/config.js', 'const apiKey = "sk_live_abcdef1234567890";\n');
    const r = runSecurity(dir);
    assert.strictEqual(r.passed, false);
    assert.match(r.output, /credential/i);
});

test('security: dangerous pattern eval/innerHTML → fail', () => {
    const dir = tmp();
    write(dir, 'app.js', 'el.innerHTML = userInput;\n');
    const r = runSecurity(dir);
    assert.strictEqual(r.passed, false);
    assert.match(r.output, /innerHTML/);
});

test('security: clean project → pass', () => {
    const dir = tmp();
    write(dir, 'index.js', 'export const sum = (a, b) => a + b;\n');
    const r = runSecurity(dir);
    assert.strictEqual(r.ran, true);
    assert.strictEqual(r.passed, true);
});

test('security: npm audit high+ via injected runner → fail', () => {
    const dir = tmp();
    write(dir, 'package.json', '{"name":"x"}');
    write(dir, 'package-lock.json', '{}');
    write(dir, 'index.js', 'module.exports = 1;\n');
    const failingAudit = () => ({ exitCode: 1, stdout: '', stderr: '', timedOut: false });
    const r = runSecurity(dir, { runCommand: failingAudit });
    assert.strictEqual(r.passed, false);
    assert.match(r.output, /audit/i);
});

// --- P4 bundle (advisory) --------------------------------------------------

test('bundle: no build output → ran:false (skipped)', () => {
    assert.strictEqual(runBundle(tmp()).ran, false);
});

test('bundle: oversized dist → advisory (ran:true, passed:false)', () => {
    const dir = tmp();
    write(dir, 'dist/app.js', 'x'.repeat(2000));
    const r = runBundle(dir, { thresholdBytes: 1000 });
    assert.strictEqual(r.ran, true);
    assert.strictEqual(r.passed, false);
    assert.match(r.output, /vượt ngưỡng/);
});

// --- P5 content ------------------------------------------------------------

test('content: no content-source.md → ran:false', () => {
    assert.strictEqual(runContent(tmp()).ran, false);
});

test('content: forbidden phrase in UI → HIGH, blocks', () => {
    const dir = tmp();
    write(dir, '.omni/sdlc/content-source.md', '## Facts\n- open-source, no pricing\n\n## Forbidden Content\n- pricing tiers\n');
    write(dir, 'src/Page.tsx', 'export const P = () => <div>Our pricing tiers start at $9</div>;\n');
    const r = runContent(dir);
    assert.strictEqual(r.severity, 'HIGH');
    assert.strictEqual(r.passed, false);
    assert.match(r.output, /bị cấm/);
});

test('content: only placeholder → LOW, does not block', () => {
    const dir = tmp();
    write(dir, '.omni/sdlc/content-source.md', '## Forbidden Content\n- fake testimonials\n');
    write(dir, 'index.html', '<p>Lorem ipsum dolor sit amet</p>\n');
    const r = runContent(dir);
    assert.strictEqual(r.severity, 'LOW');
    assert.strictEqual(r.passed, true);
});