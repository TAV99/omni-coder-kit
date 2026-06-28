# Workflow Commands

> Antigravity CLI: type `>om:*` as normal chat text (run with `agy --dangerously-skip-permissions`).

When the user types a `>om:` command, read the corresponding workflow file and follow its instructions.

| Command | Workflow File | Agent Role | Context Hints & Antigravity Tools |
|---------|--------------|------------|-----------------------------------|
| `>om:go` | `.omni/workflows/go.md` | All-in-one | One-shot pipeline; requirements-aware (auto-acceptance) |
| `>om:intake` | `.omni/workflows/intake.md` | Acceptance | Spec/Q&A → `.omni/sdlc/requirements.md` (checklist nguyên tử) |
| `>om:accept` | `.omni/workflows/acceptance.md` | Acceptance | Chấm lai từng requirement; loop tới 100% met → `conformance.md` |
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

**Khuyến nghị:** Với task lớn, nên chạy `>om:brainstorm` và `>om:plan` trước. Brainstorm/plan KHÔNG bắt buộc — được phép code trực tiếp. Giữ guard: KHÔNG `>om:ship` trước khi `>om:check` pass.
**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.
