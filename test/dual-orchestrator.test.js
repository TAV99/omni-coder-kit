'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { createDualOrchestrator } = require('../lib/dual/orchestrator');
const { ContextSchema, EvidenceSchema, ReviewSchema } = require('../lib/dual/contracts');

function initGitRepo(dir) {
    spawnSync('git', ['init', '-b', 'main'], { cwd: dir, shell: false, windowsHide: true });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, shell: false, windowsHide: true });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, shell: false, windowsHide: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>Hello</body></html>\n', 'utf8');
    spawnSync('git', ['add', '.'], { cwd: dir, shell: false, windowsHide: true });
    spawnSync('git', ['commit', '-m', 'initial commit'], { cwd: dir, shell: false, windowsHide: true });
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', shell: false, windowsHide: true }).stdout.trim();
    return head;
}

function makeRepoFixture(t) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dual-orch-'));
    const head = initGitRepo(repoRoot);
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-dual-scratch-'));
    t.after(() => {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });
    return { repoRoot, head, scratchDir };
}

function createFakeAgyScript(dir, handlerCode) {
    const scriptPath = path.join(dir, `fake-agy-${crypto.randomUUID().slice(0, 8)}.cjs`);
    const content = `'use strict';
${handlerCode}
`;
    fs.writeFileSync(scriptPath, content, 'utf8');
    return scriptPath;
}

function standardFakeAgyScript(dir, {
    modelList = ['gemini-3.7-flash-high', 'gemini-2.0-flash'],
    scoutPayload = null,
    implementPayload = null,
    reviewPayload = null,
    implementMutateFile = null,
    reviewMutateFile = null,
    crashOnPhase = null,
} = {}) {
    const defaultScoutPayload = (taskId, baseCommit) => ({
        schema_version: 1,
        task_id: taskId,
        expected_base_commit: baseCommit,
        summary: 'Scout analysis complete',
        relevant_files: [{ path: 'index.html', description: 'Main entry file' }],
        exact_symbols: [{ name: 'body', file: 'index.html', verified: true, kind: 'element' }],
        validation_commands: ['node --version'],
        constraints: ['Keep it lightweight'],
        risks: [],
        open_questions: [],
        research_trace: [
            { question: 'Where is the entry?', source: 'index.html', source_type: 'REPOSITORY', conclusion: 'index.html owns the behavior.' },
            { question: 'How is it checked?', source: 'node --version', source_type: 'TEST_OUTPUT', conclusion: 'The validation command is available.' },
        ],
        alternatives_considered: [
            { option: 'Edit index.html', tradeoff: 'Minimal scope.' },
            { option: 'Add a module', tradeoff: 'Unnecessary complexity.' },
        ],
        failure_modes: ['The body element may be malformed.'],
    });

    const defaultImplementPayload = (taskId, baseCommit) => ({
        schema_version: 1,
        task_id: taskId,
        expected_base_commit: baseCommit,
        status: 'SUCCESS',
        modified_files: ['index.html'],
        command_outputs: [{ command: 'node --version', exit_code: 0, output: 'v20.0.0' }],
        unverified_items: [],
        self_review: { checks: ['scope inspected', 'edge case challenged', 'validation passed'], remaining_risks: [] },
    });

    const defaultReviewPayload = (taskId, baseCommit) => ({
        schema_version: 1,
        task_id: taskId,
        expected_base_commit: baseCommit,
        recommendation: 'APPROVE',
        risk_level: 'LOW',
        findings: [{ file: 'index.html', line: 1, description: 'Clean implementation', severity: 'INFO' }],
        review_checks: ['spec correlated', 'evidence correlated', 'regression challenged'],
        challenge_summary: 'The strongest concern was unintended markup drift; the surgical diff resolves it.',
    });

    return createFakeAgyScript(dir, `
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);

// Handle --version
if (args.includes('--version')) {
    process.stdout.write('agy version 1.1.19\\n');
    process.exit(0);
}

// Handle the real agy 1.1.x models command (plain tab-separated output).
if (args.length === 1 && args[0] === 'models') {
    const models = ${JSON.stringify(modelList)};
    process.stdout.write(models.map((model) => model + '\\tDisplay name').join('\\n') + '\\n');
    process.exit(0);
}

// Handle prompt execution
const promptArg = args.find(a => a.startsWith('-p='));
const isScout = promptArg && promptArg.includes('scout');
const isImplement = promptArg && promptArg.includes('implement');
const isReview = promptArg && promptArg.includes('review');

const schemaArgIndex = args.indexOf('--json-schema');
const schemaPath = schemaArgIndex !== -1 ? args[schemaArgIndex + 1] : null;

// Find repo root from --add-dir
const addDirIndex = args.indexOf('--add-dir');
const repoRoot = addDirIndex !== -1 ? args[addDirIndex + 1] : process.cwd();

// Read task_id and expected_base_commit from input file
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
    if (${JSON.stringify(crashOnPhase)} === 'scout') {
        process.exit(1);
    }
    const payload = ${JSON.stringify(scoutPayload)} || (${defaultScoutPayload.toString()})(taskId, baseCommit);
    process.stdout.write(JSON.stringify({ status: 'success', structured_output: payload }) + '\\n');
    process.exit(0);
}

if (isImplement) {
    if (${JSON.stringify(implementMutateFile)}) {
        const target = path.resolve(repoRoot, ${JSON.stringify(implementMutateFile)});
        fs.writeFileSync(target, 'mutated by implement worker\\n', 'utf8');
    } else {
        // Normal edit to index.html
        const target = path.resolve(repoRoot, 'index.html');
        fs.writeFileSync(target, '<html><body>Updated Hello</body></html>\\n', 'utf8');
    }
    const payload = ${JSON.stringify(implementPayload)} || (${defaultImplementPayload.toString()})(taskId, baseCommit);
    process.stdout.write(JSON.stringify({ status: 'success', structured_output: payload }) + '\\n');
    process.exit(0);
}

if (isReview) {
    if (${JSON.stringify(reviewMutateFile)}) {
        const target = path.resolve(repoRoot, ${JSON.stringify(reviewMutateFile)});
        fs.writeFileSync(target, 'mutated by review worker\\n', 'utf8');
    }
    const payload = ${JSON.stringify(reviewPayload)} || (${defaultReviewPayload.toString()})(taskId, baseCommit);
    process.stdout.write(JSON.stringify({ status: 'success', structured_output: payload }) + '\\n');
    process.exit(0);
}

process.stdout.write(JSON.stringify({ status: 'error', message: 'Unknown phase' }) + '\\n');
process.exit(1);
`);
}

