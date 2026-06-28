'use strict';

// SPEC-CLI-SIMPLIFY — bề mặt CLI mới (5 lệnh + alias ẩn) + Phase-4 wiring.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'omni.js');

function run(args, opts = {}) {
    const r = spawnSync('node', [BIN, ...args], { encoding: 'utf-8', ...opts });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('omni --help: shows exactly the 5 visible command groups', () => {
    const { code, stdout } = run(['--help']);
    assert.strictEqual(code, 0);
    // Visible: init, run, skills, map, rules (+ implicit help).
    for (const name of ['init', 'run', 'skills', 'map', 'rules']) {
        assert.match(stdout, new RegExp(`^\\s+${name}\\b`, 'm'), `help should list ${name}`);
    }
    // Hidden aliases must NOT appear in help.
    for (const name of ['equip', 'auto-equip', 'status', 'skills:doctor', 'gate', 'trace', 'stats', 'onboard', 'commands', 'update', 'customize']) {
        assert.doesNotMatch(stdout, new RegExp(`^\\s+${name.replace(':', '\\:')}\\b`, 'm'), `hidden alias ${name} must not appear in help`);
    }
});

test('omni run --help: has Phase-4 flags + acceptance subcommand', () => {
    const { code, stdout } = run(['run', '--help']);
    assert.strictEqual(code, 0);
    assert.match(stdout, /--spec </);
    assert.match(stdout, /--accept </);
    assert.match(stdout, /--max-accept-rounds </);
    // Subcommands gate/log/stats/accept
    for (const sub of ['gate', 'log', 'stats', 'accept']) {
        assert.match(stdout, new RegExp(`^\\s+${sub}\\b`, 'm'), `run should list subcommand ${sub}`);
    }
});

test('omni skills --help: lists `add` and `doctor` subcommands', () => {
    const { code, stdout } = run(['skills', '--help']);
    assert.strictEqual(code, 0);
    assert.match(stdout, /^\s+add\b/m);
    assert.match(stdout, /^\s+doctor\b/m);
});

test('omni run --dry-run shows ACCEPTANCE in the planned pipeline', () => {
    const { code, stdout } = run(['run', '--dry-run']);
    assert.strictEqual(code, 0);
    assert.match(stdout, /ACCEPTANCE/);
});

test('hidden alias `omni gate` prints deprecation warning + still executes', () => {
    // gate exits 0 or 1 depending on project; we only care that the deprecation hint fires.
    const { stderr } = run(['gate'], { cwd: __dirname });
    assert.match(stderr, /omni gate.+đổi tên/);
});

test('hidden alias `omni trace` prints deprecation warning', () => {
    const { stderr } = run(['trace'], { cwd: __dirname });
    assert.match(stderr, /omni trace.+đổi tên/);
});

test('hidden alias `omni status` prints deprecation warning', () => {
    const { stderr } = run(['status'], { cwd: __dirname });
    assert.match(stderr, /omni status.+đổi tên/);
});

test('handleCommands lists Phase-4 chat commands (>om:go, >om:intake, >om:accept)', () => {
    const { handleCommands } = require('../lib/commands/status');
    const origLog = console.log;
    const lines = [];
    console.log = (...a) => lines.push(a.join(' '));
    try { handleCommands(); } finally { console.log = origLog; }
    const out = lines.join('\n');
    for (const cmd of ['>om:go', '>om:intake', '>om:accept']) {
        assert.ok(out.includes(cmd), `output should contain ${cmd}`);
    }
});
