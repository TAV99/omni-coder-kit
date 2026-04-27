'use strict';

const fs = require('fs');
const path = require('path');
const { IGNORED_DIRS, SOURCE_EXTENSIONS, MAX_DEPTH } = require('./constants');
const { detectTechStack } = require('./detect');
const { grepLandmines } = require('./landmines');

function walkDir(dir, baseDir, depth, maxDepth) {
    if (depth > maxDepth) return { files: 0, dirs: 0, structure: [], allFiles: [] };
    let files = 0;
    let dirs = 0;
    const structure = [];
    const allFiles = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { files: 0, dirs: 0, structure: [], allFiles: [] }; }

    for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(baseDir, fullPath);
        if (entry.isDirectory()) {
            dirs++;
            const sub = walkDir(fullPath, baseDir, depth + 1, maxDepth);
            files += sub.files;
            dirs += sub.dirs;
            structure.push({ path: relPath + '/', depth, fileCount: sub.files });
            allFiles.push(...sub.allFiles);
        } else {
            files++;
            allFiles.push(relPath);
        }
    }
    return { files, dirs, structure, allFiles };
}

function countLOC(dir, allFiles) {
    let loc = 0;
    for (const rel of allFiles) {
        const ext = path.extname(rel);
        if (!SOURCE_EXTENSIONS.has(ext)) continue;
        try {
            const content = fs.readFileSync(path.join(dir, rel), 'utf-8');
            loc += content.split('\n').length;
        } catch {}
    }
    return loc;
}

function detectEntryPoints(dir) {
    const entries = [];
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
        if (pkg.scripts) {
            for (const [name, cmd] of Object.entries(pkg.scripts)) {
                const match = cmd.match(/(?:node|ts-node|tsx|nodemon|npx\s+tsx?)\s+((?!-)\S+)/);
                if (match) entries.push({ file: match[1], type: 'script', hint: `package.json scripts.${name}` });
            }
            if (pkg.main && entries.length === 0) entries.push({ file: pkg.main, type: 'main', hint: 'package.json main' });
        }
    } catch {}
    if (fs.existsSync(path.join(dir, 'Dockerfile'))) {
        try {
            const df = fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf-8');
            const cmdMatch = df.match(/CMD\s+\[?"?(?:node|python3?|go run)\s+(\S+)/m);
            if (cmdMatch) entries.push({ file: cmdMatch[1].replace(/["\]]/g, ''), type: 'docker', hint: 'Dockerfile CMD' });
        } catch {}
    }
    if (fs.existsSync(path.join(dir, 'manage.py'))) {
        entries.push({ file: 'manage.py', type: 'script', hint: 'Django manage.py' });
    }
    const seen = new Set();
    return entries.filter(e => { if (seen.has(e.file)) return false; seen.add(e.file); return true; });
}

function detectCI(dir) {
    const ci = [];
    if (fs.existsSync(path.join(dir, '.github', 'workflows'))) {
        try {
            for (const f of fs.readdirSync(path.join(dir, '.github', 'workflows'))) {
                if (f.endsWith('.yml') || f.endsWith('.yaml'))
                    ci.push({ file: `.github/workflows/${f}`, type: 'github-actions' });
            }
        } catch {}
    }
    if (fs.existsSync(path.join(dir, '.gitlab-ci.yml'))) ci.push({ file: '.gitlab-ci.yml', type: 'gitlab-ci' });
    if (fs.existsSync(path.join(dir, 'Dockerfile'))) ci.push({ file: 'Dockerfile', type: 'docker' });
    if (fs.existsSync(path.join(dir, 'docker-compose.yml')) || fs.existsSync(path.join(dir, 'docker-compose.yaml')))
        ci.push({ file: 'docker-compose.yml', type: 'docker-compose' });
    if (fs.existsSync(path.join(dir, 'vercel.json'))) ci.push({ file: 'vercel.json', type: 'vercel' });
    if (fs.existsSync(path.join(dir, 'fly.toml'))) ci.push({ file: 'fly.toml', type: 'fly' });
    if (fs.existsSync(path.join(dir, 'netlify.toml'))) ci.push({ file: 'netlify.toml', type: 'netlify' });
    return ci;
}

function detectConventions(dir) {
    const conv = { linter: null, formatter: null, tsconfig: false, editorconfig: false, commitConvention: null };
    const eslintPatterns = ['.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', 'eslint.config.js', 'eslint.config.mjs'];
    for (const p of eslintPatterns) { if (fs.existsSync(path.join(dir, p))) { conv.linter = 'eslint'; break; } }
    if (fs.existsSync(path.join(dir, 'biome.json')) || fs.existsSync(path.join(dir, 'biome.jsonc'))) {
        conv.linter = conv.linter ? conv.linter + ' + biome' : 'biome';
        conv.formatter = 'biome';
    }
    const prettierPatterns = ['.prettierrc', '.prettierrc.js', '.prettierrc.json', '.prettierrc.yml', 'prettier.config.js', 'prettier.config.mjs'];
    for (const p of prettierPatterns) { if (fs.existsSync(path.join(dir, p))) { conv.formatter = 'prettier'; break; } }
    conv.tsconfig = fs.existsSync(path.join(dir, 'tsconfig.json'));
    conv.editorconfig = fs.existsSync(path.join(dir, '.editorconfig'));
    if (fs.existsSync(path.join(dir, '.commitlintrc')) || fs.existsSync(path.join(dir, '.commitlintrc.js')) || fs.existsSync(path.join(dir, '.commitlintrc.json')) || fs.existsSync(path.join(dir, 'commitlint.config.js')))
        conv.commitConvention = 'conventional';
    return conv;
}

function detectDocs(dir) {
    const docs = [];
    const docFiles = ['README.md', 'README.rst', 'CONTRIBUTING.md', 'CHANGELOG.md', 'LICENSE'];
    for (const f of docFiles) {
        if (fs.existsSync(path.join(dir, f))) {
            try {
                const lines = fs.readFileSync(path.join(dir, f), 'utf-8').split('\n').length;
                docs.push({ file: f, lines });
            } catch { docs.push({ file: f, lines: 0 }); }
        }
    }
    if (fs.existsSync(path.join(dir, 'docs')) && fs.statSync(path.join(dir, 'docs')).isDirectory()) {
        try {
            const count = fs.readdirSync(path.join(dir, 'docs')).length;
            docs.push({ file: 'docs/', type: 'directory', count });
        } catch {}
    }
    return docs;
}

function scanProject(dir) {
    const walked = walkDir(dir, dir, 0, MAX_DEPTH);
    const loc = countLOC(dir, walked.allFiles);
    return {
        stats: { files: walked.files, dirs: walked.dirs, loc },
        techStack: detectTechStack(dir),
        structure: walked.structure,
        entryPoints: detectEntryPoints(dir),
        docs: detectDocs(dir),
        ci: detectCI(dir),
        conventions: detectConventions(dir),
        landmines: grepLandmines(dir, walked.allFiles),
    };
}

module.exports = { walkDir, countLOC, detectEntryPoints, detectCI, detectConventions, detectDocs, scanProject };
