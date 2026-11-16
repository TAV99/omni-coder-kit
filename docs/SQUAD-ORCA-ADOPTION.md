# What omni squad takes from Orca (post-3.2.0 plan)

Source: the Orca (stablyai/orca) analysis in session `de33aa78`, re-checked on 2026-11-11 against branch `3.2.0` after P7 closed. Every item below gives its evidence in this repo. None is implemented yet.

## Already covered by P7: do not redo

| Orca idea | Where squad has it now |
|---|---|
| Dispatch fencing (dispatch/pane/launch token) | Lease + operation chain, `assertOperationAuthorized`, reclaim only on `confirmedDead` (`lib/dual/isolated-authority.js`) |
| `unknown` as a first-class state | Unresolved operations stay unresolved (A-04/D-02/A-08); `NEEDS_PROCESS_EVIDENCE` (`lib/dual/authority-store.js:504`) |
| Idempotent mutations | Inbox UUID + sha256, `DUAL_INBOX_CONFLICT` |
| Per-worker isolation | Private worker workspace + macOS source-write fence (C-08 fix, C-09 PASS 10/10) |
| Prompt/payload budget computed up front | Review planner sends the complete diff in one compact body, splitting under 16 KiB; discussion envelope 32 KiB |
| Usage-limit failure classification | `WAITING_RUNTIME` via the runtime's own `classifyWorkerFailure` (P7e, claude + codex) |

## Real gaps, in priority order

### O1. Classify the timeout branch and discussion turns too (small, high value)
- **Evidence.** In `lib/dual/orchestrator.js` (~line 1198), the `result.timedOut` branch counts a technical attempt and retries without asking the runtime. Only the contract-failure branch calls `classifyWorkerFailure`. HANDOFF §12 states "Discussion-relay turns are not classified yet".
- **Orca.** Classify first; the breaker counts only real technical failures.
- **Change.** Run the same `classifyWorkerFailure` verdict before counting a timeout. Wire the discussion relay (`lib/dual/discussion/live-*-invoke.js`) to `WAITING_RUNTIME`. A usage limit then never consumes the 3 attempts.
- **Done (2026-11-11), discussion part.**
  - The claude and codex discussion adapters attach the runtime's own `classifyFailure` verdict (`runtimeVerdict`) to a failed turn.
  - The relay exposes it as `runtime_verdict`, but only on a correlated `failed` observation.
  - `runDiscussionPhase({ runtimeWait })` waits and asks again without spending its one failed retry.
  - The orchestrator passes the isolated authority's bounded `runtimeWait` (ledger `task.runtime.waiting`/`resumed`).
  - Tests: `test/dual-discussion-phase-bridge.test.js`, `test/dual-discussion-live-adapters.test.js`.
- **Not done, on purpose.**
  - Timeouts. Claude writes its result envelope only when a turn ends, so a timed-out turn carries no observed limit signal. Classifying it would be a guess (P7 §6.1: "Do not guess").
  - Codex's real usage-limit stream (P7f dual-12) has no conversation id. The adapter therefore settles it `unknown` and it goes through the existing reconcile path. Correlation is not relaxed to make it wait.
  - The verdict is not journaled, so a relay rebuilt after a crash falls back to the ordinary failed retry.

### O2. Typed `next_action` on every orchestrator receipt (small)
- **Evidence.** `next_action` is set in one place only (`lib/dual/mcp-server.mjs:421`). Stop-hook messages are free text.
- **Change.** Add a shared enum (`request_correction | block_exhausted | wait_runtime | ask_human | integrate | none`) to `omni_dual_status` and `omni_dual_completion`. Claude and codex orchestrators then stop inventing recovery paths, which was the main source of P7f fixes.
- **Done (2026-11-11).**
  - `lib/dual/next-action.js` holds the `NEXT_ACTIONS` enum. It is the one derivation, moved out of `lib/commands/dual.js`, so `omni dual status` and MCP agree.
  - `omni_dual_status` returns `tasks[id].next_action` and a session-level `next: { action, task_id? }`, in this order: human gate (`relay_gate_to_human`), then blocker, then the most urgent task, then `evaluate_completion`.
  - `omni_dual_completion` returns `next_action`:
    - isolated QC maps its status;
    - `NEEDS_FIX`/`CONFLICT` → `check_task_status`, because only status knows whether attempts are spent.
  - Tool descriptions tell the orchestrator to follow it and to relay gates, never approve them.
  - Tests: `test/dual-next-action.test.js`, plus assertions in `test/dual-mcp-server.test.js`.
