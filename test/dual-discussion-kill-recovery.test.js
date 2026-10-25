'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { createDualOrchestrator } = require('../lib/dual/orchestrator');
const { buildBindings } = require('../lib/dual/discussion/session');

async function fixture(t, { taskId = 'TASK-KILL-RECOVERY' } = {}) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-kill-recovery-'));
    t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
    const git = (...args) => {
        const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test User');
    git('config', 'user.email', 'test@example.com');
    fs.writeFileSync(path.join(repoRoot, 'index.html'), '<body>Hello</body>\n');
    git('add', '.');
    git('commit', '-m', 'initial');
    const head = git('rev-parse', 'HEAD');
    const correlation = { schema_version: 1, task_id: taskId, expected_base_commit: head };
    const payloads = {
        scout: {
            ...correlation,
            summary: 'Scout analysis',
            relevant_files: [{ path: 'index.html', description: 'Entry' }],
            exact_symbols: [{ name: 'body', file: 'index.html', verified: true }],
            validation_commands: ['node --version'],
            constraints: [],
            risks: [],
            open_questions: [],
            research_trace: [
                { question: 'Where?', source: 'index.html', source_type: 'REPOSITORY', conclusion: 'Entry.' },
                { question: 'Check?', source: 'node --version', source_type: 'TEST_OUTPUT', conclusion: 'Available.' },
            ],
            alternatives_considered: [{ option: 'Edit entry', tradeoff: 'Small.' }, { option: 'New module', tradeoff: 'Complex.' }],
            failure_modes: ['Malformed markup.'],
        },
    };
    const messages = [];
    const createDefaultSession = () => ({
        enabled: true,
        bindings: buildBindings({
            models: { agy: 'gemini-3.7-flash-high' },
            efforts: { agy: 'high' },
            sessionId: 'session-1',
            taskId,
            planRevision: 2,
            snapshotSha256: 'a'.repeat(64),
            codexConversationId: 'codex-1',
            agyConversationId: 'agy-1',
        }),
        relay: {
            async inspect() { return { messages, unknown: null }; },
            async receive(message) { messages.push(message); },
            async dispatch(messageId) {
                const body = JSON.stringify(payloads.scout);
                messages.push({ message_id: `response-${messageId}`, body });
                return { response_message_id: `response-${messageId}`, invocation_id: 'inv-1' };
            },
        },
    });

    let activeResolver = null;
    const setSessionResolver = (resolver) => { activeResolver = resolver; };

    const orch = createDualOrchestrator({
        workerModel: 'gemini-3.7-flash-high',
        workerEffort: 'high',
        cwd: repoRoot,
        authoritativeCapabilityEvidence: { version: '1.1.19', model: 'gemini-3.7-flash-high' },
        discussion: {
            enabled: true,
            sessionResolver: async (context) => {
                if (typeof activeResolver === 'function') {
                    return activeResolver(context);
                }
                return createDefaultSession();
            },
        },
        processRunner: async () => {
            assert.fail('Cold worker process runner must not be called during discussion scout');
        },
    });

    orch.newTask(taskId);
    await orch.runPhase('preflight', taskId);
    const runDir = path.join(repoRoot, '.omni/codex-gemini/runs', taskId);
    const read = (name) => JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8'));
    const readEvents = () => {
        const content = fs.readFileSync(path.join(runDir, 'events.ndjson'), 'utf8').trim();
        return content ? content.split('\n').map((line) => JSON.parse(line)) : [];
    };

    return {
        orch,
        taskId,
        repoRoot,
        runDir,
        read,
        readEvents,
        payloads,
        setSessionResolver,
        createDefaultSession,
    };
}

test('(a) kill-giữa-seed codex: non-terminal failure allows subsequent attempt to succeed', async (t) => {
    let callCount = 0;
    const f = await fixture(t);
    f.setSessionResolver(async () => {
        callCount++;
        if (callCount === 1) {
            const err = new Error('Codex seed failed (exit=null, timedOut=true, overflowed=false): Reading additional input from stdin...');
            err.details = { conversationIds: {} };
            throw err;
        }
        return f.createDefaultSession();
    });

    await assert.rejects(
        f.orch.runPhase('scout', f.taskId),
        /Codex seed failed \(exit=null, timedOut=true, overflowed=false\)/
    );

    const events = f.readEvents();
    const failedEvent = events.find((e) => e.type === 'phase.failed' && e.phase === 'scout' && e.attempt === 1);
    assert.ok(failedEvent, 'phase.failed event for scout attempt 1 should exist');
    assert.equal(failedEvent.retryable, true, 'phase.failed event retryable should be true');

    const failureEvidence = f.read('raw/scout.1.failure.json');
    assert.equal(failureEvidence.retryable, true, 'raw/scout.1.failure.json retryable should be true');

    const result = await f.orch.runPhase('scout', f.taskId);
    assert.equal(result.state, 'SCOUT_VALID');
    assert.deepEqual(f.read('context.json'), f.payloads.scout);
    const meta2 = f.read('raw/scout.2.meta.json');
    assert.equal(meta2.attempt, 2);
});

