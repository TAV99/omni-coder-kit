'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_VIEWPORTS = Object.freeze([390, 768, 1024, 1440]);
const UI_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less', '.html', '.tsx', '.jsx', '.vue', '.svelte', '.js', '.ts', '.mjs', '.cjs', '.json']);
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.omni', 'dist', 'build', '.next', 'coverage']);

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function normalizeViewports(viewports) {
    if (!Array.isArray(viewports) || viewports.length === 0 || viewports.length > 10) throw new Error('viewports must contain 1-10 widths');
    const result = viewports.map((width) => {
        if (!Number.isSafeInteger(width) || width < 240 || width > 4096) throw new Error(`Invalid viewport width ${width}`);
        return width;
    });
    if (new Set(result).size !== result.length) throw new Error('viewports cannot contain duplicates');
    return result;
}

/** Scan workspace UI sources for advisory component-level signals. */
function analyzeWorkspaceCss(workspaceRoot, fsImpl = fs) {
    const analysis = { hasUiFiles: false, responsiveRulesCount: 0, hasReducedMotion: false, breakpoints: new Set(), cssFiles: [] };
    if (!fsImpl.existsSync(workspaceRoot)) return analysis;
    function scanDir(dir, depth = 0) {
        if (depth > 8) return;
        let entries = [];
        try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (SKIP_DIRECTORIES.has(entry.name)) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) { scanDir(fullPath, depth + 1); continue; }
            if (!entry.isFile() || !UI_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
            analysis.hasUiFiles = true;
            const ext = path.extname(entry.name).toLowerCase();
            analysis.cssFiles.push(path.relative(workspaceRoot, fullPath).replace(/\\/g, '/'));
            try {
                const content = fsImpl.readFileSync(fullPath, 'utf8');
                if (['.css', '.scss', '.sass', '.less', '.html', '.tsx', '.jsx'].includes(ext)) {
                    analysis.responsiveRulesCount += (content.match(/@media[^{}]*\{/gi) || []).length;
                    if (/prefers-reduced-motion/i.test(content)) analysis.hasReducedMotion = true;
                    for (const wm of content.match(/(?:min|max)-width\s*:\s*(\d+)px/gi) || []) {
                        const digits = wm.match(/\d+/); if (digits) analysis.breakpoints.add(parseInt(digits[0], 10));
                    }
                }
            } catch { /* advisory scan only */ }
        }
    }
    scanDir(workspaceRoot);
    analysis.cssFiles.sort();
    return { ...analysis, breakpoints: Array.from(analysis.breakpoints).sort((a, b) => a - b) };
}

function collectUiSourceEntries(workspaceRoot, fsImpl = fs) {
    const files = [];
    function walk(dir, depth = 0) {
        if (depth > 8) return;
        let entries; try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            if (SKIP_DIRECTORIES.has(entry.name)) continue;
            const absolute = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(absolute, depth + 1); continue; }
            if (!entry.isFile() || !UI_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
            try { files.push({ path: path.relative(workspaceRoot, absolute).replace(/\\/g, '/'), sha256: sha256(fsImpl.readFileSync(absolute)) }); } catch {}
        }
    }
    walk(workspaceRoot); files.sort((a, b) => a.path.localeCompare(b.path)); return files;
}

function computeUiSourceFingerprint(workspaceRoot, fsImpl = fs) { return sha256(JSON.stringify(collectUiSourceEntries(workspaceRoot, fsImpl))); }

function isSafeArtifactPath(workspaceRoot, artifactPath, fsImpl = fs) {
    if (typeof artifactPath !== 'string' || artifactPath.trim() === '') return false;
    if (/^(data:|blob:)/i.test(artifactPath)) return false;
    const absolute = path.isAbsolute(artifactPath) ? path.normalize(artifactPath) : path.resolve(workspaceRoot, artifactPath);
    const relative = path.relative(path.resolve(workspaceRoot), absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    try {
        const realRoot = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(workspaceRoot) : fsImpl.realpathSync(workspaceRoot);
        const realArtifact = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(absolute) : fsImpl.realpathSync(absolute);
        const realRelative = path.relative(realRoot, realArtifact);
        if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) return false;
        const stat = fsImpl.statSync(realArtifact);
        return stat.isFile() && stat.size > 0;
    } catch { return false; }
}

