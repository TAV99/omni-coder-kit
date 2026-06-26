'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hostCli = require('../lib/harness/providers/host-cli');
const manualRelay = require('../lib/harness/providers/manual-relay');
const { getProvider, getProviderFromSpec } = require('../lib/harness/providers');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-p3-')); }

// --- 3a: Antigravity host ---------------------------------------------------

test('host-cli.buildCommand antigravity → agy headless one-shot', () => {
    const built = hostCli.buildCommand('antigravity', 'do X');
    assert.match(built.cmd, /^agy --dangerously-skip-permission -p ".*"$/);
});

test('getProviderFromSpec parses name:ide', () => {
    const a = getProviderFromSpec('host-cli:antigravity');
    assert.strictEqual(a.host, 'antigravity');
    assert.strictEqual(a.provider.name, 'host-cli');
    assert.match(a.provider.buildCommand('debate', 'x').cmd, /^agy /);

    const c = getProviderFromSpec('host-cli:claudecode');
    assert.match(c.provider.buildCommand('debate', 'x').cmd, /^claude -p/);

    const bare = getProviderFromSpec('dry-run');
    assert.strictEqual(bare.host, 'dry-run');
    assert.strictEqual(bare.provider.name, 'dry-run');
});

test('getProvider knows manual-relay', () => {
    assert.strictEqual(getProvider('manual-relay', {}).name, 'manual-relay');
});

// --- 3a: manual-relay round-trip -------------------------------------------

test('manual-relay writes prompt file + reads injected answer', async () => {
    const dir = tmp();
    const p = manualRelay.create({ readAnswer: () => 'VERDICT: PASS — looks correct' });
    const r = await p.runStep('debate', { projectDir: dir, sharedBrief: 'review the diff' });
    assert.strictEqual(r.ok, true);
    assert.match(r.summary, /PASS/);
    // prompt file written for the operator
    const promptFile = path.join(dir, '.omni', 'run', 'relay', 'debate.prompt.md');
    assert.ok(fs.existsSync(promptFile));
    assert.match(fs.readFileSync(promptFile, 'utf-8'), /manual relay/);
});

test('manual-relay: no answer yet → awaiting (ok:false)', async () => {
    const dir = tmp();
    const p = manualRelay.create(); // default reader: no answer file present
    const r = await p.runStep('debate', { projectDir: dir });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.exitCode, 3);
    assert.match(r.summary, /awaiting manual answer/);
});

test('manual-relay: reads answer from .answer.md file', async () => {
    const dir = tmp();
    const relayDir = path.join(dir, '.omni', 'run', 'relay');
    fs.mkdirSync(relayDir, { recursive: true });
    fs.writeFileSync(path.join(relayDir, 'debate.answer.md'), 'VERDICT: FAIL', 'utf-8');
    const p = manualRelay.create();
    const r = await p.runStep('debate', { projectDir: dir });
    assert.strictEqual(r.ok, true);
    assert.match(r.summary, /FAIL/);
});
