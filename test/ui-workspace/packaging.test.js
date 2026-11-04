'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startUiServer } = require('../../lib/ui/server');

test('T15 packaging: validates all workspace static files are under lib/', () => {
    const staticDir = path.resolve(__dirname, '../../lib/ui/static/workspace');
    assert.ok(fs.existsSync(staticDir), 'lib/ui/static/workspace must exist');

    const expectedFiles = [
        'layout.mjs',
        'store.mjs',
        'theme.mjs',
        'terminals.mjs',
        'timeline.mjs',
        'context-panel.mjs',
        'workspace.mjs',
        'binding-editor.mjs',
        'limits.mjs',
        'tokens.css',
        'shell.css',
        'panes.css',
    ];

    for (const file of expectedFiles) {
        const filePath = path.join(staticDir, file);
        assert.ok(fs.existsSync(filePath), `Static file ${file} must exist under lib/ui/static/workspace`);
    }

    // Check viewers directory
    const viewersDir = path.join(staticDir, 'viewers');
    assert.ok(fs.existsSync(viewersDir));
    const viewerFiles = ['index.mjs', 'text.mjs', 'markdown.mjs', 'html.mjs', 'pdf.mjs', 'docx.mjs'];
    for (const vFile of viewerFiles) {
        assert.ok(fs.existsSync(path.join(viewersDir, vFile)), `Viewer file ${vFile} must exist`);
    }
});

test('T15 packaging: npm pack --dry-run --json verifies clean package structure', () => {
    const pkgRoot = path.resolve(__dirname, '../..');
    const rawOutput = execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: pkgRoot,
        encoding: 'utf8',
    });

    const parsed = JSON.parse(rawOutput);
    assert.ok(Array.isArray(parsed) && parsed.length > 0);
    const tarballInfo = parsed[0];

    assert.equal(tarballInfo.name, 'omni-coder-kit');
    assert.ok(tarballInfo.files && tarballInfo.files.length > 0);

    const paths = tarballInfo.files.map(f => f.path);

    // Verify key files are present in the pack
    assert.ok(paths.some(p => p.startsWith('lib/ui/static/workspace/layout.mjs')));
    assert.ok(paths.some(p => p.startsWith('lib/ui/static/workspace/store.mjs')));
    assert.ok(paths.some(p => p.startsWith('lib/ui/binding-service.js')));
    assert.ok(paths.some(p => p.startsWith('lib/ui/single-session.js')));
    assert.ok(paths.some(p => p.startsWith('lib/ui/limits.js')));

    // Verify tests and test fixtures are NOT packed
    assert.ok(!paths.some(p => p.startsWith('test/')));
    assert.ok(!paths.some(p => p.startsWith('.omni/')));
});

test('T15 packaging: graceful degradation without optional node-pty', async (t) => {
    const tmpDir = path.resolve(__dirname, '../../test/fixtures/empty-project-tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    // Mock unavailable node-pty
    const fakePty = {
        spawnPty: null,
        reason: 'node-pty is not installed on this system',
    };

    const serverInstance = await startUiServer({
        projectRoot: tmpDir,
        port: 0,
        pty: fakePty,
    });
    t.after(() => serverInstance.close());

    assert.ok(serverInstance.port > 0);
    assert.equal(serverInstance.pty.status().available, false);
    assert.equal(serverInstance.pty.status().reason, 'node-pty is not installed on this system');
});