test('(a2) kill-giữa-seed agy: non-terminal failure allows subsequent attempt to succeed', async (t) => {
    let callCount = 0;
    const f = await fixture(t);
    f.setSessionResolver(async () => {
        callCount++;
        if (callCount === 1) {
            const err = new Error('AGY seed process failed (exitCode=null, timedOut=true, overflowed=false, transportError=false): unexpected kill');
            err.details = { conversationIds: {} };
            throw err;
        }
        return f.createDefaultSession();
    });

    await assert.rejects(
        f.orch.runPhase('scout', f.taskId),
        /AGY seed process failed \(exitCode=null, timedOut=true, overflowed=false, transportError=false\)/
    );

    const events = f.readEvents();
    const failedEvent = events.find((e) => e.type === 'phase.failed' && e.phase === 'scout' && e.attempt === 1);
    assert.ok(failedEvent, 'phase.failed event for scout attempt 1 should exist');
    assert.equal(failedEvent.retryable, true, 'phase.failed event retryable should be true');

    const failureEvidence = f.read('raw/scout.1.failure.json');
    assert.equal(failureEvidence.retryable, true, 'raw/scout.1.failure.json retryable should be true');

    const result = await f.orch.runPhase('scout', f.taskId);
    assert.equal(result.state, 'SCOUT_VALID');
    assert.deepEqual(f.read('context.json'), f.payloads.scout);
    const meta2 = f.read('raw/scout.2.meta.json');
    assert.equal(meta2.attempt, 2);
});

test('(c1) fail thật do cấu hình: sessionResolver throw INVALID_INPUT -> terminal failure', async (t) => {
    let callCount = 0;
    const f = await fixture(t);
    f.setSessionResolver(async () => {
        callCount++;
        if (callCount === 1) {
            const err = new Error('Invalid discussion worker input configuration');
            err.code = 'INVALID_INPUT';
            throw err;
        }
        return f.createDefaultSession();
    });

    await assert.rejects(
        f.orch.runPhase('scout', f.taskId),
        (err) => err.code === 'INVALID_INPUT'
    );

    const events = f.readEvents();
    const failedEvent = events.find((e) => e.type === 'phase.failed' && e.phase === 'scout' && e.attempt === 1);
    assert.ok(failedEvent);
    assert.equal(failedEvent.retryable, false);

    const failureEvidence = f.read('raw/scout.1.failure.json');
    assert.equal(failureEvidence.retryable, false);

    await assert.rejects(
        f.orch.runPhase('scout', f.taskId),
        /Cannot continue scout: terminal failure at attempt 1/
    );
});

test('(c2) fail thật sau khi session đã có: relay dispatch throw OUTCOME_UNKNOWN -> terminal failure', async (t) => {
    const f = await fixture(t);
    const session = f.createDefaultSession();
    session.relay.dispatch = async () => {
        throw Object.assign(new Error('outcome unavailable'), { code: 'OUTCOME_UNKNOWN' });
    };
    f.setSessionResolver(async () => session);

    await assert.rejects(
        f.orch.runPhase('scout', f.taskId),
        (err) => err.code === 'OUTCOME_UNKNOWN'
    );

    const events = f.readEvents();
    const failedEvent = events.find((e) => e.type === 'phase.failed' && e.phase === 'scout' && e.attempt === 1);
    assert.ok(failedEvent);
    assert.equal(failedEvent.retryable, false);

    const failureEvidence = f.read('raw/scout.1.failure.json');
    assert.equal(failureEvidence.retryable, false);

    await assert.rejects(
        f.orch.runPhase('scout', f.taskId),
        /Cannot continue scout: terminal failure at attempt 1/
    );
});

test('(c3) seed fail do provider exit thật: exit=1 -> terminal failure', async (t) => {
    let callCount = 0;
    const f = await fixture(t);
    f.setSessionResolver(async () => {
        callCount++;
        if (callCount === 1) {
            const err = new Error('Codex seed failed (exit=1, timedOut=false, overflowed=false): invalid flag');
            err.details = { conversationIds: {} };
            throw err;
        }
        return f.createDefaultSession();
    });

    await assert.rejects(
        f.orch.runPhase('scout', f.taskId),
        /Codex seed failed \(exit=1, timedOut=false, overflowed=false\)/
    );

    const events = f.readEvents();
    const failedEvent = events.find((e) => e.type === 'phase.failed' && e.phase === 'scout' && e.attempt === 1);
    assert.ok(failedEvent);
    assert.equal(failedEvent.retryable, false);

    const failureEvidence = f.read('raw/scout.1.failure.json');
    assert.equal(failureEvidence.retryable, false);

    await assert.rejects(
        f.orch.runPhase('scout', f.taskId),
        /Cannot continue scout: terminal failure at attempt 1/
    );
});