test('newTask rejects non-repository, empty repo, dirty tree, duplicate and unsafe IDs', (t) => {
    const { repoRoot, head } = makeRepoFixture(t);

    // 1. Non-repository directory
    const nonRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-non-repo-'));
    t.after(() => fs.rmSync(nonRepoDir, { recursive: true, force: true }));
    const nonRepoOrch = createDualOrchestrator({ cwd: nonRepoDir });
    assert.throws(
        () => nonRepoOrch.newTask('TASK-1'),
        (error) => error.code === 'DUAL_NOT_GIT_REPOSITORY',
    );

    // 2. Empty repository without commits
    const emptyRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-empty-repo-'));
    t.after(() => fs.rmSync(emptyRepoDir, { recursive: true, force: true }));
    spawnSync('git', ['init', '-b', 'main'], { cwd: emptyRepoDir, shell: false, windowsHide: true });
    const emptyRepoOrch = createDualOrchestrator({ cwd: emptyRepoDir });
    assert.throws(
        () => emptyRepoOrch.newTask('TASK-1'),
        (error) => error.code === 'DUAL_GIT_HEAD_MISSING',
    );

    // 3. Unsafe task ID
    const orch = createDualOrchestrator({ cwd: repoRoot });
    assert.throws(
        () => orch.newTask('../escape'),
        (error) => error.code === 'DUAL_CONTRACT_INVALID',
    );
    assert.throws(
        () => orch.newTask('invalid/task'),
        (error) => error.code === 'DUAL_CONTRACT_INVALID',
    );

    // 4. Dirty tree
    fs.writeFileSync(path.join(repoRoot, 'uncommitted.txt'), 'dirty content\n', 'utf8');
    assert.throws(
        () => orch.newTask('TASK-1'),
        (error) => error.code === 'DUAL_WORKTREE_DIRTY',
    );
    fs.unlinkSync(path.join(repoRoot, 'uncommitted.txt'));

    // 5. Successful creation
    const created = orch.newTask('TASK-1');
    assert.equal(created.taskId, 'TASK-1');
    assert.equal(created.state, 'NEW');
    assert.equal(created.owner, 'codex');
    assert.equal(created.nextAction, 'preflight');
    assert.equal(created.expectedBaseCommit, head);

    const runDir = path.join(repoRoot, '.omni', 'codex-gemini', 'runs', 'TASK-1');
    assert.ok(fs.existsSync(path.join(runDir, 'events.ndjson')));
    assert.ok(fs.existsSync(path.join(runDir, 'state.json')));
    assert.ok(fs.existsSync(path.join(runDir, 'request.md')));

    // 6. Duplicate task ID rejection
    assert.throws(
        () => orch.newTask('TASK-1'),
        (error) => error.code === 'DUAL_TASK_EXISTS',
    );
});

