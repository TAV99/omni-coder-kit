'use strict';

// Independent reviewer QC (SPEC-SQUAD-P5 §2). With a squad pipeline whose qc
// phase belongs to a bound reviewer, omni pushes one read-only headless turn per
// released isolated attempt. The reviewer sees the spec, the diff, the evidence
// and the changed files in its own root, never the worker's reasoning (B2).
// NEEDS_FIX rejects the handoff with the findings verbatim and opens a bounded
// correction (Q-P5-1); REJECT or an exhausted budget stops for the orchestrator.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ReviewSchema, toDraft7Schema } = require('./contracts');
const { readTaskBinding } = require('./task-workspace');
const { rejectTaskHandoff } = require('./handoff-rejection');
const { requestTaskCorrection } = require('./task-correction');
const { workerOutputSchema, workerCommandFor, extractWorkerPayload } = require('./worker-runtime');
const { resolveAgyPath } = require('./binary-paths');
const { spawnBoundedProcess } = require('../squad/runtimes/spawn-bounded');
const { defaultRegistry } = require('../squad/runtimes');
const { readBinding } = require('../squad/bindings');
const { loadRoles } = require('../squad/roles');
const { readPipelineIfAny } = require('../squad/pipeline');
const { loadCatalog, resolveBundles } = require('../squad/skills-catalog');
const { createSkillStore } = require('../squad/skill-store');
const { gitInit } = require('../squad/worker-mount');
const { roleBudget } = require('./role-budget');

const SQUAD_DIR = path.join('.omni', 'squad');
const DEFAULT_MAX_CORRECTIONS = 3;
const REVIEW_TIMEOUT_MS = 20 * 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_COPY_BYTES = 2 * 1024 * 1024;

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }

// The bound reviewer, or null when the pipeline keeps QC with the orchestrator.
function reviewerConfig(workspaceRoot, { fsImpl = fs } = {}) {
    if (!fsImpl.existsSync(path.join(workspaceRoot, SQUAD_DIR, 'roles'))) return null;
    const roles = loadRoles(path.join(workspaceRoot, SQUAD_DIR, 'roles'), { fsImpl });
    const pipeline = readPipelineIfAny(workspaceRoot, roles, { fsImpl });
    const qc = pipeline?.phases.find((phase) => phase.id === 'qc');
    const reviewer = readBinding(workspaceRoot, { fsImpl })?.roles.reviewer;
    if (qc?.role !== 'reviewer' || !reviewer) return null;
    const budget = roleBudget(workspaceRoot, 'reviewer', { fsImpl });
    return { runtime: reviewer.runtime, model: reviewer.model, ...(reviewer.effort ? { effort: reviewer.effort } : {}),
        maxCorrections: qc.max_corrections ?? DEFAULT_MAX_CORRECTIONS,
        ...(budget.turnMs ? { turnMs: budget.turnMs } : {}), ...(budget.maxTurns ? { maxTurns: budget.maxTurns } : {}) };
}

// The reviewer role's max_turns caps reviews per task, failed runs included (SPEC-SQUAD-P5 §5).
function reviewBudgetExhausted(task, config) {
    return Boolean(config?.maxTurns) && (task?.qcReviewRuns || 0) >= config.maxTurns;
}

// Whether the released attempt still waits for (or failed) its reviewer verdict.
function needsReview(task) {
    const attempt = task?.isolatedHandoff?.attempt;
    return Boolean(attempt) && task.state !== 'TASK_VERIFIED' && !task.handoffRejection
        && !(task.qcReview?.attempt === attempt && task.qcReview.status === 'completed');
}

function reviewApproved(task) {
    return task?.qcReview?.attempt === task?.isolatedHandoff?.attempt
        && task.qcReview.status === 'completed' && task.qcReview.verdict === 'APPROVE';
}

function repoFile(root, relative) {
    const target = path.resolve(root, relative);
    if (path.relative(root, target).startsWith('..') || path.isAbsolute(path.relative(root, target))) {
        fail('DUAL_REVIEW_INPUT_INVALID', `Path escapes the root: ${relative}`);
    }
    return target;
}

