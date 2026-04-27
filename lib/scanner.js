const fs = require('fs');
const path = require('path');

const IGNORED_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '__pycache__', 'vendor',
    '.next', 'target', '.omni', '.claude', '.codex', '.cursor',
    'coverage', '.nyc_output', '.cache', 'tmp', '.tmp',
]);

const MANIFEST_FILES = {
    'package.json': 'Node.js',
    'pyproject.toml': 'Python',
    'requirements.txt': 'Python',
    'setup.py': 'Python',
    'go.mod': 'Go',
    'Cargo.toml': 'Rust',
    'pom.xml': 'Java',
    'build.gradle': 'Java/Kotlin',
    'Gemfile': 'Ruby',
    'composer.json': 'PHP',
};

function detectExistingProject(dir) {
    const langs = [];
    for (const [file, lang] of Object.entries(MANIFEST_FILES)) {
        if (fs.existsSync(path.join(dir, file))) {
            if (!langs.includes(lang)) langs.push(lang);
        }
    }
    if (langs.length === 0) return { detected: false, stats: { files: 0, dirs: 0 }, lang: '' };

    let files = 0;
    let dirs = 0;
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
            if (entry.isDirectory()) { dirs++; }
            else { files++; }
        }
    } catch {}

    if (fs.existsSync(path.join(dir, 'package.json'))) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
            const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
            if (allDeps.typescript || fs.existsSync(path.join(dir, 'tsconfig.json'))) {
                const idx = langs.indexOf('Node.js');
                if (idx !== -1) langs[idx] = 'TypeScript';
            }
        } catch {}
    }

    return { detected: true, stats: { files, dirs }, lang: langs.join(' + ') };
}

const MAX_DEPTH = 4;
const MAX_LANDMINES = 50;
const SOURCE_EXTENSIONS = new Set([
    '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.kt',
    '.rb', '.php', '.c', '.cpp', '.h', '.cs', '.swift', '.vue', '.svelte',
]);

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

function detectTechStack(dir) {
    const stack = { runtime: null, language: null, framework: null, ui: null, db: null, test: null, queue: null, deploy: null };
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        const has = (n) => n in allDeps;

        stack.runtime = 'Node.js';
        if (has('typescript') || fs.existsSync(path.join(dir, 'tsconfig.json'))) stack.language = 'TypeScript';
        else stack.language = 'JavaScript';

        if (has('next')) stack.framework = 'Next.js';
        else if (has('nuxt')) stack.framework = 'Nuxt';
        else if (has('@nestjs/core')) stack.framework = 'NestJS';
        else if (has('express')) stack.framework = 'Express';
        else if (has('fastify')) stack.framework = 'Fastify';
        else if (has('hono')) stack.framework = 'Hono';

        if (has('react')) stack.ui = (stack.ui ? stack.ui + ' + ' : '') + 'React';
        if (has('vue')) stack.ui = (stack.ui ? stack.ui + ' + ' : '') + 'Vue';
        if (has('svelte')) stack.ui = (stack.ui ? stack.ui + ' + ' : '') + 'Svelte';
        if (has('@angular/core')) stack.ui = (stack.ui ? stack.ui + ' + ' : '') + 'Angular';

        if (has('prisma') || has('@prisma/client')) stack.db = 'Prisma';
        else if (has('mongoose')) stack.db = 'MongoDB (Mongoose)';
        else if (has('typeorm')) stack.db = 'TypeORM';
        else if (has('drizzle-orm')) stack.db = 'Drizzle';
        else if (has('sequelize')) stack.db = 'Sequelize';
        else if (has('@supabase/supabase-js')) stack.db = 'Supabase';

        if (has('jest')) stack.test = 'Jest';
        else if (has('vitest')) stack.test = 'Vitest';
        else if (has('mocha')) stack.test = 'Mocha';
        if (has('@playwright/test')) stack.test = (stack.test ? stack.test + ' + ' : '') + 'Playwright';

        if (has('bullmq') || has('bull')) stack.queue = 'BullMQ';
        if (has('ioredis') || has('redis')) stack.queue = (stack.queue ? stack.queue + ' + ' : '') + 'Redis';

        return stack;
    } catch {}

    if (fs.existsSync(path.join(dir, 'pyproject.toml')) || fs.existsSync(path.join(dir, 'requirements.txt'))) {
        stack.runtime = 'Python';
        stack.language = 'Python';
        try {
            const content = fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf-8');
            if (content.includes('django')) stack.framework = 'Django';
            else if (content.includes('fastapi')) stack.framework = 'FastAPI';
            else if (content.includes('flask')) stack.framework = 'Flask';
            if (content.includes('pytest')) stack.test = 'pytest';
        } catch {}
    }
    if (fs.existsSync(path.join(dir, 'go.mod'))) { stack.runtime = 'Go'; stack.language = 'Go'; }
    if (fs.existsSync(path.join(dir, 'Cargo.toml'))) { stack.runtime = 'Rust'; stack.language = 'Rust'; }
    if (fs.existsSync(path.join(dir, 'pom.xml'))) { stack.runtime = 'JVM'; stack.language = 'Java'; }
    if (fs.existsSync(path.join(dir, 'build.gradle'))) { stack.runtime = 'JVM'; stack.language = 'Java/Kotlin'; }
    if (fs.existsSync(path.join(dir, 'Gemfile'))) { stack.runtime = 'Ruby'; stack.language = 'Ruby'; }

    return stack;
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

