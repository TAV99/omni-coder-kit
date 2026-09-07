# v3.1.2 Coordination Implementation Plan

Final handoff: see V3_1_2_HANDOFF.md (2026-09-07). The requested controller workflow optimization is implemented; final current tests1705 pass/0 fail/2 skipped, current independent package smoke pass, and bounded two-task Gemini3.8 live qualification passed6 phase calls. Historical checkbox details below record implementation stages and explicitly unimplemented extensions; do not confuse them with blanket capability guarantees. No commit/push/release.

> For agentic workers: use executing-plans and test-driven-development, one slice at a time. The user permits direct implementation in AGENTS.md. No commit/push, release, global configuration changes or paid live run is implied.

Goal: one user-facing Codex CLI session coordinating AGY/Gemini workers, with durable context, isolated writes, safe integration and resumable communication.

Architecture: retain the v3 authority ledger and Node runner; repair the task contract and controller entrypoints first, then introduce isolated task execution and controller-only integration. Keep existing callers compatible; never substitute a shared-writer-only patch for the final isolated-worker objective.

Tech stack: existing CommonJS Node >=20, Zod schemas and node:test. No new dependency is needed for the first slice.

## Constraints and status

- Work in the already requested `codex/v3.1.2` branch, E:/omni-coder-kit. Do not silently relocate the user's checkout.
- The implementation follows the original direct-code authorization, not a fabricated design approval. Earlier audit's approval wait is superseded by this instruction review.
- Existing ignored .omni/sdlc files belong to a different v4 task. Use this tracked plan instead, leaving those artifacts intact.
- Worker model must be resolved from real AGY capability/config, not an invented Gemini 3.8 alias.
- Safe failures remain explicit. Waiting for context/resources must not masquerade as final failure; corrupt authority and conflicting writes must never become success.
- No live AGY launch until adapter changes are offline-verified and the model/account/cost scope is confirmed.

## Slice 1 — Durable registered task metadata

Files: lib/dual/contracts.js, lib/dual/authority-store.js, lib/dual/daemon-server.js; test/dual-authority-store.test.js and test/dual-daemon-orchestrator.test.js.

Interface: existing plan.registered task carries optional context_files plus existing goal/category/complexity/risk/deny_patterns/validation_commands. Old events without these fields remain byte-compatible on replay. Derived tasks retain provided metadata, while routed owner/state and lease semantics remain controller-owned.

- [x] Add regression asserting rich registered fields survive store reopen: `assert.deepEqual(reopened.derive().tasks[id].validation_commands, registered.validation_commands)` and the same for context_files, goal and constraints. Also replay old events with absent context_files.
- [x] Add registration integration assertion: client.registerPlan → durable event → reopened store → client status retain metadata; use injected capability only, never a real model.
- [x] Run focused registration/replay tests; observed 3 failures (missing goal, rejected context_files, missing recorded context), then 3 pass after implementation.
- [x] Add optional bounded repo-relative context_files to event schema, copy it into the registered event, preserve all schema-validated task fields in reducer (`...t`, followed by derived aliases/state/revision). No schema default: old hash-chain bytes remain unchanged.
- [x] Re-run tests: `node --test --test-concurrency=1 test/dual-authority-store.test.js test/dual-contracts.test.js test/dual-mcp-server.test.js` → 99 pass, 0 fail. Full Dual checkpoint pending below.

Checkpoint: full Dual suite after metadata/briefing/retry fixes → 580 pass, 0 fail, 2 skipped, exit 0. TAP at `.omni/runs/v312-context-checkpoint-1.tap`. This is a partial implementation checkpoint, not completion of slice 2 or the original goal. Next: immutable bounded context/source binding and exact QC regression, then authority-aware run/resume and isolated workers.

## Slice 2 — Worker context packet and exact QC

Files: lib/dual/orchestrator-adapter.js, lib/dual/orchestrator.js, lib/dual/contracts.js, lib/commands/dual.js; test/dual-orchestrator.test.js, test/dual-daemon-orchestrator.test.js, test/dual-bootstrap.test.js.