test('preflight blocks when Agy is missing or gemini-3.7-flash-high is unavailable', async (t) => {
    const { repoRoot, scratchDir } = makeRepoFixture(t);
    const orch = createDualOrchestrator({ cwd: repoRoot });
    orch.newTask('TASK-PF');

    // 1. Missing / failing Agy
    const missingAgyScript = createFakeAgyScript(scratchDir, `
process.stderr.write('command not found\\n');
process.exit(127);
`);
    const badAgyOrch = createDualOrchestrator({
        cwd: repoRoot,
        agyCommand: process.execPath,
        agyPrefixArgs: [missingAgyScript],
    });
    await assert.rejects(
        () => badAgyOrch.runPhase('preflight', 'TASK-PF'),
        (error) => error.code === 'DUAL_PREFLIGHT_AGY_MISSING',
    );

    // 2. Model gemini-3.7-flash-high missing
    const missingModelScript = standardFakeAgyScript(scratchDir, {
        modelList: ['gemini-2.0-flash', 'claude-3-5-sonnet'],
    });
    const badModelOrch = createDualOrchestrator({
        cwd: repoRoot,
        agyCommand: process.execPath,
        agyPrefixArgs: [missingModelScript],
    });
    await assert.rejects(
        () => badModelOrch.runPhase('preflight', 'TASK-PF'),
        (error) => error.code === 'DUAL_PREFLIGHT_MODEL_UNAVAILABLE',
    );

    // 3. Valid preflight
    const validScript = standardFakeAgyScript(scratchDir);
    const validOrch = createDualOrchestrator({
        cwd: repoRoot,
        agyCommand: process.execPath,
        agyPrefixArgs: [validScript],
    });
    const pfResult = await validOrch.runPhase('preflight', 'TASK-PF');
    assert.equal(pfResult.state, 'PREFLIGHT_SAFE');
    assert.equal(pfResult.nextAction, 'scout');
    assert.equal(pfResult.reused, false);

    // 4. Preflight idempotency
    const secondPf = await validOrch.runPhase('preflight', 'TASK-PF');
    assert.equal(secondPf.state, 'PREFLIGHT_SAFE');
    assert.equal(secondPf.reused, true);
});

test('route before Scout and spec validation throws DUAL_TRANSITION_INVALID without creating route.json', async (t) => {
    const { repoRoot, scratchDir } = makeRepoFixture(t);
    const validScript = standardFakeAgyScript(scratchDir);
    const orch = createDualOrchestrator({
        cwd: repoRoot,
        agyCommand: process.execPath,
        agyPrefixArgs: [validScript],
    });
    orch.newTask('TASK-ROUTE-ERR');

    await assert.rejects(
        () => orch.runPhase('route', 'TASK-ROUTE-ERR'),
        (error) => error.code === 'DUAL_TRANSITION_INVALID',
    );

    const runDir = path.join(repoRoot, '.omni', 'codex-gemini', 'runs', 'TASK-ROUTE-ERR');
    assert.equal(fs.existsSync(path.join(runDir, 'route.json')), false);
});

test('complete Gemini path reaches CODEX_QC with all transaction artifacts', async (t) => {
    const { repoRoot, head, scratchDir } = makeRepoFixture(t);
    const validScript = standardFakeAgyScript(scratchDir);
    const orch = createDualOrchestrator({
        cwd: repoRoot,
        agyCommand: process.execPath,
        agyPrefixArgs: [validScript],
    });

    orch.newTask('TASK-FULL');

    // Run preflight & scout
    await orch.runPhase('preflight', 'TASK-FULL');
    await orch.runPhase('scout', 'TASK-FULL');

    const runDir = path.join(repoRoot, '.omni', 'codex-gemini', 'runs', 'TASK-FULL');
    assert.ok(fs.existsSync(path.join(runDir, 'context.json')));

    // Prepare valid spec.json
    const spec = {
        schema_version: 1,
        task_id: 'TASK-FULL',
        expected_base_commit: head,
        goal: 'Update heading in index.html',
        allowed_files: ['index.html'],
        deny_patterns: ['**/.env*'],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        risk_flags: [],
        permission_authority: 'dual-init-dangerous-auto-v1',
    };
    fs.writeFileSync(path.join(runDir, 'spec.json'), JSON.stringify(spec, null, 2), 'utf8');

    // Run remaining phases via run()
    const result = await orch.run('TASK-FULL');
    assert.equal(result.state, 'CODEX_QC');
    assert.equal(result.owner, 'codex');
    assert.equal(result.nextAction, 'codex_qc');

    assert.ok(fs.existsSync(path.join(runDir, 'spec.json')));
    assert.ok(fs.existsSync(path.join(runDir, 'route.json')));
    assert.ok(fs.existsSync(path.join(runDir, 'evidence.json')));
    assert.ok(fs.existsSync(path.join(runDir, 'review.json')));

    const routeJson = JSON.parse(fs.readFileSync(path.join(runDir, 'route.json'), 'utf8'));
    assert.equal(routeJson.owner, 'gemini');
    assert.equal(routeJson.model, 'gemini-3.7-flash-high');
    assert.equal(routeJson.token_budget, null);

    // Check status
    const status = orch.status('TASK-FULL');
    assert.equal(status.state, 'CODEX_QC');
    assert.equal(status.owner, 'codex');
    assert.ok(status.attempts && typeof status.attempts === 'object');
    assert.equal(status.attempts.preflight, 1);
    assert.equal(status.attempts.scout, 1);
    assert.equal(status.attempts.implement, 1);
    assert.equal(status.attempts.review, 1);
});

