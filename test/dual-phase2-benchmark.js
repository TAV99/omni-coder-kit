#!/usr/bin/env node
'use strict';

// Standalone live benchmark, deliberately not registered with node:test.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const PROTOCOL = 'f01-phase2-v1';
const DEADLINE_MS = 240000;
const MODELS = { codex: 'gpt-6.1-sol', agy: 'gemini-3.8-flash-high' };
const FIXTURE = {
    'entry.js': "'use strict';\nmodule.exports = require('./lib/util');\n",
    'README.md': '# Benchmark fixture\nactiveIds returns ids of active records. parseRecords parses a JSON array.\nRun: node --test test/smoke.test.js\n',
    'lib/util.js': "'use strict';\nfunction activeIds(xs) {\n    return xs.filter(x => x.active).map(x => x.id);\n}\nmodule.exports = { activeIds };\n",
    'lib/parse.js': "'use strict';\nfunction parseRecords(text) {\n    const xs = JSON.parse(text);\n    if (!Array.isArray(xs)) throw new TypeError('Expected array');\n    return xs;\n}\nmodule.exports = { parseRecords };\n",
    'test/smoke.test.js': "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { activeIds } = require('../entry');\nconst { parseRecords } = require('../lib/parse');\ntest('active ids', () => assert.deepEqual(activeIds([{id: 1, active: true}, {id: 2, active: false}]), [1]));\ntest('parse array', () => assert.deepEqual(parseRecords('[]'), []));\n",
};
const EXTRA_MODULES = {
    'lib/format.js': "'use strict';\nmodule.exports = { formatIds: xs => xs.join(',') };\n",
    'lib/stats.js': "'use strict';\nmodule.exports = { countActive: xs => xs.filter(x => x.active).length };\n",
    'lib/validate.js': "'use strict';\nmodule.exports = { hasId: x => x != null && Object.hasOwn(x, 'id') };\n",
};
const GUARD = "    if (!Array.isArray(xs)) throw new TypeError('Expected array');\n";
const PATCH = [
    '--- a/lib/util.js', '+++ b/lib/util.js', '@@ -1,5 +1,6 @@',
    " 'use strict';", ' function activeIds(xs) {', '+' + GUARD.trimEnd(),
    '     return xs.filter(x => x.active).map(x => x.id);', ' }',
    ' module.exports = { activeIds };', '',
].join('\n');

function writeJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
function failure(code) { return Object.assign(new Error(code), { code }); }
function codeOf(error) { return String(error.code || error.cause?.code || 'BENCHMARK_ERROR').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100); }
function blank(task) {
    const pending = () => ({ wallMs: null, ok: false, errorCode: 'NOT_RUN' });
    return { phases: { preflight: pending(), scout: pending(), ...(task === 'T3'
        ? { prepareReview: pending(), review: pending() } : {}) },
    ok: false, errorCode: null, stage: 'setup', payloadValid: false,
    conversationIds: [], tokens: 'unavailable', continuity: false };
}

// Token observations retain only numeric fields.
function tokenFields(stdout, source) {
    const records = [];
    for (const line of [stdout, ...String(stdout || '').split('\n')]) {
        let value;
        try { value = JSON.parse(line); } catch { continue; }
        function visit(node, prefix, depth) {
            if (!node || typeof node !== 'object' || depth > 8) return;
            for (const [key, item] of Object.entries(node)) {
                if (/^(input_tokens|output_tokens|total_tokens|cached_input_tokens|cache_read_input_tokens|prompt_tokens|completion_tokens|reasoning_tokens|inputTokens|outputTokens|totalTokens|promptTokenCount|candidatesTokenCount|totalTokenCount)$/.test(key)
                    && Number.isFinite(item) && item >= 0) {
                    records.push({ source, field: prefix + key, value: item });
                } else if (typeof item === 'object') visit(item, prefix + key + '.', depth + 1);
            }
        }
        visit(value, '', 0);
        // A single JSON document must not also be counted as a JSONL line.
        if (line === stdout) break;
    }
    return records;
}

