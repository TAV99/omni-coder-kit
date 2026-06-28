# Omni-Coder Kit

**Omni-Coder Kit** là một bộ công cụ CLI mạnh mẽ giúp inject mindset phát triển phần mềm chuẩn mực (Karpathy Mindset), SDLC workflows và skills vào các AI coding agent. Công cụ này định hướng AI hoạt động với kỷ luật của một Senior Engineer, tuân thủ quy trình SDLC nghiêm ngặt và hạn chế tối đa lỗi ảo tưởng (hallucination).

Trong phiên bản mới nhất, Omni-Coder Kit đã nâng cấp từ một bộ công cụ sinh template (scaffolding) thành một **Agent Harness + Loop Runtime** hoàn chỉnh — một môi trường tự chạy vòng lặp SDLC: gọi LLM → thực thi các quality gate (lint, build, test, security) → tự động sửa lỗi (fix loop) → tự động tiếp tục hoặc báo cáo trạng thái dừng.

---

## 🚀 Hai chế độ hoạt động chính

Omni-Coder Kit hỗ trợ linh hoạt cả hai cách tiếp cận:

1. **Assisted Mode (Thủ công - Tương tác chat):** Người dùng trực tiếp gõ các lệnh `>om:` (hoặc `/om:` trên Claude Code) trong khung chat của AI IDE. AI tự đọc hướng dẫn từ `.omni/workflows/` để tuân thủ quy trình thiết kế, lập kế hoạch và lập trình.
2. **Harness Mode (Tự động - CLI Auto-run):** Sử dụng lệnh `omni run`. Bộ điều phối (Orchestrator) của Omni sẽ trực tiếp lái vòng đời SDLC thông qua các Provider Adapter (chạy headless CLI của IDE hoặc gọi trực tiếp API qua SDK), tự động chạy test/lint thật để kiểm tra chất lượng và kích hoạt vòng lặp tự sửa lỗi (fix loop) mà không cần người dùng can thiệp thủ công.

---

## ✨ Tính năng nổi bật

### 1. Agent Harness & Runtime Loop (Mới)
- **State Machine SDLC:** Quản lý vòng đời chặt chẽ qua các trạng thái: `INIT` → `BRAINSTORM` → `EQUIP` → `PLAN` → `COOK` ⇄ `CHECK` ⇄ `FIX` → `DOC` → `SHIP` → `DONE`. Trạng thái lưu tại `.omni/run/state.json` giúp dễ dàng phục hồi bằng `--resume`.
- **Provider Adapters:** Hỗ trợ điều khiển headless qua `host-cli` (gọi các CLI sẵn có như `claude`, `gemini`, `codex`, `agy` ở chế độ headless) hoặc gọi API trực tiếp qua `claude-sdk`.
- **Adversarial Cross-Provider Debate:** Cho phép cấu hình ≥2 mô hình từ các nhà cung cấp khác nhau (ví dụ: Claude và Gemini) tranh luận đối kháng chéo để phản biện chất lượng code/thiết kế ở bước `CHECK`, xuất báo cáo tranh luận tại `.omni/run/debate-[timestamp].md`.
- **Budget & Safety Guardrails:** Giới hạn cứng số lần transition, chi phí token (USD), và tự động khóa các lệnh shell nguy hiểm.

### 2. Programmatic Quality Gates (Mới)
- Chuyển hóa các bước kiểm định từ "chỉ dẫn bằng văn bản" thành code chạy thực tế. Lệnh `omni gate` hoặc bước `CHECK` trong harness sẽ quét qua 6 mức chất lượng:
  - **P0 - Security:** Quét rò rỉ secrets, kiểm tra dependencies, cấm hàm nguy hiểm (eval/innerHTML), chống SQL injection.
  - **P1 - Lint & Types:** Chạy linter (ESLint/Biome) và kiểm tra kiểu dữ liệu (TypeScript/Python/Rust typecheck).
  - **P2 - Build:** Biên dịch toàn bộ dự án.
  - **P3 - Tests:** Chạy test suite thật (Jest/Vitest/pytest/cargo test).
  - **P4 - Bundle:** Phân tích dung lượng bundle và dependencies thừa (Advisory).
  - **P5 - Content:** Đối chiếu nhãn giao diện thực tế với ground-truth trong `.omni/sdlc/content-source.md` (HIGH severity vi phạm sẽ chặn đứng pipeline).

