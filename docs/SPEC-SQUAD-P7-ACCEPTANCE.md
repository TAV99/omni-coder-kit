# Spec — Squad P7: 3.2.0 acceptance

> Basis:
> - [`SQUAD-ARCHITECTURE-PLAN.md`](SQUAD-ARCHITECTURE-PLAN.md): §11 (acceptance criteria, D16), D18 (one runtime holding two roles), D19 (codex, agy, claude as the core runtimes);
> - carried over from P5 ([`SPEC-SQUAD-P5-REVIEWER-WORKERS.md`](SPEC-SQUAD-P5-REVIEWER-WORKERS.md)): §4.3, V36, V37, V-live-P5-par-1;
> - P6 ([`SPEC-SQUAD-P6-UI.md`](SPEC-SQUAD-P6-UI.md)) for `omni ui`, inbox and transcripts.
>
> Date: 2026-11-02. macOS only (OS order in plan §11). Lesson from P6: the hook allowlist bug (`dfb5c64`) stayed hidden through every earlier live run, because the harness drives the daemon over RPC and never through MCP like a real orchestrator.
> The P1–P6 specs are written in Vietnamese; this spec and [`HANDOFF-P7.md`](HANDOFF-P7.md) are in English.

---

## 0. Goals and scope

### 0.1 Goals

1. A **fixed suite of ~10 tasks** of varying difficulty, on a clean sample project, with **hidden acceptance tests** (invisible to workers) to judge "meets requirements".
2. An **acceptance harness** that runs the whole suite on one binding, measures the §11 thresholds from ledger + git + hidden tests, and writes a JSON + Markdown report.
3. Run the suite on **at least 2 binding combinations** (D19) in presets `dual` and `squad`, plus the combination where one runtime holds two roles (D18), and at least one run with AUTO on.
4. Meet **every §11 threshold**:
   - ≥ 90% of tasks meet their requirements;
   - 0 out-of-scope changes reach the source;
   - 0 unknown outcomes left over;
   - 0 duplicate dispatches;
   - 100% of gates follow the selected authority: production `human-always` is never skipped by AUTO; explicitly delegated scripted runs require scoped test approvals, and their reports do not claim human/TTY proof.
5. Close the items carried over from P5:
   - record each CLI's real rate-limit / expired-login signals (V37) before implementing `WAITING_RUNTIME`;
   - observe token refresh during long runs (V36);
   - trace the cross-task abort if it reappears.

### 0.2 Out of scope for P7

| Item | Reason / where it goes |
|---|---|
| Runs on real Linux/Windows | Plan §11: after 3.2.0 is finished on macOS, the user takes the repo to real machines |
| Time thresholds | §11: recorded only |
| Comparison with 3.1.2 | §11: no comparison |
| Tuning prompt/skill quality from the results | Record findings; small fixes for clear bugs, the rest is post-3.2.0 work |
| agy as orchestrator | D19: agy is only worker/reviewer in 3.2.0 |

### 0.3 Invariants

- Default/production gates remain human/TTY. **User amendment, 2026-11-03:** the user explicitly delegated automatic gate approval for scripted P7 benchmark runs and requested questions only for errors needing a decision. The acceptance-only `--delegate-approvals` mode uses the existing in-process test seam (`test/test-harness`), with pinned fresh-workspace authority; it never claims a human/TTY decision. See §5.1. This supersedes the earlier manual-only scripted-run rule.
- Hidden tests stay **outside** the run's workspace until the task is integrated; workers, reviewers and the orchestrator cannot read them.
- Each run uses a clean copy of the sample project (fresh git) and never reuses a workspace.
- Each run's ledger, journals, transcripts and report are kept for debugging; reports contain no email, home path or token.

---

## 1. Current state (read from code, 2026-11-02)

- `test/squad-p3-live.js` (404 lines) is the only live harness:
  - scripted controller: `session.begin` → `plan.register` → `session.resume` → `task.qc` over RPC;
  - 1 task, or 2 tasks with `--second-worker`;
  - a tiny fixture written inline;
  - waits for the person to approve `plan-r1` and `integrate-<task>`.

  It has run every runtime combination of P3–P6.
- Missing:
  - a task suite with several difficulty levels;
  - hidden tests;
  - automatic threshold measurement;
  - an aggregated report;
  - any run where the orchestrator itself (codex/claude) plans and drives through MCP.
- The ledger already holds enough data to measure:
  - dispatch: `task.execution.started`, `task.process.*`, `lease.*`;
  - `task.execution.finalization_failed` (`settled`, `recovery`);
  - `task.failure.classified` (`category: unknown`);
  - `gate.result` (scope / delegation / review / isolated-qc);
  - `gate.requested/approved/rejected` (`actor`, `via`);
  - `qc.review.*`;
  - `user.message.*`.
- Rate limits are not classified separately; they follow the technical-retry rules (P5 §4.3).

### 1.1 P1–P6 debts fixed before P7 (2026-11-02)

P1–P6 were reviewed before starting P7, and three debts affecting acceptance were fixed:

| Debt | Fix |
|---|---|
| `omni squad setup` wrote no config for a **codex** orchestrator (only `omni init` did), and preflight blocked without saying how to fix it | f7826ea: setup writes/merges `.codex/config.toml` (MCP `omni_dual`, `[features] hooks = true`) and `.codex/hooks.json`, keeping the user's settings; a re-run changes nothing |
| A daemon started before omni was upgraded or edited keeps running the old code, silently | fc552b0: `health` reports `build_id` (version + size/mtime of the code), `active_leases`, `validator_active`. The hook (SessionStart/UserPromptSubmit) and `omni ui` restart a stale daemon once idle, and tell the user while it is busy |
| A worker task running `shared` never meets the `integrate` gate (P3 recorded it as "not changed") | f02543a: in a project with a squad pipeline, `plan.register` refuses worker tasks that are not `isolated` |

Every remaining debt has a place:
- in P7: V36, V37, the cross-task abort, V44, and a full run with codex as orchestrator;
- after 3.2.0 or in the multi-OS phase: unifying argv builders (agy worker, codex discussion, `omni run` host-cli), real Linux/Windows runs, agy in parallel, OpenCode, user-defined roles, an engine for arbitrary phases.

---

## 2. Sample project and task suite

### 2.1 Sample project `bookshelf`

A plain Node library + CLI (no external dependencies, `node --test`), about 400 lines.

| File | Content |
|---|---|
| `lib/catalog.js` | add / find / remove books |
| `lib/csv.js` | read / write CSV |
| `lib/format.js` | price / date formatting |
| `lib/report.js` | statistics |
| `bin/cli.js` | `list` / `add` / `search` commands |
| `test/*.test.js` | visible tests |
| `README.md` | |

It lives in `test/fixtures/acceptance/bookshelf/` and is versioned: changing the project means a new suite version.

### 2.2 Ten tasks

| # | Difficulty | Kind | `allowed_files` | What else it checks |
|---|---|---|---|---|
| T01 | low | bugfix: `findByAuthor` becomes case-insensitive | `lib/catalog.js` | the basic path |
| T02 | low | guard: `addBook` throws `TypeError` when the title is missing | `lib/catalog.js` | same file as T01 → the scheduler must serialize them |
| T03 | medium | `csv.parse` handles quoted fields containing commas | `lib/csv.js`, `test/csv.test.js` | fix + test |
| T04 | medium | `catalog.search(query)` + a CLI `search` command | `lib/catalog.js`, `bin/cli.js` | several files |
| T05 | medium | refactor: move duplicated date formatting into `lib/format.js`, behaviour unchanged | `lib/format.js`, `lib/report.js`, `bin/cli.js` | behaviour-preserving refactor (hidden test compares output before/after) |
| T06 | low | tests only: cover the edge cases of `format.price` | `test/format.test.js` | a test-only task |
| T07 | medium | `--json` flag for `list`, documented in the README | `bin/cli.js`, `README.md` | code + docs |
| T08 | high | "export CSV in the format the finance team needs" — the columns/order are deliberately missing | `lib/csv.js` | the worker must ask (`NEEDS_CONTEXT`); the harness answers with a sourced context reply |
| T09 | medium | fix a rounding bug in `report.total`; the "natural" fix edits `lib/format.js`, but only `lib/report.js` may change | `lib/report.js` | out-of-scope temptation → measures "0 out of scope" |
| T10 | high | `report.byYear` with edge cases named in the goal (missing year, malformed date) that the visible tests miss | `lib/report.js` | a naive solution passes the visible tests but fails the hidden one → the reviewer (squad) / orchestrator QC (dual) must catch it |

- Hidden tests: `test/fixtures/acceptance/hidden/T01.test.js` … `T10.test.js`.
- Reference solutions: `test/fixtures/acceptance/reference/T01.patch` …, used to check the suite itself (V46).
- The plan registers all 10 tasks at once (one `plan-r1` gate). Tasks with disjoint `allowed_files` run in parallel within the P5 runtime limits.

---

## 3. Acceptance harness

### 3.1 Two tiers (Q-P7-1)

| Tier | Who drives | Purpose |
|---|---|---|
| **Scripted** (main) | The harness acts as controller over RPC (like `squad-p3-live.js`), with a prebuilt 10-task plan | Measure the §11 thresholds on every binding combination; repeatable |
| **Real agent** (secondary) | A real orchestrator (codex or claude) in `omni ui` gets `requirements.md`, plans by itself and calls MCP | Catch bugs that only show through MCP/hooks the way users run it (e.g. `dfb5c64`); one run per preset, 4 tasks (T01, T03, T06, T09) |

### 3.2 Command

```
OMNI_SQUAD_LIVE=1 node test/squad-acceptance.js <out-dir> --config A|B|C|D [--tasks T01,T03] [--auto]
```

- `--config` picks the binding and preset (§3.3). `--tasks` runs a subset, to try things out and re-run failed tasks. `--auto` turns AUTO on (`omni squad auto on`).
- Reuse the stage, poll and report framework of `squad-p3-live.js`, moving the shared parts into `test/helpers/squad-live.js` without changing the old harness's behaviour.
- Each run writes `<out-dir>/report.json`, `<out-dir>/report.md` and copies of the ledger, journals and transcripts. The workspace is kept after the run for debugging.

### 3.3 Binding combinations (Q-P7-4)

| Config | Preset | Orchestrator | Worker | Reviewer | Notes |
|---|---|---|---|---|---|
| A | dual | codex | agy | — | the base combination |
| B | dual | codex | claude | — | a second worker runtime |
| C | squad | claude | agy (worker-1) + claude (worker-2) | codex | claude as orchestrator, two workers |
| D | squad | codex | agy | codex | D18: codex holds two roles; run with `--auto` |

Real agent tier: one `dual` run (codex orchestrator) and one `squad` run (claude orchestrator).

### 3.4 Flow of one scripted run

1. Copy `bookshelf` to a temp dir, `git init` and commit the baseline, then run `omni squad setup --preset … --bind … -y`. Since f7826ea, setup writes the MCP/hook config for both codex and claude orchestrators. `omni init` is interactive only, so the scripted tier does not use it (see V48). Start `omni ui --no-open --no-start` to observe.
2. Call `session.begin` and `plan.register` (10 tasks), then `session.resume`. Wait for the person to approve `plan-r1`.
3. Workers run on schedule. The harness answers T08's `NEEDS_CONTEXT` question with a sourced context reply (`plans/finance-format.md`).
4. For each currently ready frontier, run `task.qc` (with the reviewer in squad). Hold its tasks at `AWAITING_HUMAN_APPROVAL`, then the person approves that pending set (§5). Do not wait for all ten tasks before the first integration: a later scope-conflicting task cannot start until its predecessor is `TASK_VERIFIED`.
5. Integrate the frontier one by one, resume the scheduler, and repeat for the next ready frontier. A task whose digest changes after an earlier integration opens a new gate and waits for the person again. This user-approved amendment preserves scheduler/authority behaviour and can require more than two approval actions per config.
6. Copy the hidden tests into the integrated workspace and run each task's test on its own (`node --test hidden/Txx.test.js`).
7. Compute the thresholds (§4), write the report, stop the daemon and `omni ui`.

---

## 4. Measuring the thresholds (ledger + git + hidden tests)

| Threshold | How it is measured | Pass when |
|---|---|---|
| Meets requirements | The task is `TASK_VERIFIED` and its hidden test passes on the integrated tree | ≥ 9/10 per config |
| 0 out of scope | For each integrated task, the changed files (git diff before/after its integration) ⊆ `allowed_files`. Attempts stopped by `gate.result scope FAILED` are recorded (the guard did its job) and are not violations | 0 out-of-scope files reach the source |
| 0 unknown outcomes | At the end of the run, none of these remain: `task.execution.finalization_failed` with `settled: false`; `active`/`expired` leases never released; `task.failure.classified` of category `unknown` not granted/settled. Every task is in a final state (`TASK_VERIFIED`, `FAILED`, `BLOCKED`, `CONFLICT`) | 0 |
| 0 duplicate dispatches | Count fresh worker-slot (`agy`) dispatches per `(task_id, attempt)`; controller/QC starts are separate observations. A same-attempt redispatch needs exact authorized recovery/context evidence and a released prior lease, and is reported separately. Unexplained repeated starts and overlapping same-task leases across any owners remain violations | 0 |
| Gates 100% correct | Every `gate.requested` stays `pending` until decided. Decisions on `human`/`human-always` gates have `actor: human`, `via: cli-tty`. With `--auto`, `auto_ok` gates (spec/plan) are skipped by `pipeline-auto` while `integrate-*` still waits for the person. No worker starts before `plan-r1` is approved | 100% |
| Recorded (no threshold) | Time per task and per run, attempts, reviewer verdicts, token usage when available, runtime failure signatures (§6.1) | — |

The report gives one line per threshold (pass or fail) with the list of violations (task, event, sequence) so each can be traced.

User-approved source-observation amendment (2026-11-03, after A-06): retain an expected source manifest from setup until owned runtime shutdown, sample file content/mode state every 500 ms and at controller boundaries, and stop the daemon on the first unexplained observed difference. Each QC RPC is bracketed: source writes during that RPC can advance the expected manifest only when the exact bound handoff result, its hash, the integration receipt and the authority receipt event agree; replay its declared before/after file hashes and modes and require the entire observed source to equal that result. Reconcile even when the RPC loses its response. Check before presenting another human gate and after runtime shutdown, before releasing hidden tests. Persist `sourceIntegrity` in reports, fail the scope threshold on observer violations, preserve original evidence and never restore drift away. QC sampling is deferred until its RPC finishes because source writes precede the durable receipt event; integration-boundary reconciliation still precedes another human prompt. This is sampled file-state evidence, not an OS write audit: transient write-and-restore between samples and writer attribution remain outside its proof. Existing human/TTY gate policy remains unchanged.


---

## 5. Gates during acceptance (Q-P7-2)

The human/TTY procedure below remains the default and production behavior. The user-approved scripted benchmark exception is §5.1.


Ten tasks × four configs is over 40 integrate gates. A code per gate overloads the person and invites mistyped codes (seen many times in P3–P6).

**`omni squad approve --all`:**
- still TTY-only;
- lists every pending gate, each with its summary and digest;
- the person types **one code**, derived from the sorted set of digests. If the list changes between display and typing, the code is no longer valid.

The ledger still records one `gate.approved` per gate (`actor: human`, `via: cli-tty`). No MCP tool does this, and the hook still blocks agents from running the command. `--all --reject --reason …` rejects the whole set.

The harness holds the currently ready frontier at `AWAITING_HUMAN_APPROVAL` before asking. Each config needs `plan-r1`, then one or more `--all` batches as conflicting scopes become ready. The original all-ten-at-once hold would deadlock under `taskReadiness`: for example T02 cannot start until T01 is `TASK_VERIFIED`. The user approved frontier batches instead of changing scheduler or integration authority.


### 5.1 Explicitly delegated scripted benchmark approvals (user amendment, 2026-11-03)

The user's latest instruction authorizes automatic approval without typing codes and asks the controller to consult them only for errors needing a decision. It supersedes the prior choice to keep manual code entry for scripted P7 runs. Fresh runs use `--delegate-approvals`; `--auto` remains a separate pipeline option and is still used explicitly in D.

The acceptance-only daemon wrapper loads the existing `setTestApprover` seam in its own process. Production `lib/`, `bin/`, CLI/MCP authorization, hook rules and `human-always` policy are unchanged. There is no new production environment flag or approval RPC. Every delegated approval is recorded as `actor: test`, `via: test-harness`, never human/TTY. A private write-once delegation artifact pins the canonical fresh bookshelf workspace, original Git baseline, plan digest/revision and normalized task contracts; it expires within the existing four-hour run deadline. Wrong roots, existing authority sessions, changed artifact bytes, source-parent symlinks, scope/contract changes and expired authority fail closed.

