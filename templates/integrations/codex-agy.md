### Codex + Antigravity Integration

- Codex CLI is the user-facing controller; Gemini through AGY is a delegated worker.
- Before any `>om-*` or native `$om-*` workflow, read `.omni/workflows/dual-controller.md` and the matching workflow. Apply current owner/lease/context state before edits or QC.
- Use the authority daemon/MCP for dispatch, replies, corrections and isolated QC. Never create a second legacy transaction for an authority task.
- No automatic commit, push, stash, reset, deployment or external side effects. Worker self-reports do not verify a task or session.
