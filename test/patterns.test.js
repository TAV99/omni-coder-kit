const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    sampleSourceFiles,
    classifyNamingCase,
    analyzeFileNaming,
    analyzeFunctionNaming,
    analyzeImportStyle,
    analyzeErrorHandling,
    analyzeTestPatterns,
    analyzeCodePatterns,
    analyzeDeps,
    classifyStructureType,
} = require('../lib/scanner/patterns');

describe('classifyNamingCase', () => {
    it('detects kebab-case', () => {
        assert.equal(classifyNamingCase('my-component.js'), 'kebab-case');
    });

    it('detects camelCase', () => {
        assert.equal(classifyNamingCase('myComponent.ts'), 'camelCase');
    });

    it('detects PascalCase', () => {
        assert.equal(classifyNamingCase('MyComponent.tsx'), 'PascalCase');
    });

    it('detects snake_case', () => {
        assert.equal(classifyNamingCase('my_component.py'), 'snake_case');
    });

    it('detects UPPER_SNAKE', () => {
        assert.equal(classifyNamingCase('MAX_RETRIES.js'), 'UPPER_SNAKE');
    });

    it('returns camelCase for single lowercase word', () => {
        assert.equal(classifyNamingCase('helpers.js'), 'camelCase');
    });

    it('returns unknown for ambiguous names', () => {
        assert.equal(classifyNamingCase('.gitignore'), 'unknown');
    });

    it('returns unknown for empty stem', () => {
        assert.equal(classifyNamingCase('.js'), 'unknown');
    });
});

describe('analyzeFileNaming', () => {
    it('returns majority pattern', () => {
        const files = [
            'src/my-comp.ts', 'src/my-utils.ts', 'src/my-hooks.ts',
            'src/Other.ts',
        ];
        const result = analyzeFileNaming(files);
        assert.equal(result.pattern, 'kebab-case');
    });

    it('returns mixed when no clear majority', () => {
        const files = [
            'src/my-comp.ts', 'src/MyComp.ts', 'src/myComp.ts',
        ];
        const result = analyzeFileNaming(files);
        assert.equal(result.pattern, 'mixed');
    });

    it('handles empty input', () => {
        const result = analyzeFileNaming([]);
        assert.equal(result.pattern, 'unknown');
    });

    it('skips non-source files', () => {
        const files = ['README.md', 'package.json', 'src/app.ts'];
        const result = analyzeFileNaming(files);
        assert.ok(result.breakdown);
    });

    it('skips index files', () => {
        const files = ['index.js', 'index.ts', 'src/helpers.ts'];
        const result = analyzeFileNaming(files);
        assert.ok(!result.breakdown['index']);
    });
});

describe('analyzeFunctionNaming', () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    it('detects camelCase functions', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-test-'));
        fs.writeFileSync(path.join(dir, 'a.js'), 'function handleClick() {}\nconst getData = () => {}');
        const result = analyzeFunctionNaming(dir, ['a.js']);
        assert.equal(result.pattern, 'camelCase');
        fs.rmSync(dir, { recursive: true });
    });

    it('detects PascalCase (class-like)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-test-'));
        fs.writeFileSync(path.join(dir, 'a.js'), 'function MyComponent() {}\nfunction UserProfile() {}');
        const result = analyzeFunctionNaming(dir, ['a.js']);
        assert.equal(result.pattern, 'PascalCase');
        fs.rmSync(dir, { recursive: true });
    });

    it('returns unknown for empty files', () => {
        const result = analyzeFunctionNaming('/nonexistent', []);
        assert.equal(result.pattern, 'unknown');
    });
});

