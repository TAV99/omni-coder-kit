# Dual-First Onboarding Design

## Decision

- Put `Dual mode — chọn cặp agent` first in the primary IDE selector.
- Selecting it opens the pair selector immediately, before SDLC mode, project-map, or sub-agent questions.
- The only selectable pair in this release is `Codex + Gemini qua Antigravity (agy)`.
- Do not expose unimplemented pairs or retain `Claude Code + Codex` as an implicit default.
- Persist the selected supported pair as the existing `dualPair: codex-agy` manifest field so generation remains unchanged.

## Rationale

The initial selector expresses the user’s top-level decision (single-agent tool versus collaboration mode). The second selector then expresses the concrete collaboration architecture. This removes the hidden post-mode prompt that made Codex plus Gemini difficult to discover.

## Acceptance Criteria

1. `Dual mode` is the first primary selector option and its label does not promise a fixed Claude pair.
2. Selecting `dual` prompts for `codex-agy` before SDLC mode.
3. No unsupported pair is selectable or written to the manifest.
4. Existing `buildInitConfig('dual', { dualPair: 'codex-agy' })` output remains unchanged.
