'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const {
    evaluateHook,
    validateHookInput,
    extractPatchPaths,
    extractMcpPaths,
    extractEventHint,
    classifyTool,
    inferTask,
    sanitizeOutput,
    serializeBoundedOutput,
    findNearestWorkspaceRoot,
} = require('../lib/dual/hook-bridge');

const {
    startDaemonServer,
} = require('../lib/dual/daemon-server');

const {
    createDaemonClient,
} = require('../lib/dual/daemon-client');

const {
    createAuthorityStore,
} = require('../lib/dual/authority-store');

const {
    computeWorkspaceId,
    getRuntimeDir,
} = require('../lib/dual/daemon-lock');

const HOOK_CLI = path.join(__dirname, '..', 'bin', 'omni-hook.js');
const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'overlays', 'codex', 'hooks.template.json');

function createTempWorkspace(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-hook-ws-'));
    const canonical = fs.realpathSync.native ? fs.realpathSync.native(dir) : fs.realpathSync(dir);
    t.after(async () => {
        try {
            const client = createDaemonClient({ workspaceRoot: canonical, timeoutMs: 200 });
            await client.stop();
        } catch {
            // ignore
        }
        try {
            fs.rmSync(canonical, { recursive: true, force: true });
        } catch {
            // ignore
        }
    });
    return canonical;
}

function setupTestSession(wsRoot, { tasks = [] } = {}) {
    const init = spawnSync('git', ['init', '-b', 'main'], { cwd: wsRoot, encoding: 'utf8' });
    if (init.status !== 0) {
        assert.equal(spawnSync('git', ['init'], { cwd: wsRoot, encoding: 'utf8' }).status, 0);
    }
    assert.equal(spawnSync('git', ['config', 'user.email', 'hook-test@example.invalid'], { cwd: wsRoot }).status, 0);
    assert.equal(spawnSync('git', ['config', 'user.name', 'Hook Test'], { cwd: wsRoot }).status, 0);
    fs.writeFileSync(path.join(wsRoot, 'a.js'), 'module.exports = true;\n', 'utf8');
    assert.equal(spawnSync('git', ['add', 'a.js'], { cwd: wsRoot }).status, 0);
    assert.equal(spawnSync('git', ['commit', '-m', 'initial'], { cwd: wsRoot }).status, 0);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: wsRoot, encoding: 'utf8' });
    assert.equal(head.status, 0);

    const wsId = computeWorkspaceId(wsRoot);
    const store = createAuthorityStore(path.join(wsRoot, '.omni', 'authority'));
    const sessionId = 'omni-sess-1';
    const baseline = { kind: 'git', id: head.stdout.trim() };

    store.append({
        schema_version: 2,
        type: 'session.created',
        state: 'DISCOVERED',
        workspace_root: wsRoot,
        mode: 'auto',
        workspace_id: wsId,
        session_id: sessionId,
        plan_revision: 1,
        expected_baseline: baseline,
    });

    if (tasks.length > 0) {
        store.append({
            schema_version: 2,
            type: 'capability.result',
            from_state: 'DISCOVERED',
            to_state: 'CAPABILITY_SAFE',
            workspace_id: wsId,
            session_id: sessionId,
            plan_revision: 1,
            expected_baseline: baseline,
            status: 'PASSED',
            checks: [{ name: 'hooks', status: 'PASSED' }],
        });

        store.append({
            schema_version: 2,
            type: 'plan.registered',
            from_state: 'INTERVIEWING',
            to_state: 'PLANNED',
            workspace_id: wsId,
            session_id: sessionId,
            plan_revision: 1,
            expected_baseline: baseline,
            plan_path: 'plans/plan.md',
            plan_sha256: 'c'.repeat(64),
            total_tasks: tasks.length,
            tasks: tasks.map((t) => ({
                task_id: t.id,
                title: t.title || t.id,
                owner: t.owner || 'codex',
                allowed_files: t.allowed_files || [],
            })),
        });

        for (const t of tasks) {
            store.append({
                schema_version: 2,
                type: 'task.routed',
                workspace_id: wsId,
                session_id: sessionId,
                plan_revision: 1,
                expected_baseline: baseline,
                task_id: t.id,
                owner: t.owner || 'codex',
                authority_state: 'ROUTED',
                allowed_files: t.allowed_files || [],
                reason: 'task routing',
            });
        }
    }

    return { store, wsId, sessionId, baseline };
}

// --------------------------------------------------------------------------
// 1. Pure Helper Unit Tests
// --------------------------------------------------------------------------

test('validateHookInput validates common and event-specific schemas', () => {
    // Missing / invalid object
    assert.throws(() => validateHookInput(null), /Input must be a non-null object/);
    assert.throws(() => validateHookInput('string'), /Input must be a non-null object/);
    assert.throws(() => validateHookInput([]), /Input must be a non-null object/);

    // Missing common fields
    assert.throws(() => validateHookInput({ cwd: 'C:\\test', hook_event_name: 'Stop' }), /session_id is required/);
    assert.throws(() => validateHookInput({ session_id: 'codex-123', hook_event_name: 'Stop' }), /cwd is required/);
    assert.throws(() => validateHookInput({ session_id: 'codex-123', cwd: 'C:\\test' }), /hook_event_name is required/);
    assert.throws(() => validateHookInput({ session_id: 'codex-123', cwd: 'C:\\test', hook_event_name: 'InvalidEvent' }), /Unsupported hook_event_name/);

    // PreToolUse requires tool_name and tool_input
    assert.throws(() => validateHookInput({ session_id: 's', cwd: 'c', hook_event_name: 'PreToolUse' }), /tool_name is required/);
    assert.throws(() => validateHookInput({ session_id: 's', cwd: 'c', hook_event_name: 'PreToolUse', tool_name: '   ' }), /tool_name is required/);
    assert.throws(() => validateHookInput({ session_id: 's', cwd: 'c', hook_event_name: 'PreToolUse', tool_name: 123 }), /tool_name is required/);
    assert.throws(() => validateHookInput({ session_id: 's', cwd: 'c', hook_event_name: 'PreToolUse', tool_name: 'Bash' }), /tool_input is required/);
    assert.throws(() => validateHookInput({ session_id: 's', cwd: 'c', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: 'bad' }), /tool_input is required/);
    assert.throws(() => validateHookInput({ session_id: 's', cwd: 'c', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: [] }), /tool_input is required/);

    // PostToolUse requires tool_name, tool_input, and tool_response
    assert.throws(() => validateHookInput({ session_id: 's', cwd: 'c', hook_event_name: 'PostToolUse' }), /tool_name is required/);
    assert.throws(() => validateHookInput({ session_id: 's', cwd: 'c', hook_event_name: 'PostToolUse', tool_name: 'Bash' }), /tool_input is required/);
    assert.throws(() => validateHookInput({ session_id: 's', cwd: 'c', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} }), /tool_response is required/);

    // Valid PreToolUse
    const validPre = validateHookInput({
        session_id: 'codex-session-1',
        cwd: 'C:\\ws',
        hook_event_name: 'PreToolUse',
        turn_id: 'turn-1',
        tool_name: 'Bash',
        tool_use_id: 'call-1',
        tool_input: { command: 'git status' },
    });
    assert.equal(validPre.hook_event_name, 'PreToolUse');
    assert.equal(validPre.tool_name, 'Bash');

    // Valid Stop
    const validStop = validateHookInput({
        session_id: 'codex-session-1',
        cwd: 'C:\\ws',
        hook_event_name: 'Stop',
        turn_id: 'turn-1',
        stop_hook_active: true,
    });
    assert.equal(validStop.stop_hook_active, true);
});

