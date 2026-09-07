# Codex + Antigravity controller contract

Applies when this project is configured for Codex + Gemini through AGY. Read this before think/plan/cook/check/fix/pass. These coordination rules take precedence over generic instructions to edit the next unchecked todo; the underlying workflow still governs implementation quality.

## One user-facing controller

The user works in Codex CLI. Codex owns architecture, context, routing, independent QC and integration. AGY is a worker, never the final approver. Do not commit, stash, reset, push or deploy automatically. A reply cannot grant filesystem or external-service authority.

Inspect the current canonical workspace, branch, package and `.omni/manifest.json` before loading planning artifacts. A todo/spec from another branch or project is not the active contract. Preserve it; do not overwrite it to make bootstrap pass.

## Plan and dispatch

- Complete `.omni/sdlc/setup.json`, design/context sources, `todo.md` and `dual-plan.json` before `omni dual bootstrap --json`. Bootstrap is the single AUTO entrypoint: never create `bootstrap-plan-artifacts` or directly call begin/register as a workaround.
- For new low-risk AGY slices use `execution_mode: "isolated"`, 1–10 exact `allowed_files`, explicit `context_files`, `deny_patterns`, and typed `validation_commands` (`program`, `args`, `cwd`). Declare `depends_on: ["TASK-1"]` when predecessor output is needed. Unknown/cyclic dependencies are invalid.
- Multiple AGY tasks require an all-isolated worker graph. Architecture/security/migration/ambiguous/high-risk work stays with Codex outside that graph; do not mislabel risky work as low risk. Existing shared plans remain compatible but retain a single AGY slice.
- Overlapping write/read-context scopes wait in deterministic dependency order. Do not remove ownership checks or merge competing edits by last-writer-wins. The adapter currently dispatches serially; do not claim parallel throughput.
- Resolve the worker model from configured capability evidence and `agy models`; model examples are not proof of availability. No silent fallback to another model.
- Private workers start from source snapshots without copying `node_modules`, authority credentials or the source AGY project binding. For a single-package npm project with an immutable package.json/package-lock.json, declare `dependency_mode: "npm-ci"`. The controller installs in private cwd with lifecycle scripts disabled, records a dependency fingerprint, and checks it on resume/QC. Shrinkwrap, workspace projects and escaping local dependencies are rejected by this mode. If a build requires lifecycle/native setup or another package manager, resolve that capability before spending a live attempt; do not switch to shared writes to hide it.
- Use `omni_dual_status` and `omni_dual_resume` (or `omni dual status/run/resume <task-id>`). Direct legacy `omni dual phase` is not a bypass for an authority task.

## Act on observable task state

| State/evidence | Controller action |
|---|---|
| Active AGY lease | Coordinate/read status; no source/build/browser writes and no duplicate worker launch. |
| WAITING_FOR_DEPENDENCY / WAITING_FOR_SCOPE | Finish/QC the predecessor; wait is not failure. |
| NEEDS_CONTEXT / pending_questions | Answer from the user's decisions or repository; ask the user only for a genuinely missing decision. |
| AWAITING_CODEX_QC / isolated handoff | Inspect semantic evidence, then request independent isolated QC. |
| NEEDS_FIX / FAILED / last_outcome | Inspect preserved attempt artifacts, then request bounded correction if safe. |
| CONFLICT | Preserve user and worker versions. Resolve source/context disagreement; never blindly overwrite. |
| Partial integration journal | Resume its integration/recovery; a new correction attempt is refused. |
| Expired unreleased lease | Verify actual process ownership/termination before recovery; expiry is not proof the worker stopped. |

## Exact MCP calls

Use the current `workspace_root`, `session_id`, task ID and `plan_revision` from status. IDs below illustrate a task named `TASK-1`; do not reuse another session's values.

Reply and resume through `omni_dual_resume`:

