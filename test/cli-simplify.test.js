'use strict';

// SPEC-CLI-SIMPLIFY / v3.0 — bề mặt CLI chính + Phase-4 wiring (aliases removed).

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'omni.js');

function run(args, opts = {}) {
    const r = spawnSync('node', [BIN, ...args], { encoding: 'utf-8', ...opts });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('omni --help: shows visible command groups', () => {
    const { code, stdout } = run(['--help']);
    assert.strictEqual(code, 0);
    // Visible: init, skills, map, rules, agent-files, squad, ui (+ implicit help).
    for (const name of ['init', 'skills', 'map', 'rules', 'agent-files', 'squad', 'ui']) {
        assert.match(stdout, new RegExp(`^\\s+${name}\\b`, 'm'), `help should list ${name}`);
    }
    // Removed 2.x aliases + hidden utils must NOT appear in top-level help.
    // The old SDLC harness (`omni run` and its gate/log/stats/accept) was removed in 3.2.0.
    for (const name of ['run', 'equip', 'auto-equip', 'status', 'skills:doctor', 'gate', 'trace', 'stats', 'onboard', 'commands', 'update', 'customize']) {
        assert.doesNotMatch(stdout, new RegExp(`^\\s+${name.replace(':', '\\:')}\\b`, 'm'), `${name} must not appear in help`);
    }
});

test('omni skills --help: lists -y/--yes option and `add`/`doctor` subcommands', () => {
    const { code, stdout } = run(['skills', '--help']);
    assert.strictEqual(code, 0);
    assert.match(stdout, /-y,\s+--yes/);
    assert.match(stdout, /^\s+add\b/m);
    assert.match(stdout, /^\s+doctor\b/m);
});

test('omni skills -y / --yes: parses flag and reaches default skills action without unknown-option error', () => {
    for (const flag of ['-y', '--yes']) {
        const { code, stderr, stdout } = run(['skills', flag], { cwd: __dirname });
        assert.doesNotMatch(stderr, /unknown option/i, `${flag} must not be rejected as unknown option`);
        assert.doesNotMatch(stdout, /unknown option/i, `${flag} must not be rejected as unknown option`);
        assert.match(`${stderr}\n${stdout}`, /Không tìm thấy file Omni|universal skills|Trạng thái Omni-Coder Kit/i);
    }
});

test('v3.0: removed aliases are unknown commands (not deprecated wrappers)', () => {
    // `run` is the removed 3.x SDLC harness.
    for (const name of ['run', 'gate', 'trace', 'status', 'equip', 'onboard', 'auto-equip']) {
        const { code, stderr, stdout } = run([name], { cwd: __dirname });
        assert.notStrictEqual(code, 0, `${name} should exit non-zero`);
        const err = `${stderr}\n${stdout}`;
        assert.match(err, /unknown command/i, `${name} should be unknown command`);
    }
});

test('canonical replacements still work: skills doctor / init help', () => {
    assert.strictEqual(run(['skills', 'doctor', '--help']).code, 0);
    assert.strictEqual(run(['init', '--help']).code, 0);
});

test('handleCommands lists Phase-4 chat commands (>om-go, >om-spec, >om-pass)', () => {
    const { handleCommands } = require('../lib/commands/status');
    const origLog = console.log;
    const lines = [];
    console.log = (...a) => lines.push(a.join(' '));
    try { handleCommands(); } finally { console.log = origLog; }
    const out = lines.join('\n');
    for (const cmd of ['>om-go', '>om-spec', '>om-pass']) {
        assert.ok(out.includes(cmd), `output should contain ${cmd}`);
    }
});
