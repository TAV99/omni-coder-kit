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

module.exports = { detectExistingProject, IGNORED_DIRS, MANIFEST_FILES };
