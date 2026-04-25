# Design Spec - Codex CLI Overlay Optimization

> Generated: 2026-04-25 | Complexity: Large
> Approach: Phased Codex Overlay (base workflows + Codex-specific overlay)

## Summary

| Field | Value |
|-------|-------|
| Goal | Toi uu omni-coder-kit cho Codex CLI ma khong lam regression Claude Code overlay hien co |
| Target Users | Codex CLI users, dual Claude Code + Codex users, TAV power-user |
| Approach | Them `templates/overlays/codex/` rieng, dung chung base workflows va overlay merge system |
| Phase 1 Scope | Codex-native setup: lean `AGENTS.md`, `.codex/config.toml`, `.codex/hooks.json`, Codex workflow overrides, README update |
| Out of Scope | Custom `/om:*` slash command registration cho Codex, vi chua co co che official/documented nhu Claude Code |
| Backward Compat | Claude Code overlay giu nguyen; Cursor/Windsurf/Generic behavior khong doi |

## 1. Architecture

### Directory Structure

Add a Codex overlay next to the existing Claude Code overlay:

```text
templates/
  core/
  workflows/
  overlays/
    claude-code/        # existing, must not be changed by this feature
    codex/              # new
      config.template.toml
      hooks.template.json
      docs/
        codex-usage.md
      workflows/
        coder-execution.md
        superpower-sdlc.md
```

### Overlay Rules

- Base workflows in `templates/workflows/` remain the default for every IDE.
- Codex-specific behavior lives only under `templates/overlays/codex/`.
- Claude Code-specific behavior continues to live only under `templates/overlays/claude-code/`.
- A workflow file in an overlay replaces the base workflow with the same filename for that target.
- Codex overlay must not generate `.claude/` files.
- Claude Code overlay must not generate `.codex/` files.

### Helper Design

The existing Claude-only overlay helpers should be generalized without changing Claude output:

- `getOverlayDir(ide)` becomes either `getOverlayDirs(ide)` or a target-aware equivalent.
- `buildWorkflows(ide, target)` builds base workflows plus the overlay for a specific target.
- `buildCommands(ide)` remains Claude-only because Codex CLI does not currently document project-defined custom slash command files.
- Codex setup uses dedicated helpers:
  - `buildCodexConfig(advanced)`
  - `buildCodexHooks(advanced)`
  - `writeCodexAdvancedSetup(manifest)`

## 2. Codex Overlay Contents

### Lean `AGENTS.md`

Codex reads `AGENTS.md` as project instructions and has a default project-doc byte budget. `AGENTS.md` should therefore stay compact:

- core mindset rules
- hygiene rules
- `>om:*` workflow registry
- Codex-specific adapter rules
- personal rules injection
- references to `.omni/workflows/` for detailed instructions

Long SDLC instructions should stay in `.omni/workflows/`, not inline in `AGENTS.md`.

### `.codex/config.toml`

When Codex advanced setup is enabled, generate `.codex/config.toml` from `templates/overlays/codex/config.template.toml`.

The template should include conservative defaults and comments for user edits:

- model/reasoning placeholders that users can adjust
- sandbox and approval guidance for local development
- `project_doc_max_bytes` guidance so `AGENTS.md` stays predictable
- feature flag section for hooks when needed
- optional profile examples for `codex --full-auto` and safer interactive work

The config must avoid forcing dangerous defaults. It should document trade-offs and leave full-auto/danger bypass as explicit user choices.

### `.codex/hooks.json`

When Codex hooks are enabled, generate `.codex/hooks.json` from `templates/overlays/codex/hooks.template.json`.

Hooks are lightweight nudges, not a replacement for Omni workflows:

- remind about quality gates after relevant turns
- surface validation command suggestions
- avoid destructive automation
- keep behavior deterministic and easy to inspect

The README and generated docs must mention that Codex hooks require trusted project configuration and the relevant Codex feature flag/environment support.

### Workflow Overrides

Codex overlay should override only workflows where Codex-native behavior matters:

- `coder-execution.md`
  - keep one-task-at-a-time discipline by default
  - explain how Codex sandbox and approval policy affect shell/network/git actions
  - use Codex subagents only when tasks are clearly independent and the user has explicitly asked for agent delegation
  - preserve the 3-cycle quality gate behavior

- `superpower-sdlc.md`
  - document Codex-native commands alongside Omni `>om:*`
  - include `/plan`, `/review`, `/permissions`, `/agent`, `/status`, `/mcp`, `/plugins`
  - explain the stable Omni invocation path: type `>om:*` in chat so the model receives the command as text

## 3. `/om:*` Positioning for Codex

Claude Code has project slash command files in `.claude/commands/`, so `/om:*` can be implemented natively there.

Codex CLI currently documents built-in slash commands, but not a project-level custom slash command directory equivalent to `.claude/commands/`. Phase 1 will not claim native custom `/om:*` registration for Codex.

The Codex design keeps the UX direction without depending on unsupported behavior:

