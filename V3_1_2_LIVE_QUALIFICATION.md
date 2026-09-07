# Codex–AGY live qualification — 2026-09-06

## Result

**PASS for the approved two-task live scenario.** Session reached `VERIFIED` with an empty blocker list. This is bounded live evidence, not a promise that every model, project or crash scenario is qualified.

- User authorization: two temporary tasks, at most nine AGY phase calls, model usage allowed; no commit/push/deploy or customer-source mutation.
- Actual executable/version: AGY 1.1.27, model `gemini-3.8-flash-high` (verified through actual `agy --version` and `agy models`).
- Calls consumed: **6 of 9**, all exit0, no timeout, no retry or correction required. No additional calls were used after success.
- Started: 2026-09-06T11:51:35Z. Ended: 2026-09-06T12:08:04Z (about16m29s).
- Temporary workspace: `C:/Users/TAV/AppData/Local/Temp/omni-v312-live-DSt5De`.
- Session: `6657e620-1b11-4cd8-a521-05016a9bc22b`.
- Final receipt SHA256: `cc86cfe0ecafa50086c494ad00670091112d2172203ebbbfcecc7036a0594eff`.
- Durable runner report: `.omni/runs/live-v312-qualification-report.json`; bounded driver: `.omni/runs/live-v312-qualification.cjs`. These runtime files are ignored by Git; retain them with the temporary workspace for detailed evidence.

## What ran

| Call | Task | Phase | Result |
|---|---|---|---|
| 1 | LIVE-LABEL | scout | exit0; asked “Confirm the display label?” |
| 2 | LIVE-LABEL | implement | exit0; implemented label.js after controller reply |
| 3 | LIVE-LABEL | review | exit0; independent controller QC subsequently passed |
| 4 | LIVE-GREETING | scout | exit0; started only after LIVE-LABEL was integrated |
| 5 | LIVE-GREETING | implement | exit0; composed greeting from existing label module |
| 6 | LIVE-GREETING | review | exit0; independent controller QC subsequently passed |

Codex supplied the predetermined answer “Student” through the durable question/reply mechanism. Scout was not repeated. Each worker operated in its own private snapshot; source integration was performed by the controller under authority, not directly by Gemini.

Actual resulting implementations:

- `label.js`: `formatName(name)` returns `Student: ${String(name).trim()}`.
- `greeting.js`: requires `./label` and appends one exclamation mark; does not duplicate the label implementation.

The controller ran the registered validators, integrated both results, ran both validators in each of three final quality cycles, and obtained the session receipt. After completion the main agent reread both modules and independently reran `node check-label.cjs` and `node check-greeting.cjs`: both printed PASS.

## Restart and integrity checks

- Reopened the actual authority store and verified its hash chain.
- Restarted the temporary daemon without invoking AGY, queried status/completion, and obtained the same VERIFIED receipt.
- All five recorded task/QC leases were released.
- Phase counter remained6 after restart verification.
- Driver recorded identical original-repository tracked binary diff hashes before/after (`sourceUnchanged: true`). Independent comparison of245 packed `bin/lib/templates` files found no implementation drift; the installed npm bin differed only by shebang CRLF normalization. No changes to the original code were made during the live run.

## Evidence boundaries / remaining audit items

- Both tasks succeeded first attempt. Correction and failure recovery were exercised in deterministic tests, **not in this live run**.
- Completed-session daemon restart was exercised; a crash during a running real AGY subprocess was not. Detached descendant termination remains an explicitly fail-closed recovery boundary.
- This fixture is dependency-free CommonJS. Private npm-ci was independently tested with actual npm and a local dependency, but native lifecycle scripts, other package managers and complex frameworks are not qualified by this fixture.
- Source-change conflict/overlap detection has deterministic coverage; this live scenario used a write/read dependency, not competing writes to the same file.
- Repository full test checkpoint before the live run: 1700 pass, 0 fail, 2 skipped. Current package metadata remains3.1.1 on branch `codex/v3.1.2`; no version release, commit, push, tag or publish was authorized or performed.

## Objective audit

| User requirement | Current evidence |
|---|---|
| Separate v3.1.2 branch | `codex/v3.1.2` based on a46dff2, modifications retained uncommitted |
| Review/optimize v3.1.1 workflow | V3_1_2_WORKFLOW_AUDIT.md plus source/regression tests |
| Codex coordinates Gemini in one user-facing session | This live driver was launched/managed from the current Codex task; authority adapter invoked all six actual Gemini phases |
| Agents exchange sufficient task information | Registered contracts, immutable handoffs, live question/reply, dependency-aware snapshot |
| Avoid accidental overlapping writes | Private snapshots/controller integration; deterministic scope/conflict tests; no source drift in live scenario |
| Recover without deleting evidence | Durable process/message/correction histories and journal tests; completed live session reopens with unchanged receipt |
| No avoidable BLOCKED/failure due coordination | Zero blockers/retries in this bounded live scenario; no universal zero-failure claim beyond tested scope |

The permission blocker for this live scenario is resolved. Do not request the same authorization again or repeat these calls automatically. Further live scenarios or additional phase calls beyond the original cap require a new scoped decision.

### Post-live verifier update (2026-09-07)

The overlap-replay defect found in deterministic testing was fixed after this live run. Current QC follows later verified integrations instead of falsely rejecting an earlier task when a later task legitimately changes the same file. Both preserved live tasks were rechecked with the updated verifier successfully, without changing the ledger or calling Gemini. The six-phase live result above describes its original code snapshot; the new overlap behavior has deterministic/review evidence, not a repeated live run.