function rejectRetiredMode(mode) {
    if (mode !== 'OLD') return;
    throw Object.assign(new Error('Mode OLD was retired in Phase 3; to reproduce OLD, checkout a historical revision in a separate workspace with a version label. There is no hidden cold option in the Phase 3 product.'), { code: 'BENCHMARK_OLD_RETIRED' });
}

async function worker(config) {
    rejectRetiredMode(config.mode);
    // Imports/provider initialization stay entirely behind the live gate.
    const { createDualOrchestrator } = require('../lib/dual/orchestrator');
    const { ContextSchema, ReviewSchema, SpecSchema, EvidenceSchema, toDraft7Schema } = require('../lib/dual/contracts');
    const { createSnapshotBaseline } = require('../lib/dual/baseline-snapshot');
    const { createStateStore } = require('../lib/dual/state-store');
    const { canonicalizeEvent, computeEventHash, replayAuthorityEvents, computeLeaseStatus } = require('../lib/dual/authority-store');
    const { createDiscussionHost } = require('../lib/dual/discussion/host-resolver');
    const { createHostPorts } = require('../lib/dual/discussion/host-ports');
    const { createDaemonHostDeps } = require('../lib/dual/discussion/daemon-ports');
    const { createCodexAdapter, seedCodexConversation } = require('../lib/dual/discussion/live-codex-invoke');
    const { createAgyAdapter, seedAgyConversation, classify } = require('../lib/dual/discussion/live-agy-invoke');
    const { spawnBoundedProcess } = require('../lib/dual/capability-preflight');
    const { task, mode, root } = config;
    const result = blank(task);
    const repoRoot = path.join(root, 'workspace');
    const taskId = 'BENCH-' + task;
    const runDir = path.join(repoRoot, '.omni/codex-gemini/runs', taskId);
    let host;
    let snapshot;
    const sessions = [];
    const usage = [];
    const send = () => {
        result.tokens = usage.length ? { coverage: 'partial', observations: usage,
            aggregation: 'none; may be cumulative' } : 'unavailable';
        if (process.connected) process.send({ result });
    };
    function stage(name) { result.stage = name; send(); }
    async function phase(name, action) {
        stage(name);
        const start = performance.now();
        try {
            const value = await action();
            result.phases[name] = { wallMs: performance.now() - start, ok: true, errorCode: null };
            return value;
        } catch (error) {
            result.phases[name] = { wallMs: performance.now() - start, ok: false, errorCode: codeOf(error) };
            throw error;
        } finally { send(); }
    }
    try {
        for (const [file, content] of Object.entries({ ...FIXTURE, ...(task === 'T2' ? EXTRA_MODULES : {}) })) {
            const target = path.join(repoRoot, file);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, content);
        }
        snapshot = createSnapshotBaseline({ root: repoRoot }).capture();
        const options = { cwd: repoRoot, backend: 'snapshot', initialSnapshot: snapshot,
            workerModel: MODELS.agy, workerEffort: 'high', timeoutMs: 110000,
            env: process.env, authoritativeCapabilityEvidence: { version: '1.2.3', model: MODELS.agy } };
        if (mode === 'NEW') {
            const checks = ['authority_ledger_integrity', 'baseline_backend', 'project_configuration',
                'agy_cli_and_model', 'mcp_and_hook_setup'].map(name => ({ name, status: 'PASSED' }));
            const sessionId = 'benchmark-' + randomUUID();
            const start = Date.now() - 10000;
            const payloads = [
                { type: 'session.created', state: 'DISCOVERED', workspace_root: repoRoot, mode: 'auto' },
                { type: 'capability.result', from_state: 'DISCOVERED', to_state: 'CAPABILITY_SAFE', status: 'PASSED', checks },
                { type: 'plan.registered', from_state: 'INTERVIEWING', to_state: 'PLANNED', plan_path: 'plans/plan.md',
                    plan_sha256: 'd'.repeat(64), total_tasks: 1,
                    tasks: [{ task_id: taskId, title: 'Read-only benchmark', owner: 'agy', allowed_files: Object.keys(FIXTURE) }] },
                { type: 'task.routed', task_id: taskId, owner: 'agy', authority_state: 'ROUTED', model: MODELS.agy,
                    effort: 'high', token_budget: 10000, allowed_files: Object.keys(FIXTURE), reason: 'Read-only benchmark' },
                { type: 'lease.acquired', lease_id: randomUUID(), task_id: taskId, owner: 'agy',
                    acquired_at: new Date(start).toISOString(), expires_at: new Date(start + 1800000).toISOString(), ttl_ms: 1800000 },
            ];
            let previousHash = '0'.repeat(64);
            let previousId = randomUUID();
            const leaseEvents = payloads.map((payload, index) => {
                const event = JSON.parse(canonicalizeEvent({ schema_version: 2, sequence: index + 1,
                    event_id: randomUUID(), causation_id: previousId, workspace_id: 'ws-benchmark', session_id: sessionId,
                    plan_revision: 1, expected_baseline: snapshot.identity,
                    timestamp: new Date(start + index * 1000).toISOString(), ...payload }));
                const envelope = { previous_hash: previousHash, event_hash: computeEventHash(previousHash, event), event };
                previousHash = envelope.event_hash;
                previousId = event.event_id;
                return envelope;
            });
            const authority = replayAuthorityEvents(leaseEvents);
            if (authority.sessionId !== sessionId || authority.planRevision !== 1
                || !Object.values(authority.leases).some(lease => lease.task_id === taskId && computeLeaseStatus(lease, Date.now()) === 'active')) {
                throw failure('BENCHMARK_LEASE_INVALID');
            }
            const agyOptions = { cwd: repoRoot, model: MODELS.agy, timeoutMs: 110000 };
            const codexOptions = { cwd: repoRoot, model: MODELS.codex, effort: 'medium', timeoutMs: 110000 };
            const observeAdapter = (adapter, provider) => ({ ...adapter, classify(raw, ...args) {
                usage.push(...tokenFields(raw?.stdout, provider + ':' + result.stage));
                send();
                return adapter.classify(raw, ...args);
            } });
            host = createDiscussionHost({ enabled: true, stateDir: path.join(root, 'discussion'), models: MODELS,
                limits: { ttlMs: 900000, timeoutMs: 110000 },
                daemon: { sessionId, workspaceRoot: repoRoot, getPlanRevision: () => 1, readLeaseEvents: async () => leaseEvents },
                preflight: { run: async (_root, { workerModel }) => ({ status: 'PASSED', to_state: 'CAPABILITY_SAFE', checks,
                    details: { agy_version: '1.2.3', agy_model: workerModel, agy_evidence: { version: '1.2.3', model: workerModel } } }),
                codexProbe: async () => true },
                seeds: {
                    codex: async seedOptions => {
                        stage('codexSeed');
                        const seeded = await seedCodexConversation({ ...seedOptions, ...codexOptions });
                        usage.push(...tokenFields(seeded.rawStdout, 'codex:seed'));
                        result.conversationIds.push({ provider: 'codex', id: seeded.conversationId }); send();
                        return seeded;
                    },
                    agy: async seedOptions => {
                        stage('agySeed');
                        const seeded = await seedAgyConversation({ ...seedOptions, ...agyOptions });
                        usage.push(...tokenFields(seeded.rawStdout, 'agy:seed'));
                        result.conversationIds.push({ provider: 'agy', id: seeded.conversationId }); send();
                        stage('agySeedBrief');
                        const brief = ['Read-only reconnaissance and review. Never write files, commit, push or deploy.',
                            'For subsequent scout/review prompts use the exact task_id and baseline in that prompt.',
                            'Return outer {schema_version:1,kind:"reply",body:"..."} with serialized phase JSON in body.',
                            'Scout schema:', JSON.stringify(toDraft7Schema(ContextSchema, 'omni-dual-context-v1')),
                            'Review schema:', JSON.stringify(toDraft7Schema(ReviewSchema, 'omni-dual-review-v1')),
                            'Read the fixture files independently. Do not invent test execution.',
                            'For THIS setup only return the discussion reply with body exactly ready.'].join('\n');
                        const setup = await spawnBoundedProcess(seedOptions.agyPath || 'agy', ['-p', brief,
                            '--conversation', seeded.conversationId, '--output-format', 'json', '--model', MODELS.agy,
                            '--print-timeout', '110s'], { cwd: repoRoot, timeoutMs: 110000, maxOutputBytes: 131072 });
                        usage.push(...tokenFields(setup.stdout, 'agy:seedBrief'));
                        const observed = classify({ ...setup, exitCode: setup.code });
                        if (!setup.ok || observed.completion !== 'succeeded' || observed.observedConversationId !== seeded.conversationId
                            || JSON.stringify(observed.payload) !== JSON.stringify({ schema_version: 1, kind: 'reply', body: 'ready' })) {
                            throw failure('BENCHMARK_SEED_BRIEF_FAILED');
                        }
                        stage('scout');
                        return seeded;
                    },
                },
                adapters: { codex: observeAdapter(createCodexAdapter(codexOptions), 'codex'),
                    agy: observeAdapter(createAgyAdapter(agyOptions), 'agy') },
            });
            options.discussion = { enabled: true, sessionResolver: async context => {
                const session = await host.sessionResolver(context);
                const ports = createHostPorts(createDaemonHostDeps({ authority: host.authorityReader }));
                if (!await ports.authority.check({ bindings: session.bindings })) throw failure('BENCHMARK_AUTHORITY_INVALID');
                sessions.push(session);
                return session;
            } };
        }
        // Historical OLD omitted discussion/processRunner overrides; Phase 3 rejects it before I/O.
        const orch = createDualOrchestrator(options);
        orch.newTask(taskId);
        const request = 'Read all fixture source files, README.md and test/smoke.test.js. Explain APIs, assumptions and risks. '
            + 'Do not change files or invent test execution. Return the requested phase schema JSON.'
            + (task === 'T3' ? '\nAfter scout the harness will apply this fixed patch. Review it against the original fixture:\n' + PATCH : '');
        fs.writeFileSync(path.join(runDir, 'request.md'), request);
        await phase('preflight', async () => {
            if ((await orch.runPhase('preflight', taskId)).state !== 'PREFLIGHT_SAFE') throw failure('UNEXPECTED_STATE');
        });
        const valid = (file, schema) => {
            const payload = schema.parse(JSON.parse(fs.readFileSync(path.join(runDir, file), 'utf8')));
            if (payload.task_id !== taskId || JSON.stringify(payload.expected_baseline) !== JSON.stringify(snapshot.identity)) {
                throw failure('BENCHMARK_PAYLOAD_CORRELATION');
            }
        };
        await phase('scout', async () => {
            if ((await orch.runPhase('scout', taskId)).state !== 'SCOUT_VALID') throw failure('UNEXPECTED_STATE');
            valid('context.json', ContextSchema);
        });
        if (task === 'T3') {
            await phase('prepareReview', async () => {
                const correlation = { schema_version: 1, task_id: taskId, expected_baseline: snapshot.identity };
                writeJson(path.join(runDir, 'spec.json'), SpecSchema.parse({ ...correlation,
                    goal: 'Add an Array.isArray guard to activeIds using the fixed patch in request.md',
                    allowed_files: ['lib/util.js'], deny_patterns: [], risk_flags: [],
                    context_files: [path.relative(repoRoot, path.join(runDir, 'request.md')).split(path.sep).join('/')],
                    validation_commands: [{ program: 'node', args: ['--test', 'test/smoke.test.js'], cwd: '.' }],
                    permission_authority: 'dual-init-dangerous-auto-v1' }));
                writeJson(path.join(runDir, 'evidence.json'), EvidenceSchema.parse({ ...correlation,
                    status: 'SUCCESS', modified_files: ['lib/util.js'], command_outputs: [],
                    unverified_items: ['Tests not executed; patch prepared by benchmark harness'],
                    self_review: { checks: ['Harness prepared fixed patch', 'Only lib/util.js targeted', 'No worker implementation measured'],
                        remaining_risks: ['Behavior requires independent review'] } }));
                fs.writeFileSync(path.join(repoRoot, 'lib/util.js'), FIXTURE['lib/util.js'].replace('    return xs.filter', GUARD + '    return xs.filter'));
                // Controller scaffolding only; never substitutes scout/review payloads.
                const store = createStateStore(runDir, { taskId, expectedBaseline: snapshot.identity });
                for (const [name, from, to] of [['spec', 'SCOUT_VALID', 'SPEC_VALID'], ['route', 'SPEC_VALID', 'ROUTED'],
                    ['implement', 'ROUTED', 'IMPLEMENT_VALID'], ['scope', 'IMPLEMENT_VALID', 'SCOPE_VALID']]) {
                    store.append({ type: 'phase.started', phase: name, attempt: 1 });
                    store.append({ type: 'phase.completed', phase: name, attempt: 1,
                        from_state: from, to_state: to, artifact_hashes: {} });
                }
            });
            await phase('review', async () => {
                if ((await orch.runPhase('review', taskId)).state !== 'CODEX_QC') throw failure('UNEXPECTED_STATE');
                valid('review.json', ReviewSchema);
            });
        }
        result.payloadValid = true;
        result.continuity = mode === 'OLD' || (sessions.length === (task === 'T3' ? 2 : 1)
            && sessions.every(session => session === sessions[0]));
        result.ok = true;
    } catch (error) {
        result.errorCode = codeOf(error);
        result.diagnostics = { ...result.diagnostics, errorCode: result.errorCode, errorMessage: error.message };
    } finally {
        try { if (host) await host.closeAll(); }
        catch (error) { result.ok = false; result.errorCode ||= codeOf(error); result.stage = 'closeHost'; }
        if (mode === 'OLD' && fs.existsSync(path.join(runDir, 'raw'))) {
            for (const file of fs.readdirSync(path.join(runDir, 'raw')).filter(file => file.endsWith('.stdout.json'))) {
                usage.push(...tokenFields(fs.readFileSync(path.join(runDir, 'raw', file), 'utf8'), file));
            }
        }
        result.tokens = usage.length ? { coverage: 'partial', observations: usage, aggregation: 'none; may be cumulative' } : 'unavailable';
        send();
    }
    return result;
}

