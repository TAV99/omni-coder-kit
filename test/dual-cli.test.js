'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const BIN = path.resolve(__dirname, '../bin/omni.js');

function initGitRepo(dir) {
    spawnSync('git', ['init', '-b', 'main'], { cwd: dir, shell: false, windowsHide: true });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, shell: false, windowsHide: true });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, shell: false, windowsHide: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>Hello Dual</body></html>\n', 'utf8');
    spawnSync('git', ['add', '.'], { cwd: dir, shell: false, windowsHide: true });
    spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: dir, shell: false, windowsHide: true });
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', shell: false, windowsHide: true }).stdout.trim();
    return head;
}

function makeRepoFixture(t) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dual-cli-'));
    const head = initGitRepo(repoRoot);
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dual-cli-scratch-'));
    t.after(() => {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });
    return { repoRoot, head, scratchDir };
}

function runCli(args, options = {}) {
    const cwd = options.cwd || process.cwd();
    const env = { ...process.env, ...(options.env || {}) };
    const res = spawnSync(process.execPath, [BIN, ...args], {
        cwd,
        env,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
    });
    return {
        exitCode: res.status,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
    };
}

function createFakeAgyScript(dir, { modelList = ['gemini-3.7-flash-high'] } = {}) {
    const scriptPath = path.join(dir, `fake-agy-${crypto.randomUUID().slice(0, 8)}.cjs`);
    const content = `'use strict';
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);

if (args.includes('--version')) {
    process.stdout.write('agy version 1.1.19\\n');
    process.exit(0);
}

if (args.length === 1 && args[0] === 'models') {
    const models = ${JSON.stringify(modelList)};
    process.stdout.write(models.map((m) => m + '\\tDisplay').join('\\n') + '\\n');
    process.exit(0);
}

const promptArg = args.find((a) => a.startsWith('-p='));
const isScout = promptArg && promptArg.includes('scout');
const isImplement = promptArg && promptArg.includes('implement');
const isReview = promptArg && promptArg.includes('review');

const addDirIndex = args.indexOf('--add-dir');
const repoRoot = addDirIndex !== -1 ? args[addDirIndex + 1] : process.cwd();

let taskId = 'test-task';
let baseCommit = 'a'.repeat(40);

const inputMatch = promptArg ? promptArg.match(/Read\\s+(\\S+)/) : null;
if (inputMatch) {
    const inputPath = path.resolve(repoRoot, inputMatch[1]);
    if (fs.existsSync(inputPath)) {
        const inputContent = fs.readFileSync(inputPath, 'utf8');
        const taskMatch = inputContent.match(/#\\s*Task:\\s*(\\S+)/i) || inputContent.match(/task_id:\\s*(\\S+)/i);
        if (taskMatch) taskId = taskMatch[1].trim();
        const commitMatch = inputContent.match(/base\\s*commit:\\s*([0-9a-f]{40})/i);
        if (commitMatch) baseCommit = commitMatch[1].trim();
    }
}

if (isScout) {
    const payload = {
        schema_version: 1,
        task_id: taskId,
        expected_base_commit: baseCommit,
        summary: 'Scout analysis complete via CLI',
        relevant_files: [{ path: 'index.html', description: 'Main file' }],
        exact_symbols: [{ name: 'body', file: 'index.html', verified: true, kind: 'element' }],
        validation_commands: ['node --version'],
        constraints: [],
        risks: [],
        open_questions: [],
        research_trace: [
            { question: 'Where is the entry?', source: 'index.html', source_type: 'REPOSITORY', conclusion: 'index.html owns the behavior.' },
            { question: 'How is it checked?', source: 'node --version', source_type: 'TEST_OUTPUT', conclusion: 'Validation is available.' },
        ],
        alternatives_considered: [
            { option: 'Edit index.html', tradeoff: 'Minimal scope.' },
            { option: 'Add a module', tradeoff: 'Unnecessary complexity.' },
        ],
        failure_modes: ['The HTML body may regress.'],
    };
    process.stdout.write(JSON.stringify({ status: 'success', structured_output: payload }) + '\\n');
    process.exit(0);
}

if (isImplement) {
    const target = path.resolve(repoRoot, 'index.html');
    fs.writeFileSync(target, '<html><body>Updated by CLI Gemini</body></html>\\n', 'utf8');
    const payload = {
        schema_version: 1,
        task_id: taskId,
        expected_base_commit: baseCommit,
        status: 'SUCCESS',
        modified_files: ['index.html'],
        command_outputs: [{ command: 'node --version', exit_code: 0, output: 'v20.0.0' }],
        unverified_items: [],
        self_review: { checks: ['scope inspected', 'edge case challenged', 'validation passed'], remaining_risks: [] },
    };
    process.stdout.write(JSON.stringify({ status: 'success', structured_output: payload }) + '\\n');
    process.exit(0);
}

if (isReview) {
    const payload = {
        schema_version: 1,
        task_id: taskId,
        expected_base_commit: baseCommit,
        recommendation: 'APPROVE',
        risk_level: 'LOW',
        findings: [{ file: 'index.html', line: 1, description: 'LGTM', severity: 'INFO' }],
        review_checks: ['spec correlated', 'evidence correlated', 'regression challenged'],
        challenge_summary: 'The strongest concern was markup drift; the bounded diff resolves it.',
    };
    process.stdout.write(JSON.stringify({ status: 'success', structured_output: payload }) + '\\n');
    process.exit(0);
}

process.stdout.write(JSON.stringify({ status: 'error', message: 'Unknown phase' }) + '\\n');
process.exit(1);
`;
    fs.writeFileSync(scriptPath, content, 'utf8');
    return scriptPath;
}

