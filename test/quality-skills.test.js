'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
    QUALITY_SKILLS, QUALITY_VALID_CATEGORIES, validateQualityRegistry, getQualitySkillsForStack,
} = require('../lib/skills');

test('QUALITY_SKILLS: registry hợp lệ', () => {
    assert.doesNotThrow(() => validateQualityRegistry(QUALITY_SKILLS));
    assert.ok(QUALITY_SKILLS.length >= 4, 'cần đủ Tier-2 quality skill');
    const names = QUALITY_SKILLS.map(s => s.name);
    assert.strictEqual(new Set(names).size, names.length, 'tên skill duy nhất');
    for (const s of QUALITY_SKILLS) {
        assert.ok(QUALITY_VALID_CATEGORIES.includes(s.category));
        assert.strictEqual(s.source, 'addyosmani/agent-skills');
    }
});

test('QUALITY_SKILLS: phủ Tier-2 (BUILD + VERIFY)', () => {
    const names = QUALITY_SKILLS.map(s => s.name);
    for (const required of [
        'context-engineering',
        'source-driven-development',
        'api-and-interface-design',
        'browser-testing-with-devtools',
    ]) {
        assert.ok(names.includes(required), `thiếu quality skill: ${required}`);
    }
});

test('getQualitySkillsForStack: universal — trả về khi có ngôn ngữ', () => {
    assert.deepStrictEqual(getQualitySkillsForStack(null), []);
    assert.deepStrictEqual(getQualitySkillsForStack({}), []);
    assert.strictEqual(getQualitySkillsForStack({ language: 'TypeScript' }).length, QUALITY_SKILLS.length);
});

test('validateQualityRegistry: bắt category sai', () => {
    assert.throws(() => validateQualityRegistry([
        { source: 'x/y', name: 'z', desc: 'd', category: 'không-hợp-lệ' },
    ]), /invalid category/);
});
