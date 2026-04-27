const UNIVERSAL_SKILLS = [
    { source: 'vercel-labs/skills', name: 'find-skills', desc: 'Tìm kiếm & cài đặt skills tự động từ skills.sh' },
    { source: 'forrestchang/andrej-karpathy-skills', name: 'karpathy-guidelines', desc: 'Karpathy mindset: Think → Simplify → Surgical → Goal-Driven' },
    { source: 'obra/superpowers', name: 'systematic-debugging', desc: 'Debugging có hệ thống' },
    { source: 'obra/superpowers', name: 'test-driven-development', desc: 'Phát triển hướng test (TDD)' },
    { source: 'obra/superpowers', name: 'requesting-code-review', desc: 'Quy trình review code chuyên nghiệp' },
    { source: 'obra/superpowers', name: 'using-git-worktrees', desc: 'Quản lý Git worktrees hiệu quả' },
];

// Curated test skills per language/test-framework detected by scanner.
// Each entry: { source, name, desc, lang, testFramework }
// lang matches scanner's techStack.language; testFramework matches techStack.test
const TEST_SKILLS = [
    // JavaScript / TypeScript — Jest
    { source: 'github/awesome-copilot', name: 'javascript-typescript-jest', desc: 'Jest best practices cho JS/TS — mocking, async, matchers, React Testing Library', lang: ['JavaScript', 'TypeScript'], testFramework: 'Jest' },
    // JavaScript / TypeScript — Vitest
    { source: 'antfu/skills', name: 'vitest', desc: 'Vitest 3.x — ESM native, Jest-compatible API, coverage, type testing', lang: ['JavaScript', 'TypeScript'], testFramework: 'Vitest' },
    // JavaScript / TypeScript — generic (no specific framework detected)
    { source: 'wshobson/agents', name: 'javascript-testing-patterns', desc: 'JS/TS testing patterns — Jest + Vitest, mocking, AAA pattern, integration tests', lang: ['JavaScript', 'TypeScript'], testFramework: null },
    // Playwright (cross-language but mostly JS/TS)
    { source: 'currents-dev/playwright-best-practices-skill', name: 'playwright-best-practices', desc: 'Playwright E2E — 50+ patterns, multi-browser, visual regression, CI/CD', lang: ['JavaScript', 'TypeScript'], testFramework: 'Playwright' },
    // Python — pytest
    { source: 'wshobson/agents', name: 'python-testing-patterns', desc: 'pytest patterns — fixtures, parametrize, async, property-based testing', lang: ['Python'], testFramework: 'pytest' },
    // Python — generic (no specific framework detected)
    { source: 'wshobson/agents', name: 'python-testing-patterns', desc: 'pytest patterns — fixtures, parametrize, async, property-based testing', lang: ['Python'], testFramework: null },
    // Rust — includes testing chapter
    { source: 'apollographql/skills', name: 'rust-best-practices', desc: 'Rust best practices — testing, error handling, clippy, performance', lang: ['Rust'], testFramework: null },
    // PHP — includes PHPUnit/Pest
    { source: 'jeffallan/claude-skills', name: 'php-pro', desc: 'PHP 8.3+ — PHPUnit, Pest, PSR-12, PHPStan, Laravel, Symfony', lang: ['PHP'], testFramework: null },
];

// Returns curated test skills matching the detected tech stack.
// techStack: { language, test, ... } from scanner.detectTechStack()
// Returns array of { source, name, desc } — deduplicated, best match first.
function getTestSkillsForStack(techStack) {
    if (!techStack || !techStack.language) return [];

    const lang = techStack.language;
    const testFw = techStack.test || null;

    // 1. Find exact match: language + testFramework
    const exact = TEST_SKILLS.filter(s =>
        s.lang.includes(lang) && s.testFramework && testFw && s.testFramework === testFw
    );

    // 2. Find fallback: language + testFramework=null (generic for that lang)
    const fallback = TEST_SKILLS.filter(s =>
        s.lang.includes(lang) && s.testFramework === null
    );

    // 3. Find Playwright if detected alongside other test frameworks
    const playwright = testFw && testFw.includes('Playwright')
        ? TEST_SKILLS.filter(s => s.testFramework === 'Playwright')
        : [];

    // Merge: exact first, then playwright addon, then fallback (only if no exact match)
    const merged = [...exact, ...playwright];
    if (exact.length === 0) merged.push(...fallback);

    // Deduplicate by name
    const seen = new Set();
    return merged.filter(s => {
        if (seen.has(s.name)) return false;
        seen.add(s.name);
        return true;
    });
}

module.exports = { UNIVERSAL_SKILLS, TEST_SKILLS, getTestSkillsForStack };
