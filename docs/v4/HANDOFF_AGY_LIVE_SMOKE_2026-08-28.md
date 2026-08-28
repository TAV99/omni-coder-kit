# Omni v4 AGY Live Smoke Handoff — 2026-08-28

## Current state

AGY CLI `1.1.22` is installed and authenticated on `win32-x64`. Its version and required CLI flags probe successfully. Local v4 gates are green, but AGY remains `experimental` because no post-remediation live smoke has returned a successful end-to-end `StepResult`.

Claude qualification is intentionally deferred until the user has a Claude account.

## Changes prepared

- Resolve native executables behind Windows npm `.cmd` shims without enabling `shell:true` or executing batch wrappers.
- For AGY `workspace-write`, retain `--sandbox` and add `--dangerously-skip-permissions` so headless verification commands are not soft-denied.
- Parse a schema-valid JSON `response` when AGY 1.1.22 completes without populating `structured_output`; JSON parsing and `AgentStepOutcomeSchema` validation remain fail-closed.
- Add regression tests for the Windows shim, AGY invocation, and AGY response-envelope fallback.

## Live evidence

Four bounded live attempts were used:

1. The README mutation succeeded, but AGY soft-denied `RunCommand` in headless `accept-edits` mode and returned no structured result.
2. With command permissions auto-approved, mutation and verification succeeded, but AGY hit its internal 110-second print timeout.
3. With a 240-second outer timeout, AGY completed in about 68 seconds and generated a schema-valid success JSON. AGY 1.1.22 repeatedly failed its internal `finish` tool validation, so the final envelope omitted `structured_output`; the adapter therefore failed before the response fallback was added.
4. The post-fix qualification run on 2026-08-29 again mutated README successfully, but the fallback received multiple concatenated response fragments. Strict JSON parsing rejected the ambiguous envelope with `ANTIGRAVITY_MALFORMED_OUTPUT` after about 138 seconds.

The compatibility manifest was deliberately not promoted. Live mutation alone is insufficient evidence for first-class qualification, and arbitrary trailing output must not be accepted as a false-green result.

## Fresh verification

- `npm audit --audit-level=high`: PASS, 0 vulnerabilities.
- `npm run typecheck:v4`: PASS.
- `npm run build:v4`: PASS.
- Targeted AGY/process suite: PASS, 24 passed, 2 skipped, 0 failed.
- `npm run test:v4`: PASS, 193 passed, 2 skipped, 0 failed; 195 total.
- `git diff --check`: PASS.
- Tracked-diff credential scan: PASS, 0 matches.

## Recommended disposition

Keep AGY 1.1.22 experimental. Do not spend additional model calls retrying the same contract. Reopen qualification only after one of these inputs materially changes:

- AGY ships a newer CLI with reliable `finish`/`structured_output` behavior.
- Omni adopts and tests a different explicit AGY model contract.
- The adapter architecture gains an unambiguous completion channel that remains fail-closed.

Only after a fresh end-to-end live smoke passes should `compatibility/v4/hosts.json` be updated for AGY 1.1.22 on `win32-x64`.