// Finding 1: Invalid PreToolUse returns official deny shape without echoing raw input
test('evaluateHook returns exact PreToolUse deny shape on schema error and never fails open', async () => {
    // 1. Missing tool_name
    const res1 = await evaluateHook({
        session_id: 'codex-1',
        cwd: 'C:\\ws',
        hook_event_name: 'PreToolUse',
        tool_input: { command: 'rm -rf /' },
    });
    assert.deepEqual(res1, {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: '[omni-blocked] invalid hook input: tool_name is required for PreToolUse',
        },
    });
    assert.equal(res1.systemMessage, undefined);

    // 2. Missing tool_input
    const res2 = await evaluateHook({
        session_id: 'codex-1',
        cwd: 'C:\\ws',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
    });
    assert.deepEqual(res2, {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: '[omni-blocked] invalid hook input: tool_input is required for PreToolUse',
        },
    });
    assert.equal(res2.systemMessage, undefined);

    // 3. Invalid non-object tool_input
    const res3 = await evaluateHook({
        session_id: 'codex-1',
        cwd: 'C:\\ws',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: 'rm -rf /',
    });
    assert.equal(res3.hookSpecificOutput?.permissionDecision, 'deny');
    assert.equal(res3.systemMessage, undefined);
    assert.equal(JSON.stringify(res3).includes('rm -rf /'), false);
});

// Finding 4: Patch parser accepts valid headers and rejects partially malformed headers
test('extractPatchPaths extracts Add/Update/Delete/Move paths accurately, deduplicates, and rejects malformed headers', () => {
    const validPatchText = `
*** Add File: lib/new-file.js
+console.log('hello');
*** Update File: src/app.js
@@ -1,3 +1,4 @@
*** Update File: lib/new-file.js
*** Move to: dest/target.js
*** Delete File: old/file.js
`;
    const paths = extractPatchPaths(validPatchText);
    assert.deepEqual(paths, ['dest/target.js', 'lib/new-file.js', 'old/file.js', 'src/app.js']);

    // Empty or non-header text returns empty array
    assert.deepEqual(extractPatchPaths(''), []);
    assert.deepEqual(extractPatchPaths('plain text without headers'), []);

    // Path traversal and absolute paths throw
    assert.throws(() => extractPatchPaths('*** Add File: ../escape.js'), /Path traversal/);
    assert.throws(() => extractPatchPaths('*** Update File: /absolute/path.js'), /Absolute repository path/);

    // Partially malformed: one valid header plus empty path on second header => denies entire classification
    assert.throws(() => extractPatchPaths('*** Update File: src/a.js\n*** Add File:\n'), /Patch header has empty path/);
    assert.throws(() => extractPatchPaths('*** Update File: src/a.js\n*** Update File:   \n'), /Patch header has empty path/);

    // Partially malformed: misspelled / unsupported file operation header => denies entire classification
    assert.throws(() => extractPatchPaths('*** Update File: src/a.js\n*** Delete Flie: src/b.js\n'), /Malformed or unsupported patch header/);
    assert.throws(() => extractPatchPaths('*** Update File: src/a.js\n*** Move: src/b.js\n'), /Malformed or unsupported patch header/);
    assert.throws(() => extractPatchPaths('*** Update File: src/a.js\n*** Create File: src/b.js\n'), /Malformed or unsupported patch header/);
});

// Finding 3: MCP path extraction known-key contract & bounds
test('extractMcpPaths strictly enforces known-key contract and depth/path bounds', () => {
    // 1. Known keys extracted
    const input1 = {
        path: 'src/index.js',
        destination: 'dist/bundle.js',
        nested: {
            file_path: 'lib/helper.js',
            targets: ['config/settings.json'],
        },
    };
    const paths = extractMcpPaths(input1);
    assert.deepEqual(paths, ['config/settings.json', 'dist/bundle.js', 'lib/helper.js', 'src/index.js']);

    // 2. Unknown key containing raw string array is NOT treated as paths
    const inputUnknownArray = {
        content: ['src/a.js', 'src/b.js'],
        lines: ['line 1', 'line 2'],
    };
    assert.deepEqual(extractMcpPaths(inputUnknownArray), []);

    // 3. Unknown key containing nested object WITH known path key is traversed
    const inputNestedKnown = {
        options: {
            target: 'src/out.js',
            raw_text: ['not a path'],
        },
    };
    assert.deepEqual(extractMcpPaths(inputNestedKnown), ['src/out.js']);

    // 4. >50 paths under known key throws bounds exceeded (fail-closed)
    const bigPathArray = Array.from({ length: 55 }, (_, i) => `src/file_${i}.js`);
    assert.throws(() => extractMcpPaths({ files: bigPathArray }), /maximum path count/);

    // 5. Deeply nested > 5 levels throws bounds exceeded (fail-closed)
    const deepObj = { level1: { level2: { level3: { level4: { level5: { level6: { path: 'deep.js' } } } } } } };
    assert.throws(() => extractMcpPaths(deepObj), /recursion depth/);

    // 6. Path traversal throws
    assert.throws(() => extractMcpPaths({ path: '../traversal.js' }), /Path traversal/);
});

