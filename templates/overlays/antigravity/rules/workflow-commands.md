# Workflow Commands

> Antigravity CLI: type `>om:*` as normal chat text (run with `agy --dangerously-skip-permission`).

When the user types a `>om:` command, read the corresponding workflow file and follow its instructions.

| Command | Workflow File | Agent Role | Context Hints & Antigravity Tools |
|---------|--------------|------------|-----------------------------------|
| `>om:onboard` | `.omni/workflows/onboard-workflow.md` | Architect | Read `.omni/onboard-report.json` |
| `>om:brainstorm` | `.omni/workflows/requirement-analysis.md` | Architect | Ask adaptive questions |
| `>om:equip` | `.omni/workflows/skill-manager.md` | Skill Manager | Call external search if needed |
| `>om:plan` | `.omni/workflows/task-planning.md` | PM | Generate `.omni/sdlc/todo.md` |
| `>om:cook` | `.omni/workflows/coder-execution.md` | Coder | 3 quality cycles (cook -> check -> fix) |
| `>om:check` | `.omni/workflows/qa-testing.md` | QA Tester | Run validation script pipeline |
| `>om:fix` | `.omni/workflows/debugger-workflow.md` | Debugger | Reproduce -> root cause -> surgical fix |
| `>om:doc` | `.omni/workflows/documentation-writer.md` | Writer | Read implementation to generate docs |
| `>om:ship` | `.omni/workflows/shipping.md` | Release Engineer | Only after >om:check passes; stage, never auto-deploy |
| `>om:learn` | `.omni/workflows/knowledge-learn.md` | Learner | Write Knowledge Item (KI) or file |

Supporting files:
- `.omni/workflows/pm-templates.md` — Output format standards
- `.omni/workflows/validation-scripts.md` — P0-P4 validation pipeline
- `.omni/workflows/superpower-sdlc.md` — SDLC overview and workflows
- `.omni/knowledge/knowledge-base.md` — Project lessons learned

**CRITICAL:** Do NOT write code without running `>om:brainstorm` and `>om:plan` first.
**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.
