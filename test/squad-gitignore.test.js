'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { applyGitignore } = require('../lib/squad/gitignore');
const { tempDir } = require('./helpers/squad-project');

function ignored(root, file) {
    try {
        execFileSync('git', ['check-ignore', '-q', file], { cwd: root, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

test('new project: .omni/squad is committable, everything else under .omni is ignored', (t) => {
    const root = tempDir(t, 'squad-gi-');
    execFileSync('git', ['init', '-q'], { cwd: root });
    assert.deepEqual(applyGitignore(root).added, ['.omni/*', '!.omni/squad/']);
    assert.equal(ignored(root, '.omni/squad/roles/worker.yaml'), false);
    assert.equal(ignored(root, '.omni/squad/skills.yaml'), false);
    for (const file of ['.omni/skills/x/SKILL.md', '.omni/squad.local.json', '.omni/runs/a', '.omni/manifest.json']) {
        assert.equal(ignored(root, file), true, file);
    }
});

test('legacy .omni/ inside omni\'s block is migrated in place', (t) => {
    const root = tempDir(t, 'squad-gi-');
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n\n# Omni-Coder Kit (generated)\n.omni/\n.claude/\n');
    const result = applyGitignore(root);
    assert.equal(result.migrated, true);
    assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'),
        'node_modules/\n\n# Omni-Coder Kit (generated)\n.omni/*\n!.omni/squad/\n.claude/\n');
    assert.deepEqual(applyGitignore(root), { added: [], migrated: false, warning: null }, 'second run changes nothing');
});

test('a user-written .omni/ is left alone and reported', (t) => {
    const root = tempDir(t, 'squad-gi-');
    fs.writeFileSync(path.join(root, '.gitignore'), '.omni/\nnode_modules/\n');
    const result = applyGitignore(root);
    assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '.omni/\nnode_modules/\n');
    assert.match(result.warning, /\.omni\/\*/);
});
