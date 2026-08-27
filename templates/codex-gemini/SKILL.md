---
name: omni-codex-gemini
description: Native Codex orchestration skill for delegating scout, implementation, and review work to Gemini via Antigravity (agy).
---

# Omni Codex-Gemini Orchestration

## Role & Authority
- Codex is the manager, orchestrator coordinator, and final verifier.
- Gemini (via Antigravity / `agy`) is the delegated worker.
- Antigravity worker phases run with the approved `--dangerously-skip-permissions` flag managed by the `omni dual` orchestrator.
- Codex retains final QC, git validation, and all commit/push authority. Never commit or push automatically.

## Dual AUTO MCP Operations
- `omni_dual_begin`: Begin or attach a Dual session with workspace baseline capture.
- `omni_dual_register_plan`: Register the user-approved typed plan and route tasks to AGY or Codex.
- `omni_dual_status`: Inspect session state, active leases, tasks, quality gates, and authority ledger.
- `omni_dual_resume`: Continue/resume execution across planned tasks and worker slices.
- `omni_dual_completion`: Submit typed QC evidence, record quality/UI gate cycles, and evaluate verified completion receipt.

## CLI Compatibility Commands
- `omni dual bootstrap [--json]`: Validate planning/setup, create authority, register the full graph once, and resume.
- `omni dual daemon start|status|stop|recover`: Manage workspace authority daemon lifecycle.
- `omni dual new <task-id>`: Initialize task transaction directory.
- `omni dual run <task-id>`: Run transaction through scout, spec, Gemini implementation, and review.
- `omni dual resume <task-id>`: Resume an incomplete or interrupted transaction.
- `omni dual status <task-id>`: Inspect current transaction state and next action.
- `omni dual phase <phase> <task-id>`: Run an individual phase.

## Auto Pipeline after `$om-think`
1. Complete the approved design, install selected skills, and generate `.omni/sdlc/setup.json`, `.omni/sdlc/todo.md`, and the complete `.omni/sdlc/dual-plan.json` graph. These are planning artifacts outside the execution ledger.
   - Put source implementation deliverables only in `dual-plan.json`; setup, planning, final QC, review, and verification remain controller/gate operations rather than tasks.
2. Call `omni dual bootstrap --json` exactly once. It validates the full graph, executes/reuses typed setup, requires its `SUCCESS receipt`, creates authority after setup, registers the real graph once, and resumes eligible AGY tasks.
   - Use at most one cohesive AGY-owned implementation slice per session; the immutable baseline cannot safely measure multiple sequential AGY diffs. Give AGY the highest-value low-risk 1-10 exact-file slice and keep architecture/QC in Codex.
3. Never create a temporary `bootstrap-plan-artifacts` task and never call `omni_dual_begin`/`omni_dual_register_plan` directly during `$om-think` AUTO. The controller owns those low-level operations.
   - For a legacy planning-only session, the controller may archive and adopt it only with a matching setup receipt and bounded planning/package drift; every other mismatch fails closed and preserves the old ledger.
4. Check status with `omni_dual_status`. AGY runs end at `CODEX_QC` and AGY never self-approves.
5. Codex inspects AGY artifacts, runs verification checks, and submits typed `omni_dual_completion` evidence for each task.
6. Record required quality cycles and UI evidence through `omni_dual_completion`.
7. Call `omni_dual_completion` to receive the verified completion receipt once all tasks and mandatory gates pass.

## Evidence Hierarchy (Precedence)
1. Current source code and git diff
2. Fresh command output with exit code
3. Generated artifacts with schema validation
4. Approved spec (`spec.json`)
5. Worker prose / summaries (lowest precedence, never self-approving)

## Codex Token Economy
- On the success path, consume semantic artifacts first: `context.json`, `spec.json`, `evidence.json`, `review.json`, and bounded MCP status/completion summaries.
- Read raw stdout/stderr only when a phase fails, artifact hashes or correlation disagree, or crash recovery requires diagnosis. Never load raw attempts on the normal success path.
- Do not copy AGY reasoning into Codex context. Preserve conclusions, evidence, risks, and exact file/symbol references only.

## Phase Isolation
- While an AGY task lease is active, Codex coordinates only: no source, build, or browser writes.
- Wait until the AGY lease is released and the task reaches `CODEX_QC` before Codex inspects the final diff, runs builds/tests/browser QA, or writes a correction.
- If Codex rejects QC, register a bounded correction cycle; do not work concurrently in the AGY-owned slice.

## Terminal Stop Conditions
- Fail closed on missing/blocked preflight, schema validation error, diff scope violation, review mutation, or malformed JSON.
- Stop and report BLOCKED if architecture changes, scope drifts, or test failures persist across correction rounds.
- Never claim completion without current verification command outputs.