- **Not done.**
  - The Stop-hook context line (`hook-bridge.js deriveOwnerAndAction`) keeps its prose.
  - The controller workflow template does not mention `next` yet. Changing the prompt calls for a live run first.

### O3. First-run trust prompts (UX, seen 2026-11-11)
- **Evidence.**
  - The claude orchestrator in `omni ui` opens on the "Do you trust this folder?" dialog.
  - HANDOFF §12: a codex orchestrator needs the project trusted, plus one sandbox escalation.
- **Change.** `omni squad doctor` (and `omni ui` before autoStart) reports an untrusted project for each runtime, with the exact one-time command or flag. The user still decides. omni never edits the CLI's trust store.
- **Done (2026-11-11).** `lib/squad/trust.js` is read-only and checks only the orchestrator runtime, because headless `-p`/`exec` turns show no prompt.
  - **claude.** It reads `projects[key].hasTrustDialogAccepted` from `~/.claude.json` (or `$CLAUDE_CONFIG_DIR`).
    - Inside git, the key is the main repository root.
    - Outside git, a trusted parent folder covers the project.
    - Source: code.claude.com/docs/en/permissions.
  - **codex.** It reads `[projects."<path>"] trust_level` from `config.toml`, by exact match on the folder, the git root or the main checkout root.
    - An explicit `untrusted` wins.
    - A folder with no git and no `.codex` needs no trust.
    - Source: codex-rs `decision_for_dir` and `resolve_root_git_project_for_trust`.
    - A config form the small reader cannot parse reports `unknown`, never `trusted`.
  - **Where it shows.**
    - `omni skills doctor` warns `SQUAD_RUNTIME_UNTRUSTED` or `SQUAD_RUNTIME_TRUST_UNKNOWN`.
    - `omni ui` prints a line explaining the prompt the orchestrator pane will show.
  - **Tests.** `test/squad-trust.test.js`, `test/squad-doctor.test.js`.
  - **Not done.** The codex sandbox-escalation approval for `omni dual bootstrap` (HANDOFF §12) is a separate one-time prompt and is not checked.

### O4. Recover a lease stranded by host sleep (medium)
- **Evidence.** HANDOFF §12, known limits: sleep during a worker lease leaves `NEEDS_PROCESS_EVIDENCE` forever.
- **Orca.** `stop_unknown` has an explicit operator action (`worker-abandon`), separate from kill.
- **Change.** Add a human-only `omni squad abandon <task>` (TTY, like approve) that records an `abandoned` fence event. It does not claim the process died. The task can then be re-dispatched with a new lease, and the old process stays fenced out.
- **Decision (user, 2026-11-11): prevention first (option A).** The abandon command (option B) would be the ledger's first settlement from a person's word instead of process evidence. It stays unbuilt until it has its own spec and a live run.
- **Done (2026-11-11).**
  - `lib/dual/sleep-guard.js` keeps one refcounted `caffeinate -i -s -w <daemon pid>` on macOS while any worker lease is held.
  - `executeIsolatedAuthorityTask` acquires it right after `acquireLease` and releases it with the heartbeat, on success or failure.
  - `-w` ends the assertion when the daemon dies.
  - The guard is best effort and never blocks a lease. Opt out with `OMNI_SLEEP_GUARD=off`.
  - It cannot prevent a lid close or an empty battery (the 1% case).
  - Tests: `test/dual-sleep-guard.test.js`. On this Mac the isolated suites (142 tests) started a caffeinate and left none behind.