// Finding 2 & 5 & 6: Tool classification, MCP precedence, setup flags, read escapes
test('classifyTool handles apply_patch, Bash allowlist, Bash denials, MCP tools, and unknown tools', () => {
    // 1. apply_patch
    const patchSingle = classifyTool('apply_patch', { command: '*** Update File: src/main.js\n+line\n' });
    assert.equal(patchSingle.classification, 'write');
    assert.deepEqual(patchSingle.paths, ['src/main.js']);

    const patchMulti = classifyTool('apply_patch', { command: '*** Add File: a.js\n*** Update File: b.js\n' });
    assert.equal(patchMulti.classification, 'execute');
    assert.deepEqual(patchMulti.paths, ['a.js', 'b.js']);

    const patchEmpty = classifyTool('apply_patch', { command: 'no files here' });
    assert.equal(patchEmpty.classification, 'denied');

    // Malformed patch in apply_patch denies entire classification
    const patchMalformed = classifyTool('apply_patch', { command: '*** Update File: src/a.js\n*** Delete Flie: src/b.js\n' });
    assert.equal(patchMalformed.classification, 'denied');
    assert.match(patchMalformed.reason, /invalid patch path/);

    // 2. Bash read allowlist
    const allowCommands = [
        'git status',
        'git diff HEAD~1',
        'git show HEAD:file.txt',
        'git log -n 5',
        'git rev-parse HEAD',
        'rg "pattern" src/',
        'grep -rn "test" .',
        'Get-Content file.txt',
        'Get-ChildItem -Path .',
        'Select-String -Pattern "foo" file.txt',
        'ls -la',
        'dir',
        'pwd',
        'node -c lib/dual/hook-bridge.js',
        'node --check bin/omni-hook.js',
        'node --test test/dual-hook-bridge.test.js',
        'node test/codex-smoke.test.js',
        'npm test',
        'pnpm test',
        'yarn test',
        'bun test',
        'npm run test:dual',
        'npm run typecheck',
        'npm run build',
        'npm audit --audit-level=high',
        'npm run dev',
        'npm run preview',
        'omni dual setup run',
        'omni dual setup run --dry-run',
        'omni dual setup run --force --json',
        'omni dual setup run --dry-run --force --json',
        'omni dual --help',
        'omni dual status',
        'omni dual status --json',
        'omni dual daemon recover --if-pristine --json',
        'omni dual bootstrap --json',
        'omni skills --help',
        'omni skills list',
        'omni skills find react',
        'npx skills find react',
        'node -e "JSON.parse(\'{}\')"',
        'node bin/omni.js dual setup run',
        'node bin/omni.js dual setup run --dry-run',
        'node bin/omni.js dual --help',
        'node bin/omni.js dual status',
        'node bin/omni.js dual daemon recover --if-pristine',
        'node bin/omni.js dual bootstrap',
    ];

    for (const cmd of allowCommands) {
        const res = classifyTool('Bash', { command: cmd });
        assert.equal(res.classification, 'read', `Expected read for: ${cmd}`);
    }

    // 3. Finding 5: Setup command flag allowlist & denials
    const denySetup = [
        'omni dual setup run --evil',
        'omni dual setup run --output /tmp',
        'omni dual setup run extra',
        'omni dual setup run --dry-run --dry-run', // duplicate
        'omni check',
        'omni doctor',
        'omni dual status --output result.json',
        'omni dual status extra',
        'omni dual daemon recover',
        'omni dual daemon recover --if-pristine --force',
        'omni dual bootstrap --force',
        'node bin/omni.js dual setup run --evil',
        'node bin/omni.js dual setup run extra_arg',
    ];
    for (const cmd of denySetup) {
        const res = classifyTool('Bash', { command: cmd });
        assert.equal(res.classification, 'denied', `Expected denied for setup command: ${cmd}`);
        assert.equal(res.reason.includes(cmd), false, 'Denial reason must not echo full command');
    }

    // 4. Finding 6: Read command execution escapes
    const escapeCommands = [
        'rg --pre cat "foo"',
        'rg --pre=./script.sh "foo"',
        'git diff --ext-diff',
        'git show --ext-diff',
        'git log --textconv',
        'git diff --output=out.txt',
        'git show --output out.txt',
    ];
    for (const cmd of escapeCommands) {
        const res = classifyTool('Bash', { command: cmd });
        assert.equal(res.classification, 'denied', `Expected denied for escape command: ${cmd}`);
        assert.equal(res.reason.includes(cmd), false, 'Denial reason must not echo full command');
    }

    // 5. Bash standard denials (mutating commands, operators, pipelines, package installs, git mutations)
    const denyCommands = [
        'git add .',
        'git commit -m "msg"',
        'git push origin main',
        'git reset --hard',
        'git checkout branch',
        'git stash',
        'git clean -fd',
        'rm -rf node_modules',
        'del /f file.txt',
        'Remove-Item file.txt',
        'mv a.js b.js',
        'cp a.js b.js',
        'npm install lodash',
        'pnpm add zod',
        'yarn add commander',
        'git status && rm -rf dist',
        'git status | grep foo',
        'node -e "console.log(1)" > out.txt',
        'cat < input.txt',
        'echo `whoami`',
        'echo $(id)',
        'docker run ubuntu',
    ];

    for (const cmd of denyCommands) {
        const res = classifyTool('Bash', { command: cmd });
        assert.equal(res.classification, 'denied', `Expected denied for: ${cmd}`);
    }

    // 6. Finding 2: MCP mixed-name verbs precedence
    // Mutating verb wins over read verb in mixed names
    const mcpMixed1 = classifyTool('mcp__server__get_metadata_and_delete', { path: 'src/a.js' });
    assert.equal(mcpMixed1.classification, 'write');
    assert.deepEqual(mcpMixed1.paths, ['src/a.js']);

    const mcpMixed2 = classifyTool('mcp__server__get_and_delete', { path: 'src/a.js' });
    assert.equal(mcpMixed2.classification, 'write');

    const mcpMixed3 = classifyTool('mcp__server__read_then_write', { path: 'src/a.js' });
    assert.equal(mcpMixed3.classification, 'write');

    const mcpMixed4 = classifyTool('mcp__server__delete_and_read', { path: 'src/a.js' });
    assert.equal(mcpMixed4.classification, 'write');

    // Normal read MCP
    const mcpNormalRead = classifyTool('mcp__fs__read_file', { path: 'README.md' });
    assert.equal(mcpNormalRead.classification, 'read');

    const mcpNodeRepl = classifyTool('mcp__node_repl__js', { code: '1+1' });
    assert.equal(mcpNodeRepl.classification, 'read');

    const mcpBrowserNav = classifyTool('mcp__browser__navigate', { url: 'http://localhost:5173' });
    assert.equal(mcpBrowserNav.classification, 'read');

    const mcpBrowserSnap = classifyTool('mcp__browser__screenshot', {});
    assert.equal(mcpBrowserSnap.classification, 'read');

    // Mutating without paths is denied
    const mcpMutNoPaths = classifyTool('mcp__server__get_metadata_and_delete', { content: ['not_path'] });
    assert.equal(mcpMutNoPaths.classification, 'denied');

    // Unknown MCP is denied
    const mcpUnknown = classifyTool('mcp__custom__dance_party', { song: 'disco' });
    assert.equal(mcpUnknown.classification, 'denied');

    // 7. Unknown tool
    const unknownTool = classifyTool('UnknownTool', {});
    assert.equal(unknownTool.classification, 'denied');
});

test('inferTask prefers active leases and falls back only to a unique routed Codex-owned task', () => {
    const tasks = {
        'TASK-1': { id: 'TASK-1', title: 'Task 1', owner: 'codex', allowed_files: ['src/a.js', 'src/b.js'] },
        'TASK-2': { id: 'TASK-2', title: 'Task 2', owner: 'agy', allowed_files: ['lib/c.js'] },
        'TASK-3': { id: 'TASK-3', title: 'Task 3', owner: 'codex', allowed_files: ['lib/d.js'] },
    };

    const leases = {
        'LEASE-1': { lease_id: 'LEASE-1', task_id: 'TASK-1', owner: 'codex', status: 'active' },
        'LEASE-2': { lease_id: 'LEASE-2', task_id: 'TASK-2', owner: 'agy', status: 'active' },
        'LEASE-3': { lease_id: 'LEASE-3', task_id: 'TASK-3', owner: 'codex', status: 'expired' },
    };

    // 1. Single match active lease
    const match1 = inferTask(tasks, leases, ['src/a.js']);
    assert.equal(match1.task?.id, 'TASK-1');
    assert.equal(match1.error, null);

    // 2. Active lease for AGY task
    const match2 = inferTask(tasks, leases, ['lib/c.js']);
    assert.equal(match2.task?.id, 'TASK-2');
    assert.equal(match2.task?.owner, 'agy');

    // 3. No match (expired lease)
    const match3 = inferTask(tasks, leases, ['lib/d.js']);
    assert.equal(match3.task, null);
    assert.match(match3.error, /no authorized task found/);

    const codexWithoutLease = inferTask({
        'T-CODEX': { id: 'T-CODEX', owner: 'codex', state: 'ROUTED', allowed_files: ['src/live.js'] },
    }, {}, ['src/live.js']);
    assert.equal(codexWithoutLease.task.id, 'T-CODEX');

    const agyWithoutLease = inferTask({
        'T-AGY': { id: 'T-AGY', owner: 'agy', state: 'ROUTED', allowed_files: ['src/worker.js'] },
    }, {}, ['src/worker.js']);
    assert.equal(agyWithoutLease.task, null);
    assert.match(agyWithoutLease.error, /no authorized task found/);

    // 4. Ambiguous match (if two tasks have active leases covering same file)
    const tasksAmbiguous = {
        'T-1': { id: 'T-1', allowed_files: ['foo.js'] },
        'T-2': { id: 'T-2', allowed_files: ['foo.js'] },
    };
    const leasesAmbiguous = {
        'L-1': { task_id: 'T-1', status: 'active' },
        'L-2': { task_id: 'T-2', status: 'active' },
    };
    const matchAmbiguous = inferTask(tasksAmbiguous, leasesAmbiguous, ['foo.js']);
    assert.equal(matchAmbiguous.task, null);
    assert.match(matchAmbiguous.error, /ambiguous task match/);
});

test('findNearestWorkspaceRoot walks ancestors to find directory containing runtime daemon discovery', (t) => {
    const wsRoot = createTempWorkspace(t);
    const subDir = path.join(wsRoot, 'sub', 'deep', 'folder');
    fs.mkdirSync(subDir, { recursive: true });

    // When runtime doesn't exist
    assert.equal(findNearestWorkspaceRoot(subDir), null);

    // When runtime exists at wsRoot
    const runtimeDir = getRuntimeDir(wsRoot);
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'daemon.json'), '{}');

    assert.equal(findNearestWorkspaceRoot(subDir), wsRoot);
    assert.equal(findNearestWorkspaceRoot(wsRoot), wsRoot);
});

