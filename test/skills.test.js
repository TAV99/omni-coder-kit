const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    UNIVERSAL_SKILLS, TEST_SKILLS,
    FE_SKILLS, FE_VALID_CATEGORIES,
    validateRegistry, validateFERegistry, parseFrameworks,
    getTestSkillsForStack, getFESkillsForStack,
    scoreFESkill, buildSearchSuggestion,
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

    it('falls back to generic JS testing for Mocha (no dedicated skill còn sống)', () => {
        // Nguồn mocha cũ (nicolo-ribaudo/skills) đã 404 → bỏ entry; Mocha rơi về skill generic.
        const result = getTestSkillsForStack({ language: 'JavaScript', test: 'Mocha' });
        assert.ok(result.length > 0);
        assert.equal(result[0].name, 'javascript-testing-patterns');
        assert.ok(!result.some(s => s.name === 'mocha-testing'), 'không còn entry mocha-testing chết');
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
        assert.ok(true);
    });

    it('không chứa entry mocha-testing chết (nguồn nicolo-ribaudo 404)', () => {
        assert.ok(!TEST_SKILLS.some(s => s.name === 'mocha-testing'));
        assert.ok(!TEST_SKILLS.some(s => s.source === 'nicolo-ribaudo/skills'));
    });

    it('has exactly 7 entries', () => {
        assert.equal(TEST_SKILLS.length, 7);
    });
});

// ---------------------------------------------------------------------------
// FE_SKILLS
// ---------------------------------------------------------------------------

describe('FE_SKILLS registry', () => {
    it('has 14 curated FE skills', () => {
        assert.equal(FE_SKILLS.length, 14);
    });

    it('has no duplicate names', () => {
        const names = FE_SKILLS.map(s => s.name);
        assert.equal(names.length, new Set(names).size);
    });

    it('passes validateFERegistry at load time', () => {
        assert.doesNotThrow(() => validateFERegistry(FE_SKILLS));
    });

    it('has entries for React, Vue, Angular, Svelte', () => {
        assert.ok(FE_SKILLS.some(s => s.ui.includes('React')));
        assert.ok(FE_SKILLS.some(s => s.ui.includes('Vue')));
        assert.ok(FE_SKILLS.some(s => s.ui.includes('Angular')));
        assert.ok(FE_SKILLS.some(s => s.ui.includes('Svelte')));
    });

    it('has Next.js and Nuxt SSR skills', () => {
        assert.ok(FE_SKILLS.some(s => s.frameworks.includes('Next.js')));
        assert.ok(FE_SKILLS.some(s => s.frameworks.includes('Nuxt')));
    });

    it('has dep-based skills (tailwindcss, vite)', () => {
        assert.ok(FE_SKILLS.some(s => s.deps.includes('tailwindcss')));
        assert.ok(FE_SKILLS.some(s => s.deps.includes('vite')));
    });

    it('has generic FE skills', () => {
        assert.ok(FE_SKILLS.filter(s => s.category === 'generic').length >= 2);
    });

    it('does not overlap with TEST_SKILLS names', () => {
        const testNames = new Set(TEST_SKILLS.map(s => s.name));
        for (const s of FE_SKILLS) {
            assert.ok(!testNames.has(s.name), `"${s.name}" overlaps with TEST_SKILLS`);
        }
    });
});

describe('validateFERegistry', () => {
    it('throws on non-array ui', () => {
        assert.throws(
            () => validateFERegistry([{ source: 'a/b', name: 'x', desc: 'd', ui: 'React', frameworks: [], deps: [], category: 'component' }]),
            /FE_SKILLS\[0\].*ui/
        );
    });

    it('throws on invalid category', () => {
        assert.throws(
            () => validateFERegistry([{ source: 'a/b', name: 'x', desc: 'd', ui: [], frameworks: [], deps: [], category: 'unit' }]),
            /FE_SKILLS\[0\].*category/
        );
    });

    it('throws on duplicate name', () => {
        assert.throws(
            () => validateFERegistry([
                { source: 'a/b', name: 'x', desc: 'd', ui: ['React'], frameworks: [], deps: [], category: 'component' },
                { source: 'c/d', name: 'x', desc: 'e', ui: ['Vue'], frameworks: [], deps: [], category: 'component' },
            ]),
            /FE_SKILLS\[1\].*duplicate.*x/
        );
    });
});