test('retries empty and malformed AGY output up to a third quality-first attempt', async (t) => {
    const { repoRoot, head } = makeRepoFixture(t);
    const invocations = [];
    let phaseAttempt = 0;
    const payload = {
        schema_version: 1,
        task_id: 'TASK-RETRY-3',
        expected_base_commit: head,
        summary: 'Recovered after technical output failures',
        relevant_files: [{ path: 'index.html', description: 'Entry point' }],
        exact_symbols: [{ name: 'body', file: 'index.html', verified: true }],
        validation_commands: ['node --version'],
        constraints: [],
        risks: [],
        open_questions: [],
        research_trace: [
            { question: 'Where is the entry?', source: 'index.html', source_type: 'REPOSITORY', conclusion: 'index.html owns it.' },
            { question: 'How is it validated?', source: 'node --version', source_type: 'TEST_OUTPUT', conclusion: 'The command is available.' },
        ],
        alternatives_considered: [
            { option: 'Inspect the entry directly', tradeoff: 'Small bounded scope.' },
            { option: 'Search the full tree', tradeoff: 'Broader but unnecessary.' },
        ],
        failure_modes: ['The output envelope may be malformed.'],
    };
    const processRunner = async (invocation) => {
        invocations.push(invocation);
        phaseAttempt += 1;
        const stdout = phaseAttempt === 1
            ? ''
            : phaseAttempt === 2
                ? 'not-json'
                : JSON.stringify({ status: 'success', structured_output: payload });
        return {
            exitCode: 0,
            stdout,
            stderr: '',
            timedOut: false,
            startedAt: new Date('2026-08-25T00:00:00.000Z'),
            endedAt: new Date('2026-08-25T00:00:01.000Z'),
            durationMs: 1000,
        };
    };
    const orch = createDualOrchestrator({
        cwd: repoRoot,
        processRunner,
        authoritativeCapabilityEvidence: {
            version: 'agy version 1.1.20',
            model: 'gemini-3.7-flash-high',
        },
    });

    orch.newTask('TASK-RETRY-3');
    await orch.runPhase('preflight', 'TASK-RETRY-3');
    const result = await orch.runPhase('scout', 'TASK-RETRY-3');

    assert.equal(result.state, 'SCOUT_VALID');
    assert.equal(phaseAttempt, 3);
    assert.equal(orch.status('TASK-RETRY-3').attempts.scout, 3);
    assert.doesNotMatch(invocations[0].args.at(-1), /Retry correction:/);
    assert.match(invocations[1].args.at(-1), /DUAL_AGY_EMPTY_OUTPUT/);
    assert.match(invocations[2].args.at(-1), /DUAL_AGY_OUTPUT_MALFORMED/);
});

test('risky spec and 11-file spec route to CODEX_OWNED without implement/review calls', async (t) => {
    // 1. Risky spec
    const fixture1 = makeRepoFixture(t);
    const validScript1 = standardFakeAgyScript(fixture1.scratchDir);
    const orch1 = createDualOrchestrator({
        cwd: fixture1.repoRoot,
        agyCommand: process.execPath,
        agyPrefixArgs: [validScript1],
    });

    orch1.newTask('TASK-RISKY');
    await orch1.runPhase('preflight', 'TASK-RISKY');
    await orch1.runPhase('scout', 'TASK-RISKY');
    const runDirRisky = path.join(fixture1.repoRoot, '.omni', 'codex-gemini', 'runs', 'TASK-RISKY');
    fs.writeFileSync(path.join(runDirRisky, 'spec.json'), JSON.stringify({
        schema_version: 1,
        task_id: 'TASK-RISKY',
        expected_base_commit: fixture1.head,
        goal: 'Security auth redesign',
        allowed_files: ['index.html'],
        deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        risk_flags: ['architecture', 'security'],
        permission_authority: 'dual-init-dangerous-auto-v1',
    }, null, 2), 'utf8');

    const resultRisky = await orch1.run('TASK-RISKY');
    assert.equal(resultRisky.state, 'CODEX_OWNED');
    assert.equal(resultRisky.owner, 'codex');
    assert.equal(fs.existsSync(path.join(runDirRisky, 'evidence.json')), false);
    assert.equal(fs.existsSync(path.join(runDirRisky, 'review.json')), false);

    // 2. 11-file spec on a separate clean fixture
    const fixture2 = makeRepoFixture(t);
    const validScript2 = standardFakeAgyScript(fixture2.scratchDir);
    const orch2 = createDualOrchestrator({
        cwd: fixture2.repoRoot,
        agyCommand: process.execPath,
        agyPrefixArgs: [validScript2],
    });

    orch2.newTask('TASK-11FILES');
    await orch2.runPhase('preflight', 'TASK-11FILES');
    await orch2.runPhase('scout', 'TASK-11FILES');
    const runDir4 = path.join(fixture2.repoRoot, '.omni', 'codex-gemini', 'runs', 'TASK-11FILES');
    fs.writeFileSync(path.join(runDir4, 'spec.json'), JSON.stringify({
        schema_version: 1,
        task_id: 'TASK-11FILES',
        expected_base_commit: fixture2.head,
        goal: 'Multi-module migration',
        allowed_files: Array.from({ length: 11 }, (_, index) => `file-${index}.js`),
        deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        risk_flags: [],
        permission_authority: 'dual-init-dangerous-auto-v1',
    }, null, 2), 'utf8');

    const result4 = await orch2.run('TASK-11FILES');
    assert.equal(result4.state, 'CODEX_OWNED');
    assert.equal(result4.owner, 'codex');
    assert.equal(fs.existsSync(path.join(runDir4, 'evidence.json')), false);
    assert.equal(fs.existsSync(path.join(runDir4, 'review.json')), false);
});

