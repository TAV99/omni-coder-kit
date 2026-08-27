'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    analyzeWorkspaceCss,
    evaluateAdaptiveVisualQa,
} = require('../lib/dual/visual-qa');
const { parseContract, UiEvidenceSchema } = require('../lib/dual/contracts');

function createTempWorkspace(t) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-visual-qa-test-'));
    t.after(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
    });
    return tmpDir;
}

test('analyzeWorkspaceCss detects responsive media queries, breakpoints, and reduced-motion', (t) => {
    const wsRoot = createTempWorkspace(t);
    const srcDir = path.join(wsRoot, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    const cssContent = `
        .container { display: flex; }
        @media (min-width: 390px) { .container { flex-direction: column; } }
        @media (min-width: 768px) { .container { flex-direction: row; } }
        @media (max-width: 1024px) { .sidebar { display: none; } }
        @media (min-width: 1440px) { .layout { max-width: 1440px; } }
        @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
    `;
    fs.writeFileSync(path.join(srcDir, 'App.css'), cssContent, 'utf8');
    fs.writeFileSync(path.join(srcDir, 'App.tsx'), 'export function App() { return <div className="container">App</div>; }', 'utf8');

    const result = analyzeWorkspaceCss(wsRoot);
    assert.equal(result.hasUiFiles, true);
    assert.equal(result.hasReducedMotion, true);
    assert.equal(result.responsiveRulesCount, 5);
    assert.deepEqual(result.breakpoints, [390, 768, 1024, 1440]);
});

test('Tier 1: evaluateAdaptiveVisualQa generates valid UiEvidenceSchema payload for UI workspace', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const srcDir = path.join(wsRoot, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'style.css'), '@media (min-width: 768px) { body { color: red; } }', 'utf8');

    const qaResult = await evaluateAdaptiveVisualQa({ workspaceRoot: wsRoot });
    assert.equal(qaResult.evidence.runtime_status, 'AVAILABLE');
    assert.equal(qaResult.meta.tier, 'tier1_component');
    assert.equal(qaResult.evidence.viewports.length, 4);
    assert.equal(qaResult.evidence.reduced_motion.passed, true);

    // Verify strict contract validation
    const parsed = parseContract(UiEvidenceSchema, {
        requirement: qaResult.requirement,
        evidence: qaResult.evidence,
    }, 'ui_evidence');
    assert.equal(parsed.requirement.gate_id, 'responsive_visual_qa');
    assert.equal(parsed.evidence.runtime_status, 'AVAILABLE');
});

test('Tier 1: evaluateAdaptiveVisualQa marks non-UI workspace as UNAVAILABLE', async (t) => {
    const wsRoot = createTempWorkspace(t);
    fs.writeFileSync(path.join(wsRoot, 'backend.py'), 'print("hello")', 'utf8');

    const qaResult = await evaluateAdaptiveVisualQa({ workspaceRoot: wsRoot });
    assert.equal(qaResult.evidence.runtime_status, 'UNAVAILABLE');
    assert.ok(qaResult.evidence.reason.includes('No UI'));

    const parsed = parseContract(UiEvidenceSchema, {
        requirement: qaResult.requirement,
        evidence: qaResult.evidence,
    }, 'ui_evidence');
    assert.equal(parsed.evidence.runtime_status, 'UNAVAILABLE');
});

test('Tier 2: evaluateAdaptiveVisualQa runs headless screenshot runner and upgrades tier', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const srcDir = path.join(wsRoot, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'style.css'), 'body { margin: 0; }', 'utf8');

    let runnerCalled = false;
    const mockHeadlessRunner = async ({ viewports }) => {
        runnerCalled = true;
        return {
            success: true,
            screenshots: viewports.map((w) => `.omni/qc/viewport-${w}.png`),
        };
    };

    const qaResult = await evaluateAdaptiveVisualQa({
        workspaceRoot: wsRoot,
        headlessRunner: mockHeadlessRunner,
    });

    assert.equal(runnerCalled, true);
    assert.equal(qaResult.meta.tier, 'tier2_headless_screenshot');
    assert.equal(qaResult.meta.screenshots.length, 4);
    assert.equal(qaResult.evidence.runtime_status, 'AVAILABLE');

    const parsed = parseContract(UiEvidenceSchema, {
        requirement: qaResult.requirement,
        evidence: qaResult.evidence,
    }, 'ui_evidence');
    assert.equal(parsed.evidence.runtime_status, 'AVAILABLE');
});

test('Tier 3: evaluateAdaptiveVisualQa uses live MCP client and gracefully falls back on error', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const srcDir = path.join(wsRoot, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'style.css'), '@media (min-width: 768px) { body { margin: 0; } }', 'utf8');

    // Successful Tier 3
    const mockMcpClientSuccess = {
        captureViewport: async () => ({
            success: true,
            screenshots: ['.omni/qc/obscura-viewport-390.png'],
        }),
    };

    const qaResult = await evaluateAdaptiveVisualQa({
        workspaceRoot: wsRoot,
        mcpClient: mockMcpClientSuccess,
    });
    assert.equal(qaResult.meta.tier, 'tier3_live_mcp');
    assert.equal(qaResult.evidence.runtime_status, 'AVAILABLE');

    // Failed Tier 3 gracefully falls back to Tier 1
    const mockMcpClientFailure = {
        captureViewport: async () => {
            throw new Error('Connection refused to Obscura MCP');
        },
    };

    const fallbackResult = await evaluateAdaptiveVisualQa({
        workspaceRoot: wsRoot,
        mcpClient: mockMcpClientFailure,
    });
    assert.equal(fallbackResult.meta.tier, 'tier1_component');
    assert.equal(fallbackResult.evidence.runtime_status, 'AVAILABLE');
    assert.ok(fallbackResult.meta.reason.includes('Live MCP offline'));

    const parsed = parseContract(UiEvidenceSchema, {
        requirement: fallbackResult.requirement,
        evidence: fallbackResult.evidence,
    }, 'ui_evidence');
    assert.equal(parsed.evidence.runtime_status, 'AVAILABLE');
});
