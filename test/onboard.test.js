const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { buildOnboardReport } = require('../lib/commands/onboard');
const { updateOnboardStatus } = require('../lib/commands/helpers');

function createTestProject(opts = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-test-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
        name: 'test-project',
        dependencies: { react: '^18', next: '^14' },
        devDependencies: { jest: '^29', typescript: '^5' },
    }));
    if (opts.tsconfig) {
        fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    }
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export function main() {}');
    if (opts.test) {
        fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'test', 'app.test.ts'), 'test("it", () => {})');
    }
    return dir;
}

describe('buildOnboardReport', () => {
    let dir;

    before(() => {
        dir = createTestProject({ tsconfig: true, test: true });
    });

    after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns correct JSON structure', () => {
        const scanResult = {
            techStack: { runtime: 'Node.js', language: 'TypeScript', framework: 'Next.js', ui: 'React', db: null, test: 'Jest', queue: null, deploy: null },
            stats: { files: 10, dirs: 3, loc: 500 },
            conventions: { linter: 'eslint', formatter: 'prettier', tsconfig: true, editorconfig: false, commitConvention: null },
            structure: [
                { path: 'src/', depth: 0, fileCount: 5 },
                { path: 'test/', depth: 0, fileCount: 3 },
            ],
            entryPoints: [{ file: 'src/app.ts', type: 'script', hint: 'main' }],
            docs: [{ file: 'README.md', lines: 50 }],
            ci: [{ file: '.github/workflows/ci.yml', type: 'github-actions' }],
            landmines: [
                { tag: 'TO' + 'DO', file: 'src/app.ts', line: 10, text: 'refactor this' },
            ],
        };

        const codePatterns = {
            naming: { files: 'kebab-case', functions: 'camelCase' },
            imports: { style: 'esm', aliasPrefix: '@/', barrelExports: false },
            errorHandling: { pattern: 'try-catch', customErrorClass: false, globalHandler: null },
            testPatterns: { location: 'separate', naming: '*.test.ts', e2eDir: null, coverageConfig: 'jest' },
        };

        const deps = { production: 2, dev: 2, notable: ['react@^18', 'next@^14'] };

        const report = buildOnboardReport(dir, scanResult, codePatterns, deps, 'layer-based');

        assert.equal(report.version, 1);
        assert.ok(report.scannedAt);
        assert.equal(report.project.name, path.basename(dir));
        assert.equal(report.project.root, dir);

        assert.equal(report.techStack.language, 'TypeScript');
        assert.equal(report.techStack.framework, 'Next.js');
        assert.equal(report.stats.files, 10);
        assert.equal(report.stats.loc, 500);

        assert.equal(report.conventions.linter, 'eslint');
        assert.equal(report.codePatterns.naming.files, 'kebab-case');
        assert.equal(report.codePatterns.imports.style, 'esm');

        assert.equal(report.structure.type, 'layer-based');
        assert.ok(Array.isArray(report.structure.keyDirs));
        assert.ok(Array.isArray(report.structure.entryPoints));

        assert.ok(Array.isArray(report.ci));
        assert.ok(Array.isArray(report.docs));

        assert.equal(report.landmines.count, 1);
        assert.ok(report.landmines.topIssues[0].includes('TO' + 'DO'));

        assert.equal(report.deps.production, 2);
        assert.ok(report.deps.notable.includes('react@^18'));
    });

    it('handles empty landmines', () => {
        const scanResult = {
            techStack: {}, stats: { files: 0, dirs: 0, loc: 0 },
            conventions: {}, structure: [], entryPoints: [],
            docs: [], ci: [], landmines: [],
        };
        const report = buildOnboardReport(dir, scanResult, { naming: {}, imports: {}, errorHandling: {}, testPatterns: {} }, { production: 0, dev: 0, notable: [] }, 'flat');
        assert.equal(report.landmines.count, 0);
        assert.equal(report.landmines.topIssues.length, 0);
    });

    it('limits landmines to 10', () => {
        const landmines = Array.from({ length: 20 }, (_, i) => ({
            tag: 'TO' + 'DO', file: 'file' + i + '.ts', line: i, text: 'issue ' + i,
        }));
        const scanResult = {
            techStack: {}, stats: { files: 0, dirs: 0, loc: 0 },
            conventions: {}, structure: [], entryPoints: [],
            docs: [], ci: [], landmines,
        };
        const report = buildOnboardReport(dir, scanResult, { naming: {}, imports: {}, errorHandling: {}, testPatterns: {} }, { production: 0, dev: 0, notable: [] }, 'flat');
        assert.equal(report.landmines.count, 10);
    });
});

describe('updateOnboardStatus', () => {
    it('sets onboard metadata on manifest', () => {
        const manifest = { version: '1.0', skills: { external: [] } };
        const generated = {
            rules: '.omni/rules.md',
            skills: ['.claude/skills/project-test.md'],
        };
        const result = updateOnboardStatus(manifest, generated);
        assert.equal(result.onboard.status, 'completed');
        assert.ok(result.onboard.onboardedAt);
        assert.equal(result.onboard.scanVersion, 1);
        assert.equal(result.onboard.generated.rules, '.omni/rules.md');
    });

    it('handles empty generated', () => {
        const manifest = {};
        const result = updateOnboardStatus(manifest);
        assert.equal(result.onboard.status, 'completed');
        assert.deepEqual(result.onboard.generated, {});
    });

    it('overwrites existing onboard data', () => {
        const manifest = { onboard: { status: 'completed', onboardedAt: '2020-01-01' } };
        const result = updateOnboardStatus(manifest, { rules: '.omni/rules.md' });
        assert.notEqual(result.onboard.onboardedAt, '2020-01-01');
    });
});