test('stale HEAD blocks implement phase', async (t) => {
    const { repoRoot, head, scratchDir } = makeRepoFixture(t);
    const validScript = standardFakeAgyScript(scratchDir);
    const orch = createDualOrchestrator({
        cwd: repoRoot,
        agyCommand: process.execPath,
        agyPrefixArgs: [validScript],
    });

    orch.newTask('TASK-STALE');
    await orch.runPhase('preflight', 'TASK-STALE');
    await orch.runPhase('scout', 'TASK-STALE');

    const runDir = path.join(repoRoot, '.omni', 'codex-gemini', 'runs', 'TASK-STALE');
    fs.writeFileSync(path.join(runDir, 'spec.json'), JSON.stringify({
        schema_version: 1,
        task_id: 'TASK-STALE',
        expected_base_commit: head,
        goal: 'Goal',
        allowed_files: ['index.html'],
        deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        risk_flags: [],
        permission_authority: 'dual-init-dangerous-auto-v1',
    }, null, 2), 'utf8');

    await orch.runPhase('spec', 'TASK-STALE');
    await orch.runPhase('route', 'TASK-STALE');

    // Simulate commit to advance HEAD
    fs.writeFileSync(path.join(repoRoot, 'index.html'), '<html><body>New commit</body></html>\n', 'utf8');
    spawnSync('git', ['commit', '-am', 'unrelated commit'], { cwd: repoRoot, shell: false, windowsHide: true });

    await assert.rejects(
        () => orch.runPhase('implement', 'TASK-STALE'),
        (error) => error.code === 'DUAL_BASE_COMMIT_STALE',
    );
});

test('scope violation blocks and preserves diff when worker edits outside allowed scope', async (t) => {
    const { repoRoot, head, scratchDir } = makeRepoFixture(t);
    // Worker modifies outside.txt
    const outOfScopeScript = standardFakeAgyScript(scratchDir, {
        implementMutateFile: 'outside.txt',
    });
    const orch = createDualOrchestrator({
        cwd: repoRoot,
        agyCommand: process.execPath,
        agyPrefixArgs: [outOfScopeScript],
    });

    orch.newTask('TASK-SCOPE');
    await orch.runPhase('preflight', 'TASK-SCOPE');
    await orch.runPhase('scout', 'TASK-SCOPE');

    const runDir = path.join(repoRoot, '.omni', 'codex-gemini', 'runs', 'TASK-SCOPE');
    fs.writeFileSync(path.join(runDir, 'spec.json'), JSON.stringify({
        schema_version: 1,
        task_id: 'TASK-SCOPE',
        expected_base_commit: head,
        goal: 'Goal',
        allowed_files: ['index.html'],
        deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        risk_flags: [],
        permission_authority: 'dual-init-dangerous-auto-v1',
    }, null, 2), 'utf8');

    await orch.runPhase('spec', 'TASK-SCOPE');
    await orch.runPhase('route', 'TASK-SCOPE');
    await orch.runPhase('implement', 'TASK-SCOPE');

    await assert.rejects(
        () => orch.runPhase('scope', 'TASK-SCOPE'),
        (error) => error.code === 'DUAL_SCOPE_VIOLATION',
    );

    // Diff is preserved
    assert.ok(fs.existsSync(path.join(repoRoot, 'outside.txt')));
});

test('review mutation blocks and preserves raw review evidence', async (t) => {
    const { repoRoot, head, scratchDir } = makeRepoFixture(t);
    const reviewMutateScript = standardFakeAgyScript(scratchDir, {
        reviewMutateFile: 'index.html',
    });
    const orch = createDualOrchestrator({
        cwd: repoRoot,
        agyCommand: process.execPath,
        agyPrefixArgs: [reviewMutateScript],
    });

    orch.newTask('TASK-REV-MUT');
    await orch.runPhase('preflight', 'TASK-REV-MUT');
    await orch.runPhase('scout', 'TASK-REV-MUT');

    const runDir = path.join(repoRoot, '.omni', 'codex-gemini', 'runs', 'TASK-REV-MUT');
    fs.writeFileSync(path.join(runDir, 'spec.json'), JSON.stringify({
        schema_version: 1,
        task_id: 'TASK-REV-MUT',
        expected_base_commit: head,
        goal: 'Goal',
        allowed_files: ['index.html'],
        deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        risk_flags: [],
        permission_authority: 'dual-init-dangerous-auto-v1',
    }, null, 2), 'utf8');

    await orch.runPhase('spec', 'TASK-REV-MUT');
    await orch.runPhase('route', 'TASK-REV-MUT');
    await orch.runPhase('implement', 'TASK-REV-MUT');
    await orch.runPhase('scope', 'TASK-REV-MUT');

    await assert.rejects(
        () => orch.runPhase('review', 'TASK-REV-MUT'),
        (error) => error.code === 'DUAL_REVIEW_MUTATION',
    );

    // Raw evidence preserved
    assert.ok(fs.existsSync(path.join(runDir, 'raw', 'review.1.stdout.json')));
    assert.ok(fs.existsSync(path.join(runDir, 'raw', 'review.1.meta.json')));
});

