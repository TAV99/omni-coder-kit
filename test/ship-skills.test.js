'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
    SHIP_SKILLS, SHIP_VALID_CATEGORIES, validateShipRegistry, getShipSkillsForStack,
} = require('../lib/skills');

test('SHIP_SKILLS: registry hợp lệ', () => {
    assert.doesNotThrow(() => validateShipRegistry(SHIP_SKILLS));
    assert.ok(SHIP_SKILLS.length >= 5, 'cần đủ 5 ship skill cốt lõi');
    const names = SHIP_SKILLS.map(s => s.name);
    assert.strictEqual(new Set(names).size, names.length, 'tên skill duy nhất');
    for (const s of SHIP_SKILLS) {
        assert.ok(SHIP_VALID_CATEGORIES.includes(s.category));
        assert.strictEqual(s.source, 'addyosmani/agent-skills');
    }
});

test('SHIP_SKILLS: phủ đủ deploy lifecycle', () => {
    const names = SHIP_SKILLS.map(s => s.name);
    for (const required of [
        'git-workflow-and-versioning',
        'ci-cd-and-automation',
        'shipping-and-launch',
        'documentation-and-adrs',
        'deprecation-and-migration',
    ]) {
        assert.ok(names.includes(required), `thiếu ship skill: ${required}`);
    }
});

test('getShipSkillsForStack: universal — trả về khi có ngôn ngữ', () => {
    assert.deepStrictEqual(getShipSkillsForStack(null), []);
    assert.deepStrictEqual(getShipSkillsForStack({}), []);
    assert.strictEqual(getShipSkillsForStack({ language: 'TypeScript' }).length, SHIP_SKILLS.length);
});

test('>om:ship: có workflow file shipping.md', () => {
    const wf = path.join(__dirname, '..', 'templates', 'workflows', 'shipping.md');
    assert.ok(fs.existsSync(wf), 'thiếu templates/workflows/shipping.md');
    const content = fs.readFileSync(wf, 'utf-8');
    assert.match(content, /SHIP AGENT WORKFLOW/);
    assert.match(content, /## Verification/);
    assert.match(content, />om:check/, 'phải yêu cầu check pass trước');
});

test('>om:ship: đăng ký trong superpower-sdlc + slash command claude-code', () => {
    const sdlc = fs.readFileSync(path.join(__dirname, '..', 'templates', 'workflows', 'superpower-sdlc.md'), 'utf-8');
    assert.match(sdlc, /\[>om:ship\]/, 'superpower-sdlc phải liệt kê >om:ship');
    assert.match(sdlc, />om:doc → >om:ship/, 'pipeline diagram phải kết thúc bằng ship');

    const slash = path.join(__dirname, '..', 'templates', 'overlays', 'claude-code', 'commands', 'om:ship.md');
    assert.ok(fs.existsSync(slash), 'thiếu slash command om:ship.md');
});
