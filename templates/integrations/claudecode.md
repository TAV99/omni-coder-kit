### Claude Code Integration
- **Native Commands:** Dùng `/om-think`, `/om-cook`, ... (auto-complete) hoặc gõ `>om-think`, `>om-cook` trong chat — cả hai đều hoạt động.
- **Sub-Agent Execution:** Khi `/om-cook` chạy, phân tích dependency graph trong `.omni/sdlc/todo.md` và spawn parallel agents (worktree isolation) cho tasks độc lập. Xem chi tiết: `.omni/workflows/coder-execution.md`
- **Agent Teams (experimental):** For complex features needing cross-layer coordination, use Agent Teams (`TeamCreate`) to spawn specialist teammates that communicate via shared task list. Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
- **Task Tracking:** Dùng TaskCreate/TaskUpdate để track progress khi thực thi tasks, thay vì chỉ dựa vào `.omni/sdlc/todo.md` checkboxes.
- **Model Recommendations:** Opus 4.7 for architecture/review, Sonnet 4.6 for daily coding (default), Haiku 4.5 for mechanical edits. Use `model:` parameter in sub-agent prompts to optimize cost.
- **Memory Partitioning:** Claude Code auto-memories (Dreaming) are separate from `.omni/` project state. Do not store workflow data in Claude memories — use `.omni/knowledge/` for lessons, `.omni/sdlc/` for task state.
- **Safety:** KHÔNG thực thi destructive commands (rm -rf, git push --force, git reset --hard) mà không có permission user.
- **Workflow Files:** Tất cả logic nằm trong `.omni/workflows/`. Khi nhận lệnh `>om-*` hoặc `/om-*`, đọc file tương ứng rồi thực thi.
