# Dual runtime authority P0 — verification report

Date: 2026-08-26

## Implemented

- Canonicalize contained absolute `apply_patch` paths to repository-relative paths before planning/source classification.
- Keep outside-workspace absolute paths and traversal fail-closed on Windows and POSIX path forms.
- Preserve planning classification across the PreToolUse → PostToolUse transition after `design-spec.md` becomes non-empty.
- Authorize a unique routed Codex-owned task as interactive authority without manufacturing a short-lived worker lease.
- Keep AGY-owned mutations lease-bound and reject ambiguous or out-of-scope mutations.
- Permit bounded read-only Dual CLI inspection (`dual --help`, `dual status`, optional `--json`) without broadening the mutation allowlist.
- Verify `plan_path` is a readable repository-relative regular file and `plan_sha256` matches its current bytes.
- Preserve safe actionable plan/setup/transition error codes across MCP without exposing raw internal messages.
- Replace the MCP tuple wire schema that caused `omni_dual_completion` incompatibility with an object-only array item schema while retaining the exact viewport sequence contract.
- Add `omni dual daemon recover --if-pristine --json`: archive an abandoned ledger and create fresh authority only when the workspace matches baseline and no lease, gate, execution evidence, blocker, or receipt exists.

## AGY contribution and Codex review

- AGY (`gemini-3.7-flash-high`, effort high, permission bypass enabled) isolated the omitted completion tool to the tuple-shaped JSON Schema emitted for `viewport_widths` and added a wire-schema regression test.
- Codex reviewed the change, retained it, and added an exact-order refinement plus a duplicate/incorrect viewport regression so the new compatible schema did not weaken the domain contract.

## Verification evidence

- `node --test --test-concurrency=1 test/dual-hook-bridge.test.js`
  - 30 pass, 0 fail.
- `node --test --test-concurrency=1 test/dual-mcp-server.test.js`
  - 36 pass, 0 fail.
- `node --test --test-concurrency=1 test/dual-daemon-orchestrator.test.js`
  - 46 pass, 0 fail.
- `npm run test:dual`
  - Final post-recovery run: 545 pass, 0 fail, 2 skipped because the Windows host cannot create the relevant test symlinks.
- `npm test`
  - v3: 1,571 pass, 0 fail, 2 skipped.
  - v4: 187 pass, 0 fail, 2 skipped.
- Overall command exit code: 0.

## Live DemoSite recovery smoke

- Global `omni-coder-kit@3.0.0` is linked directly to `E:\omni-coder-kit`.
- `E:\demoSite` manifest remains `ide: dual`, `mode: auto`, pair `codex-agy`, permissions `dangerous-auto`.
- Recovery archived session `d1cdfa3a-74ad-4400-9e27-d4b25fabd6a1` under `.omni/runs/dual-history/` without deleting its event log or initial snapshot.
- Fresh session `4078b65c-c167-4789-8e05-32277c6cfd74` is healthy at `DISCOVERED` with 0 tasks, 0 leases, and 0 gates.
- A real stdio MCP handshake bound to `E:\demoSite` returned all five tools, including `omni_dual_completion`.

## Qualification boundary

- The repository behavior and cross-platform path/argv contracts are automated-tested on the current Windows host.
- No full user-prompt Codex + AGY implementation transaction using this exact patch has yet been completed in `E:\DemoSite`; the authority recovery and MCP wire surface were live-smoked.
- Linux and macOS code paths are covered by deterministic tests, but native live-host smoke on those operating systems is not claimed by this report.
- No commit, push, release, or deployment was performed.