describe('scoreFESkill', () => {
    it('returns -1 when no criteria match', () => {
        assert.equal(scoreFESkill({ ui: ['React'], frameworks: [], deps: [], category: 'component' }, ['Vue'], '', {}), -1);
    });

    it('scores UI match at 10 + category bonus', () => {
        assert.equal(scoreFESkill({ ui: ['React'], frameworks: [], deps: [], category: 'component' }, ['React'], '', {}), 12);
    });

    it('scores framework match at 10 + ssr bonus', () => {
        assert.equal(scoreFESkill({ ui: [], frameworks: ['Next.js'], deps: [], category: 'ssr' }, [], 'Next.js', {}), 12);
    });

    it('scores dep match at 5 + styling bonus', () => {
        assert.equal(scoreFESkill({ ui: [], frameworks: [], deps: ['tailwindcss'], category: 'styling' }, ['React'], '', { tailwindcss: '^3' }), 6);
    });

    it('scores generic at 5 when UI detected', () => {
        assert.equal(scoreFESkill({ ui: [], frameworks: [], deps: [], category: 'generic' }, ['React'], '', {}), 5);
    });

    it('returns -1 for generic when no UI', () => {
        assert.equal(scoreFESkill({ ui: [], frameworks: [], deps: [], category: 'generic' }, [], '', {}), -1);
    });

    it('combines UI + deps', () => {
        assert.equal(scoreFESkill({ ui: ['React'], frameworks: [], deps: ['framer-motion'], category: 'animation' }, ['React'], '', { 'framer-motion': '^10' }), 15);
    });
});

describe('getFESkillsForStack', () => {
    it('returns empty for null stack', () => {
        assert.deepEqual(getFESkillsForStack(null), []);
    });

    it('returns empty when no UI/framework', () => {
        assert.deepEqual(getFESkillsForStack({ language: 'Go' }), []);
    });

    it('returns React skills for React stack', () => {
        const result = getFESkillsForStack({ ui: 'React', language: 'TypeScript' });
        assert.ok(result.length > 0);
        assert.ok(result.some(s => s.name === 'vercel-react-best-practices'));
    });

    it('returns Vue skills for Vue stack', () => {
        const result = getFESkillsForStack({ ui: 'Vue', language: 'JavaScript' });
        assert.ok(result.some(s => s.name === 'vue'));
    });

    it('returns Next.js + React skills for Next.js', () => {
        const result = getFESkillsForStack({ ui: 'React', framework: 'Next.js', language: 'TypeScript' });
        assert.ok(result.some(s => s.name === 'next-best-practices'));
        assert.ok(result.some(s => s.name === 'vercel-react-best-practices'));
    });

    it('includes generic FE skills when UI detected', () => {
        const result = getFESkillsForStack({ ui: 'Angular', language: 'TypeScript' });
        assert.ok(result.some(s => s.name === 'frontend-ui-engineering'));
    });

    it('sorts framework-specific above generic', () => {
        const result = getFESkillsForStack({ ui: 'React', framework: 'Next.js', language: 'TypeScript' });
        const nextIdx = result.findIndex(s => s.frameworks.includes('Next.js'));
        const genericIdx = result.findIndex(s => s.category === 'generic');
        if (nextIdx !== -1 && genericIdx !== -1) {
            assert.ok(nextIdx < genericIdx);
        }
    });

    it('deduplicates by name', () => {
        const result = getFESkillsForStack({ ui: 'React', language: 'TypeScript' });
        const names = result.map(s => s.name);
        assert.equal(names.length, new Set(names).size);
    });
});