async function evidence(root, mode) {
    if (mode === 'OLD') {
        // Parent also reads completed attempts after a hard timeout kills the worker.
        const usage = [];
        const runsDir = path.join(root, 'workspace/.omni/codex-gemini/runs');
        for (const task of fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []) {
            const rawDir = path.join(runsDir, task, 'raw');
            for (const file of fs.existsSync(rawDir) ? fs.readdirSync(rawDir) : []) {
                if (file.endsWith('.stdout.json')) usage.push(...tokenFields(fs.readFileSync(path.join(rawDir, file), 'utf8'), file));
            }
        }
        return { nudges: 'unavailable', repairs: 'unavailable', unresolvedOutcomeUnknown: 0,
            duplicateDispatch: 'unavailable', manualRecovery: 0, evidenceAvailable: true,
            tokens: usage.length ? { coverage: 'partial', observations: usage, aggregation: 'none; may be cumulative' } : 'unavailable' };
    }
    const { inspectJournal } = require('../lib/dual/discussion/journal');
    const result = { nudges: 0, repairs: [], unresolvedOutcomeUnknown: 0, duplicateDispatch: 0,
        manualRecovery: 0, evidenceAvailable: true };
    try {
        const dir = path.join(root, 'discussion');
        for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
            const journal = await inspectJournal({ stateDir: path.join(dir, name) });
            const events = journal.events.map(record => record.event);
            result.unresolvedOutcomeUnknown += journal.unresolvedInvocations.length;
            for (const event of events.filter(event => event.type === 'observation')) {
                const ref = event.evidence_ref || '';
                if (ref.includes('+nudge')) result.nudges++;
                const repair = ref.match(/payload-repair=([a-z_]+(?:\+(?:fence|body_object|bare_object))*)/);
                if (repair) result.repairs.push({ invocationId: event.invocation_id, type: repair[1] });
            }
            const counts = new Map();
            for (const event of events.filter(event => event.type === 'dispatch_intent')) {
                counts.set(event.message_id, (counts.get(event.message_id) || 0) + 1);
            }
            result.duplicateDispatch += [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
        }
    } catch (error) {
        result.evidenceAvailable = false;
        result.evidenceErrorCode = codeOf(error);
        result.unresolvedOutcomeUnknown = 'unavailable';
        result.nudges = 'unavailable';
        result.repairs = 'unavailable';
    }
    return result;
}