### O5. Agent status channel for `omni ui` (later)
- **Orca.** Hooks first, with OSC 7501 as the fallback, giving `blocked: permission|question|auth`.
- **Change.** The watchdog and UI read claude/codex JSONL events for "waiting on permission" so they can tell it apart from "stalled". Do this after O1–O4. It needs a check of what the adapters parse today.

## After the omni-p8-test run (2026-11-15)

Re-read against Orca `3036ed0d` (2026-11-14), `skill-guides/orchestration/` and
`src/main/runtime/orchestration/`. Each row is a gap that cost a session in
`docs/P8-TEST-RUN-FINDINGS.md`.

| omni gap (p8 evidence) | What Orca does (evidence) | Candidate change |
|---|---|---|
| **O6. A correction starts from the baseline (F16).** Attempt N+1 gets a fresh workspace and fresh conversations; c3b7f3cb/4c2bc1ae carried work only because the worker read the old attempt by absolute path. | A fix goes to the same worker: `send` to a finished worker becomes a follow-up Task on the same agent and workspace (`db/dispatch-context/worker-follow-up-plan.ts`: the follow-up inherits the predecessor's resource through `follow_up_of_dispatch_id`). The guide: "Send fixes to a worker." | Seed attempt N+1's private workspace from attempt N's candidate for review-driven corrections (not for harness failures), keeping the baseline fence. Optionally reuse the discussion conversation. |
| **O7. One budget for quality and technical failures.** Three attempts covered review NEEDS_FIX, chunk blindness and queue expiry alike; c3b7f3cb spent its last attempt on a harness expiry. | The breaker counts only failed starts: `DISPATCH_CIRCUIT_BREAK_FAILURES = 3` advances in `failDispatch`; "A worker's own failed report does not advance that count" (`references/recovery-and-cleanup.md`). | Count harness failures separately from review-driven corrections, so a quality loop is bounded on its own and a harness fault never ends it. |
| **O8. An exhausted or BLOCKED task needs a new session.** Five re-bootstraps, each redoing scout and coverage approval. | After the breaker, only an explicit user request may reopen the **same Task** in its Run (`task-update --status ready`); "this fresh series starts at zero"; history and the broken count stay; never route around it with a new Run. | A human-only `omni dual task reopen <task>` that keeps plan, receipt and coverage approval and starts a new attempt series, with the old attempts kept in the ledger. |
| **O9. No retry for a reviewer that failed before its verdict.** 4c2bc1ae: Codex exited non-zero in 5 s with the handoff intact; the only path was a correction. | A reviewer is an ordinary worker Task, retried with `worker-start --task <id> --retry-of <dispatch>` against the breaker. | Retry independent QC on the same handoff when the reviewer produced no verdict (exit before contract), within the review budget; keep its stderr. |
| **O10. Messages expire in the queue (F15).** The relay discarded a reply that landed 1 s after a 300 s TTL. | Mail has no expiry: a working worker gets a message "when its current turn ends" (`orchestration.md`); staleness is decided by dispatch identity, not by the clock. | F15 (900 s plus one retry) is the stopgap; consider dropping TTL as a failure cause for phase questions and keeping only authority staleness. |
| **O11. Contradicting operator messages (4c2bc1ae).** A stale "retry review" arrived after the orchestrator had moved to attempt 3, so it blocked. | Every receipt carries `next`; the coordinator handles a whole `check` batch before the next, and recovery acts "only on proof". | Show the current `next` (task, attempt, action) in `omni ui` beside the orchestrator pane, so the user writes against the current state. |

### O6 spec: a quality correction continues the previous candidate

- **When.** A correction whose previous attempt failed on a worker-quality cause:
  `classifyFailure` gives `category: 'worker'` (QC findings, a worker review NEEDS_FIX,
  a malformed result). Harness and unknown failures still start from the baseline.
- **What.** Attempt N+1's private workspace is prepared from the source as before.
  After its `worker-baseline.json` and `original-workspace.json` are written, each
  allowed file takes attempt N's content and mode (verified through attempt N's
  binding); one attempt N deleted is deleted. Generated outputs are not carried.
