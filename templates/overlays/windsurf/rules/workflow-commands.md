---
trigger: always_on
description: "Omni-Coder Kit workflow command registry. Maps >om:* commands to workflow files."
---

# Workflow Commands

When the user types a `>om:` command, read the corresponding workflow file from `.omni/workflows/`, then follow its instructions.

| Command | Workflow File | Description |
|---------|--------------|-------------|
| `>om:onboard` | `.omni/workflows/onboard-workflow.md` | Legacy project scan + AI interview |
| `>om:brainstorm` | `.omni/workflows/requirement-analysis.md` | Requirement analysis |
| `>om:equip` | `.omni/workflows/skill-manager.md` | Skill discovery & install |
| `>om:plan` | `.omni/workflows/task-planning.md` | Task planning from spec |
| `>om:cook` | `.omni/workflows/coder-execution.md` | Code execution |
| `>om:check` | `.omni/workflows/qa-testing.md` | QA & testing |
| `>om:fix` | `.omni/workflows/debugger-workflow.md` | Debugging |
| `>om:doc` | `.omni/workflows/documentation-writer.md` | Documentation |
| `>om:learn` | `.omni/workflows/knowledge-learn.md` | Knowledge capture |

Supporting files (referenced by workflows):
- `.omni/workflows/pm-templates.md` — Output format standards
- `.omni/workflows/validation-scripts.md` — P0-P4 validation pipeline
- `.omni/workflows/superpower-sdlc.md` — Windsurf-aware SDLC overview
- `.omni/knowledge-base.md` — Project lessons learned

**CRITICAL:** Do NOT write code without running `>om:brainstorm` and `>om:plan` first.
**Quality Pipeline:** `>om:cook` enforces 3 quality cycles (cook -> check -> fix). See coder-execution.md.
**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.
