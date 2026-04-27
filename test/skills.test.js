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
