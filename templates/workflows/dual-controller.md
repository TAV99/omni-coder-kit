# Codex + Antigravity controller contract

Applies when this project is configured for Codex + Gemini through AGY. Read this before think/plan/cook/check/fix/pass. These coordination rules take precedence over generic instructions to edit the next unchecked todo; the underlying workflow still governs implementation quality.

## One user-facing controller

The user works in Codex CLI. Codex owns architecture, context, routing, independent QC and integration. AGY is a worker, never the final approver. Do not commit, stash, reset, push or deploy automatically. A reply cannot grant filesystem or external-service authority.

Inspect the current canonical workspace, branch, package and `.omni/manifest.json` before loading planning artifacts. A todo/spec from another branch or project is not the active contract. Preserve it; do not overwrite it to make bootstrap pass.

## Plan and dispatch

- Complete `.omni/sdlc/setup.json`, design/context sources, `todo.md` and `dual-plan.json` before `omni dual bootstrap --json` (pass `--worker-model <model>` if specified by user prompt or config). Bootstrap is the single AUTO entrypoint: never create `bootstrap-plan-artifacts` or directly call begin/register as a workaround.
- For new low-risk AGY slices use `execution_mode: "isolated"`, 1–10 exact `allowed_files`, explicit `context_files`, `deny_patterns`, and typed `validation_commands` (`program`, `args`, `cwd`). Declare `depends_on: ["TASK-1"]` when predecessor output is needed. Unknown/cyclic dependencies are invalid. Validation commands for isolated AGY slices must be source verification checks (e.g. typecheck, unit tests); full-project build commands (e.g. npm run build) producing bundle artifacts (dist/) belong to the controller integration/QA phase on the root workspace.
- **Pre-Integration Acceptance Policy:** Plans may declare a strict `acceptance_policy` with `protocol_version: 1` and a `checks` array. Each check uses `id`, `requirement_id`, `phase` (`pre_integration` or `session`), `kind` (`command` or `review`), `required`, optional `task_id`, and a typed command (`program`, `args`, `cwd`) for command checks. For a required pre-integration review, first prepare a daemon-owned review execution, then submit untrusted findings against its `review_execution_id`; isolated QC only trusts the resulting durable daemon attestation.
- Multiple AGY tasks require an all-isolated worker graph. Architecture/security/migration/ambiguous/high-risk work stays with Codex outside that graph; do not mislabel risky work as low risk. Existing shared plans remain compatible but retain a single AGY slice.
- Overlapping write/read-context scopes wait in deterministic dependency order. Do not remove ownership checks or merge competing edits by last-writer-wins. The adapter currently dispatches serially; do not claim parallel throughput.
- Resolve the worker model from user preference (`--worker-model`), configured capability evidence in `.omni/manifest.json`, `OMNI_DUAL_WORKER_MODEL`, and `agy models` (supported: `gemini-3.8-flash-high`, `gemini-3.7-flash-high`, `gemini-3.1-pro-high`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`); model examples are not proof of availability. No silent fallback to another model.
- Private workers start from source snapshots without copying `node_modules`, authority credentials or the source AGY project binding. For a single-package npm project with an immutable package.json/package-lock.json, declare `dependency_mode: "npm-ci"`. The controller installs in private cwd with lifecycle scripts disabled, records a dependency fingerprint, and checks it on resume/QC. Shrinkwrap, workspace projects and escaping local dependencies are rejected by this mode. If a build requires lifecycle/native setup or another package manager, resolve that capability before spending a live attempt; do not switch to shared writes to hide it.
- Use `omni_dual_status` and `omni_dual_resume` (or `omni dual status <task-id>` / `omni dual run|resume <task-id>`). `omni dual status --json` is not a supported CLI form; use the task ID form and inspect bounded public fields only. Direct legacy `omni dual phase` is not a bypass for an authority task.
- **Controller model and reasoning profile:** Default to `gpt-5.6-luna medium` or `gpt-5.6-sol` for Controller coordination. Ultra-high reasoning (`xhigh`) adds 4–8 minutes of latency per coordination turn and is only warranted when initially drafting multi-package architecture plans.
- **Unstoppable Relay Loop (Baton-Passing Chaining):** For multi-task plans, when an isolated task reaches `TASK_VERIFIED` after QC integration, the controller MUST NOT stop or wait for user prompts. Immediately evaluate the next eligible task in `orderedTasks` and proceed to dispatch or resume it, keeping the pipeline continuously running until all tasks are complete.
- **Immediate Bounded Correction:** When a worker attempt stops early or fails QC without a fatal session blocker, immediately inspect failure codes and issue targeted `correction` guidance via `omni_dual_resume` within the 3-attempt budget. Never leave worker idle when bounded correction can drive verification.
- **Autonomous Context Auto-Reply (Uninterrupted Execution):** When an isolated worker raises `task.questions` (`NEEDS_CONTEXT`), auto-reply is limited to non-safety in-scope implementation conventions grounded in `.omni/sdlc/design-spec.md`, `.omni/sdlc/content-source.md`, `todo.md`, or an equivalent source. Always require user input for commerce, sensitive data, an external write, a paid action, a breaking change, or scope expansion, even when the decision is grounded in a source. Dispatch `omni_dual_resume` and resume only after that boundary is satisfied; never let a worker recommendation authorize a safety-sensitive decision.
- **Grounded context-reply contract:** A context reply must be grounded in a design/content source or an in-scope implementation convention already within scope, never solely in a worker recommendation. Keep the existing `context_reply` envelope and add no unknown schema fields. Its `body` must state `Decision`, `Source file/section`, `Question ID`, and `Plan revision`.
- **User-decision boundary:** Always require user input before deciding anything involving commerce, sensitive data, an external write, a paid action, a breaking change, or scope expansion, even when grounded in a source. A worker suggestion of a paid service is only a proposal and requires a user decision; it is never authorization.
- **Reply identity and continuation:** Preserve stable `message_id` and exact `reply_to` across retries. Same ID/content may be acknowledged, but duplicate ID with changed content must reject through the existing mechanism. AUTO may continue only when an authorized next action exists. If authority is missing or an exhausted retry budget is reached, stop with the preserved evidence and must not reset the session.

## Act on observable task state

| State/evidence | Controller action |
|---|---|
| Active AGY lease | Lease heartbeat is maintained by daemon (10s intervals). Avoid tight high-effort reasoning loops to poll status; wait for terminal handoff, questions, or failure. No source/build/browser writes and no duplicate worker launch. |
| WAITING_FOR_DEPENDENCY / WAITING_FOR_SCOPE | Finish/QC the predecessor; wait is not failure. |
| NEEDS_CONTEXT / pending_questions | AUTONOMOUS REPLY MANDATORY for non-safety, in-scope conventions: inspect `.omni/sdlc/design-spec.md` and `.omni/sdlc/content-source.md` immediately, synthesize an authoritative answer, and dispatch `omni_dual_resume` with `context_reply` without pausing. For commerce, sensitive data, an external write, a paid action, a breaking change, or scope expansion, always require user input regardless of grounding. |
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
    "body": "Decision: Use Student; Source file/section: design-spec.md#labels; Question ID: question-1; Plan revision: 1"
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

For isolated QC, call `omni_dual_completion` with `isolated_qc: {"task_id":"TASK-1","plan_revision":1}` plus current workspace/session, or `omni dual qc TASK-1 --json`. If the task is subject to pre-integration review checks, call `omni_dual_acceptance_review_prepare`, perform the review against its exact bindings, then call `omni_dual_acceptance_review_submit` with untrusted findings:
```json
{
  "workspace_root": "<current canonical workspace>",
  "session_id": "<current session>",
  "task_id": "TASK-1",
  "plan_revision": 1,
  "review_submission": {
    "review_execution_id": "00000000-0000-4000-8000-000000000001",
    "check_results": [{"check_id": "CHK-001", "status": "PASS", "findings": []}]
  }
}
```
Then run isolated QC without caller-built review evidence. The compatibility CLI option `--review-evidence` remains available as an alias for a review-submission file, but legacy files containing policy/result/evidence hashes are rejected.
The daemon runs exact registered validators, rechecks private evidence, binds independent review evidence, integrates under Codex authority, and records task completion only with valid integration evidence.

### Post-integration acceptance correction

When the session is in `ACCEPTANCE` state, prepare a fresh execution through `omni_dual_acceptance_review_prepare` (or `omni dual acceptance prepare <task-id> --plan-revision <n> --json`), then submit findings through `omni_dual_acceptance_review_submit` (or `omni dual acceptance submit <task-id> --plan-revision <n> --review-submission <file>`). The daemon binds and attests the findings to the registered policy, current integrated diff fingerprint and verified task result. A failed required session check creates the durable correction gate.

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

### Daemon-owned quality checkpoints

Use `omni_dual_quality` once for each required `cycle_index` (1, 2, then 3), with the current canonical `workspace_root` and `session_id`. The daemon binds each checkpoint to the current source fingerprint generation and records the exact quality gate and evidence. Do not build or submit `quality_evidence` through `omni_dual_completion`.

If source changes before the session is verified, restart the required checkpoint sequence from cycle 1 for the new fingerprint generation; later cycles must wait until their current-generation prerequisites are recorded. A successful same-generation replay is read-only. If the quality call times out, inspect `omni_dual_status` for that same session before taking another action; do not blindly replay a possibly active mutation. After the daemon reports `VERIFIED`, source changes require a new session.

If isolated QC returns `NEEDS_REVIEW`, use its returned `missing` check IDs to call `omni_dual_acceptance_review_prepare`, review the exact returned execution bindings, and submit real findings through `omni_dual_acceptance_review_submit`. MCP may bound the displayed list; when `missing_truncated` is true, submit the displayed IDs and rerun isolated QC to obtain the remaining required IDs. Never fabricate PASS findings or waive a check. All required tasks, quality gates, and reviews must be complete before the daemon can report session `VERIFIED`.

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

TASK_VERIFIED is not session VERIFIED. The three quality cycles are recorded only through `omni_dual_quality` as described above; never construct `quality_evidence` manually or inherit cycle 1 from isolated-QC outputs. Use `omni_dual_completion` only for the remaining isolated-task QC (`isolated_qc`), root QC (`qc_evidence`), required UI (`ui_evidence`) inputs, and completion-readiness evaluation as applicable, then inspect the session receipt. Never fabricate command output or infer visual QA from static checks. A green simulated-worker suite does not qualify live AGY, platforms or release packaging.
- **Uncommitted Working Tree Verification:** The daemon verifies that the uncommitted workspace diff matches the approved receipt diff fingerprint. Do not force an unauthorized `git commit` or `git push` to pass completion.

If transport observation times out, inspect the same daemon/lease/attempt; do not launch another process just because the previous response was lost. Preserve all evidence and report the exact missing capability/authority when safe progress truly requires the user.

For a recorded dead controller before any child spawn, `omni_dual_resume` accepts `recovery: {"task_id":"TASK-1","plan_revision":1}` plus current workspace/session. Recovery discovers recorded PIDs itself; never supply PIDs or edit locks. `WAITING_FOR_PROCESS`, `NEEDS_PROCESS_EVIDENCE` and `NEEDS_PROCESS_TREE_EVIDENCE` do not resume execution. A direct worker PID's death is not proof that detached descendants are gone; this case remains a safety stop until tree-level evidence is available. Normal delayed-close cleanup preserves the lease until the tracked child closes, then completes the deferred release.