function grepLandmines(dir, allFiles) {
    const landmines = [];
    const pattern = /\b(TODO|FIXME|HACK|XXX)\b[:\s]*(.*)/;
    for (const rel of allFiles) {
        if (landmines.length >= MAX_LANDMINES) break;
        const ext = path.extname(rel);
        if (!SOURCE_EXTENSIONS.has(ext)) continue;
        try {
            const lines = fs.readFileSync(path.join(dir, rel), 'utf-8').split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (landmines.length >= MAX_LANDMINES) break;
                const match = lines[i].match(pattern);
                if (match) {
                    landmines.push({ file: rel, line: i + 1, type: match[1], text: match[2].trim().substring(0, 120) });
                }
            }
        } catch {}
    }
    return landmines;
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

function generateMapSkeleton(scan, projectName) {
    const date = new Date().toISOString().split('T')[0];
    const lines = [];

    lines.push(`# Project Map — ${projectName}`);
    lines.push(`> Generated by omni map | ${date} | ${scan.stats.files} files, ${scan.stats.dirs} dirs, ~${scan.stats.loc} LOC`);
    lines.push(`> Last refresh: ${date} | Age: 0 days`);
    lines.push('');

    // Tech Stack
    lines.push('## Tech Stack');
    const ts = scan.techStack;
    const parts = [];
    if (ts.runtime) parts.push(`Runtime: ${ts.runtime}`);
    if (ts.language && ts.language !== ts.runtime) parts.push(`Lang: ${ts.language}`);
    if (ts.framework) parts.push(`Framework: ${ts.framework}`);
    if (ts.ui) parts.push(`UI: ${ts.ui}`);
    if (ts.db) parts.push(`DB: ${ts.db}`);
    if (ts.test) parts.push(`Test: ${ts.test}`);
    if (ts.queue) parts.push(`Queue: ${ts.queue}`);
    lines.push(parts.length > 0 ? parts.join(' | ') : '[No tech stack detected]');
    lines.push('');

    // Structure
    lines.push('## Structure');
    if (scan.structure.length > 0) {
        const dirs = scan.structure.filter(s => s.depth <= 2).sort((a, b) => a.path.localeCompare(b.path));
        for (const dir of dirs) {
            const indent = '  '.repeat(dir.depth);
            lines.push(`${indent}- \`${dir.path}\` (${dir.fileCount} files) [PENDING]`);
        }
    } else {
        lines.push('[No directories found]');
    }
    lines.push('');

    // Entry Points
    lines.push('## Entry Points');
    if (scan.entryPoints.length > 0) {
        for (const ep of scan.entryPoints) {
            lines.push(`- \`${ep.file}\` — ${ep.hint}`);
        }
    } else {
        lines.push('[No entry points detected]');
    }
    lines.push('');

    // CI/CD
    if (scan.ci.length > 0) {
        lines.push('## CI/CD');
        for (const c of scan.ci) {
            lines.push(`- \`${c.file}\` (${c.type})`);
        }
        lines.push('');
    }

    // Conventions
    lines.push('## Conventions');
    const conv = scan.conventions;
    if (conv.linter) lines.push(`- Linter: ${conv.linter}`);
    if (conv.formatter) lines.push(`- Formatter: ${conv.formatter}`);
    if (conv.tsconfig) lines.push('- TypeScript: strict (tsconfig.json)');
    if (conv.editorconfig) lines.push('- EditorConfig: yes');
    if (conv.commitConvention) lines.push(`- Commits: ${conv.commitConvention}`);
    if (!conv.linter && !conv.formatter && !conv.tsconfig) lines.push('[No conventions detected]');
    lines.push('');

    // Key Patterns
    lines.push('## Key Patterns');
    lines.push('[PENDING — AI fills this when running >om:map]');
    lines.push('');

    // Landmines
    lines.push('## Landmines');
    if (scan.landmines.length > 0) {
        const show = scan.landmines.slice(0, 12);
        for (const l of show) {
            lines.push(`- \`${l.file}:${l.line}\` — ${l.type}: ${l.text}`);
        }
        if (scan.landmines.length > 12) {
            lines.push(`- _(showing 12/${scan.landmines.length} — run >om:map for full analysis)_`);
        }
    } else {
        lines.push('[No TODO/FIXME/HACK found]');
    }
    lines.push('');

    // Existing Docs
    lines.push('## Existing Docs');
    if (scan.docs.length > 0) {
        for (const d of scan.docs) {
            if (d.type === 'directory') {
                lines.push(`- \`${d.file}\` (${d.count} files)`);
            } else {
                lines.push(`- \`${d.file}\` (${d.lines} lines)`);
            }
        }
    } else {
        lines.push('[No docs found]');
    }
    lines.push('');

    return lines.join('\n');
}

