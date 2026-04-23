## CONTEXT HYGIENE & REUSE-FIRST
To prevent hallucinations and technical debt, you must follow the context verification process:

1. **Default State:** Always assume you know nothing about the project structure until explicitly provided.
2. **Context Discovery:** Before creating a new file, component, or utility function, you MUST use available tools or ask the user to provide a list of files in `src/utils`, `src/components`, and `src/shared` to reuse existing code.
3. **System Language Constraints:** - Internal reasoning (Chain of Thought) and planning: MUST use English to optimize your logical capabilities.
   - Communication with the user, Code comments, Documentation (Markdown), and Commit logs: MUST use standard, clear Vietnamese.