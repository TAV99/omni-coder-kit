'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseYamlText, parseYamlFile } = require('../lib/squad/yaml');

const rejects = (text, pattern) => assert.throws(() => parseYamlText(text, { source: 't.yaml' }),
    (error) => error.code === 'SQUAD_CONFIG_INVALID' && (!pattern || pattern.test(error.message)));

test('plain data parses', () => {
    assert.deepEqual(parseYamlText('a: 1\nb: [x, "y"]\nc: {d: true}\n'), { a: 1, b: ['x', 'y'], c: { d: true } });
});

test('aliases and merge keys are refused (no alias bombs)', () => {
    rejects('a: &x 1\nb: *x\n');
    rejects('base: &b {x: 1}\nc:\n  <<: *b\n');
});

test('custom and YAML 1.1 tags are refused, not turned into strings', () => {
    rejects('a: !!js/function foo\n', /Unresolved tag/);
    rejects('a: !foo bar\n', /Unresolved tag/);
    rejects('a: !!binary aGk=\n', /Unresolved tag/);
    rejects('a: !!timestamp 2020-01-01\n', /Unresolved tag/);
});

test('duplicate and non-string keys are refused with a position', () => {
    assert.throws(() => parseYamlText('a: 1\na: 2\n', { source: 'dup.yaml' }), (error) =>
        error.code === 'SQUAD_CONFIG_INVALID' && error.details.line === 2 && /^dup\.yaml:2:1:/.test(error.message));
    rejects('? [1]\n: v\n', /keys must be strings/);
});

test('top level must be a mapping', () => {
    rejects('just text\n', /mapping/);
    rejects('- a\n- b\n', /mapping/);
    rejects('', /mapping/);
});

test('files: size cap, regular files only, no symlinks', (t) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-yaml-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const ok = path.join(dir, 'ok.yaml');
    fs.writeFileSync(ok, 'a: 1\n');
    assert.deepEqual(parseYamlFile(ok), { a: 1 });
    const big = path.join(dir, 'big.yaml');
    fs.writeFileSync(big, `a: "${'x'.repeat(70 * 1024)}"\n`);
    assert.throws(() => parseYamlFile(big), /larger than/);
    const link = path.join(dir, 'link.yaml');
    fs.symlinkSync(ok, link);
    assert.throws(() => parseYamlFile(link), /symlink/);
    assert.throws(() => parseYamlFile(dir), /regular file/);
    assert.throws(() => parseYamlFile(path.join(dir, 'missing.yaml')), /cannot read/);
});
