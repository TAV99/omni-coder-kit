'use strict';

// SPEC-SQUAD-P8 §4 (P8a): `omni init` → Squad writes the shared dual file set,
// asks nothing squad-specific, and opens `omni ui`; single-agent init is unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const prompts = require('prompts');
const { handleInit } = require('../lib/commands/init');

function inTempProject(t) {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-init-squad-')));
    const previous = process.cwd();
    process.chdir(dir);
    const log = console.log, error = console.error;
    console.log = () => {}; console.error = () => {};
    t.after(() => {
        console.log = log; console.error = error;
        process.chdir(previous);
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}

// ide, SDLC mode, [ide-specific], 4 personal-rule texts, agent-file visibility, [trailing].
const answers = (ide, { afterMode = [], trailing = [] } = {}) => [ide, 'manual', ...afterMode, '', '', '', '', 'visible', ...trailing];

test('Squad is the first init choice, above Dual mode', () => {
    const { INIT_TOOL_CHOICES } = require('../lib/commands/init');
    assert.deepEqual(INIT_TOOL_CHOICES.slice(0, 2).map((choice) => choice.value), ['squad', 'dual']);
});

test('omni init → Squad writes the dual file set, records ide squad and opens omni ui', async (t) => {
    const dir = inTempProject(t);
    prompts.inject(answers('squad'));
    let opened = null;
    await handleInit({}, { autoEquip: async () => {}, openUi: async (options) => { opened = options; } });
    for (const file of ['CLAUDE.md', 'AGENTS.md', '.omni/manifest.json']) {
        assert.ok(fs.existsSync(path.join(dir, file)), `${file} written`);
    }
    assert.ok(fs.readdirSync(path.join(dir, '.omni', 'workflows')).length > 0);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.omni', 'manifest.json'), 'utf8'));
    assert.equal(manifest.ide, 'squad');
    assert.equal(manifest.dualPair, undefined, 'no pair is chosen in the terminal');
    assert.equal(manifest.subagents, undefined, 'the sub-agent question is skipped');
    assert.equal(fs.existsSync(path.join(dir, '.omni', 'squad')), false, 'roles are set up on the web, not by init');
    assert.deepEqual(opened, { open: true });
});

test('omni init → Squad with --no-open still starts the UI without a browser', async (t) => {
    inTempProject(t);
    prompts.inject(answers('squad'));
    let opened = null;
    await handleInit({ open: false }, { autoEquip: async () => {}, openUi: async (options) => { opened = options; } });
    assert.deepEqual(opened, { open: false });
});

test('a single-agent init never opens the UI and keeps its own manifest', async (t) => {
    const dir = inTempProject(t);
    // claudecode also asks the sub-agent question and the advanced-setup confirm.
    prompts.inject(answers('claudecode', { afterMode: [false], trailing: [false] }));
    let opened = false;
    await handleInit({}, { autoEquip: async () => {}, openUi: async () => { opened = true; } });
    assert.equal(opened, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.omni', 'manifest.json'), 'utf8')).ide, 'claudecode');
});

test('a dry run for Squad lists files and opens nothing', async (t) => {
    const dir = inTempProject(t);
    prompts.inject(answers('squad'));
    let opened = false;
    await handleInit({ dryRun: true }, { autoEquip: async () => {}, openUi: async () => { opened = true; } });
    assert.equal(opened, false);
    assert.equal(fs.existsSync(path.join(dir, '.omni', 'manifest.json')), false);
});

test('squad projects resolve skill dir, agent flags and overlays like dual', () => {
    const helpers = require('../lib/helpers');
    assert.equal(helpers.getSkillDir({ ide: 'squad' }), helpers.getSkillDir({ ide: 'dual' }));
    assert.equal(helpers.getAgentFlags({ ide: 'squad' }), helpers.getAgentFlags({ ide: 'dual' }));
    for (const target of ['claude-code', 'codex']) {
        assert.equal(helpers.getOverlayNameForTarget('squad', target), helpers.getOverlayNameForTarget('dual', target));
    }
});
