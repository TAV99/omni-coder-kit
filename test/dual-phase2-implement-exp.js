#!/usr/bin/env node
'use strict';

// Standalone live experiment: no product changes, imports or writes before the gate.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const ROOT = '/home/hatch/workspace/.exp-briefs/impl-exp';
const MODEL = 'gemini-3.8-flash-high';
const TIMEOUT_MS = 180000;
const BRIEF = [
    'Implement parseConfig(text) in lib/parse.js, exported through entry.js.',
    "Parse newline-separated key=value pairs: 'a=1\\nb=two' yields {a:'1', b:'two'}.",
    'Trim whitespace around keys and values. Skip empty lines and lines starting with #.',
    'Edit lib/parse.js only. Preserve the existing CommonJS export. Run node --test.',
    'Do not commit or change tests or entry.js.',
].join('\n');
const SMOKE = `const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConfig } = require('../entry');
test('parses pairs', () => assert.deepEqual(parseConfig('a=1\\nb=two'), {a:'1', b:'two'}));
test('trims keys and values', () => assert.deepEqual(parseConfig(' a = 1 \\n b = two '), {a:'1', b:'two'}));
test('skips empty lines and comments', () => assert.deepEqual(parseConfig('\\n#comment=ignored\\na=1\\n\\nb=two\\n'), {a:'1', b:'two'}));
`;
const CORRECTION_TEST = `test('skips indented comments', () => assert.deepEqual(parseConfig('  #comment=ignored\\na=1\\n\\t#another=ignored'), {a:'1'}));
`;
const CORRECTION = 'The smoke tests also require lines where # appears after leading spaces to be treated as comments. Adjust lib/parse.js accordingly. Do not change other behavior.';

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10000 });
}
function setup(cwd) {
    // Only the two fixed fixture directories are ever recreated.
    if (![path.join(ROOT, 'ws-cold'), path.join(ROOT, 'ws-conv')].includes(cwd)) {
        throw new Error('Unexpected fixture path');
    }
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.mkdirSync(path.join(cwd, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'test'));
    fs.writeFileSync(path.join(cwd, 'entry.js'), "module.exports = require('./lib/parse.js');\n");
    fs.writeFileSync(path.join(cwd, 'lib/parse.js'), 'function parseConfig(text) { return {}; }\nmodule.exports = { parseConfig };\n');
    fs.writeFileSync(path.join(cwd, 'test/smoke.test.js'), SMOKE);
    git(cwd, ['init', '--quiet']);
    // Index baseline supports git diff without a fixture commit or a HEAD.
    git(cwd, ['add', '--', 'entry.js', 'lib/parse.js', 'test/smoke.test.js']);
    fs.writeFileSync(path.join(cwd, '.git/fixture.tree'), git(cwd, ['write-tree']).trim());
}
function inspect(cwd) {
    let testsPass = false;
    let testOutput;
    try {
        testOutput = execFileSync(process.execPath, ['--test'], {
            cwd, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
        });
        testsPass = true;
    } catch (error) {
        testOutput = String(error.stdout || '') + String(error.stderr || error.message);
    }
    const baseline = fs.readFileSync(path.join(cwd, '.git/fixture.tree'), 'utf8');
    const harnessTestPath = path.join(cwd, '.git/harness-test.js');
    const harnessTest = fs.existsSync(harnessTestPath) && fs.existsSync(path.join(cwd, 'test/smoke.test.js'))
        && fs.readFileSync(harnessTestPath, 'utf8') === fs.readFileSync(path.join(cwd, 'test/smoke.test.js'), 'utf8');
    const changedFiles = [...new Set([
        ...git(cwd, ['diff', baseline, '--name-only']).trim().split('\n'),
        ...git(cwd, ['ls-files', '--others', '--exclude-standard']).trim().split('\n'),
    ].filter(file => file && !(file === 'test/smoke.test.js' && harnessTest)))].sort();
    return { testsPass, changedFiles,
        scopePass: changedFiles.every(file => file === 'lib/parse.js'),
        diffStat: git(cwd, ['diff', baseline, '--stat', '--', ...(changedFiles.length ? changedFiles : ['lib/parse.js'])]),
        fullDiffStat: git(cwd, ['diff', baseline, '--stat']),
        status: git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']), testOutput };
}
async function invoke(invocation, evidencePath, runProcess) {
    const start = performance.now();
    let raw;
    let processError;
    try { raw = await runProcess(invocation); }
    catch (error) { processError = { code: error.code, message: error.message, cause: error.cause?.code }; }
    const wallMs = Math.round(performance.now() - start);
    writeJson(evidencePath, { invocation, raw, processError });
    let payload;
    let jsonError;
    if (raw) {
        try { payload = JSON.parse(raw.stdout); }
        catch (error) { jsonError = error.message; }
    }
    const failureStage = processError ? 'spawn' : raw.timedOut ? 'timeout'
        : raw.exitCode !== 0 ? 'cli_exit' : !payload ? 'cli_json' : null;
    return { wallMs, conversation_id: payload?.conversation_id ?? null,
        responseEmpty: payload && Object.hasOwn(payload, 'response')
            ? payload.response == null || payload.response === '' : null,
        ...(payload && Object.hasOwn(payload, 'denied_actions') ? { denied_actions: payload.denied_actions } : {}),
        exitCode: raw?.exitCode ?? null, timedOut: raw?.timedOut ?? false,
        failureStage, processError, jsonError, evidencePath };
}

async function main() {
    if (process.env.OMNI_DUAL_LIVE !== '1') {
        console.log('Usage: OMNI_DUAL_LIVE=1 node test/dual-phase2-implement-exp.js <report-json-path>');
        return;
    }
    if (process.argv.length !== 3) throw new Error('Exactly one report JSON path is required');
    const output = path.resolve(process.argv[2]);
    if (output === ROOT || output.startsWith(ROOT + path.sep)) throw new Error('Report must be outside recreated fixture root');
    const { buildAgyInvocation, runProcess } = require('../lib/dual/agy-runner');
    const { EvidenceSchema, toDraft7Schema } = require('../lib/dual/contracts');
    const report = {
        armA: { wallMs: null, testsPass: null, changedFiles: null },
        armB: { turns: [], testsPassAfterTurn1: null, testsPassAfterTurn2: null,
            changedFiles: null, conversationStable: null },
        environment: { startedAt: new Date().toISOString(), node: process.version, model: MODEL,
            timeoutMs: TIMEOUT_MS, workspaceRoot: ROOT, gitBaseline: 'index; no commits' },
    };
    // Fail immediately if the requested report cannot be written; never lose live observations.
    const fd = fs.openSync(output, 'wx', 0o600);
    fs.closeSync(fd);
    const save = () => writeJson(output, report);
    save();
    const cold = path.join(ROOT, 'ws-cold');
    const conv = path.join(ROOT, 'ws-conv');
    for (const [name, cwd] of [['armA', cold], ['armB', conv]]) {
        try { setup(cwd); }
        catch (error) { report[name].failureStage = 'setup'; report[name].error = { code: error.code, message: error.message }; }
        save();
    }
    if (!report.armA.failureStage) {
        console.error('Arm A: product implement invocation');
        try {
            const inputPath = path.join(cold, '.git/implement.input.md');
            const schemaPath = path.join(cold, '.git/implement.schema.json');
            fs.writeFileSync(inputPath, BRIEF + '\n\nReturn EvidenceSchema JSON with schema_version: 1, task_id: IMPL-EXP, expected_base_commit: '
                + '0'.repeat(40) + ' (fixture correlation sentinel; no commit exists).\n');
            writeJson(schemaPath, toDraft7Schema(EvidenceSchema, 'omni-dual-evidence-v1'));
            const invocation = buildAgyInvocation({ repoRoot: cold, phase: 'implement', inputPath,
                schemaPath, timeoutMs: TIMEOUT_MS, model: MODEL, effort: 'high' });
            Object.assign(report.armA, await invoke(invocation, path.join(cold, '.git/arm-a.json'), runProcess), inspect(cold));
        } catch (error) {
            report.armA.failureStage ||= 'arm_a_harness';
            report.armA.error = { code: error.code, message: error.message };
        }
        save();
    }
    if (!report.armB.failureStage) {
        try {
            const turn = async (prompt, conversationId, number) => {
                console.error(`Arm B: turn ${number}`);
                const args = ['-p', prompt, '--model', MODEL, '--mode', 'accept-edits', '--output-format', 'json',
                    ...(conversationId ? ['--conversation', conversationId] : [])];
                const result = await invoke({ command: 'agy', args, cwd: conv, timeoutMs: TIMEOUT_MS },
                    path.join(conv, `.git/turn-${number}.json`), runProcess);
                const observed = inspect(conv);
                report.armB.turns.push({ turn: number, ...result, ...observed });
                report.armB.changedFiles = observed.changedFiles;
                report.armB[`testsPassAfterTurn${number}`] = observed.testsPass;
                save();
                return result;
            };
            const first = await turn(BRIEF, null, 1);
            if (first.failureStage || !first.conversation_id) {
                report.armB.failureStage = first.failureStage || 'turn1_missing_conversation_id';
                report.armB.turn2Skipped = 'Cannot resume a successful, identified turn 1; no cold fallback';
            } else {
                // Verify the model left tests intact before advancing the harness test baseline.
                if (fs.readFileSync(path.join(conv, 'test/smoke.test.js'), 'utf8') !== SMOKE) {
                    throw new Error('Worker changed smoke tests; refusing to hide this in the harness baseline');
                }
                fs.appendFileSync(path.join(conv, 'test/smoke.test.js'), CORRECTION_TEST);
                fs.writeFileSync(path.join(conv, '.git/harness-test.js'), SMOKE + CORRECTION_TEST);
                report.armB.harnessChangedFiles = ['test/smoke.test.js'];
                report.armB.testsPassBeforeTurn2 = inspect(conv).testsPass;
                const second = await turn(CORRECTION, first.conversation_id, 2);
                report.armB.conversationStable = second.conversation_id === first.conversation_id;
                report.armB.failureStage = second.failureStage || (!report.armB.conversationStable ? 'turn2_conversation_mismatch' : null);
            }
        } catch (error) {
            report.armB.failureStage ||= 'arm_b_harness';
            report.armB.error = { code: error.code, message: error.message };
        }
        save();
    }
    console.log(JSON.stringify(report, null, 2));
    if (report.armA.failureStage || report.armB.failureStage) process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