test('planning patch classification canonicalizes contained absolute paths and rejects outside paths', (t) => {
    const wsRoot = createTempWorkspace(t);
    const designPath = path.join(wsRoot, '.omni', 'sdlc', 'design-spec.md');
    const outsidePath = path.join(path.dirname(wsRoot), 'outside-design-spec.md');

    const contained = classifyTool('apply_patch', {
        command: `*** Update File: ${designPath}\n+approved\n`,
    }, { workspaceRoot: wsRoot });
    assert.equal(contained.classification, 'write');
    assert.equal(contained.phaseOperation, 'planning');
    assert.deepEqual(contained.paths, ['.omni/sdlc/design-spec.md']);

    const outside = classifyTool('apply_patch', {
        command: `*** Update File: ${outsidePath}\n+denied\n`,
    }, { workspaceRoot: wsRoot });
    assert.equal(outside.classification, 'denied');
    assert.match(outside.reason, /invalid patch path/);

    const posixContained = classifyTool('apply_patch', {
        command: '*** Update File: /workspace/project/.omni/sdlc/todo.md\n+plan\n',
    }, { workspaceRoot: '/workspace/project' });
    assert.equal(posixContained.phaseOperation, 'planning');
    assert.deepEqual(posixContained.paths, ['.omni/sdlc/todo.md']);

    const posixOutside = classifyTool('apply_patch', {
        command: '*** Update File: /workspace/other/.omni/sdlc/todo.md\n+plan\n',
    }, { workspaceRoot: '/workspace/project' });
    assert.equal(posixOutside.classification, 'denied');

    const typedPlan = classifyTool('apply_patch', {
        command: '*** Add File: .omni/sdlc/dual-plan.json\n+{}\n',
    });
    assert.equal(typedPlan.phaseOperation, 'planning');

    const implementationPlan = classifyTool('apply_patch', {
        command: '*** Add File: docs/superpowers/plans/2026-08-26-feature.md\n+# Plan\n',
    });
    assert.equal(implementationPlan.phaseOperation, 'planning');
});

test('design spec write stays allowed from PreToolUse through PostToolUse when absolute path is contained', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const designPath = path.join(wsRoot, '.omni', 'sdlc', 'design-spec.md');
    fs.mkdirSync(path.dirname(designPath), { recursive: true });
    const toolInput = {
        command: `*** Add File: ${designPath}\n+# Design\n`,
    };
    const deps = {
        spawn: () => { throw new Error('daemon bootstrap disabled'); },
    };

    const before = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: toolInput,
        tool_use_id: 'tool-design-1',
    }, deps);
    assert.deepEqual(before, {});

    fs.writeFileSync(designPath, '# Design\n', 'utf8');
    const after = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'PostToolUse',
        tool_name: 'apply_patch',
        tool_input: toolInput,
        tool_response: { ok: true },
        tool_use_id: 'tool-design-1',
    }, deps);
    assert.deepEqual(after, {});
});

// --------------------------------------------------------------------------
// 2. Full evaluateHook Integration Tests
// --------------------------------------------------------------------------

// Finding 9: SessionStart reports state, owner, and next action; UserPromptSubmit handles session presence
test('evaluateHook handles SessionStart with status details and UserPromptSubmit correctly', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { store } = setupTestSession(wsRoot, {
        tasks: [
            { id: 'TASK-1', title: 'Codex Task', owner: 'codex', allowed_files: ['src/main.js'] },
        ],
    });
    store.acquireLease('TASK-1', 'codex');

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore: store,
    });
    t.after(() => daemon.close());

    // 1. SessionStart with healthy daemon and active session
    const outHealthy = await evaluateHook({
        session_id: 'codex-sess-99',
        cwd: wsRoot,
        hook_event_name: 'SessionStart',
        source: 'startup',
    });
    assert.ok(outHealthy.hookSpecificOutput);
    assert.equal(outHealthy.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(outHealthy.hookSpecificOutput.additionalContext, /omni-sess-1/);
    assert.match(outHealthy.hookSpecificOutput.additionalContext, /EXECUTING/);
    assert.match(outHealthy.hookSpecificOutput.additionalContext, /owner=codex/);
    assert.match(outHealthy.hookSpecificOutput.additionalContext, /next_action=/);

    // 2. SessionStart without daemon (when bootstrap fails or is unavailable)
    const otherWs = createTempWorkspace(t);
    const outMissing = await evaluateHook({
        session_id: 'codex-sess-99',
        cwd: otherWs,
        hook_event_name: 'SessionStart',
    }, {
        spawn: () => { throw new Error('spawn disabled'); },
    });
    assert.ok(outMissing.systemMessage);
    assert.match(outMissing.systemMessage, /Dual daemon is not running/);

    // 3. UserPromptSubmit with active session
    const outPromptActive = await evaluateHook({
        session_id: 'codex-sess-99',
        cwd: wsRoot,
        hook_event_name: 'UserPromptSubmit',
        turn_id: 'turn-1',
        prompt: 'SECRET PROMPT CONTENT THAT MUST NOT LEAK',
    });
    assert.ok(outPromptActive.hookSpecificOutput);
    assert.equal(outPromptActive.hookEventName || outPromptActive.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
    assert.match(outPromptActive.hookSpecificOutput.additionalContext, /Dual authority active/);
    assert.equal(JSON.stringify(outPromptActive).includes('SECRET PROMPT'), false);

    // 4. UserPromptSubmit without daemon
    const outPromptNoDaemon = await evaluateHook({
        session_id: 'codex-sess-99',
        cwd: otherWs,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'test prompt',
    }, {
        spawn: () => { throw new Error('spawn disabled'); },
    });
    assert.deepEqual(outPromptNoDaemon, {});
});

test('evaluateHook UserPromptSubmit does not claim authority is active when daemon has no active Omni session', async (t) => {
    const wsRoot = createTempWorkspace(t);
    // Uninitialized authority store (no session created)
    const store = createAuthorityStore(path.join(wsRoot, '.omni', 'authority'));
    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore: store,
    });
    t.after(() => daemon.close());

    const out = await evaluateHook({
        session_id: 'codex-sess-99',
        cwd: wsRoot,
        hook_event_name: 'UserPromptSubmit',
        turn_id: 'turn-1',
        prompt: 'hello',
    });

    assert.ok(out.hookSpecificOutput);
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(out.hookSpecificOutput.additionalContext, /No active Dual session/);
    assert.equal(out.hookSpecificOutput.additionalContext.includes('Dual authority active'), false);
});

test('UserPromptSubmit self-heals when SessionStart bootstrap was unavailable', async (t) => {
    const wsRoot = createTempWorkspace(t);
    let spawnCalls = 0;
    let waitCalls = 0;

    const out = await evaluateHook({
        session_id: 'codex-recovery',
        cwd: wsRoot,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'continue bootstrap',
    }, {
        spawn: () => {
            spawnCalls++;
            return { unref() {} };
        },
        createClient: () => ({
            health: async () => null,
            waitForHealthy: async () => {
                waitCalls++;
                return { status: 'healthy', session_id: null };
            },
        }),
    });

    assert.equal(spawnCalls, 1);
    assert.equal(waitCalls, 1);
    assert.match(out.hookSpecificOutput?.additionalContext || '', /No active Dual session/);
});

