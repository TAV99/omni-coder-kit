# Dual Auto Router Design

## Goal

In `dual + auto`, reduce Codex context and implementation spend by assigning bounded, low-risk work to Gemini 3.7 Flash High while Codex retains specification, architectural decisions, and final verification.

## Routing Contract

Codex writes one `spec.json` per planned task. The router writes `route.json` with one of two deterministic owners:

- `gemini`: task has at most three in-scope files, no architecture/security/migration/cross-module risk flag, and includes validation commands.
- `codex`: every other task, including incomplete or ambiguous specs. This is fail-closed.

Gemini receives only the task spec, prior scout context, and allowed file list. It uses `gemini-3.7-flash-high`, `--effort high`, and `accept-edits` for implementation. Its review runs in `plan` mode and is read-only by instruction. The worker requires a successful JSON envelope; Codex treats its artifacts as evidence, not approval. Neither worker command uses a global permission bypass.

## Artifact Flow

```text
Codex: spec.json → route.json → Gemini evidence.json → Gemini review.json → Codex final QC
```

The existing `preflight` gate must be exactly `safe`. Malformed JSON, missing required artifacts, unsupported route, or worker failure stops the flow rather than transferring responsibility silently.

## Native Skill Behavior

Only `Dual + Auto + codex-agy` augments `$om-think`: after the approved design, Codex continues to plan, writes bounded task specs, invokes the router for each task, dispatches only Gemini-owned tasks, and performs final QC itself. Manual mode remains explicit and unchanged.

## Non-goals

- No automatic commit, push, deploy, permission bypass, or unlimited retry.
- No Gemini ownership for architecture, security, migrations, cross-module work, or ambiguous scope.
- No claim that a native skill can bypass Codex’s normal tool permissions.
