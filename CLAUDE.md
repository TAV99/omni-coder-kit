# CLAUDE.md — omni-coder-kit (dev conventions)

> File này dành cho Claude Code khi **phát triển chính omni-coder-kit** (không phải file omni sinh ra cho project người dùng). Đọc đầu mỗi phiên.

> **Branch `3.2.0` (omni squad), handoff 2026-11-02:** any agent developing omni-coder-kit reads [`docs/HANDOFF-P7.md`](docs/HANDOFF-P7.md) first (P1–P6 status, working rules, P7 plan). Write docs and comments in English; talk to the user in Vietnamese. Keep the visual roadmap [`docs/squad-roadmap.html`](docs/squad-roadmap.html) current: edit only its `STATE`/`PREP`/`PHASES` data block at each checkpoint.

## Bối cảnh dự án
- `omni-coder-kit` là CLI (Node.js, CommonJS) inject mindset + SDLC workflow + skills vào các AI coding agent, và điều phối **omni squad** 3.2.0 (`lib/squad/`, `lib/dual/`, `omni ui` trong `lib/ui/`). Harness SDLC cũ (`lib/harness/`, `omni run`) đã bị gỡ.
- Tài liệu định hướng nằm trong `docs/` (đọc trước khi code):
  - `HANDOFF-P7.md`, `SPEC-SQUAD-P*.md`, `SQUAD-ARCHITECTURE-PLAN.md` — trạng thái và spec squad (code 1-1 theo đây).
  - `ADOPT-FROM-ADDYOSMANI.md` — skill/feature kế thừa từ addyosmani/agent-skills.
  - `orchestration-patterns.md` — kim chỉ nam điều phối agent (đọc trước khi sửa phần điều phối trong `lib/dual/`).
  - `skill-anatomy.md` — chuẩn viết skill (mà `omni skills:doctor` thực thi).

## Đọc tài liệu thư viện ngoài — DÙNG Context7
- Với MỌI SDK/thư viện/framework bên ngoài (Claude Agent SDK, dependency mới...), **dùng MCP Context7** (`resolve-library-id` → `get-library-docs`) để lấy tài liệu **phiên bản hiện hành TRƯỚC khi viết code**. Không dựa vào trí nhớ huấn luyện.
- Nếu Context7 không có/thiếu → fallback `docs.claude.com` hoặc trang chính thức qua web.
- Đặc biệt bắt buộc cho Pha 2 §2c (`providers/claude-sdk.js`).

## Quy tắc làm việc (iron rules)
1. **Bám spec.** Code đúng interface đã định trong `docs/SPEC-SQUAD-*.md`; tái dùng hàm Pha trước, đừng đổi tên.
2. **`npm test` phải xanh trước khi commit.** Mọi module mới kèm test `node:test`. Giữ toàn bộ test cũ xanh.
3. **KHÔNG tự push/deploy.** Được commit local; tuyệt đối không `git push`, `git reset --hard`, `rm -rf`. (Khớp iron law của repo.)
4. **Commit nhỏ, theo Conventional Commits** (subject tiếng Anh `feat(scope):`, body có thể tiếng Việt). Commit theo sub-phase như Pha 1 (1a/1b).
5. **Surgical changes.** Sửa tối thiểu, không refactor ngoài phạm vi task.
6. **Artifact là hand-off, không paraphrase** (orchestration-patterns anti-pattern C); giữ pause-point cho user; độ sâu điều phối = 1.

## Lệnh hữu ích
- `npm test` — chạy toàn bộ test (`node --test`).
- `node bin/omni.js skills:doctor` — kiểm nguồn skill sống/chết + validate skill đã cài.
- `node bin/omni.js squad pipeline` — xem pipeline squad đang dùng.
- `node bin/omni.js ui` — trang web local theo dõi squad.
