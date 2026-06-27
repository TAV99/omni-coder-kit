# Antigravity CLI (agy) Tools Integration

> agy is built on the Gemini CLI and shares `~/.gemini/`. Config schemas below are verified against the official Gemini CLI / Antigravity docs (2026).

## Native Tools & Capabilities
- **AGENTS.md Discovery:** agy loads `AGENTS.md` from the project root (the extension manifest sets `contextFileName: "AGENTS.md"`). Omni's modular rules live in `.agents/rules/`.
- **Skills (native slash commands):** Skills live in `.agent/skills/<name>/SKILL.md` (workspace) or `~/.gemini/antigravity/skills/` (global). Each becomes a `/<name>` command. Omni installs `om-*` skills there (`/om-cook`, `/om-check`, `/om-ship`, …).
- **Native Subagents:** Use `/agents` (Agent Manager) to spawn specialized subagents for independent tasks; `ctrl+j` to teleport into a subagent, `ctrl+k` to approve. Run independent work in parallel, merge at main. Keep orchestration depth = 1 (a subagent does not spawn subagents).
- **Knowledge Items (KIs):** Persist architecture decisions, debugging solutions, and patterns as KIs — they survive across sessions.
- **Browser Testing:** Use the integrated browser subagent to verify UI changes and capture screenshots before finalizing.
- **MCP:** Custom servers in `~/.gemini/config/mcp_config.json` (or `mcpServers` in the extension manifest); supports command-based servers and `url`. Inspect with `/mcp`.

## Slash Commands (know these)
- `/diff` — review pending changes · `/rewind` `/undo` — roll back · `/agents` `/tasks` — manage subagents & tasks
- `/skills` — list installed skills · `/mcp` — MCP servers · `/model` — switch model · `/permissions` — edit permission rules · `/hooks` — manage lifecycle hooks
- `/usage` `/quota` — real-time consumption · **Artifact Review** (`ctrl+r`) — review/approve agent plans

## Hooks (verified schema — `~/.gemini/config/hooks.json`)
Events are `BeforeTool` / `AfterTool` (NOT PreToolUse/PostToolUse). Shape:
```json
{ "hooks": { "AfterTool": [ { "matcher": "write_file|replace",
  "hooks": [ { "name": "omni-verify", "type": "command", "command": "npm test || true", "timeout": 120000 } ] } ] } }
```
The `/hooks` command writes to `~/.gemini/config/hooks.json` (shared TUI ↔ backend).

## Permissions (TOML policy engine, not allow/deny JSON)
Gate tool calls with policy rules. Each rule: `toolName` / `commandPrefix` / `commandRegex`, `decision` = `"allow"` | `"deny"` | `"ask_user"`, plus `priority` (0–999), `denyMessage`, `modes`.
```toml
[[rule]]
commandPrefix = "git push --force"
decision = "deny"
denyMessage = "Force-push is blocked by omni-coder-kit"
priority = 100
```
- **Deny:** `rm -rf`, `git push --force`, `git reset --hard` · **Ask:** install/commit · **Allow:** lint/test/build.
- "Always Approve" rules match strictly (non-regex) by default; prefix a rule with `regex:` to opt into regex. Manage via `/permissions`. Project perms in `~/.gemini/config/projects/` take precedence over global `~/.gemini/antigravity-cli/settings.json`.

## Model Recommendations (verified — switch with `/model` or `--model`)
- **Gemini 3 Flash** — fast default for scans, simple edits, and most coding/debugging.
- **Gemini 3 Pro (high/low)** — advanced reasoning for refactors, performance, and architecture.
- **Claude Sonnet 4.5 / Opus 4.5 (thinking)** — also available in agy for deep reasoning.
- List available models with the `models` subcommand.

## Headless / CI
- `agy -p "<prompt>"` (or `--print`) — one-shot non-interactive run.
- `agy --dangerously-skip-permissions -p ...` — skip permission prompts (only when the prompt is trusted).
- `agy --headless --approve all` / `--sandbox` — sandboxed CI runs (`--sandbox` propagates in print mode).
- Non-TTY note: some agy builds drop stdout under a pipe — harmless for omni's artifact-driven loop (state comes from artifacts); use `--provider manual-relay` for cross-provider debate if stdout empties.

## Sandbox Awareness
- In sandbox/restricted mode, network commands (`npx`, `curl`, `git push`) may be blocked or require permission.
- If a command fails on permissions, output it for the user to run manually rather than retrying blindly.