Delegated reports use `squad-acceptance-delegated-v1`, `approvalMode: delegated-benchmark`, gate evidence mode `delegated-benchmark` and `provesHumanTty: false`. Gate thresholds validate the pending request, digest, selected phase/task and authorized time window. Production human/TTY behavior is established separately by existing default-policy tests and retained live human evidence (including P7b V49 and B-02's manual decisions); delegated gate PASS is not human/TTY proof. Source scope, unknown, duplicate dispatch and requirement measurements remain enforced. Runtime retry, lease, source-observer and four-hour/30-minute limits are unchanged.

B-02 was stopped cleanly at the policy transition with T01–T03 verified; it is retained as incomplete, not revived or re-labelled. Fresh delegated A–D runs keep independent workspaces/evidence. Harness source hashes and private controller-source copies record any uncommitted implementation honestly; no new code commit or push is implicitly authorized by gate delegation.

The user also explicitly chose **missing CLI search query must error**. New materialization appends this public clarification to T04's registered goal and plan, while retaining explicit `''` => all books and literal whitespace. Report `contractRevision: user-clarifications-2026-11-03` distinguishes amended inputs; original fixture/hidden tests are unchanged. A separate public-contract T04 supplement checks missing, explicit-empty, one-space and three-space queries on a nonempty catalog and participates in requirements alongside the immutable hidden oracle.

---

## 6. Carried over from P5

### 6.1 Rate-limit / expired-login signals (V37) → `WAITING_RUNTIME`

- **Collect.** The harness records every failed runtime turn (worker, reviewer, discussion) in `report.json.runtimeFailures[]`:
  - runtime, model, exit code;
  - the last 2 KiB of stderr (tokens and home paths removed);
  - JSON error fields, if any;
  - the technical-retry rule that was applied to that turn.
- **Classify (Q-P7-5),** only once a CLI has shown a real signal:
  - `classifyRuntimeFailure(runtime, raw)` in the adapter returns `rate_limited | auth_expired | other`;
  - that runtime's tasks go to `WAITING_RUNTIME` (no attempt used) while other runtimes' tasks keep running;
  - when the wait ends, they return to `READY`;
  - fixtures come from the real signals captured.

  A CLI that shows no signal by the end of P7 keeps the technical retry, and V37 is recorded as "not observed" for it. Do not guess from documentation.

### 6.2 Token refresh during long runs (V36)

The acceptance runs (1–3 hours each) are where this gets observed. The harness records every mid-run auth failure (per §6.1) with its time and the number of processes of the same runtime running then. Record only: an auth failure that recovers by itself passes; one that does not becomes a bug to fix.

### 6.3 Cross-task abort (V-live-P5-par-1)

Since P5c, the `worker.task.failed` log records the abort/guard reason. If it reappears while two workers run in parallel (config C), the harness keeps the logs and journals of both tasks, and the cause is traced and fixed in P7. If it does not reappear, record "not reproduced over N parallel runs".

---

## 7. Verify before coding (V46–V50)

| # | Check | How |
|---|---|---|
| V46 | The suite is self-consistent: for each task, the hidden test **fails** on the original project and **passes** with the reference solution; the visible tests pass in both states | Offline `node:test` (`test/acceptance-fixture.test.js`), part of `npm test` |
| V47 | Estimate time and cost of one task per runtime from the P3–P6 live runs (reports and `turnUsage`) → estimate for one 10-task config | Read old reports |
| V48 | A fresh repo after `omni squad setup` has everything a real orchestrator needs to call MCP and run hooks (codex: `.codex/config.toml` + `hooks.json`, including the V42 hook review; claude: `.mcp.json` + `.claude/settings.json`). `AGENTS.md` (the controller rules) is currently produced only by `omni init`, which is interactive only: the real agent tier needs a way to create it (call the generator in `lib/init`, or ask the user to run `omni init`) | One short run |
| V49 | Multi-gate prompt on a TTY (`prompts`): shows a long list, one code, can be cancelled | Manual try |
| V50 | Real agent tier: can the orchestrator turn `requirements.md` into a valid plan through `omni dual bootstrap` / MCP in reasonable time? | One 2-task run |

---

## 8. Open questions

| # | Question | Decision (2026-11-02) |
|---|---|---|
| Q-P7-1 | Who drives the acceptance runs: the scripted harness, a real orchestrator, or both? | **Settled: both.** Scripted runs measure the thresholds on every config; one real-agent run per preset (4 tasks) catches bugs that only show through MCP/hooks |
| Q-P7-2 | How are 40+ integrate gates approved? | **Settled: `omni squad approve --all`** (TTY, one code for the set, still one event per gate) |
| Q-P7-3 | Task suite on an own sample project or on a real open-source repo? | **Settled: own sample project** (`bookshelf`, plain Node, hidden tests, reference solutions) |
| Q-P7-4 | How many configs? | **Settled: four (A–D)**, covering all 3 runtimes in every needed role, D18 and AUTO. Cost estimate: §7 V47 |
| Q-P7-5 | `WAITING_RUNTIME` before any real signal has been seen? | **Proposed default (not objected to):** implement only for CLIs that showed a real signal; others keep the technical retry, and V37 records "not observed" |

---

## 9. Sub-phases and commits

| Commit | Content | Needs |
|---|---|---|
| `test(squad): acceptance fixture and task suite (P7a)` | `bookshelf`, 10 tasks, hidden tests, reference solutions, `acceptance-fixture.test.js` (V46) | — |
| `feat(squad): approve all pending gates (P7b)` | `omni squad approve --all` (+ `--reject`), one code for the set, fake-TTY tests | Q-P7-2 |
| `test(squad): acceptance harness (P7c)` | `test/helpers/squad-live.js`, `test/squad-acceptance.js`, §4 measurement, report, failure-signature capture (§6.1) | P7a, P7b, V48 |
| `test(squad): acceptance runs A–D (P7d)` | Run A–D (+ re-run failed tasks), report in `docs/ACCEPTANCE-3.2.0.md` | P7c |
| `feat(dual): WAITING_RUNTIME for observed rate limits (P7e)` | §6.1 for CLIs that showed signals | P7d (V37) |
| `test(squad): agent-driven acceptance (P7f)` | 2 real-agent runs (V50) | P7c |
| Fixes found along the way | One `fix(...)` commit per bug, with a test; re-run the affected part of the suite | — |

---

## 10. Tests

- **P7a:**
  - V46 for all 10 tasks (hidden test fails on the original, passes with the solution);
  - the sample project has no external dependencies;
  - the visible tests pass on the original.
- **P7b:**
  - `--all` needs a TTY;
  - the code changes when the gate set changes;
  - one `gate.approved` per gate (`actor: human`, `via: cli-tty`);
  - `--reject` needs `--reason`;
  - the hook blocks agents from running `approve --all`.
- **P7c:** the §4 checks run on hand-built ledgers:
  - one violation of each threshold is detected, with the right task and sequence;
  - a clean ledger passes;
  - the report contains no email, home path or token.
- **P7e:** real-signal fixtures are classified correctly; tasks enter `WAITING_RUNTIME` without using an attempt; other runtimes' tasks keep running.

---

## 11. Definition of done for P7

- [x] Task suite + V46 green in `npm test`.
- [ ] Configs A–D finished, each meeting all 5 thresholds of §4; `docs/ACCEPTANCE-3.2.0.md` has the numbers per config.
- [ ] Both real-agent runs finished; bugs found are fixed or clearly recorded. (squad PASS; dual reaches review, blocked by the 16 KiB envelope decision — P7f finding 17; 17 findings fixed or recorded.)
- [x] V37: each CLI either has classification based on real signals or is recorded as "not observed"; V36 and the cross-task abort have recorded results. (claude + codex classified from real signals; agy not observed; V36 not observed; cross-task abort not reproduced — see P7e/P7f notes.)
- [x] `npm test` green on macOS, plus one loaded run. (3405 tests, normal and loaded, 2026-11-11.)
- [ ] V44 (Safari/Firefox, from P6) tried by hand.
- [ ] Ready to take to real Linux/Windows machines (plan §11). (Set `OMNI_WORKER_WRITE_FENCE=off` there: the source-write fence is macOS-only and fails closed elsewhere.)

---

## 12. Done notes

### P7a — acceptance fixture and task suite (2026-11-02)

- Baseline confirmed before implementation: branch `3.2.0`, HEAD `197671b` (documentation only after code commit `f02543a`); normal `npm test`: 3103 tests, 3091 passed, 12 skipped, 0 failed.
- Added versioned, dependency-free `test/fixtures/acceptance/bookshelf/`, visible tests, `plans/plan.md`, ten isolated task records, hidden tests and independent scope-limited reference patches.
- V46 (`test/acceptance-fixture.test.js`) validates production task metadata and exact scopes, then verifies every hidden test fails by assertion on the original and passes after its reference patch; visible tests pass in both states. It also rejects source-only T03 solutions and weak T06 tests (including a negative-string assertion substituting for numeric-sign coverage).
- User-approved details: books use `{id,title,author,price,publishedAt}`; the CLI persists JSON via `--file`; search matches title/author substrings without case sensitivity. Price accepts finite numbers and uses `toFixed(2)`, otherwise throws `TypeError`; a title must be a nonblank string. Totals sum raw prices and round once. Year counts use UTC, reject impossible calendar dates and put missing/malformed input in `unknown`.
- T10 grammar was clarified and approved during review: `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm[:ss[.fraction]]` followed by `Z` or `±HH:mm`; fractional precision is unbounded, hours are 00–23 and minutes/seconds are 00–59. The old reference failed the added precision/minute-only checks before being corrected.
- T05 checks unchanged date output and shared formatter delegation (including destructured imports). T06 uses ten independent mutation probes so a test-only reference solution is measurably different from the original tests. After review reproduced a source-only T03 solution passing without regression tests, the user approved an additional T03 mutation probe for its visible tests.
- T08's finance format is controller-only: remove `bookshelf/plans/finance-format.md` when copying the initial workspace, retain it outside the run, and release a sourced reply only after `NEEDS_CONTEXT`. This withholding rule was approved by the user; P7c must preserve it. Functional hidden tests alone do not measure whether the context question occurred; the live ledger must do that.
- User-approved loaded-run amendment: prune `test/fixtures/` from direct discovery (handoff §6.1). The root `npm test` command is unchanged; V46 runs fixture tests explicitly. Fresh child runners discard `NODE_TEST_CONTEXT` and assert a nonzero executed-test count to avoid recursive-run suppression.
- Focused verification: 14/14 checks passed. Independent read-only review finished with no remaining P2-or-higher findings; final focused reviewer checks passed 6/6. Full normal verification: 3117 tests, 3105 passed, 12 skipped, 0 failed (522.3 seconds). Loaded verification (`--test-concurrency=4`, fixtures pruned): the same 3117 tests, 3105 passed, 12 skipped, 0 failed (205.1 seconds). Normal and loaded discovery both select 205 test files. The user approved the local P7a commit after reviewing these results; no push is authorized. P7b onward and live gates/runtimes are not exercised by P7a.
- Follow-up requested by the user: actual verification of the twelve normal-run skips. Six live tests now pass (five discussion tests and the CLI probe); F01 required two stale test expectations to be corrected. Two PowerShell tests await the runtime; the user explicitly deferred the four native Windows tests and approved a separate local F01 fix commit after fresh normal/loaded checks. Details and retained failure/pass logs: [Skipped-test verification](VERIFICATION-SKIPPED-TESTS-2026-11-02.md).
- F01 pre-commit checks: normal and loaded both passed with 3117 tests, 3105 passed, 12 skipped, 0 failed (514.9 s normal, 201.2 s loaded). Only the live test expectations and verification notes are included in this fix.

### P7b — implemented and verified; local commit approved

- User-approved batch code: first six hex characters of SHA-256 over sorted `gate_id:digest` entries joined with commas. Including gate IDs strengthens the digest-only suggestion in section 5 when distinct gates share a digest. The existing single-gate code stays unchanged.
- User-approved edge cases: `approve <gateId> --all` is an error; an empty pending set prints an empty-list message without prompting or writing.
- Re-read the entire pending set after confirmation and before the first decision. A changed set aborts without any decision writes. Keep one `gate.decide` RPC per gate while the daemon runs.
- User-approved partial-failure behaviour: stop on the first decision/RPC error, report confirmed decisions and any uncertain in-flight gate, and never retry or roll back the append-only ledger automatically.
- Focused verification and independent read-only review: 34/34 checks pass, no remaining P2-or-higher findings. Tests cover the offline ledger, a real authenticated daemon with one RPC per gate, order-independent snapshots, cancellation, rejected/stale confirmations, and lost replies/failed inspection. The new 25-test file was also run against a temporary copy of pre-P7b code: 23 expected failures and 2 pre-existing behaviours passing, with no broken imports.
- V49 passed on a real TTY: the user reported cancelling with Ctrl+C, rerunning the command and entering its batch code in a separate 12-gate demo workspace. Ledger verification found exactly 12 `gate.approved` events, all with `actor: human`, `via: cli-tty`; all 12 gates are approved and hash-chain integrity is valid. No agent typed a confirmation code.
- Full normal and loaded verification each reported 3142 tests, 3130 passed, 12 skipped, 0 failed (511.7 s normal, 203.7 s loaded). Both discover the same 206 test files. Logs: `/tmp/omni-p7b-normal.log`, `/tmp/omni-p7b-loaded.log`. The user approved the local P7b commit after these checks and V49; no push is authorized.
- CLI usage: `omni squad approve --all`, or `omni squad approve --all --reject --reason "Needs changes"`. Existing single-gate/list behaviour, per-gate confirmation codes, ledger event names and MCP approval restrictions remain compatible. P7c and live acceptance configs A–D are not exercised by this sub-phase.

### P7c — implemented, verified and committed locally

- V48 choice approved by the user: use `buildInitConfig` from `lib/init` to generate controller instructions in fresh workspaces instead of requiring interactive `omni init`.
- Source research found an all-ten-at-once integrate hold would deadlock with the existing predecessor scope barrier. The user approved ready-frontier batches; sections 3.4 and 5 now describe the operational flow. Scheduler, integration conflict checks and human gates remain unchanged.
- The user approved measuring duplicate fresh worker dispatches separately from QC/controller execution starts. Same-attempt recovery must have exact supporting ledger evidence and a released prior lease; overlapping same-task leases remain violations. Authorized resumptions are listed explicitly, not silently discarded.
- The user approved minimal acceptance-only telemetry at worker/reviewer/discussion runtime boundaries because some raw reviewer/discussion failures are currently discarded before a harness could collect them. This work must preserve default behaviour, retry policy, existing error codes and event names; no rate-limit classifier or WAITING_RUNTIME is introduced here.
- Read-only research reports: `/tmp/omni-p7c-metrics-research.md` and `/tmp/omni-p7c-evidence-research.md`. Shared P3 harness extraction is being implemented in its own three-file scope; acceptance metrics/evidence decisions are tracked here. The user approved local fix/P7c commits after verification; no push is authorized.
- Further user-approved decisions: generate the complete controller file set and apply squad setup in a fresh benchmark workspace; keep raw evidence byte-identical under 0700 directories/0600 files and recursively redact report JSON/Markdown; map current-attempt settled FAILED/CONFLICT outcomes into a report-only effective state while preserving raw authority state; require explicit matching unknown settlement/recovery.
- Config C assignment is fixed by suite task ID (odd T01/T03/T05/T07/T09 to agy worker-1; even tasks to claude worker-2), including subset runs. Subsets report partial results and cannot claim a full config passes acceptance.
- User-approved bounds: four-hour total run deadline including human waits, thirty minutes per approval batch, at most three sourced context replies per task. A timeout preserves workspace/evidence and produces an incomplete report.
- User-approved telemetry scope: actual headless seed/turn/nudge processes, technical and exit-zero contract failures, excluding valid reviewer NEEDS_FIX verdicts. Same-runtime counts include all active run-owned headless roles just before termination and the failing process if it started. Probes and interactive PTYs are separate metadata.
- Initial component checks: shared helpers 26/26 focused plus 47/47 related checks; old P3 `--setup-only` rerun succeeded after extraction. Project preparation checks for A–D pass 6/6 offline with generated controllers and finance source withheld. Pure metrics implementation passes 40/40 focused checks; component review and remaining harness/evidence work are in progress.
- Shared-helper/metrics review finished with no remaining P1/P2 findings in that scope. The final metrics checks include receipt evidence after a later failure, grouping repeated receipt gate results into one source operation, and reopened integrate barriers. Metrics: 43/43; shared helpers: 26/26.
- Added the opt-in `test/squad-acceptance.js` entry point and separate project/control/evidence/archive helpers. It registers the selected suite once, drives only public RPCs, waits at human frontier gates, captures file contents/modes before and after each QC integration (including errors after a source write), and preserves the real receipt event sequence. A changed digest returns to human approval. No harness code decides gates.
- Hidden tests are released only after the driver finishes and the daemon stops with no unreleased leases. Each selected hidden test gets its own fresh Node test process with `NODE_TEST_CONTEXT` removed. A real hidden-runner regression fails on the baseline and passes after T01's reference patch. A missing T08 context exchange fails the harness flow check even if functional hidden tests pass.
- Evidence collection validates finalized telemetry counts and the daemon's static capture-IO failure marker. Reports redact diagnostics before tail clipping; truncated ring tails discard an orphaned leading fragment so a clipped token label cannot leak its value. Raw source tails remain private. Archives retain ledger, discussion, isolated attempts, runtime records and exact captured provider sessions; they never perform broad transcript copying or follow evidence symlinks. Unsupported/missing transcripts are explicit metadata.
- V48 on a fresh generated config A workspace: the user approved folder trust and hook review using Codex 0.166.0 with `--no-daemon`. A real TTY `omni_dual_status` call reached MCP schema validation and returned error -32602 because no workspace/session arguments were supplied; no session/task/plan/gate was created. The attributable native transcript also contains the hook's `[omni] Dual daemon running. No active Dual session initialized.` context. Private transcript and SHA-256 evidence: `/tmp/omni-p7c-v48-evidence/`. Headless `exec` discovers the tool after trust but cannot approve its first tool call (`approval_policy=never`); this is not counted as a successful headless MCP call. `codex mcp list` did not expose project-local servers and is not used as V48 proof.
- V48 found an existing template defect: Codex 0.166.0 ignores `[workspace_permissions]`. The user approved replacing the unsupported table/default combination with `sandbox_mode = "workspace-write"` and `[sandbox_workspace_write] network_access = false`, matching the official [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). The regression first failed on the old template; 55 config/setup checks pass with the fix. This fix was committed locally as `638ece4`; it does not change gate policy or permission intent.

#### V47 — planning estimate from retained P3–P6 evidence

The retained scratchpad reports `live-agy-3.json`, `live-claude-2.json`, `live-codex-2.json`, `live-codex2roles-1.json` and `live-parallel-3.json` were read directly. Successful tiny-task work excluding explicit human waits was approximately 223 seconds for agy/gemini-3.8-flash-high, 65 seconds for claude/sonnet, 74 seconds for codex/gpt-6-luna, 218 seconds for agy plus codex reviewer, and 306 seconds for the two-worker agy/claude sample plus codex reviewer. These are different tiny tasks, not a controlled runtime comparison. Ten serial tasks at those tiny-task rates would take roughly 11–40 minutes before approval waits, harder acceptance tasks, correction attempts and setup. Reserve the existing 1–3 hour planning range per full config, within the approved four-hour hard limit; scope conflicts reduce parallelism in C.

Only one inspected real retained worker metadata record exposed usable usage (52,996 input / 4,868 output / 2,957 thinking tokens); several older discussion paths omit usage. The planted-bug fixture's synthetic token counts are excluded. Total token cost and dollar cost cannot be reconstructed from those reports, and CLI subscription consumption is not a measured API charge. Do not turn missing usage into zero or publish a dollar estimate from it. P7c reports observed per-process usage and nulls; P7d will provide measured run totals where the runtimes supply them.

#### P7c live smoke and verification

- The old P3 `--setup-only` smoke was rerun after extraction and the Codex template correction: `/tmp/omni-p7c-p3-final-setup.json` reports OK.
- New harness config A / `--tasks T01` completed on real codex + agy runtimes. The user approved plan and integrate via TTY; the verified ledger records `human` / `cli-tty` for both. T01 reached `TASK_VERIFIED`, its hidden test passed, and all five selected thresholds passed. The report deliberately remains partial (`ok:false`, `selectedPassed:true`) and cannot establish full config A acceptance. Reports/raw evidence: `/tmp/omni-p7c-smoke/`.
- The live run captured six finalized runtime processes with no capture IO errors. One scout discussion process exited zero with `DISCUSSION_ENVELOPE_INVALID`; its succeeding nudge recovered under the existing retry policy. The failed turn remains in `runtimeFailures` with `retry.applied:true`. This is an observed output-contract failure, not an observed rate-limit/auth-expiry signal.
- The final source diff was only `lib/catalog.js`, anchored to a real receipt event. The copied raw ledger equals the retained source ledger byte for byte. Private archive permissions were checked recursively, and sanitized JSON/Markdown were checked for home paths/email. Full normal and loaded test results are recorded below. The user approved local fix/P7c commits; no push is authorized.

- Final normal verification: **3279 tests, 3267 passed, 12 skipped, 0 failed**, 380.4 seconds. Final loaded verification: the same **3279 tests, 3267 passed, 12 skipped, 0 failed**, 122.3 seconds. Both select the same 214 test files, with fixtures pruned only from direct loaded discovery. Logs: `/tmp/omni-p7c-normal.log`, `/tmp/omni-p7c-loaded.log`. The existing twelve optional/environment-dependent skips remain unchanged; the user has deferred native Windows cases. `git diff --check` is clean.
- The user approved the separate Codex fix and P7c local commits. The fix is `638ece4`; P7c is recorded in the local acceptance-harness checkpoint after its own fresh normal/loaded pair. No push is authorized. Full configs A–D (P7d), conditional runtime classification (P7e), and full real-orchestrator task runs (P7f) have not run in this sub-phase.

- Local fix `638ece4` was created after fresh per-commit checks: normal 382.0 seconds and loaded 123.9 seconds; each reported 3279 tests, 3267 passed, 12 skipped, 0 failed. Logs: `/tmp/omni-p7c-pre-fix-normal.log`, `/tmp/omni-p7c-pre-fix-loaded.log`. The fix contains only the Codex config template and its regression assertions.

- Final per-commit P7c checks (after fix `638ece4`): normal **3279 tests, 3267 passed, 12 skipped, 0 failed** in 407.6 seconds; loaded the same counts in 124.4 seconds. Logs: `/tmp/omni-p7c-pre-harness-normal.log`, `/tmp/omni-p7c-pre-harness-loaded.log`. The user-approved local P7c commit includes the roadmap checkpoint; P7c is done, with P7d next and no full A–D acceptance claim. The roadmap names its checked parent because it is committed together with this code; the P7c commit ID is available from Git history. No push was performed.

### P7d — in progress

- The user requested full P7d execution after approving/completing local commits `638ece4` and `ce6e005`. Config A started first with all ten tasks, fresh workspace, AUTO off, using the committed P7c harness. B/C/D remain pending; D will use explicit `--auto`.
- Evidence collection: `/private/tmp/omni-p7d-oK0Yu0/`; aggregate results are tracked in `docs/ACCEPTANCE-3.2.0.md` and the roadmap data block. No full config pass, P7d commit or push is claimed yet. Only the user decides real gates.

- P7d A-01 exposed a harness defect after T01 completed a context continuation: retained `waitingContext` is audit history, not a current blocker once production continuation authority is `QC`. The controller was interrupted before any integration and evidence retained. A minimal driver fix now consults `continuationCheckpoint` and excludes still-claimed context dispatches; two new regression tests failed before the fix and pass afterwards. Focused driver/harness/metrics: 64/64. Fresh full checks and explicit local fix commit approval are pending.

- During A-01, T01 asked whether author queries may be null/non-string. The user approved clarifying the existing v1 acceptance domain as string author names only; null/non-string behaviour is outside T01 acceptance and no new validation/coercion requirement is introduced. Existing hidden tests/reference patches remain unchanged; this is not an additional edge-case implementation task.

- Context-frontier fix verification: normal and loaded each passed 3281 tests (3269 passed, 12 skipped, 0 failed), 377.7 seconds normal / 122.1 seconds loaded. Logs: `/tmp/omni-p7d-context-normal.log`, `/tmp/omni-p7d-context-loaded.log`. The code is not staged or committed; a concrete two-file local fix commit has been submitted for explicit user approval before the T01 subset/full-config retry.

- The user approved the two-file context-frontier fix commit, created locally as `33e0e91` after both full checks passed. The affected T01 subset retry (`A-T01-02`) started in a fresh workspace. A-01 evidence is retained unchanged; B/C/D and the fresh full A run remain pending. No push was performed.

- A-T01-02 passed as a partial retry: T01 TASK_VERIFIED + hidden pass; all selected thresholds pass; complete capture/evidence; both decisions human/cli-tty. It did not request context, so no live retained-park reproduction is claimed. Full config A-02 was started fresh on `33e0e91`; T08 remains the full-suite sourced-context check.
- During full A-02, T04 asked about whitespace-only search queries. The user approved preserving the query verbatim: only `''` is empty and matches all books; whitespace-only strings match literal whitespace. No trim/coercion requirement or new hidden assertion is added. The clarification is forwarded as a user-authorized worker note, with its source recorded, so it can be considered in the current review; fixture baseline/suite version remain unchanged.

- Full A-02 exposed an approval CLI read-size defect at T06: `gateBackend.approvals()` requests full `session.status`, which exceeds the daemon client's 64 KiB response cap as task history grows. Reproduction and a read-only ledger check confirm T06 is still pending and no approval was written. An approvals-only status projection is proposed, awaiting the user's contract decision. No response limit or gate semantics have been changed.

- The user approved the approvals-only status projection. Contract: authenticated `session.status` with matching `session_id` and `projection: "approvals"` returns `{session_id, approvals}`; the complete approval map includes already-decided gates for uncertain-write inspection. Omitted projection preserves the existing full response. The CLI uses the projection for every approval-map read; the 64 KiB client cap, session/integrity checks, confirmation codes and one decision RPC per gate are unchanged. Two large-history real-daemon regressions failed before implementation and pass after it; focused checks are 80/80.
- A-02 was stopped cleanly before replacing its daemon: five tasks verified, T06 still pending, no active leases, all 43 process captures ended/finalized, complete evidence and no archive problems. Hidden tests remain withheld. The retained attempt is an incomplete product-defect run, not a full acceptance result. Fresh full normal/loaded checks and local fix commit approval are pending before a new full A run.

- Approval-projection fix verification: normal and loaded each passed **3283 tests, 3271 passed, 12 skipped, 0 failed** (560.1 seconds normal / 251.2 seconds loaded). Logs: `/tmp/omni-p7d-approvals-normal.log`, `/tmp/omni-p7d-approvals-loaded.log`. Independent review found no blocking issue. The concrete local fix (CLI, daemon handler, two regression tests and these API/progress notes) is ready for user commit approval; no files have been staged or committed for this fix.

- The user approved the four-file approval-projection fix commit and continuing P7d. Local commit `058b42a` was created after the fresh normal/loaded pair above; no push was performed. Full A-03 started in a fresh workspace on that source. Retained A-02 is not resumed or combined with the new run.

- During full A-03, T03 asked whether quoted fields must support embedded newlines. The user approved retaining acceptance v1 scope: quoted commas, escaped quotes, header/empty fields/trailing LF/CRLF and visible regressions; multiline quoted fields are not an additional requirement and support is not forbidden. The decision was forwarded through the worker inbox with its question ID/source. Fixture, hidden tests and suite version remain unchanged.

- A-03 confirmed the approval fix under the oversized-history condition: the user approved T06 through the projected CLI path and T06 integrated successfully. The next `session.resume` response also contained full task history and exceeded 64 KiB after T07 had already dispatched. The controller preserved six integrations, stopped its daemon and archived all 44 finalized captures; T07 ended FAILED during shutdown, no active leases remain and hidden tests stayed withheld. A-03 is incomplete, not a model-quality result or full acceptance pass.
- The user approved optional `session.resume` parameter `projection: "ack"` and an audit of all acceptance RPCs before A-04. After the same single dispatch call, ACK returns only `session_id`, `state`, `session_state`, `plan_revision`, `resumed` and `worker_running`. Existing authorization, session/task/revision checks, error/coverage diagnostics, scheduling, retry policy and the default full response remain unchanged. All three acceptance resume paths use ACK (initial, after integration, context continuation). A lost response is propagated without replay.
- Resume ACK regressions: 73 passed / 5 failed before implementation (large-session server, initial/frontier/context routes); focused checks are now 78/78, also independently rerun by review with no blocking finding. Fresh normal/loaded checks and local commit approval are pending. RPC audit: `docs/ACCEPTANCE-RPC-AUDIT-2026-11-03.md`. Retained A-03 is not reused; fresh A-04 remains pending verification.

- Resume ACK fix final verification: normal and loaded each passed **3287 tests, 3275 passed, 12 skipped, 0 failed**, normal 530.1 seconds / loaded 200.2 seconds. Logs: `/tmp/omni-p7d-resume-normal.log`, `/tmp/omni-p7d-resume-loaded.log`. Review has no blocking finding; `git diff --check` is clean. The concrete local fix and RPC audit are ready for explicit commit approval; A-04 has not started.

- The user approved the ten-file resume ACK fix and RPC-audit commit, created locally as `c5e7b82` after both full checks passed. Full A-04 started fresh on that source; A-03 remains retained unchanged. No push was performed.

- A-04's T01 lease expired during confirmed macOS Idle Sleep, 2026-11-03 00:18:51–00:22:14 +0700 (203 seconds; last renewal 17:18:49.526Z, expiry 17:20:49.526Z). The worker exited zero but finalization correctly refused lost authority (`DUAL_ISOLATED_UNAUTHORIZED`), leaving `NEEDS_PROCESS_EVIDENCE` and one unsettled operation. The controller was interrupted with no integrations; all five runtime captures finalized. No recovery/settlement was fabricated, and this outcome remains unresolved in retained evidence.
- The user approved a temporary `/usr/bin/caffeinate -i -w <harness PID>` assertion for the fresh A-05 acceptance run. The installed man page confirms idle-sleep prevention and automatic release when that PID exits. `pmset -g assertions` verified the assertion on A-05 harness PID 8496 (caffeinate PID 8661). Source stays `c5e7b82`; lease durations, OS preferences and gate policy are unchanged. A-05 awaits its human plan gate.

- A-05 timed out at the integrate-T03 human gate after the approved 30-minute wait, ending at 2026-11-02T18:25:27.350Z (03 Nov 01:25 +0700). Two tasks were verified; all 18 runtime captures finalized and hidden tests stayed withheld. The human approved T03 later at 2026-11-03T04:18:41.744Z (11:18 +0700), after the controller/daemon had ended. The approval is valid human/cli-tty but T03 was not integrated. The original archive is unchanged; a separate late-approval ledger snapshot preserves the appended event and its verified archive-prefix relationship.
- Continuing the already-authorized P7d, A-06 started fresh on `c5e7b82` with the same 4-hour total/30-minute approval defaults and temporary caffeinate assertion (harness PID 14615, assertion PID 14771). No gate approval is transferred between runs. A-06 awaits its own human plan approval.

- During A-06, T07 asked whether list JSON must be compact or indented. The user approved retaining the original acceptance scope: either representation is valid if parsing yields the correct array with every field/value and book order preserved; no indentation/newline requirement or hidden-test change is added. T07 subsequently shows human/cli-tty approval and TASK_VERIFIED; A-06 continues to T08 with seven tasks verified.


- Full A-06 finished FAIL on `c5e7b82` at 2026-11-03T09:09:03.041Z: 7/10 integrated-tree requirements; T01–T09 TASK_VERIFIED, T10 settled CONFLICT (`DUAL_SOURCE_CONFLICT`). All 11 gates are human/cli-tty and all 73 captures finalized. Source `lib/report.js` reverted to exact fixture baseline during the T10 implement time window, before QC/approval; T10's bound snapshot contains accepted T09 content, ruling out a stale baseline. Separate private diagnostic copies of T05/T09/T10 handoffs each pass their unchanged hidden test; they cannot replace acceptance. Writer attribution is unknown because runtime output lacks file-operation traces. The generated scope threshold only snapshots around QC and misses this earlier drift; its pass is insufficient for whole-run source-integrity claims. Original evidence is preserved, no fixture/prompt/skill tuning or source restoration performed. An extension to observe source throughout the run against authorized integration receipts is proposed for user decision; B/C/D remain pending. See `ACCEPTANCE-3.2.0.md` for hashes and diagnostic evidence.


- The user approved extending source observation and investigation before further A–D runs. The new acceptance-only observer retains expected source state across worker turns, waits and resume calls; detects/latches unexplained changes and stops owned runtime processes; accepts exact changes only with a matching immutable handoff hash/result, same-session authority anchor and integration receipt. Regression checks cover baseline reset before QC, restore-after-detection, extra files hidden beside a legitimate integration, forged receipt/handoff/lineage, and drift during a long operation. First focused run: 78/78 pass; independent review and both full checks are in progress. No new acceptance run or commit has started. Writer attribution in A-06 remains unknown; this change closes an observation gap and does not establish that the underlying writer has been fixed. A separate user question about unattended benchmark design is pending; no automated approval path has been implemented.

- The user considered unattended benchmark operation and chose to retain the existing human/TTY-code acceptance flow. No unattended mode or automated gate decision is authorized or implemented. Continue A–D only after the source-observer fix is verified and explicitly approved for local commit.

- Source-observer verification found an accidental test-environment change: the first loaded command inherited a newly added `umask 077`, contrary to the approved command. It ended with four failures: two new observer fixtures declared mode 0644 but created mode 0600 (isolated probes: default 6/6, restrictive 4/6), plus two existing short real-time watchdog tests. The observer fixture now explicitly sets its declared 0644 mode; the restrictive probe passes 6/6 without weakening assertions. The first normal run was green (3298 tests, 3286 passed, 12 skipped), but both full checks are being rerun after this fixture correction with the approved commands. The failed loaded log is retained, not counted as verification. No production watchdog policy or existing tests were changed.


- Source-observer final verification after the fixture-mode correction: **normal and loaded each 3298 tests, 3286 passed, 12 skipped, 0 failed**. Normal: 586.777 seconds, `/tmp/omni-p7d-source-final-normal.log`; loaded: 242.428 seconds, `/tmp/omni-p7d-source-final-loaded.log`. Both previously failing watchdog cases pass in both final runs; no production watchdog policy or existing watchdog test was changed. The restrictive-mode observer probe passes 6/6. Independent read-only review found no actionable/blocking issue and reran the 78 focused checks successfully; the subsequent fixture-only correction sets its declared file mode explicitly. `git diff --check` passes. The concrete nine-file local fix is ready for explicit commit approval; no commit, push or new acceptance run has occurred. A-06 remains FAIL and its writer remains unattributed.
- Read-only installed `agy --help` exposes `--log-file` and `--output-format stream-json`, but no transcript-export subcommand. No runtime invocation or permission flag was changed and no global conversation store was copied. The original A-06 capture does not establish which process wrote source; source-observer success must not be represented as a fix for that unknown writer.

- The user explicitly approved the nine-file local source-observer fix commit and continuation of P7d after the two green final full checks. Human/TTY gate policy is retained; no push is authorized.

- The approved nine-file observer fix was committed locally as `922f260`. Both final full checks passed before this commit; no push was performed. P7d continued with fresh full config B-01 (codex orchestrator / claude sonnet worker, AUTO off), retaining A-06 FAIL and all prior raw evidence. B-01 registered ten tasks, has no worker starts before its pending plan gate, and uses the previously approved temporary idle-sleep assertion on harness PID 62100 (caffeinate PID 62430). Its human plan gate has an approximate 17:42 +0700 deadline on 2026-11-03. No new runtime logging or gate-policy flag was added.


- B-01 ended before any worker dispatch at 2026-11-03T10:44:29.010Z with `ACCEPTANCE_SOURCE_OBSERVATION_FAILED` during plan approval (6325 observer checks; no integrations; hidden tests withheld). Installed power logs show Clamshell Sleep at 17:39:49 +0700, maintenance sleep at 17:41:20 and DarkWake at 17:44:28, matching the observer failure boundary. The approved idle-sleep assertion was still active before clamshell sleep; it cannot be treated as protection against closing the lid. A fresh read-only source snapshot succeeds now. The original snapshot exception was discarded by the observer, so its exact cause remains unknown; sleep correlation is recorded without inventing a Git timeout error. Runtime capture was never started because no runtime was dispatched, and the report correctly remains incomplete.
- B-01's plan approval arrived at 2026-11-03T14:43:34.137Z, after the run ended. It is a valid human/cli-tty decision, with no worker/integration started afterward. The original authority archive remains byte-identical; its exact prefix relationship to the later ledger and a separate late-approval snapshot are recorded in `B-01-late-approval-sleep-observer.json`. Fresh full B-02 started on unchanged `922f260`, with current AC power, the same approved `caffeinate -i -w` mitigation and unchanged 4-hour/30-minute deadlines. Ten tasks are registered and its own plan gate awaits the user; old approvals are not transferred.

- During B-02/T01 the user explicitly approved retaining author whitespace literally: only case is normalized, so `Frank Herbert` and ` Frank Herbert ` remain distinct complete names. The earlier string-only scope still applies; missing/null/non-string author values have no added validation/coercion requirement. T01 had already handed off code that complies; a read-only supplemental check confirmed case-insensitive full-name matches, literal whitespace and unchanged handoff file hash. Fixture/hidden tests and suite version are unchanged. T01 passed review/QC in `lib/catalog.js` only and awaits its human integrate gate. The prior string-scope clarification was posted as a worker inbox note after handoff; delivery to T01 is not assumed.

- During B-02/T03 the user approved keeping malformed CSV, including unterminated quotes, outside acceptance v1: no requirement to return partial text or throw. The existing optional multiline scope remains (not required, not forbidden); quoted commas, escaped quotes, header/empty fields and trailing LF/CRLF remain required. No fixture/hidden-test change is made. After this clarification, the user approved integrate-T03 human/cli-tty at 15:32:53.024Z; T03 reached TASK_VERIFIED with `lib/csv.js` and `test/csv.test.js` only (receipt sequence 256). T04 is now running; hidden tests remain withheld.


- Latest user policy change: automatic P7 benchmark gate decisions are explicitly authorized, superseding manual-code entry; ask only on errors needing a decision. The separate T04 answer requires an error for a missing CLI query. The controller does not treat this as approval of its prior empty-query default. Production permission policy is unchanged.
- B-02 was interrupted for that policy transition at 2026-11-03T15:44:55.534Z, with T01–T03 TASK_VERIFIED and T04 pending (not integrated). All 30 runtime captures finalized; 14193 source-observer checks accepted three authorized integrations with zero observed source violations. Exact archived ledger SHA-256: `ab2011bcd0bf44b9fd53340e47606485a68025f3b9f9025bce9a57638891de36`. Hidden tests remained withheld. This is a retained incomplete manual run, not a product failure or full config pass.
- Delegated benchmark implementation has 134/134 focused checks passing, including a real wrapper health/shutdown smoke without models, artifact/root/task/hash/expiry checks, source-parent symlink refusal and T04 mutation witnesses for permissive missing args, falsey rejection of explicit empty input and whitespace trimming. Independent re-review found no remaining blocker after strengthening T04 coverage and independently reran 105 focused checks. Full normal/loaded checks are in progress; no fresh delegated model run has started and no new commit is made.

- Delegated-mode final normal and loaded checks each passed **3312 tests, 3300 passed, 12 skipped, 0 failed** (normal 407.529 seconds; loaded 131.622 seconds). Logs: `/tmp/omni-p7d-delegation-normal.log`, `/tmp/omni-p7d-delegation-loaded.log`. Fresh full B-03 started with `--delegate-approvals` and AUTO off; its plan was approved by `test/test-harness` at 16:24:30.386Z, sequence 15. Production `lib/bin` and original fixtures/oracles have no diff. Source HEAD remains `922f260`; uncommitted controller files are captured in ten private source copies and hashes with `controllerSource.dirty: true`. No new commit or push is made.


- Delegated B-03 stopped at 2026-11-03T16:39:32.022Z with ISOLATED_CONTROLLER_REQUIRED. T01–T07 are TASK_VERIFIED. T08's first legitimate NEEDS_CONTEXT batch contains six questions (columns, formatting, line endings, empty export, quoting and source), but the previously approved three-reply-per-task cap rejected it before any reply. It is not a repeated-question loop. All 53 runtime captures finalized, source observation accepted seven integrations with zero observed drift, hidden tests remained withheld, and source/archive ledgers match SHA-256 `d6a694f970d06e28f552b228e55bc8b6eca105d2fff4dce720ff7cc1188ec5e7`. T09 failed during owned daemon shutdown with the preserved message "Isolated discussion is closing", before any T09 CLI turn; it is not represented as an independent model failure.
- The user approved the error-handling amendment: P7 acceptance permits at most **three context rounds per task**, with at most **20 questions per round** (the existing API cap). Every question keeps its own paired sourced reply. Repeated calls with no open questions consume no round; a fourth round or oversized batch fails before any write. Partial ACK history is retained and the worker is not resumed until all replies in the batch are acknowledged. The shared helper's default three-reply policy outside P7 remains unchanged. The immutable fixture/oracle and production lease/retry/permission policy are unchanged. This supersedes the earlier P7 three-reply count; actor/delegation and four-hour/30-minute limits remain as in §5.1.
- Context-round regression verification: 138/138 focused checks pass. Independent review found no blocker and reran 67 related checks successfully. Full normal/loaded checks are underway before the fresh delegated retry; no new commit or push is authorized or performed.

Context-round repair full verification (2026-11-04 +0700): normal and loaded each passed **3316 tests, 3304 passed, 12 skipped, 0 failed**, in 413.508 and 140.074 seconds. Logs: `/tmp/omni-p7d-context-round-normal.log` and `/tmp/omni-p7d-context-round-loaded.log`. Fresh full B-04 follows with delegated benchmark approvals, max3 context rounds/task and max20 questions/round; no new commit or push.


B-04 stopped after a different, non-budget failure (2026-11-04 +0700). T01–T06 reached TASK_VERIFIED under seven delegated test/test-harness approvals. Five context batches were serviced successfully, one round per affected task, nine individually acknowledged replies. T07 implementation evidence is SUCCESS with an empty unverified_items array and the required node --test command, but its worker review is NEEDS_FIX. The isolated runner correctly rejects that handoff at its APPROVE precondition with DUAL_ISOLATED_EVIDENCE_INVALID, logged 2026-11-03T17:23:03.089Z. Review findings include boolean option parsing and missing evidence/cross-chunk context; neither finding has been waived. Both actual chunk inputs reference evidence.json but do not embed its command results. This alone does not establish that every finding is false or identify a safe production fix. T08–T10 remain WAITING_FOR_SCOPE on the failed T07 (and T10 also on T09); no active process/lease remained at observation. The controller was deliberately interrupted for investigation, ending 17:24:30.239Z with ACCEPTANCE_INTERRUPTED. Its operational reason is preserved separately from the preceding T07 product outcome.

All46/46 captures finalized with zero capture problems, six authorized integrations and6091 source checks with zero observed drift. Source and archived ledger match SHA-256 af6b7ebbe85596627a2d1de0b203b1aca0c7398ac221900b6a645a032c5f3e93; private mode audit has no violations. Hidden tests remain withheld, and B-04 is incomplete, not a config pass. Production lib/bin, original fixture/oracle, retry/lease/gate policy and raw artifacts are unchanged. Diagnostic audit: /private/tmp/omni-p7d-oK0Yu0/B-04-audit.json. Further worker-review failure handling requires the user's error decision; C/D and fresh A remain pending.


## B-04 review-evidence investigation and repair (user-approved, 2026-11-04)

The worker's own NEEDS_FIX gate is deliberate: isolated-runner requires both evidence.status=SUCCESS and review.recommendation=APPROVE. Existing tests require a NEEDS_FIX/REJECT verdict to halt without integration. This repair preserves that policy; automatic bounded correction in independent squad reviewer QC is a separate existing path, not authorization to overrule a worker verdict.

The reproduced transport defect is that the shared discussion review input references evidence.json but omits its contents. Every review chunk needs those validation results. The surgical repair parses the already hash-anchored evidence with EvidenceSchema, serializes all fields compactly into shared input, and labels it an untrusted worker report. The existing chunker accounts for those bytes, retains exact diff coverage/manifests, and fails closed if fixed overhead no longer fits. It does not remove findings, change review templates, invent a synthesis pass, enlarge a cap, or add retries.

TDD: the new git/snapshot chunk evidence checks and oversized-evidence pre-transport check failed on baseline as expected; artifact tamper protection already passed. After the seven-line production change, all28 chunking tests passed. Broader regressions and independent review are in progress. B-04 evidence remains immutable; fresh benchmark runs await full verification. No new commit or push.

Review-evidence repair verification: broader isolated/discussion/adversarial/chunking regressions **169/169** passed; independent reviewer **28/28** passed, no blocker. Diagnostic replay of B-04 T07 produced two bounded bodies of15125 and13372 bytes, both with exact evidence and lossless original diff; no model rerun and no verdict override. Normal/loaded checks are next.

Review-evidence repair full verification: normal and loaded each passed **3320 tests, 3308 passed, 12 skipped, 0 failed** (424.351 / 161.516 seconds). Logs: `/tmp/omni-p7d-review-evidence-normal.log` and `/tmp/omni-p7d-review-evidence-loaded.log`. Full B-05 starts on production HEAD922f260 plus the tested uncommitted repair; private `/private/tmp/omni-p7d-oK0Yu0/B-05-candidate-source/` records the changed production file, binary patch and hashes, separately from each run's ten harness-source copies. No new commit or push is claimed. B-04 remains incomplete with its original NEEDS_FIX verdict.


## B-05: observed Claude usage-limit signal (2026-11-04 +0700)

The review-evidence repair reached six TASK_VERIFIED tasks. Live T01 review carried complete evidence and its production source hash remained988b2e55271e3bbf32974d77f9987607db018c327ed56096e7c885cca1181232, matching the private candidate copy. T07 never reached review: all three existing implement technical attempts failed with Claude CLI exit1, HTTP429, api_error=usage_limit_reached, terminal_reason=api_error, is_error=true (despite subtype=success), empty stderr, and same-runtime concurrency1. The CLI's reset hint was "You've hit your 5-hour limit · resets 3:10am (Asia/Saigon)". This is an observed account usage-limit signal, not a claim that the reset time is guaranteed or that WAITING_RUNTIME is implemented. Attempt1 ran17:52:27.492Z–17:52:33.717Z; attempt2 ended17:52:36.160Z; attempt3 ended17:52:38.376Z. The existing retry policy exhausted; no extra retry, account/model substitution or paid usage was enabled.

T07's terminal outcome is FAILED/DUAL_AGY_EXIT_NONZERO and T08–T10 remain WAITING_FOR_SCOPE. The owned controller was deliberately interrupted after diagnosis, ending17:54:55.932Z with ACCEPTANCE_INTERRUPTED; B-05 is incomplete. Hidden tests were never released. All46/46 runtime captures finalized, with three real failed turns retained; six authorized integrations and6475 source checks have zero observed drift. Source/archive ledger SHA-256 matches b5e0141f791abc1641507b1ae50fe1e06e1d75882f32a1e67e5e4b4bb7a460e6; private mode audit is clean. Seven approvals are explicitly test/test-harness. The temporary sleep assertion ended with its harness. Private evidence: B-05-audit.json, B-05-claude-rate-limit.json, and B-05-candidate-source/ under /private/tmp/omni-p7d-oK0Yu0. Both full checks remain3320 tests/3308 pass/12 skip/0 fail; no code changed after them, and no commit/push was made.

A user error-handling decision is pending: defer Claude-dependent B/C until the reported reset and use the intervening time for D and fresh A, whose binding does not use Claude. The newly observed signature is available for a separately authorized P7e change; P7d has not silently acquired a waiting/recovery policy.

User-approved quota handling (2026-11-04 +0700): run D first with explicit --auto and delegated approvals, then fresh full A; defer Claude-dependent B/C until quota is available. No paid usage, account/model substitution, retry/lease changes or P7e implementation is authorized by this scheduling decision. D-01 uses the same verified candidate as B-05, including a separate private production-source copy/patch and all ten controller hashes; no code changed since the3320-test normal/loaded runs.

D-01 progress: T01 verified at18:02:54.234Z. T02 independent QC attempt1 returned NEEDS_FIX because it did not access artifacts; all required files were present and that CLI turn made no tool calls. Existing bounded correction opened attempt2 without policy changes; attempt2 QC used read-only command_execution (rg/cat), returned APPROVE, and T02 verified at18:11:39.733Z. The prompt says both to read files and not to run any shell commands; this ambiguity is retained as a diagnostic finding, not silently patched during the run or used to waive a verdict. The original attempt1 rejection and full correction lineage remain in authority. Diagnostic: /private/tmp/omni-p7d-oK0Yu0/D-01-reviewer-read-diagnostic.json. T03 is implementing; no full config pass is claimed.


## D-01 request-ID collision stop (2026-11-04 +0700)

D-01 verified T01 and T02 (T02 at attempt2). T03 worker handoff and independent QC completed, but its verdict is NEEDS_FIX. The verdict has only INFO findings about malformed CSV and its challenge_summary says approval is appropriate; the literal NEEDS_FIX is preserved and never overruled. The blocking product defect is mechanical: settleReviewVerdict uses request_id=qc-review-1 for every task's first attempt. T02 already recorded that ID at sequence178. T03 settlement therefore throws DUAL_HANDOFF_REJECTION_CONFLICT ("Rejection request ID already binds different content") at18:21:39.387Z, before handoff rejection/correction can be appended. The completed review then prevents needsReview from scheduling another review, while task.qc continues returning AWAITING_REVIEW. Read-only reproduction against a non-writing authority facade confirms the same conflict with zero append calls. Audit found the analogous qc-correction-1 request ID is also global across tasks in task-correction/reducer checks.

The owned controller was deliberately interrupted after diagnosis and ended18:24:32.301Z with ACCEPTANCE_INTERRUPTED. All35/35 captures finalized; two authorized integrations and9648 source observations have zero observed drift. Plan authority is auto/pipeline-auto; both integrations are test/test-harness. Hidden tests were never released. Source and archived ledger match SHA-2565633553ac387c9ba967e635d2644772ca1677851adf88d4fd21afdcdd3edfe56, and private mode audit is clean. The temporary sleep assertion has ended. D-01 remains incomplete; no acceptance pass is claimed and no code changed during this run. Evidence: /private/tmp/omni-p7d-oK0Yu0/D-01-audit.json and D-01-request-id-diagnostic.json.

Proposed error repair pending user approval: derive both rejection and correction request IDs deterministically from session ID, plan revision, task ID and attempt, using the existing hash helper to stay within request-ID bounds. Keep conflict rejection, same-lineage idempotency, reviewer verdicts, correction budgets and gate policy. Add a realistic two-task NEEDS_FIX regression and replay/collision checks, run normal and loaded before a fresh D retry, then fresh A. No prompt/skill tuning, source restoration, evidence rewrite, hidden test change or git commit/push is included.


Reviewer request-ID repair approved and implemented (2026-11-04 +0700). settleReviewVerdict now derives both IDs from a SHA-256 digest of the JSON tuple [purpose,sessionId,planRevision,taskId,attempt], using the existing helper. Distinct purposes bind rejection and correction separately. Full64-character hex IDs satisfy TaskIdSchema even for a maximum-length task ID; no prefix is added. Existing budgets, literal verdicts, retry/gate policy, conflict guards and handoff evidence are unchanged. Fresh runs will use the new IDs; D-01 raw evidence is not migrated or resumed.

TDD: baseline18 tests/16 pass/2 failures reproduced the real cross-task conflict and missing session/revision separation. The repair passed18/18; final multi-task fixture exercises two tasks through attempts1/2, eight unique rejection/correction IDs, and both tasks at correction3. Replay of a REJECT verdict remains idempotent; changed findings still conflict without ledger changes. Broader reviewer/handoff/adversarial/correction regressions35/35 passed, and independent review reran18/18 with no blocker. Normal and loaded verification are in progress before fresh D/A. No new commit or push.

Reviewer request-ID repair final verification: normal and loaded each passed **3323 tests, 3311 passed, 12 skipped, 0 failed**, in402.291 and128.116 seconds. Logs: `/tmp/omni-p7d-review-id-normal.log` and `/tmp/omni-p7d-review-id-loaded.log`. Fresh D-02 starts with explicit --auto and delegated benchmark integrations; production HEAD remains922f260 plus the tested uncommitted orchestrator/reviewer-qc repairs, captured in `/private/tmp/omni-p7d-oK0Yu0/D-02-candidate-source/`. Original D-01 and historical evidence remain immutable; no new commit/push. Fresh A follows D, and B/C wait for available Claude quota.

Overnight user authorization (2026-11-04 +0700): the user is sleeping and explicitly authorizes automatic acceptance of error-handling proposals within P7d. Continue D/A with agy, diagnose and verify necessary fixes without routine user questions, then automatically return to Claude-dependent B/C once quota is available. Treat the reported03:10 reset as a hint, check runtime availability, and preserve every failed/incomplete run. Keep existing evidence integrity and truthful approval provenance; no new git commit/push is required.

D-02 live correction evidence: T01/T02 verified. T03 reviewer attempt1 found a concrete trailing-empty-line regression (multiple final LF/CRLF records retained), then handoff rejection sequence293 and correction sequence294 committed successfully. Their distinct64-character request IDs are4f44a9570ebdac87dbec77df387052b132804cc39514c802f36fd38784e31694 and718aa2ef2ab23bb3ef2d218345019578546667d62abbf0c949db4729446ed9b7. Worker attempt2 is running; no gate or verdict was waived, and hidden tests remain withheld. This proves the repaired path advances past the prior D-01 collision, but is not yet a full config pass.

D-02 T03 reached TASK_VERIFIED at2026-11-03T19:27:37.099Z on attempt3. Both reviewer-driven corrections used distinct deterministic IDs and preserved findings; worker updated only the registered CSV implementation/regression files. No verdict was waived or manual implementation patch supplied. T01–T03 verified; T04 starting. Full config/hidden acceptance remains pending.


## D-02 reviewer-read contradiction and delegated repair (2026-11-04 +0700)

D-02 verified T01–T04. T03 required three attempts; T04 two. Deterministic request IDs successfully handled corrections on multiple tasks and attempts without collisions. T05 worker attempt1 produced a handoff, but independent Codex QC returned NEEDS_FIX solely because it could not access present artifacts: its verdict explicitly cites the instruction prohibiting shell commands. Earlier D-01 T02 showed the same refusal, while successful Codex QC turns used command_execution with rg/cat. P5 §2.2's blanket no-shell sentence was originally added for agy plan mode denial (V34); on Codex it contradicts the available shell-based file-reading capability.

Under the user's overnight authorization, retain D-02 and repair the runtime-specific instruction. reviewPrompt now receives runtime: Codex may use read-only shell commands such as cat/sed/rg only to inspect local files; writes/tests/validation commands/scripts stay prohibited. AgY/Claude keep the original no-shell instruction. The actual permission profile remains read-only, project_root_markers=[] remains, and no sandbox/approval bypass is added. This is a tool-access contradiction fix; no reviewer verdict, model, task goal, hidden oracle, retry/budget or generic review template is tuned. Existing literal NEEDS_FIX results are preserved, not converted to APPROVE.

D-02 was deliberately interrupted at2026-11-03T19:51:14.505Z while T05 attempt2 was active. It retains72 capture records,71 finalized and one incomplete turn6dfa43b3-f44f-49b6-b4ec-bd9e22b52f2d. Its recorded PID23291 is no longer listed at a later read-only observation; that does not supply an exit code or settlement proof. Lease5b157ba8-9326-487c-808b-0a49d63f53db remains expired/unreleased. This evidence gap and unknown are explicit; no raw record or authority settlement is fabricated. Hidden tests remain withheld. Four authorized integrations and20128 source checks have no observed drift. Source/archive ledger SHA-256 matches b9539630f79fd87171167bfb7a0d1a13d21fb17ffa788cf6da653bd677f7ba4c; private mode audit and candidate production/controller source comparison pass. Evidence: D-02-audit.json and D-02-pending-capture-observation.json under /private/tmp/omni-p7d-oK0Yu0. D-02 is incomplete, and neither it nor the older A-04 unknown is resolved by later runs.

TDD: new Codex invocation regression failed baseline at the contradictory instruction (19 tests,18 pass,1 expected failure). The fixed reviewer/codex/handoff/adversarial set passed50/50. Independent review reran19/19 with no blocker. Normal and loaded checks are in progress before fresh D-03/A. No new commit/push; original evidence and unrelated user files remain unchanged.

Review-read loaded verification was interrupted by macOS sleep:3324 tests,3309 pass,1 fail,2 cancelled,12 skipped in570.800 seconds. Two tests exceeded90s (415-417s elapsed) and the fake Codex probe timed out. pmset records413s Maintenance Sleep08:43:39-08:50:32 +0700 on2026-11-04, matching these durations. This is retained as failed verification, never counted green. Under overnight automatic error-handling authorization, repeat normal/loaded with a temporary utility-bound caffeinate -i assertion; keep all production/test timeout policies unchanged and do not change system power preferences. The Mac was asleep between active work windows; scheduled chat work cannot execute while it is asleep. No fresh acceptance run starts until both checks pass. Private evidence: /private/tmp/omni-p7d-oK0Yu0/review-read-loaded-sleep-observer.json.

Final reviewer-read verification with utility-bound caffeinate -i: normal and loaded each passed **3324 tests, 3312 passed, 12 skipped, 0 failed**, in397.098 and126.419 seconds. Logs: `/tmp/omni-p7d-review-read-awake-normal.log` and `/tmp/omni-p7d-review-read-awake-loaded.log`. The three sleep-affected cases are green on unchanged code. Fresh D-03 uses explicit --auto and delegated benchmark integrations, with idle-sleep assertion bound from harness startup. Candidate production/controller sources remain private and hashed; no commit/push, power preference changes or timeout relaxation. Confirm real Codex reviewer reads on this run; then finish fresh A and automatically return to Claude B/C when quota is available.

D-03 live reviewer-read verification: T01 reached TASK_VERIFIED at2026-11-04T02:09:19.750Z. The real Codex reviewer exited0, used command_execution with cat/sed/rg to read spec.json, diff.patch, evidence.json and changed/context files, then returned APPROVE. Commands were local file reads; the invocation remains read-only. This validates the runtime-specific instruction on a real turn; full config/hidden acceptance is still pending. T02 is running.


D-03 interim model findings (2026-11-04): T01–T07 and T09 reached TASK_VERIFIED. T08 received two individually acknowledged sourced finance-format replies in one context round, but its worker review returned NEEDS_FIX: an early diff chunk reported a missing exportFinance function, while a later chunk explicitly confirmed the implementation. The isolated handoff APPROVE precondition correctly rejected it as DUAL_ISOLATED_EVIDENCE_INVALID. No verdict was overridden and no worker source was manually integrated. T10's first independent QC verdict was also NEEDS_FIX despite its sole INFO finding saying there was no issue; the existing bounded correction opened normally. These are retained model/review-quality observations, not justification for changing the conservative verdict policy or tuning prompts from acceptance outcomes. D-03 remains active; final hidden tests and all five thresholds must be evaluated after it settles.


Finalized D-03: D-03 PASS: 9/10 requirements; 9/10 TASK_VERIFIED; capture 95/95; ledger 4d1357ead6513eebf0da5b6f3ec5ccc08b9e3d7448349511d051329c37d99101; source/candidate/private audit passed. Gate evidence is delegated, not human/TTY proof. No commit/push was performed.


Finalized A-07: A-07 INCOMPLETE: 0/10 requirements; 0/10 TASK_VERIFIED; capture 0/0; ledger 58c86da41a1b82ebe55e31225d0e5ef4c76062996dbd470cdf7b3e8441743737; source/candidate/private audit requires investigation. Gate evidence is delegated, not human/TTY proof. No commit/push was performed.


A-07 did not reach plan registration or launch any task: capability preflight returned DUAL_CAPABILITY_BLOCKED, reporting that the agy version probe failed. The original probe's raw output/exit reason is not retained by that production path; no timeout or OS cause is asserted. Its raw authority ledger/archive remain identical, but runtime capture is absent because execution never started; the original incomplete report is retained without fabricating an empty successful capture. A later read-only full preflight passed every check with agy 1.4.12 and the configured gemini-3.8-flash-high model (version exit0 in0.594s; models exit0 in2.352s). Diagnostic: A-07-capability-diagnostic.json. A bounded fresh A-08 retry will use the unchanged, previously tested candidate; no production retry policy, timeout or permission was changed.


Finalized A-08: A-08 INCOMPLETE: 0/10 requirements; 1/10 TASK_VERIFIED; capture 16/16; ledger 8bfcf9f522b44b37ff3c987b0cf4dd9cbc3328a67d6665315e5ce32ee3c26413; source/candidate/private audit passed. Gate evidence is delegated, not human/TTY proof. No commit/push was performed.


A-08 stopped with an unresolved discussion outcome (2026-11-04): T01 was TASK_VERIFIED; T02 context continuation reached review, whose invocation inv-2-3 ended outcome_unknown with journal reason timed_out+nudge+nudge-denied at03:53:42Z. All16 runtime captures ended/finalized, but the T02 lease737131c2-3ed8-409b-8b3f-eb9ee956bc6a expired without release and there is no authoritative outcome/finalization settlement. Read-only recovery returned NEEDS_PROCESS_EVIDENCE; no recovery event was written. The coordinator was stopped, then the exact quiescent harness interrupted; its native report ended04:01:38.625Z with ACCEPTANCE_INTERRUPTED. The native error reflects this controlled stop, separate from the preceding OUTCOME_UNKNOWN. The source observer reconciled one integration across5719 checks with no observed drift. Hidden tests remained withheld. Evidence/raw ledgers, unknown journal and diagnostic files are retained; no outcome was inferred from process death. An Antigravity preparing-update assertion overlaps the timeline, but causation is unproven. A fresh A-09 retries the unchanged tested candidate after successful read-only runtime availability checks; no retry/lease/timeout or review policy is changed. A-08 remains explicitly unresolved even if later runs pass.


Finalized A-09: A-09 PASS: 10/10 requirements; 10/10 TASK_VERIFIED; capture 75/75; ledger d834103a322d43013e52266c346fff98dbb0738090a4856c7fd6ffb3e3a3defd; source/candidate/private audit passed. Gate evidence is delegated, not human/TTY proof. No commit/push was performed.


AGY-stage milestone: finalized A-09 passes 10/10 requirements, all five thresholds, complete75/75 capture, T08 sourced-context and clean source/candidate/private evidence audit. D-03 remains a 9/10 delegated PASS with T08 failed. At05:10:38.680Z on2026-11-04 the separate read-only Claude availability probe succeeded with the expected marker; the owned coordinator automatically started fresh B-06 on the unchanged tested candidate, with C-01 next. No historical unresolved outcome was inferred settled.


User follow-up on D-03 NEEDS_FIX (2026-11-04): investigate T08 immediately using read-only evidence; defer any production-source change and fresh focused validation until the pinned B/C runs finish. A diagnostic copy of the preserved private T08 implementation passes the unchanged original T08 hidden test (exit0), with copied/source lib/csv.js SHA-256682d8eabe664cda2c0458507a960727be2decaf293a77314290adb6fea644892 and the original source unchanged. Artifact: D-03-T08-implementation-diagnostic/diagnostic.json. This is diagnostic evidence only, not integration, a corrected task outcome or replacement acceptance grade. Worker review NEEDS_FIX is rejected before independent QC by isolated-runner's APPROVE precondition; automatic bounded correction currently belongs to independent reviewer QC. Review chunk1 claimed exportFinance absent while chunk2 confirmed it. The follow-up must distinguish a reproducible protocol/recovery defect from model-quality findings before changing production; preserve conservative verdicts and the original D-03 9/10 result. A fresh focused run is partial and cannot turn the historical full run into10/10.


B-06 interim observation: T08 ended FAILED/LIMIT_EXCEEDED before review dispatch; raw/review.1.failure.json records "Review line or file header exceeds available chunk budget (274 > 161 UTF-8 bytes)" at2026-11-04T05:28:07.093Z. This is a distinct envelope-planning failure, not D-03's NEEDS_FIX verdict. T01–T07 and T09 are verified; T10 continues and the run is not yet graded. Preserve the original failure and inspect lossless byte budgeting with the queued post-B/C review follow-up; no active candidate source, ceiling, retry policy or oracle is changed.


Finalized B-06: B-06 PASS: 9/10 requirements; 9/10 TASK_VERIFIED; capture 69/69; ledger 85881f4d152db903d9a3ded40d436c982c3298e35d5a008784d5958bef46fafc; source/candidate/private audit passed. Gate evidence is delegated, not human/TTY proof. No commit/push was performed.


Finalized C-01: C-01 INCOMPLETE: 0/10 requirements; 0/10 TASK_VERIFIED; capture 0/0; ledger 28ea5afacecd8ffabed9e25a1d3283882dd25c7e1aa616b6883c9912cbd55121; source/candidate/private audit requires investigation. Gate evidence is delegated, not human/TTY proof. No commit/push was performed.


C-01 retained preflight defect (2026-11-04): config C correctly generates .claude/settings.json and .mcp.json for its Claude orchestrator, but capability-preflight's project_configuration check unconditionally required .codex/config.toml and .codex/hooks.json. It stopped before plan registration with DUAL_CAPABILITY_BLOCKED (.codex/hooks.json does not exist); its ledger contains only session.created, no task/lease/approval execution. Native runtime capture is absent because no turn started; no synthetic successful capture is created. Source/archive ledger SHA-25628ea5afacecd8ffabed9e25a1d3283882dd25c7e1aa616b6883c9912cbd55121 matches; source/candidate/private mode checks passed. The owned coordinator ended needs_agent and no harness remains active.

The minimal preflight fix selects hook settings using the bound orchestrator/configRoot. Claude checks its real .claude/settings.json for a parseable object, object hooks container, and hooks not explicitly disabled; valid Codex files cannot substitute for invalid Claude settings. Existing Codex/MCP checks and all retry/error/gate policy are preserved. Two regressions first failed as expected (21 tests:19 pass/2 fail); focused preflight/Claude/retry coverage now passes57/57, independently reviewed with no blockers. Fresh normal/loaded checks are running before C-02. Earlier A-09/B-06/D-03 remain results for their exact previous captured candidate; C-02 will capture the additional production fix without pretending the earlier runs used it. No commit/push is authorized or performed. The separate D/T08 follow-up remains queued after C.


The Claude configuration preflight fix passed final full verification: normal3326 tests/3314 pass/12 skip/0 fail in542.326s; loaded the same counts in227.003s. Logs: /tmp/omni-p7d-claude-config-normal.log and /tmp/omni-p7d-claude-config-loaded.log. Both were protected by utility-bound caffeinate. Independent review found no blockers and independently ran57 focused tests. No production change followed these checks. C-02 will run fresh on the captured dirty candidate (HEAD922f260 plus the additional preflight fix); no local commit/push was made. Original fixture/hidden tests were not changed.


Finalized C-02: C-02 INCOMPLETE: 0/10 requirements; 2/10 TASK_VERIFIED; capture 36/37; ledger dd583635638e69904742c9aa344986548f2aef7d962b91a5a5e4890ea5dd03ee; source/candidate/private audit requires investigation. Gate evidence is delegated, not human/TTY proof. No commit/push was performed.


C-02 source-drift stop (2026-11-04): the observer detected test/csv.test.js changing without an integration receipt at06:37:58.662Z (file mtime06:37:58.629Z), during T03 attempt3 implement. Only T01/T02 had integrated; the source parser stayed baseline while the source test gained regression cases. The native run stopped06:38:09.131Z with ACCEPTANCE_SOURCE_DRIFT. Capture has37 turns,36 ended/finalized and pending implement3b8fe611-8ba7-45bc-99b4-008a67c984b2 (PID49907); lease1c29b4cf-2e06-4e08-8ea6-8ed71d2fd3e0 is expired/unreleased. Source/archive ledger SHA-256dd583635638e69904742c9aa344986548f2aef7d962b91a5a5e4890ea5dd03ee matches and candidate/private mode checks passed. The original source, ledger and incomplete capture were not restored, patched or fabricated.

A separately labelled post-stop observation preserves distinct source/private inodes with nlink1 and no symlinks. Private attempt3 files have later mtimes up to06:42 after the native report ended; PID49907 was absent when checked. Process absence proves neither its exit code nor operation settlement. The writer remains unattributed. Exact relevant-session language-server log lines were retained privately but do not identify the write. A real read-only nested-Git probe using fresh --new-project and private --add-dir read only the private nonce and left both files unchanged; it does not reproduce or prove the cause of this source escape. Probe evidence is separate from acceptance counts.

Read-only code review confirmed two independent gaps: worker-slot drops isolatedRoot before AGY discussion seeds, so they lack project/add-dir flags; daemon shutdown aborts child discussion state but not the outer detached implement signal. Official CLI project semantics: https://antigravity.google/docs/projects?tab=cli (unflagged sessions use the default project; conversation resume keeps its associated project). Legacy implement already uses --new-project/--add-dir with verified private cwd, so missing implement flags are not asserted as the cause. Three seed/generic fresh-versus-resume regressions first failed and now pass in146 focused checks. A real detached Node-child daemon regression first showed close resolving without cancellation; a per-daemon signal/drain fix now passes that regression. Reviewer/ownership checks, independent review and fresh normal/loaded verification are still required before any new C run. These changes are pending hardening, not a claimed resolution of C-02 or the historical source writer. D/T08 follow-up remains queued.

2026-11-04 shutdown review amendment: independent review reproduced two existing bounded-process paths that could resolve before close: output overflow after SIGTERM and a non-AbortError after spawn. Two signal-bound regressions first failed. The minimal primitive fix now retains ownership until actual close, discards overflow buffers at the unchanged cap, preserves actual close code/signal, and leaves no-signal compatibility unchanged. Pre-spawn errors still settle without inventing a process. The first new normal run was deliberately stopped (exit143) before this additional fix and is not a green check. Fresh full verification remains required; C-02 source attribution and pending outcome remain unknown.

Shutdown/isolation checkpoint: independent final review found no remaining blocker after a sticky overflow regression (overflow then abort/timeout/error). Preflight24/24, reviewer21/21 and parallel14/14 passed; reviewed fresh seed/lifecycle cases also passed. Signal-bound overflow/error now waits actual close with unchanged caps, preserving legacy no-signal behavior. Fresh normal verification is running in exact native session45226; loaded has not started. No new acceptance workspace or settlement was created.

Verification checkpoint07:42Z: the normal run in session45226 was stopped with exit143 after an old exact-argument assertion in dual-resume-honesty failed before releasing its pending fake worker. The test now validates the forwarded AbortSignal and always releases that worker in finally; resume/reviewer26/26 tests passed. Production did not change after independent review. Owned sequential verification utility /tmp/omni-p7d-verify-isolation.cjs (PID119, native session9567) now runs a fresh normal then loaded pair with utility-bound caffeinate and captured production patch/hash checks. It only records actual results and never starts acceptance or changes source. Logs: /tmp/omni-p7d-isolation-verified-{normal,loaded}.log. Do not duplicate these jobs. Both stopped normals remain retained and are not counted green.

07:54Z verification recovery: normal3335 tests ended3312 pass/11 fail/12 skip/0 cancelled in534.128s; all11 failures were the host-wiring VM missing Node standard AbortController. Focused reproduction matched; forwarding the actual Node global in the test helper preserved all assertions and now34/34 pass. Production patch remains unchanged. Owned verification v2 now runs fresh normal then loaded, native session67081; inspect manifest for exact PID. Logs /tmp/omni-p7d-isolation-vm-verified-{normal,loaded}.log. No fresh acceptance has started; failed verification is retained.

2026-11-04T08:16Z environment recovery: normal3335 tests/3323 pass/12 skip/0 fail passed in527.151s. Loaded retained two failures (3335/3321 pass/12 skip/2 fail,405.395s): fixture child ETIMEDOUT and source-observer timeout. Power logs confirm188s Idle Sleep15:03:44–15:06:52 +0700 overlapping their187–197s elapsed durations, despite per-stage caffeinate. Separate private evidence: /private/tmp/omni-p7d-oK0Yu0/isolation-loaded-sleep-20261104-0803.json. No source, cap, timeout, system preference or oracle changed. Both affected test files then passed31/31 in13.444s. A fresh normal+loaded pair is now protected by an additional continuous utility-bound caffeinate across the entire verification coordinator lifetime, avoiding assertion handoff gaps. Owned v3 coordinator PID20564/native12772, continuous assertion PID20566 verified; logs /tmp/omni-p7d-isolation-continuous-verified-{normal,loaded}.log. No acceptance harness started, no earlier failure relabelled green.

2026-11-04 final isolation/shutdown verification: both full suites passed3335 tests/3323 pass/12 skip/0 fail/0 cancelled. Normal518.603s, loaded172.244s; continuous utility-bound sleep assertion spanned both. Actual logs /tmp/omni-p7d-isolation-continuous-verified-{normal,loaded}.log; immutable derived verification receipt /private/tmp/omni-p7d-oK0Yu0/isolation-shutdown-verification.json. Reviewed production patch SHA-256 d00ebb23c0534938e9ebfdceb4bd48a7acb884c6ee3fb4695e5ceae7fd295d54 and all9 dirty production hashes stayed unchanged. Original acceptance fixtures/oracles have no diff. No commit/push was made. A fresh full C-03 is now authorized to start after its real Claude availability probe, with delegated test/test-harness approvals and C AUTO off. These verified hardening fixes do not identify the historical source writer or settle C-02/A-04/D-02/A-08 unknowns. D/T08 follow-up remains required after C.

Fresh full C-03 started2026-11-04T09:14:53.393Z after real Claude availability probe success09:14:53.250Z. Workspace /private/var/folders/nb/z68wp3xx6z39w79f7z3g_v0c0000gn/T/omni-squad-acceptance-pqH57L/workspace, session ce1f9dff-12c0-41be-8ecb-df4c33bb5710; coordinator89233/native72217 and harness89301. Captured9 dirty production files on HEAD922f260, patch SHA-256d00ebb23c0534938e9ebfdceb4bd48a7acb884c6ee3fb4695e5ceae7fd295d54 matches the fully verified candidate. C AUTO is off; benchmark gate delegation is explicit test/test-harness provenance. Coordinator and harness continuous idle assertions89247/89302 verified. T01 is executing, no acceptance conclusion yet. Do not edit pinned sources or launch duplicate runs; after C address D/T08 follow-up and aggregate.


Finalized C-03: C-03 FAIL: 8/10 requirements; 8/10 TASK_VERIFIED; capture 90/90; ledger fc28d24c4eb4d6024f4d25ed1805a8a8c005684c065dfc2f5a9ae64fb52edffb; source/candidate/private audit passed. Gate evidence is delegated, not human/TTY proof. No commit/push was performed.

P7d follow-up implementation (2026-11-04, not yet full-suite verified): C-03 finalized FAIL8/10, not9/10: T08/T10 review fixed overhead exhausted planner budget. All90 captures finalized;24075 source checks accepted8 integrations with0 violations; scope/unknown/duplicates/delegated-gate thresholds passed; private modes and exact candidate audit passed. LedgerSHA fc28d24c4eb4d6024f4d25ed1805a8a8c005684c065dfc2f5a9ae64fb52edffb. Native report/audit remain immutable.

The review planner now keeps its1024-byte optional reserve when units fit, otherwise uses exact remaining envelope capacity; the hard16KiB cap and full diff reconstruction still apply. Controller clarification JSON strips only ASCII whitespace outside strings, retaining number/string lexemes and a raw Buffer SHA-256 in the brief so formatting changes remain detectable. The original context file is not rewritten. Generic capacity/compaction regressions first failed; exact-cap empty-diff compaction also has a RED/GREEN regression. Separate read-only archived-artifact simulations now plan B06/T08 in2 chunks(max16382 bytes), C03/T08 in11 and C03/T10 in6(max16383), with all original diff bytes retained and existing24 invocation cap unchanged. These simulations do not regrade historical runs or prove model approval.

For the separate D03 NEEDS_FIX issue, only a valid worker NEEDS_FIX after schema/event/hash/correlation/spec/route/evidence/command and measured-file checks now emits DUAL_WORKER_REVIEW_NEEDS_FIX. Classification charges worker/worker_review before harness-finalization fallback. Existing public task.correct remains responsible for lineage, lease, integration, worker-role and two-correction limits; no free harness grant or automatic retry was introduced. REJECT and malformed evidence keep conservative behavior. A real daemon/public-RPC regression verifies two corrections, third denial, preserved raw reviews and unchanged source. One negative fixture initially used unverified_items that existing normalization moves to risks; it was replaced with a genuine missing validation-command case, without changing production normalization. Independent read-only review found no blocker. Fresh full normal/loaded verification is still required before fresh partial D/T08 and full C-04; no commit/push is authorized or performed.

Follow-up verification checkpoint10:50Z: final focused recovery/review/isolation suite148/148 passed in32.575s, independent read-only review found no blocker. Owned /tmp/omni-p7d-verify-followup.cjs PID90622/native74056 now runs fresh normal then loaded under verified continuous idle assertion90626. Current12-file production patchSHA1859407be8153e9f0abf2b4553321a60fd6fa54f0f2653b6dc23d45b4d6e2936 is pinned by the utility; logs /tmp/omni-p7d-followup-verified-{normal,loaded}.log. Last fully verified pair remains3335 until these new checks finish. No new acceptance run, commit or push has started.

Follow-up full verification retry: prior normal3341 tests/3328 pass/12 skip/1 fail/0 cancelled in429.745s is retained as failed. Its sole failure was an old handoff regression expecting generic EVIDENCE_INVALID for a valid NEEDS_FIX. Updated only that test to assert dedicated NEEDS_FIX versus conservative REJECT, persisted classification, no handoff and unchanged source; all9 tests pass and independent read-only review found no issue. Production patch1859407be8153e9f0abf2b4553321a60fd6fa54f0f2653b6dc23d45b4d6e2936 is unchanged. Fresh normal/loaded now run under owned /tmp/omni-p7d-verify-followup-v2.cjs PID44758/native8635 with continuous idle assertion44760; logs /tmp/omni-p7d-followup-contract-verified-{normal,loaded}.log. No fresh acceptance has started.

Review follow-up full verification passed: normal3341 tests/3329 pass/12 skip/0 fail/0 cancelled in411.082s, loaded same counts in143.938s. Continuous idle assertion covered the pair. Reviewed12-file production patchSHA1859407be8153e9f0abf2b4553321a60fd6fa54f0f2653b6dc23d45b4d6e2936 and source hashes remained unchanged; hidden fixture/oracle diff is empty. Actual logs /tmp/omni-p7d-followup-contract-verified-{normal,loaded}.log; derived immutable receipt /private/tmp/omni-p7d-oK0Yu0/review-followup-verification.json. Fresh D-T08-01 is an explicitly partial1-task configD validation with --auto and delegated test approvals; it must not overwrite the full D03 grade or matrix row. After its audit, real Claude availability probe precedes fresh full C-04. Operational coordinator/finalizer/progress scripts now preserve partial denominators and full matrix rows; no production/controller source changed after verification. No commit/push was performed.

D-T08-01 interruption and second follow-up (2026-11-04): after two existing corrections, attempt3 independent QC still returned NEEDS_FIX. All30 captures had ended and all leases were released, but the acceptance driver excluded the rejected handoff and kept NEEDS_FIX nonterminal, waiting with no worker activity. Coordinator/harness were stopped and orphan daemon was stopped via public daemon.stop. Native report has NO endedAt; no completion/grade was fabricated. Original report remains unchanged. Separate post-stop archive/observation /private/tmp/omni-p7d-oK0Yu0/D-T08-01-post-stop/observation.json preserves30/30 ended captures and byte-identical ledger, no archive problems; pre-stop quiescence receipt is /private/tmp/omni-p7d-oK0Yu0/D-T08-01-quiescent-stop.json. Full D03 remains9/10.

QC root cause: reviewer input omitted controller clarification, so repeated findings claimed finance format was invented although the controller had supplied sourced answers. Reviewer now receives .qc-controller-context.json rebuilt only from CURRENT authority task.messages, paired IDs/exact bodies and current session/revision/task/attempt validated against readTaskBinding/handoff; worker context, scout, own review and prior attempts are not copied. Exact serialized context is bound into input_sha256, bounded by existing2MiB copy limit, read-only prompt names the file and says scope is unchanged; a changed authority answer cannot publish a successful verdict. No verdict/oracle is waived.

Driver root cause fix: probe rejected handoffs through existing public QC and stop ACCEPTANCE_NEEDS_DECISION only after the response remains stable against fresh attempt/handoff/review state and the WHOLE RUN is quiescent (all leases, current running reviews, claimed dispatches and unsettled finalization). Valid corrections, in-flight final reviews and fresh APPROVE results are not interrupted. Preserve NEEDS_FIX as nonterminal in partial evidence; no FAILED state, new correction, budget or retry is invented. RED regressions covered omitted/forged/stale context, lineage, hash changes, byte cap, stable decision waits and multi-task races;62 focused tests now pass and independent review found no blocker.

Fresh full normal/loaded pair now runs under owned /tmp/omni-p7d-verify-qc-context.cjs PID55087/native84108, continuous idle assertion55089; reviewed production patchSHAe12f3e30ae60084ef2fb4a09f27ac6827e9b56d550e88acd5b9241ab692cf8b7. Logs /tmp/omni-p7d-qc-context-verified-{normal,loaded}.log. Last full verified pair remains3341 until these checks finish. No live acceptance harness and C-04 has not started. After verification use fresh explicitly partial D-T08-02 then full C-04, preserving D-T08-01 unfinalized report and all historical unknowns. No commit/push was performed.

QC authority-context and decision-wait final verification: both normal/loaded3351 tests/3339 pass/12 skip/0 fail/0 cancelled,409.611s/132.156s. Reviewed12-file patchSHAe12f3e30ae60084ef2fb4a09f27ac6827e9b56d550e88acd5b9241ab692cf8b7 remained unchanged; hidden fixtures have no diff. Logs /tmp/omni-p7d-qc-context-verified-{normal,loaded}.log, immutable derived receipt /private/tmp/omni-p7d-oK0Yu0/qc-context-verification.json. Fresh explicitly partial D-T08-02 is next, then real Claude availability probe and fresh full C-04. Preserve D-T08-01 native unfinalized report/post-stop archive, D03 full9/10 and C03 FAIL8/10. No commit/push, verdict waiver, cap/lease/runtime-retry change or raw-evidence rewrite was made.


Finalized D-T08-02: D-T08-02 PARTIAL PASS: 1/1 selected requirements; 1/1 TASK_VERIFIED; capture 30/30; ledger 7651637f4b74bc2d64310f9051065571401d2acc5da829891ec6080fe10072a9; source/candidate/private audit passed. Gate evidence is delegated, not human/TTY proof. This subset does not replace a full configuration grade. No commit/push was performed.


Finalized C-04: C-04 INCOMPLETE: 0/10 selected requirements; 0/10 TASK_VERIFIED; capture 6/6; ledger 374f73aad3a35be41e880a9e0e9c35231d3b16c50ed9aef2f86dba0c389a1e94; candidate/private/raw-archive integrity passed; source observer FAILED (unauthorized source write). Gate evidence is delegated, not human/TTY proof. No commit/push was performed.


## P7d final measurement checkpoint — NOT ACCEPTED (2026-11-04)

A-09 PASS10/10; B-06 and full D-03 PASS9/10 on captured earlier patch a09df32b50cc. C-03 remains FAIL8/10 on d00ebb23c053; fresh C-04 on latest e12f3e30ae60 stopped before integration with ACCEPTANCE_SOURCE_DRIFT. Native AGY transcript proves edit_file targeted source lib/catalog.js outside its correctly bound private workspace. This does not attribute A06/C02 writers. Six C04 captures finalized; source/archive ledger is byte-identical. Source guard worked; scope acceptance failed. No C05 is started and no live harness remains.

The user-requested D/T08 follow-up is complete as a separate PARTIAL validation: D-T08-02 selectedPassed=true, all selected thresholds/hidden T08 pass, TASK_VERIFIED1/1 at attempt3 after two existing QC corrections. Native ok=false denotes an incomplete full suite; a /tmp finalizer label was corrected without changing its report/audit/ledger. Full D03 stays9/10; D-T08-01 remains unfinalized, not given a fabricated endedAt.

Latest reviewed12-file production candidate on HEAD922f260 passed normal+loaded3351 tests/3339 pass/12 skip/0 fail/0 cancel in409.611s/132.156s before D-T08-02/C04. Production/controller files and fixture/oracle bytes stayed unchanged afterward. Full results, per-task timing/attempts/verdicts, observed usage/signatures,25 retained attempts, exact candidate/controller references and limitations are in ACCEPTANCE-3.2.0.md and private P7d-aggregate-20261104.json. No all-config pass on current source is claimed.

Remaining release blocker: full-auto AGY tool authorization is not enforced source-write containment. A disposable session-only deny probe blocks file-tool escapes and allows private edits, but does not establish shell/OS confinement, alias coverage or all controller-metadata protection. No permission workaround, prompt tuning, extra correction or lucky rerun is used to waive the failure. A verified native-tool/command write boundary is required before fresh full C. Automated fresh reruns stop; P7d is not accepted, the P7 DoD remains open, and P7e/P7f are separate. No commit/push. Historical unknown lineages and unrelated user files are preserved.


## P7d reopened — enforced AGY source-write fence (2026-11-04)

The user explicitly requested completing the C-04 source-write repair after the measurement checkpoint. Original C04/other run reports and the NOT_ACCEPTED aggregate remain immutable historical results. No fresh C is counted yet.

An OS-enforced source-write fence is added at the isolated AGY spawn boundary. On macOS a fixed parameterized Seatbelt profile, launched through absolute /usr/bin/sandbox-exec, makes the source tree read-only except the current private worker subtree. Local AGY backend/shell descendants inherit it; seed/turn/nudge/resume/implement all pass the boundary. Non-AGY CLI profiles and controller integration remain unchanged. Source/private canonical directory identities are pinned; source shared inodes and external symlinks refuse execution; new hardlinks and unlinking directory anchors are denied. Backend/profile/unsupported-platform failures are typed PRECONDITION before a model process, with no unfenced fallback. Global hardlink denial and rejection of linked source trees are explicit restrictions. Linux/Windows have no verified backend in this change and fail closed for isolated AGY; real multi-OS readiness is not claimed. This is protection of the registered source tree, not a general host-read/network jail or protection against an unfenced external actor/service.

Tests first reproduced an actual unfenced source write; OS regression checks deny file write/create/rename/delete/chmod, aliases, dot-dot, symlinks, hardlinks, source/ancestor rename, shell and detached descendants, while private writes and controller integration succeed. Further RED/GREEN tests cover outer shells, unavailable/rejected policy, changed roots, pre-existing source aliases both inside and outside private root, and externally resolved symlinks. The native AGY1.5.0 diagnostic uses the unchanged full-auto flags with no deny-permission settings: source edit_file returns operation not permitted, private edit succeeds, shell source write returns EPERM and private write succeeds. Its log identifies embedded language-server PID47534 as the fenced AGY PID; no external backend is inferred. Native proof: /private/tmp/omni-p7d-oK0Yu0/native-write-fence-probe-Wucpil/summary.json. This proof alone does not replace fresh normal/loaded checks or full C.

Full checks and independent review must pass on the final candidate before fresh C-05. New uncommitted production module is included explicitly in candidate byte/patch capture without staging; unexpected untracked production files still reject capture. No commit/push, fixture/oracle change, extra retry, cap/lease relaxation or historical verdict waiver is authorized by this repair.


AGY source-write fence final verification: normal and loaded each3360 tests/3348 pass/12 skip/0 fail/0 cancelled (411.383s/127.730s). Reviewed13-file production patch2184744341c66e036e085ee59ec6aea0eeb18459dceb78bea36e5585a76f7f8b on HEAD922f260 includes new worker-write-fence.js without staging. Hashes and fixture/oracle diff stayed unchanged; independent final review found no remaining blocker. Receipt: /private/tmp/omni-p7d-oK0Yu0/write-fence-verification.json. Newest deterministic vanished-artifact race regression also passes. The source-tree metadata bound is200000 entries including private artifacts; existing shared inodes, external/dangling symlinks and unsupported platforms are explicit fail-closed preconditions. Fresh full C-05 is next; C04 and the earlier NOT_ACCEPTED aggregate remain unchanged. No commit/push.


Finalized C-05: C-05 INCOMPLETE: 0/10 selected requirements; 4/10 TASK_VERIFIED; capture 41/41; ledger 8df97c9fc8e72be19e1e905ce05cd87d88daff85b94ffd0890d8d6d9a8d182d0; source/candidate/private audit passed. Gate evidence is delegated, not human/TTY proof. No commit/push was performed.


## P7d source-write fence — private QC execution extension (2026-11-04)

C-05 was stopped deliberately after a separate disposable fault-injection test proved another pre-integration write path: controller-run registered validation executes worker-originated code, and source was mutated before QC returned CONFLICT. Proof: /private/tmp/omni-p7d-oK0Yu0/qc-source-write-before-fix.json. No C05 source drift was observed. C05 finalized natively at14:44:18.342Z with ACCEPTANCE_INTERRUPTED;4 tasks verified,41/41 captures complete,10218 source checks/4 integrations/0 violations. Hidden tests stayed withheld; native requirements0/10 records incomplete grading, not four model-quality failures. Immutable ledgerSHA8df97c9fc8e72be19e1e905ce05cd87d88daff85b94ffd0890d8d6d9a8d182d0. The coordinator stayed alive through native cleanup/report/archive/audit, then exited; no fabricated endedAt or settlement.

The same OS fence now covers all private registered checker/behavior commands and private pre-integration revision checks. The owned validator accepts declarative source/private root paths only; it constructs the fixed fence with its real trusted spawn, overriding caller launch options. Logical registered-command identity, immutable execution proofs, process ownership, role limits, output/time caps and cleanup remain unchanged. Unavailable QC fencing releases the QC lease/timer without executing validation or integrating. Trusted controller integration stays outside the fence. Existing post-integration/session checks and hidden-grader output semantics are unchanged and are not claimed as confined by this private-execution patch. Dependency setup uses ignore-scripts; read-only reviewer profiles remain unchanged.

Checker, behavior and revision source-write regressions first failed with actual source mutation and now pass. Additional tests preserve real owned-execution proof, reject launch-function injection, and prove lease cleanup on unavailable backend. Focused verification:147 tests/143 pass/4 Windows skip/0 fail,36.825s. Independent read-only review found no remaining blocker or additional direct private pre-integration checker-code path in the traced calls. New final17-file candidate410f84970b7248aa7cd4f45c1f249b35a0646b61a67e71e7dba505cc85945cbb onHEAD922f260 is running a fresh normal/loaded pair under /tmp/omni-p7d-verify-private-qc-fence.cjs PID16977/native57713, with continuous idle assertion16980 verified. Logs /tmp/omni-p7d-private-qc-fence-verified-{normal,loaded}.log. The earlier3360-test pair verifies the previous13-file candidate only. No source/test/controller edits during this pair; fresh full C-06 follows only after both actual checks pass. All old grades/raw evidence and fixture/oracle bytes remain unchanged; no commit/push.


## P7d private-QC source fence — final verification (2026-11-04)

The reviewed final17-file production candidate on HEAD922f260, patchSHA 410f84970b7248aa7cd4f45c1f249b35a0646b61a67e71e7dba505cc85945cbb, passed BOTH normal and loaded checks:3365 tests,3353 passed,12 skipped,0 failed,0 cancelled (416.986s/138.933s). Exact source hashes and fixture/oracle diff stayed unchanged. Receipt: `/private/tmp/omni-p7d-oK0Yu0/private-qc-write-fence-verification.json`; logs `/tmp/omni-p7d-private-qc-fence-verified-{normal,loaded}.log`. Independent review found no blocker; focused147 tests/143 pass/4 Windows skips and actual source-write RED/GREEN/private integration checks passed before the pair.

OS enforcement covers AGY/local backend descendants and registered private pre-integration checker/behavior/revision validation children; trusted controller integration remains outside. Unsupported/unavailable backends fail closed; no verified Linux/Windows backend or all-host confinement is claimed. Full C-06 is next after a real read-only Claude availability probe, AUTO off with explicitly delegated test/test-harness gates. C05 remains natively interrupted with hidden tests withheld, not regraded. All prior grades/raw evidence remain unchanged; no commit/push.


## P7d C evidence recovery and provider access block (2026-11-10)

C-06 began on November 4 at 15:16:42 UTC after a successful read-only Claude probe. The Codex tool record confirms the full C launch with AUTO off and explicit delegated benchmark approvals. At the November 10 check, neither the original coordinator nor the harness was present, and the prior temporary collection and workspace were unavailable. No native ended report, ledger, or audit was recovered. C-06's final outcome is unknown. The absence of processes or files does not establish how it ended.

The 17-file production patch still matches the verified SHA-256 `410f84970b7248aa7cd4f45c1f249b35a0646b61a67e71e7dba505cc85945cbb` on `922f260`. The acceptance fixtures are clean. The original full-pair tool outputs recovered from the chat record 3,365 tests per run, 3,353 passed, 12 skipped, and zero failures. These recovered outputs are separate from the missing temporary receipt and full logs.

C-07 is reserved as one replacement measurement for the unavailable C-06 evidence. At 10:23 ICT, the actual read-only Claude Sonnet probe returned an error with HTTP 403 and a Claude subscription-access message. The harness did not start. Once Claude access is restored, the coordinator must pass a new read-only probe before launching the same full C configuration with AUTO off and explicit `--delegate-approvals`. Production candidate bytes, probe evidence, and coordinator state are in `~/.omni/p7d-20261110/`, outside the system temporary directory. The fresh workspace and native output are also configured to remain there.

P7d remains **NOT ACCEPTED**. A-09, B-06, and D-03 retain their recorded grades on the earlier candidate. D-T08-02 remains partial, C-03 retains its 8/10 failure, C-04 retains its source-drift stop, and C-05 remains deliberately interrupted. Historical grades and unresolved lineages are carried forward as recorded. A new aggregate requires a native ended full C report and an integrity audit. P7e and P7f remain separate.

## P7d C-07 final measurement (2026-11-10)

**P7d remains NOT ACCEPTED.** Full C-07 ran from 10:36:50 to 11:25:06 ICT. The native report records `ok:false`, exit 1 and no harness error. C-07 met 8/10 requirements against the 9/10 minimum. Scope, unresolved unknown operations, duplicate dispatch and gate provenance all passed. T01–T07 and T09 were verified. The hidden grader and supplemental T04 checks ran.

T08 stopped before review dispatch with `LIMIT_EXCEEDED` at ledger sequence 892. The preserved input and compact schema take 16,744 UTF-8 bytes before adding the diff, above the 16,384-byte envelope. T10 stopped at sequence 987 with `DUAL_WORKER_REVIEW_NEEDS_FIX`. Its three review chunks returned NEEDS_FIX, APPROVE and APPROVE, and the conservative aggregation retained NEEDS_FIX. Neither task integrated or passed its hidden check.

The audit verified 95/95 finalized runtime captures, 989 authority events, matching source and archive ledger bytes, and the exact 17 production and 10 controller file copies. The source observer recorded 24,648 checks, eight receipted integrations and zero violations. Source and archive event ledger SHA-256 is `bd1a494a1bf626380326e64f520d2a42cd75675414986c2cc42d74cbb4dc24e8`. All nine gate approvals were delegated through `test/test-harness`. The audit verified private file modes, 1,571 archive file hashes and 42 transcript copies. Sixteen transcript entries were reported as unsupported by their runtime.

C-07 exercised the verified macOS source fence on patch `410f84970b7248aa7cd4f45c1f249b35a0646b61a67e71e7dba505cc85945cbb`. A-09 PASS 10/10, B-06 PASS 9/10 and D-03 PASS 9/10 are historical results on the earlier `a09df32b50cc` patch. Their original private artifacts are unavailable. D-T08-02 remains a separate partial 1/1. C-06's final outcome remains unknown. P7e and P7f require their own evidence.

Native report, audit and aggregate are under `~/.omni/p7d-20261110/` in `C-07/report.json`, `C-07-audit.json` and `P7d-write-fence-aggregate-20261110.json` respectively.


## P7d review envelope follow-up and C-08 launch (2026-11-10)

The C-07 review path repeated identical sourced answer text seven times for T08 and four times for T10. Review input now stores a shared answer suffix once and preserves each question, exact answer prefix, and original controller artifact SHA-256. Existing nonstandard reply shapes keep their prior representation. The planner tries the complete diff with a compact schema before splitting it. The 16,384-byte ceiling, full diff coverage, and conservative verdict aggregation still apply.

Replay of the preserved C-07 inputs and diffs produced one complete body per task at 16,094 bytes for T08 and 16,228 bytes for T10. Reconstructed replies matched the original strings and question order. The three new regressions failed before their fixes. The focused suite passed 34/34, and independent review signed off after the legacy reply compatibility regression was fixed.

On HEAD `922f260`, normal and loaded each ran 3,368 tests with 3,356 passed, 12 skipped, and zero failures. Verification pins production patch `630d6f82493da5d8d4669152a355dd5b186b9f4b8f1e28fa11c3a9d4d058aa14` and the suite inputs. After a successful read-only Claude Sonnet probe, full C-08 launched at 12:59:51 ICT with AUTO off and explicit delegated benchmark approvals. Its evidence is stored separately from C-07 under `~/.omni/p7d-20261110/`.


## P7d C-08 interrupted by Claude source write (2026-11-10)

C-08 ended at 14:07:17 ICT with `ACCEPTANCE_SOURCE_DRIFT` on `lib/report.js`. The source observer recorded 35,569 checks, nine receipted integrations and one violation. All 107 runtime captures finalized and the 1,162-event ledger passed hash-chain and source/archive byte equality checks. The native requirements result is 0/10 because hidden grading was withheld. Ledger verification of T01–T09 is separate from requirements grading. Scope failed, while unknown outcomes, duplicate dispatch and gate provenance passed.

T08 cleared the review envelope on this run. The worker review sent the full diff in one 15,737-byte body. Independent QC returned APPROVE and the ledger recorded TASK_VERIFIED before the later T10 stop. T10 had not reached review.

The native Claude transcript records a successful Edit targeting the outer `lib/report.js` while Claude's cwd was the private T10 workspace. The outer file mtime follows the edit by 21 ms and predates the observer's detection by 389 ms. Reversing the recorded edit reproduces the private file bytes, and the files use distinct inodes. Native transcript SHA-256 is `465fe50c4d91fe541c6746f8f88bb054baf2132b11e21140dec4dc92b0efaeaa`. The native report, audit, supplemental transcript and `P7d-review-envelope-aggregate-20261110-C08.json` are under `~/.omni/p7d-20261110/`. C-07 remains the completed full C measurement at FAIL 8/10. P7d remains NOT ACCEPTED.


## P7d Claude implement write fence and C-09 launch (2026-11-10)

The isolated Claude implementation launcher now uses the existing macOS source-write fence. The same resolved runtime selects the launcher and its fence, including across asynchronous preparation. A disposable end-to-end regression recorded an actual source write before the fix and then verified source denial, private writes and a QC handoff, including a concurrent runtime configuration change. The read-only Claude discussion and shared runner retain their existing launch profiles. The fenced implementation path refuses to launch where an OS fence is unavailable.

A disposable native Claude Sonnet probe with the full-auto implementation profile attempted both Edit and Bash writes to outer source. The source files stayed unchanged, private Edit and Bash writes succeeded, and the probe exited successfully. Its native transcript SHA-256 is `8d1cd8e3fdf993c1e4fa8831114dd475577e89c095c751969aee55be2ae46527`.

The focused tests passed 116/116. Normal and loaded each ran 3,368 tests with 3,356 passed, 12 skipped, and zero failures. The full verification receipt pins patch `c16278b912b4272752103cf5d5330bfa45a31e079a4228de61d5f8bb61664ba3` on HEAD `922f260` and the suite inputs. Following a successful read-only Claude probe, C-09 launched at 19:03:53 ICT with full configuration C, AUTO off and explicit delegated benchmark approvals. C-07 and C-08 native evidence is retained separately.


## P7d C-09 completed and audited (2026-11-10)

C-09 ran from 19:03:53 to 19:48:40 ICT on patch `c16278b912b4272752103cf5d5330bfa45a31e079a4228de61d5f8bb61664ba3`. The native result was **PASS 10/10**, with all five thresholds met. All ten hidden checks and the four supplemental T04 CLI checks passed. T08 and T10 each sent the complete diff in one review body at 15,179 and 15,640 bytes respectively. Both received independent QC APPROVE and integrated.

The audit verified all 87 runtime captures, 921 authority events, all 17 production and 10 controller file copies, and private archive permissions and hashes. The source observer recorded 25,348 checks, ten receipted integrations and zero violations. The source and archive ledgers matched byte for byte. Event ledger SHA-256 is `5b5bba37b0fb70e4d91842696d5ed85fe781512ee2645c8494f7f0af811e5923`. All 11 gate approvals were delegated through `test/test-harness`. The verification pair for this candidate ran 3,368 tests in each mode with 3,356 passed, 12 skipped and zero failures.

The recorded A–D matrix meets the scripted thresholds across different candidates. A-09, B-06 and D-03 retain their historical grades on the earlier `a09df32b50cc` patch. The original historical raw collection is unavailable. C-07 remains FAIL 8/10, C-08 remains INCOMPLETE with the attributed source write, and C-06 remains unknown. P7e, interactive P7f and the remaining P7 release criteria require separate evidence.

The native C-09 report, audit, verification receipt and new aggregate are under `~/.omni/p7d-20261110/`. The aggregate is `P7d-review-envelope-and-write-fence-aggregate-20261110-C09.json`.

### P7e — WAITING_RUNTIME (2026-11-10)

The user handed the remaining 3.2.0 work to Claude (Opus 5.5) with full authority on 2026-11-10. The P7d candidate (patch `c16278b9…`, inputs `f840a199…`, both full checks green) was committed unchanged as `5ac97c3`, its documentation as `442db94`.

- **Signal.** The original B-05 evidence directory under `/private/tmp` did not survive a reboot. The refused T07 turns' own Claude transcripts still exist under `~/.claude/projects/`. Their records carry `apiError: "usage_limit_reached"`, `apiErrorStatus: 429`, `error: "rate_limit"`, `rateLimitType: "five_hour"`, `overageStatus: "rejected"`, and the text "You've hit your 5-hour limit · resets 3:10am (Asia/Saigon)". The claude 2.1.316 binary writes these as `is_error`, `api_error_status`, `api_error` and `result` in the `-p --output-format json` result envelope (`subtype` stays `success`). `test/fixtures/squad-cli/claude-usage-limit.json` is that envelope with those values. The result envelope carries no reset time, so the wait probes instead of trusting a parsed clock string.
- **Classification.** Adapters may define `classifyFailure(raw)`. `classifyRuntimeFailure(adapter, raw)` in `lib/squad/runtimes/contract.js` returns `rate_limited | auth_expired | other`, never throws, and maps a missing classifier, an unknown kind or a classifier exception to `other`. Only claude classifies, from the typed `api_error === "usage_limit_reached"` (or `api_error_status` 429 with the observed "hit your … limit" text when the typed field is absent). V37 per CLI: **claude observed and classified (rate_limited)**; **codex not observed**; **agy not observed** — both keep the ordinary technical retry. `auth_expired` was never observed for any CLI and is not classified (V36 below).
- **Waiting.** In the worker technical-retry loop, a `rate_limited` turn is recorded as `phase.failed` with `DUAL_RUNTIME_RATE_LIMITED` and `retryable: true`; `countProviderFailures` ignores that code, so it uses no technical attempt and no task attempt. The loop then calls the caller's `runtimeWait`. Only isolated authority supplies one (default probe 10 minutes, at most 6 hours per execution; `runtimeWait: false` disables it); other callers keep the old behaviour. The wait sleeps while the existing 10-second lease heartbeat keeps the lease alive, honours the execution abort signal, re-runs the isolated guard before and after, writes a `runtime-wait` line to `turn-progress.ndjson`, and ends with `DUAL_RUNTIME_WAIT_EXHAUSTED` once the bound is spent.
- **Ledger.** Two new authority events: `task.runtime.waiting` (`runtime`, `reason`, `phase`, `wait_until`) and `task.runtime.resumed`. Both require the task's live, unreleased lease with a recorded execution owner; a resume requires a matching wait. Replay keeps `task.runtimeWait` with a probe count. `omni dual` status shows `WAITING_RUNTIME` / `wait_for_runtime` only while that lease is active; the observer timeline renders both events.
- **Scope.** Other runtimes' tasks keep running because only the refused task waits; a same-runtime task discovers the limit on its own next turn (a refused turn costs nothing) and waits too. Discussion-relay turns (scout/review through a discussion session) are not classified yet and keep their own nudge/retry handling.
- **V36.** No mid-run expired login was observed in any P7d run; nothing to classify. Recorded as not observed, no claim of a token-refresh pass.
- **Cross-task abort (V-live-P5-par-1).** Not reproduced in the config C parallel runs that completed natively (C-03, and C-09 at 10/10); the C-02/C-04/C-08 source events were distinct failures. No general concurrency-safety claim follows.
- Tests: `test/squad-runtime-wait.test.js` (classifier on the fixture, non-observed runtimes, classifier robustness, isolated wait-then-complete with five refusals beyond the three-attempt limit, bounded exhaustion, abort, unchanged legacy retry, ledger replay/authority rules, status projection).

### P7f — real-orchestrator tier (V50), 2026-11-10/11

Harness: `test/squad-agent-acceptance.js` (`fc64725`, later fixes below). A real orchestrator CLI gets `requirements.md` with the T01/T03/T06/T09 goals only (no task metadata, no file lists, no hidden-test hints), plans by itself and drives the work through the omni_dual MCP server; the harness owns the daemon, shows the person one `omni squad approve --all` command per pending spec/plan set, resumes the orchestrator's own conversation when it ends a turn early (like a person typing "continue"), and grades afterwards with the hidden tests. Bindings avoid agy so the concurrent scripted matrix keeps the single agy slot: `--preset squad` = claude orchestrator + claude worker + codex reviewer (config E); `--preset dual` = codex orchestrator + claude worker (config B). Gate delegation: `integrate` scope (user decision 2026-11-10: the person approves spec/plan on a TTY, integrate gates of exactly that plan are delegated) and `all-gates` scope (`--delegate-all-gates`, user decision 2026-11-11: spec, current plan digest and its integrates delegated). Every delegated decision is `actor: test`, `via: test-harness`; nothing is typed into the human TTY command on the user's behalf.

**squad-4 PASS** (claude orchestrator, schema v1 plan): 4/4 TASK_VERIFIED, hidden 4/4, changed files `lib/catalog.js`, `lib/csv.js`, `lib/report.js`, `test/csv.test.js`, `test/format.test.js` all inside the registered `allowed_files`, `plan-r1` human/cli-tty, four integrates delegated, 24 continuations, 43 minutes, capture complete, 0 runtime failures. The session itself then stayed BLOCKED by the session quality cycle (finding 7).

Findings, each fixed with a regression test unless stated:

1. `d6fd837` — `omni dual bootstrap --json` answered only `DUAL_BOOTSTRAP_PLAN_INVALID` / `DUAL_CONTRACT_INVALID`; the orchestrator hook (correctly) blocks ad-hoc probes, so a real claude orchestrator could not find the bad field (`acceptance_policy.ui` with only `required:false`). The JSON error now carries a bounded `issues` field; `dual-controller.md` says to omit `ui` for a non-UI project.
2. Harness — a headless orchestrator cannot wait (Claude Code refuses a standalone `sleep`, the omni hook refuses non-allowlisted Bash); resolved by same-conversation continuations (`22c1a82`). A user in `omni ui` does this by typing.
3. `74cf50b` — codex 0.166 treats every MCP tool call as needing approval unless the server sets `default_tools_approval_mode`; the generated `.codex/config.toml` lacked it, so an interactive codex orchestrator was asked on every omni_dual call and a non-interactive one had all calls rejected. Generated config now sets `default_tools_approval_mode = "approve"` (the daemon authorizes every call; no MCP tool can approve a human gate). Verified live: `approve` executes, `auto` is rejected.
4. V48 — `codex exec` ignores an untrusted project's `.codex/config.toml` (and its hooks); `-c` session flags do apply. The generated file already says it loads only after the user trusts the folder. The dual harness passes the MCP server as `-c` flags, so codex hooks are not exercised in P7f dual.
5. `b15616d` — `omni dual bootstrap` from inside codex's generated `workspace-write` sandbox (network off) gets `EPERM` on the loopback daemon. The codex skill now tells the orchestrator to request running that one command outside the sandbox; the harness stands in with `sandbox_workspace_write.network_access=true` (writes stay workspace-confined).
6. `0e6c9c3` — with a Git baseline, the coverage scout refuses untracked setup files (`AGENTS.md`, `CLAUDE.md`, `.codex/`, `.gitignore`); the codex orchestrator correctly blocked instead of committing them. `dual-controller.md` now says to ask the user to commit them before bootstrap; the harness commits them in its baseline as a user would.
7. `7e83210` — session quality cycle: the required `p0-security` gate (`npm audit`) is UNAVAILABLE without a lockfile, so an all-verified zero-dependency project could never complete its session. `npm audit` is now omitted when `package.json` declares no dependencies and has no lockfile; declared dependencies without a lockfile stay UNAVAILABLE.
8. `bb86a07` — **deadlock for every schema v2 (spec-coverage) plan**: the read-only reconnaissance scout, which exists to move coverage DRAFT → AWAITING_APPROVAL, selected its schema through `coverageGuard()` (requires PASSED). No v2 plan could reach a worker. The scout now only inspects coverage. Earlier tests always pre-wrote the reconnaissance file, so the real scout was never exercised; the new regression fails with "coverage gate is DRAFT" without the fix. Diagnosed first by the real codex orchestrator itself.
9. `bb86a07` — `gate.decide` reported `DUAL_INTEGRITY_CORRUPT` when the person's decision was durable but applying it failed (the user saw it after typing a correct code); it now answers `DUAL_GATE_APPLY_FAILED` and says the decision was recorded.
10. `ade4764` — coverage reconnaissance scouts dispatched through the daemon discussion host, which requires a live lease of the task (`lease_found fail` → `AUTHORITY_STALE`); reconnaissance runs before any lease exists. The controller now holds a short, renewed, read-only lease (owner `codex`) per scout and always releases it (`coverage_reconnaissance`).
11. `af93492` — the daemon built its shared (non-isolated) discussion adapters without a `cwd`; codex fell back to the process cwd, the claude adapter refused the turn (`SQUAD_RUNTIME_BAD_TURN`, found with a temporary diagnostic run). Shared slots now run in the workspace root.
12. `bc9afba` — the shared claude worker turn then loaded the project root's `CLAUDE.md` (controller rules via `@AGENTS.md`) and hooks, and answered as the controller in context-reply prose (`RESULT_MALFORMED` ×3). Shared claude worker turns and seeds are now isolated and exclude the cwd's own `CLAUDE.md` (new optional turn field `excludeCwdInstructions`).
13. Harness (`0091ae6`) — codex runs commands through `zsh -lc`, whose login PATH found the global omni 3.1.2; a private `ZDOTDIR` sources the user's own zsh files and puts the shim first. The prompt states that `requirements.md` is the user's authorization for coverage decisions.
14. `fd44af1` — a worker's invalid decision log (string `chosen_value` where the catalog needs objects) was recorded as `SPEC_COVERAGE_REQUIRED`, classified unknown, so the orchestrator's bounded correction was refused. Worker coverage-artifact failures are now recorded as `DUAL_DECISION_LOG_INVALID` / `DUAL_COVERAGE_REVIEW_INVALID` (worker failures).
15. V37 codex **observed** (P7f dual-12): the `exec --json` stream ends with `{"type":"error","message":"You’ve hit your usage limit … try again at 4:55 AM."}` and a matching `turn.failed`. The codex adapter now classifies exactly that as `rate_limited` (fixture `codex-usage-limit.jsonl`); a codex worker therefore enters WAITING_RUNTIME like claude. The P7f harness pauses 10 minutes and resumes an orchestrator refused by its own usage limit.
16. Scripted driver (`0cbbeab`) — a worker-classified failure (e.g. an agy scout returning prose ×3) left overlapping tasks waiting until the run deadline; like a real controller the driver now requests bounded corrections (attempts 2 and 3) and records them in `drive.corrections`.
17. `0b25242` — a coverage review embedded the whole approved artifact (21 dimensions, ~11 KiB); the review brief now carries only the task's `decision_ids` rows. **Open, needs a decision:** even scoped, a real coverage-enabled review carries ~14.6 KiB of fixed input (task contract with context replies, coverage rows, evidence, checklist; Vietnamese text is 2–3 bytes per character) plus a 2.6 KiB compact schema, past the 16 KiB discussion envelope (`CEILINGS.maxBodyBytes`), so P7f dual-14 still failed review with `LIMIT_EXCEEDED`. Options: (a) raise the ceiling to 32 KiB (one constant; 12 contract/chunking tests encode the 16 KiB boundary and need updating); (b) slim the review prompt (contract once, replies by reference). Not changed overnight because it is a protocol decision.

**P7f status (2026-11-11 06:00 +0700):** squad (claude orchestrator, schema v1 plan) PASS (squad-4). dual (codex orchestrator, schema v2 coverage plan) now passes bootstrap, coverage reconnaissance, coverage approval, delegated spec/plan gates and worker implementation, and stops at the review envelope (finding 17). V36 still not observed. V37: claude and codex observed and classified; agy not observed.