function parseMapStructure(md) {
    const entries = {};
    const structureMatch = md.match(/## Structure\n([\s\S]*?)(?=\n## )/);
    if (!structureMatch) return entries;
    const lines = structureMatch[1].split('\n').filter(l => l.trim());
    for (const line of lines) {
        const match = line.match(/`([^`]+\/)`\s*(?:\((\d+) files?\))?\s*(.*)$/);
        if (match) {
            entries[match[1]] = { fileCount: match[2] ? parseInt(match[2]) : 0, description: match[3].trim() };
        }
    }
    return entries;
}

function refreshMap(dir) {
    const mapPath = path.join(dir, '.omni', 'knowledge', 'project-map.md');
    if (!fs.existsSync(mapPath)) return null;

    const existingMd = fs.readFileSync(mapPath, 'utf-8');
    const oldEntries = parseMapStructure(existingMd);
    const newScan = scanProject(dir);
    const today = new Date().toISOString().split('T')[0];

    const newDirs = new Set(newScan.structure.filter(s => s.depth <= 2).map(s => s.path));
    const oldDirs = new Set(Object.keys(oldEntries));

    let md = existingMd;

    // Update header
    md = md.replace(/Last refresh: \S+/, `Last refresh: ${today}`);
    md = md.replace(/Age: \d+ days/, 'Age: 0 days');
    const statsMatch = md.match(/\| \d+ files, \d+ dirs, ~\d+ LOC/);
    if (statsMatch) {
        md = md.replace(statsMatch[0], `| ${newScan.stats.files} files, ${newScan.stats.dirs} dirs, ~${newScan.stats.loc} LOC`);
    }

    // Rebuild structure section preserving descriptions
    const structureLines = [];
    const allDirs = new Set([...newDirs, ...oldDirs]);
    const sorted = [...allDirs].sort();
    for (const dirPath of sorted) {
        const scanEntry = newScan.structure.find(s => s.path === dirPath);
        const oldEntry = oldEntries[dirPath];
        const depth = (dirPath.match(/\//g) || []).length - 1;
        const indent = '  '.repeat(Math.max(0, depth));

        if (scanEntry && !oldEntry) {
            structureLines.push(`${indent}- \`${dirPath}\` (${scanEntry.fileCount} files) [NEW]`);
        } else if (!scanEntry && oldEntry) {
            structureLines.push(`${indent}- \`${dirPath}\` [DELETED]`);
        } else if (scanEntry && oldEntry) {
            const desc = oldEntry.description || '[PENDING]';
            structureLines.push(`${indent}- \`${dirPath}\` (${scanEntry.fileCount} files) ${desc}`);
        }
    }

    md = md.replace(/## Structure\n[\s\S]*?(?=\n## )/, `## Structure\n${structureLines.join('\n')}\n`);

    // Update tech stack (overwrite)
    const ts = newScan.techStack;
    const parts = [];
    if (ts.runtime) parts.push(`Runtime: ${ts.runtime}`);
    if (ts.language && ts.language !== ts.runtime) parts.push(`Lang: ${ts.language}`);
    if (ts.framework) parts.push(`Framework: ${ts.framework}`);
    if (ts.ui) parts.push(`UI: ${ts.ui}`);
    if (ts.db) parts.push(`DB: ${ts.db}`);
    if (ts.test) parts.push(`Test: ${ts.test}`);
    if (ts.queue) parts.push(`Queue: ${ts.queue}`);
    const newStack = parts.length > 0 ? parts.join(' | ') : '[No tech stack detected]';
    md = md.replace(/## Tech Stack\n.*?\n/, `## Tech Stack\n${newStack}\n`);

    return md;
}

module.exports = { detectExistingProject, scanProject, generateMapSkeleton, refreshMap, IGNORED_DIRS, MANIFEST_FILES };
