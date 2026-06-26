'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
    collectRegistrySources,
    parseFrontmatter,
    validateSkillContent,
    MAX_DESCRIPTION_LENGTH,
} = require('../lib/commands/doctor');

test('collectRegistrySources: gom & dedupe nguồn từ 3 registry', () => {
    const sources = collectRegistrySources();
    assert.ok(Array.isArray(sources));
    assert.ok(sources.length > 0);

    // dedupe: mỗi source là duy nhất
    const names = sources.map((s) => s.source);
    assert.strictEqual(new Set(names).size, names.length, 'nguồn phải duy nhất sau dedupe');

    // sắp xếp alphabet
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepStrictEqual(names, sorted, 'nguồn phải được sort');

    // mỗi entry có mảng skills không rỗng, format owner/repo
    for (const s of sources) {
        assert.ok(Array.isArray(s.skills) && s.skills.length > 0, `${s.source} phải có skill dùng nó`);
        assert.match(s.source, /^[^/]+\/[^/]+/, 'source dạng owner/repo');
    }
});

test('collectRegistrySources: nguồn dùng chung gộp skills (vd obra/superpowers)', () => {
    const sources = collectRegistrySources();
    const obra = sources.find((s) => s.source === 'obra/superpowers');
    if (obra) {
        // obra/superpowers cấp 4 universal skill → phải gộp nhiều skill
        assert.ok(obra.skills.length >= 2, 'nguồn dùng chung phải gộp nhiều skill');
    }
});

test('parseFrontmatter: parse hợp lệ', () => {
    const fm = parseFrontmatter('---\nname: foo-bar\ndescription: "hello world"\n---\n# Body');
    assert.deepStrictEqual(fm, { name: 'foo-bar', description: 'hello world' });
});

test('parseFrontmatter: không có frontmatter → null', () => {
    assert.strictEqual(parseFrontmatter('# Chỉ có tiêu đề\nnội dung'), null);
});

test('validateSkillContent: skill hợp lệ → không lỗi', () => {
    const content = '---\nname: my-skill\ndescription: Làm việc X. Use when Y.\n---\n# My Skill';
    const { errors, warnings } = validateSkillContent('my-skill', content);
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(warnings.length, 0);
});

test('validateSkillContent: thiếu frontmatter → lỗi', () => {
    const { errors } = validateSkillContent('x', '# No frontmatter');
    assert.ok(errors.some((e) => /frontmatter/i.test(e)));
});

test('validateSkillContent: thiếu name/description → 2 lỗi', () => {
    const { errors } = validateSkillContent('x', '---\nfoo: bar\n---\n# Body');
    assert.ok(errors.some((e) => /'name'/.test(e)));
    assert.ok(errors.some((e) => /'description'/.test(e)));
});

test('validateSkillContent: name khác tên thư mục → warning', () => {
    const content = '---\nname: other-name\ndescription: ok\n---\n#';
    const { warnings } = validateSkillContent('dir-name', content);
    assert.ok(warnings.some((w) => /khác tên thư mục/.test(w)));
});

test('validateSkillContent: description quá dài → lỗi', () => {
    const longDesc = 'a'.repeat(MAX_DESCRIPTION_LENGTH + 1);
    const content = `---\nname: x\ndescription: ${longDesc}\n---\n#`;
    const { errors } = validateSkillContent('x', content);
    assert.ok(errors.some((e) => /vượt giới hạn/.test(e)));
});
