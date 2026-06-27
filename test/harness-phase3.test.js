'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hostCli = require('../lib/harness/providers/host-cli');
const manualRelay = require('../lib/harness/providers/manual-relay');
const { getProvider, getProviderFromSpec } = require('../lib/harness/providers');
const { runDebate, classify } = require('../lib/harness/debate');
const { readEvents } = require('../lib/harness/events');
const { runHarness } = require('../lib/harness/loop');

function writeTodo(dir, body) {
    fs.mkdirSync(path.join(dir, '.omni', 'sdlc'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.omni', 'sdlc', 'todo.md'), body, 'utf-8');
}
const passGate = () => ({ passed: true, results: [], failures: [] });
const SPECS = ['host-cli:claudecode', 'host-cli:antigravity'];

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

// --- 3b: debate engine ------------------------------------------------------

const parts = [{ id: 'claude', host: 'claudecode' }, { id: 'antigravity', host: 'antigravity' }];

test('classify: all agree / split / inconclusive', () => {
    assert.deepStrictEqual(classify([{ verdict: 'pass' }, { verdict: 'pass' }]), { consensus: 'agree', verdict: 'pass' });
    assert.deepStrictEqual(classify([{ verdict: 'pass' }, { verdict: 'fail' }]), { consensus: 'split', verdict: 'fail' });
    assert.deepStrictEqual(classify([{ verdict: 'unknown' }, { verdict: 'unknown' }]), { consensus: 'inconclusive', verdict: 'unknown' });
});

test('runDebate: A passes, B refutes → split, transcript written, 2 rounds', async () => {
    const dir = tmp();
    const runStep = async (p) => ({ id: p.id, ok: true, verdict: p.id === 'antigravity' ? 'fail' : 'pass', position: `${p.id} pos`, confidence: 0.5 });
    const res = await runDebate({ projectDir: dir, claim: { question: 'Is the cache thread-safe?' }, participants: parts, rounds: 2, runStep });
    assert.strictEqual(res.consensus, 'split');
    assert.strictEqual(res.verdict, 'fail');
    assert.strictEqual(res.rounds, 2); // no early convergence on a split
    assert.ok(fs.existsSync(path.join(dir, res.transcriptPath)));
    assert.ok(readEvents(dir).some((e) => e.type === 'debate' && e.consensus === 'split'));
});

test('runDebate: both agree → consensus agree, early-stops after round 0', async () => {
    const dir = tmp();
    const runStep = async (p) => ({ id: p.id, ok: true, verdict: 'pass', position: 'ok', confidence: 0.5 });
    const res = await runDebate({ projectDir: dir, claim: { question: 'q' }, participants: parts, rounds: 3, runStep });
    assert.strictEqual(res.consensus, 'agree');
    assert.strictEqual(res.verdict, 'pass');
    assert.strictEqual(res.rounds, 1); // converged immediately
});

test('runDebate: same-host participants → warning', async () => {
    const dir = tmp();
    const sameHost = [{ id: 'a', host: 'claudecode' }, { id: 'b', host: 'claudecode' }];
    const runStep = async (p) => ({ id: p.id, ok: true, verdict: 'pass', position: 'ok' });
    const res = await runDebate({ projectDir: dir, claim: { question: 'q' }, participants: sameHost, runStep });
    assert.ok(res.warnings.some((w) => /cùng host/.test(w)));
    assert.ok(readEvents(dir).some((e) => e.type === 'debate-warning'));
});

test('runDebate: <2 participants → warning', async () => {
    const dir = tmp();
    const runStep = async (p) => ({ id: p.id, ok: true, verdict: 'pass', position: 'ok' });
    const res = await runDebate({ projectDir: dir, claim: { question: 'q' }, participants: [{ id: 'solo', host: 'claudecode' }], runStep });
    assert.ok(res.warnings.some((w) => /≥2 participant/.test(w)));
});

// --- 3c: debate wired into the loop ----------------------------------------

test('loop: debate split at CHECK → escalate pause, does not blind-fix', async () => {
    const dir = tmp();
    writeTodo(dir, '- [x] a\n');
    const fakeDebate = async () => ({ consensus: 'split', verdict: 'fail', transcript: [], rounds: 2, transcriptPath: 'x', warnings: [] });
    const final = await runHarness(dir, {
        from: 'CHECK', provider: 'dry-run', runPipeline: passGate,
        debate: SPECS, debateOn: ['check'], runDebate: fakeDebate,
    });
    assert.strictEqual(final.status, 'paused');
    assert.strictEqual(final.state, 'CHECK'); // did NOT advance to FIX or DOC
    assert.ok(readEvents(dir).some((e) => e.type === 'pause' && /debate split/.test(e.reason)));
});

test('loop: debate agree-pass at CHECK → proceeds to DOC', async () => {
    const dir = tmp();
    writeTodo(dir, '- [x] a\n');
    const fakeDebate = async () => ({ consensus: 'agree', verdict: 'pass', transcript: [], rounds: 1, transcriptPath: 'x', warnings: [] });
    const final = await runHarness(dir, {
        from: 'CHECK', provider: 'dry-run', runPipeline: passGate,
        debate: SPECS, debateOn: ['check'], runDebate: fakeDebate,
    });
    assert.strictEqual(final.state, 'DOC');
    assert.strictEqual(final.status, 'paused'); // normal pause-before-SHIP
});

test('loop: pre-SHIP debate split → escalate, never auto-ships', async () => {
    const dir = tmp();
    writeTodo(dir, '- [x] a\n');
    let calls = 0;
    const fakeDebate = async () => (calls++ === 0
        ? { consensus: 'agree', verdict: 'pass', transcript: [], rounds: 1, transcriptPath: 'x', warnings: [] }   // CHECK passes
        : { consensus: 'split', verdict: 'fail', transcript: [], rounds: 2, transcriptPath: 'x', warnings: [] }); // pre-SHIP splits
    const final = await runHarness(dir, {
        from: 'CHECK', provider: 'dry-run', runPipeline: passGate, yesShip: true,
        debate: SPECS, debateOn: ['check', 'ship'], runDebate: fakeDebate,
    });
    assert.strictEqual(final.state, 'DOC'); // stopped at DOC, never entered SHIP
    assert.strictEqual(final.status, 'paused');
    assert.ok(!readEvents(dir).some((e) => e.type === 'transition' && e.to === 'SHIP'));
});

test('loop: debate not configured → no debate events', async () => {
    const dir = tmp();
    writeTodo(dir, '- [x] a\n');
    const final = await runHarness(dir, { from: 'CHECK', provider: 'dry-run', runPipeline: passGate });
    assert.strictEqual(final.state, 'DOC');
    assert.ok(!readEvents(dir).some((e) => e.type === 'debate'));
});
