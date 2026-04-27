# Codex CLI Usage

Omni-Coder Kit supports Codex CLI through `AGENTS.md`, lazy-loaded `.omni/workflows/`, and optional `.codex/` project configuration.

## Stable Omni Commands

Type these commands as normal chat text in Codex:

| Command | Workflow |
|---------|----------|
| `>om:brainstorm` | Requirements interview and design spec |
| `>om:equip` | Skill discovery and installation guidance |
| `>om:plan` | `.omni/design-spec.md` to `.omni/todo.md` |
| `>om:cook` | Surgical task execution |
| `>om:check` | Validation and feature verification |
| `>om:fix` | Systematic debugging |
| `>om:doc` | Documentation from implemented code |

Codex CLI documents built-in slash commands such as `/plan`, `/review`, `/permissions`, `/agent`, `/mcp`, and `/plugins`. Project-defined custom `/om:*` slash commands are not used by this overlay because Codex does not currently document a stable project-level custom slash command directory like Claude Code's `.claude/commands/`.

## Launch Examples

```bash
codex
codex --profile omni_safe
codex --profile omni_full_auto
codex exec "Read AGENTS.md, then run >om:check against the current repository state."
```

Use `omni_full_auto` only in repositories and sandboxes you trust. The profile removes approval prompts but keeps Codex in the workspace-write sandbox.

## Advanced Setup

When enabled by `omni init`, Codex advanced setup creates:

```text
.codex/config.toml
.codex/hooks.json
```

Project-scoped `.codex/` config and hooks load only after the project is trusted by Codex.