test('omni dual --help: lists all five subcommands and descriptions', () => {
    const { exitCode, stdout, stderr } = runCli(['dual', '--help']);
    assert.equal(exitCode, 0);
    assert.equal(stderr, '');
    assert.match(stdout, /new <task-id>/);
    assert.match(stdout, /run <task-id>/);
    assert.match(stdout, /resume <task-id>/);
    assert.match(stdout, /status <task-id>/);
    assert.match(stdout, /phase <phase> <task-id>/);
});

test('omni dual new: creates a transaction and rejects duplicates / dirty worktree', (t) => {
    const { repoRoot, head } = makeRepoFixture(t);

    // 1. Successful new task creation
    const res = runCli(['dual', 'new', 'TASK-CLI-1'], { cwd: repoRoot });
    assert.equal(res.exitCode, 0);
    assert.match(res.stdout, /TASK-CLI-1/);
    assert.equal(res.stderr, '');

    const runDir = path.join(repoRoot, '.omni', 'codex-gemini', 'runs', 'TASK-CLI-1');
    assert.ok(fs.existsSync(path.join(runDir, 'events.ndjson')));
    assert.ok(fs.existsSync(path.join(runDir, 'state.json')));
    assert.ok(fs.existsSync(path.join(runDir, 'request.md')));

    // 2. Duplicate task creation fails with non-zero exit and no stack trace
    const dupRes = runCli(['dual', 'new', 'TASK-CLI-1'], { cwd: repoRoot });
    assert.notEqual(dupRes.exitCode, 0);
    assert.match(dupRes.stderr, /DUAL_TASK_EXISTS/);
    assert.doesNotMatch(dupRes.stderr, /\bat\s+/);

    // 3. Dirty worktree fails
    fs.writeFileSync(path.join(repoRoot, 'dirty.txt'), 'dirty content\n', 'utf8');
    const dirtyRes = runCli(['dual', 'new', 'TASK-CLI-DIRTY'], { cwd: repoRoot });
    assert.notEqual(dirtyRes.exitCode, 0);
    assert.match(dirtyRes.stderr, /DUAL_WORKTREE_DIRTY/);
    assert.doesNotMatch(dirtyRes.stderr, /\bat\s+/);
});

test('omni dual status: outputs task, state, base commit, attempts, owner, and exact next action', (t) => {
    const { repoRoot, head } = makeRepoFixture(t);

    runCli(['dual', 'new', 'TASK-STATUS-1'], { cwd: repoRoot });

    const statusRes = runCli(['dual', 'status', 'TASK-STATUS-1'], { cwd: repoRoot });
    assert.equal(statusRes.exitCode, 0);
    assert.equal(statusRes.stderr, '');

    // Assert status contains task, state, base commit, attempts, owner, and next action
    assert.match(statusRes.stdout, /TASK-STATUS-1/);
    assert.match(statusRes.stdout, /NEW/);
    assert.match(statusRes.stdout, new RegExp(head));
    assert.match(statusRes.stdout, /attempts/i);
    assert.match(statusRes.stdout, /owner/i);
    assert.match(statusRes.stdout, /codex/i);
    assert.match(statusRes.stdout, /preflight/i);

    // Non-existent task returns error without stack trace
    const notFoundRes = runCli(['dual', 'status', 'TASK-NOT-FOUND'], { cwd: repoRoot });
    assert.notEqual(notFoundRes.exitCode, 0);
    assert.match(notFoundRes.stderr, /DUAL_TASK_NOT_FOUND/);
    assert.doesNotMatch(notFoundRes.stderr, /\bat\s+/);
});