- [x] Prove worker scout/implement/review inputs carry registered goal, context source paths, deny patterns and exact typed checks. Two integration tests red→green with actual fake-worker input files and final Codex QC.
- [x] Reject missing/directory/junction context sources and wrong task/baseline before worker calls, including technical retries. Three focused tests red→green. Immutable versioned source-content snapshot remains open below.
- [ ] Carry context_files in spec; render bounded task input from validated spec and context manifest, include semantic artifact paths. Paths/spec briefing are implemented; complete bounded immutable context-packet contract remains open.
- [ ] Ensure QC executes registered validation commands after daemon restart. Metadata preservation is tested; a status regression alone does not prove the actual QC command execution path.
- [x] Verify tests with a fake process runner and actual packet/artifact bytes, plus Windows path containment cases. Focused context/worker suite now covers 28 tests, 0 failures.

## Slice 3 — One controller path and observable outcomes

Files: lib/commands/dual.js, lib/dual/daemon-client.js, lib/dual/daemon-server.js, lib/dual/orchestrator-adapter.js, lib/dual/contracts.js; related CLI/daemon tests.

- [x] Reproduce bootstrap → status → run/resume backend split with real temporary daemon, no model.
- [x] Route authority tasks through the daemon; never fabricate legacy transactions. Keep legacy tasks functional when no authority lineage exists.
- [x] Add task-target and plan-revision checks to `session.resume`; preserve legacy path only when no authority ledger exists.
- [x] Add CLI regressions for Codex task, verified task, active AGY lease, unknown task, stale revision and legacy phase refusal.
- [ ] Persist bounded execution failure reason, retryability and next action. Errors before lease acquisition and after release must be visible after restart.
- [x] Preparation errors after lease acquisition but before workspace registration now persist a failed outcome. An orphan/partial attempt can advance via bounded correction using a null prior-binding marker only when no binding was registered; the old directory remains untouched. Regression/reopen and independent review close the two final-audit preparation gaps (2026-09-07).
- [ ] Validate correct ownership on every action, reject stale lineage, never hide active worker state or duplicate a live attempt.
- [x] CLI authority routing and task/revision validation are implemented and covered by 35/35 fresh CLI tests. Durable error outcome event remains open.

## Slice 4 — Isolated task execution and controller-only integration

Files: new focused modules lib/dual/task-workspace.js and lib/dual/task-integration.js, plus adapter/baseline/authority contracts and corresponding node:test files.

- [x] Define versioned workspace binding (session/task/attempt, baseline/hash, canonical root) and immutable result bundle (base hashes, changed file bytes/hash, evidence). Covered create/modify/delete and preservation of pre-existing changes; dedicated Unicode filename case remains a qualification check.
- [x] Materialize private task snapshot without requiring commits or copying authority credentials; worker writes only its private workspace. Retain workspace/result on failure. Adapter wiring is intentionally not claimed until baseline translation is implemented.
  - Live read-only preflight on 2026-09-05: AGY 1.1.27 supports `--project`, `--new-project`, `--add-dir`, `--sandbox`, and stream-json input. Existing runner suppresses --add-dir when --project is present. Therefore a private workspace MUST NOT inherit the source project's agyProjectId from copied manifest or prefix args. Bind the worker to its own canonical workspace/project and verify argv in a regression before any live run.
- [x] Integration primitive verifies all proposed paths and base hashes before writing; requires a controller guard, detects stale results, retains original backup bytes. Actual ledger-backed guard wiring remains open; no claim of safety against arbitrary processes ignoring the controller lock.
- [x] Journal integration recovers crashes before/after file application without double apply or partial success claims, including corrupt/null/scalar journal, `__proto__`, receipt revert and context drift. Adapter integration remains open.
- [x] Export workspace/integration primitives through `lib/dual/index.js`; public-index export regression is included in the workspace suite.
- [x] Register multiple isolated AGY slices with a validated acyclic `depends_on` graph; shared/mixed worker graphs retain their previous single-AGY restriction. Readiness waits for dependency TASK_VERIFIED rather than worker handoff. Cyclic/unknown dependencies are rejected at typed plan, daemon and reducer boundaries.
- [x] Serialize conflicting writes/read-context scopes in dependency order (including case-insensitive and parent/child path overlap). Task snapshots are taken on dispatch; test proves dependent task sees predecessor's integrated output. Two disjoint private tasks both complete QC without mixing diffs.
- [ ] Extend scheduling qualification to concurrent live workers, dependency evidence drift and correction/replanning. Current adapter dispatches eligible tasks serially; no claim of parallel worker throughput yet.
- [x] Rechecking a previously verified task follows subsequent verified overlapping completions, requiring handoff/receipt integrity and continuous before/after hash+mode lineage. Legitimate later integration no longer falsely flags earlier tasks as conflicted; external source drift and tampered later receipt still fail. Regression/review completed2026-09-07 (81 focused tests pass).