test('pre-authority hooks stay advisory before omni_dual_begin', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const unavailableClient = () => ({
        health: async () => { throw new Error('daemon unavailable'); },
    });

    const compoundRead = await evaluateHook({
        session_id: 'codex-pre-authority',
        cwd: wsRoot,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: {
            command: "$paths=@('AGENTS.md','.omni/workflows/requirement-analysis.md'); foreach($p in $paths){ Get-Content -LiteralPath $p -Raw }",
        },
    }, { createClient: unavailableClient });
    assert.deepEqual(compoundRead, {});

    const prePatch = await evaluateHook({
        session_id: 'codex-pre-authority',
        cwd: wsRoot,
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: {
            command: '*** Add File: .omni/sdlc/design-spec.md\n+# Design\n',
        },
    }, {
        createClient: () => ({
            health: async () => ({ status: 'healthy', session_id: null }),
        }),
    });
    assert.deepEqual(prePatch, {});

    const postPatch = await evaluateHook({
        session_id: 'codex-pre-authority',
        cwd: wsRoot,
        hook_event_name: 'PostToolUse',
        tool_name: 'apply_patch',
        tool_input: {
            command: '*** Add File: .omni/sdlc/design-spec.md\n+# Design\n',
        },
        tool_response: 'Done',
    }, {
        createClient: () => ({
            health: async () => ({ status: 'healthy', session_id: null }),
        }),
    });
    assert.deepEqual(postPatch, {});

    const stop = await evaluateHook({
        session_id: 'codex-pre-authority',
        cwd: wsRoot,
        hook_event_name: 'Stop',
    }, { createClient: unavailableClient });
    assert.deepEqual(stop, {});
});

test('design-ready phase blocks source mutation but permits planning, setup, and Dual control operations', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const sdlcDir = path.join(wsRoot, '.omni', 'sdlc');
    fs.mkdirSync(sdlcDir, { recursive: true });
    fs.writeFileSync(path.join(sdlcDir, 'design-spec.md'), '# Approved design\n', 'utf8');
    const healthyNoSession = () => ({
        health: async () => ({ status: 'healthy', session_id: null }),
    });

    const sourcePatch = await evaluateHook({
        session_id: 'codex-pre-authority', cwd: wsRoot, hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: { command: '*** Add File: src/main.js\n+code\n' },
    }, { createClient: healthyNoSession });
    assert.equal(sourcePatch.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(sourcePatch.hookSpecificOutput?.permissionDecisionReason || '', /Dual session required after design is ready/i);

    for (const command of [
        '*** Add File: .omni/sdlc/setup.json\n+{}\n',
        '*** Add File: .omni/sdlc/todo.md\n+# Todo\n',
    ]) {
        const planningPatch = await evaluateHook({
            session_id: 'codex-pre-authority', cwd: wsRoot, hook_event_name: 'PreToolUse',
            tool_name: 'apply_patch', tool_input: { command },
        }, { createClient: healthyNoSession });
        assert.deepEqual(planningPatch, {});
    }

    const setupRun = await evaluateHook({
        session_id: 'codex-pre-authority', cwd: wsRoot, hook_event_name: 'PreToolUse',
        tool_name: 'Bash', tool_input: { command: 'omni dual setup run --json' },
    }, { createClient: healthyNoSession });
    assert.deepEqual(setupRun, {});

    for (const command of [
        'omni skills -y',
        'omni skills add obra/superpowers',
        'omni skills add https://example.com/skills/review.md',
        'omni skills add gh:owner/repo/skills/review.md',
        'node bin/omni.js skills -y',
    ]) {
        const skillInstall = await evaluateHook({
            session_id: 'codex-pre-authority', cwd: wsRoot, hook_event_name: 'PreToolUse',
            tool_name: 'Bash', tool_input: { command },
        }, { createClient: healthyNoSession });
        assert.deepEqual(skillInstall, {}, `Expected pre-authority skill command to be allowed: ${command}`);
    }

    for (const command of [
        'omni skills add',
        'omni skills add source extra',
        'omni skills --evil',
        'omni skills add ../outside.md',
        'omni skills add ./local.md',
        'omni skills add C:\\Users\\TAV\\secret.md',
        'omni skills add /tmp/secret.md',
        'omni skills add gh:owner/repo/../secret.md',
        'omni skills add http://example.com/skill.md',
    ]) {
        const unsafeSkillInstall = await evaluateHook({
            session_id: 'codex-pre-authority', cwd: wsRoot, hook_event_name: 'PreToolUse',
            tool_name: 'Bash', tool_input: { command },
        }, { createClient: healthyNoSession });
        assert.equal(unsafeSkillInstall.hookSpecificOutput?.permissionDecision, 'deny');
    }

    for (const tool_name of [
        'mcp__omni_dual__omni_dual_begin',
        'mcp__omni_dual__omni_dual_register_plan',
    ]) {
        const control = await evaluateHook({
            session_id: 'codex-pre-authority', cwd: wsRoot, hook_event_name: 'PreToolUse',
            tool_name, tool_input: {},
        }, { createClient: healthyNoSession });
        assert.deepEqual(control, {});
    }
});

test('design-ready phase remains fail-closed for source mutation when daemon is unavailable', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const sdlcDir = path.join(wsRoot, '.omni', 'sdlc');
    fs.mkdirSync(sdlcDir, { recursive: true });
    fs.writeFileSync(path.join(sdlcDir, 'design-spec.md'), '# Approved design\n', 'utf8');

    const out = await evaluateHook({
        session_id: 'codex-pre-authority', cwd: wsRoot, hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch', tool_input: { command: '*** Add File: src/main.js\n+code\n' },
    }, { createClient: () => ({ health: async () => { throw new Error('offline'); } }) });

    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput?.permissionDecisionReason || '', /Dual session required after design is ready/i);
});

test('design-ready Stop enforces AUTO continuation once before yielding for inspection', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const sdlcDir = path.join(wsRoot, '.omni', 'sdlc');
    fs.mkdirSync(sdlcDir, { recursive: true });
    fs.writeFileSync(path.join(sdlcDir, 'design-spec.md'), '# Approved design\n', 'utf8');
    const client = () => ({ health: async () => ({ status: 'healthy', session_id: null }) });

    const first = await evaluateHook({
        session_id: 'codex-pre-authority', cwd: wsRoot, hook_event_name: 'Stop',
    }, { createClient: client });
    assert.equal(first.decision, 'block');
    assert.match(first.reason || '', /continue.*setup.*Dual/i);

    const guarded = await evaluateHook({
        session_id: 'codex-pre-authority', cwd: wsRoot, hook_event_name: 'Stop', stop_hook_active: true,
    }, { createClient: client });
    assert.match(guarded.systemMessage || '', /stopping loop for user inspection/i);
});

test('initialized authority still fails closed when daemon is unavailable from a nested cwd', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const nested = path.join(wsRoot, 'src', 'nested');
    const authorityDir = path.join(wsRoot, '.omni', 'runs', 'dual-authority');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(authorityDir, { recursive: true });
    fs.writeFileSync(path.join(wsRoot, '.omni', 'manifest.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(authorityDir, 'events.ndjson'), '{}\n', 'utf8');

    let resolvedRoot = null;
    const out = await evaluateHook({
        session_id: 'codex-active-authority',
        cwd: nested,
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: {
            command: '*** Update File: src/main.js\n+changed\n',
        },
    }, {
        createClient: ({ workspaceRoot }) => {
            resolvedRoot = workspaceRoot;
            return {
                health: async () => { throw new Error('daemon unavailable'); },
            };
        },
    });

    assert.equal(resolvedRoot, wsRoot);
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput?.permissionDecisionReason || '', /daemon is not running or unreachable/i);
});

