'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGateCommand } = require('../lib/harness/tools/build-test');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'omni-lint-test-')); }
function write(dir, rel, body) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body, 'utf-8');
    return f;
}

test('runGateCommand: auto-lint fix success converts fail to pass', () => {
    const dir = tmp();
    // Setup package.json with eslint
    write(dir, 'package.json', JSON.stringify({
        name: 'test-project',
        devDependencies: {
            eslint: '^8.0.0'
        },
        scripts: {
            lint: 'eslint .'
        }
    }));

    // Mock runner that tracks commands executed
    const executed = [];
    const mockRunner = (cmd, opts) => {
        executed.push(cmd);
        if (cmd === 'npm run lint') {
            // First time it runs: return exitCode 1 (fail)
            // Second time (after fix): return exitCode 0 (pass)
            const isSecondRun = executed.filter(c => c === 'npm run lint').length > 1;
            return { exitCode: isSecondRun ? 0 : 1, stdout: isSecondRun ? 'Passed after fix' : 'Formatting error', stderr: '', timedOut: false };
        }
        if (cmd === 'npx eslint --fix .') {
            return { exitCode: 0, stdout: 'Fixed', stderr: '', timedOut: false };
        }
        return { exitCode: 1, stdout: '', stderr: '', timedOut: false };
    };

    const res = runGateCommand(dir, 'lint', { runner: mockRunner });
    
    assert.strictEqual(res.ran, true);
    assert.strictEqual(res.passed, true); // Should be converted to pass
    assert.ok(executed.includes('npx eslint --fix .'), 'Should have run eslint --fix');
    assert.strictEqual(executed.filter(c => c === 'npm run lint').length, 2, 'Should re-run eslint check');
});
