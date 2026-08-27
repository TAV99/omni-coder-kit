# Dual AUTO setup state gates — P0 implementation plan

**Goal:** Make the Codex + AGY AUTO pipeline continue deterministically from an approved `om-think` design into setup and a durable Dual session without allowing source mutation in the gap.

**Architecture:** Treat setup as an enforced state transition, not a prompt convention. The typed setup manifest is semantically validated, one known legacy model error (`native` + package-manager identifier) is repaired atomically, and plan registration requires a matching SUCCESS receipt. Codex hooks permit planning/control-plane operations before authority exists but block source mutation once a design spec is ready.

**Compatibility:** Direct process invocation remains `shell: false`. Package managers continue to resolve through trusted native binaries or Node CLI entrypoints on Windows, Linux, and macOS. No shell fallback is introduced.

## Task 1 — Semantic setup contract and safe repair

**Files:** `lib/dual/contracts.js`, `lib/dual/setup-command.js`, `test/dual-contracts.test.js`, `test/dual-setup-cli.test.js`

- Replace the loose setup action object with a discriminated semantic contract.
- Reject package-manager identifiers under `kind: native`.
- During `omni dual setup run`, atomically canonicalize only the exact legacy mismatch to `kind: package-manager`.
- Return bounded repair metadata and retain strict failure for every ambiguous or unsafe action.
- Verify direct package-manager execution remains shell-free and portable.

## Task 2 — Setup receipt gate at plan registration

**Files:** `lib/dual/setup-command.js`, `lib/dual/daemon-server.js`, `test/dual-daemon-orchestrator.test.js`

- Add a reusable setup-readiness check.
- If no setup manifest exists, plan registration remains compatible.
- If a setup manifest exists, require a valid SUCCESS receipt matching the current manifest hash and action count.
- Reject missing, stale, corrupt, or invalid setup evidence before capability preflight/plan registration.

## Task 3 — Pre-authority phase gate and control-plane allowlist

**Files:** `lib/dual/hook-bridge.js`, `test/dual-hook-bridge.test.js`

- Keep pre-design behavior advisory so direct workflows remain compatible.
- Once `.omni/sdlc/design-spec.md` is non-empty and no durable session exists, allow only reads, bounded planning artifacts, typed setup execution, and Omni Dual MCP control operations.
- Deny source/build/browser mutations until `omni_dual_begin` creates durable authority.
- Make `Stop` continue AUTO once, while respecting the hook recursion guard.
- Ensure daemon unavailability cannot bypass this phase gate.

## Task 4 — Native skill and workflow sequencing

**Files:** `lib/init/strategies.js`, `templates/codex-gemini/SKILL.md`, `templates/workflows/task-planning.md`, `templates/workflows/coder-execution.md`, `test/workflow-command-contracts.test.js`, relevant init tests

- Encode the authoritative order: design → skill → plan → typed setup SUCCESS receipt → begin → register → resume/cook.
- State that the exact repairable kind mismatch is self-healed; ambiguous/security failures remain fail-closed.
- Require setup receipt and active Dual authority before source edits.

## Verification

- Run focused contract, setup CLI, hook bridge, daemon orchestration, workflow contract, and init tests.
- Run `npm run test:dual`.
- Run the full repository test suite if focused gates pass.
- Review the final diff without committing or pushing.