test('resume after successful Scout does not increment fake-Agy Scout call count', async (t) => {
    const { repoRoot, head, scratchDir } = makeRepoFixture(t);
    const counterFile = path.join(scratchDir, 'scout-counter.txt');
    fs.writeFileSync(counterFile, '0', 'utf8');

    const countingScript = createFakeAgyScript(scratchDir, `
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
if (args.includes('--version')) {
    process.stdout.write('agy version 1.1.19\\n');
    process.exit(0);
}
if (args[0] === 'models') {
    process.stdout.write(JSON.stringify(['gemini-3.7-flash-high']) + '\\n');
    process.exit(0);
}

const promptArg = args.find(a => a.startsWith('-p='));
if (promptArg && promptArg.includes('scout')) {
    const cFile = ${JSON.stringify(counterFile)};
    const count = parseInt(fs.readFileSync(cFile, 'utf8') || '0', 10);
    fs.writeFileSync(cFile, String(count + 1), 'utf8');

    const payload = {
        schema_version: 1,
        task_id: 'TASK-RESUME',
        expected_base_commit: ${JSON.stringify(head)},
        summary: 'Scout analysis',
        relevant_files: [{ path: 'index.html', description: 'desc' }],
        exact_symbols: [{ name: 's', file: 'index.html', verified: true }],
        validation_commands: ['node --version'],
        constraints: [],
        risks: [],
        open_questions: [],
        research_trace: [
            { question: 'Where is the entry?', source: 'index.html', source_type: 'REPOSITORY', conclusion: 'index.html is the entry.' },
            { question: 'How is it checked?', source: 'node --version', source_type: 'TEST_OUTPUT', conclusion: 'Validation is available.' },
        ],
        alternatives_considered: [
            { option: 'Recover semantic output', tradeoff: 'Preserves completed work.' },
            { option: 'Rerun scout', tradeoff: 'Costs another model call.' },
        ],
        failure_modes: ['Raw output may be incomplete.'],
    };
    process.stdout.write(JSON.stringify({ status: 'success', structured_output: payload }) + '\\n');
    process.exit(0);
}
process.exit(0);
`);

    const orch = createDualOrchestrator({
        cwd: repoRoot,
        agyCommand: process.execPath,
        agyPrefixArgs: [countingScript],
    });

    orch.newTask('TASK-RESUME');
    await orch.runPhase('preflight', 'TASK-RESUME');
    await orch.runPhase('scout', 'TASK-RESUME');

    assert.equal(fs.readFileSync(counterFile, 'utf8'), '1');

    // Second resume / scout phase call
    const resumed = await orch.runPhase('scout', 'TASK-RESUME');
    assert.equal(resumed.reused, true);
    assert.equal(fs.readFileSync(counterFile, 'utf8'), '1');

    const runResumed = await orch.resume('TASK-RESUME');
    assert.equal(fs.readFileSync(counterFile, 'utf8'), '1');
});

test('crash recovery after raw output finalizes exactly once when raw payload validates', async (t) => {
    const { repoRoot, head, scratchDir } = makeRepoFixture(t);
    const validScript = standardFakeAgyScript(scratchDir);
    const orch = createDualOrchestrator({
        cwd: repoRoot,
        agyCommand: process.execPath,
        agyPrefixArgs: [validScript],
    });

    orch.newTask('TASK-CRASH');
    await orch.runPhase('preflight', 'TASK-CRASH');

    const runDir = path.join(repoRoot, '.omni', 'codex-gemini', 'runs', 'TASK-CRASH');

    // Simulate crash after raw output of scout:
    // Append phase.started for scout
    const { createStateStore } = require('../lib/dual/state-store');
    const store = createStateStore(runDir, { taskId: 'TASK-CRASH', expectedBaseCommit: head });
    store.append({ type: 'phase.started', phase: 'scout', attempt: 1 });

    // Write raw output files as if Agy finished writing them
    const scoutPayload = {
        schema_version: 1,
        task_id: 'TASK-CRASH',
        expected_base_commit: head,
        summary: 'Recovered scout payload',
        relevant_files: [{ path: 'index.html', description: 'desc' }],
        exact_symbols: [{ name: 's', file: 'index.html', verified: true }],
        validation_commands: ['node --version'],
        constraints: [],
        risks: [],
        open_questions: [],
        research_trace: [
            { question: 'Where is the feature?', source: 'index.html', source_type: 'REPOSITORY', conclusion: 'The fixture entry point owns it.' },
            { question: 'How can it be validated?', source: 'node --version', source_type: 'TEST_OUTPUT', conclusion: 'The validation command is available.' },
        ],
        alternatives_considered: [
            { option: 'Recover the completed output', tradeoff: 'Avoids repeating an already finished phase.' },
            { option: 'Run scout again', tradeoff: 'Fresh output but wastes a completed attempt.' },
        ],
        failure_modes: ['The raw output may be incomplete after a crash.'],
    };
    fs.mkdirSync(path.join(runDir, 'raw'), { recursive: true });
    fs.writeFileSync(
        path.join(runDir, 'raw', 'scout.1.stdout.json'),
        JSON.stringify({ status: 'success', structured_output: scoutPayload }),
        'utf8',
    );
    fs.writeFileSync(path.join(runDir, 'raw', 'scout.1.stderr.txt'), '', 'utf8');

    // Resume should recover and finalize scout
    const recovered = await orch.runPhase('scout', 'TASK-CRASH');
    assert.equal(recovered.state, 'SCOUT_VALID');
    assert.ok(fs.existsSync(path.join(runDir, 'context.json')));

    const context = JSON.parse(fs.readFileSync(path.join(runDir, 'context.json'), 'utf8'));
    assert.equal(context.summary, 'Recovered scout payload');
});