- Stable path: user types `>om:brainstorm`, `>om:plan`, `>om:cook`, etc. in Codex chat.
- Codex adapter maps each `>om:*` command to the corresponding `.omni/workflows/*.md` file.
- `AGENTS.md` may mention `/om:*` only as a future compatibility goal, not as a guaranteed Codex-native feature.
- If Codex later supports project custom slash commands officially, add a `templates/overlays/codex/commands/` layer in a later phase.

## 4. `omni init` Flow

### Codex CLI

When the user selects Codex CLI:

```text
AGENTS.md
.omni/workflows/
.omni-manifest.json
.codex/config.toml    # advanced setup only
.codex/hooks.json     # advanced setup only
```

Flow:

1. Generate lean `AGENTS.md` with Codex adapter.
2. Copy base workflows plus Codex workflow overrides into `.omni/workflows/`.
3. Ask whether to install Codex advanced setup.
4. If yes, create `.codex/config.toml` and `.codex/hooks.json`.
5. Update `.omni-manifest.json` with Codex overlay metadata.

### Claude Code

Claude Code behavior remains unchanged:

```text
CLAUDE.md
.omni/workflows/
.claude/commands/
.claude/settings.json # optional existing advanced setup
```

Codex overlay must not run for this choice.

### Dual

When the user selects dual Claude Code + Codex:

```text
CLAUDE.md
AGENTS.md
.omni/workflows/
.claude/commands/
.claude/settings.json # optional Claude setup
.codex/config.toml    # optional Codex setup
.codex/hooks.json     # optional Codex setup
```

Dual must keep adapters separate:

- `CLAUDE.md` uses Claude Code adapter and Claude command registry.
- `AGENTS.md` uses Codex adapter and Codex command guidance.
- `.claude/` contains Claude-native files.
- `.codex/` contains Codex-native files.
- Shared `.omni/workflows/` must avoid tool-specific assumptions that break either agent.

If a workflow cannot safely serve both tools in dual mode, prefer the base workflow and keep tool-specific guidance in `CLAUDE.md`, `AGENTS.md`, `.claude/`, and `.codex/`.

## 5. README and Usage Docs

Update README with a Codex-specific section:

- `omni init` -> select Codex CLI
- stable chat usage: `>om:brainstorm`, `>om:plan`, `>om:cook`, `>om:check`, `>om:fix`, `>om:doc`
- optional advanced setup files under `.codex/`
- recommended launch examples:
  - safer interactive: `codex`
  - lower-friction local work: `codex --full-auto`
  - non-interactive automation: `codex exec "<prompt>"`
- warning that full-auto and sandbox bypass modes are user-controlled risk decisions
- explicit note that Codex custom `/om:*` project slash commands are not implemented in phase 1 because they are not currently documented as a stable project extension point

Add `templates/overlays/codex/docs/codex-usage.md` as generated reference material that can be copied or referenced by README.

## 6. Testing

### Automated Checks

- Keep existing `npm test` syntax validation.
- Add focused tests only if they fit the current lightweight project style. Do not introduce a large test framework solely for this feature.

### Smoke Verification

Use temporary directories to verify `omni init` outputs:

- Codex:
  - creates `AGENTS.md`
  - creates `.omni/workflows/`
  - creates `.codex/config.toml` and `.codex/hooks.json` when advanced setup is selected
  - does not create `.claude/`
  - keeps `AGENTS.md` under the target Codex project-doc budget

- Claude Code:
  - still creates `.claude/commands/`
  - still offers `.claude/settings.json`
  - does not create `.codex/`

- Dual:
  - creates `CLAUDE.md` and `AGENTS.md`
  - keeps `.claude/` and `.codex/` separate
  - does not mix Claude slash command files into Codex setup

- Other IDEs:
  - Cursor, Windsurf, Cross-tool, and Generic behavior remains unchanged.

### Manual Review

- Confirm `templates/overlays/claude-code/` has no intended content changes.
- Confirm Codex workflow override mentions sandbox, approval policy, hooks, native slash commands, and subagents.
- Confirm README does not overclaim Codex custom `/om:*` support.

## 7. Acceptance Criteria

- `templates/overlays/codex/` exists with config, hooks, docs, and workflow override templates.
- `omni init` selected as Codex uses Codex overlay and does not depend on Claude overlay.
- `omni init` selected as Claude Code behaves the same as before this feature.
- `omni init` selected as dual creates both adapters without mixing native files.
- Codex `AGENTS.md` is lean and points to `.omni/workflows/`.
- Codex advanced setup is optional and transparent.
- README documents Codex workflow, advanced setup, and `/om:*` limitation accurately.
- No destructive defaults are introduced.

## 8. Sources and Current Assumptions

- OpenAI AGENTS.md guide: https://developers.openai.com/codex/guides/agents-md
- Codex CLI slash commands: https://developers.openai.com/codex/cli/slash-commands
- Codex hooks: https://developers.openai.com/codex/hooks
- Local Codex version observed during design: `codex-cli 0.125.0`

These assumptions should be rechecked during implementation if Codex CLI or official docs have changed.
