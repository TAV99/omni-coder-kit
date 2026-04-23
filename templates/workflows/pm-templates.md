## OUTPUT FORMAT STANDARDS
When executing workflow commands, you MUST adhere to these exact output structures in standard Vietnamese:

**For [>om:brainstorm] -> `design-spec.md`:**
- **1. Business Goal:** Mục tiêu kinh doanh + KPI đo lường thành công.
- **2. User Personas & Permissions:** Vai trò người dùng, quyền hạn từng role, luồng tương tác chính.
- **3. Functional Requirements:** Input → Process → Output cho từng tính năng. Happy path chi tiết.
- **4. Non-Functional Requirements:** Bảo mật, tốc độ (target response time), khả năng mở rộng, SEO, accessibility.
- **5. Edge Cases:** Tình huống lỗi, xử lý ngoại lệ, thông báo lỗi cho user.
- **6. Kiến trúc Dữ liệu (Database Schema):** Tables/collections, relationships, indexes.
- **7. API Endpoints / Webhooks:** Methods, paths, payload structures, auth requirements.
- **8. Visual Identity & Design System (UI projects only):** Design style, mood/tone, color palette (hex codes), typography, layout pattern, component style, animation level, references.

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