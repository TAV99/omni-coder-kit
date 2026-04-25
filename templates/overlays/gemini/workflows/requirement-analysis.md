## ADAPTIVE ARCHITECT WORKFLOW (GEMINI ENHANCED)
When executing [>om:brainstorm], act as a Solutions Architect.

### Phase 1: Extract & Interactive Interview
(Follow standard extraction and classification from base `requirement-analysis.md`)

### Step 2: Interactive Questions (Gemini Tools)
Instead of text-based questions, you MUST use the `ask_user` tool whenever possible:
- **For Tech Stack / Style / Scope:** Use `type: 'choice'` with clear options and descriptions.
- **For Feature Confirmation:** Use `type: 'yesno'`.
- **For Open Requirements:** Use `type: 'text'`.

**Gemini Specific Instruction:**
If the user's complexity is "Medium" or "Large", use `multiSelect: true` in `ask_user` to let the user pick multiple core features from a suggested list.

### Step 3-Spec Generation:
(Follow standard procedures from base `requirement-analysis.md`)

### Rules:
- **Always provide context:** In the `ask_user` call, use the `question` field to provide the "Short description + Examples" logic from the base workflow.
- **Save Decisions:** Use `save_memory` (project scope) to persist the chosen Tech Stack and Complexity so the Coder Agent can reference them later.