```json
{
  "workspace_root": "<current canonical workspace>",
  "session_id": "<current session>",
  "context_reply": {
    "task_id": "TASK-1", "plan_revision": 1,
    "message_id": "reply-1", "reply_to": "<pending question message_id>",
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

For isolated QC, call `omni_dual_completion` with `isolated_qc: {"task_id":"TASK-1","plan_revision":1}` plus current workspace/session, or `omni dual qc TASK-1 --json`. Keep `isolated_qc` separate from quality/UI evidence. The daemon runs exact registered validators, rechecks private evidence, integrates under Codex authority, and records task completion only with valid integration evidence.

## Completion and evidence

### Incident prevention: source binding, dependencies and external tools

- Keep source `agyProjectId` and global project mappings intact. The daemon passes source binding separately; only shared execution selects that project. Isolated workers never inherit it. Explicit unsafe worker flags remain rejected.
- Bootstrap checks declared npm-ci inputs and any existing dependency tree after typed setup, before authority dispatch. This is diagnostic preflight, not a private dependency receipt: isolated install and verification still run independently.
- Dependency fingerprints use at most 1 MiB read buffers, with 256 MiB/file, 1 GiB total, 50,000 files and 64 directory levels. Lifecycle scripts remain disabled. A resource error is preparation failure, not an AGY model failure; do not replace the project's linter automatically.
- A failed task with no active/expired worker and no independent runnable task stops the AUTO continuation loop with correction guidance. Preserve the failed attempt and ledger; do not stop the daemon to evade scope enforcement or remove bindings manually.

Stitch mutations need an explicit exact `external_operations` grant on a Codex/shared task. Example (illustrative title, not permission to create a real project):

```json
"external_operations": [{
  "tool_name": "mcp__stitch__create_project",
  "tool_input": { "title": "Approved design project" },
  "evidence_file": ".omni/sdlc/stitch-reference.json"
}]
```

The evidence file must already be in `allowed_files` and outside `deny_patterns`. It is a scope anchor, not fabricated proof of remote success. Input is exact bounded JSON (16 KiB, 16 container levels); there are no wildcard arguments or blanket MCP permissions. The daemon reserves a grant durably before allowing one invocation; repeated PreToolUse is denied even after a lost response/restart. PostToolUse records observation only. Inspect the remote state before requesting new authority after uncertain effects. Normal Codex ROUTED interactive authority is retained; active or expired unrecovered AGY leases block external mutation.

Do not invent a local path field in provider tool arguments. Provider IAM/OAuth permissions remain independent. Grants must be known before immutable plan registration: if later operations require newly returned project/screen IDs, prepare that external design phase before freezing the implementation graph, or stop for an explicitly authorized follow-up plan. Never edit an active plan or grant yourself wildcard access to work around unknown IDs.

Read bounded semantic artifacts/status first, raw stdout/stderr only to diagnose a failure or correlation mismatch. Worker prose is not completion evidence.

TASK_VERIFIED is not session VERIFIED. Record three real quality cycles and required UI evidence on the integrated project through `omni_dual_completion`, then inspect the session receipt. Never fabricate command output or infer visual QA from static checks. A green simulated-worker suite does not qualify live AGY, platforms or release packaging.

If transport observation times out, inspect the same daemon/lease/attempt; do not launch another process just because the previous response was lost. Preserve all evidence and report the exact missing capability/authority when safe progress truly requires the user.

For a recorded dead controller before any child spawn, `omni_dual_resume` accepts `recovery: {"task_id":"TASK-1","plan_revision":1}` plus current workspace/session. Recovery discovers recorded PIDs itself; never supply PIDs or edit locks. `WAITING_FOR_PROCESS`, `NEEDS_PROCESS_EVIDENCE` and `NEEDS_PROCESS_TREE_EVIDENCE` do not resume execution. A direct worker PID's death is not proof that detached descendants are gone; this case remains a safety stop until tree-level evidence is available. Normal delayed-close cleanup preserves the lease until the tracked child closes, then completes the deferred release.