- **Why after the baseline.** The review diff and the integrated result are measured
  against that baseline, so carried files are ordinary candidate changes: reviewed in
  full, fenced, integrated only through QC.
- **Told to the worker.** `correction_context.carried_from_attempt` and
  `carried_files`, next to the rejection `findings` (F9).
- **Fallback.** A missing or unverifiable attempt N workspace carries nothing.

### O7 and O8 as built (2026-11-16)

- **O7.** A watchdog stall on a run whose lease expired under it is harness `lease_lost`
  once settlement is proven. The default recovery policy applied with a harness
  correction is worker 2, harness 2, total 4. Not done: counting only failed starts as
  Orca's breaker does; harness faults still have a finite budget of their own.
- **O8.** `omni dual task reopen <task> --reason …` is a terminal-only, typed-confirmation
  command, with no MCP tool. It appends `task.recovery.reopened` (`approved_by: user`)
  for the current failed, released attempt of an executing session. That grants one
  correction with `budget_class: user`, whatever the classification, and the attempt and
  budget series restart after it; earlier attempts stay in the ledger. `next_action`
  sends exhausted or unclassified failures to the person instead of blocking.
  Not done: reopening a session that is already `BLOCKED`.
- **One orchestrator per project.** `omni ui` holds `.omni/runtime/ui/ui.lock` (Orca: one
  current coordinator per Run).

Already aligned: silence or a timeout never proves exit (Orca's guide, omni's
`NEEDS_PROCESS_EVIDENCE`); a guarded stop is not a proof of stop.

## Not adopted
- Nesting depth 4 (squad stays depth 1).
- PTY as the control path (squad stays headless; the PTY is only for the human orchestrator view).
- Wake-instead-of-poll (would replace the Stop-hook model; too large).
- Orca's 46-migration SQLite schema (squad keeps the ledger).

## Order of work
O1 → O2 → O3 → O4, each as its own sub-phase:
- spec note here;
- `node:test` regressions that fail before the fix;
- normal + loaded `npm test` green;
- one Conventional Commit per item.

O5 waits for a decision after O4.

## Live verification (2026-11-11)

Harness: `OMNI_SQUAD_LIVE=1 node test/squad-agent-acceptance.js <out> --preset squad --delegate-all-gates`. Orchestrator and worker are claude sonnet, the reviewer is codex, and there are 4 bookshelf tasks. Evidence is under `~/.omni/orca-20261111/`.

### squad-1 (HEAD `732f74b`): stopped stuck after 30 min, 4 tasks ROUTED

Two pre-existing MCP bugs blocked the spec coverage gate:
- `omni_dual_coverage_inspect` always returned `DUAL_MCP_RESPONSE_TOO_LARGE`. The gate was 8.3 KB, but MCP sends it as both text and structured content, which went past 16 KiB.
- The orchestrator therefore guessed the approve submission. It put a path in `workspace` instead of the `workspace_id`.
- `omni_dual_coverage_approve` then reported `STALE_COVERAGE` as an opaque `DUAL_MCP_ERROR`. The code was not public, and the message contained a slash, so it was dropped.
- Fixed in `4fc1b8a`: inspect is compact and adds `approve_with`, and coverage refusal codes are public.

### squad-2 (HEAD `4fc1b8a`): PASS 4/4 in 12 min

- Requirements 4/4: every hidden test passed (T01, T03, T06, T09).
- Scope: no file changed outside the allowed set. Nothing unsettled. Every task reached `TASK_VERIFIED` at attempt 1.
- **O2 live.** `omni_dual_status` returned `next_action` (38 occurrences in the transcript).
- **Coverage fix live.** `COVERAGE_APPROVAL_CONFLICT` reached the orchestrator with its actionable text. It waited for the reconnaissance lease to end, then approved.
- **O4 live.** macOS power log: the guard's `caffeinate -i -s -w` (PreventUserIdleSystemSleep + PreventSystemSleep) held during a lease and ended with it.
- **Not exercised by this run:**
  - O1, because no usage limit was hit;
  - O3, because the temp workspace is projectless for codex, claude ran headless, and doctor is not run by the harness.
