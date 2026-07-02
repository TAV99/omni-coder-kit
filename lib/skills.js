const UNIVERSAL_SKILLS = [
    { source: 'vercel-labs/skills', name: 'find-skills', desc: 'Tìm kiếm & cài đặt skills tự động từ skills.sh' },
    { source: 'multica-ai/andrej-karpathy-skills', name: 'karpathy-guidelines', desc: 'Karpathy mindset: Think → Simplify → Surgical → Goal-Driven' },
    { source: 'obra/superpowers', name: 'brainstorming', desc: 'Brainstorm ý tưởng và phân tích yêu cầu có hệ thống' },
    { source: 'obra/superpowers', name: 'writing-plans', desc: 'Viết kế hoạch triển khai chi tiết, có cấu trúc' },
    { source: 'obra/superpowers', name: 'executing-plans', desc: 'Thực thi kế hoạch từng bước, theo dõi tiến độ' },
    { source: 'obra/superpowers', name: 'systematic-debugging', desc: 'Debugging có hệ thống' },
    { source: 'obra/superpowers', name: 'test-driven-development', desc: 'Phát triển hướng test (TDD)' },
    { source: 'obra/superpowers', name: 'requesting-code-review', desc: 'Quy trình review code chuyên nghiệp' },
    { source: 'obra/superpowers', name: 'receiving-code-review', desc: 'Tiếp nhận và xử lý feedback từ code review' },
    { source: 'obra/superpowers', name: 'using-git-worktrees', desc: 'Quản lý Git worktrees hiệu quả' },
    { source: 'obra/superpowers', name: 'finishing-a-development-branch', desc: 'Hoàn tất branch phát triển — merge, cleanup, close' },
    { source: 'obra/superpowers', name: 'dispatching-parallel-agents', desc: 'Điều phối nhiều agent chạy song song hiệu quả' },
    { source: 'obra/superpowers', name: 'subagent-driven-development', desc: 'Phát triển dựa trên sub-agent — phân rã và uỷ thác task' },
    { source: 'obra/superpowers', name: 'verification-before-completion', desc: 'Kiểm chứng kỹ trước khi đánh dấu hoàn thành' },
    { source: 'obra/superpowers', name: 'using-superpowers', desc: 'Hướng dẫn sử dụng framework Superpowers tổng thể' },
    { source: 'obra/superpowers', name: 'writing-skills', desc: 'Viết skill mới theo chuẩn Superpowers' },
];

const UI_SKILLS = [
    { source: 'Leonxlnx/taste-skill/skills/gpt-tasteskill', name: 'design-taste-frontend', desc: 'Anti-slop frontend skill for landing pages, portfolios, and redesigns', lang: ['JavaScript', 'TypeScript', 'HTML', 'CSS'], frameworks: [], category: 'generic' },
    { source: 'Leonxlnx/taste-skill/skills/minimalist-skill', name: 'minimalist-ui', desc: 'Clean warm monochrome editorial-style interfaces, flat bento, no heavy shadows', lang: ['JavaScript', 'TypeScript', 'HTML', 'CSS'], frameworks: [], category: 'generic' },
    { source: 'Leonxlnx/taste-skill/skills/brutalist-skill', name: 'industrial-brutalist-ui', desc: 'Swiss typographic print fused with military/CRT terminal aesthetics, rigid grids', lang: ['JavaScript', 'TypeScript', 'HTML', 'CSS'], frameworks: [], category: 'generic' },
    { source: 'Leonxlnx/taste-skill/skills/soft-skill', name: 'high-end-visual-design', desc: 'Agency-level digital experiences, haptic depth, fluid motion, custom typography', lang: ['JavaScript', 'TypeScript', 'HTML', 'CSS'], frameworks: [], category: 'generic' },
];

const VALID_CATEGORIES = ['unit', 'e2e', 'integration', 'generic'];

