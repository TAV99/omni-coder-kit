'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { analyzeWorkspaceCss, computeUiSourceFingerprint, evaluateAdaptiveVisualQa } = require('../lib/dual/visual-qa');
const { parseContract, UiEvidenceSchema } = require('../lib/dual/contracts');
const POLICY_SHA = 'a'.repeat(64);
const SOURCE_SHA = 'b'.repeat(64);
const binding = { policySha256: POLICY_SHA, sourceFingerprint: SOURCE_SHA };

function createTempWorkspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-visual-qa-test-'));
    t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }); return root;
}
function browserEvidence(root, widths, sourceFingerprint = SOURCE_SHA) {
    const screenshots = widths.map((width) => { const file = path.join(root, `.omni-test-viewport-${width}.png`); fs.writeFileSync(file, Buffer.from(`png-${width}`)); return { width, path: file }; });
    return { success: true, source_fingerprint: sourceFingerprint, viewports: widths.map((width) => ({ width, passed: true, horizontal_overflow: false })), reduced_motion: { tested: true, passed: true }, screenshots };
}

test('analyzeWorkspaceCss detects responsive media queries, breakpoints, and reduced-motion', (t) => {
    const root = createTempWorkspace(t); fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src', 'App.css'), '@media (min-width: 390px) {} @media (prefers-reduced-motion: reduce) {}');
    const result = analyzeWorkspaceCss(root); assert.equal(result.hasUiFiles, true); assert.equal(result.hasReducedMotion, true); assert.equal(result.responsiveRulesCount, 2); assert.deepEqual(result.breakpoints, [390]);
});
test('CSS-only evidence is advisory and cannot claim runtime PASS', async (t) => {
    const root = createTempWorkspace(t); fs.writeFileSync(path.join(root, 'style.css'), '@media (min-width: 768px) {}'); const result = await evaluateAdaptiveVisualQa({ workspaceRoot: root, ...binding });
    assert.equal(result.evidence.runtime_status, 'UNAVAILABLE'); assert.match(result.evidence.reason, /static CSS/i); parseContract(UiEvidenceSchema, { requirement: result.requirement, evidence: result.evidence }, 'ui_evidence');
});
test('browser adapter must provide concrete measured artifacts and reduced-motion evidence', async (t) => {
    const root = createTempWorkspace(t); fs.writeFileSync(path.join(root, 'style.css'), 'body{}'); const result = await evaluateAdaptiveVisualQa({ workspaceRoot: root, ...binding, viewports: [360, 768, 1440], headlessRunner: async () => ({ success: true, screenshots: [] }) });
    assert.equal(result.evidence.runtime_status, 'UNAVAILABLE'); assert.match(result.evidence.reason, /fingerprint|screenshot|measurement/i);
});
test('measured headless evidence passes requested 360 viewport and validates contract', async (t) => {
    const root = createTempWorkspace(t); fs.writeFileSync(path.join(root, 'style.css'), 'body{}'); const widths = [360, 768, 1440]; const result = await evaluateAdaptiveVisualQa({ workspaceRoot: root, ...binding, viewports: widths, headlessRunner: async ({ source_fingerprint }) => browserEvidence(root, widths, source_fingerprint) });
    assert.equal(result.meta.tier, 'tier2_headless_screenshot'); assert.equal(result.evidence.runtime_status, 'AVAILABLE'); assert.deepEqual(result.evidence.viewports.map((item) => item.width), widths); parseContract(UiEvidenceSchema, { requirement: result.requirement, evidence: result.evidence }, 'ui_evidence');
});
test('failed live adapter remains unavailable and does not fall back to static PASS', async (t) => {
    const root = createTempWorkspace(t); fs.writeFileSync(path.join(root, 'style.css'), 'body{}'); const result = await evaluateAdaptiveVisualQa({ workspaceRoot: root, ...binding, mcpClient: { captureViewport: async () => ({ success: false }) } }); assert.equal(result.evidence.runtime_status, 'UNAVAILABLE');
});
test('stale source fingerprint invalidates browser result', async (t) => {
    const root = createTempWorkspace(t); fs.writeFileSync(path.join(root, 'app.ts'), 'export const x=1;'); const result = await evaluateAdaptiveVisualQa({ workspaceRoot: root, ...binding, headlessRunner: async ({ source_fingerprint }) => { const evidence = browserEvidence(root, [390, 768, 1024, 1440], source_fingerprint); fs.writeFileSync(path.join(root, 'app.ts'), 'export const x=2;'); return evidence; } }); assert.equal(result.evidence.runtime_status, 'UNAVAILABLE');
});