test('omni dual phase: executes preflight and scout with fake Agy seam', (t) => {
    const { repoRoot, scratchDir } = makeRepoFixture(t);
    const fakeAgyScript = createFakeAgyScript(scratchDir);

    const env = {
        OMNI_DUAL_AGY_COMMAND: process.execPath,
        OMNI_DUAL_AGY_PREFIX_ARGS: JSON.stringify([fakeAgyScript]),
    };

    runCli(['dual', 'new', 'TASK-PHASE-1'], { cwd: repoRoot, env });

    // Run preflight
    const pfRes = runCli(['dual', 'phase', 'preflight', 'TASK-PHASE-1'], { cwd: repoRoot, env });
    assert.equal(pfRes.exitCode, 0);
    assert.equal(pfRes.stderr, '');
    assert.match(pfRes.stdout, /PREFLIGHT_SAFE/);
    assert.match(pfRes.stdout, /scout/);

    // Run scout
    const scoutRes = runCli(['dual', 'phase', 'scout', 'TASK-PHASE-1'], { cwd: repoRoot, env });
    assert.equal(scoutRes.exitCode, 0);
    assert.equal(scoutRes.stderr, '');
    assert.match(scoutRes.stdout, /SCOUT_VALID/);
    assert.match(scoutRes.stdout, /spec/);

    // Normal success does not expose raw Agy stdout in terminal
    assert.doesNotMatch(scoutRes.stdout, /"structured_output"/);

    // Invalid phase fails cleanly without stack trace
    const badPhaseRes = runCli(['dual', 'phase', 'invalid_phase', 'TASK-PHASE-1'], { cwd: repoRoot, env });
    assert.notEqual(badPhaseRes.exitCode, 0);
    assert.match(badPhaseRes.stderr, /DUAL_CONTRACT_INVALID|DUAL_UNKNOWN_PHASE/);
    assert.doesNotMatch(badPhaseRes.stderr, /\bat\s+/);
});

test('omni dual run: executes pipeline and reaches CODEX_QC / CODEX_OWNED with exit code 0', (t) => {
    const { repoRoot, head, scratchDir } = makeRepoFixture(t);
    const fakeAgyScript = createFakeAgyScript(scratchDir);

    const env = {
        OMNI_DUAL_AGY_COMMAND: process.execPath,
        OMNI_DUAL_AGY_PREFIX_ARGS: JSON.stringify([fakeAgyScript]),
    };

    // 1. Run task until spec is needed (stops at SCOUT_VALID with exit code 0)
    runCli(['dual', 'new', 'TASK-RUN-1'], { cwd: repoRoot, env });
    const run1 = runCli(['dual', 'run', 'TASK-RUN-1'], { cwd: repoRoot, env });
    assert.equal(run1.exitCode, 0);
    assert.match(run1.stdout, /SCOUT_VALID/);

    // 2. Provide spec.json and run to completion (CODEX_QC)
    const runDir = path.join(repoRoot, '.omni', 'codex-gemini', 'runs', 'TASK-RUN-1');
    const spec = {
        schema_version: 1,
        task_id: 'TASK-RUN-1',
        expected_base_commit: head,
        goal: 'Update index.html',
        allowed_files: ['index.html'],
        deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        risk_flags: [],
        permission_authority: 'dual-init-dangerous-auto-v1',
    };
    fs.writeFileSync(path.join(runDir, 'spec.json'), JSON.stringify(spec, null, 2), 'utf8');

    const run2 = runCli(['dual', 'run', 'TASK-RUN-1'], { cwd: repoRoot, env });
    assert.equal(run2.exitCode, 0);
    assert.match(run2.stdout, /CODEX_QC/);
});

test('omni dual run: risky spec routes to CODEX_OWNED with exit code 0', (t) => {
    const { repoRoot, head, scratchDir } = makeRepoFixture(t);
    const fakeAgyScript = createFakeAgyScript(scratchDir);

    const env = {
        OMNI_DUAL_AGY_COMMAND: process.execPath,
        OMNI_DUAL_AGY_PREFIX_ARGS: JSON.stringify([fakeAgyScript]),
    };

    const newRes = runCli(['dual', 'new', 'TASK-RUN-RISKY'], { cwd: repoRoot, env });
    assert.equal(newRes.exitCode, 0);

    const runDirRisky = path.join(repoRoot, '.omni', 'codex-gemini', 'runs', 'TASK-RUN-RISKY');
    const spec = {
        schema_version: 1,
        task_id: 'TASK-RUN-RISKY',
        expected_base_commit: head,
        goal: 'Security auth redesign',
        allowed_files: ['index.html'],
        deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        risk_flags: ['security_auth'],
        permission_authority: 'dual-init-dangerous-auto-v1',
    };
    fs.writeFileSync(path.join(runDirRisky, 'spec.json'), JSON.stringify(spec, null, 2), 'utf8');

    const runRisky = runCli(['dual', 'run', 'TASK-RUN-RISKY'], { cwd: repoRoot, env });
    assert.equal(runRisky.exitCode, 0);
    assert.match(runRisky.stdout, /CODEX_OWNED/);
});

test('omni dual resume: re-runs from durable state idempotently', (t) => {
    const { repoRoot, head, scratchDir } = makeRepoFixture(t);
    const fakeAgyScript = createFakeAgyScript(scratchDir);

    const env = {
        OMNI_DUAL_AGY_COMMAND: process.execPath,
        OMNI_DUAL_AGY_PREFIX_ARGS: JSON.stringify([fakeAgyScript]),
    };

    runCli(['dual', 'new', 'TASK-RESUME-1'], { cwd: repoRoot, env });
    runCli(['dual', 'phase', 'preflight', 'TASK-RESUME-1'], { cwd: repoRoot, env });

    const resumeRes = runCli(['dual', 'resume', 'TASK-RESUME-1'], { cwd: repoRoot, env });
    assert.equal(resumeRes.exitCode, 0);
    assert.match(resumeRes.stdout, /SCOUT_VALID/);
});
