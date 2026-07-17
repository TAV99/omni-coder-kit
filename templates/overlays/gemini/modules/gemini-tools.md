# Gemini CLI Integration

## Native Tools
- **Plan Mode:** Use `enter_plan_mode` for research and `exit_plan_mode` to return to execution.
- **Task Tracking:** Use `tracker_create_task` and `tracker_update_task` tools to manage progress.
- **Context Efficiency:** Use `save_memory` (project scope) for long-term project facts to keep the main context lean.
- **Interactive Tools:** Use `ask_user` for decisions and `google_web_search` for documentation.

## Agent Skills Alignment
Gemini Agent Skills and Omni skills serve different roles:
- **Gemini skills** (`.gemini/skills/`): Domain-specific expertise activated on-demand via `activate_skill`. Best for security auditing, deployment automation, migration guides.
- **Omni skills** (`.omni/skills/`): Workflow-level skills referenced by `@skill:name` tags in todo.md. Integrated with the SDLC pipeline (`>om-skill` discovers and installs them).
- Both systems coexist. Gemini skills use progressive disclosure (load when needed). Omni skills are injected into sub-agent prompts during `>om-cook`.

## Model Recommendations
- **Gemini 3.5 Flash** — Default. Extremely fast and highly capable for most coding and debugging tasks.
- **Gemini 3.5 Pro** — Advanced reasoning model. Recommended for complex refactoring, performance optimization, and architectural decisions.
- **Gemini 3.5 Ultra** — Most capable model. Recommended for large-scale migrations, architectural design, and complex multi-agent orchestration.
- Switch models with `/model` command during a session.

## @file Imports
This GEMINI.md uses `@file.md` imports for modular configuration.
- Modules are stored in `.gemini/` directory
- Each module focuses on one concern (mindset, commands, tools)
- Edit individual module files to customize behavior

## Memory Partitioning
- Gemini Auto Memory Inbox is separate from `.omni/` project state
- `.omni/knowledge/` is for workflow-captured lessons (via `>om-memo`)
- Gemini memories are for session context and cross-restart persistence
- Use `save_memory` with project scope for architectural decisions

## Sandbox Awareness
When running in `--yolo` sandbox mode:
- Network calls (`npx`, `curl`, `git push`) may be blocked
- If a command fails due to sandbox, output the command for user to run manually
- File writes within the workspace are always allowed
