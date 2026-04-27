# Lib Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split monolithic `lib/scanner.js` into `lib/scanner/` sub-modules with proper manifest parsing, add severity to landmines, consolidate rules into `lib/rules/`, and add hybrid workflow resolution in `lib/workflows/`.

**Architecture:** Monorepo sub-modules under `lib/`. Each sub-directory (`scanner/`, `rules/`, `workflows/`) has an `index.js` re-exporting the public API so `require('../lib/scanner')` resolves to `lib/scanner/index.js` — backward compatible. Old `lib/scanner.js` deleted after migration.

**Tech Stack:** Node.js (CommonJS), `node:test` + `node:assert/strict` for testing, no external test framework.

---

## File Structure

```
lib/
├── scanner/
│   ├── index.js          # Re-export: detectExistingProject, scanProject, generateMapSkeleton, refreshMap, IGNORED_DIRS, MANIFEST_FILES
│   ├── constants.js      # IGNORED_DIRS, SOURCE_EXTENSIONS, MAX_DEPTH, MAX_LANDMINES, MANIFEST_FILES
│   ├── parsers.js        # parseRequirementsTxt, parsePyprojectToml, parseGoMod, parseCargoToml, parseComposerJson, parseGemfile
│   ├── detect.js         # detectExistingProject(), detectTechStack()
│   ├── scan.js           # walkDir(), countLOC(), detectEntryPoints(), detectCI(), detectConventions(), detectDocs(), scanProject()
│   ├── landmines.js      # SEVERITY_MAP, grepLandmines(), groupBySeverity(), formatLandminesForPlan(), formatLandminesForMap()
│   └── map.js            # generateMapSkeleton(), parseMapStructure(), refreshMap()
├── rules/
│   ├── index.js          # Re-export: parseRules, formatMarkdown, formatInject, syncRulesToConfig
│   ├── parse.js          # parseRules(rp)
│   ├── format.js         # formatMarkdown(parsed), formatInject(parsed)
│   └── sync.js           # syncRulesToConfig(findConfigFileFn)
├── workflows/
│   ├── index.js          # Re-export: resolveWorkflow, resolveAllWorkflows, buildWorkflows, getOverlayDir
│   ├── resolve.js        # resolveWorkflow(name, projectDir), resolveAllWorkflows(projectDir)
│   └── build.js          # getOverlayDir(ide, target), buildWorkflows(ide, target)
├── helpers.js            # Reduced — removed buildRulesContent, extractRulesForInject
├── skills.js             # Unchanged
```

```
test/
├── scanner/
│   ├── parsers.test.js   # ~20 cases
│   ├── detect.test.js    # ~10 cases
│   ├── landmines.test.js # ~12 cases
│   └── scan.test.js      # ~5 cases (integration)
├── rules.test.js         # ~10 cases
├── workflows.test.js     # ~6 cases
├── skills.test.js        # Unchanged (43 cases)
├── helpers.test.js       # Existing (unchanged)
├── scan.test.js          # Existing (unchanged)
```

---

### Task 1: Extract `lib/scanner/constants.js`

**Files:**
- Create: `lib/scanner/constants.js`

- [ ] **Step 1: Create `lib/scanner/` directory and `constants.js`**

```js
// lib/scanner/constants.js
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

const MAX_DEPTH = 4;
const MAX_LANDMINES = 50;

const SOURCE_EXTENSIONS = new Set([
    '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.kt',
    '.rb', '.php', '.c', '.cpp', '.h', '.cs', '.swift', '.vue', '.svelte',
]);

module.exports = { IGNORED_DIRS, MANIFEST_FILES, MAX_DEPTH, MAX_LANDMINES, SOURCE_EXTENSIONS };
```

- [ ] **Step 2: Verify syntax**

Run: `node -c lib/scanner/constants.js`
Expected: no output (valid syntax)

- [ ] **Step 3: Commit**

```bash
git add lib/scanner/constants.js
git commit -m "refactor: extract lib/scanner/constants.js from scanner.js"
```

---

### Task 2: Create `lib/scanner/parsers.js` with TDD

**Files:**
- Create: `lib/scanner/parsers.js`
- Create: `test/scanner/parsers.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/scanner/parsers.test.js
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    parseRequirementsTxt,
    parsePyprojectToml,
    parseGoMod,
    parseCargoToml,
    parseComposerJson,
    parseGemfile,
} = require('../../lib/scanner/parsers');

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'parsers-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseRequirementsTxt', () => {
    it('parses simple package names', () => {
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'django==4.2\nflask>=2.0\n');
        const result = parseRequirementsTxt(path.join(tmpDir, 'requirements.txt'));
        assert.deepEqual(result, ['django', 'flask']);
    });

    it('skips comments', () => {
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), '# django tutorial\nflask\n');
        const result = parseRequirementsTxt(path.join(tmpDir, 'requirements.txt'));
        assert.deepEqual(result, ['flask']);
    });

    it('skips blank lines and flags', () => {
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), '\n-r base.txt\n--index-url http://x\nrequests\n');
        const result = parseRequirementsTxt(path.join(tmpDir, 'requirements.txt'));
        assert.deepEqual(result, ['requests']);
    });

    it('handles extras and version specifiers', () => {
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'celery[redis]>=5.0\nuvicorn~=0.20\n');
        const result = parseRequirementsTxt(path.join(tmpDir, 'requirements.txt'));
        assert.deepEqual(result, ['celery', 'uvicorn']);
    });

    it('lowercases names', () => {
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'Django==4.2\nFastAPI\n');
        const result = parseRequirementsTxt(path.join(tmpDir, 'requirements.txt'));
        assert.deepEqual(result, ['django', 'fastapi']);
    });

    it('returns empty for missing file', () => {
        assert.deepEqual(parseRequirementsTxt(path.join(tmpDir, 'nope.txt')), []);
    });

    it('skips -e editable installs', () => {
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), '-e git+https://x.git#egg=y\nflask\n');
        const result = parseRequirementsTxt(path.join(tmpDir, 'requirements.txt'));
        assert.deepEqual(result, ['flask']);
    });
});

describe('parsePyprojectToml', () => {
    it('parses dependencies array', () => {
        const toml = `[project]\nname = "myapp"\ndependencies = [\n  "django>=4.2",\n  "celery[redis]",\n]\n`;
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), toml);
        const result = parsePyprojectToml(path.join(tmpDir, 'pyproject.toml'));
        assert.ok(result.includes('django'));
        assert.ok(result.includes('celery'));
    });

    it('parses optional-dependencies', () => {
        const toml = `[project]\ndependencies = [\n  "flask",\n]\n\n[project.optional-dependencies]\ndev = [\n  "pytest>=7.0",\n  "black",\n]\n`;
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), toml);
        const result = parsePyprojectToml(path.join(tmpDir, 'pyproject.toml'));
        assert.ok(result.includes('flask'));
        assert.ok(result.includes('pytest'));
        assert.ok(result.includes('black'));
    });

    it('returns empty for missing file', () => {
        assert.deepEqual(parsePyprojectToml(path.join(tmpDir, 'nope.toml')), []);
    });
});

describe('parseGoMod', () => {
    it('parses require block', () => {
        const gomod = `module example.com/app\n\ngo 1.21\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgithub.com/gofiber/fiber/v2 v2.50.0\n)\n`;
        fs.writeFileSync(path.join(tmpDir, 'go.mod'), gomod);
        const result = parseGoMod(path.join(tmpDir, 'go.mod'));
        assert.ok(result.includes('github.com/gin-gonic/gin'));
        assert.ok(result.includes('github.com/gofiber/fiber/v2'));
    });

    it('parses single-line require', () => {
        const gomod = `module example.com/app\n\nrequire github.com/gorilla/mux v1.8.0\n`;
        fs.writeFileSync(path.join(tmpDir, 'go.mod'), gomod);
        const result = parseGoMod(path.join(tmpDir, 'go.mod'));
        assert.ok(result.includes('github.com/gorilla/mux'));
    });

    it('returns empty for missing file', () => {
        assert.deepEqual(parseGoMod(path.join(tmpDir, 'nope.mod')), []);
    });
});

describe('parseCargoToml', () => {
    it('parses [dependencies]', () => {
        const cargo = `[package]\nname = "app"\n\n[dependencies]\nactix-web = "4"\ntokio = { version = "1", features = ["full"] }\n`;
        fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), cargo);
        const result = parseCargoToml(path.join(tmpDir, 'Cargo.toml'));
        assert.ok(result.includes('actix-web'));
        assert.ok(result.includes('tokio'));
    });

    it('parses [dev-dependencies]', () => {
        const cargo = `[dependencies]\nserde = "1"\n\n[dev-dependencies]\ncriterion = "0.5"\n`;
        fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), cargo);
        const result = parseCargoToml(path.join(tmpDir, 'Cargo.toml'));
        assert.ok(result.includes('serde'));
        assert.ok(result.includes('criterion'));
    });

    it('returns empty for missing file', () => {
        assert.deepEqual(parseCargoToml(path.join(tmpDir, 'nope.toml')), []);
    });
});

describe('parseComposerJson', () => {
    it('parses require and require-dev', () => {
        const json = JSON.stringify({
            require: { 'laravel/framework': '^10.0', 'php': '>=8.1' },
            'require-dev': { 'phpunit/phpunit': '^10.0' },
        });
        fs.writeFileSync(path.join(tmpDir, 'composer.json'), json);
        const result = parseComposerJson(path.join(tmpDir, 'composer.json'));
        assert.ok(result.includes('laravel/framework'));
        assert.ok(result.includes('phpunit/phpunit'));
    });

    it('returns empty for missing file', () => {
        assert.deepEqual(parseComposerJson(path.join(tmpDir, 'nope.json')), []);
    });
});

describe('parseGemfile', () => {
    it('parses gem declarations', () => {
        fs.writeFileSync(path.join(tmpDir, 'Gemfile'), "source 'https://rubygems.org'\n\ngem 'rails', '~> 7.0'\ngem \"sinatra\"\n");
        const result = parseGemfile(path.join(tmpDir, 'Gemfile'));
        assert.ok(result.includes('rails'));
        assert.ok(result.includes('sinatra'));
    });

    it('skips comments', () => {
        fs.writeFileSync(path.join(tmpDir, 'Gemfile'), "# gem 'old-gem'\ngem 'rspec'\n");
        const result = parseGemfile(path.join(tmpDir, 'Gemfile'));
        assert.deepEqual(result, ['rspec']);
    });

    it('returns empty for missing file', () => {
        assert.deepEqual(parseGemfile(path.join(tmpDir, 'Nope')), []);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/scanner/parsers.test.js`
