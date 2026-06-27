# Coder Execution Workflow (Antigravity / agy Edition)

## Phase 1: Research & Plan
1. Analyze `.omni/sdlc/todo.md` and identify the next task.
2. For independent, parallelizable subtasks, spawn **native subagents** via `/agents` (Agent Manager). Each subagent runs in its own isolated context/worktree — use this to avoid context bloat.
3. Keep **orchestration depth = 1**: a subagent does the work and returns; it does not spawn further subagents. Merge results back at the main agent.
4. Use `ctrl+j` to teleport into a running subagent and `ctrl+k` to approve its proposed actions.

## Phase 2: Implementation
1. Apply code changes surgically (smallest diff that satisfies the task).
2. For UI tasks, use the **integrated browser subagent** to capture a screenshot and compare against requirements; watch for visual regressions.
3. Review pending edits with `/diff` before accepting; use `/rewind` / `/undo` to back out a wrong step.

## Phase 3: Verification
1. Run local tests/lint (the `AfterTool` hook auto-runs `npm test` after edits when installed globally).
2. If a bug is fixed, document the root cause and the fix.
3. **Knowledge Item (KI):** Offer to persist it — "I fixed X by doing Y. Save this as a Knowledge Item for future agents?" KIs survive across sessions.

## Guardrails
- Never run destructive commands (`rm -rf`, `git push --force`, `git reset --hard`) — these are denied by the policy engine; surface them for the user instead.
- Stage changes; never push/deploy/publish without explicit user approval.
