'use strict';

// Project-file scope (docs/SPEC-FIX-GATE-SCOPE-AND-FIXLOOP.md FIX 1 / §5).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { listProjectFiles, isProjectFile, INFRA_DIRS } = require('../lib/harness/scope');

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-scope-'));
    const write = (rel, body = '//\n') => {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body, 'utf-8');
    };
    return { dir, write };
}

describe('FIX 1 — scope.listProjectFiles', () => {
    test('returns product source only, excluding infra + deps', () => {
        const { dir, write } = fixture();
        write('src/app.js');
        write('.agents/skills/brainstorming/scripts/helper.js');
        write('node_modules/dep/index.js');
        write('.omni/knowledge/x.js');
        write('dist/bundle.js');
        const rels = listProjectFiles(dir, { exts: ['js'] }).map((f) => path.relative(dir, f).split(path.sep).join('/'));
        assert.deepEqual(rels.sort(), ['src/app.js']);
    });

    test('respects .gitignore (bare name + *.ext)', () => {
        const { dir, write } = fixture();
        write('.gitignore', 'secret/\n*.log\nscratch.js\n');
        write('src/keep.js');
        write('secret/leak.js');
        write('debug.log');
        write('scratch.js');
        const rels = listProjectFiles(dir, { exts: ['js', 'log'] }).map((f) => path.relative(dir, f).split(path.sep).join('/'));
        assert.deepEqual(rels.sort(), ['src/keep.js']);
    });

    test('exts filter is honoured; null returns everything in scope', () => {
        const { dir, write } = fixture();
        write('src/a.js');
        write('src/b.css');
        write('README.md');
        const onlyJs = listProjectFiles(dir, { exts: ['js'] });
        assert.equal(onlyJs.length, 1);
        const all = listProjectFiles(dir);
        assert.equal(all.length, 3);
    });

    test('isProjectFile: infra paths are not product files', () => {
        const { dir } = fixture();
        assert.equal(isProjectFile(dir, path.join(dir, 'src', 'app.js')), true);
        assert.equal(isProjectFile(dir, path.join(dir, '.agents', 'skills', 'x', 'helper.js')), false);
        assert.equal(isProjectFile(dir, path.join(dir, 'node_modules', 'd', 'i.js')), false);
        assert.equal(isProjectFile(dir, '/etc/passwd'), false); // outside the project
    });

    test('INFRA_DIRS covers omni infrastructure dirs', () => {
        for (const d of ['.agents', '.omni', '.claude', 'node_modules', 'dist', '.next']) {
            assert.ok(INFRA_DIRS.has(d), `${d} should be infra`);
        }
    });
});
