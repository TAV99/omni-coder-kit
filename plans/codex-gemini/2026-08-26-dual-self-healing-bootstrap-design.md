# Dual Self-Healing Bootstrap Design

> Approved: 2026-08-26 | Scope: Codex Dual hooks and daemon bootstrap only

## Problem

Codex Dual currently gives every command hook a five-second timeout and allows only `SessionStart` to bootstrap the authority daemon. If that one hook times out, later `UserPromptSubmit` hooks do not retry and `PreToolUse` blocks the workflow because the daemon is unavailable. A second deadlock remains after a successful daemon start: before `omni_dual_begin` creates an authority session, `PreToolUse` denies mutating tools, including the write needed to create `.omni/sdlc/design-spec.md`.

## Evidence

- The failing DemoSite discovery referenced dead PID `25684`.
- A later diagnostic bootstrap created healthy daemon PID `18532`.
- Warm direct-Node `SessionStart` completed in 97 ms and a clean direct-Node cold start completed in 284 ms.
- A bounded invocation through the real outer PowerShell reproduced the reported five-second timeout. PowerShell kept waiting on the daemon process tree even though Node used `detached: true` and `unref()`.
- The failure therefore combined an unrecoverable one-shot startup path with a Windows process-detachment bug; increasing the timeout alone would only delay the failure.
- Official Codex hook documentation defines `timeout` in seconds and uses 600 seconds by default for most hooks. Omni's five-second bootstrap timeout is an unnecessary fragility.

## Approved Architecture: Self-Healing Bootstrap

### Bootstrap events

Both `SessionStart` and `UserPromptSubmit` may idempotently ensure that the daemon is healthy. The existing daemon lock remains the single-instance boundary, so concurrent or repeated starts cannot create two authorities.

### Pre-authority phase

Before a durable Dual session exists, hooks are advisory and must not block tools. This allows `$om-think` to inspect the workspace and write SDLC planning artifacts before calling `omni_dual_begin`. Omni must not claim that hard authority is active during this phase.

### Active-authority phase

After an authority ledger/session exists, existing strict behavior remains unchanged. If the daemon becomes unavailable during an initialized transaction, writes remain fail-closed so lease, scope, and QC integrity cannot be bypassed accidentally.

### Timeouts

- `SessionStart`: 15 seconds.
- `UserPromptSubmit`: 15 seconds.
- `PreToolUse`, `PostToolUse`, and `Stop`: retain 5 seconds because they do not perform cold bootstrap.
- The bridge polls readiness for at most 10 seconds; the 15-second outer timeout leaves margin for hook startup, serialization, and Windows scheduling.

## State Outcomes

| Daemon | Durable session | Event | Outcome |
|---|---:|---|---|
| unavailable | no | `SessionStart` / `UserPromptSubmit` | Retry idempotent bootstrap; return advisory context if still unavailable |
| unavailable | no | `PreToolUse` / `Stop` | Do not block pre-authority workflow |
| healthy | no | any tool hook | Do not enforce task authority yet |
| unavailable | yes | mutating `PreToolUse` / `Stop` | Fail closed |
| healthy | yes | tool hooks | Existing task, lease, scope, and QC rules |

## Cross-Platform Contract

Generated hook commands retain absolute Node and hook paths, and the bridge keeps one platform boundary:

- Windows daemon bootstrap starts a hidden inner PowerShell launcher which uses `Start-Process` to detach Node from Codex's outer PowerShell process tree.
- Linux and macOS retain the direct argument-array Node spawn with `shell: false`, `detached: true`, and `unref()`.
- Argument quoting remains explicit; the real Windows smoke test uses a workspace path containing spaces and the installed Node path may also contain spaces.

Tests cover generated hook configuration, bridge state transitions, the preserved POSIX spawn contract, and a bounded real PowerShell cold bootstrap.

## Non-Goals

- No daemon protocol or ledger schema changes.
- No automatic plan registration.
- No relaxation after `omni_dual_begin`.
- No commit, push, deployment, or Recycle Bin recovery.

## Acceptance Gates

1. A failed `SessionStart` can recover on `UserPromptSubmit`.
2. `$om-think` can read and write its spec before authority initialization.
3. Daemon loss during an initialized transaction still blocks mutation.
4. Generated bootstrap hook timeouts are 15 seconds.
5. Focused hook, init, Dual, and full repository tests pass.
