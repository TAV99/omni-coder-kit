#!/usr/bin/env node
'use strict';

// Standalone opt-in script. Never imported by the node:test suites.
// Relay-ceiling part 2: live E2E on a REAL daemon from this worktree.
// Scope is deliberately bounded: session -> plan -> resume -> worker
// phases up to the REVIEW verdict. Codex QC after review is OUT of scope
// for this run (it is covered by test/dual-daemon-fullcycle-live.js).
// The fixture task makes the AGY worker create ten new lookup-table
// modules; the review diff is whatever the worker actually produced, so
// the pass bar is: review completes, its chunk manifest has >= 13 chunks
// (the old ceiling of 12 would have failed at chunk 13), and
// chunks + 1 shared scout turn fits the new ceiling of 24.
// All authority state changes go through the daemon client API only;
// authority-store reads below are read-only observation, never writes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const DEADLINE_MS = 3000000;
const TASK_ID = 'TASK-RELAY-CEILING-LIVE';
const MODEL = 'gemini-3.8-flash-high';
const failure = (code, message = code) => Object.assign(new Error(message), { code });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function records(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).filter(Boolean).map(JSON.parse);
}
function check(value, code, message) { if (!value) throw failure(code, message); }
function stopTree(child) {
    if (!child?.pid) return;
    const ids = new Set([child.pid]);
    try {
        const rows = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 1000 })
            .trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
        let added;
        do { added = false; for (const [pid, ppid] of rows) if (ids.has(ppid) && !ids.has(pid)) { ids.add(pid); added = true; } } while (added);
    } catch { /* Still kill the known daemon process/group. */ }
    for (const pid of [...ids].reverse()) {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* Not a group leader. */ }
        try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
}

