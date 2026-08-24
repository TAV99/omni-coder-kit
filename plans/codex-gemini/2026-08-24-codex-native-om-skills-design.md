# Codex Native Omni Skills Design

## Goal

Make Omni workflow entry points deterministic in Codex CLI through native project skills, while keeping `.omni/workflows/` as the only workflow-content source.

## Decision

- Emit a native `SKILL.md` for each supported Omni workflow whenever `ide` is `codex` or `dual`.
- Initial native entry points: `om-go`, `om-think`, `om-spec`, `om-skill`, `om-plan`, `om-cook`, `om-check`, `om-fix`, `om-pass`, `om-doc`, `om-memo`, `om-map`, and `om-ship`.
- Each generated skill is a thin launcher: it identifies the exact `.omni/workflows/<workflow>.md` file, requires the agent to read it fully, and preserves the workflow's stated gate/stop conditions.
- `AGENTS.md` becomes a short dispatcher: prefer `$om-*` for native invocation, retain `>om-*` only as a compatibility prompt alias, and never promise `/om-*` slash commands.
- No changes to the run engine, external skill installer, Antigravity adapter, or workflow content in this migration.

## Generated Layout

```text
.codex/skills/
  om-think/SKILL.md
  om-plan/SKILL.md
  om-cook/SKILL.md
  ...
.omni/workflows/
  requirement-analysis.md
  task-planning.md
  coder-execution.md
  ...
```

## Safety and Compatibility

- Skills are emitted only for Codex-containing configurations (`codex`, `dual`), so other IDE outputs remain unchanged.
- A missing source workflow causes the generator to omit that native skill rather than emitting a broken path.
- The generated skill does not duplicate workflow text, execute shell commands, grant permissions, or authorize commits/deployments.
- Existing `>om-*` text aliases remain documented for users migrating gradually.

## Acceptance Criteria

1. `buildInitConfig('codex', ...)` and `buildInitConfig('dual', ...)` emit all 13 native skills under `.codex/skills`.
2. `buildInitConfig` for non-Codex IDEs emits none of those files.
3. Every emitted skill references an existing, exact workflow file and tells Codex to read it before acting.
4. Codex `AGENTS.md` advertises `$om-*` as preferred and keeps `>om-*` as a compatibility alias.
5. Unit tests prove the file set, routing, and no-duplication contract.
