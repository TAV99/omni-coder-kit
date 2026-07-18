---
trigger: always_on
description: "Omni-Coder Kit workflow command registry. Maps >om-* commands to workflow files."
---

# Workflow Commands

When the user types a `>om-` command, read the corresponding workflow file from `.omni/workflows/`, then follow its instructions.

| Command | Workflow File | Description |
|---------|--------------|-------------|
| `>om-go` | `.omni/workflows/go.md` | One-shot pipeline (requirements-aware) |
| `>om-spec` | `.omni/workflows/intake.md` | Spec/Q&A → `.omni/sdlc/requirements.md` |
| `>om-pass` | `.omni/workflows/acceptance.md` | Acceptance hybrid (test/agent+debate) → conformance.md |
| `>om-scan` | `.omni/workflows/onboard-workflow.md` | Legacy project scan + AI interview |
| `>om-think` | `.omni/workflows/requirement-analysis.md` | Requirement analysis |
| `>om-skill` | `.omni/workflows/skill-manager.md` | Skill discovery & install |
| `>om-plan` | `.omni/workflows/task-planning.md` | Task planning from spec |
| `>om-cook` | `.omni/workflows/coder-execution.md` | Code execution |
| `>om-check` | `.omni/workflows/qa-testing.md` | QA & testing |
| `>om-fix` | `.omni/workflows/debugger-workflow.md` | Debugging |
| `>om-doc` | `.omni/workflows/documentation-writer.md` | Documentation |
| `>om-ship` | `.omni/workflows/shipping.md` | Release: version, rollout + rollback (after check) |
| `>om-memo` | `.omni/workflows/knowledge-learn.md` | Knowledge capture |

Supporting files (referenced by workflows):
- `.omni/workflows/pm-templates.md` — Output format standards
- `.omni/workflows/validation-scripts.md` — P0-P4 validation pipeline
- `.omni/workflows/superpower-sdlc.md` — Windsurf-aware SDLC overview
- `.omni/knowledge-base.md` — Project lessons learned

**Khuyến nghị:** Với task lớn, nên chạy `>om-think` và `>om-plan` trước. Brainstorm/plan KHÔNG bắt buộc — được phép code trực tiếp. Giữ guard: KHÔNG `>om-ship` trước khi `>om-check` pass.
**Quality Pipeline:** `>om-cook` enforces 3 quality cycles (cook -> check -> fix). See coder-execution.md.
**Fallback:** If `.omni/workflows/` not found, read from `node_modules/omni-coder-kit/templates/workflows/`.