describe('analyzeImportStyle', () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    it('detects ESM imports', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-test-'));
        fs.writeFileSync(path.join(dir, 'a.js'), "import React from 'react';\nimport { useState } from 'react';");
        const result = analyzeImportStyle(dir, ['a.js']);
        assert.equal(result.style, 'esm');
        fs.rmSync(dir, { recursive: true });
    });

    it('detects CJS requires', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-test-'));
        fs.writeFileSync(path.join(dir, 'a.js'), "const fs = require('fs');\nconst path = require('path');");
        const result = analyzeImportStyle(dir, ['a.js']);
        assert.equal(result.style, 'cjs');
        fs.rmSync(dir, { recursive: true });
    });

    it('detects alias prefix', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-test-'));
        fs.writeFileSync(path.join(dir, 'a.js'), "import { db } from '@/lib/db';");
        const result = analyzeImportStyle(dir, ['a.js']);
        assert.equal(result.aliasPrefix, '@/');
        fs.rmSync(dir, { recursive: true });
    });

    it('detects barrel exports', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-test-'));
        fs.writeFileSync(path.join(dir, 'index.ts'), "export { foo } from './foo';");
        const result = analyzeImportStyle(dir, ['index.ts']);
        assert.equal(result.barrelExports, true);
        fs.rmSync(dir, { recursive: true });
    });

    it('returns unknown for empty', () => {
        const result = analyzeImportStyle('/nonexistent', []);
        assert.equal(result.style, 'unknown');
    });
});

describe('analyzeErrorHandling', () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    it('detects try-catch', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'err-test-'));
        fs.writeFileSync(path.join(dir, 'a.js'), 'try {\n  doSomething();\n} catch (e) {}');
        const result = analyzeErrorHandling(dir, ['a.js']);
        assert.equal(result.pattern, 'try-catch');
        fs.rmSync(dir, { recursive: true });
    });

    it('detects custom Error class', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'err-test-'));
        fs.writeFileSync(path.join(dir, 'a.js'), 'class AppError extends Error {}');
        const result = analyzeErrorHandling(dir, ['a.js']);
        assert.equal(result.customErrorClass, true);
        fs.rmSync(dir, { recursive: true });
    });

    it('returns none when no error handling', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'err-test-'));
        fs.writeFileSync(path.join(dir, 'a.js'), 'const x = 1;');
        const result = analyzeErrorHandling(dir, ['a.js']);
        assert.equal(result.pattern, 'none');
        fs.rmSync(dir, { recursive: true });
    });
});

describe('analyzeTestPatterns', () => {
    it('detects colocated tests', () => {
        const files = ['src/app.ts', 'src/app.test.ts', 'src/utils.test.ts'];
        const result = analyzeTestPatterns('/tmp', files);
        assert.equal(result.location, 'colocated');
        assert.ok(result.naming.includes('*.test.*'));
    });

    it('detects separate test dir', () => {
        const files = ['src/app.ts', 'test/app.test.ts', 'test/utils.test.ts'];
        const result = analyzeTestPatterns('/tmp', files);
        assert.equal(result.location, 'separate');
    });

    it('detects spec naming', () => {
        const files = ['src/app.spec.ts'];
        const result = analyzeTestPatterns('/tmp', files);
        assert.ok(result.naming.includes('*.spec.*'));
    });

    it('returns none when no tests', () => {
        const files = ['src/app.ts', 'src/utils.ts'];
        const result = analyzeTestPatterns('/tmp', files);
        assert.equal(result.location, 'none');
    });

    it('detects e2e directory', () => {
        const files = ['src/app.ts', 'e2e/login.test.ts'];
        const result = analyzeTestPatterns('/tmp', files);
        assert.equal(result.e2eDir, 'e2e');
    });
});

describe('analyzeCodePatterns', () => {
    it('returns correct shape', () => {
        const result = analyzeCodePatterns('/tmp', []);
        assert.ok(result.naming);
        assert.ok(result.imports);
        assert.ok(result.errorHandling);
        assert.ok(result.testPatterns);
        assert.ok('files' in result.naming);
        assert.ok('functions' in result.naming);
        assert.ok('style' in result.imports);
        assert.ok('pattern' in result.errorHandling);
        assert.ok('location' in result.testPatterns);
    });
});

