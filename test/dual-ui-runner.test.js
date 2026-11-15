'use strict';
// F17 phase 1: the daemon-owned browser runner (lib/dual/ui-runner*.js).
// A fake `playwright` in the fixture's node_modules stands in for the browser:
// it really fetches the page from the child's static server, so serving rules
// are exercised, and reports the facts the fixture asks for.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlaywrightUiRunner } = require('../lib/dual/ui-runner');
const { evaluateAdaptiveVisualQa } = require('../lib/dual/visual-qa');

const CHILD = path.join(__dirname, '..', 'lib', 'dual', 'ui-runner-child.js');
const HEX = 'a'.repeat(64);

const FAKE_PLAYWRIGHT = `'use strict';
const fs = require('fs'), http = require('http'), path = require('path');
const root = path.resolve(__dirname, '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'fake-playwright.json'), 'utf8'));
const get = (url) => new Promise((resolve) => http.get(url, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', () => resolve(0)));
module.exports = { chromium: { async launch() {
  if (config.launchError) throw new Error("browserType.launch: Executable doesn't exist at /fake/chrome");
  const requests = [];
  return { async newContext({ viewport, reducedMotion }) { return { async newPage() {
    let url;
    return { on() {}, async goto(target) {
        url = target;
        requests.push({ path: '/', status: await get(target) });
        requests.push({ path: '/.omni/secret.txt', status: await get(new URL('/.omni/secret.txt', target).href) });
      },
      async waitForLoadState() {},
      async evaluate() { return { overflow: config.overflowAt === viewport.width, infinite: reducedMotion === 'reduce' && config.infinite ? 1 : 0 }; },
      async screenshot({ path: file }) {
        if (config.writeOutside) fs.writeFileSync(path.join(root, 'escape.txt'), 'x');
        if (config.mutate) fs.appendFileSync(path.join(root, 'index.html'), '<!-- changed -->');
        fs.writeFileSync(file, 'png-' + viewport.width);
        fs.writeFileSync(path.join(path.dirname(file), 'requests.json'), JSON.stringify(requests));
      } };
  }, async close() {} }; }, async close() {} };
} } };
`;

function fixture(t, config = {}, { playwright = true } = {}) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-ui-runner-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","private":true}\n');
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>x</title><link rel="stylesheet" href="/src/style.css">\n');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'style.css'), 'body{margin:0}@media (prefers-reduced-motion: reduce){*{animation:none}}\n');
    fs.mkdirSync(path.join(root, '.omni', 'runs', 'dual-authority', 'ui'), { recursive: true });
    fs.writeFileSync(path.join(root, '.omni', 'secret.txt'), 'control plane');
    fs.writeFileSync(path.join(root, 'fake-playwright.json'), JSON.stringify(config));
    if (playwright) {
        fs.mkdirSync(path.join(root, 'node_modules', 'playwright'), { recursive: true });
        fs.writeFileSync(path.join(root, 'node_modules', 'playwright', 'index.js'), FAKE_PLAYWRIGHT);
    }
    const artifactDir = path.join(root, '.omni', 'runs', 'dual-authority', 'ui');
    return { root, artifactDir };
}

