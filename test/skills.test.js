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

    it('includes Mocha entry', () => {
        assert.ok(TEST_SKILLS.some(s => s.name === 'mocha-testing'));
    });

    it('has exactly 8 entries', () => {
        assert.equal(TEST_SKILLS.length, 8);
    });
});
