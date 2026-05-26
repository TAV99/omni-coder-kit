# Antigravity CLI Tools Integration

## Native Tools & Capabilities
- **AGENTS.md Discovery:** Antigravity automatically discovers the `AGENTS.md` file from the project root and loads it. Rules, skills, and workflows are structured inside the `.agents/` directory.
- **Knowledge Items (KIs):** Persist architecture decisions, debugging solutions, and implementation patterns as Knowledge Items (KIs). Unlike standard chat history, KIs survive across sessions. Save crucial findings so future agents can leverage them instantly.
- **Multi-Agent (Manager View):** For complex tasks, spawn specialized agents from the Manager View (`Cmd+E` / `Ctrl+E`). Each agent operates in its own isolated worktree or workspace. Use this to delegate parallel tasks safely.
- **Browser Testing:** Use the integrated browser to visually verify UI changes. Take screenshots to detect visual regressions and ensure a premium visual experience before finalizing changes.
- **Workflows:** Reusable workflows go into `.agents/workflows/` and can be triggered via `/workflow-name` in chat.
- **JSON Hooks & Automation:** Hook into agent lifecycle phases (configured via `hooks.json` globally or per-workspace):
  - `PreInvocation`: Run setup or preflight check scripts before the agent session starts.
  - `PreToolUse`: Intercept and gate proposed tool calls (e.g., `run_command`). The hook receives a JSON payload with `toolCall` details and returns a `decision` (`"allow"`, `"deny"`, `"ask"`, `"force_ask"`) along with optional `permissionOverrides`.
  - `PostToolUse`: Execute automated verification tasks (like running linters or tests) immediately after tool execution.


## Confirmation Policy
- **Destructive Operations:** ALWAYS request explicit user confirmation before executing any destructive operations (e.g., database writes, deployments, `rm -rf`, `git push --force`).
- **Preflight Checks:** Always run preflight lints or tests before completing a task.

## Model Recommendations
- **Gemini 3.5 Flash** — Default model. Extremely fast and highly capable for most coding and debugging tasks.
- **Gemini 3.5 Pro** — Advanced reasoning model. Recommended for complex refactoring, performance optimization, and architectural decisions.
- **Gemini 3.1 Pro** — Legacy reasoning model. Highly capable for parsing large context scopes.
- *Switch models using the `/model` command in the chat.*

## Sandbox Awareness
- When running in sandbox or restricted mode, network commands (`npx`, `curl`, `git push`) may be blocked or require permission.
- If a terminal command fails due to insufficient permissions, use the `ask_permission` tool or output the command for the user to execute manually.
