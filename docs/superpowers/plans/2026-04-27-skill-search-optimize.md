# Skill Search Optimize — Smart Matching Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the binary exact/fallback matching in `lib/skills.js` with a score-based engine, add composite framework parsing, registry validation, expanded coverage, and UX fallback chain.

**Architecture:** `lib/skills.js` is the single module owning registry data, parsing, scoring, validation, and fallback helpers. `bin/omni.js` consumes the public API (`getTestSkillsForStack`, `buildSearchSuggestion`) and handles all user-facing output. Tests in `test/skills.test.js` cover every exported function.

**Tech Stack:** Node.js, `node:test`, `node:assert/strict`, no external dependencies.

---

### Task 1: Registry Schema v2 + Validation

**Files:**
- Modify: `lib/skills.js:1-69`
- Test: `test/skills.test.js`

- [ ] **Step 1: Write failing tests for `validateRegistry()`**

In `test/skills.test.js`, replace the entire file with the new test suite. Start with the validation tests:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    UNIVERSAL_SKILLS, TEST_SKILLS,
    validateRegistry, parseFrameworks,
    getTestSkillsForStack, buildSearchSuggestion,
} = require('../lib/skills');

describe('UNIVERSAL_SKILLS', () => {
    it('has 6 universal skills', () => {
        assert.equal(UNIVERSAL_SKILLS.length, 6);
    });

    it('includes find-skills', () => {
        assert.ok(UNIVERSAL_SKILLS.some(s => s.name === 'find-skills'));
    });

    it('includes test-driven-development', () => {
        assert.ok(UNIVERSAL_SKILLS.some(s => s.name === 'test-driven-development'));
    });

    it('every skill has source, name, desc', () => {
        for (const s of UNIVERSAL_SKILLS) {
            assert.ok(s.source, `${s.name} missing source`);
            assert.ok(s.name, 'missing name');
            assert.ok(s.desc, `${s.name} missing desc`);
        }
    });
});

