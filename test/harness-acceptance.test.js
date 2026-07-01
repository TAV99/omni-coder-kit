'use strict';

// Pha 4 — acceptance (SPEC-PHASE-4-ACCEPTANCE-LOOP §3b).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const acceptance = require('../lib/harness/acceptance');
const intake = require('../lib/harness/intake');

function tmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-accept-'));
}

function writeReqs(dir, body) {
    fs.mkdirSync(path.join(dir, '.omni', 'sdlc'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.omni', 'sdlc', 'requirements.md'), body, 'utf-8');
}

const PARTICIPANTS = [
    { id: 'host-cli:claudecode', host: 'claudecode', provider: { name: 'fake' } },
    { id: 'host-cli:antigravity', host: 'antigravity', provider: { name: 'fake' } },
];

const passDebate = async () => ({
    consensus: 'agree', verdict: 'pass', transcript: [], rounds: 1, transcriptPath: 'p', warnings: [],
});

const failDebate = async () => ({
    consensus: 'split', verdict: 'fail', transcript: [], rounds: 2, transcriptPath: 'p', warnings: [],
});

test('isHardTest: classifies test strings correctly', () => {
    assert.strictEqual(acceptance.isHardTest('agent'), false);
    assert.strictEqual(acceptance.isHardTest(''), false);
    assert.strictEqual(acceptance.isHardTest('npm test'), true);
    assert.strictEqual(acceptance.isHardTest('./run.sh'), true);
});

test('runAcceptance: all requirements met (mixed hard + agent debate=pass)', async () => {
    const dir = tmp();
    writeReqs(dir, [
        '- [ ] R1 | login flow works | test: npm test -- auth',
        '- [ ] R2 | UI shows brand | test: agent',
    ].join('\n'));
    const reqs = intake.parseRequirements(dir);
    const runner = (cmd) => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, cmd });
    const res = await acceptance.runAcceptance({
        projectDir: dir, requirements: reqs, runDebate: passDebate, runner,
        participants: PARTICIPANTS, rounds: 1,
    });
    assert.strictEqual(res.allMet, true);
    assert.deepStrictEqual(res.failed, []);
    assert.strictEqual(res.report[0].method, 'test');
    assert.strictEqual(res.report[1].method, 'agent');

    // requirements.md must reflect met status.
    const after = intake.parseRequirements(dir);
    assert.strictEqual(after[0].status, 'met');
    assert.strictEqual(after[1].status, 'met');
});

test('runAcceptance: agent debate split → requirement failed (no blind-fix)', async () => {
    const dir = tmp();
    writeReqs(dir, '- [ ] R1 | qualitative thing | test: agent\n');
    const reqs = intake.parseRequirements(dir);
    const res = await acceptance.runAcceptance({
        projectDir: dir, requirements: reqs, runDebate: failDebate,
        participants: PARTICIPANTS, rounds: 2,
    });
    assert.strictEqual(res.allMet, false);
    assert.deepStrictEqual(res.failed, ['R1']);
    assert.strictEqual(res.report[0].method, 'agent');
    assert.match(res.report[0].evidence, /split/);
    const after = intake.parseRequirements(dir);
    assert.strictEqual(after[0].status, 'failed');
});

test('runAcceptance: hard test exit-non-zero → failed', async () => {
    const dir = tmp();
    writeReqs(dir, '- [ ] R1 | api endpoint exists | test: false\n');
    const reqs = intake.parseRequirements(dir);
    const runner = (_cmd) => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false });
    const res = await acceptance.runAcceptance({
        projectDir: dir, requirements: reqs, runDebate: passDebate, runner,
        participants: PARTICIPANTS,
    });
    assert.strictEqual(res.allMet, false);
    assert.deepStrictEqual(res.failed, ['R1']);
    assert.strictEqual(res.report[0].method, 'test');
    assert.match(res.report[0].evidence, /exit=1/);
});

test('runAcceptance: < 2 participants for agent test → NOT met with explanation', async () => {
    const dir = tmp();
    writeReqs(dir, '- [ ] R1 | agent judged | test: agent\n');
    const reqs = intake.parseRequirements(dir);
    const res = await acceptance.runAcceptance({
        projectDir: dir, requirements: reqs, runDebate: passDebate,
        participants: [],
    });
    assert.strictEqual(res.allMet, false);
    assert.match(res.report[0].evidence, /participants/);
});

test('writeConformance: produces a parseable markdown report', () => {
    const dir = tmp();
    const report = [
        { id: 'R1', text: 'login', met: true, method: 'test', evidence: 'ok' },
        { id: 'R2', text: 'logo', met: false, method: 'agent', evidence: 'split' },
    ];
    const p = acceptance.writeConformance(dir, report, { round: 2 });
    const md = fs.readFileSync(p, 'utf-8');
    assert.match(md, /Conformance report \(round 2\)/);
    assert.match(md, /R1 \| ✅/);
    assert.match(md, /R2 \| ❌/);
    assert.match(md, /1\/2 requirements met/);
});

test('writeConformance: pipes in evidence are escaped', () => {
    const dir = tmp();
    const report = [{ id: 'R1', text: 't', met: true, method: 'test', evidence: 'a | b | c' }];
    const p = acceptance.writeConformance(dir, report);
    const md = fs.readFileSync(p, 'utf-8');
    assert.match(md, /a \\\| b \\\| c/);
});

test('runAcceptance: emits acceptance + per-req events', async () => {
    const dir = tmp();
    writeReqs(dir, [
        '- [ ] R1 | one | test: agent',
        '- [ ] R2 | two | test: agent',
    ].join('\n'));
    const reqs = intake.parseRequirements(dir);
    const events = [];
    await acceptance.runAcceptance({
        projectDir: dir, requirements: reqs,
        runDebate: passDebate, participants: PARTICIPANTS,
        onEvent: (e) => events.push(e),
    });
    assert.strictEqual(events.filter((e) => e.type === 'acceptance-req').length, 2);
    const finalEv = events.find((e) => e.type === 'acceptance');
    assert.ok(finalEv);
    assert.strictEqual(finalEv.allMet, true);
    assert.strictEqual(finalEv.total, 2);
});

test('runAcceptance: skips debate/evaluation for already met requirements', async () => {
    const dir = tmp();
    // One requirement already met [x], one pending [ ]
    writeReqs(dir, [
        '- [x] R1 | met requirement | test: agent',
        '- [ ] R2 | pending requirement | test: agent',
    ].join('\n'));
    
    const reqs = intake.parseRequirements(dir);
    
    // We pass failing debate, but R1 should be preserved as PASS because it is already marked met.
    const res = await acceptance.runAcceptance({
        projectDir: dir, requirements: reqs,
        runDebate: failDebate, participants: PARTICIPANTS,
    });
    
    assert.strictEqual(res.allMet, false);
    assert.strictEqual(res.failed.length, 1);
    assert.strictEqual(res.failed[0], 'R2');
    
    const r1 = res.report.find(r => r.id === 'R1');
    assert.ok(r1);
    assert.strictEqual(r1.met, true);
    assert.match(r1.evidence, /Already marked as met/);
});
