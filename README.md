# Omni-Coder Kit

**Omni-Coder Kit** là một bộ công cụ CLI giúp inject mindset phát triển phần mềm chuẩn mực (Karpathy Mindset), SDLC workflows và các kỹ năng chuyên sâu vào AI coding agents (Claude Code, Antigravity CLI, Cursor, Windsurf, Codex, Gemini CLI...). Công cụ này định hướng AI hoạt động với kỷ luật của một Senior Engineer, tuân thủ quy trình SDLC nghiêm ngặt và hạn chế tối đa lỗi ảo tưởng (hallucination).

Trong phiên bản mới nhất (v2.7.2), Omni-Coder Kit hoạt động như một **Agent Harness & Loop Runtime** — tự lái vòng lặp SDLC: gọi LLM → thực thi quality gates (lint, build, test, security) → tự động sửa lỗi (fix loop) → tự động nghiệm thu (acceptance loop).

---

## 📦 Cài đặt & Khởi tạo nhanh

Yêu cầu [Node.js](https://nodejs.org/) >= 16.0.0.

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

---

## 🚀 Hai cách sử dụng chính

Omni-Coder Kit hỗ trợ 2 cách tiếp cận linh hoạt tùy theo thói quen lập trình của bạn:

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
CLI gọn nhẹ với 5 nhóm lệnh điều khiển chính:

| Nhóm lệnh | Mô tả | Option hữu ích |
| :--- | :--- | :--- |
| `omni init` | Khởi tạo DNA dự án và cấu hình IDE thích hợp. | `--onboard` (ép quét codebase cũ), `--dry-run` |
| `omni run` | Khởi chạy vòng lặp SDLC tự động từ terminal. | `--spec <file>`, `--resume`, `--dry-run`, `--yolo` |
| `omni run gate` | Chạy độc lập Quality Pipeline P0-P5 (tiện cho CI/CD). | `--only <P0,P1,P3>` |
| `omni run log` | Xem nhật ký sự kiện thực thi của phiên chạy gần nhất. | `--limit <n>`, `--follow` |
| `omni skills` | Quản lý, cài đặt và kiểm tra các bộ skill lập trình. | `add <nguồn>`, `doctor` |
| `omni map` | Tạo hoặc cập nhật sơ đồ tóm tắt mã nguồn dự án. | `--refresh` |
| `omni rules` | Quản lý quy tắc cá nhân (Personal Rules sync). | `[action]`, `--dry-run` |

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
    ├── manifest.json               # Trạng thái IDE và danh sách skill đã cài
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

Mã nguồn được phân phối dưới giấy phép **ISC**. Phát triển và duy trì bởi **TAV** (tav99.dev@gmail.com).
