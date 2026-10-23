'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { z } = require('zod');
const { ContextSchema, EvidenceSchema, ReviewSchema, toDraft7Schema } = require('../lib/dual/contracts');
const { buildAgyInvocation, runProcess } = require('../lib/dual/agy-runner');

test('passes generated schema files through the subprocess root-type gate', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-schema-root-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const inputPath = path.join(root, 'input.md');
    const schemaPath = path.join(root, 'schema.json');
    fs.writeFileSync(inputPath, 'Read-only schema compatibility test.');
    const fixture = path.join(__dirname, 'fixtures/codex-gemini/schema-root-gate.cjs');
    async function invoke(schema, phase) {
        fs.writeFileSync(schemaPath, JSON.stringify(schema));
        const invocation = buildAgyInvocation({
            agyCommand: process.execPath,
            agyPrefixArgs: [fixture], repoRoot: root,
            phase, inputPath, schemaPath, timeoutMs: 10_000,
        });
        assert.equal(invocation.args[invocation.args.indexOf('--json-schema') + 1], schemaPath);
        return runProcess(invocation);
    }
    const bad = await invoke(z.toJSONSchema(ContextSchema, { target: 'draft-7' }), 'scout');
    assert.equal(bad.exitCode, 1);
    assert.match(bad.stderr, /schema root must specify/);
    for (const [phase, schema] of [
        ['scout', ContextSchema], ['implement', EvidenceSchema], ['review', ReviewSchema],
    ]) {
        const result = await invoke(toDraft7Schema(schema, `root-${phase}`), phase);
        assert.equal(result.exitCode, 0, result.stderr);
        assert.equal(result.timedOut, false);
        assert.deepEqual(JSON.parse(result.stdout), { accepted: true, schema_id: `root-${phase}` });
    }
});
