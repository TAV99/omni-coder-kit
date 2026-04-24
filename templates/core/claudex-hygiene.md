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
- **Read Once:** If you've already read a file in this session, don't re-read unless it may have changed.
- **Concise Output:** Use bullet points over paragraphs. State conclusions directly.

### Language Constraints
- Internal reasoning and planning: Use English for optimal logical capability.
- User communication, code comments, documentation, and commit messages: Use clear Vietnamese.