const TEST_SKILLS = [
    { source: 'github/awesome-copilot', name: 'javascript-typescript-jest', desc: 'Jest best practices cho JS/TS — mocking, async, matchers, React Testing Library', lang: ['JavaScript', 'TypeScript'], frameworks: ['Jest'], category: 'unit' },
    { source: 'antfu/skills', name: 'vitest', desc: 'Vitest 3.x — ESM native, Jest-compatible API, coverage, type testing', lang: ['JavaScript', 'TypeScript'], frameworks: ['Vitest'], category: 'unit' },
    // Mocha không có skill chuyên dụng còn sống trên skills.sh (nguồn cũ nicolo-ribaudo/skills đã 404 — xem skills:doctor).
    // Project Mocha rơi về skill generic 'javascript-testing-patterns' + gợi ý dynamic find-skills ("javascript mocha testing").
    { source: 'wshobson/agents', name: 'javascript-testing-patterns', desc: 'JS/TS testing patterns — Jest + Vitest + Mocha, mocking, AAA pattern, integration tests', lang: ['JavaScript', 'TypeScript'], frameworks: [], category: 'generic' },
    { source: 'currents-dev/playwright-best-practices-skill', name: 'playwright-best-practices', desc: 'Playwright E2E — 50+ patterns, multi-browser, visual regression, CI/CD', lang: ['JavaScript', 'TypeScript'], frameworks: ['Playwright'], category: 'e2e' },
    { source: 'wshobson/agents', name: 'python-testing-patterns', desc: 'pytest patterns — fixtures, parametrize, async, property-based testing', lang: ['Python'], frameworks: [], category: 'generic' },
    { source: 'apollographql/skills', name: 'rust-best-practices', desc: 'Rust best practices — testing, error handling, clippy, performance', lang: ['Rust'], frameworks: [], category: 'generic' },
    { source: 'jeffallan/claude-skills', name: 'php-pro', desc: 'PHP 8.3+ — PHPUnit, Pest, PSR-12, PHPStan, Laravel, Symfony', lang: ['PHP'], frameworks: [], category: 'generic' },
];