// Read diagnostics in the parent, including when the worker was killed, before cleanup.
async function diagnostics(root, task, result, mode) {
    const details = { ...result.diagnostics };
    if (!result.ok) {
        const rawDir = path.join(root, 'workspace/.omni/codex-gemini/runs', 'BENCH-' + task, 'raw');
        const files = fs.existsSync(rawDir) ? fs.readdirSync(rawDir)
            .filter(file => file.endsWith('.failure.json')) : [];
        const artifacts = [];
        for (const file of files) {
            try {
                const artifact = JSON.parse(fs.readFileSync(path.join(rawDir, file), 'utf8'));
                artifacts.push({ file, ...artifact });
            } catch (error) {
                details.artifactReadError = { errorCode: codeOf(error), errorMessage: error.message };
            }
        }
        artifacts.sort((a, b) => Number(a.phase === result.stage) - Number(b.phase === result.stage)
            || a.attempt - b.attempt);
        const artifact = artifacts.at(-1);
        if (artifact) {
            details.artifact = path.join('raw', artifact.file);
            for (const field of ['rawReplyExcerpt', 'validationIssues', 'repairKind', 'nudged',
                'discussionCorrection', 'discussionRecovery', 'recoveryError', 'recoveryOutcome']) {
                if (artifact[field] !== undefined) details[field] = artifact[field];
            }
            details.errorCode = artifact.error_code ?? result.errorCode;
            details.errorMessage = artifact.reason ?? details.errorMessage ?? result.errorCode;
        } else {
            details.artifact = 'missing';
            details.errorCode = result.errorCode;
            details.errorMessage ||= result.errorCode;
        }
    }
    try {
        const { inspectJournal } = require('../lib/dual/discussion/journal');
        const dir = path.join(root, 'discussion');
        const trail = [];
        const recoveryAttempts = [];
        if (mode === 'NEW' && !fs.existsSync(dir)) throw failure('JOURNAL_UNAVAILABLE');
        for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
            const stateDir = path.join(dir, name);
            if (!fs.existsSync(path.join(stateDir, 'journal.jsonl'))) throw failure('JOURNAL_UNAVAILABLE');
            const journal = await inspectJournal({ stateDir });
            const events = journal.events.map(record => record.event);
            // Only journaled reconciliations are observable; rejected calls leave no event.
            const sessionAttempts = events.filter(event => event.type === 'reconciled').map(event => ({
                invocationId: event.invocation_id, messageId: event.message_id,
                reconcileAttempted: true, settledOutcome: event.provider_outcome ?? null,
                recoveryEvidenceProbes: { supplied: [], results: 'unavailable' },
            }));
            recoveryAttempts.push(...sessionAttempts);
            for (const unknown of events.filter(event => event.type === 'outcome_unknown')) {
                const settled = events.find(event => event.type === 'reconciled'
                    && event.invocation_id === unknown.invocation_id);
                const attempts = sessionAttempts.filter(attempt => attempt.messageId === unknown.message_id
                    && attempt.invocationId === unknown.invocation_id);
                trail.push({ invocationId: unknown.invocation_id, messageId: unknown.message_id,
                    reconcileAttempted: Boolean(settled) || attempts.length > 0,
                    settledOutcome: settled?.provider_outcome ?? null,
                    recoveryEvidenceProbes: { supplied: [], results: 'unavailable' },
                    attempts });
            }
        }
        if (mode === 'NEW') details.recoveryAttempts = recoveryAttempts;
        if (trail.length) details.recoveryTrail = trail;
    } catch (error) {
        if (mode === 'NEW') details.recoveryAttempts = 'unavailable';
        details.journalReadError = { errorCode: codeOf(error), errorMessage: error.message };
    }
    return Object.keys(details).length ? details : undefined;
}

