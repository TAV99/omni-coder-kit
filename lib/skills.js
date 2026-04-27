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
