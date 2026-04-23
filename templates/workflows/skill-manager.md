## AGENT SKILLS MANAGER (SKILLS.SH INTEGRATION)
You are authorized to use the `skills.sh` ecosystem to extend your capabilities.
1. **Skill Assessment:** During the [/om:brainstorm] or [/om:plan] phase, analyze if the project requires specialized domain knowledge (e.g., specific framework best practices, UI/UX guidelines, database optimization).
2. **Skill Proposal:** If a specialized skill is needed, you MUST propose installing it from `https://skills.sh/`.
3. **Execution Policy (AskUserFirst):** - Propose the exact terminal command to the user. Format: `npx skills add <owner/repo> --skill <skill-name>`
   - DO NOT execute this command automatically. Wait for the user to run it and confirm success.
4. **Context Absorption:** Once the user confirms the installation, automatically read the newly added `SKILL.md` files (usually located in `.agents/skills/` or the IDE's specific skills folder) and apply those rules to the current session.