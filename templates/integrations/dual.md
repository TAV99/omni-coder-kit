### Claude Code Integration
- **Native Commands:** Dùng `/om:brainstorm`, `/om:cook`, ... (auto-complete) hoặc gõ `>om:brainstorm`, `>om:cook` trong chat — cả hai đều hoạt động.
- **Sub-Agent Execution:** Khi `/om:cook` chạy, phân tích dependency graph trong `.omni/sdlc/todo.md` và spawn parallel agents (worktree isolation) cho tasks độc lập. Xem chi tiết: `.omni/workflows/coder-execution.md`
- **Task Tracking:** Dùng TaskCreate/TaskUpdate để track progress khi thực thi tasks, thay vì chỉ dựa vào `.omni/sdlc/todo.md` checkboxes.
- **Safety:** KHÔNG thực thi destructive commands (rm -rf, git push --force, git reset --hard) mà không có permission user.
- **Workflow Files:** Tất cả logic nằm trong `.omni/workflows/`. Khi nhận lệnh `>om:*` hoặc `/om:*`, đọc file tương ứng rồi thực thi.
