# Coder Execution Workflow (Antigravity / agy Edition)

> `>om-cook` chạy TỰ ĐỘNG: làm từng task → tự kiểm thử → tự sửa, theo 3 quality cycle.
> KHÔNG dừng hỏi sau mỗi task (trừ lỗi nghiêm trọng). Đừng tách cook/check thành 2 bước thủ công.

## Phase 1: Research & Plan
1. Analyze `.omni/sdlc/todo.md` and identify the NEXT uncompleted task (`- [ ]`).
2. Read `.omni/sdlc/design-spec.md` for context; if `.omni/knowledge/project-map.md` exists, use it to locate files instead of scanning.
3. **MANDATORY SKILL FETCH:** If the task has `@skill:skill-name` tag(s), you MUST call your file reading tool (`view_file` or `read_file`) to open and inspect `.agents/skills/<skill-name>/SKILL.md` before writing any code. Do NOT code based on memory.
4. For independent, parallelizable subtasks, spawn **native subagents** via `/agents` (Agent Manager). Each subagent runs in its own isolated context/worktree to avoid context bloat.
5. Keep **orchestration depth = 1**: a subagent does the work and returns; it does not spawn further subagents. Merge results back at the main agent.
6. Use `ctrl+j` to teleport into a running subagent and `ctrl+k` to approve its proposed actions.

## Phase 2: Implementation (ONE task at a time)
1. State scope (files affected) then apply code changes surgically (smallest diff that satisfies the task). Scope-lock: no cleanup/refactor ngoài task.
2. For UI tasks, use the **integrated browser subagent** to capture a screenshot and compare against requirements; watch for visual regressions.
3. **Surgical Context:** for files > 200 lines, grep/search first, đọc ±20 dòng quanh target, không đọc cả file.
4. Review pending edits with `/diff` before accepting; use `/rewind` / `/undo` to back out a wrong step.
5. Mark task done: đổi `- [ ]` → `- [x]` trong `.omni/sdlc/todo.md`.

## Phase 3: Report & Auto-Continue (KHÔNG hỏi xác nhận)
After each task, report ngắn gọn:
```
✅ [Task] — Done | Files: [list] | Progress: [done]/[total] (Cycle [1|2|3]/3)
   Next: [task kế tiếp]
```
- **Auto-continue (mặc định):** task xong, không lỗi (hoặc lỗi vặt) → làm NGAY task `- [ ]` kế tiếp. KHÔNG dừng hỏi.
- **CHỈ dừng & hỏi khi:** build/compile fail chặn task sau · breaking change interface dùng chung (API/DB/types) · lỗ hổng bảo mật · task mơ hồ dễ đi sai hướng · xung đột dependency ảnh hưởng nhiều task.

## Phase 4: Quality Gate — Auto Check/Fix Cycle (BẮT BUỘC, tự động)
Dự án chạy đúng **3 quality cycle**. Mỗi cycle trigger sau khi xong 1/3 số task:
1. Lần đầu: đếm tổng task (`- [ ]` + `- [x]`) trong `.omni/sdlc/todo.md` → `checkpoint = ceil(total / 3)`.
2. Theo dõi `cycle` counter (1, 2, 3) xuyên suốt session.
3. Sau mỗi `checkpoint` task hoàn thành trong cycle hiện tại:
   ```
   🔄 Quality Gate — Cycle [N]/3 ([X]/[total] task done) → tự chạy >om-check...
   ```
   - Tự động thực thi workflow [>om-check] **inline** (không cần user gõ). Tận dụng `AfterTool` hook (auto `npm test` sau edit khi cài global) làm tín hiệu sớm, nhưng vẫn chạy đủ pipeline P0–P5.
   - Nếu >om-check có lỗi → tự động [>om-fix] → chạy lại [>om-check]. Tối đa 3 lần fix/cycle.
   - Quá 3 lần: đánh dấu task `[BLOCKED]` trong `.omni/sdlc/todo.md`, escalate cho user, rồi tiếp tục >om-cook batch sau (bỏ qua task blocked).
   - check pass → tiếp tục >om-cook batch kế.
4. Sau cycle 3 và check pass:
   ```
   ✅ Hoàn tất 3 quality cycle. [total] task done. Sẵn sàng >om-doc → >om-ship.
   ```

## Phase 5: Knowledge & Guardrails
1. Nếu fix một bug: document root cause + cách fix. **Knowledge Item (KI):** hỏi user lưu lại — "Tôi đã fix X bằng Y. Lưu thành KI cho agent sau?" KI tồn tại xuyên session.
2. Never run destructive commands (`rm -rf`, `git push --force`, `git reset --hard`) — bị policy engine chặn; surface cho user thay vì chạy.
3. Stage changes; never push/deploy/publish without explicit user approval.

## Rules
- Quality gate cycles là **bắt buộc** — KHÔNG bỏ qua dù mọi task trông có vẻ đúng.
- ONE task/lần; không gộp nhiều task trừ khi user yêu cầu.
- Task `[BLOCKED]` hoặc bị chặn (phụ thuộc thứ chưa build) → SKIP, ghi lý do, làm task khác.
- Task mơ hồ → HỎI trước khi code, không đoán.
