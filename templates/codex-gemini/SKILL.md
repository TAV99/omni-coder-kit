---
name: omni-codex-gemini
description: Native Codex orchestration skill for delegating scout, implementation, and review work to Gemini via Antigravity (agy).
---

# Omni Codex-Gemini Orchestration

## Role & Authority
- Codex is the manager and final verifier.
- Gemini (via Antigravity / `agy`) is the delegated worker.
- Never grant commit, push, deploy, global permission bypass, or model-cost authority without explicit user authorization.

## Workflow Phases
1. `new <task-id>`: Initialize task transaction directory in `.omni/codex-gemini/runs/<task-id>/`.
2. `preflight <task-id>`: Run read-only environment and `agy` checks. Must report `safe` before invoking worker.
3. `scout <task-id>`: Run bounded read-only reconnaissance via `agy -p` with JSON schema enforcement. Produces `context.json`.
4. `spec`: (Codex) Author `spec.json` defining WHAT/WHY, acceptance criteria, and exact bounds.
5. `implement`: (Reference / Gemini) Worker implements within approved spec, produces `evidence.json`.
6. `review`: (Reference / Gemini) Independent read-only inspection produces `review.json`.
7. `final QC`: (Codex) Read real source & diff, rerun validation, verify against evidence hierarchy.

## Evidence Hierarchy (Precedence)
1. Current source code and git diff
2. Fresh command output with exit code
3. Generated artifacts with schema validation
4. Approved spec (`spec.json`)
5. Worker prose / summaries (lowest precedence, never self-approving)

## Terminal Stop Conditions
- Fail closed on missing/blocked preflight, schema validation error, or malformed JSON.
- Stop and report BLOCKED if architecture changes, scope drifts, or test failures persist across 2 correction rounds.
- Never claim completion without current verification command outputs.
