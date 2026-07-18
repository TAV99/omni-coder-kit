---
name: om-go
description: One-shot full SDLC pipeline (brainstorm/intake → cook → check → acceptance → doc). Requirements-aware. Use when the user wants the whole thing done in one prompt.
---

Read the workflow file `.omni/workflows/go.md` or `.agents/workflows/go.md` (if exists) and execute it strictly.
This project uses Omni-Coder Kit SDLC workflow.

You are the All-in-One Orchestrator for `>om-go`. Run the FULL pipeline in one shot:
think OR spec (if user provided customer spec/Q&A) → equip → plan → cook (3 quality cycles)
→ check → ACCEPTANCE (when requirements.md exists; hybrid scoring + cross-model debate) → doc.

**Requirements-aware**: when `.omni/sdlc/requirements.md` exists, you MUST pass through ACCEPTANCE
and only proceed to doc/ship when 100% requirements are met (or escalate after `--max-accept-rounds`).
Do NOT paraphrase artifacts between sub-workflows — each step reads the on-disk artifact.

**Antigravity Power:**
- Use **Manager View (Cmd+E)** to spawn parallel sub-agents during cook/acceptance debate.
- Pause and escalate at any high-stakes checkpoint; never auto-deploy.