test('evaluateHook PreToolUse authorizes routed Codex work without a lease while AGY remains lease-bound', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { store } = setupTestSession(wsRoot, {
        tasks: [
            { id: 'TASK-1', title: 'Codex Task', owner: 'codex', allowed_files: ['src/codex.js', 'src/helper.js'] },
            { id: 'TASK-2', title: 'Agy Task', owner: 'agy', allowed_files: ['src/agy.js'] },
        ],
    });

    store.acquireLease('TASK-2', 'agy');

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore: store,
    });
    t.after(() => daemon.close());

    // 1. Allowed single-file Codex-owned write
    const allowRes = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'PreToolUse',
        turn_id: 'turn-1',
        tool_name: 'apply_patch',
        tool_use_id: 'call-1',
        tool_input: {
            command: '*** Update File: src/codex.js\n+code\n',
        },
    });
    assert.deepEqual(allowRes, {});

    // 2. Allowed multi-file Codex-owned write within scope
    const allowMulti = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'PreToolUse',
        turn_id: 'turn-1',
        tool_name: 'apply_patch',
        tool_use_id: 'call-1b',
        tool_input: {
            command: '*** Update File: src/codex.js\n+code1\n*** Add File: src/helper.js\n+code2\n',
        },
    });
    assert.deepEqual(allowMulti, {});

    // 3. Denied AGY-owned write (daemon owner mismatch)
    const denyAgy = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'PreToolUse',
        turn_id: 'turn-1',
        tool_name: 'apply_patch',
        tool_use_id: 'call-2',
        tool_input: {
            command: '*** Update File: src/agy.js\n+code\n',
        },
    });
    assert.equal(denyAgy.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(denyAgy.hookSpecificOutput?.permissionDecisionReason, /AGY_OWNED/);

    // 4. Denied out-of-scope write
    const denyScope = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'PreToolUse',
        turn_id: 'turn-1',
        tool_name: 'apply_patch',
        tool_use_id: 'call-3',
        tool_input: {
            command: '*** Update File: src/unauthorized.js\n+code\n',
        },
    });
    assert.equal(denyScope.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(denyScope.hookSpecificOutput?.permissionDecisionReason, /no authorized task found/);

    // 5. Denied Bash mutation
    const denyBash = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'PreToolUse',
        turn_id: 'turn-1',
        tool_name: 'Bash',
        tool_use_id: 'call-4',
        tool_input: {
            command: 'git commit -m "hack"',
        },
    });
    assert.equal(denyBash.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(denyBash.hookSpecificOutput?.permissionDecisionReason, /allowlist/);

    // 6. Allowed Bash read inspection
    const allowBash = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'PreToolUse',
        turn_id: 'turn-1',
        tool_name: 'Bash',
        tool_use_id: 'call-5',
        tool_input: {
            command: 'git status',
        },
    });
    assert.deepEqual(allowBash, {});

    // 7. Allowed MCP mutating tool in scope
    const allowMcpWrite = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'PreToolUse',
        turn_id: 'turn-1',
        tool_name: 'mcp__fs__write_file',
        tool_use_id: 'call-6',
        tool_input: {
            path: 'src/codex.js',
            content: 'console.log(1);',
        },
    });
    assert.deepEqual(allowMcpWrite, {});

    // 8. Denied MCP mutating tool outside scope
    const denyMcpWrite = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'PreToolUse',
        turn_id: 'turn-1',
        tool_name: 'mcp__fs__write_file',
        tool_use_id: 'call-7',
        tool_input: {
            path: 'unauthorized/file.js',
            content: 'console.log(1);',
        },
    });
    assert.equal(denyMcpWrite.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(denyMcpWrite.hookSpecificOutput?.permissionDecisionReason, /no authorized task found/);
});

test('evaluateHook denies an unleased AGY-owned task even when its paths match', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { store } = setupTestSession(wsRoot, {
        tasks: [
            { id: 'TASK-AGY', title: 'Agy Task', owner: 'agy', allowed_files: ['src/agy.js'] },
        ],
    });
    const daemon = await startDaemonServer({ workspaceRoot: wsRoot, authorityStore: store });
    t.after(() => daemon.close());

    const result = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_use_id: 'call-unleased-agy',
        tool_input: { command: '*** Update File: src/agy.js\n+code\n' },
    });
    assert.equal(result.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput?.permissionDecisionReason, /no authorized task found/);
});

// Finding 7: PostToolUse handles malformed apply_patch, unknown MCP, daemon loss, never echoes tool_response
test('evaluateHook PostToolUse observes changes without leaking tool_response, claiming undo, or ignoring unverified actions', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { store } = setupTestSession(wsRoot, {
        tasks: [
            { id: 'TASK-1', title: 'Codex Task', owner: 'codex', allowed_files: ['src/codex.js'] },
        ],
    });
    store.acquireLease('TASK-1', 'codex');

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore: store,
    });
    t.after(() => daemon.close());

    // 1. PostToolUse on valid safe read tool -> empty {}
    const validReadPost = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'PostToolUse',
        turn_id: 'turn-1',
        tool_name: 'Bash',
        tool_use_id: 'call-r',
        tool_input: { command: 'git status' },
        tool_response: 'STATUS OUTPUT',
    });
    assert.deepEqual(validReadPost, {});

    // 2. PostToolUse on valid Codex write -> empty {}
    const validPost = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'PostToolUse',
        turn_id: 'turn-1',
        tool_name: 'apply_patch',
        tool_use_id: 'call-1',
        tool_input: { command: '*** Update File: src/codex.js\n' },
        tool_response: 'SUPER SENSITIVE RESULT',
    });
    assert.deepEqual(validPost, {});
    assert.equal(JSON.stringify(validPost).includes('SUPER SENSITIVE'), false);

    // 3. PostToolUse on unleased/out-of-scope write -> block feedback (cannot undo)
    const invalidPost = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'PostToolUse',
        turn_id: 'turn-1',
        tool_name: 'apply_patch',
        tool_use_id: 'call-2',
        tool_input: { command: '*** Update File: outside/scope.js\n' },
        tool_response: 'output',
    });
    assert.equal(invalidPost.decision, 'block');
    assert.match(invalidPost.reason, /action already executed/);
    assert.equal(invalidPost.hookSpecificOutput?.hookEventName, 'PostToolUse');
    assert.match(invalidPost.hookSpecificOutput?.additionalContext, /violation detected post-tool/);

    // 4. PostToolUse on malformed apply_patch -> block feedback (action already executed)
    const malformedPatchPost = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'PostToolUse',
        turn_id: 'turn-1',
        tool_name: 'apply_patch',
        tool_use_id: 'call-3',
        tool_input: { command: '*** Update File: src/codex.js\n*** Delete Flie: bad\n' },
        tool_response: 'patch result',
    });
    assert.equal(malformedPatchPost.decision, 'block');
    assert.match(malformedPatchPost.reason, /action already executed/);

    // 5. PostToolUse on unknown MCP tool -> block feedback (action already executed)
    const unknownMcpPost = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'PostToolUse',
        turn_id: 'turn-1',
        tool_name: 'mcp__evil__wipe_drive',
        tool_use_id: 'call-4',
        tool_input: { path: 'src/codex.js' },
        tool_response: 'wiped',
    });
    assert.equal(unknownMcpPost.decision, 'block');
    assert.match(unknownMcpPost.reason, /action already executed/);

    // 6. PostToolUse on daemon loss after mutation -> block feedback (action already executed)
    const wsNoDaemon = createTempWorkspace(t);
    const lostAuthorityDir = path.join(wsNoDaemon, '.omni', 'runs', 'dual-authority');
    fs.mkdirSync(lostAuthorityDir, { recursive: true });
    fs.writeFileSync(path.join(lostAuthorityDir, 'events.ndjson'), '{}\n', 'utf8');
    const noDaemonPost = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsNoDaemon,
        hook_event_name: 'PostToolUse',
        turn_id: 'turn-1',
        tool_name: 'apply_patch',
        tool_use_id: 'call-5',
        tool_input: { command: '*** Update File: src/codex.js\n' },
        tool_response: 'result',
    });
    assert.equal(noDaemonPost.decision, 'block');
    assert.match(noDaemonPost.reason, /action already executed/);
});

