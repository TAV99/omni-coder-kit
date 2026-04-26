### Gemini CLI Integration
- **Workflow Interaction:** Type `>om:brainstorm`, `>om:plan`, `>om:cook`, etc. as normal chat text.
- **Plan Mode:** Use `enter_plan_mode` for research and `exit_plan_mode` to return to execution.
- **Task Tracking:** Use `tracker_create_task` and `tracker_update_task` tools to manage progress. This is the primary source of truth for task status.
- **Context Efficiency:** Use `save_memory` (project scope) for long-term project facts to keep the main context lean.
- **Interactive Tools:** Use `ask_user` for making decisions and `google_web_search` for documentation search.
- **Workflow Files:** All logic is in `.omni/workflows/`. Read corresponding files when receiving `>om:*` commands.
