# What omni squad takes from Orca (post-3.2.0 plan)

Source: the Orca (stablyai/orca) analysis in session `de33aa78`, re-checked on 2026-11-11 against branch `3.2.0` after P7 closed. Every item below gives its evidence in this repo. None is implemented yet.

## Already covered by P7: do not redo

| Orca idea | Where squad has it now |
|---|---|
| Dispatch fencing (dispatch/pane/launch token) | Lease + operation chain, `assertOperationAuthorized`, reclaim only on `confirmedDead` (`lib/dual/isolated-authority.js`) |
| `unknown` as a first-class state | Unresolved operations stay unresolved (A-04/D-02/A-08); `NEEDS_PROCESS_EVIDENCE` (`lib/dual/authority-store.js:504`) |
| Idempotent mutations | Inbox UUID + sha256, `DUAL_INBOX_CONFLICT` |
| Per-worker isolation | Private worker workspace + macOS source-write fence (C-08 fix, C-09 PASS 10/10) |
| Prompt/payload budget computed up front | Review planner sends the complete diff in one compact body, splitting under 16 KiB; discussion envelope 32 KiB |
| Usage-limit failure classification | `WAITING_RUNTIME` via the runtime's own `classifyWorkerFailure` (P7e, claude + codex) |

## Real gaps, in priority order

### O1. Classify the timeout branch and discussion turns too (small, high value)
- **Evidence.** In `lib/dual/orchestrator.js` (~line 1198), the `result.timedOut` branch counts a technical attempt and retries without asking the runtime. Only the contract-failure branch calls `classifyWorkerFailure`. HANDOFF §12 states "Discussion-relay turns are not classified yet".
- **Orca.** Classify first; the breaker counts only real technical failures.
- **Change.** Run the same `classifyWorkerFailure` verdict before counting a timeout. Wire the discussion relay (`lib/dual/discussion/live-*-invoke.js`) to `WAITING_RUNTIME`. A usage limit then never consumes the 3 attempts.

### O2. Typed `next_action` on every orchestrator receipt (small)
- **Evidence.** `next_action` is set in one place only (`lib/dual/mcp-server.mjs:421`). Stop-hook messages are free text.
- **Change.** Add a shared enum (`request_correction | block_exhausted | wait_runtime | ask_human | integrate | none`) to `omni_dual_status` and `omni_dual_completion`. Claude and codex orchestrators then stop inventing recovery paths, which was the main source of P7f fixes.

### O3. First-run trust prompts (UX, seen 2026-11-11)
- **Evidence.**
  - The claude orchestrator in `omni ui` opens on the "Do you trust this folder?" dialog.
  - HANDOFF §12: a codex orchestrator needs the project trusted, plus one sandbox escalation.
- **Change.** `omni squad doctor` (and `omni ui` before autoStart) reports an untrusted project for each runtime, with the exact one-time command or flag. The user still decides. omni never edits the CLI's trust store.

### O4. Recover a lease stranded by host sleep (medium)
- **Evidence.** HANDOFF §12, known limits: sleep during a worker lease leaves `NEEDS_PROCESS_EVIDENCE` forever.
- **Orca.** `stop_unknown` has an explicit operator action (`worker-abandon`), separate from kill.
- **Change.** Add a human-only `omni squad abandon <task>` (TTY, like approve) that records an `abandoned` fence event. It does not claim the process died. The task can then be re-dispatched with a new lease, and the old process stays fenced out.

### O5. Agent status channel for `omni ui` (later)
- **Orca.** Hooks first, with OSC 7501 as the fallback, giving `blocked: permission|question|auth`.
- **Change.** The watchdog and UI read claude/codex JSONL events for "waiting on permission" so they can tell it apart from "stalled". Do this after O1–O4. It needs a check of what the adapters parse today.

## Not adopted
- Nesting depth 4 (squad stays depth 1).
- PTY as the control path (squad stays headless; the PTY is only for the human orchestrator view).
- Wake-instead-of-poll (would replace the Stop-hook model; too large).
- Orca's 46-migration SQLite schema (squad keeps the ledger).

## Order of work
O1 → O2 → O3 → O4, each as its own sub-phase:
- spec note here;
- `node:test` regressions that fail before the fix;
- normal + loaded `npm test` green;
- one Conventional Commit per item.

O5 waits for a decision after O4.