Expected: FAIL — `Cannot find module '../../lib/scanner/parsers'`

- [ ] **Step 3: Implement `lib/scanner/parsers.js`**

```js
// lib/scanner/parsers.js
const fs = require('fs');

function parseRequirementsTxt(filePath) {
    try {
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        const deps = [];
        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith('#') || line.startsWith('-') || line.startsWith('--')) continue;
            const name = line.split(/[=<>!~\[;@\s]/)[0].trim().toLowerCase();
            if (name) deps.push(name);
        }
        return deps;
    } catch {
        return [];
    }
}

function parsePyprojectToml(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const deps = [];
        const depArrayRegex = /(?:dependencies|dev|test|docs)\s*=\s*\[([\s\S]*?)\]/g;
        let match;
        while ((match = depArrayRegex.exec(content)) !== null) {
            const block = match[1];
            const entries = block.match(/"([^"]+)"|'([^']+)'/g);
            if (entries) {
                for (const entry of entries) {
                    const raw = entry.replace(/["']/g, '');
                    const name = raw.split(/[=<>!~\[;@\s]/)[0].trim().toLowerCase();
                    if (name) deps.push(name);
                }
            }
        }
        return deps;
    } catch {
        return [];
    }
}

function parseGoMod(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const deps = [];
        const blockMatch = content.match(/require\s*\(([\s\S]*?)\)/g);
        if (blockMatch) {
            for (const block of blockMatch) {
                const inner = block.replace(/require\s*\(/, '').replace(/\)/, '');
                for (const line of inner.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('//')) continue;
                    const parts = trimmed.split(/\s+/);
                    if (parts[0]) deps.push(parts[0]);
                }
            }
        }
        const singleLine = content.match(/^require\s+(\S+)\s+\S+/gm);
        if (singleLine) {
            for (const line of singleLine) {
                const parts = line.split(/\s+/);
                if (parts[1]) deps.push(parts[1]);
            }
        }
        return deps;
    } catch {
        return [];
    }
}

function parseCargoToml(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const deps = [];
        const sections = content.split(/^\[/m);
        for (const section of sections) {
            if (!/^(?:dev-)?dependencies\]/.test(section)) continue;
            for (const line of section.split('\n').slice(1)) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) break;
                const nameMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=/);
                if (nameMatch) deps.push(nameMatch[1]);
            }
        }
        return deps;
    } catch {
        return [];
    }
}

function parseComposerJson(filePath) {
    try {
        const pkg = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const deps = [];
        if (pkg.require) deps.push(...Object.keys(pkg.require));
        if (pkg['require-dev']) deps.push(...Object.keys(pkg['require-dev']));
        return deps;
    } catch {
        return [];
    }
}

function parseGemfile(filePath) {
    try {
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        const deps = [];
        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const match = line.match(/^\s*gem\s+['"]([^'"]+)['"]/);
            if (match) deps.push(match[1]);
        }
        return deps;
    } catch {
        return [];
    }
}

module.exports = {
    parseRequirementsTxt,
    parsePyprojectToml,
    parseGoMod,
    parseCargoToml,
    parseComposerJson,
    parseGemfile,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/scanner/parsers.test.js`
Expected: All ~20 cases PASS

- [ ] **Step 5: Commit**

```bash
git add lib/scanner/parsers.js test/scanner/parsers.test.js
git commit -m "feat: add lib/scanner/parsers.js — proper manifest parsing for 6 languages"
```

---

### Task 3: Create `lib/scanner/detect.js` with TDD

