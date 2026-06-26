# CLAUDE.md — omni-coder-kit (dev conventions)

> File này dành cho Claude Code khi **phát triển chính omni-coder-kit** (không phải file omni sinh ra cho project người dùng). Đọc đầu mỗi phiên.

## Bối cảnh dự án
- `omni-coder-kit` là CLI (Node.js, CommonJS) inject mindset + SDLC workflow + skills vào các AI coding agent, và đang được nâng cấp thành **agent harness** (`lib/harness/`).
- Tài liệu định hướng nằm trong `docs/` (đọc trước khi code):
  - `HARNESS-UPGRADE-PLAN.md` — lộ trình harness 3 pha + kiến trúc.
  - `HARNESS-SPEC-PHASE-1.md`, `HARNESS-SPEC-PHASE-2.md` — spec triển khai chi tiết (code 1-1 theo đây).
  - `ADOPT-FROM-ADDYOSMANI.md` — skill/feature kế thừa từ addyosmani/agent-skills.
  - `orchestration-patterns.md` — kim chỉ nam điều phối agent (đọc trước khi sửa `lib/harness/loop.js`).
  - `skill-anatomy.md` — chuẩn viết skill (mà `omni skills:doctor` thực thi).

## Đọc tài liệu thư viện ngoài — DÙNG Context7
- Với MỌI SDK/thư viện/framework bên ngoài (Claude Agent SDK, dependency mới...), **dùng MCP Context7** (`resolve-library-id` → `get-library-docs`) để lấy tài liệu **phiên bản hiện hành TRƯỚC khi viết code**. Không dựa vào trí nhớ huấn luyện.
- Nếu Context7 không có/thiếu → fallback `docs.claude.com` hoặc trang chính thức qua web.
- Đặc biệt bắt buộc cho Pha 2 §2c (`providers/claude-sdk.js`).

## Quy tắc làm việc (iron rules)
1. **Bám spec.** Code đúng interface đã định trong `docs/HARNESS-SPEC-*.md`; tái dùng hàm Pha trước, đừng đổi tên.
2. **`npm test` phải xanh trước khi commit.** Mọi module mới kèm test `node:test`. Giữ toàn bộ test cũ xanh.
3. **KHÔNG tự push/deploy.** Được commit local; tuyệt đối không `git push`, `git reset --hard`, `rm -rf`. (Khớp iron law của repo + deny-list `tools/shell.js`.)
4. **Commit nhỏ, theo Conventional Commits** (subject tiếng Anh `feat(scope):`, body có thể tiếng Việt). Commit theo sub-phase như Pha 1 (1a/1b).
5. **Surgical changes.** Sửa tối thiểu, không refactor ngoài phạm vi task.
6. **Artifact là hand-off, không paraphrase** (orchestration-patterns anti-pattern C); giữ pause-point cho user; độ sâu điều phối = 1.

## Lệnh hữu ích
- `npm test` — chạy toàn bộ test (`node --test`).
- `node bin/omni.js skills:doctor` — kiểm nguồn skill sống/chết + validate skill đã cài.
- `node bin/omni.js run --dry-run` — in kế hoạch SDLC của harness.
- `node bin/omni.js gate` / `omni trace` — chạy quality gate / xem event log.
