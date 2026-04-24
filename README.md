# Omni-Coder Kit

**Omni-Coder Kit** là công cụ CLI quản lý hệ tư tưởng (mindset + workflow + skills) cho các AI coding agent. Đảm bảo AI hoạt động với kỷ luật Senior Engineer, tuân thủ SDLC nghiêm ngặt và sử dụng mẫu thiết kế tối ưu.

## Tính năng chính

- **Đa IDE:** Claude Code, Codex CLI, Cursor, Windsurf, Antigravity, Cross-tool, Generic — mỗi IDE sinh file cấu hình riêng
- **Dual-Agent:** Tạo cả `CLAUDE.md` + `AGENTS.md` cùng lúc cho dự án dùng nhiều AI tool
- **Karpathy Mindset:** 4 nguyên tắc — Think Before Coding, Simplicity First, Surgical Changes, Goal-Driven Execution
- **Socratic Gate:** Bắt buộc AI hỏi tối thiểu 3 câu trước khi code — không có ngoại lệ
- **Phỏng vấn 6 dimensions:** Business Goal, User Persona, Functional, Non-Functional, Edge Cases, Tech Stack — kèm phỏng vấn thiết kế cho dự án có UI
- **IDE-Aware Skills:** `auto-equip` chỉ cài skill cho IDE/CLI đã chọn (không cài tất cả), dùng `--agent` flag của skills.sh
- **Skill-Tagged Tasks:** `>om:plan` gắn `@skill:name` cho từng task trong `todo.md`, `>om:cook` tự động load skill tương ứng khi thực thi
- **Automated Quality Pipeline:** 3 quality cycles bắt buộc — `cook → check → fix` loop tự động sau mỗi 1/3 tasks
- **Lazy Loading & Token Optimization:** Config file chỉ ~5KB (core rules + registry table), workflows lazy-loaded khi cần — tiết kiệm ~85% token so với inline
- **Anti-Hallucination (Paranoid Mode):** Grounding rules, self-verification checklist, no phantom imports/APIs
- **Antigravity Fallback:** Sinh `install-skills.sh` thay vì chạy trực tiếp (do Antigravity không hỗ trợ auto-approve)
- **Validation Pipeline:** Security → Lint → Build → Tests → Bundle analysis — blocking tự động
- **Tech Stacks:** React/Next.js, Hono/PostgreSQL, Automation Bot, Payment Gateway
- **Skills.sh:** Tích hợp skills.sh ecosystem — auto-equip theo tech stack, conflict detection, manifest tracking

---

## Cài đặt