**Files:**
- Create: `lib/scanner/detect.js`
- Create: `test/scanner/detect.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/scanner/detect.test.js
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { detectExistingProject, detectTechStack } = require('../../lib/scanner/detect');

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('detectExistingProject', () => {
    it('returns detected=false for empty dir', () => {
        const result = detectExistingProject(tmpDir);
        assert.equal(result.detected, false);
    });

    it('detects Node.js project', () => {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }));
        const result = detectExistingProject(tmpDir);
        assert.equal(result.detected, true);
        assert.ok(result.lang.includes('Node.js'));
    });

    it('detects TypeScript when tsconfig exists', () => {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'test', devDependencies: { typescript: '5.0' } }));
        const result = detectExistingProject(tmpDir);
        assert.ok(result.lang.includes('TypeScript'));
    });

    it('detects Python project', () => {
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask\n');
        const result = detectExistingProject(tmpDir);
        assert.equal(result.detected, true);
        assert.ok(result.lang.includes('Python'));
    });
});

describe('detectTechStack', () => {
    it('detects Node.js with Express', () => {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
            dependencies: { express: '4.18' },
        }));
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.runtime, 'Node.js');
        assert.equal(stack.framework, 'Express');
    });

    it('detects Python with Django via proper parsing (not naive includes)', () => {
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), '# django tutorial notes\nflask>=2.0\n');
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.language, 'Python');
        assert.equal(stack.framework, 'Flask');
        assert.notEqual(stack.framework, 'Django', 'should not match django from comment');
    });

    it('detects Django from actual dependency', () => {
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'django==4.2\ncelery\n');
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.framework, 'Django');
    });

    it('detects Go framework from go.mod', () => {
        fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/app\n\ngo 1.21\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n');
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.language, 'Go');
        assert.equal(stack.framework, 'Gin');
    });

    it('detects Rust framework from Cargo.toml', () => {
        fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "app"\n\n[dependencies]\nactix-web = "4"\ntokio = { version = "1" }\n');
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.language, 'Rust');
        assert.equal(stack.framework, 'Actix');
    });

    it('detects PHP framework from composer.json', () => {
        fs.writeFileSync(path.join(tmpDir, 'composer.json'), JSON.stringify({
            require: { 'php': '>=8.1', 'laravel/framework': '^10.0' },
        }));
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.language, 'PHP');
        assert.equal(stack.framework, 'Laravel');
    });

    it('detects Ruby framework from Gemfile', () => {
        fs.writeFileSync(path.join(tmpDir, 'Gemfile'), "source 'https://rubygems.org'\ngem 'rails', '~> 7.0'\n");
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.language, 'Ruby');
        assert.equal(stack.framework, 'Rails');
    });

    it('detects pytest from requirements.txt', () => {
        fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'pytest>=7.0\nflask\n');
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.test, 'pytest');
    });

    it('returns empty stack for empty dir', () => {
        const stack = detectTechStack(tmpDir);
        assert.equal(stack.runtime, null);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/scanner/detect.test.js`
Expected: FAIL — `Cannot find module '../../lib/scanner/detect'`

- [ ] **Step 3: Implement `lib/scanner/detect.js`**

```js
// lib/scanner/detect.js
const fs = require('fs');
const path = require('path');
const { IGNORED_DIRS, MANIFEST_FILES } = require('./constants');
const {
    parseRequirementsTxt, parsePyprojectToml, parseGoMod,
    parseCargoToml, parseComposerJson, parseGemfile,
} = require('./parsers');

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

    // Python — proper parsing
    const reqPath = path.join(dir, 'requirements.txt');
    const pyprojectPath = path.join(dir, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath) || fs.existsSync(reqPath)) {
        stack.runtime = 'Python';
        stack.language = 'Python';

        const reqDeps = parseRequirementsTxt(reqPath);
        const pyDeps = parsePyprojectToml(pyprojectPath);
        const allPyDeps = new Set([...reqDeps, ...pyDeps]);
        const hasPy = (n) => allPyDeps.has(n);

        if (hasPy('django')) stack.framework = 'Django';
        else if (hasPy('fastapi')) stack.framework = 'FastAPI';
        else if (hasPy('flask')) stack.framework = 'Flask';
        if (hasPy('pytest')) stack.test = 'pytest';
    }

    // Go — proper parsing
    const goModPath = path.join(dir, 'go.mod');
    if (fs.existsSync(goModPath)) {
        stack.runtime = 'Go';
        stack.language = 'Go';
        const goDeps = parseGoMod(goModPath);
        const hasGo = (pattern) => goDeps.some(d => d.includes(pattern));
        if (hasGo('gin-gonic/gin')) stack.framework = 'Gin';
        else if (hasGo('gofiber/fiber')) stack.framework = 'Fiber';
        else if (hasGo('labstack/echo')) stack.framework = 'Echo';
        else if (hasGo('gorilla/mux')) stack.framework = 'Gorilla Mux';
    }

    // Rust — proper parsing
    const cargoPath = path.join(dir, 'Cargo.toml');
    if (fs.existsSync(cargoPath)) {
        stack.runtime = 'Rust';
        stack.language = 'Rust';
        const rustDeps = parseCargoToml(cargoPath);
        const hasRust = (n) => rustDeps.includes(n);
        if (hasRust('actix-web')) stack.framework = 'Actix';
        else if (hasRust('axum')) stack.framework = 'Axum';
        else if (hasRust('rocket')) stack.framework = 'Rocket';
    }

    // PHP — proper parsing
    const composerPath = path.join(dir, 'composer.json');
    if (fs.existsSync(composerPath)) {
        stack.runtime = 'PHP';
        stack.language = 'PHP';
        const phpDeps = parseComposerJson(composerPath);
        const hasPHP = (pattern) => phpDeps.some(d => d.includes(pattern));
        if (hasPHP('laravel/framework')) stack.framework = 'Laravel';
        else if (hasPHP('symfony/')) stack.framework = 'Symfony';
    }

    // Ruby — proper parsing
    const gemfilePath = path.join(dir, 'Gemfile');
    if (fs.existsSync(gemfilePath)) {
        stack.runtime = 'Ruby';
        stack.language = 'Ruby';
        const rubyDeps = parseGemfile(gemfilePath);
        const hasRuby = (n) => rubyDeps.includes(n);
        if (hasRuby('rails')) stack.framework = 'Rails';
        else if (hasRuby('sinatra')) stack.framework = 'Sinatra';
    }

    // Java — file existence only (XML/Gradle too complex)
    if (fs.existsSync(path.join(dir, 'pom.xml'))) { stack.runtime = 'JVM'; stack.language = 'Java'; }
    if (fs.existsSync(path.join(dir, 'build.gradle'))) { stack.runtime = 'JVM'; stack.language = 'Java/Kotlin'; }

    return stack;
}

module.exports = { detectExistingProject, detectTechStack };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/scanner/detect.test.js`
Expected: All ~10 cases PASS

- [ ] **Step 5: Commit**

```bash
git add lib/scanner/detect.js test/scanner/detect.test.js
git commit -m "feat: add lib/scanner/detect.js — proper framework detection using parsers"
```

---

### Task 4: Extract `lib/scanner/scan.js`

**Files:**
- Create: `lib/scanner/scan.js`

This extracts `walkDir`, `countLOC`, `detectEntryPoints`, `detectCI`, `detectConventions`, `detectDocs`, and `scanProject` — all functions that depend on constants and the detect/landmines modules.

- [ ] **Step 1: Create `lib/scanner/scan.js`**

```js
// lib/scanner/scan.js
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
```

**Note:** This file depends on `landmines.js` which is created in Task 5. If building sequentially, create a stub `lib/scanner/landmines.js` first:

```js
// Temporary stub — replaced in Task 5
function grepLandmines() { return []; }
module.exports = { grepLandmines };
```

- [ ] **Step 2: Verify syntax**

Run: `node -c lib/scanner/scan.js`
Expected: no output (valid syntax)

- [ ] **Step 3: Commit**

```bash
git add lib/scanner/scan.js
git commit -m "refactor: extract lib/scanner/scan.js — walkDir, scanProject, detect helpers"
```

---

### Task 5: Create `lib/scanner/landmines.js` with TDD

