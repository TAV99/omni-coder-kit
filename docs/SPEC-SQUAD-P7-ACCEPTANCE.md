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
4. For each task, run `task.qc` (with the reviewer in squad). Every task is held at `AWAITING_HUMAN_APPROVAL`, then the person approves the whole set (§5).
5. Integrate one by one. A task whose digest changes after an earlier integration opens a new gate and waits for the person again.
6. Copy the hidden tests into the integrated workspace and run each task's test on its own (`node --test hidden/Txx.test.js`).
7. Compute the thresholds (§4), write the report, stop the daemon and `omni ui`.

---

## 4. Measuring the thresholds (ledger + git + hidden tests)

| Threshold | How it is measured | Pass when |
|---|---|---|
| Meets requirements | The task is `TASK_VERIFIED` and its hidden test passes on the integrated tree | ≥ 9/10 per config |
| 0 out of scope | For each integrated task, the changed files (git diff before/after its integration) ⊆ `allowed_files`. Attempts stopped by `gate.result scope FAILED` are recorded (the guard did its job) and are not violations | 0 out-of-scope files reach the source |
| 0 unknown outcomes | At the end of the run, none of these remain: `task.execution.finalization_failed` with `settled: false`; `active`/`expired` leases never released; `task.failure.classified` of category `unknown` not granted/settled. Every task is in a final state (`TASK_VERIFIED`, `FAILED`, `BLOCKED`, `CONFLICT`) | 0 |
| 0 duplicate dispatches | Each `(task_id, attempt)` has at most one `task.execution.started`, and no two `active` leases of the same `task_id` overlap in time | 0 |
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

The harness holds every task at `AWAITING_HUMAN_APPROVAL` before asking. Each config then needs about two actions from the user: `plan-r1`, then one `--all` for the integrate gates.

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

- [ ] Task suite + V46 green in `npm test`.
- [ ] Configs A–D finished, each meeting all 5 thresholds of §4; `docs/ACCEPTANCE-3.2.0.md` has the numbers per config.
- [ ] Both real-agent runs finished; bugs found are fixed or clearly recorded.
- [ ] V37: each CLI either has classification based on real signals or is recorded as "not observed"; V36 and the cross-task abort have recorded results.
- [ ] `npm test` green on macOS, plus one loaded run.
- [ ] V44 (Safari/Firefox, from P6) tried by hand.
- [ ] Ready to take to real Linux/Windows machines (plan §11).