function validateRegistry(skills, registryName = 'skills') {
    const seen = new Set();
    for (const [i, s] of skills.entries()) {
        const p = `${registryName}[${i}]`;
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

validateRegistry(UI_SKILLS, 'UI_SKILLS');
validateRegistry(TEST_SKILLS, 'TEST_SKILLS');

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

// ---------------------------------------------------------------------------
// SHIP Skills Registry (pha SHIP — deploy lifecycle)
// Nguồn: addyosmani/agent-skills (MIT). Universal — không phụ thuộc framework.
// ---------------------------------------------------------------------------

const SHIP_VALID_CATEGORIES = ['vcs', 'cicd', 'release', 'docs', 'deprecation'];

const SHIP_SKILLS = [
    { source: 'addyosmani/agent-skills', name: 'git-workflow-and-versioning', desc: 'Trunk-based dev, atomic commits, change sizing ~100 dòng, commit-as-save-point', category: 'vcs' },
    { source: 'addyosmani/agent-skills', name: 'ci-cd-and-automation', desc: 'Shift Left, feature flags, quality gate pipeline, failure feedback loop', category: 'cicd' },
    { source: 'addyosmani/agent-skills', name: 'shipping-and-launch', desc: 'Pre-launch checklist, staged rollout, rollback procedure, monitoring setup', category: 'release' },
    { source: 'addyosmani/agent-skills', name: 'documentation-and-adrs', desc: 'ADR, API docs, ghi lại *why* của quyết định kiến trúc', category: 'docs' },
    { source: 'addyosmani/agent-skills', name: 'deprecation-and-migration', desc: 'Code-as-liability, deprecation bắt buộc/khuyến nghị, migration, dọn zombie code', category: 'deprecation' },
];

function validateShipRegistry(skills) {
    const seen = new Set();
    for (const [i, s] of skills.entries()) {
        const p = `SHIP_SKILLS[${i}]`;
        if (!s.source || typeof s.source !== 'string') throw new Error(`${p}: missing/invalid 'source'`);
        if (!s.name || typeof s.name !== 'string') throw new Error(`${p}: missing/invalid 'name'`);
        if (!s.desc || typeof s.desc !== 'string') throw new Error(`${p}: missing/invalid 'desc'`);
        if (!SHIP_VALID_CATEGORIES.includes(s.category)) throw new Error(`${p}: invalid category '${s.category}'`);
        if (seen.has(s.name)) throw new Error(`${p}: duplicate name '${s.name}'`);
        seen.add(s.name);
    }
}

validateShipRegistry(SHIP_SKILLS);

// Ship skill là universal: đề xuất khi đã nhận diện được project (có ngôn ngữ chính).
function getShipSkillsForStack(techStack) {
    if (!techStack || !techStack.language) return [];
    return SHIP_SKILLS;
}

// ---------------------------------------------------------------------------
// QUALITY Skills Registry (Tier-2 — BUILD/VERIFY/REVIEW chuyên sâu, Route A)
// Nguồn: addyosmani/agent-skills (MIT). Universal — không phụ thuộc framework.
// Xem docs/ADOPT-FROM-ADDYOSMANI.md §3 (T2.1, T2.2, T2.5, T2.6).
// ---------------------------------------------------------------------------

const QUALITY_VALID_CATEGORIES = ['build', 'verify', 'review'];

const QUALITY_SKILLS = [
    { source: 'addyosmani/agent-skills', name: 'context-engineering', desc: 'Quản context đúng lúc — progressive disclosure, just-in-time, chống context rot', category: 'build' },
    { source: 'addyosmani/agent-skills', name: 'source-driven-development', desc: 'Ground quyết định vào docs chính thức + cite nguồn — chống hallucination', category: 'build' },
    { source: 'addyosmani/agent-skills', name: 'api-and-interface-design', desc: 'Thiết kế API/interface — contract-first, versioning, backward compat', category: 'build' },
    { source: 'addyosmani/agent-skills', name: 'browser-testing-with-devtools', desc: 'Verify runtime thật qua Chrome DevTools MCP — DOM, console, network, perf', category: 'verify' },
];

function validateQualityRegistry(skills) {
    const seen = new Set();
    for (const [i, s] of skills.entries()) {
        const p = `QUALITY_SKILLS[${i}]`;
        if (!s.source || typeof s.source !== 'string') throw new Error(`${p}: missing/invalid 'source'`);
        if (!s.name || typeof s.name !== 'string') throw new Error(`${p}: missing/invalid 'name'`);
        if (!s.desc || typeof s.desc !== 'string') throw new Error(`${p}: missing/invalid 'desc'`);
        if (!QUALITY_VALID_CATEGORIES.includes(s.category)) throw new Error(`${p}: invalid category '${s.category}'`);
        if (seen.has(s.name)) throw new Error(`${p}: duplicate name '${s.name}'`);
        seen.add(s.name);
    }
}

validateQualityRegistry(QUALITY_SKILLS);

// Quality skill là universal: đề xuất khi đã nhận diện được project (có ngôn ngữ chính).
function getQualitySkillsForStack(techStack) {
    if (!techStack || !techStack.language) return [];
    return QUALITY_SKILLS;
}

module.exports = {
    UNIVERSAL_SKILLS, TEST_SKILLS, VALID_CATEGORIES,
    UI_SKILLS,
    FE_SKILLS, FE_VALID_CATEGORIES,
    SHIP_SKILLS, SHIP_VALID_CATEGORIES,
    QUALITY_SKILLS, QUALITY_VALID_CATEGORIES,
    validateRegistry, validateFERegistry, validateShipRegistry, validateQualityRegistry, parseFrameworks,
    getTestSkillsForStack, getFESkillsForStack, getShipSkillsForStack, getQualitySkillsForStack,
    scoreFESkill, buildSearchSuggestion,
};
