# Design Spec - Codex `$om:*` Alias for Omni Commands

## 1. Summary

Add a Codex chat alias layer so users can invoke Omni workflows with `$om:<command>` anywhere in a message, while preserving existing `>om:*` behavior.

Approved behavior:
- Full command set: `brainstorm`, `equip`, `plan`, `cook`, `check`, `fix`, `doc`, `learn`, `map`
- Match `$om:*` in any non-code text position
- Do not trigger when alias appears inside inline backticks or fenced code blocks
- Keep Codex guidance that project-level custom `/om:*` slash commands are not assumed

## 2. Goals

- Optimize Codex UX with a short, memorable Omni command alias.
- Keep command routing deterministic and backward-compatible.
- Prevent accidental triggers in code/documentation snippets.

## 3. Non-Goals

- Implement project-level custom `/om:*` slash commands in Codex.
- Dispatch multiple Omni workflows from one message.
- Support aliases outside the `om` namespace.

## 4. Scope

### In Scope
- Update Codex-oriented command guidance in templates/generated instructions.
- Update Codex SDLC workflow guidance to include alias normalization.
- Update README usage docs for Codex users.

### Out of Scope
- Changes to Claude-specific slash command overlay behavior.
- Runtime shell aliases or terminal command shortcuts.

## 5. Architecture

Apply a hybrid instruction-layer approach across three surfaces:

1. Codex AGENTS template (source used by `omni init`)
2. `.omni/workflows/superpower-sdlc.md` (runtime workflow guidance)
3. `README.md` (public usage documentation)

This keeps init output, runtime behavior, and docs aligned.

## 6. Alias Rules

### 6.1 Matching
- Detect pattern: `$om:<cmd>`
- `<cmd>` must be in whitelist:
  - `brainstorm`, `equip`, `plan`, `cook`, `check`, `fix`, `doc`, `learn`, `map`

### 6.2 Exclusions
- Ignore alias inside inline code spans: `` `$om:plan` ``
- Ignore alias inside fenced code blocks

### 6.3 Dispatch
- `$om:<cmd>` is normalized to `>om:<cmd>` for workflow routing.
- Existing `>om:*` behavior remains unchanged.

### 6.4 Multiple Commands in One Message
- If multiple valid commands exist, dispatch only the first valid command in non-code text order.
- Remaining commands are treated as contextual text, not additional dispatches.

### 6.5 Mixed Syntax
- If message contains both `>om:*` and `$om:*`, dispatch the first valid command in non-code text order.

## 7. Data Flow

1. User sends message.
2. Router/guidance layer conceptually partitions message into:
   - code segments (inline/fenced)
   - non-code segments
3. Command scan runs only on non-code segments.
4. First valid command token (`$om:*` or `>om:*`) selects workflow.
5. Existing workflow mapping executes unchanged.

## 8. Error Handling

- Unknown alias (example: `$om:unknown`) does not trigger dispatch.
- Alias fully inside code formatting does not trigger dispatch.
- Empty or malformed alias token does not trigger dispatch.
- No valid command token means no command routing action.

## 9. Compatibility

- Backward compatibility: 100% for `>om:*` users.
- No behavioral change for Claude slash-command overlay.
- Codex documentation remains explicit that custom `/om:*` registration is not guaranteed.

## 10. Validation Scenarios

1. `$om:brainstorm lam app quan ly task` -> dispatch `brainstorm`
2. `abc $om:plan xyz` -> dispatch `plan`
3. `` `$om:plan` `` -> no dispatch
4. fenced code block containing `$om:check` -> no dispatch
5. `$om:unknown` -> no dispatch
6. `>om:cook ... $om:check ...` -> dispatch first valid token only
7. `>om:doc` -> unchanged behavior

## 11. Implementation Impact (for next phase)

Expected edits in implementation phase:
- Codex AGENTS template generation logic/content
- `.omni/workflows/superpower-sdlc.md`
- `README.md`
- Optional tests/assertions around command normalization examples if project has command-parser tests

## 12. Risks and Mitigations

- Risk: ambiguous behavior when many commands appear in one message
  - Mitigation: deterministic "first valid command wins" rule
- Risk: accidental trigger in docs snippets
  - Mitigation: strict no-trigger in inline/fenced code
- Risk: doc drift between AGENTS/workflow/README
  - Mitigation: apply same rule set in all three surfaces

## 13. Success Criteria

- Codex users can invoke all Omni workflows via `$om:*` in normal chat text.
- Code-snippet mentions do not trigger command routing.
- Existing `>om:*` usage remains fully functional.
- Docs and generated guidance consistently describe identical behavior.