**Files:**
- Create (or replace stub): `lib/scanner/landmines.js`
- Create: `test/scanner/landmines.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/scanner/landmines.test.js
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    SEVERITY_MAP,
    grepLandmines,
    groupBySeverity,
    formatLandminesForPlan,
    formatLandminesForMap,
} = require('../../lib/scanner/landmines');

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'landmines-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('SEVERITY_MAP', () => {
    it('FIXME is critical', () => {
        assert.equal(SEVERITY_MAP.FIXME, 'critical');
    });

    it('XXX is critical', () => {
        assert.equal(SEVERITY_MAP.XXX, 'critical');
    });

    it('HACK is warning', () => {
        assert.equal(SEVERITY_MAP.HACK, 'warning');
    });

    it('TODO is info', () => {
        assert.equal(SEVERITY_MAP.TODO, 'info');
    });
});

describe('grepLandmines', () => {
    it('finds landmines with severity', () => {
        fs.writeFileSync(path.join(tmpDir, 'app.js'), 'const x = 1;\n// TODO: refactor this\n// FIXME: broken\n');
        const result = grepLandmines(tmpDir, ['app.js']);
        assert.equal(result.length, 2);
        assert.equal(result[0].type, 'TODO');
        assert.equal(result[0].severity, 'info');
        assert.equal(result[0].line, 2);
        assert.equal(result[1].type, 'FIXME');
        assert.equal(result[1].severity, 'critical');
    });

    it('includes context lines', () => {
        fs.writeFileSync(path.join(tmpDir, 'app.js'), 'line one\n// HACK: workaround\nline three\n');
        const result = grepLandmines(tmpDir, ['app.js']);
        assert.equal(result.length, 1);
        assert.ok(result[0].context.includes('line one'));
        assert.ok(result[0].context.includes('line three'));
    });

    it('caps at MAX_LANDMINES', () => {
        const lines = Array.from({ length: 60 }, (_, i) => `// TODO: item ${i}`).join('\n');
        fs.writeFileSync(path.join(tmpDir, 'big.js'), lines);
        const result = grepLandmines(tmpDir, ['big.js']);
        assert.ok(result.length <= 50);
    });

    it('sorts critical first', () => {
        fs.writeFileSync(path.join(tmpDir, 'app.js'), '// TODO: low\n// FIXME: high\n// HACK: mid\n');
        const result = grepLandmines(tmpDir, ['app.js']);
        assert.equal(result[0].severity, 'critical');
    });

    it('skips non-source files', () => {
        fs.writeFileSync(path.join(tmpDir, 'notes.txt'), '// TODO: not source\n');
        const result = grepLandmines(tmpDir, ['notes.txt']);
        assert.equal(result.length, 0);
    });

    it('truncates text at 120 chars', () => {
        const long = '// TODO: ' + 'x'.repeat(200);
        fs.writeFileSync(path.join(tmpDir, 'app.js'), long);
        const result = grepLandmines(tmpDir, ['app.js']);
        assert.ok(result[0].text.length <= 120);
    });
});

describe('groupBySeverity', () => {
    it('groups landmines by severity', () => {
        const mines = [
            { severity: 'critical', type: 'FIXME' },
            { severity: 'info', type: 'TODO' },
            { severity: 'warning', type: 'HACK' },
            { severity: 'critical', type: 'XXX' },
        ];
        const groups = groupBySeverity(mines);
        assert.equal(groups.critical.length, 2);
        assert.equal(groups.warning.length, 1);
        assert.equal(groups.info.length, 1);
    });

    it('returns empty arrays for missing groups', () => {
        const groups = groupBySeverity([]);
        assert.deepEqual(groups, { critical: [], warning: [], info: [] });
    });
});

describe('formatLandminesForPlan', () => {
    it('returns markdown checklist grouped by severity', () => {
        const mines = [
            { file: 'a.js', line: 10, type: 'FIXME', severity: 'critical', text: 'broken auth' },
            { file: 'b.js', line: 5, type: 'TODO', severity: 'info', text: 'add logging' },
        ];
        const md = formatLandminesForPlan(mines);
        assert.ok(md.includes('🔴 Critical'));
        assert.ok(md.includes('- [ ] `a.js:10`'));
        assert.ok(md.includes('ℹ️ Info'));
    });
});

describe('formatLandminesForMap', () => {
    it('limits items per group', () => {
        const mines = Array.from({ length: 10 }, (_, i) => ({
            file: `f${i}.js`, line: 1, type: 'TODO', severity: 'info', text: `item ${i}`,
        }));
        const md = formatLandminesForMap(mines, 3);
        const todoLines = md.split('\n').filter(l => l.includes('f'));
        assert.ok(todoLines.length <= 3);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/scanner/landmines.test.js`
Expected: FAIL — exports missing or stub doesn't have SEVERITY_MAP

- [ ] **Step 3: Implement `lib/scanner/landmines.js`**

```js
// lib/scanner/landmines.js
const fs = require('fs');
const path = require('path');
const { MAX_LANDMINES, SOURCE_EXTENSIONS } = require('./constants');

const SEVERITY_MAP = {
    FIXME: 'critical',
    XXX: 'critical',
    HACK: 'warning',
    TODO: 'info',
};

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

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
                    const before = i > 0 ? lines[i - 1].trim() : '';
                    const after = i < lines.length - 1 ? lines[i + 1].trim() : '';
                    landmines.push({
                        file: rel,
                        line: i + 1,
                        type: match[1],
                        severity: SEVERITY_MAP[match[1]],
                        text: match[2].trim().substring(0, 120),
                        context: [before, after].filter(Boolean).join(' | '),
                    });
                }
            }
        } catch {}
    }

    landmines.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    return landmines;
}

function groupBySeverity(landmines) {
    const groups = { critical: [], warning: [], info: [] };
    for (const m of landmines) {
        if (groups[m.severity]) groups[m.severity].push(m);
    }
    return groups;
}

