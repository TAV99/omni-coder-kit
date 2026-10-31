'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadRoles, parseRole } = require('../lib/squad/roles');

const TEMPLATES = path.join(__dirname, '..', 'templates', 'squad', 'roles');

function rolesDir(t, overrides = {}) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-roles-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const name of fs.readdirSync(TEMPLATES)) fs.copyFileSync(path.join(TEMPLATES, name), path.join(dir, name));
    for (const [name, text] of Object.entries(overrides)) {
        if (text === null) fs.rmSync(path.join(dir, name));
        else fs.writeFileSync(path.join(dir, name), text);
    }
    return dir;
}

const base = {
    schema_version: 1, id: 'worker', description: 'w', cardinality: '1..N', phases: ['implement'],
    permission: 'full-auto-isolated', requires: ['headless'], root: 'isolated',
};

test('shipped templates load: orchestrator, worker, reviewer', (t) => {
    const roles = loadRoles(rolesDir(t));
    assert.deepEqual(Object.keys(roles).sort(), ['orchestrator', 'reviewer', 'worker']);
    assert.equal(roles.orchestrator.permission, 'interactive');
    assert.equal(roles.worker.root, 'isolated');
    assert.deepEqual(roles.worker.optional, ['resume', 'structuredOutput']);
});

test('permission must fit the root', () => {
    assert.throws(() => parseRole({ ...base, root: 'project' }, 'w.yaml'), /full-auto-isolated requires root: isolated/);
    assert.throws(() => parseRole({ ...base, permission: 'interactive' }, 'w.yaml'), /interactive requires root: project/);
});

test('unknown capabilities, fields and duplicate phases are rejected', () => {
    assert.throws(() => parseRole({ ...base, requires: ['telepathy'] }, 'w.yaml'), { code: 'SQUAD_CONFIG_INVALID' });
    assert.throws(() => parseRole({ ...base, surprise: 1 }, 'w.yaml'), { code: 'SQUAD_CONFIG_INVALID' });
    assert.throws(() => parseRole({ ...base, phases: ['a', 'a'] }, 'w.yaml'), /unique/);
});

test('id must match the file name', (t) => {
    const text = fs.readFileSync(path.join(TEMPLATES, 'worker.yaml'), 'utf8').replace('id: worker', 'id: builder');
    assert.throws(() => loadRoles(rolesDir(t, { 'worker.yaml': text })), /must match the file name/);
});

test('required roles must exist with the expected shape', (t) => {
    assert.throws(() => loadRoles(rolesDir(t, { 'reviewer.yaml': null })), /missing required role "reviewer"/);
    const text = fs.readFileSync(path.join(TEMPLATES, 'worker.yaml'), 'utf8').replace('cardinality: "1..N"', 'cardinality: "1"');
    assert.throws(() => loadRoles(rolesDir(t, { 'worker.yaml': text })), /cardinality "1\.\.N"/);
});

test('YAML problems surface as SQUAD_CONFIG_INVALID with the file name', (t) => {
    const dir = rolesDir(t, { 'worker.yaml': 'schema_version: 1\nid: worker\nid: again\n' });
    assert.throws(() => loadRoles(dir), (error) => error.code === 'SQUAD_CONFIG_INVALID' && error.message.includes('worker.yaml'));
});