function validateRuntimeResult(result, { workspaceRoot, viewports, sourceFingerprint, fsImpl }) {
    if (!result || typeof result !== 'object' || result.success !== true) return { ok: false, reason: 'Browser adapter did not report success' };
    if ((result.source_fingerprint || result.input_fingerprint) !== sourceFingerprint) return { ok: false, reason: 'Browser evidence source fingerprint is missing or stale' };
    const measured = result.viewports || result.measurements;
    if (!Array.isArray(measured) || measured.length !== viewports.length) return { ok: false, reason: 'Browser evidence must include one measurement for every requested viewport' };
    const seen = new Set(), normalizedViewports = [];
    for (const item of measured) {
        if (!item || typeof item !== 'object' || !Number.isSafeInteger(item.width) || !viewports.includes(item.width) || seen.has(item.width)
            || typeof item.passed !== 'boolean' || typeof item.horizontal_overflow !== 'boolean') return { ok: false, reason: 'Browser viewport measurements are malformed or incomplete' };
        seen.add(item.width); normalizedViewports.push({ width: item.width, passed: item.passed, horizontal_overflow: item.horizontal_overflow });
    }
    if (seen.size !== viewports.length) return { ok: false, reason: 'Browser viewport measurements omit a requested width' };
    if (!result.reduced_motion || result.reduced_motion.tested !== true || result.reduced_motion.passed !== true) return { ok: false, reason: 'Browser evidence does not prove a reduced-motion run' };
    if (!Array.isArray(result.screenshots) || result.screenshots.length < viewports.length) return { ok: false, reason: 'Browser evidence must include screenshots for every requested viewport' };
    const artifactWidths = new Set();
    const artifactPaths = new Set();
    for (let index = 0; index < result.screenshots.length; index++) {
        const screenshot = result.screenshots[index];
        const artifact = typeof screenshot === 'string' ? screenshot : screenshot?.path || screenshot?.artifact;
        const artifactWidth = typeof screenshot === 'object' && screenshot ? screenshot.width : viewports[index];
        if (!viewports.includes(artifactWidth) || artifactWidths.has(artifactWidth)) return { ok: false, reason: 'Browser screenshot artifacts must map one-to-one to requested viewports' };
        artifactWidths.add(artifactWidth);
        if (!isSafeArtifactPath(workspaceRoot, artifact, fsImpl)) return { ok: false, reason: 'Browser screenshot artifact is missing, invalid, or outside the workspace' };
        const canonicalArtifact = path.isAbsolute(artifact) ? path.normalize(artifact) : path.resolve(workspaceRoot, artifact);
        let identity = canonicalArtifact;
        try { identity = fsImpl.realpathSync.native ? fsImpl.realpathSync.native(canonicalArtifact) : fsImpl.realpathSync(canonicalArtifact); } catch { return { ok: false, reason: 'Browser screenshot artifact disappeared during validation' }; }
        if (artifactPaths.has(identity)) return { ok: false, reason: 'Browser screenshot artifacts must be unique per viewport' };
        artifactPaths.add(identity);
    }
    if (artifactWidths.size !== viewports.length) return { ok: false, reason: 'Browser screenshot artifacts omit a requested viewport' };
    return { ok: true, viewports: normalizedViewports };
}

/** Runtime browser evidence is the only source of an AVAILABLE UI verdict. */
async function evaluateAdaptiveVisualQa(options = {}) {
    const { workspaceRoot = process.cwd(), fsImpl = fs, viewports = DEFAULT_VIEWPORTS, mcpClient = null, headlessRunner = null } = options;
    const requestedViewports = normalizeViewports(viewports);
    const cssAnalysis = analyzeWorkspaceCss(workspaceRoot, fsImpl);
    const sourceFingerprint = computeUiSourceFingerprint(workspaceRoot, fsImpl);
    const requirement = { gate_id: 'responsive_visual_qa', required: true, reduced_motion_required: true, viewport_widths: [...requestedViewports] };
    const attempts = [], adapters = [];
    if (mcpClient && typeof mcpClient.captureViewport === 'function') adapters.push(['tier3_live_mcp', mcpClient.captureViewport.bind(mcpClient)]);
    if (typeof headlessRunner === 'function') adapters.push(['tier2_headless_screenshot', headlessRunner]);
    for (const [tier, run] of adapters) {
        try {
            const result = await run({ viewports: requestedViewports, workspaceRoot, source_fingerprint: sourceFingerprint });
            const validation = validateRuntimeResult(result, { workspaceRoot, viewports: requestedViewports, sourceFingerprint, fsImpl });
            if (computeUiSourceFingerprint(workspaceRoot, fsImpl) !== sourceFingerprint) {
                attempts.push('Workspace UI source changed while browser evidence was being captured');
                continue;
            }
            if (validation.ok) {
                const evidenceData = { runtime_status: 'AVAILABLE', viewports: validation.viewports, reduced_motion: { tested: true, passed: true } };
                const artifactHashes = result.screenshots.map((shot) => {
                    const artifact = typeof shot === 'string' ? shot : shot?.path || shot?.artifact;
                    try { return sha256(fsImpl.readFileSync(path.isAbsolute(artifact) ? artifact : path.resolve(workspaceRoot, artifact))); } catch { return null; }
                });
                if (artifactHashes.some((hash) => !hash)) { attempts.push('Browser screenshot artifact changed while evidence was being hashed'); continue; }
                return { requirement, evidence: { ...evidenceData, evidence_sha256: sha256(JSON.stringify({ sourceFingerprint, evidenceData, artifactHashes })) },
                    meta: { tier, reason: 'Measured browser runtime evidence verified', source_fingerprint: sourceFingerprint,
                        css_analysis: { has_ui_files: cssAnalysis.hasUiFiles, responsive_rules_count: cssAnalysis.responsiveRulesCount, has_reduced_motion: cssAnalysis.hasReducedMotion, breakpoints: cssAnalysis.breakpoints, css_files_count: cssAnalysis.cssFiles.length }, screenshots: result.screenshots } };
            }
            attempts.push(validation.reason);
        } catch (error) { attempts.push(error.message || 'Browser adapter failed'); }
    }
    const reason = adapters.length ? (attempts.at(-1) || 'Browser runtime evidence unavailable') : 'Browser runtime adapter unavailable; static CSS is advisory only';
    const evidenceData = { runtime_status: 'UNAVAILABLE', reason };
    return { requirement, evidence: { ...evidenceData, evidence_sha256: sha256(JSON.stringify(evidenceData)) },
        meta: { tier: 'runtime_unavailable', reason, source_fingerprint: sourceFingerprint,
            css_analysis: { has_ui_files: cssAnalysis.hasUiFiles, responsive_rules_count: cssAnalysis.responsiveRulesCount, has_reduced_motion: cssAnalysis.hasReducedMotion, breakpoints: cssAnalysis.breakpoints, css_files_count: cssAnalysis.cssFiles.length }, screenshots: [] } };
}

module.exports = { DEFAULT_VIEWPORTS, analyzeWorkspaceCss, collectUiSourceEntries, computeUiSourceFingerprint, evaluateAdaptiveVisualQa, isSafeArtifactPath, validateRuntimeResult };