Scheduler checkpoint 2026-09-06: 68 focused tests passed before final routing constraints; after rejecting unsupported shared dependencies/Codex-owned isolated/risky isolated combinations, 39 tests pass. Codex orchestration work remains outside the isolated worker graph; normal shared Codex tasks remain compatible. These constraints prevent impossible handoff/QC states rather than silently changing requested isolated execution into shared writes.
- [x] `lib/dual/isolated-runner.js` now invokes the existing scout/implement/review orchestrator against the private snapshot and produces a hash-bound handoff without source mutation. Completed resume reuses validated artifacts with zero repeat worker calls. Saved worker contract pins task/model before first phase; handoff binds semantic artifact and event-log hashes.
- [x] Runtime containment is checked before artifacts are created and before/after each worker call. Exact task/baseline/spec/route/model/validation evidence checks are exercised by adversarial tests.
- [x] Wire prepared binding and completed handoff references into authority ledger events, protected by matching active AGY lease. Reopen/resume validates bound artifact/result hashes and performs zero repeat worker calls for completed handoff.
- [x] Select isolated execution using additive `execution_mode: isolated` in typed task plan; preserve it through daemon/MCP registration and dispatch to private runner from the existing adapter. Omission retains shared mode for compatibility until full qualification.
- [x] Connect isolated independent QC/integration through new `task.qc` daemon RPC, existing `omni dual qc`, and optional `isolated_qc` input of `omni_dual_completion`. Validators run independently in private cwd; validated result is integrated under Codex lease; matching QC gate and integration receipt precede task completion. Session quality gates remain separate.
- [x] Replay rechecks integration receipt hash and source after-state; validation failure/conflict does not mark task verified. Reducer rejects isolated task completion without matching handoff/QC/integration evidence.
- [ ] Qualification refinements: persistent QC progress/outcome for reconnect; dependency/build-output setup for nontrivial projects; post-integration project-wide gate; remaining multi-task/message/correction cases below.
- [x] Add explicit `dependency_mode: npm-ci` for locked single-package npm workspaces. Prepare private install before model calls using shell-free resolver, --ignore-scripts and --install-links; immutable package/lock + dependency-tree receipt are verified on resume and result/QC. Receipt digest is stored under current worker lease in authority.
- [x] Actual npm test fixture installs and executes a local locked package; lifecycle script is not run. Reject missing lock, workspace/shrinkwrap ambiguity, path-escaping local references, writable package/lock inputs and dependency/receipt drift. Shared mode cannot silently ignore private setup selection.
- [ ] Other package managers, lifecycle/native build setup, build-output policy and process-interruption recovery during dependency install remain unqualified.

Private dependency checkpoint 2026-09-06: broad authority/runner/MCP/scheduler/dependency set 112 pass, 0 fail; after reviewer found competing shrinkwrap lock precedence, added regression and rejection — dedicated dependency suite 6/6 pass. This does not imply support for every Node framework or install script.

QC checkpoint 2026-09-06: 99 tests in authority-store, daemon-client, isolated-runner and MCP suites pass. Tests execute a real Node validator (including nonzero case), CLI→real temporary daemon task.qc, fake-model handoff and MCP routing. Fresh review found receipt replay and RPC budget bugs; both were reproduced and fixed. Client task.qc budget now covers 50 bounded 60-second validators instead of 120 seconds. No paid inference or release.