// Product cold-start runner detaches its own process group. Kill descendants too.
function stopTree(child) {
    try {
        const rows = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 1000 })
            .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
        const ids = new Set([child.pid]);
        let added;
        do { added = false; for (const [pid, ppid] of rows) if (ids.has(ppid) && !ids.has(pid)) { ids.add(pid); added = true; } } while (added);
        for (const pid of [...ids].reverse()) {
            try { process.kill(-pid, 'SIGKILL'); } catch { /* may not lead a group */ }
            try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
        }
    } catch { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}

async function runOne(config) {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    let latest = blank(config.task);
    let activePhase = null;
    let phaseStart = start;
    let timedOut = false;
    const child = fork(__filename, ['--benchmark-worker'], { detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, PATH: path.join(os.homedir(), '.local/bin') + path.delimiter + (process.env.PATH || '') } });
    const result = await new Promise(resolve => {
        const timer = setTimeout(() => { timedOut = true; stopTree(child); }, DEADLINE_MS);
        child.on('message', message => {
            if (message.result) {
                latest = message.result;
                const phase = Object.entries(latest.phases).find(([, entry]) => entry.errorCode === 'NOT_RUN');
                if (phase && phase[0] !== activePhase) { activePhase = phase[0]; phaseStart = performance.now(); }
            }
        });
        child.on('error', error => { latest.errorCode = codeOf(error); });
        child.on('close', code => {
            clearTimeout(timer);
            if (timedOut) {
                latest.ok = false; latest.errorCode = 'TIMEOUT';
                if (activePhase && latest.phases[activePhase].errorCode === 'NOT_RUN') {
                    latest.phases[activePhase] = { wallMs: performance.now() - phaseStart, ok: false, errorCode: 'TIMEOUT' };
                }
            } else if (code !== 0 || !latest.ok) {
                latest.ok = false; latest.errorCode ||= 'WORKER_EXIT';
            }
            resolve(latest);
        });
        child.send(config);
    });
    const wallMs = performance.now() - start;
    const runDiagnostics = await diagnostics(config.root, config.task, result, config.mode);
    return { task: config.task, pair: config.pair, order: config.order, mode: config.mode, startedAt,
        wallMs, ...result, ...await evidence(config.root, config.mode),
        ...(runDiagnostics ? { diagnostics: runDiagnostics } : {}), cost: 'unavailable' };
}

