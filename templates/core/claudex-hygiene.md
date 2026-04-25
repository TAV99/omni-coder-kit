## CONTEXT HYGIENE & ANTI-HALLUCINATION (PARANOID MODE)
To prevent hallucinations, token waste, and technical debt, follow these rules strictly:

### Grounding Rules
1. **Assume Nothing:** Default state is zero knowledge about project structure. Verify by reading files before acting.
2. **No Phantom Imports:** NEVER import a module, function, or package without verifying it exists in the project.
3. **No Phantom APIs:** NEVER call an API endpoint or function with a signature you haven't verified from source code or docs.
4. **No Speculative Paths:** NEVER assume a file path exists. List the directory first.
5. **Reuse First:** Before creating a new file, component, or utility, search existing code for reusable implementations.

### Self-Verification Checklist
Before submitting ANY code change, verify:
- Every import resolves to an existing file or installed package
- Every function call matches the actual signature (check source/types)
- Every API endpoint matches the actual route definition
- Every env variable referenced is documented or exists in `.env.example`
- No duplicate logic — searched for existing implementations first
- No hardcoded values that should come from config or env

### Token Discipline
- **Lazy Workflow Loading:** Only read workflow files when the corresponding `>om:` command is invoked. Do NOT pre-load all workflows into context.
- **Lazy Examples:** Only read example/template files (like `interview-examples.md`) when you actively need to formulate a question or reference a format. Do not pre-load.
- **Read Once:** If you've already read a file in this session, don't re-read unless it may have changed.
- **Concise Output:** Use bullet points over paragraphs. State conclusions directly.

### Context-Aware Verbosity
Adjust output verbosity based on the active command:
- **`>om:cook` (coding):** Terse. Report only: task done, files changed, next task. No explanations of what you're about to do. Do not echo file contents after editing — use tools to write directly.
- **`>om:check` (QA):** Terse on PASS — just print "PASS" per check. Verbose on FAIL — print full error details, stack traces, and reproduction steps.
- **`>om:brainstorm` / `>om:plan`:** Verbose. Explain reasoning, present options, ask clarifying questions.
- **On errors:** Always verbose — explain what went wrong, what you tried, and what you recommend.

### Language Constraints
- Internal reasoning and planning: Use English for optimal logical capability.
- User communication, code comments, documentation, and commit messages: Use clear Vietnamese.
