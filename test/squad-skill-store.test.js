'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSkillStore, hashDir, MOUNT_MARKER } = require('../lib/squad/skill-store');
const { tempDir, writeSkill } = require('./helpers/squad-project');

test('imports unmanaged skills, reports identical ones and conflicts', (t) => {
    const root = tempDir(t, 'squad-store-');
    const source = path.join(root, '.agents', 'skills');
    writeSkill(source, 'alpha');
    writeSkill(source, 'beta');
    fs.writeFileSync(path.join(source, 'not-a-skill.txt'), 'x');
    const store = createSkillStore(root);
    assert.deepEqual(store.importFrom(source), { imported: ['alpha', 'beta'], same: [], conflicts: [] });
    assert.deepEqual(store.list(), ['alpha', 'beta']);
    writeSkill(source, 'beta', 'changed body');
    assert.deepEqual(store.importFrom(source), { imported: [], same: ['alpha'], conflicts: ['beta'] });
    assert.match(fs.readFileSync(path.join(store.dir, 'beta', 'SKILL.md'), 'utf8'), /^---/);
    assert.ok(!fs.readFileSync(path.join(store.dir, 'beta', 'SKILL.md'), 'utf8').includes('changed body'), 'store copy is not overwritten');
});

test('mounted copies (with a marker) are not imported back', (t) => {
    const root = tempDir(t, 'squad-store-');
    const source = path.join(root, '.agents', 'skills');
    writeSkill(source, 'mounted');
    fs.writeFileSync(path.join(source, 'mounted', MOUNT_MARKER), JSON.stringify({ schema_version: 1, role: 'orchestrator', skill: 'mounted' }));
    assert.deepEqual(createSkillStore(root).importFrom(source).imported, []);
});

test('hash ignores the marker and directory read order, sees content changes', (t) => {
    const root = tempDir(t, 'squad-store-');
    writeSkill(root, 'one');
    fs.mkdirSync(path.join(root, 'one', 'docs'));
    fs.writeFileSync(path.join(root, 'one', 'docs', 'b.md'), 'b');
    fs.writeFileSync(path.join(root, 'one', 'docs', 'a.md'), 'a');
    const before = hashDir(path.join(root, 'one'));
    fs.writeFileSync(path.join(root, 'one', MOUNT_MARKER), '{}');
    assert.equal(hashDir(path.join(root, 'one')), before);
    fs.writeFileSync(path.join(root, 'one', 'docs', 'a.md'), 'A');
    assert.notEqual(hashDir(path.join(root, 'one')), before);
});

test('symlinks inside a skill are refused', (t) => {
    const root = tempDir(t, 'squad-store-');
    writeSkill(root, 'linky');
    fs.symlinkSync('/etc/hosts', path.join(root, 'linky', 'hosts'));
    assert.throws(() => hashDir(path.join(root, 'linky')), { code: 'SQUAD_SKILL_INVALID' });
});

test('invalid names never reach the filesystem', (t) => {
    const store = createSkillStore(tempDir(t, 'squad-store-'));
    assert.throws(() => store.pathOf('../escape'), { code: 'SQUAD_SKILL_INVALID' });
    assert.equal(store.has('../escape'), false);
    assert.throws(() => store.hashOf('absent'), { code: 'SQUAD_SKILL_MISSING' });
});
