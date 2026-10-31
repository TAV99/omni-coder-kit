'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSkillStore, MOUNT_MARKER } = require('../lib/squad/skill-store');
const { mountBundle, inspectMount, displaceUnmanaged } = require('../lib/squad/mount');
const { tempDir, writeSkill } = require('./helpers/squad-project');

const SKILL_DIR = '.agents/skills';

function setup(t, storeSkills = ['a', 'b', 'c']) {
    const root = tempDir(t, 'squad-mount-');
    const store = createSkillStore(root);
    for (const name of storeSkills) writeSkill(store.dir, name);
    return { root, store, base: path.join(root, SKILL_DIR) };
}

test('mount places the bundle with markers and is idempotent', (t) => {
    const { root, store, base } = setup(t);
    const first = mountBundle({ store, root, skillDir: SKILL_DIR, skills: ['a', 'b'], roleId: 'orchestrator' });
    assert.deepEqual(first.mounted, ['a', 'b']);
    const marker = JSON.parse(fs.readFileSync(path.join(base, 'a', MOUNT_MARKER), 'utf8'));
    assert.deepEqual([marker.role, marker.skill, marker.sha256], ['orchestrator', 'a', store.hashOf('a')]);
    const again = mountBundle({ store, root, skillDir: SKILL_DIR, skills: ['a', 'b'], roleId: 'orchestrator' });
    assert.deepEqual([again.mounted, again.updated, again.removed, again.unchanged], [[], [], [], ['a', 'b']]);
});

test('store changes are re-mounted; skills leaving the bundle are removed', (t) => {
    const { root, store, base } = setup(t);
    mountBundle({ store, root, skillDir: SKILL_DIR, skills: ['a', 'b'], roleId: 'orchestrator' });
    writeSkill(store.dir, 'a', 'new version');
    const result = mountBundle({ store, root, skillDir: SKILL_DIR, skills: ['a'], roleId: 'orchestrator' });
    assert.deepEqual([result.updated, result.removed], [['a'], ['b']]);
    assert.match(fs.readFileSync(path.join(base, 'a', 'SKILL.md'), 'utf8'), /new version/);
    assert.equal(fs.existsSync(path.join(base, 'b')), false);
});

test('local edits to a mounted copy count as drift', (t) => {
    const { root, store, base } = setup(t);
    mountBundle({ store, root, skillDir: SKILL_DIR, skills: ['a'], roleId: 'orchestrator' });
    fs.appendFileSync(path.join(base, 'a', 'SKILL.md'), 'edited');
    assert.deepEqual(inspectMount({ store, root, skillDir: SKILL_DIR, skills: ['a'], roleId: 'orchestrator' }).drift, ['a']);
});

test('user skills and other roles\' mounts are never touched', (t) => {
    const { root, store, base } = setup(t);
    writeSkill(base, 'mine', 'user content');
    writeSkill(base, 'theirs');
    fs.writeFileSync(path.join(base, 'theirs', MOUNT_MARKER), JSON.stringify({ schema_version: 1, role: 'worker-1', skill: 'theirs', sha256: 'x' }));
    const result = mountBundle({ store, root, skillDir: SKILL_DIR, skills: ['a'], roleId: 'orchestrator' });
    assert.deepEqual([result.unmanaged, result.foreign], [['mine'], ['theirs']]);
    assert.match(fs.readFileSync(path.join(base, 'mine', 'SKILL.md'), 'utf8'), /user content/);
    assert.ok(fs.existsSync(path.join(base, 'theirs')));
});

test('an unmanaged copy identical to the store is adopted, a different one blocks', (t) => {
    const { root, store, base } = setup(t);
    fs.mkdirSync(base, { recursive: true });
    fs.cpSync(store.pathOf('a'), path.join(base, 'a'), { recursive: true });
    writeSkill(base, 'b', 'local fork');
    const result = mountBundle({ store, root, skillDir: SKILL_DIR, skills: ['a', 'b'], roleId: 'orchestrator' });
    assert.deepEqual([result.adopted, result.unmanaged], [['a'], ['b']]);
    assert.ok(fs.existsSync(path.join(base, 'a', MOUNT_MARKER)));
    assert.match(fs.readFileSync(path.join(base, 'b', 'SKILL.md'), 'utf8'), /local fork/);
});

test('missing store skills are reported, not invented', (t) => {
    const { root, store } = setup(t, ['a']);
    assert.deepEqual(mountBundle({ store, root, skillDir: SKILL_DIR, skills: ['a', 'ghost'], roleId: 'orchestrator' }).missing, ['ghost']);
});

test('displace moves unmanaged skills aside instead of deleting them', (t) => {
    const { root, store, base } = setup(t);
    writeSkill(base, 'keep-me');
    writeSkill(base, 'move-me', 'precious');
    mountBundle({ store, root, skillDir: SKILL_DIR, skills: ['a'], roleId: 'orchestrator' });
    const now = new Date('2026-11-01T10:00:00Z');
    const { moved, to } = displaceUnmanaged({ store, root, skillDir: SKILL_DIR, keep: new Set(['keep-me', 'a']), now });
    assert.deepEqual(moved, ['move-me']);
    assert.match(fs.readFileSync(path.join(to, 'move-me', 'SKILL.md'), 'utf8'), /precious/);
    assert.ok(fs.existsSync(path.join(base, 'keep-me')) && fs.existsSync(path.join(base, 'a')));
    assert.ok(to.startsWith(path.join(store.dir, '.displaced')));
});
