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
   - 100% of approval gates behave correctly (a `human-always` gate is never skipped by AUTO).
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

- The harness **never approves gates** on the person's behalf. `human` / `human-always` gates are approved only by a person on a TTY. §5 is how the number of codes typed is reduced.
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

---

## 5. Gates during acceptance (Q-P7-2)

Ten tasks × four configs is over 40 integrate gates. A code per gate overloads the person and invites mistyped codes (seen many times in P3–P6).

**`omni squad approve --all`:**
- still TTY-only;
- lists every pending gate, each with its summary and digest;
- the person types **one code**, derived from the sorted set of digests. If the list changes between display and typing, the code is no longer valid.

The ledger still records one `gate.approved` per gate (`actor: human`, `via: cli-tty`). No MCP tool does this, and the hook still blocks agents from running the command. `--all --reject --reason …` rejects the whole set.

The harness holds the currently ready frontier at `AWAITING_HUMAN_APPROVAL` before asking. Each config needs `plan-r1`, then one or more `--all` batches as conflicting scopes become ready. The original all-ten-at-once hold would deadlock under `taskReadiness`: for example T02 cannot start until T01 is `TASK_VERIFIED`. The user approved frontier batches instead of changing scheduler or integration authority.

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
- [ ] Both real-agent runs finished; bugs found are fixed or clearly recorded.
- [ ] V37: each CLI either has classification based on real signals or is recorded as "not observed"; V36 and the cross-task abort have recorded results.
- [ ] `npm test` green on macOS, plus one loaded run.
- [ ] V44 (Safari/Firefox, from P6) tried by hand.
- [ ] Ready to take to real Linux/Windows machines (plan §11).

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
