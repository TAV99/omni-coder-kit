'use strict';

// F17 phase 1: the daemon's browser measurement, run as a fenced child.
// It serves the workspace read-only on 127.0.0.1 with no transforms (module
// scripts that need a build fail, so the page shows its no-JS state), drives the
// project's own Playwright, and prints one runtime result for
// lib/dual/visual-qa.js#validateRuntimeResult. It writes only screenshots, into
// its artifact directory. Input: one JSON argument.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createRequire } = require('node:module');

const MIME = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
    '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};
const VIEWPORT_HEIGHT = 900;
const PAGE_TIMEOUT_MS = 15_000;

function out(result) { process.stdout.write(`${JSON.stringify(result)}\n`); }
function unavailable(reason) { out({ success: false, reason: String(reason).replace(/\s+/g, ' ').slice(0, 240) }); }

// Playwright comes from the project, never from omni (SPEC-F17 §3.1).
function loadPlaywright(workspaceRoot) {
    const projectRequire = createRequire(path.join(workspaceRoot, 'package.json'));
    for (const name of ['playwright', '@playwright/test']) {
        try { return projectRequire(name); } catch { /* try the next one */ }
    }
    return null;
}

function serve(root) {
    const server = http.createServer((req, res) => {
        let pathname;
        try { pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); } catch { res.writeHead(400).end(); return; }
        if (pathname.endsWith('/')) pathname += 'index.html';
        const file = path.resolve(root, `.${pathname}`);
        // Read-only and inside the workspace; control-plane and dependency trees are not served.
        if (!file.startsWith(root + path.sep) || /(^|[\\/])(\.omni|\.git|node_modules)([\\/]|$)/.test(path.relative(root, file))) {
            res.writeHead(404).end(); return;
        }
        fs.readFile(file, (error, bytes) => {
            if (error) { res.writeHead(404).end(); return; }
            res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
                'cache-control': 'no-store' }).end(bytes);
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function measure({ workspaceRoot, viewports, sourceFingerprint, artifactDir }) {
    const playwright = loadPlaywright(workspaceRoot);
    if (!playwright?.chromium) return unavailable('Playwright not found in the project (install @playwright/test)');
    let browser;
    try { browser = await playwright.chromium.launch({ headless: true }); } catch (error) {
        return unavailable(/Executable doesn't exist|browserType\.launch/i.test(String(error?.message))
            ? 'Playwright browser missing (run: npx playwright install chromium)' : `Browser failed to start: ${error?.message || error}`);
    }
    const server = await serve(workspaceRoot);
    const base = `http://127.0.0.1:${server.address().port}/`;
    try {
        const measured = [], screenshots = [];
        let reducedMotion = { tested: true, passed: true };
        for (const width of viewports) {
            const context = await browser.newContext({ viewport: { width, height: VIEWPORT_HEIGHT }, reducedMotion: 'reduce' });
            const page = await context.newPage();
            const pageErrors = [];
            page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
            try {
                await page.goto(base, { waitUntil: 'load', timeout: PAGE_TIMEOUT_MS });
                await page.waitForLoadState('networkidle', { timeout: PAGE_TIMEOUT_MS }).catch(() => {});
            } catch (error) {
                await context.close();
                return unavailable(`Page failed to load at ${width}px: ${String(error?.message || error).split('\n')[0]}`);
            }
            const facts = await page.evaluate(() => ({
                overflow: document.documentElement.scrollWidth > window.innerWidth,
                // Under reduced motion, nothing may keep animating forever (SPEC-F17 §3.1).
                infinite: document.getAnimations().filter((animation) => animation.playState === 'running'
                    && animation.effect?.getComputedTiming?.().iterations === Infinity).length,
            }));
            const file = path.join(artifactDir, `${width}.png`);
            await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
            measured.push({ width, horizontal_overflow: facts.overflow, passed: !facts.overflow && pageErrors.length === 0,
                ...(pageErrors.length ? { page_errors: pageErrors.slice(0, 3).map((message) => message.slice(0, 200)) } : {}) });
            screenshots.push({ path: file, width });
            if (facts.infinite > 0) reducedMotion = { tested: true, passed: false };
            await context.close();
        }
        out({ success: true, source_fingerprint: sourceFingerprint, viewports: measured, reduced_motion: reducedMotion, screenshots });
    } finally {
        server.close();
        await browser.close().catch(() => {});
    }
}

if (require.main === module) {
    let input;
    try { input = JSON.parse(process.argv[2] || ''); } catch { unavailable('UI runner input is not JSON'); process.exit(0); }
    measure(input).catch((error) => unavailable(`UI runner failed: ${error?.message || error}`)).finally(() => process.exit(0));
}

module.exports = { measure, loadPlaywright };
