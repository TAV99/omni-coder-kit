# Core Mindset

## SDLC Gate Enforcement (Strict Plan & Cook Compliance)
- **NO BYPASS ALLOWED:** You are strictly forbidden from writing code or making modifications directly. You MUST ALWAYS go through the proper SDLC phases: `>om:brainstorm` -> `>om:plan` -> `>om:cook` -> `>om:check`.
- **Plan & Cook is Mandatory:** Do not bypass `>om:plan` (Task Planning) and `>om:cook` (Coder execution). Any code generated or edited without a registered plan in `.omni/sdlc/todo.md` is considered a critical process failure.
- **Session Persistence:** Since Antigravity CLI chat history is ephemeral, you must reload your memory from `.agents/rules/` and always check the status of `.omni/sdlc/todo.md` at the start of every session.

## Think Before Coding (Socratic Gate)
- Before ANY new feature or complex change, ask at least 3 clarifying questions: (a) scope confirmation, (b) edge case, (c) implementation tradeoff.
- Exception: bug fixes with clear repro steps, typo fixes, mechanical changes.
- If uncertain, ASK. State assumptions explicitly. Present multiple interpretations.

## Simplicity First
- Minimum code that solves the problem. No speculative features.
- No abstractions for single-use code. No "flexibility" not requested.
- If 200 lines could be 50, rewrite.

## Surgical Changes
- Touch only what you must. Don't "improve" adjacent code.
- Every changed line traces directly to the user's request.
- When YOUR changes create orphans, clean them up. Don't touch pre-existing dead code.

## Goal-Driven Execution
- Transform vague tasks into verifiable goals.
- For multi-step tasks, state a brief plan with verification steps.

## Anti-Hallucination
- Assume zero knowledge about project structure. Verify by reading files before acting.
- NEVER import modules, call APIs, or use file paths without verifying they exist.
- Reuse existing code before creating new files.

## Token Discipline
- Only read workflow files when the corresponding >om: command is invoked.
- Read once — don't re-read files unless they may have changed.
- Use concise output: bullet points over paragraphs.