function summarize(runs) {
    const stats = mode => {
        const rows = runs.filter(run => run.mode === mode);
        const values = rows.map(run => run.wallMs).sort((a, b) => a - b);
        const n = values.length;
        return { count: n, completed: rows.filter(run => run.ok).length,
            completionRate: n ? rows.filter(run => run.ok).length / n : null,
            p50WallMs: n ? (values[Math.floor((n - 1) / 2)] + values[Math.floor(n / 2)]) / 2 : null,
            p95WallMs: n ? values[Math.ceil(0.95 * n) - 1] : null };
    };
    const old = stats('OLD'); const next = stats('NEW');
    const fresh = runs.filter(run => run.mode === 'NEW');
    const complete = runs.length === 18;
    const evidenceAvailable = fresh.every(run => run.evidenceAvailable);
    const gates = {
        completion: old.count > 0 && next.count > 0 && next.completionRate >= old.completionRate,
        payload: next.completed > 0 && fresh.filter(run => run.ok).every(run => run.payloadValid),
        wallTime: old.count > 0 && next.count > 0 && next.p50WallMs <= 1.30 * old.p50WallMs,
        outcomeUnknown: evidenceAvailable && fresh.length > 0 && fresh.every(run => run.unresolvedOutcomeUnknown === 0),
    };
    const reasons = Object.entries(gates).filter(([, pass]) => !pass).map(([gate]) => gate);
    if (!complete) reasons.push('incomplete_sample');
    if (!evidenceAvailable) reasons.push('evidence_unavailable');
    return { complete, provisional: !complete, OLD: old, NEW: next, gates, reasons,
        newValidCompletedPayloads: fresh.filter(run => run.ok && run.payloadValid).length,
        newContinuityFailures: fresh.filter(run => run.ok && !run.continuity).length,
        newUnresolvedOutcomeUnknown: evidenceAvailable
            ? fresh.reduce((sum, run) => sum + run.unresolvedOutcomeUnknown, 0) : 'unavailable',
        newDuplicateDispatch: evidenceAvailable
            ? fresh.reduce((sum, run) => sum + run.duplicateDispatch, 0) : 'unavailable',
        manualRecovery: 0,
        recommendation: complete && reasons.length === 0 ? 'flip_daemon_default' : 'keep_opt_in', cli: 'keep_opt_in' };
}

