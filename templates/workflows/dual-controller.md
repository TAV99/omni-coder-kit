# Codex + Antigravity controller contract

Applies when this project is configured for Codex + Gemini through AGY. Read this before think/plan/cook/check/fix/pass. These coordination rules take precedence over generic instructions to edit the next unchecked todo; the underlying workflow still governs implementation quality.

## One user-facing controller

The user works in Codex CLI. Codex owns architecture, context, routing, independent QC and integration. AGY is a worker, never the final approver. Do not commit, stash, reset, push or deploy automatically. A reply cannot grant filesystem or external-service authority.

Inspect the current canonical workspace, branch, package and `.omni/manifest.json` before loading planning artifacts. A todo/spec from another branch or project is not the active contract. Preserve it; do not overwrite it to make bootstrap pass.

## Plan and dispatch

- Complete `.omni/sdlc/setup.json`, design/context sources, `todo.md` and `dual-plan.json` before `omni dual bootstrap --json` (pass `--worker-model <model>` if specified by user prompt or config). Bootstrap is the single AUTO entrypoint: never create `bootstrap-plan-artifacts` or directly call begin/register as a workaround.
- For new low-risk AGY slices use `execution_mode: "isolated"`, 1–10 exact `allowed_files`, explicit `context_files`, `deny_patterns`, and typed `validation_commands` (`program`, `args`, `cwd`). Declare `depends_on: ["TASK-1"]` when predecessor output is needed. Unknown/cyclic dependencies are invalid. Validation commands for isolated AGY slices must be source verification checks (e.g. typecheck, unit tests); full-project build commands (e.g. npm run build) producing bundle artifacts (dist/) belong to the controller integration/QA phase on the root workspace.
- **Pre-Integration Acceptance Policy:** Plans may declare a strict `acceptance_policy` with `protocol_version: 1` and a `checks` array. Each check uses `id`, `requirement_id`, `phase` (`pre_integration` or `session`), `kind` (`command` or `review`), `required`, optional `task_id`, and a typed command (`program`, `args`, `cwd`) for command checks. For any pre-integration check, canonical `review_evidence` must be presented during isolated QC before integration is permitted.
- Multiple AGY tasks require an all-isolated worker graph. Architecture/security/migration/ambiguous/high-risk work stays with Codex outside that graph; do not mislabel risky work as low risk. Existing shared plans remain compatible but retain a single AGY slice.
- Overlapping write/read-context scopes wait in deterministic dependency order. Do not remove ownership checks or merge competing edits by last-writer-wins. The adapter currently dispatches serially; do not claim parallel throughput.
- Resolve the worker model from user preference (`--worker-model`), configured capability evidence in `.omni/manifest.json`, `OMNI_DUAL_WORKER_MODEL`, and `agy models` (supported: `gemini-3.8-flash-high`, `gemini-3.7-flash-high`, `gemini-3.1-pro-high`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`); model examples are not proof of availability. No silent fallback to another model.
- Private workers start from source snapshots without copying `node_modules`, authority credentials or the source AGY project binding. For a single-package npm project with an immutable package.json/package-lock.json, declare `dependency_mode: "npm-ci"`. The controller installs in private cwd with lifecycle scripts disabled, records a dependency fingerprint, and checks it on resume/QC. Shrinkwrap, workspace projects and escaping local dependencies are rejected by this mode. If a build requires lifecycle/native setup or another package manager, resolve that capability before spending a live attempt; do not switch to shared writes to hide it.
- Use `omni_dual_status` and `omni_dual_resume` (or `omni dual status <task-id>` / `omni dual run|resume <task-id>`). `omni dual status --json` is not a supported CLI form; use the task ID form and inspect bounded public fields only. Direct legacy `omni dual phase` is not a bypass for an authority task.
- **Controller model and reasoning profile:** Default to `gpt-5.6-luna medium` or `gpt-5.6-sol` for Controller coordination. Ultra-high reasoning (`xhigh`) adds 4–8 minutes of latency per coordination turn and is only warranted when initially drafting multi-package architecture plans.
- **Unstoppable Relay Loop (Baton-Passing Chaining):** For multi-task plans, when an isolated task reaches `TASK_VERIFIED` after QC integration, the controller MUST NOT stop or wait for user prompts. Immediately evaluate the next eligible task in `orderedTasks` and proceed to dispatch or resume it, keeping the pipeline continuously running until all tasks are complete.
- **Immediate Bounded Correction:** When a worker attempt stops early or fails QC without a fatal session blocker, immediately inspect failure codes and issue targeted `correction` guidance via `omni_dual_resume` within the 3-attempt budget. Never leave worker idle when bounded correction can drive verification.
- **Autonomous Context Auto-Reply (Uninterrupted Execution):** When an isolated worker raises `task.questions` (`NEEDS_CONTEXT`), the controller MUST NOT pause or wait for user intervention if the answers can be grounded in `.omni/sdlc/design-spec.md`, `.omni/sdlc/content-source.md`, `todo.md`, or standard UI/UX/API conventions. Immediately formulate authoritative answers, dispatch `omni_dual_resume` with `context_reply` for each question, and resume the task without leaving the pipeline idle. Only ask the user when a decision is fundamentally absent from all project documents and specifications.

## Act on observable task state

| State/evidence | Controller action |
|---|---|
| Active AGY lease | Lease heartbeat is maintained by daemon (10s intervals). Avoid tight high-effort reasoning loops to poll status; wait for terminal handoff, questions, or failure. No source/build/browser writes and no duplicate worker launch. |
| WAITING_FOR_DEPENDENCY / WAITING_FOR_SCOPE | Finish/QC the predecessor; wait is not failure. |
| NEEDS_CONTEXT / pending_questions | AUTONOMOUS REPLY MANDATORY: Inspect `.omni/sdlc/design-spec.md` and `.omni/sdlc/content-source.md` immediately. Synthesize authoritative recommended answers for all questions and dispatch `omni_dual_resume` with `context_reply` without pausing for user prompts. Only escalate to the user if the question involves an ungrounded commercial or breaking product decision. |
| AWAITING_CODEX_QC / isolated handoff | Inspect semantic evidence, then request independent isolated QC. |
| NEEDS_FIX / FAILED / last_outcome | Inspect preserved attempt artifacts, then request bounded correction if safe. |
| CONFLICT | Preserve user and worker versions. Resolve source/context disagreement; never blindly overwrite. |
| Partial integration journal | Resume its integration/recovery; a new correction attempt is refused. |
| Expired unreleased lease | Verify actual process ownership/termination before recovery; expiry is not proof the worker stopped. |

An isolated finalization failure is a durable `FAILED` outcome, never a success or handoff. A post-expiry lease is settled only when the current controller owns the recorded execution and every tracked child has a correlated started PID plus a numeric normal close; otherwise preserve the lease and surface `NEEDS_PROCESS_EVIDENCE` or `NEEDS_PROCESS_TREE_EVIDENCE`. Use task-level recovery for that attempt; `archive --if-pristine` is not a substitute for resolving an active or expired execution.

## Exact MCP calls

Use the current `workspace_root`, `session_id`, task ID and `plan_revision` from status. IDs below illustrate a task named `TASK-1`; do not reuse another session's values.

Reply and resume through `omni_dual_resume`:

```json
{
  "workspace_root": "<current canonical workspace>",
  "session_id": "<current session>",
  "context_reply": {
    "task_id": "TASK-1", "plan_revision": 1,
    "message_id": "reply-1", "reply_to": "question-1",
    "body": "Use Student."
  }
}
```

Use a stable request ID when retrying delivery. Same ID/content is acknowledged once; changed content under the same ID is rejected. Replies must be nonblank. Questions currently originate at scout; do not claim implementation-time interactive chat exists.

For correction, call the same `omni_dual_resume` with `correction` instead of `context_reply`:

```json
{
  "workspace_root": "<current canonical workspace>",
  "session_id": "<current session>",
  "correction": {
    "task_id": "TASK-1", "plan_revision": 1,
    "request_id": "fix-1", "expected_attempt": 1,
    "reason": "Fix the registered value check."
  }
}
```

Correction preserves scope and old artifacts, creating attempt 2 then at most 3. It requires a recorded failed outcome and released lease. Do not reset the graph, change validation commands to force success or create another task merely to evade the attempt budget.

For isolated QC, call `omni_dual_completion` with `isolated_qc: {"task_id":"TASK-1","plan_revision":1}` plus current workspace/session, or `omni dual qc TASK-1 --json`. If the task is subject to pre-integration acceptance checks, include `review_evidence`:
```json
{
  "workspace_root": "<current canonical workspace>",
  "session_id": "<current session>",
  "isolated_qc": {
    "task_id": "TASK-1",
    "plan_revision": 1
  },
  "review_evidence": {
    "policy_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "task_id": "TASK-1",
    "result_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "check_results": [{"check_id": "CHK-001", "status": "PASS", "findings": []}],
    "evidence_sha256": "0000000000000000000000000000000000000000000000000000000000000000"
  }
}
```
The daemon runs exact registered validators, rechecks private evidence, binds independent review evidence, integrates under Codex authority, and records task completion only with valid integration evidence.

### Post-integration acceptance correction

When the session is in `ACCEPTANCE` state, submit post-integration review evidence first through `omni_dual_acceptance_review_submit` (or `omni dual acceptance submit <task-id> --plan-revision <n> --review-evidence <file>`). The daemon binds the evidence to the registered policy, current integrated diff fingerprint and verified task result. A failed required session check creates the durable correction gate.

Only then start an authorized, bounded acceptance correction targeting a verified task:
```json
{
  "workspace_root": "<current canonical workspace>",
  "session_id": "<current session>",
  "task_id": "TASK-1",
  "expected_sequence": 42,
  "start_fingerprint": "0000000000000000000000000000000000000000000000000000000000000000",
  "failure_check_id": "CHK-001",
  "reason": "Fix button contrast ratio in mobile viewport"
}
```
Rules:
1. Target task must be in `TASK_VERIFIED`.
2. `failure_check_id` must name a policy-defined required session review with a correction grant for this task. Scope and typed validator commands come only from that immutable grant; callers cannot override either.
3. `expected_sequence`, `start_fingerprint` and the failed review result are compare-and-swap provenance checks; stale or superseded evidence is rejected.
4. The daemon assigns `attempt` strictly sequentially (1..3), with a maximum of 3 attempts per task across the session.
5. Only one active correction is permitted at a time.
6. Complete the correction without caller-supplied status or validator identity. The daemon derives `PASSED`/`FAILED` from the registered validator and exact delta. Failed corrections or active corrections strictly block session completion (`completion.evaluate`) and session verification (`session.verified`).

### Durable failures and session blocking

When an attempt limit is exhausted (attempt 3 failed) or an unrecoverable blocker occurs, the session must be durably blocked rather than looping endlessly:
```json
{
  "workspace_root": "<current canonical workspace>",
  "session_id": "<current session>",
  "reason": "Task TASK-1 exhausted maximum correction attempts",
  "blocker_code": "BUDGET_EXHAUSTED"
}
```
Once a session is `BLOCKED`, the Stop hook cleanly halts execution and PreToolUse denies mutations with `[omni-blocked]`.

## Completion and evidence

### Incident prevention: source binding, dependencies and external tools

- Keep source `agyProjectId` and global project mappings intact. The daemon passes source binding separately; only shared execution selects that project. Isolated workers never inherit it. Explicit unsafe worker flags remain rejected.
- Bootstrap checks declared npm-ci inputs and any existing dependency tree after typed setup, before authority dispatch. This is diagnostic preflight, not a private dependency receipt: isolated install and verification still run independently.
- Dependency fingerprints use at most 1 MiB read buffers, with 256 MiB/file, 1 GiB total, 50,000 files and 64 directory levels. Lifecycle scripts remain disabled. A resource error is preparation failure, not an AGY model failure; do not replace the project's linter automatically.
- A failed task with no active/expired worker and no independent runnable task stops the AUTO continuation loop with correction guidance. Preserve the failed attempt and ledger; do not stop the daemon to evade scope enforcement or remove bindings manually.

Stitch mutations need an explicit exact `external_operations` grant on a Codex/shared task. Example (illustrative title, not permission to create a real project):

```json
{
"external_operations": [{
  "tool_name": "mcp__stitch__create_project",
  "tool_input": { "title": "Approved design project" },
  "evidence_file": ".omni/sdlc/stitch-reference.json"
}]
}
```

The evidence file must already be in `allowed_files` and outside `deny_patterns`. It is a scope anchor, not fabricated proof of remote success. Input is exact bounded JSON (16 KiB, 16 container levels); there are no wildcard arguments or blanket MCP permissions. The daemon reserves a grant durably before allowing one invocation; repeated PreToolUse is denied even after a lost response/restart. PostToolUse records observation only. Inspect the remote state before requesting new authority after uncertain effects. Normal Codex ROUTED interactive authority is retained; active or expired unrecovered AGY leases block external mutation.

Do not invent a local path field in provider tool arguments. Provider IAM/OAuth permissions remain independent. Grants must be known before immutable plan registration: if later operations require newly returned project/screen IDs, prepare that external design phase before freezing the implementation graph, or stop for an explicitly authorized follow-up plan. Never edit an active plan or grant yourself wildcard access to work around unknown IDs.

Read bounded semantic artifacts/status first, raw stdout/stderr only to diagnose a failure or correlation mismatch. Worker prose is not completion evidence.

When an execution wrapper returns a process handle, retain the complete result (`output`, `exit_code`, and `session_id`) and poll that returned handle until it reaches a terminal state. In an exec callback, forward the complete result with `text(r)` rather than `text(r.output)`. Empty output is not process completion and is never a reason to retry bootstrap. Never read or dump raw `.omni/runtime/dual/daemon.json`; it contains a token. Diagnostics must select only public fields such as workspace, PID, host, port, and health state.

A missing Git `HEAD` in a positively proven unborn repository is distinct from `.git/index.lock`: fresh snapshot bootstrap does not require an automatic initial commit, and an index lock is a separate ownership/recovery condition. Do not infer lock ownership from age or size and do not remove it automatically.

TASK_VERIFIED is not session VERIFIED. Record three real quality cycles and required UI evidence on the integrated project through `omni_dual_completion`, then inspect the session receipt. Never fabricate command output or infer visual QA from static checks. A green simulated-worker suite does not qualify live AGY, platforms or release packaging.
- **Root Diff Fingerprint Calculation:** In `quality_evidence`, `diff_fingerprint` must reflect the fresh root workspace diff measured against `current_baseline.id` (excluding `.omni`). Do NOT reuse the isolated sandbox attempt's patch SHA.
- **Fast-Track Quality Inheritance:** When an isolated task has passed independent QC and the root workspace has no competing or unverified modifications, Quality Cycle 1 may inherit the verified command outputs from the isolated QC pass rather than re-running the exact same test suites a third time. Full-pipeline integration checks (e.g. `npm run build`, `audit`) and real browser UI verification complete the remaining cycles.
- **Uncommitted Working Tree Verification:** The daemon verifies that the uncommitted workspace diff matches the approved receipt diff fingerprint. Do not force an unauthorized `git commit` or `git push` to pass completion.

If transport observation times out, inspect the same daemon/lease/attempt; do not launch another process just because the previous response was lost. Preserve all evidence and report the exact missing capability/authority when safe progress truly requires the user.

For a recorded dead controller before any child spawn, `omni_dual_resume` accepts `recovery: {"task_id":"TASK-1","plan_revision":1}` plus current workspace/session. Recovery discovers recorded PIDs itself; never supply PIDs or edit locks. `WAITING_FOR_PROCESS`, `NEEDS_PROCESS_EVIDENCE` and `NEEDS_PROCESS_TREE_EVIDENCE` do not resume execution. A direct worker PID's death is not proof that detached descendants are gone; this case remains a safety stop until tree-level evidence is available. Normal delayed-close cleanup preserves the lease until the tracked child closes, then completes the deferred release.
