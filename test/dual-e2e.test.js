'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { createDualOrchestrator } = require('../lib/dual');
const { createDiscussionStub } = require('./helpers/dual-discussion-stub');

const BIN = path.resolve(__dirname, '../bin/omni.js');
const { AttemptMetaSchema, ContextSchema, EvidenceSchema, ReviewSchema, SpecSchema } = require('../lib/dual/contracts');

function initGitRepo(dir) {
    spawnSync('git', ['init', '-b', 'main'], { cwd: dir, shell: false, windowsHide: true });
    spawnSync('git', ['config', 'user.name', 'Dual E2E Test'], { cwd: dir, shell: false, windowsHide: true });
    spawnSync('git', ['config', 'user.email', 'dual-e2e@example.com'], { cwd: dir, shell: false, windowsHide: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<!DOCTYPE html><html><body>Original Dual Content</body></html>\n', 'utf8');
    spawnSync('git', ['add', '.'], { cwd: dir, shell: false, windowsHide: true });
    spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: dir, shell: false, windowsHide: true });
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', shell: false, windowsHide: true }).stdout.trim();
    return head;
}

function makeRepoFixture(t) {
    const rawRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dual-e2e-repo-'));
    const repoRoot = fs.realpathSync.native(rawRepo);
    const head = initGitRepo(repoRoot);
    const rawScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dual-e2e-scratch-'));
    const scratchDir = fs.realpathSync.native(rawScratch);
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

function createLoggingFakeAgyScript(dir, { repoRoot, head, taskId }) {
    const logFile = path.join(dir, 'agy-invocations.json');
    const countersFile = path.join(dir, 'agy-counters.json');
    fs.writeFileSync(logFile, JSON.stringify([]), 'utf8');
    fs.writeFileSync(countersFile, JSON.stringify({ version: 0, models: 0, scout: 0, implement: 0, review: 0 }), 'utf8');

    const baseCommit = head;
    const payloads = {
        scout: {
            schema_version: 1,
            task_id: taskId,
            expected_base_commit: baseCommit,
            summary: 'E2E Scout reconnaissance complete: index.html identified for heading update',
            relevant_files: [{ path: 'index.html', description: 'Web landing page' }],
            exact_symbols: [{ name: 'body', file: 'index.html', verified: true, kind: 'element' }],
            validation_commands: ['node --version'],
            constraints: ['Keep changes minimal and preserve index.html structure'],
            risks: [],
            open_questions: [],
            research_trace: [
                { question: 'Where is the page?', source: 'index.html', source_type: 'REPOSITORY', conclusion: 'index.html owns the page.' },
                { question: 'How is it validated?', source: 'node --version', source_type: 'TEST_OUTPUT', conclusion: 'The validation runtime is available.' },
            ],
            alternatives_considered: [
                { option: 'Edit the body', tradeoff: 'Minimal diff.' },
                { option: 'Add a script', tradeoff: 'Unnecessary for static copy.' },
            ],
            failure_modes: ['The HTML structure may be accidentally replaced.'],
        },
        review: {
            schema_version: 1,
            task_id: taskId,
            expected_base_commit: baseCommit,
            recommendation: 'APPROVE',
            risk_level: 'LOW',
            findings: [{ file: 'index.html', line: 1, description: 'Surgical update verified against spec', severity: 'INFO' }],
            review_checks: ['spec correlated', 'evidence correlated', 'regression challenged'],
            challenge_summary: 'The strongest concern was structural HTML drift; the inspected output remains valid for the fixture.',
        },
    };
    const discussion = createDiscussionStub({ turn: ({ phase }) => payloads[phase] });
    const scriptPath = path.join(dir, 'fake-agy-e2e.cjs');
    const content = `'use strict';
const fs = require('node:fs');
const path = require('node:path');

const logFile = ${JSON.stringify(logFile)};
const countersFile = ${JSON.stringify(countersFile)};

function logInvocation(entry) {
    const logs = JSON.parse(fs.readFileSync(logFile, 'utf8') || '[]');
    logs.push(entry);
    fs.writeFileSync(logFile, JSON.stringify(logs, null, 2), 'utf8');
}

function incrementCounter(key) {
    const counters = JSON.parse(fs.readFileSync(countersFile, 'utf8') || '{}');
    counters[key] = (counters[key] || 0) + 1;
    fs.writeFileSync(countersFile, JSON.stringify(counters, null, 2), 'utf8');
}

const args = process.argv.slice(2);
logInvocation({
    args,
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
});

if (args.includes('--version')) {
    incrementCounter('version');
    process.stdout.write('agy version 1.1.19\\n');
    process.exit(0);
}

if (args.length === 1 && args[0] === 'models') {
    incrementCounter('models');
    process.stdout.write('gemini-3.7-flash-high\\tGemini 3.7 Flash High\\ngemini-2.0-flash\\tGemini 2.0 Flash\\n');
    process.exit(0);
}

const promptArg = args.find((a) => a.startsWith('-p='));
const isImplement = promptArg && promptArg.includes('implement');

const addDirIndex = args.indexOf('--add-dir');
const repoRoot = addDirIndex !== -1 ? args[addDirIndex + 1] : process.cwd();

let taskId = 'E2E-TASK';
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

if (isImplement) {
    incrementCounter('implement');
    const target = path.resolve(repoRoot, 'index.html');
    fs.writeFileSync(target, '<!DOCTYPE html><html><body>Updated by Dual E2E Gemini</body></html>\\n', 'utf8');
    const payload = {
        schema_version: 1,
        task_id: taskId,
        expected_base_commit: baseCommit,
        status: 'SUCCESS',
        modified_files: ['index.html'],
        command_outputs: [{ command: 'node --version', exit_code: 0, output: 'v20.0.0' }],
        unverified_items: [],
        self_review: { checks: ['scope inspected', 'markup challenged', 'validation passed'], remaining_risks: [] },
    };
    process.stdout.write(JSON.stringify({ status: 'success', structured_output: payload }) + '\\n');
    process.exit(0);
}

process.stdout.write(JSON.stringify({ status: 'error', message: 'Unhandled worker phase' }) + '\\n');
process.exit(1);
`;
    fs.writeFileSync(scriptPath, content, 'utf8');
    return { scriptPath, logFile, countersFile, discussion,
        async createOrchestrator() {
            // Git-backed standalone fixture: snapshotSha256 is absent at the resolver boundary.
            const child = await discussion.createIsolatedDiscussion({
                sessionId: 'e2e-session', taskId, planRevision: 1, attempt: 1,
                workerRoot: repoRoot, workerBaselineId: undefined,
                reference: { bindingSha256: 'a'.repeat(64) },
            });
            return { child, orch: createDualOrchestrator({ cwd: repoRoot,
                agyCommand: process.execPath, agyPrefixArgs: [scriptPath], discussion: child }) };
        },
    };
}

test('Dual end-to-end: full state path to CODEX_QC with metadata and idempotency verification', async (t) => {
    const { repoRoot, head, scratchDir } = makeRepoFixture(t);
    const taskId = 'E2E-TASK-001';
    const fixture = createLoggingFakeAgyScript(scratchDir, { repoRoot, head, taskId });
    const { scriptPath, logFile, countersFile, discussion } = fixture;

    const env = {
        OMNI_DUAL_AGY_COMMAND: process.execPath,
        OMNI_DUAL_AGY_PREFIX_ARGS: JSON.stringify([scriptPath]),
    };

    // 1. Create transaction via public CLI
    const newRes = runCli(['dual', 'new', taskId], { cwd: repoRoot, env });
    assert.equal(newRes.exitCode, 0, `dual new failed: ${newRes.stderr}`);
    assert.match(newRes.stdout, new RegExp(taskId));

    const runDir = path.join(repoRoot, '.omni', 'codex-gemini', 'runs', taskId);
    assert.ok(fs.existsSync(path.join(runDir, 'events.ndjson')), 'events.ndjson must exist');
    assert.ok(fs.existsSync(path.join(runDir, 'state.json')), 'state.json must exist');
    assert.ok(fs.existsSync(path.join(runDir, 'request.md')), 'request.md must exist');

    // 2. The injected discussion host runs scout; CLI has no standalone host.
    const { orch, child } = await fixture.createOrchestrator();
    t.after(() => child.close());
    assert.equal((await orch.run(taskId)).state, 'SCOUT_VALID');

    const contextPath = path.join(runDir, 'context.json');
    assert.ok(fs.existsSync(contextPath), 'context.json must exist after scout');
    const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
    assert.doesNotThrow(() => ContextSchema.parse(context), 'context.json must satisfy ContextSchema');
    assert.equal(context.task_id, taskId);
    assert.equal(context.expected_base_commit, head);

    // 3. Codex creates approved spec.json
    const spec = {
        schema_version: 1,
        task_id: taskId,
        expected_base_commit: head,
        goal: 'Update landing page body text in index.html',
        allowed_files: ['index.html'],
        deny_patterns: ['**/.env*'],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        risk_flags: [],
        permission_authority: 'dual-init-dangerous-auto-v1',
    };
    assert.doesNotThrow(() => SpecSchema.parse(spec), 'spec fixture must satisfy SpecSchema');
    fs.writeFileSync(path.join(runDir, 'spec.json'), JSON.stringify(spec, null, 2), 'utf8');

    // 4. Standalone review fails closed; the injected host can then finish the same task.
    for (const phase of ['spec', 'route', 'implement', 'scope']) await orch.runPhase(phase, taskId);
    const eventsBeforeReview = fs.readFileSync(path.join(runDir, 'events.ndjson'), 'utf8');
    const coldReview = runCli(['dual', 'phase', 'review', taskId], {
        cwd: repoRoot, env: { ...env, OMNI_DUAL_DISCUSSION_ENABLED: '0' },
    });
    assert.equal(coldReview.exitCode, 1);
    assert.ok(coldReview.stderr.includes('[DUAL_DISCUSSION_REQUIRED] Scout/review cần discussion transport do daemon cấp. Hãy chạy qua authority daemon; CLI độc lập không có discussion host, tắt discussion không khôi phục đường chạy lạnh.'));
    assert.equal(fs.readFileSync(path.join(runDir, 'events.ndjson'), 'utf8'), eventsBeforeReview);
    assert.equal((await orch.run(taskId)).state, 'CODEX_QC');
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')).state, 'CODEX_QC');

    // 5. Verify semantic artifacts
    assert.ok(fs.existsSync(path.join(runDir, 'route.json')), 'route.json must exist');
    assert.ok(fs.existsSync(path.join(runDir, 'evidence.json')), 'evidence.json must exist');
    assert.ok(fs.existsSync(path.join(runDir, 'review.json')), 'review.json must exist');

    const evidence = JSON.parse(fs.readFileSync(path.join(runDir, 'evidence.json'), 'utf8'));
    assert.doesNotThrow(() => EvidenceSchema.parse(evidence), 'evidence.json must satisfy EvidenceSchema');
    assert.equal(evidence.status, 'SUCCESS');
    assert.deepEqual(evidence.modified_files, ['index.html']);

    const review = JSON.parse(fs.readFileSync(path.join(runDir, 'review.json'), 'utf8'));
    assert.doesNotThrow(() => ReviewSchema.parse(review), 'review.json must satisfy ReviewSchema');
    assert.equal(review.recommendation, 'APPROVE');

    // 6. Verify status output
    const statusRes = runCli(['dual', 'status', taskId], { cwd: repoRoot, env });
    assert.equal(statusRes.exitCode, 0, `status check failed: ${statusRes.stderr}`);
    assert.match(statusRes.stdout, /CODEX_QC/);
    assert.match(statusRes.stdout, /codex/i);

    // 7. Assert raw attempt metadata for all worker phases (scout, implement, review)
    const phases = ['scout', 'implement', 'review'];
    for (const phase of phases) {
        const metaPath = path.join(runDir, 'raw', `${phase}.1.meta.json`);
        assert.ok(fs.existsSync(metaPath), `raw metadata must exist for phase: ${phase}`);
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

        // Strict schema parsing
        assert.doesNotThrow(() => AttemptMetaSchema.parse(meta), `AttemptMetaSchema must accept ${phase} metadata`);

        // Explicit requirement assertions
        assert.equal(meta.schema_version, 1);
        assert.equal(meta.task_id, taskId);
        assert.equal(meta.expected_base_commit, head);
        assert.equal(meta.phase, phase);
        assert.equal(meta.attempt, 1);
        assert.equal(typeof meta.package_version, 'string');
        assert.ok(meta.package_version.length > 0);
        assert.equal(meta.agy_version, '1.1.19');
        assert.equal(typeof meta.duration_ms, 'number');
        assert.ok(meta.duration_ms >= 0);
        assert.equal(meta.exit_code, 0);
        assert.equal(meta.timed_out, false);
        assert.equal(meta.shell, false, 'shell must be strictly false');
        assert.equal(meta.cwd, repoRoot, 'meta cwd must be canonical repo root');
        assert.ok(Array.isArray(meta.redacted_argv), 'redacted_argv must be an array');
        if (phase !== 'implement') {
            assert.equal(meta.transport, 'discussion');
            assert.deepEqual(meta.redacted_argv, []);
            assert.ok(meta.messageId);
            assert.ok(meta.responseMessageId);
        }
        assert.match(meta.input_sha256, /^[0-9a-f]{64}$/, 'input_sha256 must be a 64-char sha256 hex');
        assert.match(meta.schema_sha256, /^[0-9a-f]{64}$/, 'schema_sha256 must be a 64-char sha256 hex');

        // Check stdout and stderr raw files exist
        assert.ok(fs.existsSync(path.join(runDir, 'raw', `${phase}.1.stdout.json`)));
        assert.ok(fs.existsSync(path.join(runDir, 'raw', `${phase}.1.stderr.txt`)));
    }

    // 8. Assert Agy invocations received canonical repo root and short repo-relative input references
    const invocations = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    const workerInvocations = invocations.filter((inv) => inv.args.some((a) => a.startsWith('-p=')));
    assert.equal(workerInvocations.length, 1, 'Only implement may invoke a cold worker');
    assert.deepEqual(discussion.counters.turns.map(({ phase }) => phase), ['scout', 'review']);
    assert.equal(discussion.counters.seeds.length, 2);

    for (const inv of workerInvocations) {
        const addDirIdx = inv.args.indexOf('--add-dir');
        assert.notEqual(addDirIdx, -1, 'Agy invocation must include --add-dir');
        assert.equal(inv.args[addDirIdx + 1], repoRoot, 'Agy --add-dir must be canonical repo root');

        const promptArg = inv.args.find((a) => a.startsWith('-p='));
        assert.ok(promptArg, 'Agy invocation must include -p= argument');
        assert.match(
            promptArg,
            /^-p=Read \.omni\/codex-gemini\/runs\/E2E-TASK-001\/raw\/implement\.\d+\.input\.md/,
            'Prompt argument must use short repo-relative input path, not absolute path or raw json',
        );

        assert.ok(inv.args.includes('--dangerously-skip-permissions'), 'Agy invocation must bypass permissions');
        assert.ok(inv.args.includes('gemini-3.7-flash-high'), 'Agy invocation must specify gemini-3.7-flash-high');
    }

    // 9. Assert only allowed source files changed in the git worktree
    const statusProc = spawnSync('git', ['status', '--porcelain=v1'], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
    });
    const statusLines = statusProc.stdout.trim().split('\n').filter(Boolean);
    const sourceChanges = statusLines.filter((l) => !l.includes('.omni'));
    assert.equal(sourceChanges.length, 1, 'Only index.html should have source modifications');
    assert.match(sourceChanges[0], /M\s+index\.html/);

    const diffProc = spawnSync('git', ['diff', '--name-only', head], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
    });
    assert.equal(diffProc.stdout.trim(), 'index.html', 'git diff must only contain index.html');

    // 10. Assert no commit, push, deploy, stash, reset, or global config write occurred
    const currentHead = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
    }).stdout.trim();
    assert.equal(currentHead, head, 'HEAD commit must remain unchanged (no auto-commit)');

    const reflogProc = spawnSync('git', ['reflog'], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
    });
    const reflogLines = reflogProc.stdout.trim().split('\n').filter(Boolean);
    assert.equal(reflogLines.length, 1, 'Reflog must only contain the initial commit entry');

    const runtimeSource = [
        path.resolve(__dirname, '../lib/dual/agy-runner.js'),
        path.resolve(__dirname, '../lib/dual/orchestrator.js'),
        path.resolve(__dirname, '../lib/commands/dual.js'),
    ].map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    assert.doesNotMatch(runtimeSource, /\b(?:powershell|pwsh|cmd\.exe)\b/i, 'Node Dual runtime must not invoke a platform shell');
    assert.doesNotMatch(runtimeSource, /shell\s*:\s*true/i, 'Node Dual runtime must never opt into shell execution');
    assert.doesNotMatch(
        runtimeSource,
        /(?:\[\s*|args\.push\(\s*)['"](?:push|deploy|stash|reset|config)['"]/i,
        'Node Dual runtime must not issue mutating or global Git/config commands',
    );
    assert.doesNotMatch(runtimeSource, /\b(?:homedir|USERPROFILE|\.gemini)\b/, 'Node Dual runtime must not write global agent configuration');

    // 11. Assert resume idempotency (counters must not increment on subsequent resume)
    const countersBefore = JSON.parse(fs.readFileSync(countersFile, 'utf8'));
    assert.equal(countersBefore.scout, 0);
    assert.equal(countersBefore.implement, 1);
    assert.equal(countersBefore.review, 0);

    const resumeRes = runCli(['dual', 'resume', taskId], { cwd: repoRoot, env });
    assert.equal(resumeRes.exitCode, 0, `dual resume failed: ${resumeRes.stderr}`);
    assert.match(resumeRes.stdout, /CODEX_QC/);

    assert.equal(discussion.counters.turns.length, 2, 'Resume must not dispatch discussion turns');
    assert.equal(discussion.counters.seeds.length, 2, 'Resume must not seed conversations');
    const countersAfter = JSON.parse(fs.readFileSync(countersFile, 'utf8'));
    assert.equal(countersAfter.scout, countersBefore.scout, 'Scout counter must not increment on resume');
    assert.equal(countersAfter.implement, countersBefore.implement, 'Implement counter must not increment on resume');
    assert.equal(countersAfter.review, countersBefore.review, 'Review counter must not increment on resume');
});

test('Dual end-to-end: routed to CODEX_OWNED when spec contains risk flags or too many files', async (t) => {
    const { repoRoot, head, scratchDir } = makeRepoFixture(t);
    const taskId = 'E2E-TASK-RISK';
    const fixture = createLoggingFakeAgyScript(scratchDir, { repoRoot, head, taskId });
    const { scriptPath } = fixture;

    const env = {
        OMNI_DUAL_AGY_COMMAND: process.execPath,
        OMNI_DUAL_AGY_PREFIX_ARGS: JSON.stringify([scriptPath]),
    };

    runCli(['dual', 'new', taskId], { cwd: repoRoot, env });
    runCli(['dual', 'phase', 'preflight', taskId], { cwd: repoRoot, env });
    const { orch, child } = await fixture.createOrchestrator();
    t.after(() => child.close());
    assert.equal((await orch.runPhase('scout', taskId)).state, 'SCOUT_VALID');

    const runDir = path.join(repoRoot, '.omni', 'codex-gemini', 'runs', taskId);
    const riskySpec = {
        schema_version: 1,
        task_id: taskId,
        expected_base_commit: head,
        goal: 'Core architecture overhaul and security changes',
        allowed_files: ['index.html'],
        deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        risk_flags: ['architecture', 'security'],
        permission_authority: 'dual-init-dangerous-auto-v1',
    };
    fs.writeFileSync(path.join(runDir, 'spec.json'), JSON.stringify(riskySpec, null, 2), 'utf8');

    assert.equal((await orch.run(taskId)).state, 'CODEX_OWNED');
    assert.deepEqual(fixture.discussion.counters.turns.map(({ phase }) => phase), ['scout']);

    const route = JSON.parse(fs.readFileSync(path.join(runDir, 'route.json'), 'utf8'));
    assert.equal(route.owner, 'codex');
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8')).state, 'CODEX_OWNED');
    assert.equal(fs.existsSync(path.join(runDir, 'evidence.json')), false, 'Evidence must not exist for Codex-owned task');
    assert.equal(fs.existsSync(path.join(runDir, 'review.json')), false, 'Review must not exist for Codex-owned task');
});