function runChild(root, artifactDir, viewports = [390, 768]) {
    const r = cp.spawnSync(process.execPath, [CHILD, JSON.stringify({ workspaceRoot: root, viewports, sourceFingerprint: HEX, artifactDir })],
        { encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('the runner child measures every viewport, serves the workspace read-only and writes one screenshot each', (t) => {
    const f = fixture(t);
    const result = runChild(f.root, f.artifactDir);
    assert.equal(result.success, true);
    assert.equal(result.source_fingerprint, HEX);
    assert.deepEqual(result.viewports, [
        { width: 390, horizontal_overflow: false, passed: true },
        { width: 768, horizontal_overflow: false, passed: true },
    ]);
    assert.deepEqual(result.reduced_motion, { tested: true, passed: true });
    assert.deepEqual(result.screenshots.map((shot) => [path.basename(shot.path), shot.width]), [['390.png', 390], ['768.png', 768]]);
    for (const shot of result.screenshots) assert.ok(fs.statSync(shot.path).size > 0);
    const requests = JSON.parse(fs.readFileSync(path.join(f.artifactDir, 'requests.json'), 'utf8'));
    assert.deepEqual(requests.slice(0, 2), [{ path: '/', status: 200 }, { path: '/.omni/secret.txt', status: 404 }]);
});

test('horizontal overflow fails that viewport only', (t) => {
    const f = fixture(t, { overflowAt: 390 });
    const result = runChild(f.root, f.artifactDir);
    assert.deepEqual(result.viewports.map((v) => [v.width, v.horizontal_overflow, v.passed]), [[390, true, false], [768, false, true]]);
});

test('an animation that keeps running under reduced motion fails the reduced-motion run', (t) => {
    const f = fixture(t, { infinite: true });
    assert.deepEqual(runChild(f.root, f.artifactDir).reduced_motion, { tested: true, passed: false });
});

test('a missing Playwright or browser is reported with its exact remedy', (t) => {
    const none = fixture(t, {}, { playwright: false });
    assert.deepEqual(runChild(none.root, none.artifactDir), { success: false, reason: 'Playwright not found in the project (install @playwright/test)' });
    const noBrowser = fixture(t, { launchError: true });
    assert.deepEqual(runChild(noBrowser.root, noBrowser.artifactDir),
        { success: false, reason: 'Playwright browser missing (run: npx playwright install chromium)' });
});

test('the fenced runner writes into a fresh per-run directory and yields AVAILABLE evidence',
    { skip: process.platform !== 'darwin' }, async (t) => {
        const f = fixture(t);
        const runner = createPlaywrightUiRunner();
        const result = await evaluateAdaptiveVisualQa({ workspaceRoot: f.root, viewports: [390, 768], policySha256: HEX,
            sourceFingerprint: 'b'.repeat(64), artifactDir: f.artifactDir, headlessRunner: runner });
        assert.equal(result.evidence.runtime_status, 'AVAILABLE', result.meta.reason);
        assert.equal(result.evidence.artifact_hashes.length, 2);
        const dirs = fs.readdirSync(f.artifactDir).filter((name) => fs.statSync(path.join(f.artifactDir, name)).isDirectory());
        assert.equal(dirs.length, 1);
        assert.ok(result.meta.screenshots.every((shot) => path.dirname(shot.path) === path.join(f.artifactDir, dirs[0])));
    });

test('under the fence a write outside the run directory is denied and no evidence is produced',
    { skip: process.platform !== 'darwin' }, async (t) => {
        const f = fixture(t, { writeOutside: true });
        await assert.rejects(createPlaywrightUiRunner()({ viewports: [390], workspaceRoot: f.root,
            source_fingerprint: HEX, artifactDir: f.artifactDir }), (error) => error.code === 'DUAL_UI_RUNNER_FAILED');
        assert.equal(fs.existsSync(path.join(f.root, 'escape.txt')), false);
    });

test('a UI source change during capture discards the evidence', { skip: process.platform !== 'darwin' }, async (t) => {
    const f = fixture(t, { mutate: true });
    // The fence keeps the child from writing source; let it write here to model a concurrent edit.
    const result = await evaluateAdaptiveVisualQa({ workspaceRoot: f.root, viewports: [390], policySha256: HEX,
        sourceFingerprint: HEX, artifactDir: f.artifactDir,
        headlessRunner: createPlaywrightUiRunner({ env: { ...process.env, OMNI_WORKER_WRITE_FENCE: 'off' } }) });
    assert.equal(result.evidence.runtime_status, 'UNAVAILABLE');
    assert.equal(result.evidence.reason, 'Workspace UI source changed while browser evidence was being captured');
});
