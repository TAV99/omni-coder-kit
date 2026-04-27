# Omni-Coder Kit for Codex CLI

This project uses Omni-Coder Kit with Codex CLI.

## Stable Omni Workflow Commands

Type these commands as normal chat text:

| Command | Workflow File | Purpose |
|---------|---------------|---------|
| `>om:brainstorm` | `.omni/workflows/requirement-analysis.md` | Requirements interview and design spec |
| `>om:equip` | `.omni/workflows/skill-manager.md` | Skill discovery |
| `>om:plan` | `.omni/workflows/task-planning.md` | Convert spec to `.omni/sdlc/todo.md` |
| `>om:cook` | `.omni/workflows/coder-execution.md` | Implement tasks |
| `>om:check` | `.omni/workflows/qa-testing.md` | Validate work |
| `>om:fix` | `.omni/workflows/debugger-workflow.md` | Diagnose and fix failures |
| `>om:doc` | `.omni/workflows/documentation-writer.md` | Write docs from code |

Codex currently provides built-in slash commands, not project-defined custom `/om:*` slash command files. Use `>om:*` so the model receives the Omni command as text.

## Codex Native Commands

Use Codex native commands when they fit the task:

| Command | Use |
|---------|-----|
| `/plan` | Ask Codex to plan before editing |
| `/review` | Review current changes |
| `/permissions` | Inspect or adjust approval behavior |
| `/agent` | Work with subagents when explicitly needed |
| `/status` | Inspect current session status |
| `/mcp` | Inspect MCP server connections |
| `/plugins` | Inspect plugin capabilities |

## Execution Model

- `AGENTS.md` stays compact and points here for details.
- `.omni/workflows/` contains long-form workflow instructions.
- `.codex/config.toml` and `.codex/hooks.json` are optional advanced setup files.
- Hooks are reminders and guardrails. They do not replace `>om:check` or verification.