### 3. Tối ưu hóa cho các IDE / AI CLI hàng đầu
- **Antigravity CLI (Mới):** Đóng gói thành cấu trúc plugin chuẩn (`gemini-extension.json`), cấu hình chính sách quyền TOML (`policy.template.toml`), hooks tự động chạy linter/tests sau khi sửa file (`hooks.json`), MCP config tự động dựa trên DNA, và native skills dưới dạng thư mục `.agents/skills/`.
- **Claude Code:** Tự động cài slash commands `/om:*` native, tối ưu hóa permissions `.claude/settings.json`, thiết lập hooks pre/post-tool, và hỗ trợ điều phối sub-agent song song với Shared Context Brief giúp tiết kiệm token.
- **Cursor & Windsurf:** MDC rules chuyên sâu hoạt động dựa trên file globs (frontend, backend, testing), YOLO guardrails tự động hỏi trước khi chạy lệnh phá hoại, cấu hình MCP động (`.cursor/mcp.json`).
- **Codex CLI & Gemini CLI:** Tự động cài đặt profiles, hooks kiểm định và tối ưu hóa file workflow cấu hình.

### 4. Codebase Intelligence & SDLC Scaffolding
- **Project DNA Detection:** AI tự động phát hiện đặc điểm dự án (`hasUI`, `hasBackend`, `hasAPI`, `backendComplexity`) từ mô tả ban đầu để tự điều chỉnh quy trình và nhóm kỹ năng phù hợp.
- **Project Map (`omni map`):** Quét cấu trúc dự án cực nhanh (0 token), sinh skeleton map. AI điền mô tả semantic và CLI hỗ trợ `--refresh` tự động phát hiện file thêm/bớt mà không làm mất mô tả cũ.
- **Legacy Project Onboarding (`omni onboard`):** Quét sâu dự án cũ để nhận diện tech stack, coding conventions, landmines kỹ thuật, giúp AI nhanh chóng làm quen và reverse-engineer ra thiết kế (`design-spec.md`) + danh sách việc cần làm (`todo.md`).
- **Knowledge Base (`>om:learn`):** Tự động ghi nhận bài học kinh nghiệm sau mỗi lần sửa lỗi thành công vào `.omni/knowledge/knowledge-base.md` để tái sử dụng ở các task sau.

---

## 📦 Cài đặt

