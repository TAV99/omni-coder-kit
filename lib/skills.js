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

function scoreSkill(skill, lang, detectedFrameworks) {
    if (!skill.lang.includes(lang)) return -1;

    let score = 10; // lang match base

    if (skill.frameworks.length === 0) {
        return score;
    }

    const matchCount = skill.frameworks.filter(fw => detectedFrameworks.includes(fw)).length;
    if (matchCount === 0) return -1;

    score += matchCount * 5;

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

    const hasFrameworkMatch = scored.some(({ skill }) => skill.frameworks.length > 0);
    const filtered = hasFrameworkMatch
        ? scored.filter(({ skill }) => skill.frameworks.length > 0)
        : scored;

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

function buildSearchSuggestion(lang, testFw) {
    const parts = [lang];
    if (testFw) parts.push(testFw);
    parts.push('testing');
    return parts.join(' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// FE Skills Registry
// ---------------------------------------------------------------------------

const FE_VALID_CATEGORIES = ['component', 'styling', 'state', 'build', 'ssr', 'animation', 'design', 'generic'];

const FE_SKILLS = [
    // React
    { source: 'vercel-labs/agent-skills', name: 'vercel-react-best-practices', desc: 'React perf — Server Components, hooks, memoization, bundle optimization (Vercel)', ui: ['React'], frameworks: [], deps: [], category: 'component' },
    { source: 'wshobson/agents', name: 'react-state-management', desc: 'React state patterns — Context, Zustand, Redux Toolkit, server state', ui: ['React'], frameworks: [], deps: [], category: 'state' },

    // Next.js
    { source: 'vercel-labs/next-skills', name: 'next-best-practices', desc: 'Next.js App Router + Pages Router — SSR, ISR, caching, middleware', ui: [], frameworks: ['Next.js'], deps: [], category: 'ssr' },
    { source: 'wshobson/agents', name: 'nextjs-app-router-patterns', desc: 'Next.js App Router — RSC, streaming, parallel routes, intercepting routes', ui: [], frameworks: ['Next.js'], deps: [], category: 'ssr' },

    // Vue
    { source: 'antfu/skills', name: 'vue', desc: 'Vue 3 Composition API — reactivity, SFC, composables, Teleport, Suspense', ui: ['Vue'], frameworks: [], deps: [], category: 'component' },
    { source: 'vuejs-ai/skills', name: 'vue-pinia-best-practices', desc: 'Vue + Pinia — store patterns, composables, SSR state hydration', ui: ['Vue'], frameworks: [], deps: [], category: 'state' },

    // Nuxt
    { source: 'antfu/skills', name: 'nuxt', desc: 'Nuxt 3 — auto-imports, server routes, composables, layers, modules', ui: [], frameworks: ['Nuxt'], deps: [], category: 'ssr' },

    // Svelte
    { source: 'sveltejs/ai-tools', name: 'svelte-code-writer', desc: 'Svelte 5 + SvelteKit — runes, stores, transitions, SSR', ui: ['Svelte'], frameworks: [], deps: [], category: 'component' },

    // Angular
    { source: 'analogjs/angular-skills', name: 'angular-component', desc: 'Angular — signals, standalone components, DI, forms, routing', ui: ['Angular'], frameworks: [], deps: [], category: 'component' },

    // Tailwind
    { source: 'wshobson/agents', name: 'tailwind-design-system', desc: 'Tailwind CSS — utility-first patterns, responsive, dark mode, design tokens', ui: [], frameworks: [], deps: ['tailwindcss'], category: 'styling' },

    // Build
    { source: 'antfu/skills', name: 'vite', desc: 'Vite — HMR, plugins, SSR, library mode, env variables', ui: [], frameworks: [], deps: ['vite'], category: 'build' },

    // Animation
    { source: 'patricio0312rev/skills', name: 'framer-motion-animator', desc: 'Framer Motion — layout animations, gestures, exit animations, variants', ui: ['React'], frameworks: [], deps: ['framer-motion'], category: 'animation' },

    // Generic FE
    { source: 'addyosmani/agent-skills', name: 'frontend-ui-engineering', desc: 'Frontend engineering — performance, accessibility, architecture, web vitals', ui: [], frameworks: [], deps: [], category: 'generic' },
    { source: 'addyosmani/web-quality-skills', name: 'web-quality', desc: 'Web quality — Core Web Vitals, accessibility audit, performance budget', ui: [], frameworks: [], deps: [], category: 'generic' },
];

function validateFERegistry(skills) {
    const seen = new Set();
    for (const [i, s] of skills.entries()) {
        const p = `FE_SKILLS[${i}]`;
        if (!s.source || typeof s.source !== 'string') throw new Error(`${p}: missing/invalid 'source'`);
        if (!s.name || typeof s.name !== 'string') throw new Error(`${p}: missing/invalid 'name'`);
        if (!s.desc || typeof s.desc !== 'string') throw new Error(`${p}: missing/invalid 'desc'`);
        if (!Array.isArray(s.ui)) throw new Error(`${p}: 'ui' must be array`);
        if (!Array.isArray(s.frameworks)) throw new Error(`${p}: 'frameworks' must be array`);
        if (!Array.isArray(s.deps)) throw new Error(`${p}: 'deps' must be array`);
        if (!FE_VALID_CATEGORIES.includes(s.category)) throw new Error(`${p}: invalid category '${s.category}'`);
        if (seen.has(s.name)) throw new Error(`${p}: duplicate name '${s.name}'`);
        seen.add(s.name);
    }
}

validateFERegistry(FE_SKILLS);

function scoreFESkill(skill, detectedUI, detectedFramework, projectDeps) {
    let score = 0;
    let hasMatch = false;

    if (skill.ui.length > 0) {
        const match = skill.ui.some(u => detectedUI.includes(u));
        if (match) { score += 10; hasMatch = true; }
    }

    if (skill.frameworks.length > 0) {
        if (skill.frameworks.includes(detectedFramework)) { score += 10; hasMatch = true; }
    }

    if (skill.deps.length > 0) {
        const match = skill.deps.some(d => d in projectDeps);
        if (match) { score += 5; hasMatch = true; }
    }

    if (skill.ui.length === 0 && skill.frameworks.length === 0 && skill.deps.length === 0) {
        if (detectedUI.length > 0) { score = 5; hasMatch = true; }
    }

    if (!hasMatch) return -1;

    if (skill.category === 'component') score += 2;
    else if (skill.category === 'ssr') score += 2;
    else if (skill.category === 'styling') score += 1;

    return score;
}

function getFESkillsForStack(techStack, projectDir) {
    if (!techStack) return [];

    const detectedUI = techStack.ui
        ? techStack.ui.split(/\s*\+\s*/).map(s => s.trim()).filter(Boolean)
        : [];
    const detectedFramework = techStack.framework || '';

    let projectDeps = {};
    if (projectDir) {
        try {
            const fs = require('fs');
            const path = require('path');
            const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
            projectDeps = { ...pkg.dependencies, ...pkg.devDependencies };
        } catch {}
    }

    if (detectedUI.length === 0 && !detectedFramework && Object.keys(projectDeps).length === 0) return [];

    const scored = FE_SKILLS
        .map(skill => ({ skill, score: scoreFESkill(skill, detectedUI, detectedFramework, projectDeps) }))
        .filter(({ score }) => score > 0);

    scored.sort((a, b) => b.score - a.score);

    const seen = new Set();
    return scored
        .filter(({ skill }) => {
            if (seen.has(skill.name)) return false;
            seen.add(skill.name);
            return true;
        })
        .map(({ skill }) => skill);
}

module.exports = {
    UNIVERSAL_SKILLS, TEST_SKILLS, VALID_CATEGORIES,
    FE_SKILLS, FE_VALID_CATEGORIES,
    validateRegistry, validateFERegistry, parseFrameworks,
    getTestSkillsForStack, getFESkillsForStack,
    scoreFESkill, buildSearchSuggestion,
};
