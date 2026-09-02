# Omni-Coder Kit

[![Version](https://img.shields.io/badge/version-3.1.1-blue.svg)](https://github.com/TAV99/omni-coder-kit/releases/tag/v3.1.1)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![V4 Next-Gen Harness](https://img.shields.io/badge/Next--Gen-Omni%20v4%20Harness-purple.svg)](./README_V4.md)

**Omni-Coder Kit** là một bộ công cụ CLI giúp inject tư duy phát triển phần mềm chuẩn mực (**Karpathy Mindset**), quy trình SDLC tinh gọn và các kỹ năng chuyên sâu vào AI coding agents (Claude Code, Antigravity CLI, Cursor, Windsurf, Codex, Gemini CLI...). Công cụ này định hướng AI hoạt động với kỷ luật của một Senior Engineer, tuân thủ quy trình SDLC nghiêm ngặt và hạn chế tối đa lỗi ảo tưởng (hallucination).

Trong phiên bản mới nhất (**v3.1.1**), Omni-Coder Kit hoạt động như một **Agent Harness & Loop Runtime** — tự lái vòng lặp SDLC: gọi LLM → thực thi quality gates (lint, build, test, security) → tự động sửa lỗi (fix loop) → tự động nghiệm thu (acceptance loop).

> 📌 **Tài liệu phiên bản:**
> - [**README_V3.md**](./README_V3.md): Hướng dẫn chi tiết cho Omni v3.x (Workflows, CLI, Dual Authority Daemon).
> - [**README_V4.md**](./README_V4.md): Kiến trúc Reliability Kernel thế hệ mới v4.0 (TypeScript, Deterministic State Machine, DAG Quality Gates, Multi-Agent Adapters).

---

## 📦 Cài đặt & Khởi tạo nhanh

Yêu cầu [Node.js](https://nodejs.org/) >= 20.0.0.

1. **Cài đặt toàn cục (global):**
   ```bash
   npm install -g omni-coder-kit
   ```

2. **Khởi tạo trong dự án của bạn:**
   ```bash
   cd my-project
   omni init
   ```
   *(Hệ thống sẽ tự động nhận diện DNA dự án như ngôn ngữ, UI/Backend và thiết lập cấu hình tích hợp tương ứng cho các IDE/Agent trong máy bạn)*

   Trong `omni init` bạn sẽ được hỏi **ẩn hay hiện** các file agent rules (`AGENTS.md`, `CLAUDE.md`, IDE dirs…) trên git:
   - **Hiện (mặc định khuyến nghị):** commit được — share rules giữa máy/team.
   - **Ẩn:** thêm block vào `.gitignore` — repo “sạch” dấu vết AI tooling. **Đánh đổi:** clone máy khác sẽ không có rules → cần `omni init` lại (và cấu hình rules lại).

   Đổi sau init bằng CLI:
   ```bash
   omni agent-files status   # visible | hidden
   omni agent-files hide     # ẩn qua .gitignore + cảnh báo trade-off
   omni agent-files show     # gỡ block ẩn (không xoá file local)
   ```

---

## 🚀 Ba cách sử dụng chính

Omni-Coder Kit hỗ trợ 3 cách tiếp cận linh hoạt tùy theo thói quen lập trình của bạn:

### Cách 1: Chế độ tương tác trong Chat (`>om-*`) — Dành cho AI IDE
Sử dụng trực tiếp trong khung chat của các AI IDE (Cursor, Windsurf, Claude Code, Antigravity, Gemini CLI) bằng các câu lệnh siêu ngắn với tiền tố `>om-` (hoặc `/om-` trên Claude Code / Antigravity).

AI sẽ tự động đọc hướng dẫn trong thư mục `.omni/workflows/` hoặc `.agents/workflows/` để tuân thủ quy trình thiết kế, lập kế hoạch, code và test.

#### 1. Lập trình tự động trọn gói (One-shot)
Gõ lệnh này trong chat để AI tự đi qua toàn bộ quy trình SDLC (Think → Skill → Plan → Cook → Check → Doc) chỉ với một yêu cầu:
```text
>om-go Xây dựng trang Landing Page giới thiệu dịch vụ bằng HTML/CSS sạch
```

#### 2. Lập trình từng bước (Tự kiểm soát)
Nếu bạn muốn tự kiểm soát từng giai đoạn, hãy chat với AI theo trình tự:
*   **Tư vấn & Thiết kế:** `>om-think Xây dựng tính năng đăng nhập` (AI phỏng vấn & xuất `design-spec.md`)
*   **Cài kỹ năng:** `>om-skill` (AI tự tìm và cài skill phù hợp cho stack)
*   **Lập kế hoạch:** `>om-plan` (AI phân tách task chi tiết trong `todo.md`)
*   **Lập trình:** `>om-cook` (AI viết code surgical & tự động chạy 3 Quality Cycles)
*   **Kiểm định QA:** `>om-check` (AI tự chạy linter, build, và test P0-P5)
*   **Sửa lỗi:** `>om-fix` (AI phân tích nguyên nhân & sửa lỗi khoanh vùng)
*   **Nghiệm thu:** `>om-pass` (AI chấm sản phẩm vs checklist yêu cầu)
*   **Tài liệu:** `>om-doc` (AI cập nhật README, API docs bằng tiếng Việt)
*   **Đóng gói Release:** `>om-ship` (AI làm sạch code, tạo changelog & version)

---

### Cách 2: Chế độ tự động hoàn toàn (`omni run`) — Dành cho Terminal
Không cần mở khung chat IDE, bạn chỉ cần ra lệnh trên terminal của mình. Bộ điều phối (Orchestrator Harness) của Omni sẽ tự khởi chạy tác vụ và "lái" agent thực hiện từ đầu đến cuối một cách tự động.

#### 1. Chạy tự động từ file đặc tả (Spec) của khách hàng
Nếu bạn có một file mô tả yêu cầu (`spec.md`), hãy để Omni tự đọc, tự phân tích thành checklist nghiệm thu (`requirements.md`), tự viết code, tự chạy test và sửa lỗi cho đến khi đạt 100% yêu cầu:
```bash
omni run --spec spec.md
```

#### 2. Các lệnh điều khiển hữu ích trên Terminal:
*   **Chạy tiếp tục:** `omni run --resume` (Nếu phiên chạy bị tạm dừng hoặc lỗi, chạy lệnh này để tiếp tục từ vị trí cũ mà không tốn lại token từ đầu).
*   **Chạy nháp không sửa code:** `omni run --dry-run` (In ra kế hoạch hành động chi tiết để bạn kiểm tra trước).
*   **Chạy kiểm định chất lượng độc lập:** `omni run gate` (Chạy toàn bộ pipeline kiểm thử P0-P5: Security → Lint → Build → Test → Content).
*   **Xem nhật ký sự kiện:** `omni run log` (In event log chi tiết từ `.omni/run/events.ndjson`).
*   **Xem thống kê tài nguyên:** `omni run stats` (Tổng hợp token, chi phí và thời gian thực thi).

---

### Cách 3: Dual AUTO Authority Daemon — Codex + Gemini qua Agy

Ở chế độ này, **Codex** giữ vai trò Architect, Router và Final QC; **Gemini 3.7 Flash High** qua `agy` đảm nhiệm các phần việc worker đủ điều kiện. Authority daemon giữ session, ownership, lease và quality gates bằng ledger hash-chain; Gemini không thể tự xác nhận hoàn thành.

#### 1. Khởi tạo và dùng hằng ngày

```bash
omni init
# Chọn: Dual -> Codex + Gemini via agy -> AUTO
```

Sau đó, trong Codex chỉ cần gọi `$om-think` (hoặc `>om-think`). Khi interview/spec hoàn tất, workflow tạo `setup.json`, `todo.md` và full graph `dual-plan.json`, rồi gọi controller `omni dual bootstrap --json`. Controller chạy setup trước, sau đó mới tạo authority, đăng ký graph thật một lần, route task, gọi AGY khi phù hợp và trả về Codex QC.

#### 2. Lifecycle và recovery

```bash
omni dual daemon start     # Khởi động daemon
omni dual daemon status    # Kiểm tra trạng thái daemon & lease
omni dual daemon stop      # Dừng daemon an toàn
omni dual bootstrap --json # Bootstrap session từ kế hoạch
```

---

## 🛠️ Tra cứu nhanh danh sách lệnh

### 1. Lệnh trong khung Chat (`>om-*` / `/om-*`)
Khi chat với AI trong IDE, hãy gõ các lệnh sau ở đầu câu để định hướng hành vi của AI:

| Lệnh | Slash | Vai trò | Output / Hành động của AI |
| :--- | :--- | :--- | :--- |
| `>om-go` | `/om-go` | All-in-one | Tự đi qua toàn bộ quy trình SDLC để hoàn thành yêu cầu trọn gói. |
| `>om-think` | `/om-think` | Kiến trúc sư | Khảo sát yêu cầu, phỏng vấn DNA, xuất đặc tả thiết kế (`design-spec.md`). |
| `>om-scan` | `/om-scan` | Kiến trúc sư | Onboard dự án cũ — scan codebase, phỏng vấn, sinh rules + skills. |
| `>om-spec` | `/om-spec` | Nghiệm thu | Đọc spec/Q&A khách hàng → sinh checklist nguyên tử (`requirements.md`). |
| `>om-plan` | `/om-plan` | Quản lý dự án | Phân tách thiết kế thành micro-tasks trong (`todo.md`). |
| `>om-cook` | `/om-cook` | Lập trình viên | Viết code chuẩn xác (surgical), tự động chạy 3 Quality Cycles (cook-check-fix). |
| `>om-check` | `/om-check` | Kỹ sư QA | Chạy kiểm thử P0-P5: security → lint → build → test → xuất (`test-report.md`). |
| `>om-fix` | `/om-fix` | Kỹ sư Debug | Phân tích root cause từ test-report và sửa lỗi khoanh vùng. |
| `>om-pass` | `/om-pass` | Nghiệm thu | Chấm sản phẩm thực tế vs 100% checklist yêu cầu khách hàng (`conformance.md`). |
| `>om-doc` | `/om-doc` | Viết tài liệu | Cập nhật tài liệu kỹ thuật, API docs và README bằng tiếng Việt. |
| `>om-ship` | `/om-ship` | Release Eng | Version + changelog, CI gate, rollout & rollback plan (`ship-report.md`). |
| `>om-memo` | `/om-memo` | Học máy | Lưu lại bài học kinh nghiệm sửa lỗi vào `knowledge-base.md`. |
| `>om-skill` | `/om-skill` | Skill Mgr | Cài đặt universal skills + tìm kiếm & đề xuất skills từ skills.sh. |
| `>om-map` | `/om-map` | Kiến trúc sư | Quét codebase → tạo bản đồ cấu trúc dự án (`project-map.md`). |

---

### 2. Lệnh trong CLI Terminal (`omni <nhóm>`)

| Nhóm lệnh | Mô tả | Option / Subcommand hữu ích |
| :--- | :--- | :--- |
| `omni init` | Khởi tạo DNA dự án và cấu hình IDE thích hợp. | `--onboard`, `--dry-run`; hỏi ẩn/hiện agent files; chọn Dual mode |
| `omni dual` | Điều phối Codex + Gemini qua agy (cross-platform). | `daemon`, `bootstrap`, `setup`, `baseline`, `status` |
| `omni run` | Khởi chạy vòng lặp SDLC tự động từ terminal. | `--spec <file>`, `--resume`, `--dry-run`, `--yolo` |
| `omni run gate` | Chạy độc lập Quality Pipeline P0-P5 (tiện cho CI/CD). | `--only <P0,P1,P3>` |
| `omni run log` | Xem nhật ký sự kiện thực thi của phiên chạy gần nhất. | `--limit <n>`, `--follow` |
| `omni run stats` | Tổng hợp token, chi phí và thời gian từ event log. | *(không)* |
| `omni run accept` | Chạy riêng state ACCEPTANCE trên build hiện tại (CI). | `--accept <specs>`, `--yolo`, `--quiet` |
| `omni skills` | Quản lý các bộ skill lập trình (cài đặt/kiểm tra). | `add <nguồn>`, `doctor` |
| `omni map` | Tạo hoặc cập nhật sơ đồ tóm tắt mã nguồn dự án. | `--refresh` |
| `omni rules` | Quản lý quy tắc cá nhân (Personal Rules sync). | `[action]`, `--dry-run` |
| `omni agent-files` | Ẩn/hiện file agent khỏi git qua `.gitignore`. | `hide`, `show`, `status` |

#### Migration từ 2.x → 3.0 (breaking)

Các **hidden aliases** CLI đã bị gỡ. Dùng lệnh canonical:

| 2.x (đã xóa) | 3.0 |
| :--- | :--- |
| `omni equip <src>` | `omni skills add <src>` |
| `omni auto-equip` / `omni status` | `omni skills` |
| `omni skills:doctor` | `omni skills doctor` |
| `omni gate` | `omni run gate` |
| `omni trace` | `omni run log` |
| `omni stats` | `omni run stats` |
| `omni onboard` | `omni init --onboard` |

Chat commands `>om-*` **không** đổi. Chi tiết release: `CHANGELOG.md`, checklist ship: `RELEASE.md`.

---

## ⚙️ Cơ chế tự động & Chế độ vận hành (Run Mode)

Omni-Coder Kit được thiết kế để cân bằng giữa sự tự động hóa tuyệt đối và sự kiểm soát an toàn của người dùng:

1. **Vòng lặp 3 Quality Cycles (`cook` → `check` → `fix`):**
   Trong quá trình `>om-cook`, hệ thống tự động chia công việc thành 3 đợt kiểm thử chất lượng. Sau mỗi checkpoint task, agent sẽ tự động thực thi `>om-check`. Nếu phát hiện lỗi, agent tự chuyển sang `>om-fix` để sửa và kiểm thử lại trước khi làm task tiếp theo.

2. **Chế độ AUTO vs MANUAL:**
   - **Chế độ AUTO:** Ngay sau khi phần hỏi-đáp của `>om-think` kết thúc, hệ thống **TỰ ĐỘNG** nối chuỗi: `>om-skill` → `>om-plan` → `>om-cook` mà không cần người dùng can thiệp giữa các bước.
   - **Chế độ MANUAL:** Người dùng tự chủ động gõ từng lệnh `>om-` theo mong muốn.

3. **Chế độ Nghiệm thu (Acceptance Loop):**
   Nếu dự án có file `requirements.md`, sau khi `>om-check` hoàn thành, hệ thống sẽ chạy vòng lặp nghiệm thu `>om-pass` để chấm điểm từng mục yêu cầu (đạt 100% met mới cho phép `>om-ship`).

---

## 📂 Cấu trúc thư mục của Omni trong dự án

Sau khi chạy `omni init`, thư mục dự án của bạn sẽ xuất hiện thêm các cấu hình quản lý:
```
your-project/
├── AGENTS.md (hoặc CLAUDE.md, .cursor/rules/, .windsurf/rules/...) # File quy tắc IDE siêu nhẹ
├── .agents/                        # Bộ quy tắc, workflows và skills dùng chung cho các agent
│   ├── rules/                      # Quy tắc lõi (core-mindset, workflow-commands, yolo-guardrails...)
│   ├── skills/                     # Các bộ kỹ năng chuyên sâu (TDD, debugging, visual UI...)
│   └── workflows/                  # Chỉ dẫn luồng thực thi SDLC
└── .omni/
    ├── manifest.json               # Trạng thái IDE, skill đã cài, agentFilesVisibility
    ├── codex-gemini/               # [Dual Orchestrator] Transaction runs và artifacts
    │   └── runs/<task-id>/         # Thư mục transaction độc lập cho từng task
    │       ├── spec.json, events.ndjson, state.json...
    │       └── raw/                # Immutable logs của từng attempt
    ├── run/                        # [Harness] Log hoạt động & state phiên chạy tự động
    │   ├── state.json              # Trạng thái hiện tại (để resume)
    │   └── events.ndjson           # Lịch sử sự kiện thực thi realtime
    ├── workflows/                  # File chỉ dẫn luồng SDLC nạp vào AI khi chat >om-
    ├── sdlc/                       # Output quá trình phát triển (todo.md, design-spec.md...)
    └── knowledge/                  # Bản đồ codebase (project-map.md) & tri thức (knowledge-base.md)
```

---

## 💖 Nguồn cảm hứng

Dự án được phát triển và tối ưu dựa trên ý tưởng từ:
- [antigravity-kit](https://github.com/vudovn/antigravity-kit)
- [karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)
- [superpowers](https://github.com/obra/superpowers/)
- [taste-skill](https://github.com/Leonxlnx/taste-skill)
- Claudekit

---

## 📄 Giấy phép

Mã nguồn được phân phối dưới giấy phép **ISC**. Phát triển và duy trì bởi **TAV** (<tav99.dev@gmail.com>).
