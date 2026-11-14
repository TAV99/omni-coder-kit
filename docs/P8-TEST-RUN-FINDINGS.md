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

Approved and done (2026-11-14):

- **F5 — seed failures are harness failures.** An outright seed failure (exit code set,
  not timed out) is `DUAL_DISCUSSION_SEED_FAILED`, classified harness/`worker_launch`;
  a kill mid-seed keeps `DUAL_WORKER_EXECUTION_FAILED` and its automatic recovery.
  Rate-limit waiting for seeds (WAITING_RUNTIME) is still open.
- **F6 (part) — chunk prompts agree with the contract.** The per-chunk text no longer
  says "never claim checks for unseen code" (it contradicted the Review coverage
  contract); a file cut across chunks is labelled "Part i of n", so a cut is not a
  defect. Still open: sending the task input once per review. Chunks share one
  conversation, but a discussion re-seed mid-review would leave later chunks without
  the task contract, so it needs a re-seed-safe design first. Budget unchanged.
- **F7 — bootstrap no longer times out.** `session.resume` waited on the 500 ms
  discovery timeout while the daemon dispatched the scout; it now waits up to 35 s.
- **F8 — unclassified failures are relayed.** `next_action` is
  `relay_failure_to_human` when the correction policy cannot classify the failure,
  instead of a `request_correction` it would refuse.

## 4. Run c2f42f52 (2026-11-14, after F1–F8)

Bootstrap, context questions (answered by the orchestrator in under a minute, twice),
a single-pass review (about 1 min, three real findings) and the automatic NEEDS_FIX
correction all worked. The session blocked on attempt 2:

- **F9 — the correction worker did not see the findings (fixed).** `correction_context`
  carried only the reason; it now carries the previous rejection's findings verbatim.
- **F10 — preserved attempts exhausted the write fence (fixed).** The fence walked the
  whole project, including 11 preserved attempt workspaces with their own
  `node_modules` (189k of 207k entries), and refused at 200k. Daemon re-dispatch of
  undelivered context then repeated the refusal every ~90 s until the orchestrator
  blocked the session. Other attempts' workspaces are no longer walked. The old
  sessions' workspaces were moved to `~/Documents/omni-p8-archive/`.
- **Still open:** context re-dispatch after a pre-launch refusal is unbounded (each
  retry walked the tree synchronously for ~80 s); the refusal message lives only in
  `worker_start.error`, not in the ledger.

## 5. Run 9d288f0b (2026-11-14, after F9–F10)

F9 and F10 worked live: attempt 1's two WARNING findings reached attempt 2's
`correction_context`, and the fence passed. Attempt 2's scout then stalled: the
discussion received the scout question for argon (agy/sonnet) at 07:55:12 but never
recorded a `dispatch_intent` (about 40 s in earlier turns), and no process started.
The watchdog aborted after 300 s (`DUAL_NO_WRITE_PROGRESS`); the discussion close
could not prove quiescence, so the run never settled, the lease expired and the
session blocked on `NEEDS_PROCESS_EVIDENCE`. No host sleep.

- **F11 — daemon diagnostics were discarded (fixed).** stderr went to `/dev/null`;
  it now goes to `.omni/runtime/dual/daemon.log`.
- **F12 — a watchdog abort with no live child now settles (fixed).** The ledger proves
  quiescence when every tracked child exited; the outcome is recorded instead.
- **Open:** why the scout turn never dispatched (needs the daemon log from a rerun);
  `DUAL_NO_WRITE_PROGRESS` and `DUAL_TURN_STALLED` are unclassified, so F8 relays them
  to the user instead of granting a correction.
