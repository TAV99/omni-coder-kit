## WORKFLOW COMMANDS
This project uses an SDLC workflow driven by `>om:` commands. Brainstorm/plan are OPTIONAL (see RUN MODE in the config file); for larger tasks they're recommended. In **auto** mode, `>om:brainstorm` finishing chains into equip→plan→cook automatically; in **manual** mode the user drives each step.

- **[>om:brainstorm]:** Activates the Solutions Architect Agent. Extracts info from user prompt, classifies complexity (small/medium/large), asks only what's missing (adaptive interview), auto-decomposes large projects, then outputs `.omni/sdlc/design-spec.md` in hybrid format (summary table + tagged requirement list). → See ADAPTIVE ARCHITECT WORKFLOW section.
- **[>om:equip]:** Activates the Skill Manager Agent. Reads the tech stack from `.omni/sdlc/design-spec.md` and proposes `npx skills add` commands to fetch necessary expert skills from skills.sh. → See AGENT SKILLS MANAGER section.
- **[>om:plan]:** Activates the PM Agent. Reads `.omni/sdlc/design-spec.md` and breaks it into detailed micro-tasks in `.omni/sdlc/todo.md`. Each task must be atomic (<20 min) and use `- [ ]` checkbox format. → See PM AGENT WORKFLOW section.
- **[>om:cook]:** Activates the Coder Agent. Picks the NEXT uncompleted task from `.omni/sdlc/todo.md`, implements it using Surgical Changes, marks it `- [x]`, then asks to continue. ONE task at a time. → See CODER AGENT WORKFLOW section.
- **[>om:check]:** Activates the QA Tester Agent. Verifies every completed task in `.omni/sdlc/todo.md` actually works (build, tests, feature verification). Outputs `.omni/sdlc/test-report.md`. → See QA TESTING WORKFLOW section.
- **[>om:fix]:** Activates the Debugger Agent. Reads `.omni/sdlc/test-report.md` or user-reported errors. Reproduces → Root cause analysis → Surgical fix → Verify. Never shotgun-fix. → See DEBUGGER AGENT WORKFLOW section.
- **[>om:doc]:** Activates the Technical Writer Agent. Reads actual code + design-spec + test-report and generates README.md and API docs in Vietnamese. Documents only what was actually built. → See TECHNICAL WRITER WORKFLOW section.
- **[>om:ship]:** Activates the Release Engineer Agent. Runs ONLY after `>om:check` passes. Verifies release readiness, bumps version + changelog, sets up/confirms the CI quality gate, writes a staged-rollout + rollback plan to `.omni/sdlc/ship-report.md`, and handles deprecations. Stages everything; never pushes/deploys without explicit user approval. → See SHIP AGENT WORKFLOW section.
*Note: Brainstorm/plan KHÔNG bắt buộc — người dùng được phép code trực tiếp. Khuyến nghị brainstorm cho task lớn để xây đúng thứ cần. Giữ guard: bất kỳ ý định chạy >om:ship trước khi >om:check pass đều PHẢI bị từ chối.*

## AUTOMATED QUALITY PIPELINE
When >om:cook is running, the system enforces **3 quality cycles** based on total task count:
```
>om:cook (1/3 tasks) → >om:check → [>om:fix ↔ >om:check loop] → >om:cook (1/3 tasks) → >om:check → [>om:fix ↔ >om:check loop] → >om:cook (1/3 tasks) → >om:check → [>om:fix ↔ >om:check loop] → >om:doc → >om:ship
```
- Checkpoint = ceil(total_tasks / 3). Quality gate triggers automatically at each checkpoint.
- Fix/check loop runs up to 3 attempts per cycle. If unresolved, escalate to user.
- After all 3 cycles pass, project is ready for >om:doc, then >om:ship (deploy with rollback plan).