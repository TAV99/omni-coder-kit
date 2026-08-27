# Dual runtime authority and recovery — P0 implementation plan

**Goal:** Remove the deadlocks and false-positive guards observed in the real AI4Teacher Codex + AGY session while preserving fail-closed source mutation.

**Approved direction:** Keep Dual AUTO strict, but distinguish interactive Codex authority from AGY worker leases. A uniquely matched Codex-owned routed task may be authorized directly by the hook/daemon pair; AGY tasks still require a live worker lease. Planning paths are canonicalized against the workspace so Codex absolute `apply_patch` headers cannot change phase classification between PreToolUse and PostToolUse.

**Portability:** All path checks use platform-aware path operations and repository containment. Commands remain direct process invocations with `shell: false`; no CMD, PowerShell, Bash, Linux, or macOS shell fallback is introduced.

## Task 1 — Stable planning-path classification

**Files:** `lib/dual/hook-bridge.js`, `test/dual-hook-bridge.test.js`

- Accept an absolute tool path only when a workspace root is present and the path resolves inside that exact workspace.
- Convert contained absolute paths to canonical repository-relative paths before phase and task classification.
- Keep absolute paths outside the workspace, traversal, malformed patch headers, and mixed-root paths fail-closed.
- Verify the same design-spec write is allowed at both PreToolUse and PostToolUse even when the file becomes non-empty between hooks.

## Task 2 — Interactive Codex authority without phantom leases

**Files:** `lib/dual/hook-bridge.js`, `lib/dual/daemon-server.js`, focused hook/daemon tests

- Infer a unique active leased task first.
- If no leased task matches, allow a unique `ROUTED`, Codex-owned task whose declared files exactly contain the mutation paths.
- The daemon accepts lease-less mutation only for that Codex-owned routed task and still validates owner plus allowed files.
- AGY-owned tasks remain lease-required; ambiguous task matches remain denied.

## Task 3 — Plan artifact integrity and actionable recovery errors

**Files:** `lib/dual/daemon-server.js`, `lib/dual/mcp-server.mjs`, daemon/MCP tests

- Require a strict repository-relative plan path that resolves to a regular file.
- Hash the actual plan bytes and compare them to `plan_sha256` before registration.
- Preserve stable safe error codes such as transition, setup, and plan-integrity failures through MCP instead of collapsing every failure to a generic wrapper.
- Keep raw internal paths, command output, and secrets out of user-visible errors.

## Task 4 — Safe control-plane inspection

**Files:** `lib/dual/hook-bridge.js`, `test/dual-hook-bridge.test.js`

- Allow only non-mutating inspection forms such as `omni dual --help`, `omni dual status`, and their Node entrypoint equivalents during bootstrap.
- Continue denying unknown Omni commands, output redirection, shell operators, duplicate/unsupported flags, and mutating commands outside typed setup.

## Task 5 — Codex MCP completion tool compatibility (AGY-owned subtask)

**Files:** `lib/dual/mcp-server.mjs`, `test/dual-mcp-server.test.js`

- Reproduce the real list-tools schema discrepancy.
- Make the smallest wire-compatible schema/registration correction supported by evidence.
- Keep all five Dual tools registered and validate `omni_dual_completion` through the actual MCP client path.

## Acceptance gates

- Focused hook, daemon, and MCP tests pass.
- Existing AGY lease enforcement and outside-workspace path denial remain green.
- `npm run test:dual` passes.
- Full `npm test` passes, including v4 checks.
- Final diff is reviewed; no commit or push without separate user approval.
