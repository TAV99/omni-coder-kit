const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── detectExistingProject ──────────────────────────────────────────────────

describe('detectExistingProject', () => {
    const { detectExistingProject } = require(path.join(__dirname, '..', 'lib', 'scanner'));

    it('returns detected:false for empty directory', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-map-'));
        try {
            const result = detectExistingProject(tmp);
            assert.equal(result.detected, false);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('detects Node.js project via package.json', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-map-'));
        try {
            fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
                dependencies: { react: '^18.0.0', express: '^4.18.0' }
            }));
            fs.mkdirSync(path.join(tmp, 'src'));
            fs.writeFileSync(path.join(tmp, 'src', 'index.js'), 'console.log("hi")');
            const result = detectExistingProject(tmp);
            assert.equal(result.detected, true);
            assert.ok(result.stats.files >= 1);
            assert.ok(result.lang.includes('Node.js'));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('detects Python project via pyproject.toml', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-map-'));
        try {
            fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[project]\nname = "myapp"');
            fs.mkdirSync(path.join(tmp, 'app'));
            fs.writeFileSync(path.join(tmp, 'app', 'main.py'), 'print("hi")');
            const result = detectExistingProject(tmp);
            assert.equal(result.detected, true);
            assert.ok(result.lang.includes('Python'));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('detects Go project via go.mod', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-map-'));
        try {
            fs.writeFileSync(path.join(tmp, 'go.mod'), 'module example.com/app\ngo 1.21');
            const result = detectExistingProject(tmp);
            assert.equal(result.detected, true);
            assert.ok(result.lang.includes('Go'));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('detects Rust project via Cargo.toml', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-map-'));
        try {
            fs.writeFileSync(path.join(tmp, 'Cargo.toml'), '[package]\nname = "myapp"');
            const result = detectExistingProject(tmp);
            assert.equal(result.detected, true);
            assert.ok(result.lang.includes('Rust'));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
