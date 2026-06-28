# Workflow Commands

> Gemini CLI: type `>om:*` as normal chat text.

When the user types a `>om:` command, read the corresponding workflow file and follow its instructions.

| Command | Workflow File | Gemini Tools |
|---------|--------------|--------------|
| `>om:onboard` | `.omni/workflows/onboard-workflow.md` | `ask_user`, `save_memory` |
| `>om:brainstorm` | `.omni/workflows/requirement-analysis.md` | `ask_user`, `save_memory` |
| `>om:equip` | `.omni/workflows/skill-manager.md` | `google_web_search` |
| `>om:plan` | `.omni/workflows/task-planning.md` | `tracker_create_task` |
| `>om:cook` | `.omni/workflows/coder-execution.md` | `tracker_update_task`, `enter_plan_mode` |
| `>om:check` | `.omni/workflows/qa-testing.md` | `run_shell_command` |
| `>om:fix` | `.omni/workflows/debugger-workflow.md` | `systematic-debugging` |
| `>om:doc` | `.omni/workflows/documentation-writer.md` | `read_file` |
| `>om:ship` | `.omni/workflows/shipping.md` | `run_shell_command` (only after >om:check passes) |
| `>om:learn` | `.omni/workflows/knowledge-learn.md` | `save_memory` |

Supporting files:
- `.omni/workflows/pm-templates.md` — Output format standards
- `.omni/workflows/validation-scripts.md` — P0-P4 validation pipeline
- `.omni/workflows/superpower-sdlc.md` — Gemini-aware SDLC overview
- `.omni/knowledge/knowledge-base.md` — Project lessons learned

**Khuyến nghị:** Với task lớn, nên chạy `>om:brainstorm` và `>om:plan` trước. Brainstorm/plan KHÔNG bắt buộc — được phép code trực tiếp. Giữ guard: KHÔNG `>om:ship` trước khi `>om:check` pass.
**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.