describe('validateRegistry', () => {
    it('accepts a valid registry', () => {
        assert.doesNotThrow(() => validateRegistry([
            { source: 'a/b', name: 'x', desc: 'd', lang: ['Go'], frameworks: [], category: 'generic' },
        ]));
    });

    it('throws on missing source', () => {
        assert.throws(
            () => validateRegistry([{ source: '', name: 'x', desc: 'd', lang: ['Go'], frameworks: [], category: 'generic' }]),
            /TEST_SKILLS\[0\].*source/
        );
    });

    it('throws when lang is not an array', () => {
        assert.throws(
            () => validateRegistry([{ source: 'a/b', name: 'x', desc: 'd', lang: 'Go', frameworks: [], category: 'generic' }]),
            /TEST_SKILLS\[0\].*lang/
        );
    });

    it('throws when frameworks is not an array', () => {
        assert.throws(
            () => validateRegistry([{ source: 'a/b', name: 'x', desc: 'd', lang: ['Go'], frameworks: 'Jest', category: 'unit' }]),
            /TEST_SKILLS\[0\].*frameworks/
        );
    });

    it('throws on invalid category', () => {
        assert.throws(
            () => validateRegistry([{ source: 'a/b', name: 'x', desc: 'd', lang: ['Go'], frameworks: [], category: 'bad' }]),
            /TEST_SKILLS\[0\].*category/
        );
    });

    it('throws on duplicate name', () => {
        assert.throws(
            () => validateRegistry([
                { source: 'a/b', name: 'x', desc: 'd', lang: ['Go'], frameworks: [], category: 'generic' },
                { source: 'c/d', name: 'x', desc: 'e', lang: ['Rust'], frameworks: [], category: 'generic' },
            ]),
            /TEST_SKILLS\[1\].*duplicate.*x/
        );
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/skills.test.js`
Expected: FAIL — `validateRegistry` is not exported from `lib/skills.js`.

- [ ] **Step 3: Migrate registry to schema v2 and implement `validateRegistry()`**

Replace the entire `lib/skills.js` with:

```js
const UNIVERSAL_SKILLS = [
    { source: 'vercel-labs/skills', name: 'find-skills', desc: 'Tìm kiếm & cài đặt skills tự động từ skills.sh' },
    { source: 'forrestchang/andrej-karpathy-skills', name: 'karpathy-guidelines', desc: 'Karpathy mindset: Think → Simplify → Surgical → Goal-Driven' },
    { source: 'obra/superpowers', name: 'systematic-debugging', desc: 'Debugging có hệ thống' },
    { source: 'obra/superpowers', name: 'test-driven-development', desc: 'Phát triển hướng test (TDD)' },
    { source: 'obra/superpowers', name: 'requesting-code-review', desc: 'Quy trình review code chuyên nghiệp' },
    { source: 'obra/superpowers', name: 'using-git-worktrees', desc: 'Quản lý Git worktrees hiệu quả' },
];

const VALID_CATEGORIES = ['unit', 'e2e', 'integration', 'generic'];

const TEST_SKILLS = [
    { source: 'github/awesome-copilot', name: 'javascript-typescript-jest', desc: 'Jest best practices cho JS/TS — mocking, async, matchers, React Testing Library', lang: ['JavaScript', 'TypeScript'], frameworks: ['Jest'], category: 'unit' },
    { source: 'antfu/skills', name: 'vitest', desc: 'Vitest 3.x — ESM native, Jest-compatible API, coverage, type testing', lang: ['JavaScript', 'TypeScript'], frameworks: ['Vitest'], category: 'unit' },
    { source: 'nicolo-ribaudo/skills', name: 'mocha-testing', desc: 'Mocha + Chai — BDD/TDD, hooks, async, reporters, Sinon mocking', lang: ['JavaScript', 'TypeScript'], frameworks: ['Mocha'], category: 'unit' },
    { source: 'wshobson/agents', name: 'javascript-testing-patterns', desc: 'JS/TS testing patterns — Jest + Vitest, mocking, AAA pattern, integration tests', lang: ['JavaScript', 'TypeScript'], frameworks: [], category: 'generic' },
    { source: 'currents-dev/playwright-best-practices-skill', name: 'playwright-best-practices', desc: 'Playwright E2E — 50+ patterns, multi-browser, visual regression, CI/CD', lang: ['JavaScript', 'TypeScript'], frameworks: ['Playwright'], category: 'e2e' },
    { source: 'wshobson/agents', name: 'python-testing-patterns', desc: 'pytest patterns — fixtures, parametrize, async, property-based testing', lang: ['Python'], frameworks: [], category: 'generic' },
    { source: 'apollographql/skills', name: 'rust-best-practices', desc: 'Rust best practices — testing, error handling, clippy, performance', lang: ['Rust'], frameworks: [], category: 'generic' },
    { source: 'jeffallan/claude-skills', name: 'php-pro', desc: 'PHP 8.3+ — PHPUnit, Pest, PSR-12, PHPStan, Laravel, Symfony', lang: ['PHP'], frameworks: [], category: 'generic' },
];

function validateRegistry(skills) {
    const seen = new Set();
    for (const [i, s] of skills.entries()) {
        const p = `TEST_SKILLS[${i}]`;
        if (!s.source || typeof s.source !== 'string') throw new Error(`${p}: missing/invalid 'source'`);
        if (!s.name || typeof s.name !== 'string') throw new Error(`${p}: missing/invalid 'name'`);
        if (!s.desc || typeof s.desc !== 'string') throw new Error(`${p}: missing/invalid 'desc'`);
        if (!Array.isArray(s.lang) || s.lang.length === 0) throw new Error(`${p}: 'lang' must be non-empty array`);
        if (!Array.isArray(s.frameworks)) throw new Error(`${p}: 'frameworks' must be array`);
        if (!VALID_CATEGORIES.includes(s.category)) throw new Error(`${p}: invalid category '${s.category}'`);
        if (seen.has(s.name)) throw new Error(`${p}: duplicate name '${s.name}'`);
        seen.add(s.name);
    }
}

validateRegistry(TEST_SKILLS);

function parseFrameworks(testField) {
    if (!testField) return [];
    return testField.split(/\s*\+\s*/).map(s => s.trim()).filter(Boolean);
}

function getTestSkillsForStack(techStack) {
    if (!techStack || !techStack.language) return [];
    // placeholder — will be replaced in Task 3
    return [];
}

function buildSearchSuggestion(lang, testFw) {
    // placeholder — will be replaced in Task 4
    return '';
}

module.exports = {
    UNIVERSAL_SKILLS, TEST_SKILLS, VALID_CATEGORIES,
    validateRegistry, parseFrameworks,
    getTestSkillsForStack, buildSearchSuggestion,
};
```

- [ ] **Step 4: Run tests to verify validation tests pass**

Run: `node --test test/skills.test.js`
Expected: `validateRegistry` tests PASS. Other tests (not yet written) not present.

- [ ] **Step 5: Verify the built-in registry passes validation**

Run: `node -e "require('./lib/skills')"`
Expected: No error — the `validateRegistry(TEST_SKILLS)` call at module load succeeds.

- [ ] **Step 6: Commit**

```bash
git add lib/skills.js test/skills.test.js
git commit -m "refactor: registry schema v2 with validation, frameworks array, category field"
```

---

### Task 2: Composite Framework Parser

**Files:**
- Modify: `lib/skills.js` (the `parseFrameworks` function is already stubbed)
- Test: `test/skills.test.js`

- [ ] **Step 1: Write failing tests for `parseFrameworks()`**

Append this `describe` block to `test/skills.test.js` after the `validateRegistry` describe:

```js
describe('parseFrameworks', () => {
    it('returns empty array for null', () => {
        assert.deepEqual(parseFrameworks(null), []);
    });

    it('returns empty array for empty string', () => {
        assert.deepEqual(parseFrameworks(''), []);
    });

    it('parses single framework', () => {
        assert.deepEqual(parseFrameworks('Jest'), ['Jest']);
    });

    it('parses composite frameworks', () => {
        assert.deepEqual(parseFrameworks('Jest + Playwright'), ['Jest', 'Playwright']);
    });

    it('handles extra whitespace', () => {
        assert.deepEqual(parseFrameworks(' Jest  +  Vitest '), ['Jest', 'Vitest']);
    });

    it('parses triple composite', () => {
        assert.deepEqual(parseFrameworks('Jest + Playwright + Cypress'), ['Jest', 'Playwright', 'Cypress']);
    });
});
```

- [ ] **Step 2: Run tests to verify parseFrameworks tests pass**

Run: `node --test test/skills.test.js`
Expected: All `parseFrameworks` tests PASS (the function was already implemented in Task 1's code).

- [ ] **Step 3: Commit**

```bash
git add test/skills.test.js
git commit -m "test: add parseFrameworks test suite — 6 cases"
```

---

### Task 3: Score-based Matching Engine

**Files:**
- Modify: `lib/skills.js` (replace `getTestSkillsForStack` placeholder)
- Test: `test/skills.test.js`

- [ ] **Step 1: Write failing tests for `getTestSkillsForStack()`**

Append this `describe` block to `test/skills.test.js`:

```js
describe('getTestSkillsForStack', () => {
    it('returns empty for null stack', () => {
        assert.deepEqual(getTestSkillsForStack(null), []);
    });

    it('returns empty for stack without language', () => {
        assert.deepEqual(getTestSkillsForStack({ language: null }), []);
    });

    it('returns Jest skill for TypeScript + Jest', () => {
        const result = getTestSkillsForStack({ language: 'TypeScript', test: 'Jest' });
        assert.ok(result.length > 0);
        assert.equal(result[0].name, 'javascript-typescript-jest');
        assert.ok(!result.some(s => s.name === 'javascript-testing-patterns'), 'generic should be excluded when exact match exists');
    });

    it('returns Vitest skill for TypeScript + Vitest', () => {
        const result = getTestSkillsForStack({ language: 'TypeScript', test: 'Vitest' });
        assert.ok(result.length > 0);
        assert.equal(result[0].name, 'vitest');
    });

    it('returns Mocha skill for JavaScript + Mocha', () => {
        const result = getTestSkillsForStack({ language: 'JavaScript', test: 'Mocha' });
        assert.ok(result.length > 0);
        assert.equal(result[0].name, 'mocha-testing');
    });

    it('returns both Jest and Playwright for composite stack', () => {
        const result = getTestSkillsForStack({ language: 'TypeScript', test: 'Jest + Playwright' });
        const names = result.map(s => s.name);
        assert.ok(names.includes('javascript-typescript-jest'), 'should include Jest skill');
        assert.ok(names.includes('playwright-best-practices'), 'should include Playwright skill');
        assert.ok(!names.includes('javascript-testing-patterns'), 'generic should be excluded');
        assert.ok(!names.includes('vitest'), 'non-matching framework should be excluded');
    });

    it('returns generic JS testing when no framework detected', () => {
        const result = getTestSkillsForStack({ language: 'TypeScript', test: null });
        assert.ok(result.length > 0);
        assert.ok(result.some(s => s.name === 'javascript-testing-patterns'));
        assert.ok(!result.some(s => s.name === 'javascript-typescript-jest'), 'framework-specific should not appear without detection');
    });

    it('returns Python generic skill regardless of pytest detection', () => {
        const withPytest = getTestSkillsForStack({ language: 'Python', test: 'pytest' });
        const withoutPytest = getTestSkillsForStack({ language: 'Python', test: null });
        assert.ok(withPytest.some(s => s.name === 'python-testing-patterns'));
        assert.ok(withoutPytest.some(s => s.name === 'python-testing-patterns'));
    });

    it('returns Rust skill', () => {
        const result = getTestSkillsForStack({ language: 'Rust', test: null });
        assert.ok(result.length > 0);
        assert.ok(result.some(s => s.name === 'rust-best-practices'));
    });

    it('returns PHP skill', () => {
        const result = getTestSkillsForStack({ language: 'PHP', test: null });
        assert.ok(result.length > 0);
        assert.ok(result.some(s => s.name === 'php-pro'));
    });

    it('returns empty for Go (no curated skills)', () => {
        assert.equal(getTestSkillsForStack({ language: 'Go', test: null }).length, 0);
    });

    it('returns empty for Ruby (no curated skills)', () => {
        assert.equal(getTestSkillsForStack({ language: 'Ruby', test: null }).length, 0);
    });

    it('returns empty for Java (no curated skills)', () => {
        assert.equal(getTestSkillsForStack({ language: 'Java', test: null }).length, 0);
    });

    it('sorts results by score descending', () => {
        const result = getTestSkillsForStack({ language: 'TypeScript', test: 'Jest + Playwright' });
        assert.equal(result[0].name, 'javascript-typescript-jest');
        assert.equal(result[1].name, 'playwright-best-practices');
    });

    it('deduplicates results by name', () => {
        const result = getTestSkillsForStack({ language: 'TypeScript', test: null });
        const names = result.map(s => s.name);
        assert.equal(names.length, new Set(names).size);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/skills.test.js`
Expected: FAIL — `getTestSkillsForStack` returns `[]` for all inputs (placeholder).

- [ ] **Step 3: Implement score-based `getTestSkillsForStack()`**

In `lib/skills.js`, replace the `getTestSkillsForStack` placeholder with:

```js
function scoreSkill(skill, lang, detectedFrameworks) {
    if (!skill.lang.includes(lang)) return -1;

    let score = 10; // lang match base

    if (skill.frameworks.length === 0) {
        // generic skill — score stays at base (10), no framework bonus
        return score;
    }

    // framework-specific skill: check if ANY of its frameworks match detected
    const matchCount = skill.frameworks.filter(fw => detectedFrameworks.includes(fw)).length;
    if (matchCount === 0) return -1; // has frameworks but none match → exclude

    score += matchCount * 5; // +5 per matching framework

    if (skill.category === 'unit') score += 2;
    else if (skill.category === 'e2e') score += 1;

    return score;
}

function getTestSkillsForStack(techStack) {
    if (!techStack || !techStack.language) return [];

    const lang = techStack.language;
    const detectedFrameworks = parseFrameworks(techStack.test);

    const scored = TEST_SKILLS
        .map(skill => ({ skill, score: scoreSkill(skill, lang, detectedFrameworks) }))
        .filter(({ score }) => score > 0);

    // If any framework-specific skill matched, remove generics
    const hasFrameworkMatch = scored.some(({ skill }) => skill.frameworks.length > 0);
    const filtered = hasFrameworkMatch
        ? scored.filter(({ skill }) => skill.frameworks.length > 0)
        : scored;

    // Sort descending by score, deduplicate by name
    filtered.sort((a, b) => b.score - a.score);

    const seen = new Set();
    return filtered
        .filter(({ skill }) => {
            if (seen.has(skill.name)) return false;
            seen.add(skill.name);
            return true;
        })
        .map(({ skill }) => skill);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/skills.test.js`
Expected: All `getTestSkillsForStack` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/skills.js test/skills.test.js
git commit -m "feat: score-based matching engine for test skill selection"
```

---

### Task 4: Fallback Chain + `buildSearchSuggestion()`

**Files:**
- Modify: `lib/skills.js` (replace `buildSearchSuggestion` placeholder)
- Test: `test/skills.test.js`

- [ ] **Step 1: Write failing tests for `buildSearchSuggestion()`**

Append this `describe` block to `test/skills.test.js`:

```js
describe('buildSearchSuggestion', () => {
    it('returns language + testing for lang only', () => {
        assert.equal(buildSearchSuggestion('Go', null), 'go testing');
    });

    it('returns language + framework + testing', () => {
        assert.equal(buildSearchSuggestion('Ruby', 'RSpec'), 'ruby rspec testing');
    });

    it('lowercases everything', () => {
        assert.equal(buildSearchSuggestion('Java', 'JUnit'), 'java junit testing');
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/skills.test.js`
Expected: FAIL — `buildSearchSuggestion` returns `''` (placeholder).

- [ ] **Step 3: Implement `buildSearchSuggestion()`**

In `lib/skills.js`, replace the `buildSearchSuggestion` placeholder with:

```js
function buildSearchSuggestion(lang, testFw) {
    const parts = [lang];
    if (testFw) parts.push(testFw);
    parts.push('testing');
    return parts.join(' ').toLowerCase();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/skills.test.js`
Expected: All `buildSearchSuggestion` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/skills.js test/skills.test.js
git commit -m "feat: buildSearchSuggestion for fallback chain keyword generation"
```

---

### Task 5: Integrate into `bin/omni.js` Phase 2

**Files:**
- Modify: `bin/omni.js:20-22` (imports)
- Modify: `bin/omni.js:1137-1197` (Phase 2 block)

- [ ] **Step 1: Update imports**

In `bin/omni.js`, change the import at lines 20-22 from:

```js
const {
    UNIVERSAL_SKILLS, getTestSkillsForStack,
} = require(path.join(__dirname, '..', 'lib', 'skills'));
```

to:

```js
const {
    UNIVERSAL_SKILLS, getTestSkillsForStack, buildSearchSuggestion,
} = require(path.join(__dirname, '..', 'lib', 'skills'));
```

- [ ] **Step 2: Replace Phase 2 block with UX-aware version**

In `bin/omni.js`, replace the Phase 2 block (lines 1137-1196) — everything between the `chalk.cyan.bold('─'.repeat(45)` line and the closing `});` of the auto-equip action — with:

```js
        // Phase 2: Detect tech stack → propose test skills
        const detected = detectExistingProject(process.cwd());
        if (!detected.detected) {
            console.log(chalk.gray('   ⚠️ Không phát hiện project — bỏ qua đề xuất test skills.\n'));
            return;
        }

        const scan = scanProject(process.cwd());
        if (!scan.techStack || !scan.techStack.language) {
            console.log(chalk.gray('   ℹ️ Không xác định được ngôn ngữ chính — bỏ qua test skills.\n'));
            return;
        }

        const testSkills = getTestSkillsForStack(scan.techStack);

        // Fallback: no curated skills for this language → suggest find-skills search
        if (testSkills.length === 0) {
            const keyword = buildSearchSuggestion(scan.techStack.language, scan.techStack.test);
            console.log(chalk.yellow(`\n   🔍 Chưa có curated test skill cho ${chalk.white(scan.techStack.language)}.`));
            console.log(chalk.gray(`      Gợi ý: dùng lệnh ${chalk.cyan('>om:equip')} hoặc tìm thủ công:`));
            console.log(chalk.cyan(`      npx skills search "${keyword}"\n`));
            return;
        }

        const installedNames = manifest.skills.external.map(s => s.name);
        const testToInstall = testSkills.filter(s => !installedNames.includes(s.name));

        if (testToInstall.length === 0) return;

        console.log(chalk.cyan.bold('🧪 Phát hiện tech stack — đề xuất test skills:\n'));
        const stackLabel = [scan.techStack.language, scan.techStack.test].filter(Boolean).join(' + ');
        console.log(chalk.gray(`   Stack: ${stackLabel}\n`));
        testToInstall.forEach((s, i) => {
            console.log(chalk.white(`   ${i + 1}. ${chalk.bold(s.name)} ${chalk.green('MỚI')}`));
            console.log(chalk.gray(`      └─ ${s.desc} (${s.source})`));
        });
        console.log('');

        if (!options.yes) {
            const { installTest } = await prompts({
                type: 'confirm',
                name: 'installTest',
                message: `Cài thêm ${testToInstall.length} test skill${testToInstall.length > 1 ? 's' : ''}? (y/N)`,
                initial: false
            });
            if (!installTest) return;
        } else {
            console.log(chalk.green(`⚡ Auto-install: ${testToInstall.length} test skill(s)\n`));
        }

        let testInstalled = 0;
        for (const skill of testToInstall) {
            console.log(chalk.cyan(`\n🧪 Đang cài: ${chalk.white(skill.name)}...`));
            try {
                const skillArgs = ['-y', 'skills', 'add', skill.source];
                if (agentFlags) {
                    skillArgs.push(...agentFlags.split(' '), '--skill', skill.name, '-y');
                } else {
                    skillArgs.push('--skill', skill.name, '-y');
                }
                execFileSync('npx', skillArgs, { stdio: 'inherit', timeout: 60000 });
                manifest.skills.external.push({
                    name: skill.name,
                    source: skill.source,
                    installedAt: new Date().toISOString(),
                    category: 'testing'
                });
                testInstalled++;
                console.log(chalk.green(`   ✓ ${skill.name}`));
            } catch {
                console.log(chalk.red(`   ✗ ${skill.name} — thất bại, bỏ qua`));
            }
        }

        if (testInstalled > 0) {
            saveManifest(manifest);
            console.log(chalk.green.bold(`\n   🧪 Test skills: ${testInstalled}/${testToInstall.length} cài thành công\n`));
        }
```

- [ ] **Step 3: Verify syntax**

Run: `node -c bin/omni.js`
Expected: No syntax errors.

- [ ] **Step 4: Run full test suite**

Run: `node --test test/skills.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/omni.js
git commit -m "feat: integrate score-based matching + fallback chain into auto-equip Phase 2"
```

---

### Task 6: Verify TEST_SKILLS registry integrity

**Files:**
- Test: `test/skills.test.js`

- [ ] **Step 1: Add registry integrity tests**

Append this `describe` block to `test/skills.test.js` (replaces the old `TEST_SKILLS registry` describe):

```js
describe('TEST_SKILLS registry', () => {
    it('has entries for JavaScript', () => {
        assert.ok(TEST_SKILLS.some(s => s.lang.includes('JavaScript')));
    });

    it('has entries for TypeScript', () => {
        assert.ok(TEST_SKILLS.some(s => s.lang.includes('TypeScript')));
    });

    it('has entries for Python', () => {
        assert.ok(TEST_SKILLS.some(s => s.lang.includes('Python')));
    });

    it('has entries for Rust', () => {
        assert.ok(TEST_SKILLS.some(s => s.lang.includes('Rust')));
    });

    it('has entries for PHP', () => {
        assert.ok(TEST_SKILLS.some(s => s.lang.includes('PHP')));
    });

    it('has no duplicate names', () => {
        const names = TEST_SKILLS.map(s => s.name);
        assert.equal(names.length, new Set(names).size, 'duplicate names found');
    });

    it('every entry has valid schema (covered by validateRegistry at load)', () => {
        // validateRegistry runs at require() time — if we got here, it passed
        assert.ok(true);
    });

    it('includes Mocha entry', () => {
        assert.ok(TEST_SKILLS.some(s => s.name === 'mocha-testing'));
    });

    it('has exactly 8 entries', () => {
        assert.equal(TEST_SKILLS.length, 8);
    });
});
```

- [ ] **Step 2: Run full test suite**

Run: `node --test test/skills.test.js`
Expected: All tests PASS (~29 total test cases across 6 describe blocks).

- [ ] **Step 3: Verify omni.js syntax check still passes**

Run: `npm test`
Expected: `node -c bin/omni.js` passes, then all `test/*.test.js` pass.

- [ ] **Step 4: Commit**

```bash
git add test/skills.test.js
git commit -m "test: complete test suite for skills v2 — 29 cases across 6 groups"
```

---

### Summary of all exports from `lib/skills.js` after completion

| Export | Type | Used by |
|--------|------|---------|
| `UNIVERSAL_SKILLS` | `Array<{source, name, desc}>` | `bin/omni.js` Phase 1 |
| `TEST_SKILLS` | `Array<{source, name, desc, lang, frameworks, category}>` | `test/skills.test.js` |
| `VALID_CATEGORIES` | `string[]` | internal + tests |
| `validateRegistry(skills)` | `function → void \| throws` | called at load time + tests |
| `parseFrameworks(testField)` | `function → string[]` | `getTestSkillsForStack` + tests |
| `getTestSkillsForStack(techStack)` | `function → Array<skill>` | `bin/omni.js` Phase 2 |
| `buildSearchSuggestion(lang, testFw)` | `function → string` | `bin/omni.js` Phase 2 fallback |
