# Parent verification — pending findings

Observed 2026-10-21 during Argon implementation. These are executable probes, not completion claims. Recheck after the final code pass before classifying a finding as fixed.

## P1 — Failure evidence must match the current invocation

`createDiscussionAdapter(...).classify({exitCode:1,stdout:'{}',stderr:''}, expectedBinding, 'expected-invocation')` returned `completion: 'failed'` when the supplied classifier reported `observedConversationId: 'OTHER'`, `observedInvocationId: 'OTHER'`, and `evidenceRef: 'unrelated-terminal'`.

The positive-success branch checks correlation, but the terminal-failure branch currently bypasses it. Evidence about another invocation does not prove that the current invocation terminated. Expected: `unknown`, preserving fail-closed recovery, not terminal `failed`. Add regression coverage for mismatched and missing correlation on failures; do not weaken the error-plus-valid-payload case when evidence actually matches.

## P2 — Journal append must snapshot the caller input at call time

Reproduction:

```js
const event = { type: 'received', message_id: 'original' };
const pending = journal.append(event);
event.message_id = 'mutated';
await pending;
```

Observed persisted `message_id: 'mutated'`; expected `original`. The copy happens after the queued operation yields. Copy/validate at the public call boundary before enqueueing; include nested mutation regression. Examine receive and reconciliation boundaries for the same pattern.

## Pending boundary checks

- `maxInvocations` must count dispatches, not envelope sequence: a final response after the last permitted invocation must still be stored. Probe with `maxInvocations: 1` and with all 12 permitted invocations.
- Verify timeout-only fake invocations settle instead of being cancelled when the timeout timer is the only live event-loop handle.
- Verify close-time sync failure retains the lock but still closes the file handle.

No changes to implementation were made by this review.