Yêu cầu [Node.js](https://nodejs.org/) >= 16.0.0.

```bash
npm install -g omni-coder-kit
```

Cập nhật:

```bash
omni update
```

---

## Bắt đầu nhanh

```bash
# 1. Khởi tạo — chọn IDE, mức kỷ luật, tech stack
omni init

# 2. Xem kỹ năng có sẵn
omni list

# 3. Thêm tech stack cục bộ
omni add react-next

# 4. Cài skill từ skills.sh (chỉ cho IDE đã chọn)
omni equip vercel-labs/agent-skills

# 5. Auto-equip theo design-spec
omni auto-equip --design-spec design-spec.md

# 6. Xem trạng thái
omni status

# 7. Xem danh sách lệnh >om:
omni commands

# 8. Cập nhật lên phiên bản mới nhất
omni update
```

---

## Lệnh CLI

| Lệnh | Mô tả |
|-------|-------|
| `omni init` | Khởi tạo DNA và workflow cho dự án mới |
| `omni add <skill>` | Bơm thêm kỹ năng cục bộ (local stack) vào file cấu hình |
| `omni equip <source>` | Tải kỹ năng ngoài từ skills.sh (cài cho IDE đã chọn) |
| `omni auto-equip` | Tự động cài tất cả skills theo tech stack |
| `omni status` | Xem trạng thái kỹ năng đã cài (local + external) |
| `omni list` | Xem danh sách kỹ năng có sẵn trong kho |
| `omni commands` | Hiển thị danh sách lệnh `>om:` dùng trong chat AI |
| `omni update` | Kiểm tra và cập nhật lên phiên bản mới nhất |

### IDE hỗ trợ khi `omni init`

| Lựa chọn | File tạo ra | Gợi ý khởi động |
|-----------|------------|-----------------|
| Claude Code / OpenCode | `CLAUDE.md` | `claude --dangerously-skip-permissions` |
| Codex CLI (OpenAI) | `AGENTS.md` | `codex --full-auto` |
| Claude Code + Codex (dual) | `CLAUDE.md` + `AGENTS.md` | Cả 2 lệnh trên |
| Antigravity | `.antigravityrules` | Skills sinh ra dạng script `install-skills.sh` |
| Cursor | `.cursorrules` | Mở Cursor trong thư mục dự án |
| Windsurf | `.windsurfrules` | Mở Windsurf trong thư mục dự án |
| Cross-tool | `AGENTS.md` | Tool-agnostic |
| Generic | `SYSTEM_PROMPT.md` | — |

---

## Quy trình SDLC

Sau khi khởi tạo, gõ các lệnh `>om:` trong chat với AI:

| Lệnh | Agent | Mô tả |
|-------|-------|-------|
| `>om:brainstorm` | Architect | Phỏng vấn 2 vòng (6 dimensions + design), đề xuất tech stack, xuất `design-spec.md` |
| `>om:equip` | Skill Manager | Đề xuất & cài skills từ skills.sh theo stack (chỉ cho IDE đã chọn) |
| `>om:plan` | PM | Phân tích spec → micro-tasks trong `todo.md`, gắn `@skill:name` cho từng task |
| `>om:cook` | Coder | Thực thi từng task, load skill theo `@skill:` tag, auto-continue, quality gate mỗi 1/3 |
| `>om:check` | QA Tester | Validation pipeline (P0–P3 blocking) + feature verification → `test-report.md` |
| `>om:fix` | Debugger | Reproduce → root cause → surgical fix → verify. Không shotgun-fix |
| `>om:doc` | Writer | Đọc code thực tế → sinh README.md + API docs bằng tiếng Việt |

### Automated Quality Pipeline

Khi `>om:cook` chạy, hệ thống tự động chia dự án thành **3 quality cycles**:

```
om:cook (1/3 tasks)
  → om:check
    → [om:fix ↔ om:check loop, tối đa 3 lần]
  → om:cook (1/3 tasks)
    → om:check
      → [om:fix ↔ om:check loop]
    → om:cook (1/3 tasks)
      → om:check
        → [om:fix ↔ om:check loop]
      → om:doc
```

- **Checkpoint** = `ceil(total_tasks / 3)` — quality gate trigger tự động
- **Fix loop** tối đa 3 lần/cycle — nếu vẫn lỗi, escalate cho user
- **Auto-continue**: `>om:cook` tự động chạy task tiếp, chỉ dừng khi lỗi nghiêm trọng (build fail, breaking changes, security)

### Skill-Tagged Tasks

`>om:plan` tự động gắn `@skill:` tag cho mỗi task dựa trên skills đã cài:

```markdown
## 1. Database
- [ ] Tạo migration users table `@skill:supabase-postgres-best-practices`
- [ ] Seed data mẫu `@skill:supabase-postgres-best-practices`

## 2. Frontend
- [ ] Tạo trang login `@skill:vercel-react-best-practices` `@skill:tailwind-design-system`
- [ ] Thêm form validation `@skill:vercel-react-best-practices`
```

`>om:cook` đọc tag → load skill file tương ứng → áp dụng rules khi code.

---

## Validation Pipeline

Khi chạy `>om:check`, AI thực thi pipeline theo thứ tự:

| Priority | Check | Blocking? |
|----------|-------|-----------|
| P0 | **Security:** dependency audit, secrets leak, .env committed, eval/innerHTML, SQL injection | Yes |
| P1 | **Lint & Types:** ESLint/Biome, TypeScript, Python lint | Yes |
| P2 | **Build:** compile/bundle project | Yes |
| P3 | **Tests:** vitest/jest/pytest | Yes |
| P4 | **Bundle:** unused deps, bundle size | No (advisory) |

P0–P3 fail → dừng ngay, auto-trigger `>om:fix`, loop cho đến khi pass.

---

## Cấu trúc dự án

```
omni-coder-kit/                  # Package (npm)
├── bin/omni.js                  # CLI chính (9 commands)
├── templates/
│   ├── core/                    # Karpathy mindset + anti-hallucination (Paranoid)
│   ├── stacks/                  # Tech stack rules (react-next, hono-pg, ...)
│   └── workflows/               # SDLC workflows (10 files)
├── package.json
└── .omni-manifest.json          # Tracking: IDE, skills, config file
```

### Sau khi `omni init` — cấu trúc dự án người dùng

```
your-project/
├── CLAUDE.md (hoặc AGENTS.md, .cursorrules, ...)  # Config nhẹ (~5KB)
│   ├── Core rules (inline): Karpathy mindset + Anti-hallucination
│   ├── Command registry table: >om: → workflow file mapping
│   ├── IDE adapters
│   └── Personal rules
├── .omni/
│   └── workflows/               # Lazy-loaded bởi AI khi cần
│       ├── requirement-analysis.md   # >om:brainstorm
│       ├── skill-manager.md          # >om:equip
│       ├── task-planning.md          # >om:plan
│       ├── coder-execution.md        # >om:cook
│       ├── qa-testing.md             # >om:check
│       ├── debugger-workflow.md      # >om:fix
│       ├── documentation-writer.md   # >om:doc
│       └── ... (supporting files)
├── .omni-manifest.json          # Tracking: IDE, skills
└── .omni-rules.md               # Personal rules (nếu có)
```

**Token optimization:** Config file chỉ chứa core rules + bảng registry (~5KB thay vì ~36KB). AI chỉ đọc workflow file khi lệnh `>om:` tương ứng được gọi, tiết kiệm token đáng kể. Fallback: nếu `.omni/workflows/` không tồn tại → đọc từ `node_modules/omni-coder-kit/templates/workflows/`.

---

## Giấy phép

ISC — Phát triển bởi [TAV](mailto:tav99.dev@gmail.com).