Authority wiring checkpoint: 107 focused tests passed before final stale-handoff tightening; after tightening, 71 tests (authority CLI/store/contracts/runner) pass. Same-revision model reroute, revision drift, foreign root, tampered handoff and baseline/contract changes cannot reuse stale private evidence. No live inference or commit/push.

Latest evidence: saved `.omni/runs/v312-final-npm-test.log` contains full-suite terminal summary 1641 pass, 0 fail, 2 skipped (1643 tests). That run predates isolated-runner additions; it is baseline evidence, not verification of the new runner. New runner focused suite: 10/10 pass after red→green adversarial cases. No live inference, no source commit/push.

## Slice 5 — Durable agent messages, questions and corrections

Files: new lib/dual/task-messages.js, contracts/daemon/client/MCP adapters, isolated worker integration tests.

- [x] Define task/revision-correlated question/reply IDs, reply-to and acknowledgment with bounded nonblank bodies. Duplicate identical delivery reuses acknowledgement; conflicting reuse rejects. Worker question batch is one atomic ledger event under its lease; controller replies require released worker.
- [x] Route scout context questions/replies through controller: unanswered questions stop before implementation and release the lease; MCP status exposes bounded question IDs/bodies; MCP resume.context_reply delivers/acknowledges before resume. Answers do not change allowed_files.
- [ ] Extend protocol to progress, implementation-time questions/scope requests and correction results. Current question gate is scout-phase only.
- [x] Add durable execution outcomes and controller-requested correction attempts (maximum three attempts per registered task). Each correction binds the previous workspace hash and reason, retains previous artifacts/messages/outcome in history, uses a fresh private snapshot, and keeps the same registered task scope/plan revision.
- [x] Correction request IDs remain idempotent across current and historical attempts; refuse active/unreleased worker leases, exhausted budgets and any recorded partial integration. No ledger reset or workspace overwrite.
- [x] Test scout context wait/reply/reopen/resume, duplicate-ID conflict, blank reply rejection, multiple-question atomicity, forged controller file and worker answer modification. Same workspace resumes without rerunning scout; handoff hashes include controller reply artifact.
- [x] Test failed-QC correction through successful real validation and source integration; actual daemon task.correct and MCP resume.correction paths are covered. Source scope expansion still requires a separate new contract, not a reply or correction reason.
- [ ] Test process-kill/reconnect recovery during reply, correction registration and integration. Append-only records alone do not prove every crash cut-point.
- [x] Record controller PID, subprocess intent/start/exit under lease (without argv). Track real worker, npm setup and QC spawns. Normal cleanup defers release while child state is pending/running, durably records release request and finishes on actual close.
- [x] Recover pre-spawn dead-controller execution by checking real OS PID liveness; real Node controller kill/reopen and temporary-daemon RPC/MCP tests pass. Alive or uncorrelated processes cannot release; no task success is inferred.
- [ ] Process-tree containment after spawned-child crashes remains unqualified. Direct PID death can leave detached descendants, so recovery returns NEEDS_PROCESS_TREE_EVIDENCE and keeps lease; do not count this safety refusal as universal automatic recovery.

Process checkpoint 2026-09-06: process suite 8 pass; authority/runner/dependency/client set81 pass; MCP recovery regression pass. Reviewer found unsafe direct-PID release and normal cleanup-before-close; these were reproduced and changed to conservative recovery + deferred release. Full suite finished with 1700 pass, 0 fail, 2 skipped (1702 tests, 223 suites), exit 0; `.omni/runs/v312-recovery-full.tap`. All35 changed JavaScript files passed syntax check.

Correction checkpoint 2026-09-06: focused 103 tests passed before final adversarial additions; subsequent correction budget/partial integration/history replay tests and MCP outcome tests pass. Full repository test runner completed 1681 pass, 0 fail, 2 skipped (1683 tests, 223 suites), exit 0; TAP `.omni/runs/v312-correction-gate.tap`. Additional session receipt test confirms private handoff evidence maps to required delegation/scope/review gates, then three quality cycles lead to VERIFIED in a fake-worker/real-validator fixture. No live model or clean-install release qualification yet.

