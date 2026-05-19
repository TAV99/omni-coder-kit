'use strict';

const fs = require('fs');
const path = require('path');
const { IGNORED_DIRS, SOURCE_EXTENSIONS, MAX_FILE_SIZE } = require('./constants');

const PRIORITY_DIRS = new Set(['src', 'lib', 'app', 'components', 'pages', 'features', 'modules']);
const MAX_SAMPLE = 20;

function sampleSourceFiles(dir, allFiles, max) {
    const limit = max || MAX_SAMPLE;
    const prioritized = [];
    const rest = [];

    for (const rel of allFiles) {
        const ext = path.extname(rel);
        if (!SOURCE_EXTENSIONS.has(ext)) continue;
        const fullPath = path.join(dir, rel);
        try {
            const stat = fs.statSync(fullPath);
            if (stat.size > MAX_FILE_SIZE) continue;
        } catch { continue; }

        const topDir = rel.split(path.sep)[0];
        if (PRIORITY_DIRS.has(topDir)) {
            prioritized.push(rel);
        } else {
            rest.push(rel);
        }
    }

    const result = [];
    for (const rel of prioritized) {
        if (result.length >= limit) break;
        result.push(rel);
    }
    for (const rel of rest) {
        if (result.length >= limit) break;
        result.push(rel);
    }
    return result;
}

function classifyNamingCase(name) {
    const stem = name.replace(/\.[^.]+$/, '');
    if (!stem || stem.length === 0) return 'unknown';

    if (/^[A-Z][A-Z0-9_]*$/.test(stem)) return 'UPPER_SNAKE';
    if (/^[A-Z][a-zA-Z0-9]*$/.test(stem)) return 'PascalCase';
    if (/^[a-z][a-zA-Z0-9]*$/.test(stem)) return 'camelCase';
    if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(stem)) return 'kebab-case';
    if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(stem)) return 'snake_case';
    if (/^[a-z]+$/.test(stem)) return 'camelCase';

    return 'unknown';
}

function majorityVote(counts) {
    let best = 'unknown';
    let bestCount = 0;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    for (const [key, count] of Object.entries(counts)) {
        if (key === 'unknown') continue;
        if (count > bestCount) { best = key; bestCount = count; }
    }
    if (total > 0 && bestCount < total * 0.6) return 'mixed';
    return best;
}

function analyzeFileNaming(allFiles) {
    const counts = {};
    for (const rel of allFiles) {
        const ext = path.extname(rel);
        if (!SOURCE_EXTENSIONS.has(ext)) continue;
        const base = path.basename(rel);
        if (base.startsWith('.') || base === 'index.js' || base === 'index.ts') continue;
        const c = classifyNamingCase(base);
        counts[c] = (counts[c] || 0) + 1;
    }
    return { pattern: majorityVote(counts), breakdown: counts };
}

