# Dual Async Validator Safe Recovery & Diagnostic Runbook

## 1. Purpose & Principles

This runbook documents the safe diagnostic and recovery procedures for dual asynchronous validator runs (quality and acceptance-correction).
The dual validator architecture enforces three invariant safety rules:

1. **Fail-Closed Mutation Fence**: An unresolved or in-flight validator run blocks all conflicting mutations (`409 DUAL_VALIDATOR_ACTIVE`) while keeping read-only diagnostics responsive.
2. **Ledger Byte Preservation**: Authority event logs (`events.ndjson`) and validator lifecycle ledgers (`validators.ndjson`) are append-only cryptographic hash chains. Historical bytes must never be modified or rewritten.
3. **No Automatic Duplicate Spawns**: The system never guesses or automatically re-launches a run that was left un-settled across a crash.

---

## 2. Validator Lifecycle States

| State | Definition | Permitted RPCs |
|---|---|---|
| `IDLE` | No active or unresolved validator runs | All valid session mutations permitted |
| `RUNNING` | An in-process validator is actively executing under an owned Windows Job Object or POSIX process group | `health`, `session.status`, `completion.evaluate`, identical cycle coalescing |
| `UNRESOLVED` | A `started` record exists in `validators.ndjson` without a corresponding `settled` record (e.g. daemon crashed or was killed mid-run) | `health`, `session.status` (safe diagnostics). All mutations rejected with 409 |
| `SETTLED` | The validator completed with an owned proof and recorded a terminal `settled` record | Run fence released once attestation or completion is committed |

---

## 3. Diagnostic Procedures

### 3.1 Non-Destructive Health & Status Inspection

Diagnostics never alter ledger bytes or hash integrity. To inspect the current status:

```bash
# Using daemon client or curl to loopback:
POST http://127.0.0.1:<port>/rpc
{
  "protocol_version": 1,
  "workspace_id": "<ws-id>",
  "method": "session.status",
  "params": { "session_id": "<session-id>" }
}
```

Or programmatically via the authority store:

```js
const { inspectValidatorRun, listValidatorRuns } = require('./lib/dual/validator-lifecycle');
const status = inspectValidatorRun({ authorityStore, runId });
// Returns: { runId, active, settled, outcome, purpose }
```

### 3.2 Verifying Descendant Process Termination

On Windows, validators run inside a dedicated Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. When the helper process terminates, the OS automatically terminates all child and descendant processes.

To verify no orphaned processes remain:
```powershell
Get-Process | Where-Object { $_.Path -like "*<workspace-path>*" }
```

---

## 4. Recovery Procedures

### 4.1 Case A: Unresolved Run Without Terminal Artifact

If a daemon restart leaves an unresolved `started` record in `validators.ndjson` with no verified artifact:
- **Action**: Do NOT attempt to hand-edit `validators.ndjson` or `events.ndjson` (doing so breaks SHA-256 chain integrity).
- **Resolution**: Preserve the authority directory for forensic analysis and start a new session with `client.beginSession({ workspace_root, mode: 'auto' })`.

### 4.2 Case B: Settled Run with Verified Artifact Pending Anchor

If a quality validator completed and its artifact was written to `.omni/runs/dual-authority/quality/<execution-id>.json`, but the daemon halted before committing `quality.execution.attested`:
- **Action**: Re-invoking `quality.execute` with the exact same `cycle_index` will:
  1. Validate that current source diff, plan revision, and acceptance policy match the pending artifact.
  2. Verify the artifact file digest against the durable hash.
  3. Replay and commit the durable attestation without re-executing validator commands.
  4. Clear the run fence once the attestation is read back.

---

## 5. Security & Secret Redaction

Command arguments, environment variables, and diagnostic outputs are sanitized:
- Secret tokens matching high-entropy patterns or known API credentials are automatically redacted with `[REDACTED]`.
- Standard output summaries in ledger records are capped at 4 KiB per stream to prevent denial of service and log bloat.
