# Acceptance RPC response audit

Date: 2026-11-03 (Asia/Ho_Chi_Minh). Scope: the P7 scripted acceptance harness, bookshelf v1, ten tasks per fresh run. Source: approval projection `058b42a`, followed by user-approved resume ACK fix `c5e7b82`.

## Observed defects and contract

A-02 could not read approvals through full `session.status`. Fix `058b42a` added `projection: "approvals"`; A-03 successfully used it to approve and integrate T06 despite full status exceeding 64 KiB. The next `session.resume` response exceeded the same cap after dispatching T07. A lost response does not establish that no operation occurred. A-03 is retained, with six integrations and complete evidence.

The user approved `session.resume` with optional `projection: "ack"`. Its successful dispatch response contains exactly `session_id`, `state`, `session_state`, `plan_revision`, `resumed`, and `worker_running`. This is an acknowledgement, not task completion evidence. The dispatch call and existing `resumed` calculation are shared with the default path. Authorization, session/task/revision checks and early error/coverage diagnostics remain unchanged. Default responses and the 64 KiB client cap are preserved. Neither client nor harness retries a potentially dispatched operation after a lost reply.

## Call-site audit

| RPC | Acceptance caller | Successful response scope / check |
|---|---|---|
| `health` | daemon readiness; approval CLI | Fixed health/identity/integrity fields, no task history. Real-daemon large-plan test confirms health still works. |
| `session.begin` | initial setup | Session identity, state and baseline. No accumulated task history; called before registration. |
| `plan.register` | once after setup | Returns all `derived.tasks`, including its idempotent path. P7 uses a fresh session and exactly ten tasks, before execution. The successful response shape reconstructed from A-03's pre-execution ledger prefix is 10,601 bytes including the result wrapper. This is a serialization calculation, not a network capture. |
| `session.resume` | initial plan; post-integration frontier; context continuation | All three paths now request ACK. A real daemon with 100 registered tasks dispatches once and returns a response below 1 KiB; the default full response still hits the unchanged cap. Route regressions cover all three callers. |
| `session.status` | human approval CLI | Uses the complete approvals projection, including decided gates for uncertain-write inspection. A-03 T06 returned 2,617 bytes while default status hit the cap. |
| `gate.decide` | human TTY only | One gate result per request. Existing large-history approval regression and partial/uncertain outcome checks remain in place. The harness never calls it. |
| `task.qc` | ready-frontier driver | One task's status, gate/receipt and validation details; no complete session task map. All A-03 T01–T06 QC requests returned successfully. |
| `task.reply` | sourced context handler | Acknowledgement, reused flag and message ID; no history. Shared helper preserves task/question/revision lineage before ACK resume. |
| `inbox.post` | user-authorized clarification forwarding | Message ID, recipient, sequence and duplicate flag; no message history. |
| `daemon.stop` | owned-child cleanup | Fixed success/message acknowledgement. |

## Validation and limits

- The focused suite first reported 73 passed / 5 failed; after the fix it passes 78/78. Independent review also ran 78/78, with no blocking finding.
- The real-daemon regression verifies one dispatch, compact shape, unchanged default cap and session/task/revision rejection. A driver regression verifies lost-resume errors propagate without replay.
- This audit addresses whole-session history growth in the current P7 path. Task-local validation/reviewer/coverage/error details can still exceed the cap if individually oversized; the client continues to reject them. There is no unlimited-response or automatic-retry fallback.
- Default status/resume and the separate P3 initial resume retain their existing full responses. This fix does not claim those callers support arbitrary history sizes.
- Fresh normal and loaded checks each passed 3287 tests, 3275 passed, 12 skipped, 0 failed (530.1 / 200.2 seconds). Logs: `/tmp/omni-p7d-resume-normal.log` and `/tmp/omni-p7d-resume-loaded.log`. The user approved local fix commit `c5e7b82`; A-04 started fresh afterwards. No retained benchmark workspace is reused or combined into a full pass.

Private observer records: `A-03-T06-approval-projection-observer.json` and `A-03-plan-response-audit.json` under `/private/tmp/omni-p7d-oK0Yu0/`. Raw evidence stays private; reports remain sanitized.
