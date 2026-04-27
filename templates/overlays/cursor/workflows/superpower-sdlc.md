## STRICT WORKFLOW COMMANDS (CURSOR ENHANCED)
This project uses a linear progression SDLC workflow. You are only allowed to change states upon receiving the corresponding command.

> Cursor: type `>om:*` in chat. Use @Files to read workflow files.

| Command | Workflow File | Context Hints |
|---------|--------------|---------------|
| `>om:brainstorm` | `.omni/workflows/requirement-analysis.md` | @Codebase for project scan |
| `>om:equip` | `.omni/workflows/skill-manager.md` | @Web for skill discovery |
| `>om:plan` | `.omni/workflows/task-planning.md` | @Git for recent changes |
| `>om:cook` | `.omni/workflows/coder-execution.md` | @Files for scope, Agent mode |
| `>om:check` | `.omni/workflows/qa-testing.md` | @Git for diff review |
| `>om:fix` | `.omni/workflows/debugger-workflow.md` | @Web for error research |
| `>om:doc` | `.omni/workflows/documentation-writer.md` | @Codebase for API surface |
| `>om:learn` | `.omni/workflows/knowledge-learn.md` | @Git for fix history |

### Cursor Native Tools Integration

| Cursor Feature | When to Use | Omni Integration |
|---|---|---|
| @Codebase | Before >om:brainstorm, >om:plan | DNA detection context |
| @Files | Before >om:cook each task | Scope verification |
| @Git | During >om:check | Diff review |
| @Docs | During >om:cook with libraries | API verification |
| @Web | During >om:fix for unknown errors | Error research |
| Agent mode | >om:cook execution | Auto lint/test cycle |
| YOLO mode | >om:cook + >om:check | Fast iteration |

### Command Descriptions
- **[>om:brainstorm]:** Solutions Architect. Uses @Codebase for project scan, then adaptive interview. Outputs `.omni/sdlc/design-spec.md`.
- **[>om:equip]:** Skill Manager. Reads tech stack from `.omni/sdlc/design-spec.md`, proposes expert skills from skills.sh.
- **[>om:plan]:** PM Agent. Breaks `.omni/sdlc/design-spec.md` into micro-tasks in `.omni/sdlc/todo.md`.
- **[>om:cook]:** Coder Agent. Executes tasks with YOLO-aware guardrails and Agent mode cook-check-fix loop.
- **[>om:check]:** QA Tester. Verifies completed tasks work (build, tests, features). Outputs `.omni/sdlc/test-report.md`.
- **[>om:fix]:** Debugger. Reproduces → Root cause → Surgical fix → Verify. Use @Web for error research.
- **[>om:doc]:** Technical Writer. Generates README.md and API docs. Documents only what was built.
- **[>om:learn]:** Knowledge Capture. Auto-records lessons after successful fixes into `.omni/knowledge/knowledge-base.md`.

*Critical Note: Any attempt to bypass >om:brainstorm or >om:plan to write code immediately MUST be rejected.*

## AUTOMATED QUALITY PIPELINE
When >om:cook is running, the system enforces **3 quality cycles**:
```
>om:cook (1/3 tasks) → >om:check → [>om:fix ↔ >om:check loop] → >om:cook (1/3) → ... → >om:doc
```
- Checkpoint = ceil(total_tasks / 3). Quality gate triggers automatically.
- Fix/check loop runs up to 3 attempts per cycle. If unresolved, escalate to user.
- In Agent mode: lint and test commands run automatically during quality gates.
