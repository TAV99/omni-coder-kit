# Dual Single Bootstrap Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace model-invented bootstrap tasks with one typed, deterministic `omni dual bootstrap` control-plane command that completes planning/setup before creating the durable execution ledger.

**Architecture:** `$om-think`, skill selection, `.omni/sdlc/setup.json`, `.omni/sdlc/todo.md`, and `.omni/sdlc/dual-plan.json` are planning artifacts outside execution authority. `omni dual bootstrap` validates those files, executes/reuses typed setup, starts authority only after setup succeeds, registers the full implementation graph once, and resumes AGY tasks. A legacy adoption path may archive an old planning-only session after proving no leases/gates/task execution and a matching setup receipt; it then captures the current post-setup baseline.

**Tech Stack:** Node.js CommonJS CLI, Zod contracts, daemon RPC, `node:test`, shell-free child processes.

## Global Constraints

- Windows CMD/PowerShell, Linux, and macOS behavior must stay argv-only with `shell: false`.
- No automatic commit, push, deployment, destructive ledger deletion, or global AGY configuration change.
- AGY stays `gemini-3.7-flash-high`, effort high, with the already approved permission bypass.
- Planning artifacts are not implementation tasks and never require a Codex/AGY execution lease.
- Until per-task baseline promotion exists, a typed graph contains at most one cohesive AGY-owned 1-10 exact-file slice; this is an explicit P0 safety boundary, not a claim of multi-AGY-task support.
- Production authority remains fail-closed for source drift, active/unreleased leases, gates, verified work, blockers, or receipts.

---

### Task 1: Typed dual plan contract

**Files:** `lib/dual/contracts.js`, `test/dual-contracts.test.js`

- [ ] Add a strict versioned `DualPlanManifestSchema` containing `schema_version`, `plan_revision`, and the complete task graph accepted by plan registration.
- [ ] Reject missing task goals, unsafe repo paths, duplicate task IDs, invalid AGY command contracts, extra keys, and oversized graphs before any setup/daemon side effect.
- [ ] Export the schema for CLI and test consumers.

### Task 2: Planning phase authority

**Files:** `lib/dual/hook-bridge.js`, `test/dual-hook-bridge.test.js`

- [ ] Treat `.omni/sdlc/dual-plan.json` and bounded `docs/superpowers/plans/*.md` as planning artifacts before durable authority.
- [ ] Allow only exact `omni dual bootstrap [--json]` and Node entrypoint forms as control-plane operations.
- [ ] Keep source/build/browser mutation denied until the full graph is registered.

### Task 3: Single bootstrap controller

**Files:** `lib/commands/dual.js`, `bin/omni.js`, `test/dual-daemon-cli.test.js`

- [ ] RED: bootstrap rejects missing/invalid typed plan before creating daemon authority.
- [ ] RED: bootstrap runs/reuses typed setup before session creation, hashes the typed plan, registers the full graph exactly once, and resumes.
- [ ] RED: retry is idempotent for an identical registered graph.
- [ ] Implement `omni dual bootstrap --json` using existing setup, daemon client, plan registration, and resume interfaces.

### Task 4: Legacy planning-session adoption

**Files:** `lib/commands/dual.js`, `test/dual-daemon-cli.test.js`

- [ ] RED: a legacy session with only REGISTERED/ROUTED planning tasks, zero leases/gates/blocker/receipt, and a matching setup SUCCESS receipt is archived without deletion.
- [ ] RED: adoption rejects source execution evidence, missing/stale setup receipt, leases, gates, blocker, verified task, or receipt.
- [ ] Start fresh authority from the current post-setup baseline and register the actual full graph.

### Task 5: Native workflow contract

**Files:** `templates/codex-gemini/SKILL.md`, `templates/workflows/task-planning.md`, `templates/workflows/coder-execution.md`, `lib/init/strategies.js`, workflow/init tests

- [ ] Replace model-authored `begin → temporary plan → replan` with `plan artifacts → typed setup → omni dual bootstrap`.
- [ ] Explicitly forbid bootstrap planning tasks and direct plan registration from `$om-think` AUTO.
- [ ] Preserve token economy and AGY delegation rules after bootstrap.

### Task 6: Verification and dogfood

- [ ] Run focused contract/hook/bootstrap/workflow tests.
- [ ] Run `npm run test:dual` and `npm test`.
- [ ] On `E:\DemoSite`, use the controller to adopt the current planning-only session, then verify the registered graph contains actual implementation tasks and AGY receives an eligible task.
- [ ] Do not claim full completion until a real Codex CLI `$om-think → AGY task → Codex QC` transaction passes.
