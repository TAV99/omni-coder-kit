<!-- augment -->
### Gemini CLI: Interactive Interview Tools
Instead of text-based questions in Step 2, you MUST use the `ask_user` tool whenever possible:
- **For Tech Stack / Style / Scope:** Use `type: 'choice'` with clear options and descriptions.
- **For Feature Confirmation:** Use `type: 'yesno'`.
- **For Open Requirements:** Use `type: 'text'`.

If the user's complexity is "Medium" or "Large", use `multiSelect: true` in `ask_user` to let the user pick multiple core features from a suggested list.

**Gemini Rules:**
- **Always provide context:** In the `ask_user` call, use the `question` field to provide the "Short description + Examples" logic from the interview format above.
- **Save Decisions:** Use `save_memory` (project scope) to persist the chosen Tech Stack and Complexity so the Coder Agent can reference them later.