async function main() {
    const args = process.argv.slice(2);
    const modesArgs = args.filter(arg => arg.startsWith('--modes='));
    for (const arg of modesArgs) {
        for (const mode of arg.slice('--modes='.length).split(/[,/]/)) rejectRetiredMode(mode.trim());
    }
    // The historical default is an OLD/NEW pair. Reject it before reserving output
    // or spawning a worker; NEW remains available only when explicitly selected.
    if (process.env.OMNI_DUAL_LIVE === '1' && args[0] !== '--benchmark-worker' && modesArgs.length === 0) rejectRetiredMode('OLD');
    if (process.env.OMNI_DUAL_LIVE !== '1') {
        console.log('Chạy benchmark live: OMNI_DUAL_LIVE=1 node test/dual-phase2-benchmark.js <output-json-path> --modes=NEW');
        return;
    }
    if (process.argv[2] === '--benchmark-worker') {
        process.once('message', async config => {
            try { await worker(config); process.exitCode = 0; }
            catch (error) { process.send({ result: { ...blank(config.task), errorCode: codeOf(error) } }); process.exitCode = 1; }
            finally { process.disconnect(); }
        });
        return;
    }
    const modesArg = args.find(arg => arg.startsWith('--modes='));
    const modesFilter = modesArg?.slice('--modes='.length);
    if (modesArg && !['NEW', 'OLD'].includes(modesFilter)) throw failure('INVALID_MODES_FILTER');
    const outputArgs = args.filter(arg => !arg.startsWith('--modes='));
    if (outputArgs.length !== 1) throw failure('OUTPUT_PATH_REQUIRED');
    const outputPath = outputArgs[0].startsWith('--out=') ? outputArgs[0].slice('--out='.length) : outputArgs[0];
    if (!outputPath) throw failure('OUTPUT_PATH_REQUIRED');
    const output = path.resolve(outputPath);
    // Reserve a fresh destination. Never destroy an earlier experiment.
    const fd = fs.openSync(output, 'wx', 0o600);
    fs.closeSync(fd);
    const document = { protocol: PROTOCOL, runs: [], summary: summarize([]),
        environment: { node: process.version, platform: process.platform, models: MODELS, deadlineMs: DEADLINE_MS } };
    const save = () => {
        if (modesFilter) document.summary.modesFilter = modesFilter;
        const temporary = output + '.' + process.pid + '.tmp';
        writeJson(temporary, document);
        fs.renameSync(temporary, output);
    };
    save();
    for (const task of ['T1', 'T2', 'T3']) {
        for (let pair = 1; pair <= 3; pair++) {
            const modes = pair % 2 ? ['OLD', 'NEW'] : ['NEW', 'OLD'];
            for (const [index, mode] of modes.entries()) {
                if (modesFilter && mode !== modesFilter) continue;
                const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-phase2-bench-'));
                console.error(`[${task} pair=${pair} order=${index + 1} ${mode}] started`);
                try {
                    const run = await runOne({ task, pair, order: index + 1, mode, root });
                    document.runs.push(run);
                    document.summary = summarize(document.runs);
                    save();
                    console.error(`[${task} pair=${pair} ${mode}] ${run.ok ? 'OK' : run.errorCode} wallMs=${Math.round(run.wallMs)}`);
                } finally {
                    if (process.env.KEEP_WORKSPACES === '1') console.error(`Kept workspace: ${root}`);
                    else fs.rmSync(root, { recursive: true, force: true });
                }
            }
        }
    }
}

main().catch(error => { console.error(`Benchmark stopped: ${codeOf(error)}${error.code === 'BENCHMARK_OLD_RETIRED' ? ': ' + error.message : ''}`); process.exitCode = 1; });
