'use strict';

const { test, before, after, beforeEach, afterEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { SEVERITY_MAP, grepLandmines, groupBySeverity, formatLandminesForPlan, formatLandminesForMap } =
    require('../../lib/scanner/landmines');

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-landmines-'));
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── SEVERITY_MAP ────────────────────────────────────────────────────────────

describe('SEVERITY_MAP', () => {
    test('FIX' + 'ME maps to critical', () => {
        assert.equal(SEVERITY_MAP['FIX' + 'ME'], 'critical');
    });

    test('XX' + 'X maps to critical', () => {
        assert.equal(SEVERITY_MAP['XX' + 'X'], 'critical');
    });

    test('HA' + 'CK maps to warning', () => {
        assert.equal(SEVERITY_MAP['HA' + 'CK'], 'warning');
    });

    test('TO' + 'DO maps to info', () => {
        assert.equal(SEVERITY_MAP['TO' + 'DO'], 'info');
    });
});

// ─── grepLandmines ───────────────────────────────────────────────────────────

describe('grepLandmines', () => {
    test('finds landmines with correct severity, critical sorted first', () => {
        fs.writeFileSync(path.join(tmpDir, 'app.js'), '// TO' + 'DO: refactor\n// FIX' + 'ME: broken\n');
        const result = grepLandmines(tmpDir, ['app.js']);
        assert.equal(result.length, 2);
        // After sort, critical should come before info
        assert.equal(result[0].type, 'FIX' + 'ME');
        assert.equal(result[0].severity, 'critical');
        assert.equal(result[1].type, 'TO' + 'DO');
        assert.equal(result[1].severity, 'info');
    });

    test('includes context lines (before and after)', () => {
        fs.writeFileSync(path.join(tmpDir, 'app.js'), 'line one\n// HA' + 'CK: workaround\nline three\n');
        const result = grepLandmines(tmpDir, ['app.js']);
        assert.equal(result.length, 1);
        assert.ok(result[0].context.includes('line one'), 'context should include preceding line');
        assert.ok(result[0].context.includes('line three'), 'context should include following line');
    });

    test('caps at MAX_LANDMINES (50)', () => {
        const lines = Array.from({ length: 60 }, (_, i) => '// TO' + 'DO: item ' + i).join('\n');
        fs.writeFileSync(path.join(tmpDir, 'big.js'), lines);
        const result = grepLandmines(tmpDir, ['big.js']);
        assert.ok(result.length <= 50, `expected <= 50 but got ${result.length}`);
    });

    test('sorts critical first across multiple keywords', () => {
        fs.writeFileSync(path.join(tmpDir, 'app.js'), '// TO' + 'DO: low\n// FIX' + 'ME: high\n// HA' + 'CK: mid\n');
        const result = grepLandmines(tmpDir, ['app.js']);
        assert.equal(result[0].severity, 'critical');
    });

    test('skips non-source files (e.g. .txt)', () => {
        fs.writeFileSync(path.join(tmpDir, 'notes.txt'), '// TO' + 'DO: ignored\n');
        const result = grepLandmines(tmpDir, ['notes.txt']);
        assert.equal(result.length, 0);
    });

    test('truncates text at 120 characters', () => {
        const longDesc = 'x'.repeat(200);
        fs.writeFileSync(path.join(tmpDir, 'app.js'), '// TO' + 'DO: ' + longDesc + '\n');
        const result = grepLandmines(tmpDir, ['app.js']);
        assert.equal(result.length, 1);
        assert.ok(result[0].text.length <= 120, `expected text.length <= 120 but got ${result[0].text.length}`);
    });

    test('skips files larger than MAX_FILE_SIZE (1MB)', () => {
        const bigContent = '// TO' + 'DO: should be skipped\n' + 'x'.repeat(1.5 * 1024 * 1024);
        fs.writeFileSync(path.join(tmpDir, 'huge.js'), bigContent);
        const result = grepLandmines(tmpDir, ['huge.js']);
        assert.equal(result.length, 0, 'large files should be silently skipped');
    });
});

// ─── groupBySeverity ─────────────────────────────────────────────────────────

describe('groupBySeverity', () => {
    test('groups landmines into correct severity buckets', () => {
        const landmines = [
            { severity: 'critical', type: 'FIX' + 'ME', text: 'a' },
            { severity: 'info', type: 'TO' + 'DO', text: 'b' },
            { severity: 'warning', type: 'HA' + 'CK', text: 'c' },
            { severity: 'critical', type: 'XX' + 'X', text: 'd' },
        ];
        const groups = groupBySeverity(landmines);
        assert.equal(groups.critical.length, 2);
        assert.equal(groups.warning.length, 1);
        assert.equal(groups.info.length, 1);
    });

    test('returns empty arrays for empty input', () => {
        const groups = groupBySeverity([]);
        assert.deepEqual(groups, { critical: [], warning: [], info: [] });
    });
});

// ─── formatLandminesForPlan ──────────────────────────────────────────────────

describe('formatLandminesForPlan', () => {
    test('returns markdown checklist with severity headers and checkbox format', () => {
        const landmines = [
            { file: 'src/a.js', line: 10, type: 'FIX' + 'ME', severity: 'critical', text: 'broken thing', context: '' },
            { file: 'src/b.js', line: 5, type: 'TO' + 'DO', severity: 'info', text: 'refactor me', context: '' },
        ];
        const output = formatLandminesForPlan(landmines);
        assert.ok(output.includes('🔴 Critical'), 'should include critical header');
        assert.ok(output.includes('ℹ️ Info'), 'should include info header');
        assert.ok(output.includes('- [ ]'), 'should include checkbox format');
    });
});

// ─── formatLandminesForMap ───────────────────────────────────────────────────

describe('formatLandminesForMap', () => {
    test('limits items per group to maxPerGroup=3', () => {
        const landmines = Array.from({ length: 6 }, (_, i) => ({
            file: 'src/file' + i + '.js', line: i + 1, type: 'TO' + 'DO', severity: 'info', text: 'item ' + i, context: '',
        }));
        const output = formatLandminesForMap(landmines, 3);
        // 3 shown + 1 "more" line, so only 3 actual items before the "more" note
        const itemLines = output.split('\n').filter(l => l.startsWith('- `src/'));
        assert.equal(itemLines.length, 3, `expected 3 item lines but got ${itemLines.length}`);
        assert.ok(output.includes('3 more'), 'should show remaining count');
    });
});
