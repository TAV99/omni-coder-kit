## STRICT WORKFLOW COMMANDS (GEMINI CLI ENHANCED)
This project uses a linear progression SDLC workflow. You are only allowed to change states upon receiving the corresponding command.

> Gemini CLI users: type `>om:*` as normal chat text.

| Command | Agent Strategy | Workflow File | Gemini-Native Tools |
|---------|---------------|---------------|---------------------|
| `>om:brainstorm` | Main session | `.omni/workflows/requirement-analysis.md` | `ask_user`, `save_memory` |
| `>om:equip` | Main session | `.omni/workflows/skill-manager.md` | `google_web_search` |
| `>om:plan` | Main session | `.omni/workflows/task-planning.md` | `tracker_create_task` |
| `>om:cook` | Main session | `.omni/workflows/coder-execution.md` | `tracker_update_task`, `enter_plan_mode` |
| `>om:check` | Main session | `.omni/workflows/qa-testing.md` | `run_shell_command` |
| `>om:fix` | Main session | `.omni/workflows/debugger-workflow.md` | `systematic-debugging` skill |
| `>om:doc` | Main session | `.omni/workflows/documentation-writer.md` | `read_file` |

### Gemini Agent Strategy
Gemini CLI operates in a single, high-context session. It does not use independent sub-agents like Claude Code. 
- **Plan Mode:** Before large implementation tasks, use `enter_plan_mode` to research and validate.
- **Task Tracking:** Use `tracker_create_task` and `tracker_update_task` for rich progress visualization in the terminal.
- **Persistence:** Use `save_memory` (project scope) for architectural decisions that should survive across restarts.

### Command Descriptions
- **[>om:brainstorm]:** Solutions Architect. Uses `ask_user` for adaptive interviewing. Outputs `.omni/design-spec.md`.
- **[>om:equip]:** Skill Manager. Search and proposes expert skills from skills.sh. **Note:** Gemini `--yolo` sandbox blocks `npx` network calls. If install fails, output commands for user to run in terminal.
- **[>om:plan]:** PM Agent. Transforms `.omni/design-spec.md` into `.omni/todo.md` AND initializes Gemini `tracker_create_task` for each item.
- **[>om:cook]:** Coder Agent. Executes tasks from `.omni/todo.md`. Updates task status via `tracker_update_task`.
- **[>om:check]:** QA Tester Agent. Runs validation pipeline.
- **[>om:fix]:** Debugger Agent. Systematic debugging and surgical fixes.
- **[>om:doc]:** Technical Writer Agent. Generates documentation in Vietnamese.

## AUTOMATED QUALITY PIPELINE
Standard 3 quality cycles (cook → check → fix). Gemini's high context window allows for more comprehensive analysis during these cycles.