Yêu cầu [Node.js](https://nodejs.org/) >= 16.0.0.

Cài đặt toàn cục (global):
```bash
npm install -g omni-coder-kit
```

Cập nhật lên phiên bản mới nhất:
```bash
omni update
```

---

## 🏁 Hướng dẫn bắt đầu nhanh

### Cách 1: Chạy tự động với Agent Harness (Khuyên dùng)
Chế độ này chạy hoàn toàn trên terminal của bạn, Omni CLI sẽ tự kích hoạt AI và kiểm tra chất lượng.

```bash
# 1. Đi tới thư mục dự án của bạn (mới hoặc đã có sẵn code)
cd my-project

# 2. Khởi tạo Omni-Coder Kit (chọn IDE của bạn)
omni init

# 3. Quét dự án hiện có (nếu dự án đã có code sẵn)
omni onboard

# 4. Cài đặt các kỹ năng lập trình cơ bản
omni auto-equip

# 5. Chạy Harness Loop tự động để brainstorm ý tưởng & lập kế hoạch
omni run --from brainstorm

# 6. Viết mã nguồn tự động
# Harness sẽ chạy: COOK (viết code) -> CHECK (quét lỗi) -> FIX (sửa lỗi nếu có)
omni run --from cook
```

### Cách 2: Chạy thủ công trong Chat AI (Assisted Mode)
Sau khi chạy `omni init` và `omni auto-equip`, mở khung chat của AI IDE của bạn và gõ các lệnh `>om:*` (hoặc `/om:*` trên Claude Code):

```text
Bạn: >om:brainstorm Xây dựng ứng dụng Todo-List bằng React
AI: [Phỏng vấn làm rõ yêu cầu, xác định DNA dự án và xuất thiết kế spec]

Bạn: >om:plan
AI: [Phân rã kế hoạch thành các task nhỏ trong .omni/sdlc/todo.md]

Bạn: >om:cook
AI: [Từng bước thực thi code, tự động kiểm tra chất lượng qua >om:check]
```

---

## 🛠️ Danh sách lệnh CLI

| Lệnh | Mô tả | Các Option nổi bật |
|:---|:---|:---|
| `omni init` | Khởi tạo DNA, cấu hình IDE và sinh thư mục `.omni/` | `--dry-run` |
| `omni onboard` | Quét sâu một dự án cũ có sẵn và xuất báo cáo cho AI | `--refresh`, `--skip-init` |
| `omni map` | Quét codebase và tạo skeleton Project Map | `--refresh` |
| `omni equip <src>` | Cài đặt skill từ nguồn ngoài (URL, GitHub repo) | `-n, --name`, `-f, --force` |
| `omni auto-equip` | Cài đặt các universal skills mặc định | `-y, --yes` |
| `omni rules [act]` | Quản lý quy tắc cá nhân (rules) của lập trình viên | `view`, `edit`, `sync`, `reset` |
| `omni status` | Xem trạng thái tích hợp IDE và danh sách skills đã cài | (Không có) |
| `omni commands` | Hiển thị danh sách các lệnh `>om:` dùng trong chat | (Không có) |
| `omni customize <wf>`| Copy workflow hệ thống ra `.omni/workflows/` để tuỳ biến | (Không có) |
| `omni skills:doctor` | Kiểm tra sức khoẻ registry skill và validate local skill | `--offline` |
| `omni run` | **[Harness]** Chạy tự động chu trình SDLC cook → check → fix | `--dry-run`, `--resume`, `--provider host-cli\|claude-sdk`, `--from <state>`, `--debate <specs>`, `--max-iterations <n>` |
| `omni trace` | **[Harness]** In nhật ký event log của lần chạy harness gần nhất | `--limit <n>` |
| `omni gate` | **[Harness]** Chạy độc lập Quality Pipeline P0-P5 (CI-friendly) | `--only <ids>` |
| `omni stats` | **[Harness]** Tổng hợp token, chi phí, thời gian chạy từ event log | (Không có) |
| `omni update` | Kiểm tra và cập nhật CLI lên phiên bản mới nhất | (Không có) |

---

## 📋 Bảng lệnh SDLC trong Chat (`>om:`)

Khi bạn đang ở trong môi trường chat của IDE, hãy dùng các lệnh sau để lái AI:

| Lệnh | Vai trò | Mô tả sản phẩm đầu ra |
|:---|:---|:---|
| `>om:brainstorm` | Architect | Phỏng vấn Socratic + Detect DNA → sinh `.omni/sdlc/design-spec.md` & `.omni/sdlc/content-source.md` |
| `>om:onboard` | Architect | Đọc onboard report, phỏng vấn lập trình viên → sinh rules, IDE skill file và todo cải tiến |
| `>om:equip` | Skill Mgr | Tự động quét và cài đặt các skill phù hợp nhất với stack thông qua `find-skills` |
| `>om:plan` | PM | Phân tích spec → lập to-do list chi tiết trong `.omni/sdlc/todo.md`, sắp xếp thứ tự ưu tiên backend-first |
| `>om:cook` | Coder | Code từng task, preflight dev server, tuân thủ nguyên tắc surgical context, tự chạy check mỗi 1/3 chặng |
| `>om:check` | QA Tester | Thực thi pipeline chất lượng P0-P5, tạo báo cáo `.omni/sdlc/test-report.md` |
| `>om:fix` | Debugger | Định vị lỗi, viết test tái hiện lỗi, sửa lỗi khoanh vùng, tránh shotgun-debugging |
| `>om:map` | Architect | Đọc hiểu cấu trúc dự án và viết mô tả semantic cho các thư mục chính trong Project Map |
| `>om:learn` | Knowledge | Tự động đúc kết bài học sau mỗi lần fix thành công vào `.omni/knowledge/knowledge-base.md` |
| `>om:doc` | Writer | Tổng hợp mã nguồn thực tế và sinh/cập nhật README.md, API docs |
| `>om:ship` | Release Eng| Soát lỗi đóng gói, lập kế hoạch rollback, chuẩn bị release note (không tự động push/deploy) |

---

## ⚡ IDE Overlays nâng cao

### Claude Code Overlay
Khi cấu hình **Claude Code**, Omni sẽ thiết lập:
- Slash commands `/om:brainstorm`, `/om:cook`,... chạy trực tiếp.
- `.claude/settings.json` cấu hình quyền tự động cho lệnh an toàn, chặn lệnh nguy hiểm (`rm -rf`, `git push --force`).
- **Parallel Sub-Agents:** Hỗ trợ phân rã task độc lập và điều phối sub-agents chạy song song trên các Git Worktree tách biệt, truyền Shared Context Brief để tối ưu hóa context window.

### Antigravity CLI Overlay (`agy`)
Tận dụng toàn bộ các nâng cấp mới nhất của Antigravity CLI:
- **Plugin Manifest (`gemini-extension.json`):** Tự động khai báo Omni-Coder Kit như một phần mở rộng chính thức cho `agy`.
- **Native Skills:** Triển khai các lệnh `om:*` dưới dạng native skills tại `.agents/skills/[tên-lệnh]/SKILL.md` cho phép gõ trực tiếp `/om-cook`, `/om-plan` trong chat.
- **TOML Policy (`policy.template.toml`):** Định nghĩa chi tiết mức độ tin cậy đối với từng loại công cụ hệ thống (chặn lệnh phá hoại, hỏi trước lệnh thay đổi trạng thái, cho phép lệnh kiểm thử).
- **Auto Hooks (`hooks.json`):** Đăng ký tự động kiểm thử (`PostToolUse`) sau khi sửa file hoặc chuẩn bị môi trường trước khi lập trình.
- **Gemini Model Optimization:** Hướng dẫn AI tự động chuyển đổi giữa Gemini Pro (cho thiết kế, phân tích lỗi phức tạp) và Gemini Flash (cho việc coding nhanh, quét mã nguồn).

### Cursor & Windsurf Overlay
- Cursor rules modular sử dụng định dạng file `.cursorrules` phối hợp với các tệp `.cursor/rules/*.mdc` kích hoạt theo file glob (ví dụ: chỉ load `backend.mdc` khi sửa file dưới thư mục `server/`).
- Windsurf rules tích hợp sâu với Cascade Mode, phân cấp quy tắc YOLO và tối ưu hóa chu trình kiểm định liên tục.

---

## 📂 Cấu trúc thư mục dự án người dùng

Sau khi bạn chạy `omni init`, thư mục dự án sẽ có cấu trúc như sau:

```
your-project/
├── CLAUDE.md (hoặc GEMINI.md, AGENTS.md, .cursorrules, .windsurfrules...) # Config core nhẹ (~5KB)
├── .omni/
│   ├── manifest.json               # Theo dõi IDE đã cấu hình & skills đã cài
│   ├── rules.md                    # Quy tắc cá nhân hóa của lập trình viên
│   ├── onboard-report.json         # Báo cáo quét dự án cũ (từ omni onboard)
│   ├── run/                        # [Harness] Lưu trữ log hoạt động tự động
│   │   ├── state.json              # State hiện tại của harness
│   │   ├── events.ndjson           # Lịch sử các bước chạy (transition, gate, provider)
│   │   └── debate-[timestamp].md   # Transcripts các phiên tranh luận đối kháng (nếu bật debate)
│   ├── workflows/                  # Lazy-loaded workflows nạp vào AI khi gọi >om:
│   │   ├── requirement-analysis.md
│   │   ├── task-planning.md
│   │   ├── coder-execution.md
│   │   ├── qa-testing.md
│   │   └── ...
│   ├── sdlc/                       # Sản phẩm đầu ra của các bước SDLC
│   │   ├── design-spec.md          # Đặc tả thiết kế hệ thống
│   │   ├── content-source.md       # Ground-truth nội dung UI
│   │   ├── todo.md                 # Danh sách tasks lập trình
│   │   └── test-report.md          # Kết quả chạy quality pipeline
│   └── knowledge/                  # Cơ sở tri thức dự án
│       ├── project-map.md          # Bản đồ cấu trúc codebase
│       └── knowledge-base.md       # Bài học đúc kết từ quá trình sửa lỗi
```

---

## 💖 Nguồn cảm hứng

Dự án được phát triển và tối ưu dựa trên ý tưởng từ:
- [antigravity-kit](https://github.com/vudovn/antigravity-kit)
- [karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills)
- Claudekit

---

## 📄 Giấy phép

Mã nguồn được phân phối dưới giấy phép **ISC**. Được phát triển và duy trì bởi [TAV](mailto:tav99.dev@gmail.com).
