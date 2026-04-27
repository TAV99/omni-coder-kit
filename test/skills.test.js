const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { UNIVERSAL_SKILLS, TEST_SKILLS, getTestSkillsForStack } = require('../lib/skills');

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

    it('every entry has source, name, desc, lang array', () => {
        for (const s of TEST_SKILLS) {
            assert.ok(s.source, `${s.name} missing source`);
            assert.ok(s.name, 'missing name');
            assert.ok(s.desc, `${s.name} missing desc`);
            assert.ok(Array.isArray(s.lang), `${s.name} lang should be array`);
            assert.ok(s.lang.length > 0, `${s.name} lang should not be empty`);
        }
    });
});

describe('getTestSkillsForStack', () => {
    it('returns empty for null stack', () => {
        assert.deepEqual(getTestSkillsForStack(null), []);
    });

    it('returns empty for stack without language', () => {
        assert.deepEqual(getTestSkillsForStack({ language: null }), []);
    });

    it('returns Jest skill for TypeScript + Jest stack', () => {
        const result = getTestSkillsForStack({ language: 'TypeScript', test: 'Jest' });
        assert.ok(result.length > 0);
        assert.ok(result.some(s => s.name === 'javascript-typescript-jest'));
    });

    it('returns Vitest skill for TypeScript + Vitest stack', () => {
        const result = getTestSkillsForStack({ language: 'TypeScript', test: 'Vitest' });
        assert.ok(result.length > 0);
        assert.ok(result.some(s => s.name === 'vitest'));
    });

    it('returns generic JS testing for TypeScript with no test framework', () => {
        const result = getTestSkillsForStack({ language: 'TypeScript', test: null });
        assert.ok(result.length > 0);
        assert.ok(result.some(s => s.name === 'javascript-testing-patterns'));
    });

    it('returns pytest skill for Python + pytest', () => {
        const result = getTestSkillsForStack({ language: 'Python', test: 'pytest' });
        assert.ok(result.length > 0);
        assert.ok(result.some(s => s.name === 'python-testing-patterns'));
    });

    it('returns Python fallback when no test framework detected', () => {
        const result = getTestSkillsForStack({ language: 'Python', test: null });
        assert.ok(result.length > 0);
        assert.ok(result.some(s => s.name === 'python-testing-patterns'));
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

    it('returns empty for Go (no skills available)', () => {
        const result = getTestSkillsForStack({ language: 'Go', test: null });
        assert.equal(result.length, 0);
    });

    it('returns empty for Ruby (no skills available)', () => {
        const result = getTestSkillsForStack({ language: 'Ruby', test: null });
        assert.equal(result.length, 0);
    });

    it('returns empty for Java (no skills available)', () => {
        const result = getTestSkillsForStack({ language: 'Java', test: null });
        assert.equal(result.length, 0);
    });

    it('returns Playwright for stack with Playwright', () => {
        const result = getTestSkillsForStack({ language: 'TypeScript', test: 'Jest + Playwright' });
        assert.ok(result.some(s => s.name === 'playwright-best-practices'));
    });

    it('deduplicates results by name', () => {
        const result = getTestSkillsForStack({ language: 'Python', test: null });
        const names = result.map(s => s.name);
        const unique = [...new Set(names)];
        assert.equal(names.length, unique.length, 'should not have duplicate names');
    });

    it('returns JavaScript skills for plain JavaScript stack', () => {
        const result = getTestSkillsForStack({ language: 'JavaScript', test: 'Jest' });
        assert.ok(result.some(s => s.name === 'javascript-typescript-jest'));
    });
});
