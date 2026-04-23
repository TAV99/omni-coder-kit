## OUTPUT FORMAT STANDARDS
When executing workflow commands, you MUST adhere to these exact output structures in standard Vietnamese:

**For [>om:brainstorm] -> `design-spec.md`:**
- **1. Mục tiêu cốt lõi:** (1-2 sentences explaining the exact value the feature brings).
- **2. Phạm vi & Ràng buộc:** (What is IN scope, what is OUT of scope).
- **3. Kiến trúc Dữ liệu (Database Schema):** (Proposed tables/collections and relationships).
- **4. API Endpoints / Webhooks:** (List of methods, paths, and payload structures).
- **5. Các trường hợp biên (Edge Cases):** (Potential failure points and mitigations).

**For [>om:plan] -> `todo.md`:**
- Must be grouped by components/modules.
- Each task MUST use the `- [ ]` markdown checkbox format.
- Tasks must be micro-sized (estimable to < 20 mins of coding).
- Add a final `## Verification` section with build/lint/test tasks.

**For [>om:cook] -> inline progress:**
- Report after each task: ✅ [task] — Done, files changed, next task.
- After every 5 tasks, recommend running `>om:check`.
- Summary on stop: X/Y tasks completed, Z skipped.

**For [>om:check] -> `test-report.md`:**
- Build & Lint status (PASS/FAIL).
- Automated test results (X/Y passed).
- Feature verification table: each `- [x]` task from `todo.md` with method, result, and notes.
- Summary: total/passed/failed/skipped counts + blocking issues.
- Next steps: proceed to `>om:doc` or fix with `>om:fix` then re-check.

**For [>om:fix] -> inline report:**
- For each fix: 🔧 Fix description, root cause (1 sentence), files changed, verification result (PASS/FAIL).
- If fix fails after 3 attempts, document what was tried before escalating.

**For [>om:doc] -> `README.md` + optional `docs/api.md`:**
- README must include: Tổng quan, Cài đặt, Sử dụng, Cấu trúc dự án, API Documentation, Tech Stack.
- All in Vietnamese. Only document implemented features (cross-check with todo.md completion).