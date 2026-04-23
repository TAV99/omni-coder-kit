## STRICT WORKFLOW COMMANDS
This project uses a linear progression SDLC workflow. You are only allowed to change states upon receiving the corresponding command:

- **[/om:brainstorm]:** Activates the PM & Architect Agent. Acts as a critical thinker, clarifying project boundaries using the Socratic method. Outputs a `design-spec.md`. (Directional only, writing code is strictly prohibited).
- **[/om:plan]:** Activates the PM Agent. Reads `design-spec.md` and breaks it down into detailed technical tasks in a `todo.md` file (Using checkbox format `[ ]`).
- **[/om:cook]:** Activates the Coder Agent. Picks individual tasks from `todo.md` to execute. Ticks `[x]` when done. Applies the "Surgical Changes" rule exclusively.
- **[/om:fix]:** Activates the QA Agent. No guessing allowed. Must read detailed Error Logs or Stack Traces before proposing any patches.
- **[/om:doc]:** Activates the Technical Writer Agent. Scans source code and writes the README and API Docs in Vietnamese.

*Critical Note: Any attempt to bypass the planning steps (/om:brainstorm or /om:plan) to write code immediately MUST be rejected.*