// The worker review phase leaves the exact diff it reviewed; the newest one wins.
function latestReviewDiff(runDir) {
    const raw = path.join(runDir, 'raw');
    if (!fs.existsSync(raw)) return null;
    const diffs = fs.readdirSync(raw).map((name) => /^review\.(\d+)\.diff\.txt$/.exec(name)).filter(Boolean)
        .sort((a, b) => Number(b[1]) - Number(a[1]));
    return diffs.length ? fs.readFileSync(path.join(raw, diffs[0][0]), 'utf8') : null;
}

function fallbackDiff(workspaceRoot, workerRoot, files) {
    return files.map((file) => {
        const before = fs.existsSync(repoFile(workspaceRoot, file)) ? fs.readFileSync(repoFile(workspaceRoot, file), 'utf8') : '';
        const after = fs.existsSync(repoFile(workerRoot, file)) ? fs.readFileSync(repoFile(workerRoot, file), 'utf8') : '';
        return `--- a/${file}\n+++ b/${file}\n${before.split('\n').map((l) => `-${l}`).join('\n')}\n${after.split('\n').map((l) => `+${l}`).join('\n')}\n`;
    }).join('');
}

// Builds <attempt>/review: spec, diff, evidence and the post-change scope files,
// its own git root, and the reviewer skill bundle. Rebuilt from scratch per run.
function prepareReviewRoot({ workspaceRoot, task, runtime }) {
    const { workerRoot } = readTaskBinding(workspaceRoot, task.isolatedWorkspace.reference);
    const attemptDir = path.dirname(path.join(workspaceRoot, task.isolatedWorkspace.reference.bindingPath));
    const reviewRoot = path.join(attemptDir, 'review');
    fs.rmSync(reviewRoot, { recursive: true, force: true });
    fs.mkdirSync(reviewRoot, { recursive: true });
    const runDir = path.join(workerRoot, '.omni', 'codex-gemini', 'runs', task.task_id);
    const spec = JSON.parse(fs.readFileSync(path.join(runDir, 'spec.json'), 'utf8'));
    const evidence = fs.readFileSync(path.join(runDir, 'evidence.json'), 'utf8');
    const scope = [...new Set([...(spec.allowed_files || []), ...(task.context_files || [])])];
    const copied = [];
    let bytes = 0;
    for (const file of scope) {
        const source = repoFile(workerRoot, file);
        if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
        bytes += fs.statSync(source).size;
        if (bytes > MAX_COPY_BYTES) break;
        fs.mkdirSync(path.dirname(repoFile(reviewRoot, file)), { recursive: true });
        fs.copyFileSync(source, repoFile(reviewRoot, file));
        copied.push(file);
    }
    const diff = latestReviewDiff(runDir) ?? fallbackDiff(workspaceRoot, workerRoot, spec.allowed_files || []);
    fs.writeFileSync(path.join(reviewRoot, 'spec.json'), `${JSON.stringify(spec, null, 2)}\n`);
    fs.writeFileSync(path.join(reviewRoot, 'evidence.json'), evidence);
    fs.writeFileSync(path.join(reviewRoot, 'diff.patch'), diff);
    gitInit(reviewRoot, workspaceRoot);
    mountReviewerSkills({ workspaceRoot, reviewRoot, runtime });
    return { reviewRoot, attemptDir, spec, copied,
        inputSha256: sha(JSON.stringify({ spec, evidence, diff, copied })) };
}

// Mounts the reviewer bundle (QC phase + shared-core, P2) where its CLI reads skills.
function mountReviewerSkills({ workspaceRoot, reviewRoot, runtime }) {
    const squad = path.join(workspaceRoot, SQUAD_DIR);
    if (!fs.existsSync(path.join(squad, 'skills.yaml')) || typeof runtime.mountSkills !== 'function') return null;
    const roles = loadRoles(path.join(squad, 'roles'));
    const catalog = loadCatalog(path.join(squad, 'skills.yaml'), roles);
    const pipeline = readPipelineIfAny(workspaceRoot, roles);
    const { bundles } = resolveBundles({ catalog, roles, reviewerBound: true, pipeline });
    const store = createSkillStore(workspaceRoot);
    const skills = (bundles.reviewer || []).filter((name) => store.has(name));
    return runtime.mountSkills({ store, root: reviewRoot, skills, roleId: 'reviewer', deterministic: true });
}

