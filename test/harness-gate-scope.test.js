'use strict';

// Gates scan PRODUCT source only (docs/SPEC-FIX-GATE-SCOPE-AND-FIXLOOP.md
// FIX 2 / §5). This file is the regression proof for the reported incident:
// innerHTML inside .agents/skills/.../helper.js must NOT fail P0.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runSecurity } = require('../lib/harness/gates/security');
const { runContent } = require('../lib/harness/gates/content');

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-gatescope-'));
    const write = (rel, body) => {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, body, 'utf-8');
    };
    return { dir, write };
}

const noAudit = { runCommand: () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) };

describe('FIX 2 — security gate scans product source only', () => {
    test('innerHTML in .agents/skills helper → P0 PASS (infra ignored)', () => {
        const { dir, write } = fixture();
        write('.agents/skills/brainstorming/scripts/helper.js', 'el.innerHTML = data;\n');
        write('src/clean.js', 'export const ok = 1;\n');
        const r = runSecurity(dir, noAudit);
        assert.equal(r.passed, true, r.output);
    });

    test('innerHTML in src/app.js → P0 FAIL (real product finding)', () => {
        const { dir, write } = fixture();
        write('src/app.js', 'node.innerHTML = userInput;\n');
        const r = runSecurity(dir, noAudit);
        assert.equal(r.passed, false);
        assert.match(r.output, /src\/app\.js/);
        assert.match(r.output, /innerHTML/);
    });

    test('node_modules dependency code never triggers a finding', () => {
        const { dir, write } = fixture();
        write('node_modules/evil/index.js', 'eval(payload);\nx.innerHTML = y;\n');
        write('src/app.js', 'export const ok = 1;\n');
        const r = runSecurity(dir, noAudit);
        assert.equal(r.passed, true, r.output);
    });
});

describe('FIX 2 — content gate uses the same scope', () => {
    test('placeholder in .agents file is ignored; in src it is flagged', () => {
        const { dir, write } = fixture();
        write('.omni/sdlc/content-source.md', '## Forbidden Content\n- Lorem ipsum\n');
        write('.agents/skills/x/sample.md', 'Lorem ipsum dolor sit amet\n');
        const clean = runContent(dir);
        assert.equal(clean.passed, true, clean.output);

        write('src/page.md', 'Lorem ipsum dolor\n');
        const dirty = runContent(dir);
        assert.equal(dirty.passed, false);
        assert.match(dirty.output, /src\/page\.md/);
    });
});
