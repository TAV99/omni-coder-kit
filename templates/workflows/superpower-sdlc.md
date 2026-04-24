## STRICT WORKFLOW COMMANDS
This project uses a linear progression SDLC workflow. You are only allowed to change states upon receiving the corresponding command:

- **[>om:brainstorm]:** Activates the Solutions Architect Agent. Extracts info from user prompt, classifies complexity (small/medium/large), asks only what's missing (adaptive interview), auto-decomposes large projects, then outputs `design-spec.md` in hybrid format (summary table + tagged requirement list). → See ADAPTIVE ARCHITECT WORKFLOW section.
- **[>om:equip]:** Activates the Skill Manager Agent. Reads the tech stack from `design-spec.md` and proposes `npx skills add` commands to fetch necessary expert skills from skills.sh. → See AGENT SKILLS MANAGER section.
- **[>om:plan]:** Activates the PM Agent. Reads `design-spec.md` and breaks it into detailed micro-tasks in `todo.md`. Each task must be atomic (<20 min) and use `- [ ]` checkbox format. → See PM AGENT WORKFLOW section.
- **[>om:cook]:** Activates the Coder Agent. Picks the NEXT uncompleted task from `todo.md`, implements it using Surgical Changes, marks it `- [x]`, then asks to continue. ONE task at a time. → See CODER AGENT WORKFLOW section.
- **[>om:check]:** Activates the QA Tester Agent. Verifies every completed task in `todo.md` actually works (build, tests, feature verification). Outputs `test-report.md`. → See QA TESTING WORKFLOW section.
- **[>om:fix]:** Activates the Debugger Agent. Reads `test-report.md` or user-reported errors. Reproduces → Root cause analysis → Surgical fix → Verify. Never shotgun-fix. → See DEBUGGER AGENT WORKFLOW section.
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