test('crash recovery after review raw output writes final Codex QC handoff and validates event sequence', async (t) => {
    const { repoRoot, head, scratchDir } = makeRepoFixture(t);
    const validScript = standardFakeAgyScript(scratchDir);
    const orch = createDualOrchestrator({
        cwd: repoRoot,
        agyCommand: process.execPath,
        agyPrefixArgs: [validScript],
    });

    const taskId = 'TASK-REV-RECOVER';
    orch.newTask(taskId);
    await orch.runPhase('preflight', taskId);
    await orch.runPhase('scout', taskId);

    const runDir = path.join(repoRoot, '.omni', 'codex-gemini', 'runs', taskId);
    const spec = {
        schema_version: 1,
        task_id: taskId,
        expected_base_commit: head,
        goal: 'Recovered review goal',
        allowed_files: ['index.html'],
        deny_patterns: ['**/.env*'],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        risk_flags: [],
        permission_authority: 'dual-init-dangerous-auto-v1',
    };
    fs.writeFileSync(path.join(runDir, 'spec.json'), JSON.stringify(spec, null, 2), 'utf8');

    await orch.runPhase('spec', taskId);
    await orch.runPhase('route', taskId);
    await orch.runPhase('implement', taskId);
    await orch.runPhase('scope', taskId);

    const { createStateStore } = require('../lib/dual/state-store');
    const store = createStateStore(runDir, { taskId, expectedBaseCommit: head });
    store.append({ type: 'phase.started', phase: 'review', attempt: 1 });

    const reviewPayload = {
        schema_version: 1,
        task_id: taskId,
        expected_base_commit: head,
        recommendation: 'APPROVE',
        risk_level: 'LOW',
        findings: [],
        review_checks: ['spec correlated', 'evidence correlated', 'regression challenged'],
        challenge_summary: 'The strongest concern was crash recovery inconsistency; hashes resolve it.',
    };
    fs.mkdirSync(path.join(runDir, 'raw'), { recursive: true });
    fs.writeFileSync(
        path.join(runDir, 'raw', 'review.1.stdout.json'),
        JSON.stringify({ status: 'success', structured_output: reviewPayload }),
        'utf8',
    );
    fs.writeFileSync(path.join(runDir, 'raw', 'review.1.stderr.txt'), '', 'utf8');

    // Run review phase: should recover review, write review.json, and append handoff.completed
    const recovered = await orch.runPhase('review', taskId);
    assert.equal(recovered.state, 'CODEX_QC');
    assert.ok(fs.existsSync(path.join(runDir, 'review.json')));

    const { validateEventSequence } = require('../lib/dual/contracts');
    const events = store.readEvents();
    const lastEvent = events[events.length - 1];
    assert.equal(lastEvent.type, 'handoff.completed');
    assert.equal(lastEvent.to_state, 'CODEX_QC');
    assert.equal(lastEvent.reason, 'final_qc');

    assert.doesNotThrow(() => validateEventSequence(events, taskId, head));
});

