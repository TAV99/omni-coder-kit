'use strict';

// Pha 4 — intake (SPEC-PHASE-4-ACCEPTANCE-LOOP §2).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const intake = require('../lib/harness/intake');

function tmp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-intake-'));
}

function writeReq(dir, body) {
    fs.mkdirSync(path.join(dir, '.omni', 'sdlc'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.omni', 'sdlc', 'requirements.md'), body, 'utf-8');
}

test('parseRequirements: empty / missing file → []', () => {
    const dir = tmp();
    assert.deepStrictEqual(intake.parseRequirements(dir), []);
});

test('parseRequirements: extracts id/text/test/status', () => {
    const dir = tmp();
    writeReq(dir, [
        '# Requirements — demo',
        '',
        '- [ ] R1 | User can log in with email/password | test: npm test -- auth',
        '- [x] R2 | UI shows brand logo on header | test: agent',
        '- [!] R3 | API rate-limits to 60 req/min | test: ./check-rate.sh | note: fails at 80rpm',
        '',
        'random line ignored',
    ].join('\n'));
    const items = intake.parseRequirements(dir);
    assert.strictEqual(items.length, 3);
    assert.deepStrictEqual(items.map((i) => i.id), ['R1', 'R2', 'R3']);
    assert.strictEqual(items[0].status, 'pending');
    assert.strictEqual(items[1].status, 'met');
    assert.strictEqual(items[2].status, 'failed');
    assert.strictEqual(items[0].test, 'npm test -- auth');
    assert.strictEqual(items[1].test, 'agent');
    assert.strictEqual(items[2].note, 'fails at 80rpm');
});

test('updateRequirementStatus: round-trips pending → met → failed', () => {
    const dir = tmp();
    writeReq(dir, '- [ ] R1 | one | test: agent\n- [ ] R2 | two | test: agent\n');
    assert.ok(intake.updateRequirementStatus(dir, 'R1', 'met'));
    let items = intake.parseRequirements(dir);
    assert.strictEqual(items[0].status, 'met');
    assert.strictEqual(items[1].status, 'pending');

    assert.ok(intake.updateRequirementStatus(dir, 'R2', 'failed', 'reason X'));
    items = intake.parseRequirements(dir);
    assert.strictEqual(items[1].status, 'failed');
    assert.strictEqual(items[1].note, 'reason X');

    assert.ok(intake.updateRequirementStatus(dir, 'R2', 'pending'));
    items = intake.parseRequirements(dir);
    assert.strictEqual(items[1].status, 'pending');
});

test('updateRequirementStatus: unknown id → false', () => {
    const dir = tmp();
    writeReq(dir, '- [ ] R1 | one | test: agent\n');
    assert.strictEqual(intake.updateRequirementStatus(dir, 'R99', 'met'), false);
});

test('buildRequirements: provider output is written + parseable', async () => {
    const dir = tmp();
    const provider = {
        async runStep(_step, _ctx) {
            return {
                ok: true,
                summary: 'ok',
                output: [
                    'Some chatter from the model.',
                    '- [ ] R1 | App có trang đăng nhập email/password | test: npm test -- auth',
                    '- [ ] R2 | Dashboard hiển thị doanh thu hôm nay | test: agent',
                ].join('\n'),
            };
        },
    };
    const res = await intake.buildRequirements({ projectDir: dir, specText: 'spec gốc', provider });
    assert.strictEqual(res.count, 2);
    assert.ok(fs.existsSync(intake.customerSpecPath(dir)));
    assert.ok(fs.readFileSync(intake.customerSpecPath(dir), 'utf-8').includes('spec gốc'));
    const items = intake.parseRequirements(dir);
    assert.strictEqual(items[0].id, 'R1');
    assert.strictEqual(items[0].test, 'npm test -- auth');
    assert.strictEqual(items[1].test, 'agent');
});

test('buildRequirements: idempotent — does not overwrite existing requirements.md', async () => {
    const dir = tmp();
    writeReq(dir, '- [ ] R1 | original | test: agent\n');
    const provider = { async runStep() { return { output: '- [ ] R9 | replaced | test: agent' }; } };
    const res = await intake.buildRequirements({ projectDir: dir, specText: 'x', provider });
    assert.ok(res.skipped);
    const items = intake.parseRequirements(dir);
    assert.strictEqual(items[0].id, 'R1');
    assert.strictEqual(items[0].text, 'original');
});

test('buildRequirements: empty spec throws', async () => {
    const dir = tmp();
    await assert.rejects(intake.buildRequirements({ projectDir: dir, specText: '', provider: null }), /rỗng/);
});

test('buildRequirements: provider with no usable output → fallback checklist still parseable', async () => {
    const dir = tmp();
    const provider = { async runStep() { return { output: 'I think...' }; } };
    const res = await intake.buildRequirements({
        projectDir: dir,
        specText: 'Yêu cầu 1\nYêu cầu 2',
        provider,
    });
    assert.ok(res.count >= 1);
    const items = intake.parseRequirements(dir);
    assert.ok(items.length >= 1);
    assert.match(items[0].id, /^R\d+$/);
});

test('extractChecklist / fallbackChecklist helpers', () => {
    assert.strictEqual(intake.extractChecklist('no rows here'), null);
    const ok = intake.extractChecklist('- [ ] R1 | x | test: agent');
    assert.match(ok, /R1/);
    assert.match(intake.fallbackChecklist(''), /R1/);
});
