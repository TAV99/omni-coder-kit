## OUTPUT FORMAT STANDARDS
When executing workflow commands, you MUST adhere to these exact output structures in standard Vietnamese:

**For [>om:brainstorm] -> `.omni/sdlc/design-spec.md`:**
Hybrid format with 2 parts:
- **Part A — Summary table:** Goal, Users, Tech Stack (with justification), UI Style, Constraints. Machine-readable for `>om:plan`.
- **Part B — Tagged requirement list:** Each requirement is a bullet with category tag. Tags: `[func]`, `[auth]`, `[nfr]`, `[edge]`, `[ui]`, `[data]`, `[api]`. Grouped by: Core, Auth & Permissions, Data, API, Non-Functional, Edge Cases, Visual.
- Each `[func]` item uses "input → process → output" format when possible.
- Each `[data]` item lists actual field names and relationships.
- Each `[api]` item includes method, path, and auth level.
- Each `[nfr]` item includes concrete numbers.

**For [>om:plan] -> `.omni/sdlc/todo.md`:**
- Must be grouped by components/modules.
- Each task MUST use the `- [ ]` markdown checkbox format.
- Tasks must be micro-sized (estimable to < 20 mins of coding).
- Add a final `## Verification` section with build/lint/test tasks.

**For [>om:cook] -> inline progress:**
- Report after each task: ✅ [task] — Done, files changed, next task.
- Quality gate triggers automatically every ceil(total/3) tasks (3 cycles). No manual `>om:check` needed.
- Summary on stop: X/Y tasks completed, Z skipped.

**For [>om:check] -> `.omni/sdlc/test-report.md`:**
- Build & Lint status (PASS/FAIL).
- Automated test results (X/Y passed).
- Feature verification table: each `- [x]` task from `.omni/sdlc/todo.md` with method, result, and notes.
- Summary: total/passed/failed/skipped counts + blocking issues.
- Next steps: proceed to `>om:doc` or fix with `>om:fix` then re-check.

**For [>om:fix] -> inline report:**
- For each fix: 🔧 Fix description, root cause (1 sentence), files changed, verification result (PASS/FAIL).
- If fix fails after 3 attempts, document what was tried before escalating.

**For [>om:doc] -> `README.md` + optional `docs/api.md`:**
- README must include: Tổng quan, Cài đặt, Sử dụng, Cấu trúc dự án, API Documentation, Tech Stack.
- All in Vietnamese. Only document implemented features (cross-check with .omni/sdlc/todo.md completion).