function analyzeFunctionNaming(dir, sampledFiles) {
    const counts = {};
    const fnPattern = /(?:function\s+|const\s+|let\s+|var\s+)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:=\s*(?:\(|async\s*\(|function)|[\s(])/g;

    for (const rel of sampledFiles) {
        try {
            const content = fs.readFileSync(path.join(dir, rel), 'utf-8');
            let match;
            while ((match = fnPattern.exec(content)) !== null) {
                const name = match[1];
                if (name.length < 2) continue;
                const c = classifyNamingCase(name);
                counts[c] = (counts[c] || 0) + 1;
            }
        } catch { /* skip unreadable */ }
    }
    return { pattern: majorityVote(counts), breakdown: counts };
}

function analyzeImportStyle(dir, sampledFiles) {
    let esmCount = 0;
    let cjsCount = 0;
    let aliasPrefix = null;
    let barrelExports = false;

    for (const rel of sampledFiles) {
        try {
            const content = fs.readFileSync(path.join(dir, rel), 'utf-8');

            const esmMatches = content.match(/\bimport\s+.*\s+from\s+['"]/g);
            const cjsMatches = content.match(/\brequire\s*\(/g);
            if (esmMatches) esmCount += esmMatches.length;
            if (cjsMatches) cjsCount += cjsMatches.length;

            if (!aliasPrefix) {
                const aliasMatch = content.match(/from\s+['"](@\/|~\/)/);
                if (aliasMatch) aliasPrefix = aliasMatch[1];
            }

            const base = path.basename(rel);
            if ((base === 'index.ts' || base === 'index.js') && /export\s+\{/.test(content)) {
                barrelExports = true;
            }
        } catch { /* skip */ }
    }

    return {
        style: esmCount >= cjsCount ? (esmCount > 0 ? 'esm' : 'unknown') : 'cjs',
        aliasPrefix: aliasPrefix || null,
        barrelExports,
    };
}

function analyzeErrorHandling(dir, sampledFiles) {
    let tryCatchCount = 0;
    let customErrorClass = false;
    let globalHandler = null;

    for (const rel of sampledFiles) {
        try {
            const content = fs.readFileSync(path.join(dir, rel), 'utf-8');

            const tcMatches = content.match(/\btry\s*\{/g);
            if (tcMatches) tryCatchCount += tcMatches.length;

            if (/class\s+\w+Error\s+extends\s+Error/.test(content)) {
                customErrorClass = true;
            }

            if (/\b(errorHandler|globalErrorHandler|handleError)\b/.test(content) ||
                /app\.use\(\s*(?:err|error)\s*,/.test(content)) {
                globalHandler = rel;
            }
        } catch { /* skip */ }
    }

    return {
        pattern: tryCatchCount > 0 ? 'try-catch' : 'none',
        customErrorClass,
        globalHandler,
    };
}

function analyzeTestPatterns(dir, allFiles) {
    let colocatedCount = 0;
    let separateCount = 0;
    const namingSet = new Set();
    let e2eDir = null;
    let coverageConfig = null;

    for (const rel of allFiles) {
        const base = path.basename(rel);
        const dirName = path.dirname(rel).split(path.sep)[0];

        if (/\.test\.[jt]sx?$/.test(base)) {
            namingSet.add('*.test.*');
            if (dirName === 'test' || dirName === 'tests' || dirName === '__tests__') {
                separateCount++;
            } else {
                colocatedCount++;
            }
        } else if (/\.spec\.[jt]sx?$/.test(base)) {
            namingSet.add('*.spec.*');
            if (dirName === 'test' || dirName === 'tests' || dirName === '__tests__') {
                separateCount++;
            } else {
                colocatedCount++;
            }
        } else if (/^test_.*\.py$/.test(base)) {
            namingSet.add('test_*.py');
            separateCount++;
        }

        if (/^e2e\b/.test(rel) || /^cypress\b/.test(rel) || /^playwright\b/.test(rel)) {
            e2eDir = rel.split(path.sep)[0];
        }
    }

    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
        if (pkg.jest && pkg.jest.collectCoverage) coverageConfig = 'jest';
        if (pkg.scripts && pkg.scripts.coverage) coverageConfig = pkg.scripts.coverage.split(/\s/)[0];
    } catch { /* no package.json */ }

    if (fs.existsSync(path.join(dir, 'jest.config.js')) || fs.existsSync(path.join(dir, 'jest.config.ts'))) {
        if (!coverageConfig) coverageConfig = 'jest';
    }
    if (fs.existsSync(path.join(dir, 'vitest.config.js')) || fs.existsSync(path.join(dir, 'vitest.config.ts'))) {
        if (!coverageConfig) coverageConfig = 'vitest';
    }

    return {
        location: colocatedCount >= separateCount ? (colocatedCount > 0 ? 'colocated' : 'none') : 'separate',
        naming: [...namingSet].join(', ') || null,
        e2eDir,
        coverageConfig,
    };
}

function analyzeCodePatterns(dir, allFiles) {
    const sampled = sampleSourceFiles(dir, allFiles);
    return {
        naming: {
            files: analyzeFileNaming(allFiles).pattern,
            functions: analyzeFunctionNaming(dir, sampled).pattern,
        },
        imports: analyzeImportStyle(dir, sampled),
        errorHandling: analyzeErrorHandling(dir, sampled),
        testPatterns: analyzeTestPatterns(dir, allFiles),
    };
}

function analyzeDeps(dir) {
    const result = { production: 0, dev: 0, notable: [] };
    const NOTABLE_KEYS = new Set([
        'react', 'vue', 'svelte', '@angular/core', 'next', 'nuxt',
        'express', 'fastify', 'hono', '@nestjs/core', 'django', 'flask', 'fastapi',
        'prisma', '@prisma/client', 'mongoose', 'typeorm', 'drizzle-orm', 'sequelize',
        'jest', 'vitest', 'mocha', '@playwright/test', 'pytest',
        'tailwindcss', 'typescript', 'vite', 'webpack', 'esbuild',
    ]);

    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            const deps = pkg.dependencies || {};
            const devDeps = pkg.devDependencies || {};
            result.production = Object.keys(deps).length;
            result.dev = Object.keys(devDeps).length;
            const allDeps = { ...deps, ...devDeps };
            for (const [name, ver] of Object.entries(allDeps)) {
                if (NOTABLE_KEYS.has(name)) {
                    result.notable.push(`${name}@${ver}`);
                }
            }
        } catch { /* skip */ }
        return result;
    }

    const pyprojectPath = path.join(dir, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
        try {
            const content = fs.readFileSync(pyprojectPath, 'utf-8');
            const depMatches = content.match(/^\s*"?([a-zA-Z0-9_-]+)/gm);
            if (depMatches) result.production = depMatches.length;
        } catch { /* skip */ }
        return result;
    }

    const cargoPath = path.join(dir, 'Cargo.toml');
    if (fs.existsSync(cargoPath)) {
        try {
            const content = fs.readFileSync(cargoPath, 'utf-8');
            const depSection = content.match(/\[dependencies\]([\s\S]*?)(?:\[|$)/);
            if (depSection) {
                const lines = depSection[1].match(/^[a-zA-Z]/gm);
                if (lines) result.production = lines.length;
            }
        } catch { /* skip */ }
        return result;
    }

    return result;
}

function classifyStructureType(structure) {
    const topDirs = structure
        .filter(s => s.depth === 0 && s.path.endsWith('/'))
        .map(s => s.path.replace(/\/$/, ''));

    const featureDirs = new Set(['features', 'modules', 'domains']);
    const layerDirs = new Set(['controllers', 'services', 'models', 'routes', 'views', 'repositories']);

    const monorepoSignals = topDirs.filter(d => ['packages', 'apps'].includes(d)).length;
    if (monorepoSignals > 0) return 'monorepo';

    const featureHits = topDirs.filter(d => featureDirs.has(d)).length;
    const layerHits = topDirs.filter(d => layerDirs.has(d)).length;

    const srcDirs = structure
        .filter(s => s.path.startsWith('src/') && s.depth === 1 && s.path.endsWith('/'))
        .map(s => s.path.replace(/^src\//, '').replace(/\/$/, ''));

    const srcFeatureHits = srcDirs.filter(d => featureDirs.has(d)).length;
    const srcLayerHits = srcDirs.filter(d => layerDirs.has(d)).length;

    if (featureHits + srcFeatureHits > 0) return 'feature-based';
    if (layerHits + srcLayerHits >= 2) return 'layer-based';
    if (topDirs.length <= 3 && structure.filter(s => s.depth === 0).length <= 10) return 'flat';

    return 'unknown';
}

module.exports = {
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
};