describe('analyzeDeps', () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    it('parses Node.js package.json', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-test-'));
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
            dependencies: { react: '^18', next: '^14' },
            devDependencies: { jest: '^29', typescript: '^5' },
        }));
        const result = analyzeDeps(dir);
        assert.equal(result.production, 2);
        assert.equal(result.dev, 2);
        assert.ok(result.notable.some(d => d.startsWith('react@')));
        assert.ok(result.notable.some(d => d.startsWith('next@')));
        fs.rmSync(dir, { recursive: true });
    });

    it('returns empty for missing manifests', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deps-test-'));
        const result = analyzeDeps(dir);
        assert.equal(result.production, 0);
        assert.equal(result.dev, 0);
        assert.equal(result.notable.length, 0);
        fs.rmSync(dir, { recursive: true });
    });
});

describe('classifyStructureType', () => {
    it('detects feature-based', () => {
        const structure = [
            { path: 'src/', depth: 0 },
            { path: 'src/features/', depth: 1 },
            { path: 'src/components/', depth: 1 },
        ];
        assert.equal(classifyStructureType(structure), 'feature-based');
    });

    it('detects layer-based', () => {
        const structure = [
            { path: 'controllers/', depth: 0 },
            { path: 'services/', depth: 0 },
            { path: 'models/', depth: 0 },
            { path: 'routes/', depth: 0 },
            { path: 'utils/', depth: 0 },
            { path: 'config/', depth: 0 },
            { path: 'test/', depth: 0 },
        ];
        assert.equal(classifyStructureType(structure), 'layer-based');
    });

    it('detects monorepo', () => {
        const structure = [
            { path: 'packages/', depth: 0 },
            { path: 'apps/', depth: 0 },
            { path: 'config/', depth: 0 },
            { path: 'docs/', depth: 0 },
        ];
        assert.equal(classifyStructureType(structure), 'monorepo');
    });

    it('detects flat structure', () => {
        const structure = [
            { path: 'src/', depth: 0 },
        ];
        assert.equal(classifyStructureType(structure), 'flat');
    });

    it('returns unknown for ambiguous', () => {
        const structure = Array.from({ length: 20 }, (_, i) => ({ path: `dir${i}/`, depth: 0 }));
        assert.equal(classifyStructureType(structure), 'unknown');
    });
});

describe('sampleSourceFiles', () => {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    it('limits to max samples', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-test-'));
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        const files = [];
        for (let i = 0; i < 50; i++) {
            const rel = `src/file${i}.js`;
            fs.writeFileSync(path.join(dir, rel), `// file ${i}`);
            files.push(rel);
        }
        const result = sampleSourceFiles(dir, files, 5);
        assert.equal(result.length, 5);
        fs.rmSync(dir, { recursive: true });
    });

    it('prioritizes src/ lib/ app/ dirs', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-test-'));
        fs.mkdirSync(path.join(dir, 'other'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'other', 'a.js'), '// a');
        fs.writeFileSync(path.join(dir, 'src', 'b.js'), '// b');
        fs.writeFileSync(path.join(dir, 'lib', 'c.js'), '// c');
        const result = sampleSourceFiles(dir, ['other/a.js', 'src/b.js', 'lib/c.js'], 2);
        assert.ok(result.includes('src/b.js'));
        assert.ok(result.includes('lib/c.js'));
        fs.rmSync(dir, { recursive: true });
    });

    it('skips non-source files', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-test-'));
        fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'readme.md'), '# hi');
        fs.writeFileSync(path.join(dir, 'src', 'data.json'), '{}');
        fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export {}');
        const result = sampleSourceFiles(dir, ['src/readme.md', 'src/data.json', 'src/app.ts'], 10);
        assert.equal(result.length, 1);
        assert.equal(result[0], 'src/app.ts');
        fs.rmSync(dir, { recursive: true });
    });

    it('returns empty for empty input', () => {
        assert.equal(sampleSourceFiles('/tmp', [], 20).length, 0);
    });
});
