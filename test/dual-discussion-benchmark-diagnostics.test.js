'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('benchmark reads recovery diagnostics from failure artifacts offline', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-f3-diagnostics-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const filename = require.resolve('./dual-phase2-benchmark');
    const source = (await fs.readFile(filename, 'utf8')).replace(/^#!.*\n/, '')
        .replace(/main\(\)\.catch\(error => \{[^\n]+\}\);\s*$/, 'module.exports = { diagnostics };');
    const module = { exports: {} };
    vm.runInNewContext(source, { require: createRequire(filename), module, process, console });
    const rawDir = path.join(root, 'workspace/.omni/codex-gemini/runs/BENCH-T1/raw');
    await fs.mkdir(rawDir, { recursive: true });
    for (const recovery of [{ recoveryError: 'CAPABILITY_BLOCKED' }, { recoveryOutcome: 'succeeded' }]) {
        await fs.writeFile(path.join(rawDir, 'scout.failure.json'), JSON.stringify({
            phase: 'scout', attempt: 1, error_code: 'OUTCOME_UNKNOWN', ...recovery,
        }));
        const details = await module.exports.diagnostics(root, 'T1', { ok: false, stage: 'scout' }, 'OLD');
        for (const [key, value] of Object.entries(recovery)) assert.equal(details[key], value);
    }
});
