## STRICT WORKFLOW COMMANDS
This project uses a linear progression SDLC workflow. You are only allowed to change states upon receiving the corresponding command:

- **[>om:brainstorm]:** Activates the Solutions Architect Agent. Conducts a deep project interview (Phase 1), proposes Tech Stack options (Phase 2), waits for user selection, and ONLY THEN outputs `design-spec.md` (Phase 3).
- **[>om:equip]:** Activates the Skill Manager Agent. Reads the tech stack from `design-spec.md` and proposes `npx skills add` commands to fetch necessary expert skills from skills.sh.
- **[>om:plan]:** Activates the PM Agent. Breaks `design-spec.md` into detailed micro-tasks in `todo.md`.
- **[>om:cook]:** Activates the Coder Agent. Executes tasks from `todo.md` using Surgical Changes.
- **[>om:check]:** Activates the QA Tester Agent. Verifies every completed task in `todo.md` actually works (build, tests, feature verification). Outputs `test-report.md`.
- **[>om:fix]:** Activates the QA Agent. Debugs using strict Error Log analysis.
- **[>om:doc]:** Activates the Technical Writer Agent. Writes README/API Docs in Vietnamese.
*Critical Note: Any attempt to bypass the planning steps (>om:brainstorm or >om:plan) to write code immediately MUST be rejected.*  