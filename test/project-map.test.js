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

// ─── scanProject ────────────────────────────────────────────────────────────

describe('scanProject', () => {
    const { scanProject } = require(path.join(__dirname, '..', 'lib', 'scanner'));

    function makeTmpProject(setup) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-scan-'));
        setup(tmp);
        return tmp;
    }

    it('returns stats with file and dir counts', () => {
        const tmp = makeTmpProject(dir => {
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
                name: 'test-app', scripts: { start: 'node src/index.js' },
                dependencies: { express: '^4.18.0' }
            }));
            fs.mkdirSync(path.join(dir, 'src'));
            fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'const app = require("express")();\napp.listen(3000);\n');
            fs.writeFileSync(path.join(dir, 'src', 'utils.js'), '// util\n');
        });
        try {
            const result = scanProject(tmp);
            assert.ok(result.stats.files >= 3);
            assert.ok(result.stats.dirs >= 1);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('detects tech stack from package.json', () => {
        const tmp = makeTmpProject(dir => {
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
                dependencies: { react: '^18.0.0', next: '^14.0.0' },
                devDependencies: { jest: '^29.0.0', typescript: '^5.0.0' }
            }));
        });
        try {
            const result = scanProject(tmp);
            assert.ok(result.techStack.ui);
            assert.ok(result.techStack.test);
            assert.ok(result.techStack.language.includes('TypeScript'));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('detects entry points from package.json scripts', () => {
        const tmp = makeTmpProject(dir => {
            fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
                scripts: { start: 'node src/server.js', dev: 'nodemon src/server.js' }
            }));
            fs.mkdirSync(path.join(dir, 'src'));
            fs.writeFileSync(path.join(dir, 'src', 'server.js'), '');
        });
        try {
            const result = scanProject(tmp);
            assert.ok(result.entryPoints.length >= 1);
            assert.ok(result.entryPoints.some(e => e.hint.includes('scripts')));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('skips ignored directories', () => {
        const tmp = makeTmpProject(dir => {
            fs.writeFileSync(path.join(dir, 'package.json'), '{}');
            fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), '');
            fs.mkdirSync(path.join(dir, 'src'));
            fs.writeFileSync(path.join(dir, 'src', 'app.js'), '');
        });
        try {
            const result = scanProject(tmp);
            assert.ok(!result.structure.some(s => s.path.includes('node_modules')));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('respects max depth of 4', () => {
        const tmp = makeTmpProject(dir => {
            fs.writeFileSync(path.join(dir, 'package.json'), '{}');
            const deep = path.join(dir, 'a', 'b', 'c', 'd', 'e');
            fs.mkdirSync(deep, { recursive: true });
            fs.writeFileSync(path.join(deep, 'too-deep.js'), '');
        });
        try {
            const result = scanProject(tmp);
            assert.ok(!result.structure.some(s => s.path.includes('e')));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('detects CI/CD configs', () => {
        const tmp = makeTmpProject(dir => {
            fs.writeFileSync(path.join(dir, 'package.json'), '{}');
            fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
            fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'name: CI');
            fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:20');
        });
        try {
            const result = scanProject(tmp);
            assert.ok(result.ci.some(c => c.type === 'github-actions'));
            assert.ok(result.ci.some(c => c.type === 'docker'));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('detects conventions from config files', () => {
        const tmp = makeTmpProject(dir => {
            fs.writeFileSync(path.join(dir, 'package.json'), '{}');
            fs.writeFileSync(path.join(dir, '.eslintrc.json'), '{}');
            fs.writeFileSync(path.join(dir, '.prettierrc'), '{}');
            fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
        });
        try {
            const result = scanProject(tmp);
            assert.equal(result.conventions.linter, 'eslint');
            assert.equal(result.conventions.formatter, 'prettier');
            assert.equal(result.conventions.tsconfig, true);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('detects existing docs', () => {
        const tmp = makeTmpProject(dir => {
            fs.writeFileSync(path.join(dir, 'package.json'), '{}');
            fs.writeFileSync(path.join(dir, 'README.md'), '# Hello\nWorld\n');
            fs.writeFileSync(path.join(dir, 'CONTRIBUTING.md'), '# Contributing\n');
        });
        try {
            const result = scanProject(tmp);
            assert.ok(result.docs.some(d => d.file === 'README.md'));
            assert.ok(result.docs.some(d => d.file === 'CONTRIBUTING.md'));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('greps landmines (TODO/FIXME/HACK)', () => {
        const tmp = makeTmpProject(dir => {
            fs.writeFileSync(path.join(dir, 'package.json'), '{}');
            fs.mkdirSync(path.join(dir, 'src'));
            fs.writeFileSync(path.join(dir, 'src', 'app.js'),
                '// TODO: handle edge case\nconst x = 1;\n// FIXME: race condition\n// HACK: workaround\n');
        });
        try {
            const result = scanProject(tmp);
            assert.ok(result.landmines.length >= 3);
            assert.ok(result.landmines.some(l => l.type === 'TODO'));
            assert.ok(result.landmines.some(l => l.type === 'FIXME'));
            assert.ok(result.landmines.some(l => l.type === 'HACK'));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('caps landmines at 50', () => {
        const tmp = makeTmpProject(dir => {
            fs.writeFileSync(path.join(dir, 'package.json'), '{}');
            fs.mkdirSync(path.join(dir, 'src'));
            const lines = Array.from({ length: 100 }, (_, i) => `// TODO: item ${i}`).join('\n');
            fs.writeFileSync(path.join(dir, 'src', 'big.js'), lines);
        });
        try {
            const result = scanProject(tmp);
            assert.ok(result.landmines.length <= 50);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

// ─── generateMapSkeleton ────────────────────────────────────────────────────

describe('generateMapSkeleton', () => {
    const { scanProject, generateMapSkeleton } = require(path.join(__dirname, '..', 'lib', 'scanner'));

    it('generates markdown with all required sections', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-skel-'));
        try {
            fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
                name: 'test-project',
                scripts: { start: 'node src/index.js' },
                dependencies: { express: '^4.18.0' }
            }));
            fs.mkdirSync(path.join(tmp, 'src'));
            fs.writeFileSync(path.join(tmp, 'src', 'index.js'), '// TODO: setup server\nconst app = require("express")();\n');
            fs.writeFileSync(path.join(tmp, 'README.md'), '# Test\n');

            const scan = scanProject(tmp);
            const md = generateMapSkeleton(scan, 'test-project');

            assert.ok(md.includes('# Project Map'));
            assert.ok(md.includes('## Tech Stack'));
            assert.ok(md.includes('## Structure'));
            assert.ok(md.includes('## Entry Points'));
            assert.ok(md.includes('## Conventions'));
            assert.ok(md.includes('## Key Patterns'));
            assert.ok(md.includes('[PENDING]'));
            assert.ok(md.includes('## Landmines'));
            assert.ok(md.includes('## Existing Docs'));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('includes tech stack info in output', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-skel-'));
        try {
            fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({
                dependencies: { react: '^18.0.0', next: '^14.0.0' },
                devDependencies: { jest: '^29.0.0' }
            }));
            const scan = scanProject(tmp);
            const md = generateMapSkeleton(scan, 'my-app');
            assert.ok(md.includes('React'));
            assert.ok(md.includes('Next.js'));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
