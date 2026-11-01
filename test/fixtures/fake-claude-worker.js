#!/usr/bin/env node
'use strict';

// Scripted stand-in for the `claude` CLI in the worker slot, for the live
// NEEDS_FIX loop (test/squad-p3-live.js --planted-bug, SPEC-SQUAD-P5 V38).
// It speaks claude's -p --output-format json shape. Attempt 1 plants a bug the
// smoke test misses (null slips through the guard); once spec.json carries a
// correction_context it writes the correct guard. Everything else in the loop -
// the reviewer, the orchestrator, the daemon and the gates - is real.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const out = (value) => { process.stdout.write(`${JSON.stringify(value)}\n`); };
const result = (fields) => out({ type: 'result', subtype: 'success', is_error: false, permission_denials: [],
    usage: { input_tokens: 1, output_tokens: 1, output_tokens_details: { thinking_tokens: 0 } }, ...fields });

if (args[0] === '--version') { process.stdout.write('2.1.316 (Claude Code)\n'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') { out({ loggedIn: true, authMethod: 'fake' }); process.exit(0); }

const prompt = args[args.indexOf('-p') + 1] || '';
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const session = resume || crypto.randomUUID();

if (prompt === '/model') {
    result({ session_id: session, result: 'Usage: /model <name>. Available: sonnet, opus, haiku, fable, or a full model ID.' });
    process.exit(0);
}

const BUGGY = "'use strict';\nfunction activeIds(xs) {\n    if (xs !== null && xs !== undefined && !Array.isArray(xs)) throw new TypeError('Expected array');\n"
    + "    return (xs || []).filter(x => x.active).map(x => x.id);\n}\nmodule.exports = { activeIds };\n";
const FIXED = "'use strict';\nfunction activeIds(xs) {\n    if (!Array.isArray(xs)) throw new TypeError('Expected array');\n"
    + "    return xs.filter(x => x.active).map(x => x.id);\n}\nmodule.exports = { activeIds };\n";

function contract(text) {
    const line = text.split('\n').find((l) => l.startsWith('{"schema_version":') && l.includes('"expected_baseline"'));
    const parsed = JSON.parse(line);
    return { schema_version: parsed.schema_version, task_id: parsed.task_id, expected_baseline: parsed.expected_baseline };
}

function phasePayload(text) {
    const base = contract(text);
    if (text.includes('Review Phase Prompt')) {
        return { ...base, recommendation: 'APPROVE', risk_level: 'LOW', findings: [],
            review_checks: ['diff stays in lib/util.js', 'smoke test passes', 'arrays keep their behavior'],
            challenge_summary: 'The guard rejects non-array input and arrays still map active ids.' };
    }
    return { ...base, summary: 'activeIds in lib/util.js needs an Array.isArray guard.',
        relevant_files: [{ path: 'lib/util.js', description: 'activeIds implementation' }], exact_symbols: [{ name: 'activeIds', file: 'lib/util.js', verified: true, kind: 'function' }],
        validation_commands: ['node --test test/smoke.test.js'], constraints: ['change only lib/util.js'], risks: [], open_questions: [],
        research_trace: ['lib/util.js', 'test/smoke.test.js'].map((source) => ({ question: 'Where is activeIds?', source,
            source_type: 'REPOSITORY', conclusion: 'activeIds filters active records' })),
        alternatives_considered: [{ option: 'Guard inside activeIds', tradeoff: 'smallest change' },
            { option: 'Validate in entry.js', tradeoff: 'misses direct callers' }],
        failure_modes: ['a non-array input reaches .filter and throws the wrong error'] };
}

// Discussion: seed, then phase replies on --resume.
if (prompt.includes('Prepare for a discussion')) {
    result({ session_id: session, result: JSON.stringify({ schema_version: 1, kind: 'reply', body: 'ready' }) });
    process.exit(0);
}
if (prompt.includes('Read-only snapshot context:')) {
    result({ session_id: session, result: JSON.stringify({ schema_version: 1, kind: 'reply', body: JSON.stringify(phasePayload(prompt)) }) });
    process.exit(0);
}

// Implement: headless with --json-schema, in the worker root.
if (prompt.includes('implement phase')) {
    const runs = path.join(process.cwd(), '.omni', 'codex-gemini', 'runs');
    const taskId = fs.readdirSync(runs)[0];
    const spec = JSON.parse(fs.readFileSync(path.join(runs, taskId, 'spec.json'), 'utf8'));
    fs.writeFileSync(path.join(process.cwd(), 'lib', 'util.js'), spec.correction_context ? FIXED : BUGGY);
    const run = spawnSync(process.execPath, ['--test', 'test/smoke.test.js'], { cwd: process.cwd(), encoding: 'utf8' });
    result({ session_id: session, result: '', structured_output: {
        schema_version: spec.schema_version, task_id: taskId, expected_baseline: spec.expected_baseline, status: 'SUCCESS',
        modified_files: ['lib/util.js'], command_outputs: [{ command: 'node --test test/smoke.test.js', exit_code: run.status ?? 1,
            output: `${run.stdout || ''}${run.stderr || ''}`.slice(-2000) }],
        unverified_items: [], self_review: { checks: ['scope', 'smoke test', 'array behavior'], remaining_risks: [] } } });
    process.exit(0);
}

process.stderr.write(`fake-claude-worker: unhandled call ${JSON.stringify(args.slice(0, 3))}\n`);
process.exit(2);