test('evaluateHook Stop handles verified completion, continuation, terminal BLOCKED, and loop guard', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { store, wsId, sessionId, baseline } = setupTestSession(wsRoot, {
        tasks: [
            { id: 'TASK-1', title: 'Task 1', owner: 'codex', allowed_files: ['a.js'] },
        ],
    });

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore: store,
    });
    t.after(() => daemon.close());

    // 1. Incomplete session, stop_hook_active: false -> block continuation
    const contRes = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'Stop',
        turn_id: 'turn-1',
        stop_hook_active: false,
    });
    assert.equal(contRes.decision, 'block');
    assert.match(contRes.reason, /Dual AUTO session incomplete/);

    // 2. Incomplete session, stop_hook_active: true -> loop guard systemMessage, no block
    const loopGuardRes = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'Stop',
        turn_id: 'turn-1',
        stop_hook_active: true,
    });
    assert.equal(loopGuardRes.decision, undefined);
    assert.ok(loopGuardRes.systemMessage);
    assert.match(loopGuardRes.systemMessage, /Stopping loop for user inspection/);

    // 3. Terminal BLOCKED session -> systemMessage, no block
    store.append({
        schema_version: 2,
        type: 'session.blocked',
        session_id: sessionId,
        workspace_id: wsId,
        plan_revision: 1,
        expected_baseline: baseline,
        from_state: 'EXECUTING',
        to_state: 'BLOCKED',
        blocker_code: 'FATAL_ERR',
        reason: 'Fatal error occurred',
    });
    const blockedRes = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'Stop',
        turn_id: 'turn-2',
        stop_hook_active: false,
    });
    assert.equal(blockedRes.decision, undefined);
    assert.ok(blockedRes.systemMessage);
    assert.match(blockedRes.systemMessage, /session is BLOCKED/);

    // 4. Before authority initialization, daemon loss at Stop stays advisory
    const wsNoDaemon = createTempWorkspace(t);
    const noDaemonStop = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsNoDaemon,
        hook_event_name: 'Stop',
        turn_id: 'turn-3',
    });
    assert.deepEqual(noDaemonStop, {});
});

test('evaluateHook Stop returns empty object when session is verified', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const { store, wsId, sessionId, baseline } = setupTestSession(wsRoot, {
        tasks: [
            { id: 'TASK-1', title: 'Task 1', owner: 'codex', allowed_files: ['a.js'] },
        ],
    });

    const lease = store.acquireLease('TASK-1', 'codex');
    store.append({
        schema_version: 2,
        type: 'task.completed',
        workspace_id: wsId,
        session_id: sessionId,
        plan_revision: 1,
        expected_baseline: baseline,
        task_id: 'TASK-1',
        owner: 'codex',
        authority_state: 'TASK_VERIFIED',
        modified_files: ['a.js'],
        diff_fingerprint: 'e'.repeat(64),
        verdict: 'SUCCESS',
        verified_by: 'codex',
    });
    store.releaseLease(lease.lease_id, 'completed');

    store.append({
        schema_version: 2,
        type: 'session.verified',
        workspace_id: wsId,
        session_id: sessionId,
        plan_revision: 1,
        expected_baseline: baseline,
        from_state: 'ACCEPTANCE',
        to_state: 'VERIFIED',
        completed_tasks: ['TASK-1'],
        receipt_sha256: 'f'.repeat(64),
    });

    const daemon = await startDaemonServer({
        workspaceRoot: wsRoot,
        authorityStore: store,
    });
    t.after(() => daemon.close());

    const verifiedRes = await evaluateHook({
        session_id: 'codex-session',
        cwd: wsRoot,
        hook_event_name: 'Stop',
        turn_id: 'turn-1',
    });
    assert.deepEqual(verifiedRes, {});
});