test('snapshot orchestrator assertBaseWorkspace blocks Scout if workspace was modified after initial snapshot', async (t) => {
    const snapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-snap-orch-'));
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-snap-scratch-'));
    t.after(() => {
        fs.rmSync(snapRoot, { recursive: true, force: true });
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    fs.writeFileSync(path.join(snapRoot, 'index.html'), '<html><body>Initial</body></html>\n', 'utf8');
    const { createSnapshotBaseline } = require('../lib/dual/baseline-snapshot');
    const snapBaseline = createSnapshotBaseline({ root: snapRoot });
    const initialSnapshot = snapBaseline.capture();

    const validScript = standardFakeAgyScript(scratchDir);
    const orch = createDualOrchestrator({
        cwd: snapRoot,
        backend: 'snapshot',
        initialSnapshot,
        agyCommand: process.execPath,
        agyPrefixArgs: [validScript],
    });

    const taskId = 'TASK-SNAP-DIRTY';
    orch.newTask(taskId);
    await orch.runPhase('preflight', taskId);

    // External modification after initial snapshot but before Scout
    fs.writeFileSync(path.join(snapRoot, 'external.txt'), 'uncommitted file\n', 'utf8');

    await assert.rejects(
        () => orch.runPhase('scout', taskId),
        (err) => err.code === 'DUAL_BASE_COMMIT_STALE' || /uncommitted changes|stale/i.test(err.message)
    );
});

test('snapshot orchestrator detects and blocks unauthorized modification of .omni/sdlc/requirements.md', async (t) => {
    const snapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-snap-sdlc-'));
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-snap-scratch-'));
    t.after(() => {
        fs.rmSync(snapRoot, { recursive: true, force: true });
        fs.rmSync(scratchDir, { recursive: true, force: true });
    });

    fs.writeFileSync(path.join(snapRoot, 'index.html'), '<html><body>Hello</body></html>\n', 'utf8');
    fs.mkdirSync(path.join(snapRoot, '.omni', 'sdlc'), { recursive: true });
    fs.writeFileSync(path.join(snapRoot, '.omni', 'sdlc', 'requirements.md'), '# Requirements\n', 'utf8');

    const { createSnapshotBaseline } = require('../lib/dual/baseline-snapshot');
    const snapBaseline = createSnapshotBaseline({ root: snapRoot });
    const initialSnapshot = snapBaseline.capture();

    // Script modifies index.html (allowed) AND .omni/sdlc/requirements.md (not allowed)
    const rogueScript = standardFakeAgyScript(scratchDir, {
        implementMutateFile: '.omni/sdlc/requirements.md',
        implementPayload: {
            schema_version: 1,
            task_id: 'TASK-SDLC-SCOPE',
            expected_baseline: { kind: 'snapshot', id: initialSnapshot.identity.id },
            status: 'SUCCESS',
            modified_files: ['index.html', '.omni/sdlc/requirements.md'],
            command_outputs: [{ command: 'node --version', exit_code: 0, output: 'v20' }],
            unverified_items: [],
            self_review: {
                checks: ['Re-read both changed files.', 'Compared changes with allowed scope.', 'Checked command evidence.'],
                remaining_risks: ['The orchestrator must reject the unauthorized file.'],
            },
        },
    });

    const orch = createDualOrchestrator({
        cwd: snapRoot,
        backend: 'snapshot',
        initialSnapshot,
        agyCommand: process.execPath,
        agyPrefixArgs: [rogueScript],
    });

    const taskId = 'TASK-SDLC-SCOPE';
    orch.newTask(taskId);
    await orch.runPhase('preflight', taskId);
    await orch.runPhase('scout', taskId);

    const runDir = path.join(snapRoot, '.omni', 'codex-gemini', 'runs', taskId);
    const spec = {
        schema_version: 1,
        task_id: taskId,
        expected_baseline: { kind: 'snapshot', id: initialSnapshot.identity.id },
        goal: 'SDLC scope test',
        allowed_files: ['index.html'],
        deny_patterns: [],
        validation_commands: [{ program: 'node', args: ['--version'], cwd: '.' }],
        risk_flags: [],
        permission_authority: 'dual-init-dangerous-auto-v1',
    };
    fs.writeFileSync(path.join(runDir, 'spec.json'), JSON.stringify(spec, null, 2), 'utf8');

    await orch.runPhase('spec', taskId);
    await orch.runPhase('route', taskId);
    await orch.runPhase('implement', taskId);

    // Scope phase must detect the unauthorized edit to .omni/sdlc/requirements.md
    await assert.rejects(
        () => orch.runPhase('scope', taskId),
        /DUAL_SCOPE_FILE_NOT_ALLOWED|allowed/i
    );
});

test('Slice 3C: Task orchestrator reuses authoritative capability evidence without spawning version/models', async (t) => {
    const { repoRoot, head, scratchDir } = makeRepoFixture(t);
    let processCalls = [];
    const customProcessRunner = async (invocation) => {
        processCalls.push(invocation.args);
        return { exitCode: 0, stdout: 'ok', stderr: '' };
    };

    const orch = createDualOrchestrator({
        cwd: repoRoot,
        processRunner: customProcessRunner,
        authoritativeCapabilityEvidence: {
            version: '1.2.3',
            model: 'gemini-3.7-flash-high',
        },
    });

    const taskId = 'TASK-REUSE-EVIDENCE';
    orch.newTask(taskId);
    const result = await orch.runPhase('preflight', taskId);

    assert.equal(result.state, 'PREFLIGHT_SAFE');
    // ZERO capability subprocesses spawned!
    assert.equal(processCalls.length, 0);
});

test('Slice 3C: Task orchestrator rejects forged / incomplete authoritative capability evidence', async (t) => {
    const { repoRoot, head, scratchDir } = makeRepoFixture(t);

    // Missing version
    const orchBadVer = createDualOrchestrator({
        cwd: repoRoot,
        authoritativeCapabilityEvidence: {
            version: '',
            model: 'gemini-3.7-flash-high',
        },
    });
    orchBadVer.newTask('TASK-BAD-1');
    await assert.rejects(
        () => orchBadVer.runPhase('preflight', 'TASK-BAD-1'),
        /DUAL_PREFLIGHT_AUTHORITY_INVALID|invalid/i
    );

    // Wrong model
    const orchBadModel = createDualOrchestrator({
        cwd: repoRoot,
        authoritativeCapabilityEvidence: {
            version: '1.2.3',
            model: 'gemini-3.7-flash-high-preview',
        },
    });
    orchBadModel.newTask('TASK-BAD-2');
    await assert.rejects(
        () => orchBadModel.runPhase('preflight', 'TASK-BAD-2'),
        /DUAL_PREFLIGHT_AUTHORITY_INVALID|invalid/i
    );
});