function formatLandminesForPlan(landmines) {
    const groups = groupBySeverity(landmines);
    const lines = [];

    if (groups.critical.length > 0) {
        lines.push('### 🔴 Critical');
        for (const m of groups.critical) {
            lines.push(`- [ ] \`${m.file}:${m.line}\` — ${m.type}: ${m.text}`);
        }
        lines.push('');
    }
    if (groups.warning.length > 0) {
        lines.push('### ⚠️ Warning');
        for (const m of groups.warning) {
            lines.push(`- [ ] \`${m.file}:${m.line}\` — ${m.type}: ${m.text}`);
        }
        lines.push('');
    }
    if (groups.info.length > 0) {
        lines.push('### ℹ️ Info');
        for (const m of groups.info) {
            lines.push(`- [ ] \`${m.file}:${m.line}\` — ${m.type}: ${m.text}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

function formatLandminesForMap(landmines, maxPerGroup = 4) {
    const groups = groupBySeverity(landmines);
    const lines = [];

    for (const [severity, label] of [['critical', '🔴 Critical'], ['warning', '⚠️ Warning'], ['info', 'ℹ️ Info']]) {
        const items = groups[severity];
        if (items.length === 0) continue;
        lines.push(`**${label}** (${items.length})`);
        const show = items.slice(0, maxPerGroup);
        for (const m of show) {
            lines.push(`- \`${m.file}:${m.line}\` — ${m.type}: ${m.text}`);
        }
        if (items.length > maxPerGroup) {
            lines.push(`- _(${items.length - maxPerGroup} more)_`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

module.exports = { SEVERITY_MAP, grepLandmines, groupBySeverity, formatLandminesForPlan, formatLandminesForMap };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/scanner/landmines.test.js`
Expected: All ~12 cases PASS

- [ ] **Step 5: Commit**

```bash
git add lib/scanner/landmines.js test/scanner/landmines.test.js
git commit -m "feat: add lib/scanner/landmines.js — severity classification, context, formatters"
```

---

### Task 6: Extract `lib/scanner/map.js`

**Files:**
- Create: `lib/scanner/map.js`

- [ ] **Step 1: Create `lib/scanner/map.js`**

Extract `generateMapSkeleton`, `parseMapStructure`, and `refreshMap` from old `lib/scanner.js`. Update `generateMapSkeleton` to use the new `formatLandminesForMap` for the Landmines section.

```js
// lib/scanner/map.js
const fs = require('fs');
const path = require('path');
const { scanProject } = require('./scan');
const { formatLandminesForMap } = require('./landmines');

function generateMapSkeleton(scan, projectName) {
    const date = new Date().toISOString().split('T')[0];
    const lines = [];

    lines.push(`# Project Map — ${projectName}`);
    lines.push(`> Generated by omni map | ${date} | ${scan.stats.files} files, ${scan.stats.dirs} dirs, ~${scan.stats.loc} LOC`);
    lines.push(`> Last refresh: ${date} | Age: 0 days`);
    lines.push('');

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

    lines.push('## Entry Points');
    if (scan.entryPoints.length > 0) {
        for (const ep of scan.entryPoints) {
            lines.push(`- \`${ep.file}\` — ${ep.hint}`);
        }
    } else {
        lines.push('[No entry points detected]');
    }
    lines.push('');

    if (scan.ci.length > 0) {
        lines.push('## CI/CD');
        for (const c of scan.ci) {
            lines.push(`- \`${c.file}\` (${c.type})`);
        }
        lines.push('');
    }

    lines.push('## Conventions');
    const conv = scan.conventions;
    if (conv.linter) lines.push(`- Linter: ${conv.linter}`);
    if (conv.formatter) lines.push(`- Formatter: ${conv.formatter}`);
    if (conv.tsconfig) lines.push('- TypeScript: strict (tsconfig.json)');
    if (conv.editorconfig) lines.push('- EditorConfig: yes');
    if (conv.commitConvention) lines.push(`- Commits: ${conv.commitConvention}`);
    if (!conv.linter && !conv.formatter && !conv.tsconfig) lines.push('[No conventions detected]');
    lines.push('');

    lines.push('## Key Patterns');
    lines.push('[PENDING — AI fills this when running >om:map]');
    lines.push('');

    lines.push('## Landmines');
    if (scan.landmines.length > 0) {
        lines.push(formatLandminesForMap(scan.landmines, 4));
    } else {
        lines.push('[No TODO/FIXME/HACK found]');
    }
    lines.push('');

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

    md = md.replace(/Last refresh: \S+/, `Last refresh: ${today}`);
    md = md.replace(/Age: \d+ days/, 'Age: 0 days');
    const statsMatch = md.match(/\| \d+ files, \d+ dirs, ~\d+ LOC/);
    if (statsMatch) {
        md = md.replace(statsMatch[0], `| ${newScan.stats.files} files, ${newScan.stats.dirs} dirs, ~${newScan.stats.loc} LOC`);
    }

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

module.exports = { generateMapSkeleton, parseMapStructure, refreshMap };
```

- [ ] **Step 2: Verify syntax**

Run: `node -c lib/scanner/map.js`
Expected: no output (valid syntax)

- [ ] **Step 3: Commit**

```bash
git add lib/scanner/map.js
git commit -m "refactor: extract lib/scanner/map.js — map generation with severity-grouped landmines"
```

---

### Task 7: Create `lib/scanner/index.js` + backward compatibility test

**Files:**
- Create: `lib/scanner/index.js`
- Create: `test/scanner/scan.test.js`

- [ ] **Step 1: Write the backward compatibility test**

```js
// test/scanner/scan.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const scanner = require('../../lib/scanner');

describe('lib/scanner/index.js backward compatibility', () => {
    it('exports detectExistingProject', () => {
        assert.equal(typeof scanner.detectExistingProject, 'function');
    });

    it('exports scanProject', () => {
        assert.equal(typeof scanner.scanProject, 'function');
    });

    it('exports generateMapSkeleton', () => {
        assert.equal(typeof scanner.generateMapSkeleton, 'function');
    });

    it('exports refreshMap', () => {
        assert.equal(typeof scanner.refreshMap, 'function');
    });

    it('exports IGNORED_DIRS as a Set', () => {
        assert.ok(scanner.IGNORED_DIRS instanceof Set);
        assert.ok(scanner.IGNORED_DIRS.has('node_modules'));
    });

    it('exports MANIFEST_FILES as an object', () => {
        assert.equal(typeof scanner.MANIFEST_FILES, 'object');
        assert.equal(scanner.MANIFEST_FILES['package.json'], 'Node.js');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scanner/scan.test.js`
Expected: FAIL — `lib/scanner` still resolves to old `lib/scanner.js`, not `lib/scanner/index.js`

- [ ] **Step 3: Delete `lib/scanner.js` and create `lib/scanner/index.js`**

First, delete the old monolithic file:

```bash
rm lib/scanner.js
```

Then create the index:

```js
// lib/scanner/index.js
const { IGNORED_DIRS, MANIFEST_FILES, MAX_DEPTH, MAX_LANDMINES, SOURCE_EXTENSIONS } = require('./constants');
const { detectExistingProject, detectTechStack } = require('./detect');
const { scanProject } = require('./scan');
const { generateMapSkeleton, refreshMap } = require('./map');
const { SEVERITY_MAP, grepLandmines, groupBySeverity, formatLandminesForPlan, formatLandminesForMap } = require('./landmines');

module.exports = {
    detectExistingProject,
    detectTechStack,
    scanProject,
    generateMapSkeleton,
    refreshMap,
    grepLandmines,
    groupBySeverity,
    formatLandminesForPlan,
    formatLandminesForMap,
    SEVERITY_MAP,
    IGNORED_DIRS,
    MANIFEST_FILES,
    MAX_DEPTH,
    MAX_LANDMINES,
    SOURCE_EXTENSIONS,
};
```

- [ ] **Step 4: Run backward compat test**

Run: `node --test test/scanner/scan.test.js`
Expected: All 6 cases PASS

- [ ] **Step 5: Verify existing tests still pass**

Run: `node -c bin/omni.js && node --test test/*.test.js test/**/*.test.js`
Expected: All existing tests PASS (bin/omni.js `require('../lib/scanner')` now resolves to `lib/scanner/index.js`)

- [ ] **Step 6: Commit**

```bash
git add lib/scanner/index.js test/scanner/scan.test.js
git rm lib/scanner.js
git commit -m "refactor: replace lib/scanner.js with lib/scanner/ directory — backward compatible"
```

---

### Task 8: Create `lib/rules/` module with TDD

**Files:**
- Create: `lib/rules/parse.js`
- Create: `lib/rules/format.js`
- Create: `lib/rules/sync.js`
- Create: `lib/rules/index.js`
- Create: `test/rules.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/rules.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { parseRules, formatMarkdown, formatInject, syncRulesToConfig } = require('../lib/rules');

describe('parseRules', () => {
    it('parses all fields', () => {
        const result = parseRules({
            language: 'TypeScript',
            codingStyle: 'functional; immutable',
            forbidden: 'any; eval',
            custom: 'commit tiếng Việt',
        });
        assert.equal(result.language, 'TypeScript');
        assert.deepEqual(result.codingStyle, ['functional', 'immutable']);
        assert.deepEqual(result.forbidden, ['any', 'eval']);
        assert.deepEqual(result.custom, ['commit tiếng Việt']);
    });

    it('handles null/undefined fields', () => {
        const result = parseRules({ language: null });
        assert.equal(result.language, null);
        assert.deepEqual(result.codingStyle, []);
        assert.deepEqual(result.forbidden, []);
        assert.deepEqual(result.custom, []);
    });

    it('filters empty entries from semicolon split', () => {
        const result = parseRules({ codingStyle: '; foo ; ; bar ;' });
        assert.deepEqual(result.codingStyle, ['foo', 'bar']);
    });
});

describe('formatMarkdown', () => {
    it('formats sections with headers and bullets', () => {
        const parsed = {
            language: 'Python',
            codingStyle: ['PEP 8', 'type hints'],
            forbidden: ['global vars'],
            custom: ['docstrings required'],
        };
        const md = formatMarkdown(parsed);
        assert.ok(md.includes('# Personal Rules'));
        assert.ok(md.includes('## Ngôn ngữ'));
        assert.ok(md.includes('- Python'));
        assert.ok(md.includes('## Coding Style'));
        assert.ok(md.includes('- PEP 8'));
        assert.ok(md.includes('## Forbidden Patterns'));
        assert.ok(md.includes('- global vars'));
        assert.ok(md.includes('## Custom Rules'));
    });

    it('returns null when no sections', () => {
        assert.equal(formatMarkdown({ language: null, codingStyle: [], forbidden: [], custom: [] }), null);
    });
});

describe('formatInject', () => {
    it('formats for config injection', () => {
        const parsed = {
            language: 'Go',
            codingStyle: ['gofmt'],
            forbidden: ['panic'],
            custom: [],
        };
        const result = formatInject(parsed);
        assert.ok(result.includes('**Ngôn ngữ:** Go'));
        assert.ok(result.includes('- gofmt'));
        assert.ok(result.includes('**KHÔNG:** panic'));
    });

    it('handles empty parsed rules', () => {
        const result = formatInject({ language: null, codingStyle: [], forbidden: [], custom: [] });
        assert.equal(result, '');
    });
});

describe('syncRulesToConfig', () => {
    it('injects rules between markers', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-sync-'));
        const configPath = path.join(tmpDir, 'CLAUDE.md');
        const rulesPath = path.join(tmpDir, '.omni', 'rules.md');
        fs.mkdirSync(path.join(tmpDir, '.omni'), { recursive: true });
        fs.writeFileSync(configPath, '# Config\n<!-- omni:rules -->\nold\n<!-- /omni:rules -->\n# End\n');
        fs.writeFileSync(rulesPath, '# Rules\n- rule one\n- rule two\n');

        const result = syncRulesToConfig(() => 'CLAUDE.md', tmpDir);
        assert.equal(result, true);

        const updated = fs.readFileSync(configPath, 'utf-8');
        assert.ok(updated.includes('rule one'));
        assert.ok(updated.includes('rule two'));
        assert.ok(updated.includes('<!-- omni:rules -->'));
        assert.ok(updated.includes('# End'));

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('appends markers if not present', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-sync-'));
        const configPath = path.join(tmpDir, 'CLAUDE.md');
        const rulesPath = path.join(tmpDir, '.omni', 'rules.md');
        fs.mkdirSync(path.join(tmpDir, '.omni'), { recursive: true });
        fs.writeFileSync(configPath, '# Config\n');
        fs.writeFileSync(rulesPath, '# Rules\n- new rule\n');

        syncRulesToConfig(() => 'CLAUDE.md', tmpDir);

        const updated = fs.readFileSync(configPath, 'utf-8');
        assert.ok(updated.includes('<!-- omni:rules -->'));
        assert.ok(updated.includes('new rule'));

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns false when no config file', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-sync-'));
        const result = syncRulesToConfig(() => null, tmpDir);
        assert.equal(result, false);
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/rules.test.js`
Expected: FAIL — `Cannot find module '../lib/rules'`

- [ ] **Step 3: Implement `lib/rules/parse.js`**

```js
// lib/rules/parse.js
function parseRules(rp) {
    const split = (str) => str ? str.split(';').map(r => r.trim()).filter(Boolean) : [];
    return {
        language: rp.language || null,
        codingStyle: split(rp.codingStyle),
        forbidden: split(rp.forbidden),
        custom: split(rp.custom),
    };
}

module.exports = { parseRules };
```

- [ ] **Step 4: Implement `lib/rules/format.js`**

```js
// lib/rules/format.js
function formatMarkdown(parsed) {
    const sections = [];
    if (parsed.language) sections.push(`## Ngôn ngữ\n- ${parsed.language}`);
    if (parsed.codingStyle.length > 0) sections.push(`## Coding Style\n${parsed.codingStyle.map(r => `- ${r}`).join('\n')}`);
    if (parsed.forbidden.length > 0) sections.push(`## Forbidden Patterns\n${parsed.forbidden.map(r => `- ${r}`).join('\n')}`);
    if (parsed.custom.length > 0) sections.push(`## Custom Rules\n${parsed.custom.map(r => `- ${r}`).join('\n')}`);
    if (sections.length === 0) return null;
    return `# Personal Rules\n> Generated by Omni-Coder Kit | Last updated: ${new Date().toISOString().split('T')[0]}\n\n${sections.join('\n\n')}\n`;
}

function formatInject(parsed) {
    const lines = [];
    if (parsed.language) lines.push(`- **Ngôn ngữ:** ${parsed.language}`);
    for (const r of parsed.codingStyle) lines.push(`- ${r}`);
    for (const r of parsed.forbidden) lines.push(`- **KHÔNG:** ${r}`);
    for (const r of parsed.custom) lines.push(`- ${r}`);
    return lines.join('\n');
}

module.exports = { formatMarkdown, formatInject };
```

- [ ] **Step 5: Implement `lib/rules/sync.js`**

```js
// lib/rules/sync.js
const fs = require('fs');
const path = require('path');

const RULES_FILE = path.join('.omni', 'rules.md');

function syncRulesToConfig(findConfigFileFn, projectDir) {
    const configFile = findConfigFileFn();
    if (!configFile) return false;
    const configPath = path.join(projectDir, configFile);
    const rulesPath = path.join(projectDir, RULES_FILE);
    if (!fs.existsSync(rulesPath)) return false;

    const rulesRaw = fs.readFileSync(rulesPath, 'utf-8');
    const lines = rulesRaw.split('\n').filter(l => l.startsWith('- ')).join('\n');
    if (!lines) return false;

    let config = fs.readFileSync(configPath, 'utf-8');
    const startMarker = '<!-- omni:rules -->';
    const endMarker = '<!-- /omni:rules -->';
    const injection = `${startMarker}\n## PERSONAL RULES\n${lines}\n${endMarker}`;

    if (config.includes(startMarker) && config.includes(endMarker)) {
        const regex = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}`, 'g');
        config = config.replace(regex, injection);
    } else {
        config += `\n\n${injection}\n`;
    }
    fs.writeFileSync(configPath, config, 'utf-8');
    return true;
}

module.exports = { syncRulesToConfig };
```

- [ ] **Step 6: Create `lib/rules/index.js`**

```js
// lib/rules/index.js
const { parseRules } = require('./parse');
const { formatMarkdown, formatInject } = require('./format');
const { syncRulesToConfig } = require('./sync');

module.exports = { parseRules, formatMarkdown, formatInject, syncRulesToConfig };
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test test/rules.test.js`
Expected: All ~10 cases PASS

- [ ] **Step 8: Commit**

```bash
git add lib/rules/parse.js lib/rules/format.js lib/rules/sync.js lib/rules/index.js test/rules.test.js
git commit -m "feat: add lib/rules/ module — consolidated parseRules, formatMarkdown, formatInject, syncRulesToConfig"
```

---

### Task 9: Create `lib/workflows/` module with TDD

**Files:**
- Create: `lib/workflows/resolve.js`
- Create: `lib/workflows/build.js`
- Create: `lib/workflows/index.js`
- Create: `test/workflows.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// test/workflows.test.js
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { resolveWorkflow, resolveAllWorkflows } = require('../lib/workflows');

let tmpDir;
const pkgTemplatesDir = path.join(__dirname, '..', 'templates', 'workflows');

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflows-test-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveWorkflow', () => {
    it('returns custom workflow if exists in .omni/workflows/', () => {
        const customDir = path.join(tmpDir, '.omni', 'workflows');
        fs.mkdirSync(customDir, { recursive: true });
        fs.writeFileSync(path.join(customDir, 'task-planning.md'), '# Custom');
        const result = resolveWorkflow('task-planning.md', tmpDir);
        assert.ok(result.endsWith(path.join('.omni', 'workflows', 'task-planning.md')));
    });

    it('falls back to package templates when no custom', () => {
        const result = resolveWorkflow('task-planning.md', tmpDir);
        assert.ok(result.includes(path.join('templates', 'workflows', 'task-planning.md')));
    });

    it('returns null for non-existent workflow', () => {
        const result = resolveWorkflow('nonexistent.md', tmpDir);
        assert.equal(result, null);
    });
});

describe('resolveAllWorkflows', () => {
    it('returns all package workflows', () => {
        const result = resolveAllWorkflows(tmpDir);
        assert.ok(Object.keys(result).length > 0);
        assert.ok('task-planning.md' in result);
    });

    it('overlays custom workflows', () => {
        const customDir = path.join(tmpDir, '.omni', 'workflows');
        fs.mkdirSync(customDir, { recursive: true });
        fs.writeFileSync(path.join(customDir, 'task-planning.md'), '# Custom');

        const result = resolveAllWorkflows(tmpDir);
        assert.ok(result['task-planning.md'].includes('.omni'));
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/workflows.test.js`
Expected: FAIL — `Cannot find module '../lib/workflows'`

- [ ] **Step 3: Implement `lib/workflows/resolve.js`**

```js
// lib/workflows/resolve.js
const fs = require('fs');
const path = require('path');

const PACKAGE_WORKFLOWS_DIR = path.join(__dirname, '..', '..', 'templates', 'workflows');

function resolveWorkflow(name, projectDir) {
    const customPath = path.join(projectDir, '.omni', 'workflows', name);
    if (fs.existsSync(customPath)) return customPath;

    const pkgPath = path.join(PACKAGE_WORKFLOWS_DIR, name);
    if (fs.existsSync(pkgPath)) return pkgPath;

    return null;
}

function resolveAllWorkflows(projectDir) {
    const result = {};

    if (fs.existsSync(PACKAGE_WORKFLOWS_DIR)) {
        for (const f of fs.readdirSync(PACKAGE_WORKFLOWS_DIR).filter(f => f.endsWith('.md'))) {
            result[f] = path.join(PACKAGE_WORKFLOWS_DIR, f);
        }
    }

    const customDir = path.join(projectDir, '.omni', 'workflows');
    if (fs.existsSync(customDir)) {
        for (const f of fs.readdirSync(customDir).filter(f => f.endsWith('.md'))) {
            result[f] = path.join(customDir, f);
        }
    }

    return result;
}

module.exports = { resolveWorkflow, resolveAllWorkflows };
```

- [ ] **Step 4: Implement `lib/workflows/build.js`**

Extract `getOverlayDir` and `buildWorkflows` from `bin/omni.js`:

```js
// lib/workflows/build.js
const fs = require('fs');
const path = require('path');
const { getOverlayNameForTarget } = require('../helpers');

function getOverlayDir(ide, target = null) {
    const overlayName = target
        ? getOverlayNameForTarget(ide, target)
        : ({ claudecode: 'claude-code', dual: 'claude-code', cursor: 'cursor' }[ide] || null);
    if (!overlayName) return null;
    const dir = path.join(__dirname, '..', '..', 'templates', 'overlays', overlayName);
    return fs.existsSync(dir) ? dir : null;
}

function buildWorkflows(ide, target = null) {
    const baseDir = path.join(__dirname, '..', '..', 'templates', 'workflows');
    const files = {};

    for (const f of fs.readdirSync(baseDir).filter(f => f.endsWith('.md'))) {
        files[f] = path.join(baseDir, f);
    }

    const overlayDir = getOverlayDir(ide, target);
    if (overlayDir) {
        const overlayWorkflowDir = path.join(overlayDir, 'workflows');
        if (fs.existsSync(overlayWorkflowDir)) {
            for (const f of fs.readdirSync(overlayWorkflowDir).filter(f => f.endsWith('.md'))) {
                files[f] = path.join(overlayWorkflowDir, f);
            }
        }
    }

    return files;
}

module.exports = { getOverlayDir, buildWorkflows };
```

- [ ] **Step 5: Create `lib/workflows/index.js`**

```js
// lib/workflows/index.js
const { resolveWorkflow, resolveAllWorkflows } = require('./resolve');
const { getOverlayDir, buildWorkflows } = require('./build');

module.exports = { resolveWorkflow, resolveAllWorkflows, getOverlayDir, buildWorkflows };
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test test/workflows.test.js`
Expected: All ~6 cases PASS

- [ ] **Step 7: Commit**

```bash
git add lib/workflows/resolve.js lib/workflows/build.js lib/workflows/index.js test/workflows.test.js
git commit -m "feat: add lib/workflows/ module — hybrid resolve chain + build extraction"
```

---

### Task 10: Update `bin/omni.js` imports + cleanup `lib/helpers.js`

**Files:**
- Modify: `bin/omni.js` (imports, remove inlined functions, use new modules)
- Modify: `lib/helpers.js` (remove `buildRulesContent`, `extractRulesForInject`)

- [ ] **Step 1: Update `bin/omni.js` imports (lines 14-22)**

Replace the current import block:

```js
// OLD (lines 14-22):
const {
    IDE_AGENT_MAP, IDE_CONFIG_FILE, parseSource, isValidSkillName,
    buildRulesContent, extractRulesForInject, createManifest,
    getAgentFlags, getOverlayNameForTarget, detectDNA,
} = require(path.join(__dirname, '..', 'lib', 'helpers'));
const {
    detectExistingProject, scanProject, generateMapSkeleton, refreshMap,
} = require(path.join(__dirname, '..', 'lib', 'scanner'));
const {
    UNIVERSAL_SKILLS, getTestSkillsForStack, buildSearchSuggestion,
} = require(path.join(__dirname, '..', 'lib', 'skills'));
```

With:

```js
const {
    IDE_AGENT_MAP, IDE_CONFIG_FILE, parseSource, isValidSkillName,
    createManifest, getAgentFlags, getOverlayNameForTarget, detectDNA,
} = require(path.join(__dirname, '..', 'lib', 'helpers'));
const {
    detectExistingProject, scanProject, generateMapSkeleton, refreshMap,
} = require(path.join(__dirname, '..', 'lib', 'scanner'));
const {
    UNIVERSAL_SKILLS, getTestSkillsForStack, buildSearchSuggestion,
} = require(path.join(__dirname, '..', 'lib', 'skills'));
const { parseRules, formatMarkdown, formatInject, syncRulesToConfig } = require(path.join(__dirname, '..', 'lib', 'rules'));
const { getOverlayDir, buildWorkflows } = require(path.join(__dirname, '..', 'lib', 'workflows'));
```

- [ ] **Step 2: Remove `syncRulesToConfig` from `bin/omni.js` (lines 99-122)**

Delete the `syncRulesToConfig()` function defined in `bin/omni.js` since it's now in `lib/rules/sync.js`.

- [ ] **Step 3: Remove `getOverlayDir` from `bin/omni.js` (lines 134-141)**

Delete the `getOverlayDir()` function — now in `lib/workflows/build.js`.

- [ ] **Step 4: Remove `buildWorkflows` from `bin/omni.js` (lines 143-163)**

Delete the `buildWorkflows()` function — now in `lib/workflows/build.js`.

- [ ] **Step 5: Update `syncRulesToConfig()` call sites**

Find all calls to `syncRulesToConfig()` in `bin/omni.js` and update them to pass `findConfigFile` and `process.cwd()`:

```js
// Before:
syncRulesToConfig();

// After:
syncRulesToConfig(findConfigFile, process.cwd());
```

- [ ] **Step 6: Update rules generation in `omni init` (around line 592-596)**

Replace `buildRulesContent(rulesPrompt)` and `extractRulesForInject(rulesPrompt)`:

```js
// Before:
const rulesContent = buildRulesContent(rulesPrompt);
if (rulesContent) {
    const rulesPath = path.join(process.cwd(), '.omni', 'rules.md');
    writeFileSafe(rulesPath, rulesContent);
    finalRules += `\n<!-- omni:rules -->\n## PERSONAL RULES\n${extractRulesForInject(rulesPrompt)}\n<!-- /omni:rules -->\n\n`;
}

// After:
const parsed = parseRules(rulesPrompt);
const rulesContent = formatMarkdown(parsed);
if (rulesContent) {
    const rulesPath = path.join(process.cwd(), '.omni', 'rules.md');
    writeFileSafe(rulesPath, rulesContent);
    finalRules += `\n<!-- omni:rules -->\n## PERSONAL RULES\n${formatInject(parsed)}\n<!-- /omni:rules -->\n\n`;
}
```

- [ ] **Step 7: Remove `buildRulesContent` and `extractRulesForInject` from `lib/helpers.js`**

Delete lines 47-64 (the two functions) and remove them from `module.exports`.

Updated `module.exports` in `lib/helpers.js`:

```js
module.exports = {
    IDE_AGENT_MAP,
    IDE_CONFIG_FILE,
    parseSource,
    isValidSkillName,
    createManifest,
    getAgentFlags,
    getOverlayNameForTarget,
    detectDNA,
};
```

- [ ] **Step 8: Verify syntax**

Run: `node -c bin/omni.js && node -c lib/helpers.js`
Expected: no output (valid syntax)

- [ ] **Step 9: Run full test suite**

Run: `node -c bin/omni.js && node --test test/*.test.js test/**/*.test.js`
Expected: All tests PASS

- [ ] **Step 10: Commit**

```bash
git add bin/omni.js lib/helpers.js
git commit -m "refactor: update bin/omni.js to use lib/rules/ and lib/workflows/ modules, cleanup helpers.js"
```

---

### Task 11: Add `omni customize` command + update `package.json` test glob

**Files:**
- Modify: `bin/omni.js` (add `omni customize` command)
- Modify: `package.json` (update test script glob)

- [ ] **Step 1: Add `omni customize` command to `bin/omni.js`**

Add after the existing commands (before `program.parse()`):

```js
// ---------- CUSTOMIZE ----------
program
    .command('customize <workflow>')
    .description('Copy a workflow from package to .omni/workflows/ for customization')
    .action(async (workflow) => {
        const { resolveWorkflow } = require(path.join(__dirname, '..', 'lib', 'workflows'));

        const name = workflow.endsWith('.md') ? workflow : workflow + '.md';
        const pkgPath = path.join(__dirname, '..', 'templates', 'workflows', name);

        if (!fs.existsSync(pkgPath)) {
            const available = fs.readdirSync(path.join(__dirname, '..', 'templates', 'workflows'))
                .filter(f => f.endsWith('.md'))
                .map(f => f.replace('.md', ''));
            console.log(chalk.red(`\n❌ Workflow "${name}" không tồn tại.`));
            console.log(chalk.gray(`   Có sẵn: ${available.join(', ')}\n`));
            return;
        }

        const customDir = path.join(process.cwd(), '.omni', 'workflows');
        const customPath = path.join(customDir, name);

        if (fs.existsSync(customPath)) {
            console.log(chalk.yellow(`\n⚠️  .omni/workflows/${name} đã tồn tại — bỏ qua.\n`));
            return;
        }

        fs.mkdirSync(customDir, { recursive: true });
        fs.copyFileSync(pkgPath, customPath);
        console.log(chalk.green(`\n✅ Đã copy ${name} → .omni/workflows/${name}`));
        console.log(chalk.gray(`   Chỉnh sửa file này. Omni sẽ ưu tiên bản custom.\n`));
    });
```

- [ ] **Step 2: Update `package.json` test script**

```json
"test": "node -c bin/omni.js && node --test test/*.test.js test/**/*.test.js"
```

- [ ] **Step 3: Verify syntax and run full test suite**

Run: `node -c bin/omni.js && node --test test/*.test.js test/**/*.test.js`
Expected: All tests PASS (parsers ~20 + detect ~10 + landmines ~12 + scan ~6 + rules ~10 + workflows ~6 + skills 43 + existing)

- [ ] **Step 4: Commit**

```bash
git add bin/omni.js package.json
git commit -m "feat: add omni customize command + update test glob for sub-directories"
```

---

### Task 12: Final verification + cleanup

- [ ] **Step 1: Verify file structure matches design**

Run:
```bash
find lib/scanner lib/rules lib/workflows -type f | sort
```

Expected:
```
lib/rules/format.js
lib/rules/index.js
lib/rules/parse.js
lib/rules/sync.js
lib/scanner/constants.js
lib/scanner/detect.js
lib/scanner/index.js
lib/scanner/landmines.js
lib/scanner/map.js
lib/scanner/parsers.js
lib/scanner/scan.js
lib/workflows/build.js
lib/workflows/index.js
lib/workflows/resolve.js
```

- [ ] **Step 2: Verify old `lib/scanner.js` is deleted**

Run: `ls lib/scanner.js 2>&1`
Expected: `No such file or directory`

- [ ] **Step 3: Run full test suite**

Run: `node -c bin/omni.js && node --test test/*.test.js test/**/*.test.js`
Expected: ALL PASS — ~478+ total (420 existing + ~58 new)

- [ ] **Step 4: Verify `require('../lib/scanner')` backward compat**

Run: `node -e "const s = require('./lib/scanner'); console.log(Object.keys(s).join(', '))"`
Expected output includes: `detectExistingProject, detectTechStack, scanProject, generateMapSkeleton, refreshMap, grepLandmines, groupBySeverity, formatLandminesForPlan, formatLandminesForMap, SEVERITY_MAP, IGNORED_DIRS, MANIFEST_FILES`

- [ ] **Step 5: Final commit if any loose changes**

```bash
git status
```

If clean, no commit needed. Otherwise commit with appropriate message.