// Finding 10: Regression coverage for daemon client timeout, corrupt discovery, ambiguous lease, unknown event
test('evaluateHook fails closed on client timeout and corrupt discovery', async (t) => {
    const wsRoot = createTempWorkspace(t);
    const runtimeDir = getRuntimeDir(wsRoot);
    fs.mkdirSync(runtimeDir, { recursive: true });

    // Corrupt discovery file
    fs.writeFileSync(path.join(runtimeDir, 'daemon.json'), '{ invalid json');
    const authorityDir = path.join(wsRoot, '.omni', 'runs', 'dual-authority');
    fs.mkdirSync(authorityDir, { recursive: true });
    fs.writeFileSync(path.join(authorityDir, 'events.ndjson'), '{}\n', 'utf8');

    const corruptRes = await evaluateHook({
        session_id: 'codex-1',
        cwd: wsRoot,
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: { command: '*** Update File: a.js\n' },
    });
    assert.equal(corruptRes.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(corruptRes.hookSpecificOutput?.permissionDecisionReason, /unreachable/);

    // Unknown event name
    const unknownEvtRes = await evaluateHook({
        session_id: 'codex-1',
        cwd: wsRoot,
        hook_event_name: 'UnknownEventName',
    });
    assert.ok(unknownEvtRes.systemMessage);
    assert.match(unknownEvtRes.systemMessage, /Unsupported hook_event_name/);
});

// --------------------------------------------------------------------------
// 3. CLI Entrypoint (bin/omni-hook.js) Contract Tests
// --------------------------------------------------------------------------

// Finding 8: Bounded output serializer, <=16 KiB stdout, exactly one JSON object
test('bin/omni-hook.js CLI reads JSON stdin, writes exactly one JSON stdout, diagnostics on stderr', async (t) => {
    const wsRoot = createTempWorkspace(t);

    // 1. Oversize stdin (>64 KiB)
    const bigInput = JSON.stringify({
        session_id: 'codex-1',
        cwd: wsRoot,
        hook_event_name: 'SessionStart',
        blob: 'x'.repeat(70 * 1024),
    });

    const resBig = spawnSync(process.execPath, [HOOK_CLI], {
        input: bigInput,
        encoding: 'utf8',
        shell: false,
    });
    assert.equal(resBig.status, 0);
    const linesBig = resBig.stdout.trim().split('\n');
    assert.equal(linesBig.length, 1, 'CLI must emit exactly one JSON line');
    const parsedBig = JSON.parse(linesBig[0]);
    assert.match(parsedBig.systemMessage, /64 KiB/);

    // 2. Malformed JSON stdin
    const resMalformed = spawnSync(process.execPath, [HOOK_CLI], {
        input: '{ broken json',
        encoding: 'utf8',
        shell: false,
    });
    assert.equal(resMalformed.status, 0);
    const linesMalformed = resMalformed.stdout.trim().split('\n');
    assert.equal(linesMalformed.length, 1, 'CLI must emit exactly one JSON line');
    const parsedMalformed = JSON.parse(linesMalformed[0]);
    assert.match(parsedMalformed.systemMessage, /invalid JSON input/);
    assert.match(resMalformed.stderr, /invalid JSON/);

    // 3. Invalid PreToolUse input via CLI returns exact PreToolUse deny shape without failing open
    const resPreInvalid = spawnSync(process.execPath, [HOOK_CLI], {
        input: JSON.stringify({
            session_id: 'codex-1',
            cwd: wsRoot,
            hook_event_name: 'PreToolUse',
            tool_name: '',
        }),
        encoding: 'utf8',
        shell: false,
    });
    assert.equal(resPreInvalid.status, 0);
    const linesPre = resPreInvalid.stdout.trim().split('\n');
    assert.equal(linesPre.length, 1, 'CLI must emit exactly one JSON line');
    const parsedPreInvalid = JSON.parse(linesPre[0]);
    assert.equal(parsedPreInvalid.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.equal(parsedPreInvalid.hookSpecificOutput?.permissionDecision, 'deny');
    assert.equal(parsedPreInvalid.systemMessage, undefined);

    // 4. Valid SessionStart CLI execution from subdirectory
    const subDir = path.join(wsRoot, 'sub', 'nested');
    fs.mkdirSync(subDir, { recursive: true });

    const validIn = JSON.stringify({
        session_id: 'codex-1',
        cwd: subDir,
        hook_event_name: 'SessionStart',
    });
    const resValid = spawnSync(process.execPath, [HOOK_CLI], {
        input: validIn,
        encoding: 'utf8',
        shell: false,
    });
    assert.equal(resValid.status, 0);
    const parsedValid = JSON.parse(resValid.stdout.trim());
    assert.ok(parsedValid.hookSpecificOutput || parsedValid.systemMessage);

    // 5. Output is strictly <= 16 KiB
    assert.ok(Buffer.byteLength(resValid.stdout, 'utf8') <= 16 * 1024);

    const bootstrappedClient = createDaemonClient({ workspaceRoot: subDir, timeoutMs: 1000 });
    await bootstrappedClient.stop();
});

// --------------------------------------------------------------------------
// 4. Template (hooks.template.json) Contract Tests
// --------------------------------------------------------------------------

// Finding 10: Template checks for forbidden developer absolute paths, shell substitution, etc.
test('hooks.template.json is valid JSON with real 5 events, placeholders, and commandWindows', () => {
    assert.ok(fs.existsSync(TEMPLATE_PATH));
    const content = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const parsed = JSON.parse(content);

    assert.ok(parsed.hooks);
    const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
    for (const evt of events) {
        assert.ok(parsed.hooks[evt], `Missing hook event: ${evt}`);
        assert.ok(Array.isArray(parsed.hooks[evt]));
        assert.ok(parsed.hooks[evt].length > 0);

        const group = parsed.hooks[evt][0];
        assert.ok(Array.isArray(group.hooks));
        const hook = group.hooks[0];
        assert.equal(hook.type, 'command');
        assert.equal(hook.command, '__OMNI_HOOK_COMMAND_POSIX__');
        assert.equal(hook.commandWindows, '__OMNI_HOOK_COMMAND_WINDOWS__');
        const expectedTimeout = (evt === 'SessionStart' || evt === 'UserPromptSubmit') ? 15 : 5;
        assert.equal(hook.timeout, expectedTimeout, `Unexpected ${evt} timeout`);
        assert.ok(hook.statusMessage && hook.statusMessage.length > 0);

        // Verify command strings have no absolute paths, no node -e, and no shell substitutions ($ ` %)
        assert.equal(/([a-zA-Z]:[\\\/]|\/Users\/|\/home\/)/.test(hook.command), false);
        assert.equal(/([a-zA-Z]:[\\\/]|\/Users\/|\/home\/)/.test(hook.commandWindows), false);
        assert.equal(/[\$`%]/.test(hook.command), false);
        assert.equal(/[\$`%]/.test(hook.commandWindows), false);
        assert.equal(hook.command.includes('node -e'), false);
        assert.equal(hook.commandWindows.includes('node -e'), false);
    }

    // Matchers verification
    assert.equal(parsed.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
    assert.equal(parsed.hooks.PreToolUse[0].matcher, '^(Bash|apply_patch|mcp__.*)$');
    assert.equal(parsed.hooks.PostToolUse[0].matcher, '^(Bash|apply_patch|mcp__.*)$');
    assert.equal(parsed.hooks.UserPromptSubmit[0].matcher, undefined);
    assert.equal(parsed.hooks.Stop[0].matcher, undefined);

    // No developer absolute paths in full file
    assert.equal(/([a-zA-Z]:[\\\/]|\/Users\/|\/home\/)/.test(content), false, 'Template must not contain developer absolute paths');
});

// --------------------------------------------------------------------------
// 5. Review 2 Integration Blocker Regression Tests
// --------------------------------------------------------------------------

test('extractPatchPaths and classifyTool accept standard framing lines (Begin Patch, End Patch, End of File) and multi-file Move-to', () => {
    const standardPayload = [
        '*** Begin Patch',
        '*** Update File: src/a.js',
        '@@ -1,3 +1,4 @@',
        '+x',
        '*** Move to: src/b.js',
        '*** Add File: src/c.js',
        '+new content',
        '*** End of File',
        '*** End Patch',
    ].join('\n');

    const paths = extractPatchPaths(standardPayload);
    assert.deepEqual(paths, ['src/a.js', 'src/b.js', 'src/c.js']);

    const classification = classifyTool('apply_patch', { command: standardPayload });
    assert.equal(classification.classification, 'execute');
    assert.deepEqual(classification.paths, ['src/a.js', 'src/b.js', 'src/c.js']);
});

test('extractPatchPaths and classifyTool never embed raw patch lines or secret markers in errors/reasons', () => {
    const secretMarker = 'SECRET_HEADER_MARKER_987654321';
    const malformedPatch = `*** ${secretMarker}: src/leak.js\n+evil`;

    assert.throws(() => extractPatchPaths(malformedPatch), (err) => {
        assert.equal(err.message.includes(secretMarker), false);
        assert.match(err.message, /Malformed or unsupported patch header/);
        return true;
    });

    const res = classifyTool('apply_patch', { command: malformedPatch });
    assert.equal(res.classification, 'denied');
    assert.equal(res.reason.includes(secretMarker), false);
    assert.match(res.reason, /invalid patch path or malformed patch/);
});

test('extractEventHint identifies exact 5 event names from prefix without evaluating input', () => {
    assert.equal(extractEventHint('{"hook_event_name":"PreToolUse"}'), 'PreToolUse');
    assert.equal(extractEventHint('{"hook_event_name": "PostToolUse", "other": 1}'), 'PostToolUse');
    assert.equal(extractEventHint('{"hook_event_name" : \'SessionStart\'}'), 'SessionStart');
    assert.equal(extractEventHint('{"hook_event_name":"UserPromptSubmit"}'), 'UserPromptSubmit');
    assert.equal(extractEventHint('{"hook_event_name":"Stop"}'), 'Stop');
    assert.equal(extractEventHint('{"hook_event_name":"InvalidEvent"}'), null);
    assert.equal(extractEventHint('{"some_key":"PreToolUse"}'), null);
    assert.equal(extractEventHint('random text without json'), null);
});

test('bin/omni-hook.js never leaks secret markers on malformed JSON to stdout or stderr', () => {
    const secret = 'SECRET_JSON_PAYLOAD_MARKER_12345';
    const malformedInput = `{"session_id":"${secret}", broken json`;

    const res = spawnSync(process.execPath, [HOOK_CLI], {
        input: malformedInput,
        encoding: 'utf8',
        shell: false,
    });

    assert.equal(res.status, 0);
    assert.equal(res.stdout.includes(secret), false);
    assert.equal(res.stderr.includes(secret), false);
    assert.match(res.stderr, /invalid JSON/);
    const parsed = JSON.parse(res.stdout.trim());
    assert.match(parsed.systemMessage, /invalid JSON input/);
});

test('bin/omni-hook.js fails closed for PreToolUse on oversized input and malformed input', () => {
    // 1. Oversized PreToolUse
    const bigPreInput = JSON.stringify({
        session_id: 'codex-1',
        cwd: 'C:\\ws',
        hook_event_name: 'PreToolUse',
        tool_name: 'apply_patch',
        tool_input: { command: 'x'.repeat(70 * 1024) },
    });

    const resBigPre = spawnSync(process.execPath, [HOOK_CLI], {
        input: bigPreInput,
        encoding: 'utf8',
        shell: false,
    });
    assert.equal(resBigPre.status, 0);
    const parsedBigPre = JSON.parse(resBigPre.stdout.trim());
    assert.equal(parsedBigPre.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.equal(parsedBigPre.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(parsedBigPre.hookSpecificOutput?.permissionDecisionReason, /64 KiB/);
    assert.equal(parsedBigPre.systemMessage, undefined);

    // 2. Malformed JSON PreToolUse
    const malformedPre = '{"hook_event_name":"PreToolUse", "tool_name": broken json';
    const resMalformedPre = spawnSync(process.execPath, [HOOK_CLI], {
        input: malformedPre,
        encoding: 'utf8',
        shell: false,
    });
    assert.equal(resMalformedPre.status, 0);
    const parsedMalformedPre = JSON.parse(resMalformedPre.stdout.trim());
    assert.equal(parsedMalformedPre.hookSpecificOutput?.hookEventName, 'PreToolUse');
    assert.equal(parsedMalformedPre.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(parsedMalformedPre.hookSpecificOutput?.permissionDecisionReason, /invalid JSON input/);
    assert.equal(parsedMalformedPre.systemMessage, undefined);
});
