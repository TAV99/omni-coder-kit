# ADR-0002: Event Log as Source of Truth

## Status
Accepted

## Context
Omni v4 needs a robust way to persist state that can recover from crashes, interruptions, and failed actions without relying on disposable memory or brittle update-in-place databases.

## Decision
We will use `.omni/v4/runs/<runId>/events.ndjson` as the append-only source of truth. Replay is authoritative, cached state is disposable, every event has a monotonic sequence, and conflicting appends fail instead of overwriting.

## Alternatives Considered
- Update-in-place state file: rejected because it cannot safely recover from partial writes or concurrent updates.
- External database: rejected because it adds unnecessary dependencies for local agent runs.

## Consequences
- State is rebuilt deterministically by replaying events.
- Concurrency issues are caught at the storage layer via expected sequence numbers.
- Corrupted logs result in strict failures rather than silent state corruption.
