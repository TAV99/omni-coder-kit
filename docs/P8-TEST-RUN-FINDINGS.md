# omni-p8-test run findings and fix plan (2026-11-14)

The first real squad run (`~/Documents/omni-p8-test`, a two-task landing page) took
about 10 hours of wall clock across 14 dual sessions. Twelve ended `BLOCKED`; LANDING-1
integrated in the eleventh, LANDING-2 is still open. The goal of this plan is one
smooth session: a failure that has a known cause gets a bounded correction inside the
same session, and the orchestrator can name that cause from the tool response alone.

## 1. What happened

| Session | Hours | Ended on | Root cause | Status |
|---|---|---|---|---|
| 08d59c26 | 0.4 | `DUAL_TASK_CONTEXT_UNAVAILABLE` | context under a role skill dir is excluded from snapshots | fixed d37de79, e0a2dee |
| 199ce3e1 | 0.5 | coverage STALE, `DUAL_MCP_RESPONSE_TOO_LARGE` | inspect copied the whole receipt | fixed 4e5c840, fd89bdd |
| b5057a4c, 9e0782b2 | 0.4 | `OWNER_BUSY`, scout terminal | recovered session kept old scout state | fixed b71968a |
| 0d1e76af | 7.8 (overnight) | `DUAL_TASK_CONTEXT_UNAVAILABLE` | `.agents/skills` context excluded | fixed e0a2dee |
| 03e85233 | 0.4 | `DUAL_PRIVATE_SETUP_DRIFT` | `.vitest-cache` counted as drift | fixed 762940c |
| 6b605443 | 0.6 | `DUAL_MCP_COMPLETION_ERROR` "Isolated QC failed" | real code masked by MCP | **open (F1)** |
| bdae2cd2 | 0.4 | `DUAL_QC_WORKSPACE_MUTATION` | npm bin links | fixed c465a2a, 13c68a6 |
| b9269199 | 0.7 | `SEED_FAILED` → `DUAL_WORKER_EXECUTION_FAILED`, correction refused | seed cause dropped; code unclassified | **open (F3, F5)** |
| 584b6639 | 2.8 | `CAPABILITY_BLOCKED`, `NEEDS_PROCESS_EVIDENCE` | host sleep past the 120 s lease | fixed 4ee8a7c |
| 5f4f56ed | 1.5 | `DUAL_COVERAGE_REVIEW_INVALID`, then `REVIEW_COVERAGE_INVALID` | review brief had no coverage contract; chunk contradiction unclassified | fixed f9f31e8, 0f14cc5 |

## 2. Systemic problems

1. **One failure ends the session.** `BLOCKED` is terminal, so each new failure cost a
   re-bootstrap, a fresh scout and a coverage approval (30–60 min). Corrections were
   refused whenever the failure code was unclassified (b9269199, 5f4f56ed).
2. **Causes are hidden from the orchestrator.** MCP replaces unknown codes with a generic
   `DUAL_MCP_*_ERROR`; coverage validation errors and seed failure messages are not
   persisted, so the orchestrator read worker workspace files to find them.
3. **Chunked review is slow and blind.** A 32 KiB envelope with ~15 KiB of contract leaves
   ~17 KiB of diff per chunk: 5 chunks (attempt 1) and 10 chunks (attempt 2), about
   70 s each plus setup. A chunk sees a slice of a file, so it reports false findings at
   SVG/CSS cut points and cannot verify dimensions outside its slice.
4. **Operational traps.** `omni dual bootstrap` outlasts the Codex exec tool timeout
   (the session was created, the client saw TIMEOUT); after `omni dual daemon stop`
   the MCP server answers `DUAL_DISCOVERY_MISSING` without saying how to restart.

## 3. Fixes

Done before the next Codex window (this change set):

- **F1 — MCP keeps the original code.** When a daemon error code is not public, the
  tool error still carries it as `details.cause_code`, so `DUAL_QC_*`,
  `DUAL_CORRECTION_CLASSIFICATION_REQUIRED` and similar are visible.
- **F2 — the failure summary names the validation errors.** A coverage review or
  decision-log failure records its first errors in the outcome summary.
- **F3 — seed failures keep their message.** `*.seed-failure.json` stores the sanitized
  error message, so a rate limit or auth failure is diagnosable.
- **F4 — the discovery error says how to recover.** `DUAL_DISCOVERY_MISSING` tells the
  orchestrator to run `omni dual daemon start`.

Next (needs a design decision, not started):

- **F5 — classify seed failures.** A seed that fails on a rate limit or before any
  model turn is a harness failure (`worker_launch`) and should wait or retry, not
  end the session. Needs a reliable signal from the seed message (F3 first).
- **F6 — whole-file review chunks.** Split the review diff at file boundaries and give a
  chunk whole files; send the coverage contract once per review, not per chunk; raise
  the chunk budget only with user approval (it was raised to 32 KiB on 2026-11-11).
- **F7 — bootstrap returns early.** Return the session id as soon as the plan is
  registered and let scout continue in the daemon; document a longer exec timeout.
- **F8 — fewer terminal blocks.** Before the orchestrator writes `session.blocked`,
  `next_action` should offer the in-session path (correction, recover lease, wait).