Question checkpoint 2026-09-06: `node --test --test-concurrency=1 test/dual-isolated-runner.test.js test/dual-authority-store.test.js test/dual-mcp-server.test.js` → 95 pass, 0 fail. Questions use fake model output; real daemon RPC and in-memory MCP client transport exercised. Fresh reviewer findings (partial question batch, whitespace reply dead-end, forged no-question reply artifact) reproduced then fixed. No live model qualification implied.

## Slice 6 — Generated workflow consistency and qualification

Files: templates/workflows and shared partials, Codex overlay, lib/init/strategies.js, templates/integrations/dual.md, README.md, CHANGELOG.md; generated configuration matrix tests.

- [x] Every generated Codex-AGY native entrypoint references `.omni/workflows/dual-controller.md` before generic execution. Pairing-specific CLAUDE/AGENTS integration text is correct; standalone Codex cook no longer mandates commit/stash or undeclared installation.
- [x] Controller reference documents current workspace/branch/context selection, exact reply/correction/isolated_qc payloads, dependencies, waits and evidence boundaries. Baseline reference agent could not find the APIs; a fresh updated-reference agent selected the correct calls and integration order. Removed stale one-AGY statement outside shared mode.
- [x] Generation/init/smoke/workflow matrix: 261 pass, 0 fail. README/Unreleased changelog describe opt-in isolated state and remaining live/dependency limitations.
- [x] Complete staged focused/full quality checks, clean install/tarball smoke and independent review. Final frozen source gate:1705 pass/0 fail/2 skipped; current tarball245-file source parity and installed CLI pass. Earlier failed gates remain in the audit with their fixes and are not counted as passes.
- [x] Obtain separately scoped two-task live AGY qualification. User approved at most9 phase calls; actual gemini-3.8-flash-high/AGY1.1.27 used6, all successful. Live question/reply, dependency handoff, independent QC/integration, three quality cycles and completed-daemon restart produced the same VERIFIED receipt. See V3_1_2_LIVE_QUALIFICATION.md for precise tested/untested boundaries.
  - Live permission blocker resolved on2026-09-06. Do not repeat the original consent request or automatically spend unused phase budget. Live correction/running-process crash and competing writes were not exercised because both tasks passed first attempt.
- [x] Audit original requirements before completion: final independent audit found two preparation/outcome gaps, both fixed/reviewed; V3_1_2_HANDOFF.md maps requested outcomes to authoritative implementation/tests/live evidence and clearly lists unsupported extensions. Package/tag/publish remain separately authorized actions.

Final audit additions2026-09-07: snapshot-preparation outcome/recovery regressions pass; bound-workspace correction still checks its exact hash while preparation-only correction permits a null prior binding and retains old files. Focused preparation/authority/integration/process/contracts suite115/115 pass. Concurrent broad run exposed Stop hook completion timeout inherited from500ms health timeout; completion now explicitly receives10000ms, and three Stop regressions pass. Broad/package gates must be refreshed once code is frozen; do not use the pre-fix tarball or partial broad run as current qualification.

Packaging checkpoint 2026-09-06 (not release): clean temporary copy of package.json/package-lock.json completed `npm ci --ignore-scripts --no-audit --no-fund` (104 packages). `npm pack` artifact independently installed (105 packages) and passed CLI --version/dual --help, runtime-module inclusion and six native controller entrypoint assertions. Artifact version remains 3.1.1, SHA256 D4BE257AD8C5B7815DB860E53FE14A4F39A01E2633E3F77411191FB74287B46C; no tag/publish/commit/push. Temporary qualification root: C:/Users/TAV/AppData/Local/Temp/omni-v312-qualification-e1ba12bf75134ae29cf2b4d1538ac58a. This qualifies that packed snapshot's installability only, not live operation or final v3.1.2 release.

Updated runtime package after process/dependency recovery: SHA256 A94EFEA4A569C2AE28A4425F1C9B536CB443C345029E503F595310D72509F088, path C:/Users/TAV/AppData/Local/Temp/omni-v312-recovery-pack-3df047e20256499d8fddcd658b42d9c2/omni-coder-kit-3.1.1.tgz. Independent install/CLI/runtime byte parity/controller-reference smoke passed. Live authorization still pending; do not infer approval from automatic continuations.