function reviewPrompt(spec) {
    return [
        `You are the independent QC reviewer for task ${spec.task_id}. Another agent made the change; you did not.`,
        'Read spec.json, diff.patch, evidence.json and the changed files in this directory.',
        'Judge only whether the change meets spec.json exactly: correctness, edge cases the spec names, scope, regressions.',
        'Do not modify any file. Do not run shell commands, tests or scripts: only read files; command results are in evidence.json.',
        `Return the required JSON contract with task_id ${spec.task_id}, schema_version ${spec.schema_version},`,
        `expected_baseline ${JSON.stringify(spec.expected_baseline)}; recommendation APPROVE only when nothing must change,`,
        'NEEDS_FIX with concrete findings (file, line, description, severity) otherwise, REJECT when the approach is wrong;',
        'at least three review_checks and a challenge_summary.',
    ].join(' ');
}

// One reviewer turn for the task's released attempt; appends started/completed/failed.
async function runReviewerQc({ workspaceRoot, authorityStore, taskId, config, env = process.env, spawnImpl, registry = defaultRegistry }) {
    const task = { task_id: taskId, ...authorityStore.derive().tasks[taskId] };
    if (!needsReview(task)) return { status: 'SKIPPED' };
    if (reviewBudgetExhausted(task, config)) return { status: 'BUDGET_EXHAUSTED' };
    const timeoutMs = config.turnMs ?? REVIEW_TIMEOUT_MS;
    const attempt = task.isolatedHandoff.attempt;
    const runtime = registry.get(config.runtime);
    const prepared = prepareReviewRoot({ workspaceRoot, task, runtime });
    authorityStore.append({ schema_version: 2, type: 'qc.review.started', task_id: taskId, attempt,
        runtime: config.runtime, model: config.model, input_sha256: prepared.inputSha256 });
    try {
        const { spec, reviewRoot, attemptDir } = prepared;
        const base = toDraft7Schema(ReviewSchema, 'omni-dual-review-v1', { schemaVersion: spec.schema_version, baselineKind: spec.expected_baseline?.kind
            ?? (spec.expected_base_commit ? 'git' : 'snapshot') });
        const schemaPath = path.join(reviewRoot, '.qc-schema.json');
        fs.writeFileSync(schemaPath, JSON.stringify(workerOutputSchema(config.runtime, base)));
        const { command, prefixArgs } = workerCommandFor(config.runtime, { agyCommand: resolveAgyPath({ env }) });
        const invocation = runtime.buildHeadless({ prompt: reviewPrompt(spec), cwd: reviewRoot, model: config.model,
            ...(config.effort ? { effort: config.effort } : {}), permission: 'read-only', isolatedRoot: true,
            jsonSchemaPath: schemaPath, timeoutMs }, { resolved: { found: true, command, prefixArgs } });
        const raw = await spawnBoundedProcess(invocation.command, [...invocation.args], {
            cwd: reviewRoot, env: { ...env, GIT_CEILING_DIRECTORIES: path.dirname(reviewRoot).replace(/\\/g, '/') },
            timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES, ...(spawnImpl ? { spawnImpl } : {}) });
        const result = { exitCode: raw.code, stdout: raw.stdout || '', stderr: raw.stderr || '',
            timedOut: raw.timedOut === true || raw.error_code === 'TIMEOUT' };
        const { payload } = extractWorkerPayload(config.runtime, result, ReviewSchema);
        if (payload.task_id !== taskId) fail('DUAL_REVIEW_OUTPUT_INVALID', 'Reviewer verdict names another task');
        const verdictText = `${JSON.stringify({ ...payload, reviewer: { runtime: config.runtime, model: config.model } }, null, 2)}\n`;
        fs.writeFileSync(path.join(attemptDir, 'qc-verdict.json'), verdictText);
        const usage = runtime.parseResult(result, {}).usage;
        authorityStore.append({ schema_version: 2, type: 'qc.review.completed', task_id: taskId, attempt,
            verdict: payload.recommendation, verdict_sha256: sha(verdictText), findings_count: payload.findings.length,
            ...(usage ? { usage: { input_tokens: usage.inputTokens ?? null, output_tokens: usage.outputTokens ?? null,
                thinking_tokens: usage.thinkingTokens ?? null } } : {}) });
        return { status: 'COMPLETED', attempt, verdict: payload };
    } catch (error) {
        const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code || '') ? error.code : 'DUAL_REVIEW_FAILED';
        authorityStore.append({ schema_version: 2, type: 'qc.review.failed', task_id: taskId, attempt, code });
        return { status: 'FAILED', attempt, code };
    }
}

