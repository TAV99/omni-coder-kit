'use strict';

// Pha 4 — loop integration (SPEC-PHASE-4-ACCEPTANCE-LOOP §3c).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runHarness } = require('../lib/harness/loop');
const { readEvents } = require('../lib/harness/events');

function tmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-loop4-'));
}

function writeTodo(dir, body) {
    fs.mkdirSync(path.join(dir, '.omni', 'sdlc'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.omni', 'sdlc', 'todo.md'), body, 'utf-8');
}

function writeReqs(dir, body) {
    fs.mkdirSync(path.join(dir, '.omni', 'sdlc'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.omni', 'sdlc', 'requirements.md'), body, 'utf-8');
}

const passGate = () => ({ passed: true, results: [], failures: [] });

test('loop: CHECK pass + all-tasks-done → ACCEPTANCE (when requirements.md exists)', async () => {
    const dir = tmp();
    writeTodo(dir, '- [x] a\n');
    writeReqs(dir, '- [ ] R1 | one | test: agent\n');
    const passAcceptance = async () => ({ allMet: true, report: [{ id: 'R1', text: 'one', met: true, method: 'agent', evidence: 'ok' }], failed: [] });
    const final = await runHarness(dir, {
        from: 'CHECK', provider: 'dry-run', runPipeline: passGate, runAcceptance: passAcceptance,
        acceptSpecs: ['host-cli:claudecode', 'host-cli:antigravity'],
    });
    // After ACCEPTANCE all-met, loop advances to DOC (pauses before SHIP).
    assert.strictEqual(final.state, 'DOC');
    assert.strictEqual(final.status, 'paused');
    assert.ok(fs.existsSync(path.join(dir, '.omni', 'sdlc', 'conformance.md')));
});

test('loop: CHECK pass + no requirements.md → DOC (no acceptance)', async () => {
    const dir = tmp();
    writeTodo(dir, '- [x] a\n');
    const final = await runHarness(dir, {
        from: 'CHECK', provider: 'dry-run', runPipeline: passGate,
    });
    assert.strictEqual(final.state, 'DOC');
    const evs = readEvents(dir);
    const ack = evs.find((e) => e.type === 'acceptance');
    assert.ok(ack);
    assert.strictEqual(ack.allMet, true);
    assert.strictEqual(ack.total, 0);
});

test('loop: ACCEPTANCE failed → appends [ACCEPT] tasks + back to COOK', async () => {
    const dir = tmp();
    writeTodo(dir, '- [x] a\n');
    writeReqs(dir, '- [ ] R1 | qualitative | test: agent\n');
    let acceptCalls = 0;
    const acceptance = async () => {
        acceptCalls++;
        return { allMet: false, report: [{ id: 'R1', text: 'qualitative', met: false, method: 'agent', evidence: 'split' }], failed: ['R1'] };
    };
    // Stop loop after 1 round so we can inspect side effects without infinite COOK.
    const final = await runHarness(dir, {
        from: 'CHECK', provider: 'dry-run', runPipeline: passGate, runAcceptance: acceptance,
        acceptSpecs: ['host-cli:claudecode', 'host-cli:antigravity'],
        budget: { maxIterations: 3, maxAcceptanceRounds: 5 },
    });
    assert.strictEqual(acceptCalls, 1);
    const todo = fs.readFileSync(path.join(dir, '.omni', 'sdlc', 'todo.md'), 'utf-8');
    assert.match(todo, /\[ACCEPT\] R1/);
    // After ACCEPTANCE goes to COOK, the loop should have left ACCEPTANCE.
    assert.notStrictEqual(final.state, 'ACCEPTANCE');
});

test('loop: ACCEPTANCE over maxAcceptanceRounds → BLOCKED escalate with unmet list', async () => {
    const dir = tmp();
    writeTodo(dir, '- [x] a\n');
    writeReqs(dir, '- [ ] R1 | qualitative | test: agent\n');
    const acceptance = async () => ({
        allMet: false,
        report: [{ id: 'R1', text: 'x', met: false, method: 'agent', evidence: 'split' }],
        failed: ['R1'],
    });
    // Pre-load state with acceptanceRounds = 2 so 1 more call trips maxAcceptanceRounds=3.
    fs.mkdirSync(path.join(dir, '.omni', 'run'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.omni', 'run', 'state.json'), JSON.stringify({
        state: 'ACCEPTANCE', provider: 'dry-run', cycle: 1, fixAttempts: 0,
        acceptanceRounds: 2, iterations: 5, startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }), 'utf-8');
    const final = await runHarness(dir, {
        provider: 'dry-run', runPipeline: passGate, runAcceptance: acceptance,
        acceptSpecs: ['host-cli:claudecode', 'host-cli:antigravity'],
        budget: { maxAcceptanceRounds: 3 },
    });
    assert.strictEqual(final.state, 'BLOCKED');
    assert.strictEqual(final.status, 'blocked');
    const evs = readEvents(dir);
    assert.ok(evs.some((e) => e.type === 'blocked' && /R1/.test(e.reason)));
});

test('loop: acceptOnly + allMet → done at ACCEPTANCE (omni run accept happy path)', async () => {
    const dir = tmp();
    writeTodo(dir, '- [x] a\n');
    writeReqs(dir, '- [ ] R1 | x | test: agent\n');
    const acceptance = async () => ({
        allMet: true, report: [{ id: 'R1', text: 'x', met: true, method: 'agent', evidence: 'ok' }], failed: [],
    });
    // Seed state to ACCEPTANCE so the loop enters it directly.
    fs.mkdirSync(path.join(dir, '.omni', 'run'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.omni', 'run', 'state.json'), JSON.stringify({
        state: 'ACCEPTANCE', provider: 'dry-run', cycle: 1, fixAttempts: 0,
        acceptanceRounds: 0, iterations: 0, startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }), 'utf-8');
    const final = await runHarness(dir, {
        provider: 'dry-run', runPipeline: passGate, runAcceptance: acceptance,
        acceptSpecs: ['host-cli:claudecode', 'host-cli:antigravity'],
        acceptOnly: true,
    });
    assert.strictEqual(final.state, 'ACCEPTANCE');
    assert.strictEqual(final.status, 'done');
});

test('loop: acceptOnly + unmet → paused (no re-cook)', async () => {
    const dir = tmp();
    writeTodo(dir, '- [x] a\n');
    writeReqs(dir, '- [ ] R1 | x | test: agent\n');
    const acceptance = async () => ({
        allMet: false, report: [{ id: 'R1', text: 'x', met: false, method: 'agent', evidence: 'split' }], failed: ['R1'],
    });
    fs.mkdirSync(path.join(dir, '.omni', 'run'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.omni', 'run', 'state.json'), JSON.stringify({
        state: 'ACCEPTANCE', provider: 'dry-run', cycle: 1, fixAttempts: 0,
        acceptanceRounds: 0, iterations: 0, startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }), 'utf-8');
    const final = await runHarness(dir, {
        provider: 'dry-run', runPipeline: passGate, runAcceptance: acceptance,
        acceptSpecs: ['host-cli:claudecode', 'host-cli:antigravity'],
        acceptOnly: true,
    });
    assert.strictEqual(final.state, 'ACCEPTANCE');
    assert.strictEqual(final.status, 'paused');
});

test('loop: --spec triggers intake → requirements.md before loop starts', async () => {
    const dir = tmp();
    const specPath = path.join(dir, 'spec.md');
    fs.writeFileSync(specPath, 'A. Login\nB. Dashboard\n', 'utf-8');
    writeTodo(dir, '- [x] a\n');
    const acceptance = async () => ({ allMet: true, report: [{ id: 'R1', text: 'x', met: true, method: 'agent', evidence: 'ok' }], failed: [] });
    const final = await runHarness(dir, {
        specFile: specPath,
        from: 'CHECK', provider: 'dry-run', runPipeline: passGate, runAcceptance: acceptance,
        acceptSpecs: ['host-cli:claudecode', 'host-cli:antigravity'],
    });
    assert.ok(fs.existsSync(path.join(dir, '.omni', 'sdlc', 'requirements.md')));
    assert.ok(fs.existsSync(path.join(dir, '.omni', 'sdlc', 'customer-spec.md')));
    const evs = readEvents(dir);
    assert.ok(evs.some((e) => e.type === 'intake'));
    assert.strictEqual(final.state, 'DOC');
});
