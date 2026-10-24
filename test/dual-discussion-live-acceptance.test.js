'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

test('F01 WP4b: real discussion host delivers two live AGY scouts to the orchestrator', {
    skip: process.env.OMNI_DUAL_LIVE !== '1',
    timeout: 1_200_000,
}, async (t) => {
    // Keep the entire production stack and all provider work behind the live gate.
    const { createDualOrchestrator } = require('../lib/dual/orchestrator');
    const { ContextSchema, AttemptMetaSchema, toDraft7Schema } = require('../lib/dual/contracts');
    const { createSnapshotBaseline } = require('../lib/dual/baseline-snapshot');
    const { canonicalizeEvent, computeEventHash, replayAuthorityEvents, computeLeaseStatus } = require('../lib/dual/authority-store');
    const { createDiscussionHost } = require('../lib/dual/discussion/host-resolver');
    const { createDaemonHostDeps } = require('../lib/dual/discussion/daemon-ports');
    const { createHostPorts } = require('../lib/dual/discussion/host-ports');
    const { inspectJournal } = require('../lib/dual/discussion/journal');
    const { bindingRef } = require('../lib/dual/discussion/contracts');
    const { createCodexAdapter, seedCodexConversation } = require('../lib/dual/discussion/live-codex-invoke');
    const { createAgyAdapter, seedAgyConversation, classify: classifyAgyOutput } = require('../lib/dual/discussion/live-agy-invoke');
    const { spawnBoundedProcess } = require('../lib/dual/capability-preflight');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-disc-live-acceptance-'));
    const repoRoot = path.join(tempDir, 'workspace');
    const stateDir = path.join(tempDir, 'discussion');
    const taskIds = ['TASK-LIVE-ALPHA', 'TASK-LIVE-BETA'];
    const daemonState = { sessionId: 'live-acceptance-session', revision: 1 };
    const checks = ['authority_ledger_integrity', 'baseline_backend',
        'project_configuration', 'agy_cli_and_model', 'mcp_and_hook_setup']
        .map((name) => ({ name, status: 'PASSED' }));
    const models = { codex: 'gpt-6.1-sol', agy: 'gemini-3.8-flash-high' };
    const limits = { ttlMs: 900000, timeoutMs: 110000 };
    const codexOptions = { cwd: repoRoot, model: models.codex, effort: 'medium', timeoutMs: limits.timeoutMs };
    const agyOptions = { effort: 'high', cwd: repoRoot, model: models.agy, timeoutMs: limits.timeoutMs };
    const seeds = { codex: [], agy: [] };
    const contexts = [];
    const sessions = [];
    const observations = new Map();
    let host;
    let stage = 'snapshot/process scaffolding';
    let scaffolding = true;
    try {
        fs.mkdirSync(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'entry.js'),
            "'use strict';\nfunction activeIds(xs) { return xs.filter(x => x.active).map(x => x.id); }\nmodule.exports = { activeIds };\n");
        fs.writeFileSync(path.join(repoRoot, 'README.md'),
            '# Scout fixture\nentry.js exports activeIds; it returns ids of active records.\n');
        const initialSnapshot = createSnapshotBaseline({ root: repoRoot }).capture();

        // Same complete envelopes as daemon-ports fixtures, with one live lease
        // per task. Build once: replay must validate a stable history, not a mock grant.
        const start = Date.now() - 10000;
        const payloads = [
            { type: 'session.created', state: 'DISCOVERED', workspace_root: repoRoot, mode: 'auto' },
            { type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE',
                status: 'PASSED', checks },
            { type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED',
                plan_path: 'plans/plan.md', plan_sha256: 'd'.repeat(64), total_tasks: taskIds.length,
                tasks: taskIds.map((taskId) => ({ task_id: taskId, title: 'Read-only scout',
                    owner: 'agy', allowed_files: ['entry.js'] })) },
            ...taskIds.flatMap((taskId) => [
                { type: 'task.routed', task_id: taskId, owner: 'agy', authority_state: 'ROUTED',
                    model: models.agy, effort: 'high', token_budget: 10000,
                    allowed_files: ['entry.js'], reason: 'Live read-only acceptance' },
                { type: 'lease.acquired', lease_id: randomUUID(), task_id: taskId, owner: 'agy',
                    acquired_at: new Date(start).toISOString(),
                    expires_at: new Date(start + 1_800_000).toISOString(), ttl_ms: 1_800_000 },
            ]),
        ];
        let previousHash = '0'.repeat(64);
        let previousId = randomUUID();
        const leaseEvents = payloads.map((payload, index) => {
            const eventId = randomUUID();
            const event = JSON.parse(canonicalizeEvent({ schema_version: 2, sequence: index + 1,
                event_id: eventId, causation_id: previousId, workspace_id: 'ws-live-acceptance',
                session_id: daemonState.sessionId, plan_revision: daemonState.revision,
                expected_baseline: initialSnapshot.identity,
                timestamp: new Date(start + index * 1000).toISOString(), ...payload }));
            const envelope = { previous_hash: previousHash,
                event_hash: computeEventHash(previousHash, event), event };
            previousHash = envelope.event_hash;
            previousId = eventId;
            return envelope;
        });
        const authorityState = replayAuthorityEvents(leaseEvents);
        assert.equal(authorityState.sessionId, daemonState.sessionId);
        assert.equal(authorityState.planRevision, daemonState.revision);
        for (const taskId of taskIds) {
            assert.ok(Object.values(authorityState.leases).some((lease) =>
                lease.task_id === taskId && computeLeaseStatus(lease, Date.now()) === 'active'));
        }
        const codex = createCodexAdapter(codexOptions);
        const agy = createAgyAdapter(agyOptions);
        const schema = toDraft7Schema(ContextSchema, 'omni-dual-context-v1');
        // The seed API has a fixed readiness prompt. Its wrapper resumes that
        // actual conversation once via a bounded CLI call to load the brief.
        // This is setup only; neither this call nor controller fakes supply a scout.
        async function seedWorker(options) {
            stage = 'AGY seed';
            t.diagnostic(stage);
            const seeded = await seedAgyConversation({ ...options, ...agyOptions });
            seeds.agy.push(seeded.conversationId);
            stage = 'AGY seed brief';
            const brief = [
                'SYSTEM-STYLE BRIEF FOR SUBSEQUENT PHASE PROMPTS:',
                'Read-only reconnaissance only. Never write files, commit, push, deploy, or change permissions.',
                'For each scout phase, answer with ONLY the ContextSchema JSON object required below.',
                'The discussion transport requires an outer {schema_version:1,kind:"reply",body:"..."};',
                'put the serialized ContextSchema object in that body string. No markdown or prose outside JSON.',
                'Use the exact task_id and baseline from the phase prompt; do not reuse another task identity.',
                'Read entry.js and README.md for independent research checks. Do not invent test execution.',
                'The orchestrator writes raw/scout.1.schema.json separately from the phase input;',
                'this is its schema content:', JSON.stringify(schema),
                'For THIS setup message only, return the discussion reply with body exactly ready.',
            ].join('\n');
            const setup = await spawnBoundedProcess(options.agyPath || 'agy', [
                '-p', brief, '--conversation', seeded.conversationId,
                '--output-format', 'json', '--model', models.agy,
                '--print-timeout', `${Math.ceil(limits.timeoutMs / 1000)}s`,
            ], { cwd: repoRoot, timeoutMs: limits.timeoutMs, maxOutputBytes: 131072 });
            assert.equal(setup.ok, true, JSON.stringify(setup));
            const raw = { ...setup, exitCode: setup.code };
            const observed = classifyAgyOutput(raw);
            assert.equal(observed.completion, 'succeeded', JSON.stringify(raw));
            assert.equal(observed.observedConversationId, seeded.conversationId);
            assert.deepEqual(observed.payload, { schema_version: 1, kind: 'reply', body: 'ready' });
            return seeded;
        }
        // Controller capability fixtures mirror the orchestrator/daemon-ports
        // suites. Provider seeding, invocation and classification all remain live.
        host = createDiscussionHost({ enabled: true, stateDir, models, limits,
            daemon: { sessionId: daemonState.sessionId, workspaceRoot: repoRoot,
                getPlanRevision: () => daemonState.revision, readLeaseEvents: async () => leaseEvents },
            preflight: { run: async (_root, { workerModel }) => ({
                status: 'PASSED', to_state: 'CAPABILITY_SAFE', checks,
                details: { agy_version: '1.2.3', agy_model: workerModel,
                    agy_evidence: { version: '1.2.3', model: workerModel } },
            }), codexProbe: async () => true },
            seeds: { codex: async (options) => {
                stage = 'Codex seed';
                t.diagnostic(stage);
                const seeded = await seedCodexConversation({ ...options, ...codexOptions });
                seeds.codex.push(seeded.conversationId);
                return seeded;
            }, agy: seedWorker },
            adapters: { codex, agy: { ...agy, classify(raw, binding, invocationId, caps) {
                const result = agy.classify(raw, binding, invocationId, caps);
                observations.set(result.observedConversationId + ':' + invocationId, result);
                return result;
            } } },
        });
        const orch = createDualOrchestrator({ cwd: repoRoot, backend: 'snapshot', initialSnapshot,
            workerModel: models.agy,
            workerEffort: 'high',
            authoritativeCapabilityEvidence: { version: '1.2.3', model: models.agy },
            processRunner: async () => { assert.fail('Worker must use discussion, never the cold-start processRunner'); },
            discussion: { enabled: true, sessionResolver: async (context) => {
                contexts.push(context);
                const session = await host.sessionResolver(context);
                sessions.push(session);
                // Exercise the real daemon authority ports against exactly the
                // host snapshot/bindings, independently of the relay's own checks.
                const ports = createHostPorts(createDaemonHostDeps({ authority: host.authorityReader }));
                assert.equal(await ports.authority.check({ bindings: session.bindings }), true);
                stage = `${context.taskId}: relay dispatch / live AGY scout`;
                t.diagnostic(stage);
                return session;
            } },
        });

        for (const [index, taskId] of taskIds.entries()) {
            scaffolding = true;
            stage = `${taskId}: controller preflight`;
            orch.newTask(taskId);
            const runDir = path.join(repoRoot, '.omni/codex-gemini/runs', taskId);
            fs.writeFileSync(path.join(runDir, 'request.md'),
                'Read entry.js and README.md. Explain activeIds and its assumptions; propose no changes. Return ContextSchema JSON.');
            assert.equal((await orch.runPhase('preflight', taskId)).state, 'PREFLIGHT_SAFE');
            scaffolding = false;
            const result = await orch.runPhase('scout', taskId);
            stage = `${taskId}: artifact and journal assertions`;
            assert.deepEqual(result, { taskId, state: 'SCOUT_VALID', owner: 'codex',
                nextAction: 'spec', warnings: [], reused: false });
            const read = (name) => JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8'));
            const payload = read('context.json');
            assert.deepEqual(ContextSchema.parse(payload), payload);
            assert.equal(payload.schema_version, 1);
            assert.equal(payload.task_id, taskId);
            assert.deepEqual(payload.expected_baseline, initialSnapshot.identity);
            assert.ok(payload.summary.length > 0);
            for (const key of ['relevant_files', 'exact_symbols', 'validation_commands', 'constraints',
                'risks', 'open_questions', 'research_trace', 'alternatives_considered', 'failure_modes']) {
                assert.ok(Array.isArray(payload[key]), `${taskId}: ${key} must be an array`);
            }
            assert.ok(payload.relevant_files.some((file) => file.path === 'entry.js'));
            assert.deepEqual(read('raw/scout.1.schema.json'), schema);
            const meta = read('raw/scout.1.meta.json');
            assert.deepEqual(AttemptMetaSchema.parse(meta), meta);
            assert.equal(meta.transport, 'discussion');
            assert.ok(meta.messageId);
            assert.ok(meta.responseMessageId);
            assert.notEqual(meta.messageId, meta.responseMessageId);
            assert.equal(meta.exit_code, 0);
            assert.equal(meta.timed_out, false);
            const session = sessions[index];
            const context = contexts[index];
            assert.deepEqual(context, { taskId, snapshotSha256: initialSnapshot.identity.id,
                phase: 'scout', workspaceRoot: repoRoot,
                workerModel: models.agy, workerEffort: 'high' });
            const sessionDir = path.join(stateDir,
                encodeURIComponent(`${taskId}|${context.snapshotSha256}|${daemonState.revision}|${models.agy}|high`));
            const journal = await inspectJournal({ stateDir: sessionDir });
            const received = journal.events.filter(({ event }) => event.type === 'received');
            const responses = journal.events.filter(({ event }) => event.type === 'response');
            assert.equal(received.length, 1);
            assert.equal(responses.length, 1);
            const question = received[0].event.envelope;
            const response = responses[0].event.response_envelope;
            assert.equal(question.kind, 'question');
            assert.equal(question.message_id, meta.messageId);
            assert.equal(question.sender_ref, bindingRef(session.bindings[0]));
            assert.equal(question.recipient_ref, bindingRef(session.bindings[1]));
            const inputContent = fs.readFileSync(path.join(runDir, 'raw/scout.1.input.md'), 'utf8');
            const schemaContent = fs.readFileSync(path.join(runDir, 'raw/scout.1.schema.json'), 'utf8');
            assert.equal(question.body, `${inputContent}\n\n--- PHASE OUTPUT SCHEMA (JSON Schema) ---\n${schemaContent}\nAnswer with ONLY a JSON object matching this schema.\n`);
            assert.equal(response.kind, 'reply');
            assert.equal(response.message_id, meta.responseMessageId);
            assert.equal(response.reply_to, question.message_id);
            assert.deepEqual(JSON.parse(response.body), payload);
            assert.equal(fs.readFileSync(path.join(runDir, 'raw/scout.1.stdout.json'), 'utf8'), response.body);
            const turn = (await session.relay.inspect()).turns.find((entry) => entry.message_id === meta.messageId);
            assert.equal(turn.provider, 'succeeded');
            assert.equal(turn.schema, 'valid');
            assert.equal(turn.discussion_result, 'available');
            assert.equal(observations.get(session.conversationIds.agy + ':' + turn.invocation_id).observedConversationId, session.conversationIds.agy);
            assert.equal(seeds.codex.length, index + 1);
            assert.equal(seeds.agy.length, index + 1);
            t.diagnostic(`${taskId}: ${JSON.stringify(result)}; transport=${meta.transport}; messageId=${meta.messageId}; responseMessageId=${meta.responseMessageId}`);
        }
        stage = 'second session and first-task cache assertions';
        assert.notStrictEqual(sessions[0], sessions[1]);
        assert.notEqual(sessions[0].conversationIds.codex, sessions[1].conversationIds.codex);
        assert.notEqual(sessions[0].conversationIds.agy, sessions[1].conversationIds.agy);
        assert.equal(observations.size, 2);
        assert.strictEqual(await host.sessionResolver(contexts[0]), sessions[0]);
        assert.deepEqual({ codex: seeds.codex.length, agy: seeds.agy.length }, { codex: 2, agy: 2 });
        assert.equal(fs.readdirSync(stateDir).length, 2);
    } catch (error) {
        // Only sandbox-denied controller scaffolding is skippable. Provider,
        // transport, contract and assertion failures must remain real failures.
        if (scaffolding && (error.code === 'EPERM' || error.cause?.code === 'EPERM')) {
            t.skip(`Sandbox blocked orchestrator scaffolding at ${stage}: ${error.message}`);
            return;
        }
        t.diagnostic(`Stopped at ${stage}: ${error.code || error.name}: ${error.message}`);
        if (error.details) t.diagnostic(JSON.stringify(error.details));
        throw error;
    } finally {
        try {
            if (host) await host.closeAll();
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    }
});
