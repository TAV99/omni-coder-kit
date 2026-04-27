## STRICT WORKFLOW COMMANDS (CLAUDE CODE ENHANCED)
This project uses a linear progression SDLC workflow. You are only allowed to change states upon receiving the corresponding command.

> Claude Code users: dùng `/om:*` slash commands (auto-complete) hoặc `>om:*` trong chat — cả hai đều hoạt động.

| Command | Slash | Agent Strategy | Workflow File |
|---------|-------|---------------|---------------|
| `>om:brainstorm` | `/om:brainstorm` | Main session | `.omni/workflows/requirement-analysis.md` |
| `>om:equip` | `/om:equip` | Main session | `.omni/workflows/skill-manager.md` |
| `>om:plan` | `/om:plan` | Main session | `.omni/workflows/task-planning.md` |
| `>om:cook` | `/om:cook` | Main → sub-agents (parallel) | `.omni/workflows/coder-execution.md` |
| `>om:check` | `/om:check` | Main session | `.omni/workflows/qa-testing.md` |
| `>om:fix` | `/om:fix` | Main session | `.omni/workflows/debugger-workflow.md` |
| `>om:doc` | `/om:doc` | Main session | `.omni/workflows/documentation-writer.md` |

### Agent Strategy Guide
- **Main session:** Execute directly in current conversation. Suitable for interactive workflows (brainstorm, fix) and workflows needing full project context (doc, check).
- **Main → sub-agents (parallel):** Main session analyzes dependency graph, then dispatches General sub-agents with worktree isolation for independent tasks. Used by `/om:cook` only.

### Command Descriptions
- **[>om:brainstorm]:** Activates the Solutions Architect Agent. Extracts info from user prompt, classifies complexity (small/medium/large), asks only what's missing (adaptive interview), auto-decomposes large projects, then outputs `.omni/sdlc/design-spec.md` in hybrid format (summary table + tagged requirement list). → See ADAPTIVE ARCHITECT WORKFLOW section.
- **[>om:equip]:** Activates the Skill Manager Agent. Reads the tech stack from `.omni/sdlc/design-spec.md` and proposes `npx skills add` commands to fetch necessary expert skills from skills.sh. → See AGENT SKILLS MANAGER section.
- **[>om:plan]:** Activates the PM Agent. Reads `.omni/sdlc/design-spec.md` and breaks it into detailed micro-tasks in `.omni/sdlc/todo.md`. Each task must be atomic (<20 min) and use `- [ ]` checkbox format. → See PM AGENT WORKFLOW section.
- **[>om:cook]:** Activates the Coder Agent. Analyzes dependency graph in `.omni/sdlc/todo.md`, groups independent tasks into batches, spawns parallel sub-agents with worktree isolation. Quality gate triggers at each 1/3 checkpoint. → See CODER AGENT WORKFLOW section.
- **[>om:check]:** Activates the QA Tester Agent. Verifies every completed task in `.omni/sdlc/todo.md` actually works (build, tests, feature verification). Outputs `.omni/sdlc/test-report.md`. → See QA TESTING WORKFLOW section.
- **[>om:fix]:** Activates the Debugger Agent. Reads `.omni/sdlc/test-report.md` or user-reported errors. Reproduces → Root cause analysis → Surgical fix → Verify. Never shotgun-fix. → See DEBUGGER AGENT WORKFLOW section.
- **[>om:doc]:** Activates the Technical Writer Agent. Reads actual code + design-spec + test-report and generates README.md and API docs in Vietnamese. Documents only what was actually built. → See TECHNICAL WRITER WORKFLOW section.

*Critical Note: Any attempt to bypass the planning steps (>om:brainstorm or >om:plan) to write code immediately MUST be rejected.*

## AUTOMATED QUALITY PIPELINE
When >om:cook is running, the system enforces **3 quality cycles** based on total task count:
```
>om:cook (1/3 tasks) → >om:check → [>om:fix ↔ >om:check loop] → >om:cook (1/3 tasks) → >om:check → [>om:fix ↔ >om:check loop] → >om:cook (1/3 tasks) → >om:check → [>om:fix ↔ >om:check loop] → >om:doc
```
- Checkpoint = ceil(total_tasks / 3). Quality gate triggers automatically at each checkpoint.
- Fix/check loop runs up to 3 attempts per cycle. If unresolved, escalate to user.
- After all 3 cycles pass, project is ready for >om:doc.