async function main() {
    if (process.env.OMNI_DUAL_LIVE !== '1') {
        console.log('Usage: OMNI_DUAL_LIVE=1 node test/dual-relay-ceiling-live.js <report-json-path>');
        return;
    }
    check(process.argv.length === 3 && !process.argv[2].startsWith('--'), 'REPORT_PATH_REQUIRED');
    const output = path.resolve(process.argv[2]);
    fs.closeSync(fs.openSync(output, 'wx', 0o600));
    const started = Date.now();
    const deadline = started + DEADLINE_MS;
    const names = ['setup', 'binaryPreflight', 'daemonListened', 'sessionBegun', 'planRegistered',
        'taskStarted', 'reviewVerdict', 'finalEvidence', 'daemonShutdown'];
    const report = { protocol: 'dual-relay-ceiling-live-v1', startedAt: new Date(started).toISOString(),
        ok: false, errorCode: null, errorMessage: null, failedStage: null,
        deadlineMs: DEADLINE_MS, taskId: TASK_ID, phasesExecuted: [], phasesCompleted: [],
        executionScope: 'daemon session -> plan -> resume -> worker phases up to review verdict, with controller context replies via task.reply + session.resume when the worker parks with questions; Codex QC out of scope',
        environment: { node: process.version, agyCommand: 'agy', codexCommand: '/usr/bin/codex',
            workerModel: MODEL, workerEffort: 'high', discussionEnabledEnv: 'unset' },
        stages: Object.fromEntries(names.map(name => [name,
            { ok: false, wallMs: 0, errorCode: 'NOT_RUN', errorMessage: 'Stage has not run' }])) };
    const save = () => {
        const temp = `${output}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(temp, output);
    };
    let child, client, exited, childError, exitResult, root, runDir, authority, daemonEnv;
    report.phaseTimestamps = {};
    let activeStage = 'setup';
    let forceTimer;
    const rememberError = (name, error) => {
        if (report.failedStage) return;
        report.failedStage = name;
        report.errorCode = error.code || 'LIVE_ERROR';
        report.errorMessage = require('../lib/dual/validator-security').redactDiagnostic(error.message);
    };
    async function stage(name, timeoutMs, action) {
        activeStage = name;
        const time = Date.now();
        console.error(`[${name}] started`);
        const limit = Math.max(1, Math.min(timeoutMs, deadline - Date.now()
            - (name === 'daemonShutdown' ? 0 : 15000)));
        let timer;
        const controller = new AbortController();
        try {
            const result = await Promise.race([action(limit, controller.signal), new Promise((_, reject) => {
                timer = setTimeout(() => reject(failure('STAGE_TIMEOUT', `${name} exceeded ${limit}ms`)), limit);
            })]);
            report.stages[name] = { ok: true, errorCode: null, errorMessage: null, wallMs: Date.now() - time };
            console.error(`[${name}] OK`);
            return result;
        } catch (error) {
            rememberError(name, error);
            report.stages[name] = { ok: false, errorCode: error.code || 'LIVE_ERROR',
                errorMessage: require('../lib/dual/validator-security').redactDiagnostic(error.message),
                wallMs: Date.now() - time };
            console.error(`[${name}] ${report.stages[name].errorCode}`);
            throw error;
        } finally { controller.abort(); clearTimeout(timer); save(); }
    }
    const taskEvents = () => runDir ? records(path.join(runDir, 'events.ndjson')) : [];
    function observe() {
        const task = authority?.derive().tasks[TASK_ID];
        if (task?.isolatedWorkspace && task.isolatedWorkspace.reference?.bindingSha256 !== report.workerBindingSha256) {
            const { workerRoot } = require('../lib/dual/task-workspace').readTaskBinding(root, task.isolatedWorkspace.reference);
            runDir = path.join(workerRoot, '.omni/codex-gemini/runs', TASK_ID);
            report.workerRoot = workerRoot;
            report.workerBindingSha256 = task.isolatedWorkspace.reference.bindingSha256;
        }
        for (const event of taskEvents()) {
            if (!['phase.started', 'phase.completed'].includes(event.type)) continue;
            const key = `${event.phase}:${event.type}`;
            report.phaseTimestamps[key] ||= { observedAt: new Date().toISOString(), event };
        }
        return task;
    }
    async function poll(predicate, limit, signal) {
        const until = Date.now() + limit;
        while (Date.now() < until && !signal.aborted) {
            if (childError) throw childError;
            if (exitResult) throw failure('DAEMON_EXIT', JSON.stringify(exitResult));
            const task = authority ? observe() : undefined;
            if (await predicate(task)) return;
            const failed = taskEvents().find(event => event.type === 'phase.failed');
            if (failed) { report.taskFailure = failed; throw failure(failed.error_code || 'TASK_PHASE_FAILED'); }
            await pause(5000);
        }
        throw failure('STAGE_TIMEOUT', 'Evidence deadline reached');
    }
    save();
    const heartbeat = setInterval(() => {
        console.error(`[${activeStage}] elapsed ${Math.round((Date.now() - started) / 1000)}s`);
        try { if (authority) observe(); save(); } catch { /* Stage polling reports evidence errors. */ }
    }, 30000);
    const allowed = Array.from({ length: 10 }, (_, i) => `src/tables/table${i}.js`);
    const goal = 'Create ten lookup-table modules under src/tables/, one per catalogue section (electronics, furniture, clothing, books, toys, sports, kitchen, garden, automotive and health), each exporting a frozen array of EXACTLY 55 catalogue records with stable numeric ids, human-readable names and decimal prices, plus a byId lookup helper that returns the matching record or undefined. Every record line uses the same field order (id, name, price) so downstream code can parse the tables without a schema change, every module keeps its own section header comment at the top of the file, and every price is a non-negative number with at most two decimal places. The modules must not import each other, must not touch any file outside src/tables/, and must pass node --check for every file. Record names must be unique within a module, ids must start at zero and increase by one without gaps, and the byId helper must not throw for an unknown id. Count the records in each module before finishing; any count other than 55 is not complete. Pinned decisions: (1) CommonJS only, module.exports = { records, byId }; (2) freeze the array only with Object.freeze, never freeze individual records; (3) the array export is the NAMED export records, no default export; (4) byId is exactly records.find((record) => record.id === id), a separate export alongside records and not a property on the array, returning the record or undefined, never throwing, no Map; (5) EXACTLY 55 records per module.';
    try {
        await stage('setup', 10000, async () => {
            root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'omni-relay-ceiling-live-')), 'workspace');
            fs.mkdirSync(root);
            report.workspaceRoot = root;
            runDir = path.join(root, '.omni/codex-gemini/runs', TASK_ID);
            const { buildCodexConfig, buildCodexHooks } = require('../lib/init');
            const opts = { dualPair: 'codex-agy', mode: 'auto', projectDir: root };
            const plan = `# Relay-ceiling live fixture\n\n${goal}\n\nSection order: electronics (table0), furniture (table1), clothing (table2), books (table3), toys (table4), sports (table5), kitchen (table6), garden (table7), automotive (table8), health (table9). Each module is a new file under src/tables/, named exactly src/tables/tableN.js for N 0 to 9, and no other file is created or touched.\n\nExact module shape (the only shape a module may take):\n\n// Section: <section>\nconst records = Object.freeze([\n  { id: 0, name: "...", price: 0.00 },\n  { id: 1, name: "...", price: 0.00 },\n]);\nfunction byId(id) {\n  return records.find((record) => record.id === id);\n}\nmodule.exports = {\n  records,\n  byId,\n};\n\nDecisions already fixed in this plan, so they are not open questions: CommonJS (module.exports = { records, byId }); freeze the array only, never the individual records; the array export is named records, never a default export; byId is implemented with Array.find, returns the record or undefined, and never throws; exactly 55 records per module; record fields are exactly id, name, price in that order with no extra fields; names are invented, unique within a module only; prices are plain numbers, non-negative, at most two decimal places, with no range and no currency; no imports, no Map, no barrel file, no shared helper, no extra top-level bindings.\n\nVerification before finishing: run node --check src/tables/tableN.js from the workspace root for each N from 0 to 9, fix any failure before finishing, and verify records.length is 55 in every module.\n`;
            const fixture = {
                'README.md': '# Relay-ceiling live fixture\nTen lookup-table modules under src/tables/. Run node --check on each module.\n',
                'plans/plan.md': plan,
                '.codex/config.toml': buildCodexConfig('dual', true, opts),
                '.codex/hooks.json': buildCodexHooks('dual', true, opts),
                '.omni/manifest.json': JSON.stringify({ workerModel: MODEL, workerEffort: 'high' }),
            };
            for (const [file, content] of Object.entries(fixture)) {
                fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
                fs.writeFileSync(path.join(root, file), content);
            }
            report.planSha256 = createHash('sha256').update(plan).digest('hex');
        });
        await stage('binaryPreflight', 10000, async () => {
            daemonEnv = { ...process.env,
                PATH: [path.join(os.homedir(), '.local/bin'), '/usr/bin', '/usr/local/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
                OMNI_DUAL_WORKER_MODEL: MODEL, OMNI_DUAL_WORKER_EFFORT: 'high' };
            delete daemonEnv.OMNI_DUAL_DISCUSSION_ENABLED;
            const binary = daemonEnv.PATH.split(path.delimiter).map(dir => path.join(dir, 'codex')).find(file => {
                try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
            });
            check(binary && fs.realpathSync(binary) === fs.realpathSync('/usr/bin/codex'), 'CODEX_NOT_NPM');
            const version = execFileSync(binary, ['--version'], { env: daemonEnv, encoding: 'utf8', timeout: 5000 }).trim();
            report.binary = { path: binary, realpath: fs.realpathSync(binary), version };
            check(version === 'codex-cli 0.164.0', 'CODEX_NOT_NPM', version);
            const agy = path.join(os.homedir(), '.local/bin/agy');
            check(fs.existsSync(agy), 'AGY_MISSING');
            report.agy = agy;
        });
        await stage('daemonListened', 15000, async (limit, signal) => {
            report.daemonLog = path.join(path.dirname(root), 'daemon.log');
            const log = fs.openSync(report.daemonLog, 'wx', 0o600);
            try {
                child = spawn(process.execPath, [path.resolve(__dirname, '../bin/omni-daemon.js'), '--workspace', root],
                    { env: daemonEnv, detached: true, stdio: ['ignore', log, log] });
            } finally { fs.closeSync(log); }
            exited = new Promise(resolve => child.once('close', (code, signal) => {
                exitResult = { code, signal }; resolve(exitResult);
            }));
            child.on('error', error => { childError = error; });
            forceTimer = setTimeout(() => stopTree(child), Math.max(1, deadline - Date.now()));
            client = require('../lib/dual/daemon-client').createDaemonClient({ workspaceRoot: root, timeoutMs: 5000 });
            await poll(() => {
                try { report.daemon = client.readDiscovery(); return true; }
                catch (error) { if (error.code !== 'DUAL_DISCOVERY_MISSING') throw error; return false; }
            }, limit, signal);
            check((await client.health()).status === 'healthy', 'DAEMON_UNHEALTHY');
            authority = require('../lib/dual/authority-store').createAuthorityStore(path.join(root, '.omni/runs/dual-authority'));
        });
        await stage('sessionBegun', 15000, async limit => {
            const result = await client.beginSession({ workspace_root: root, mode: 'auto' }, { timeoutMs: limit });
            check(result.session_id, 'SESSION_ID_MISSING');
            report.sessionId = result.session_id;
            report.baseline = result.expected_baseline;
        });
        await stage('planRegistered', 60000, async limit => {
            const result = await client.registerPlan(report.sessionId, {
                plan_path: 'plans/plan.md', plan_sha256: report.planSha256, plan_revision: 1,
                acceptance_policy: { protocol_version: 1, checks: [], ui: { required: false,
                    viewport_widths: [390, 768, 1024, 1440], reduced_motion_required: true } },
                tasks: [{ task_id: TASK_ID, title: 'Create ten lookup-table modules with exactly 55 records each under src/tables/.',
                    owner: 'agy', execution_mode: 'isolated', model: MODEL, effort: 'high',
                    goal, risk: 'low', complexity: 'medium', category: 'feature',
                    allowed_files: allowed, deny_patterns: [],
                    context_files: ['README.md', 'plans/plan.md'],
                    validation_commands: allowed.map(file => ({ program: 'node', args: ['--check', file], cwd: '.' })) }],
            }, { timeoutMs: limit });
            check(result.registered === true, 'PLAN_NOT_REGISTERED');
            check(result.tasks.find(task => task.task_id === TASK_ID)?.owner === 'agy', 'TASK_NOT_AGY_OWNED');
        });
        await stage('taskStarted', 10000, async limit => {
            check((await client.resumeSession(report.sessionId, { timeoutMs: limit })).resumed === true, 'TASK_NOT_RESUMED');
        });
        await stage('reviewVerdict', 2400000, async (limit, signal) => {
            // The worker parks after scout with context questions (lease
            // released, task.questions event). The controller answers them
            // through the daemon API only, then resumes; reply-before-resume
            // is the established rule, and an unmapped question fails closed
            // instead of inventing a controller decision.
            const decideReply = (question) => {
                if (question.body.includes('CommonJS')) {
                    return `Decision: confirmed, CommonJS (module.exports = { records, byId }) is the module export system and satisfies node --check with no package.json type module. Source file/section: plans/plan.md module export and validation. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                if (question.body.includes('mapping order')) {
                    return `Decision: confirmed, section mapping is table0=electronics, table1=furniture, table2=clothing, table3=books, table4=toys, table5=sports, table6=kitchen, table7=garden, table8=automotive, table9=health. Source file/section: plans/plan.md section order. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                if (question.body.includes('deeply frozen') || question.body.includes('deep-freeze')
                    || question.body.includes('deep freeze') || question.body.includes('freeze individual')
                    || question.body.includes('freeze each record')) {
                    return `Decision: confirmed, do NOT deep-freeze individual record objects; only freeze the array itself, as plans/plan.md says "frozen array". This is a fixture scaffolding question, not a product decision, and it does not change the chunk/ceiling conclusion under test. Source file/section: plans/plan.md frozen array. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                if (question.body.includes('default export') || question.body.includes('named records')
                    || question.body.includes('export should be named') || question.body.includes('export be named')
                    || question.body.includes('named export')) {
                    return `Decision: confirmed, the frozen array export is the NAMED export records, via module.exports = { records, byId }; there is no default export and no other exported key. Source file/section: plans/plan.md module export. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                if (question.body.includes('byId') || question.body.includes('Map')
                    || question.body.includes('lookup helper')) {
                    return `Decision: confirmed, byId is exactly function byId(id) { return records.find((record) => record.id === id); }; it returns the record object itself or undefined, never throws for any input, uses no Map, and is a separate named export alongside records, NOT a property on the array. Source file/section: plans/plan.md byId. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                if (question.body.includes('55') || question.body.includes('how many records')
                    || question.body.includes('record count') || question.body.includes('number of records')) {
                    return `Decision: confirmed, EXACTLY 55 records per module; any other count is not complete. Source file/section: plans/plan.md record count. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                if (question.body.includes('field') || question.body.includes('record shape')
                    || question.body.includes('record format')) {
                    return `Decision: confirmed, each record has exactly three fields in this order and no extra fields: id, name, price, one object literal per line. Source file/section: plans/plan.md record fields. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                if (question.body.includes('price')) {
                    return `Decision: confirmed, prices are plain number literals, never strings, non-negative with at most two decimal places, any value the worker chooses; zero is allowed, there is no price range and no currency symbol, field, or code. Source file/section: plans/plan.md prices. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                // P1 fix: the file-name branch must precede the broad 'name'
                // branch — every "file name(s)" question contains "name", so
                // in the old order it was unreachable and received the wrong
                // record-name answer. The broad 'name' branch stays as the
                // fallback for generic/record-name questions (e.g. uniqueness).
                if (question.body.includes('file name')) {
                    return `Decision: confirmed, files are named exactly src/tables/tableN.js for N 0 to 9, and no other file is created or touched. Source file/section: plans/plan.md files. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                if (question.body.includes('name')) {
                    return `Decision: confirmed, names are invented human-readable catalogue product names with no external catalogue to match, unique within a module only, so the same name in two different modules is allowed. Source file/section: plans/plan.md names. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                if (question.body.includes('header') || question.body.includes('comment')) {
                    return `Decision: confirmed, the first line of each file is the section header comment // Section: <section> with the section name in lowercase. Source file/section: plans/plan.md header comment. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                if (question.body.includes('import') || question.body.includes('require')
                    || question.body.includes('barrel') || question.body.includes('index.js')
                    || question.body.includes('shared helper') || question.body.includes('helper module')) {
                    return `Decision: confirmed, no imports, no require calls, no index.js barrel file, no shared helper module, no package.json change, and no file created or touched outside src/tables/. Source file/section: plans/plan.md files. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                if (question.body.includes('sort') || question.body.includes('ascending')
                    || question.body.includes('record order')) {
                    return `Decision: confirmed, records are in ascending id order, integers 0 through 54 with no gaps and no repeats. Source file/section: plans/plan.md ids. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                if (question.body.includes('currency')) {
                    return `Decision: confirmed, prices are bare numbers with no currency symbol, field, or code. Source file/section: plans/plan.md prices. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                if (question.body.includes('strict')) {
                    return `Decision: confirmed, no use strict directive is required; the header comment stays the first line. Source file/section: plans/plan.md formatting. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                if (question.body.includes('frozen') || question.body.includes('freeze')) {
                    return `Decision: confirmed, freeze the array only via const records = Object.freeze([...]); never freeze individual records. Source file/section: plans/plan.md frozen array. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                if (question.body.includes('node --check') || question.body.includes('validation')
                    || question.body.includes('verify')) {
                    return `Decision: confirmed, before finishing run node --check src/tables/tableN.js from the workspace root for each N from 0 to 9, fix any failure before finishing, and verify records.length is 55 in every module. Source file/section: plans/plan.md verification. Question ID: ${question.message_id}. Plan revision: 1.`;
                }
                return null;
            };
            report.controllerReplyRounds = [];
            const until = Date.now() + limit;
            let rounds = 0;
            while (Date.now() < until && !signal.aborted) {
                if (childError) throw childError;
                if (exitResult) throw failure('DAEMON_EXIT', JSON.stringify(exitResult));
                observe();
                if (taskEvents().some(event => event.type === 'phase.completed' && event.phase === 'review')) {
                    report.reviewCompletedAt = new Date().toISOString();
                    return;
                }
                const failed = taskEvents().find(event => event.type === 'phase.failed');
                if (failed) { report.taskFailure = failed; throw failure(failed.error_code || 'TASK_PHASE_FAILED'); }
                const derived = authority.derive();
                const task = derived.tasks[TASK_ID];
                const activeLease = Object.values(derived.leases || {})
                    .some(lease => (lease.taskId || lease.task_id) === TASK_ID && lease.status === 'active');
                if (!activeLease && Array.isArray(task?.messages)) {
                    const replied = new Set(task.messages.filter(m => m.kind === 'reply').map(m => m.reply_to));
                    const unanswered = task.messages.filter(m => m.kind === 'question' && !replied.has(m.message_id));
                    if (unanswered.length) {
                        if (++rounds > 5) throw failure('CONTROLLER_REPLY_ROUNDS_EXCEEDED');
                        const round = { at: new Date().toISOString(),
                            questions: unanswered.map(q => q.body), replies: [] };
                        for (const question of unanswered) {
                            const body = decideReply(question);
                            if (!body) {
                                report.unknownControllerQuestion = question.body;
                                throw failure('CONTROLLER_QUESTION_UNKNOWN',
                                    `No controller decision mapped for question: ${question.body}`);
                            }
                            const result = await client.replyToTask(report.sessionId,
                                { task_id: TASK_ID, plan_revision: 1,
                                    message_id: `reply-${question.message_id.slice(2, 10)}-${rounds}`,
                                    reply_to: question.message_id, body }, { timeoutMs: 15000 });
                            round.replies.push({ question_id: question.message_id, reused: result.reused });
                        }
                        report.controllerReplyRounds.push(round);
                        save();
                        const resumed = await client.resumeSession(report.sessionId, { timeoutMs: 10000 });
                        check(resumed.resumed === true, 'TASK_NOT_RESUMED_AFTER_REPLY');
                        round.resumed = true;
                        save();
                    }
                }
                await pause(5000);
            }
            throw failure('STAGE_TIMEOUT', 'Evidence deadline reached');
        });
        await stage('finalEvidence', 15000, async () => {
            observe();
            for (const phase of ['scout', 'implement', 'review']) {
                check(taskEvents().some(event => event.type === 'phase.completed' && event.phase === phase), 'PHASE_MISSING', phase);
            }
            const review = json(path.join(runDir, 'review.json'));
            report.reviewVerdict = { recommendation: review.recommendation, risk_level: review.risk_level,
                findings: Array.isArray(review.findings) ? review.findings.length : null };
            check(review.recommendation, 'REVIEW_VERDICT_MISSING');
            const manifests = fs.readdirSync(path.join(runDir, 'raw'))
                .filter(name => /^review\.\d+\.chunks\.json$/.test(name)).sort();
            check(manifests.length >= 1, 'REVIEW_MANIFEST_MISSING');
            report.reviewManifestFile = manifests.at(-1);
            const manifest = json(path.join(runDir, 'raw', manifests.at(-1)));
            const diffBytes = fs.statSync(path.join(runDir, manifest.diff_file)).size;
            report.reviewManifest = { chunks: manifest.chunks.length, byte_length: manifest.byte_length,
                diffFileBytes: diffBytes, sha256: manifest.sha256 };
            check(manifest.byte_length === diffBytes, 'DIFF_SIZE_MISMATCH');
            // Pass bar: the old ceiling of 12 would have failed at chunk 13;
            // chunks + 1 shared scout turn must fit the new ceiling of 24.
            check(manifest.chunks.length >= 13, 'CHUNKS_BELOW_OLD_CEILING_PROOF',
                `Only ${manifest.chunks.length} chunks; this run does not prove the old ceiling would fail`);
            check(manifest.chunks.length + 1 <= 24, 'CHUNKS_OVER_NEW_CEILING',
                `${manifest.chunks.length} chunks + 1 scout turn exceeds 24`);
            for (const chunk of manifest.chunks) check(chunk.body_bytes <= 16384, 'CHUNK_BODY_OVER_CEILING');
            const workerRoot = report.workerRoot;
            report.modifiedFiles = allowed.filter(file => fs.existsSync(path.join(workerRoot, file)));
            check(report.modifiedFiles.length === 10, 'MODIFIED_FILES_MISMATCH',
                `Expected 10 table modules, found ${report.modifiedFiles.length}`);
            report.moduleRecordCounts = {};
            for (const file of allowed) {
                const text = fs.readFileSync(path.join(workerRoot, file), 'utf8');
                // Diagnostic only (not a pass criterion): lines carrying a record id.
                report.moduleRecordCounts[file] = text.split('\n').filter(line => /id:\s*\d+/.test(line)).length;
            }
        });
    } catch { /* The failing stage has already recorded its exact error. */ }
    finally {
        try {
            await stage('daemonShutdown', 10000, async limit => {
                check(child && client, 'DAEMON_UNAVAILABLE', 'Daemon did not reach client readiness');
                check(!exitResult, 'DAEMON_ALREADY_EXITED');
                await client.stop({ timeoutMs: Math.min(limit, 5000) });
                const result = await exited;
                report.daemonExit = result;
                check(result.code === 0 && result.signal === null, 'DAEMON_UNCLEAN_EXIT');
                let missing = false;
                try { client.readDiscovery(); } catch (error) { missing = error.code === 'DUAL_DISCOVERY_MISSING'; }
                check(missing, 'DAEMON_DISCOVERY_NOT_REMOVED');
            });
        } catch { if (child && !exitResult) stopTree(child); }
        clearTimeout(forceTimer);
        clearInterval(heartbeat);
        try {
            if (authority) {
                observe();
                report.authorityTaskState = authority.derive().tasks[TASK_ID]?.state;
            }
            if (!report.ok && report.daemonLog && fs.existsSync(report.daemonLog)) {
                report.daemonLogTail = require('../lib/dual/validator-security').redactDiagnostic(
                    fs.readFileSync(report.daemonLog, 'utf8').slice(-16000), { maxLength: 16000 });
            }
        } catch (error) { report.diagnosticError = error.code || error.message; }
        if (runDir) {
            const events = taskEvents();
            report.phasesExecuted = [...new Set(events.filter(event => event.type === 'phase.started').map(event => event.phase))];
            report.phasesCompleted = [...new Set(events.filter(event => event.type === 'phase.completed').map(event => event.phase))];
        }
        report.ok = names.every(name => report.stages[name].ok);
        report.wallMs = Date.now() - started;
        save();
        console.error(`Report: ${output}; ${report.ok ? 'OK' : `${report.failedStage}: ${report.errorCode}`}`);
        process.exitCode = report.ok ? 0 : 1;
    }
}

main().catch(error => {
    console.error(`Live relay-ceiling run stopped: ${error.code || 'LIVE_ERROR'}`);
    process.exitCode = 1;
});