// Reviewer findings → handoff rejection findings, verbatim (anti-pattern C). A
// rejection may only name task scope files, so others keep their path in the text.
function rejectionFindings(verdict, attempt, allowedFiles) {
    const blocking = verdict.findings.filter((finding) => finding.severity !== 'INFO');
    const chosen = (blocking.length ? blocking : verdict.findings).slice(0, 32);
    const inScope = (file) => allowedFiles.includes(file);
    const findings = chosen.map((finding, index) => ({ id: `qc-${attempt}-${index + 1}`,
        file: inScope(finding.file) ? finding.file : allowedFiles[0], line: inScope(finding.file) ? finding.line || 1 : 1,
        requirement_id: 'qc-review',
        description: `[${finding.severity}]${inScope(finding.file) ? '' : ` (${finding.file}${finding.line ? `:${finding.line}` : ''})`} ${finding.description}`.slice(0, 2048) }));
    return findings.length ? findings : [{ id: `qc-${attempt}-1`, file: allowedFiles[0], line: 1, requirement_id: 'qc-review',
        description: verdict.challenge_summary.slice(0, 2048) }];
}

// NEEDS_FIX within budget → rejection + correction (the caller dispatches the worker).
// REJECT, or no budget left → rejection only: the orchestrator decides (B3).
function settleReviewVerdict({ workspaceRoot, authorityStore, taskId, verdict, attempt, config }) {
    const current = authorityStore.derive();
    const task = current.tasks[taskId];
    rejectTaskHandoff({ workspaceRoot, authorityStore, session_id: current.sessionId, task_id: taskId,
        plan_revision: current.planRevision, expected_attempt: attempt, request_id: `qc-review-${attempt}`,
        expected_handoff_sha256: task.isolatedHandoff.handoff_sha256, expected_result_sha256: task.isolatedHandoff.result_sha256,
        findings: rejectionFindings(verdict, attempt, task.allowed_files) });
    if (verdict.recommendation !== 'NEEDS_FIX' || attempt - 1 >= config.maxCorrections) {
        return { status: 'NEEDS_DECISION', reason: verdict.recommendation === 'REJECT' ? 'reviewer rejected the approach' : 'correction limit reached' };
    }
    try {
        requestTaskCorrection({ workspaceRoot, authorityStore, sessionId: current.sessionId, planRevision: current.planRevision,
            taskId, requestId: `qc-correction-${attempt}`, expectedAttempt: attempt,
            reason: 'Independent reviewer returned NEEDS_FIX; address every recorded finding.' });
    } catch (error) {
        return { status: 'NEEDS_DECISION', reason: error.code || 'correction refused' };
    }
    return { status: 'CORRECTING', attempt: attempt + 1 };
}

module.exports = { reviewerConfig, needsReview, reviewApproved, reviewBudgetExhausted, prepareReviewRoot, runReviewerQc, settleReviewVerdict, rejectionFindings, reviewPrompt };
