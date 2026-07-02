# Omni-Coder Kit

**Omni-Coder Kit** là một bộ công cụ CLI giúp inject mindset phát triển phần mềm chuẩn mực (Karpathy Mindset), SDLC workflows và các kỹ năng chuyên sâu vào AI coding agent (Claude Code, Antigravity CLI, Cursor, Windsurf, Codex...). Công cụ này định hướng AI hoạt động với kỷ luật của một Senior Engineer, tuân thủ quy trình SDLC nghiêm ngặt và hạn chế tối đa lỗi ảo tưởng (hallucination).

Trong phiên bản mới nhất, Omni-Coder Kit hoạt động như một **Agent Harness & Loop Runtime** — tự lái vòng lặp SDLC: gọi LLM → thực thi quality gates (lint, build, test, security) → tự động sửa lỗi (fix loop) → tự động nghiệm thu (acceptance loop).

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
   *(Hệ thống sẽ tự nhận diện DNA dự án như ngôn ngữ, UI/Backend và thiết lập cấu hình tích hợp tương ứng cho các IDE/Agent trong máy bạn)*

---

## 🚀 Hai cách sử dụng chính

Omni-Coder Kit hỗ trợ 2 cách tiếp cận linh hoạt tùy theo thói quen lập trình của bạn:

### Cách 1: Chế độ tương tác trong Chat (`>om:`) — Dành cho AI IDE
Sử dụng trực tiếp trong khung chat của các AI IDE (như Cursor, Windsurf, Claude Code, Antigravity) bằng cách bắt đầu câu lệnh bằng tiền tố `>om:` (hoặc `/om:` trên Claude Code). 

AI sẽ tự động đọc hướng dẫn trong thư mục `.omni/workflows/` để tuân thủ quy trình thiết kế, lập kế hoạch, code và test.

#### 1. Lập trình nhanh (One-shot)
Gõ lệnh này trong chat để AI tự thực hiện toàn bộ quy trình SDLC (Brainstorm → Plan → Cook → Check → Doc) chỉ với một yêu cầu:
```text
>om:go Xây dựng trang Landing Page giới thiệu dịch vụ bằng HTML/CSS sạch
```

#### 2. Lập trình từng bước (Tự kiểm soát)
Nếu bạn muốn tự kiểm soát từng giai đoạn, hãy chat với AI theo trình tự:
*   **Thiết kế & Brainstorm:** `>om:brainstorm Xây dựng tính năng đăng nhập`
*   **Lập kế hoạch:** `>om:plan` (AI tạo danh sách việc cần làm trong `todo.md`)
*   **Viết code:** `>om:cook` (AI lập trình và kiểm tra cú pháp)
*   **Kiểm tra:** `>om:check` (AI tự chạy linter, build, và test tự động)
*   **Tài liệu:** `>om:doc` (AI cập nhật README, API docs)

---

### Cách 2: Chế độ tự động hoàn toàn (`omni run`) — Dành cho Terminal
Không cần mở khung chat IDE, bạn chỉ cần ra lệnh trên terminal của mình. Bộ điều phối (Orchestrator) của Omni sẽ tự khởi chạy tác vụ và "lái" agent thực hiện từ đầu đến cuối một cách tự động.

#### 1. Chạy tự động từ file đặc tả (Spec) của khách hàng
Nếu bạn có một file mô tả yêu cầu (`spec.md`), hãy để Omni tự đọc, tự phân tích thành checklist nghiệm thu (`requirements.md`), tự viết code, tự chạy test và sửa lỗi cho đến khi đạt 100% yêu cầu:
```bash
omni run --spec spec.md
```

#### 2. Các lệnh điều khiển hữu ích trên Terminal:
*   **Chạy tiếp tục:** `omni run --resume` (Nếu phiên chạy bị tạm dừng hoặc lỗi, chạy lệnh này để tiếp tục từ vị trí cũ mà không tốn lại token từ đầu).
*   **Chạy nháp không sửa code:** `omni run --dry-run` (In ra kế hoạch hành động chi tiết để bạn kiểm tra trước).
*   **Chạy kiểm định chất lượng độc lập:** `omni run gate` (Chạy toàn bộ pipeline kiểm thử P0-P5: Security → Lint → Build → Test → Content).

---

## 🛠️ Tra cứu nhanh danh sách lệnh

### 1. Lệnh trong khung Chat (`>om:`)
Khi chat với AI trong IDE, hãy gõ các lệnh sau ở đầu câu để định hướng hành vi của AI:

| Lệnh | Vai trò | Output/Hành động của AI |
| :--- | :--- | :--- |
| `>om:go` | **Chạy tự động** | Tự đi qua toàn bộ các bước SDLC để hoàn thành yêu cầu của bạn. |
| `>om:brainstorm`| Kiến trúc sư | Khảo sát yêu cầu, sinh đặc tả thiết kế (`design-spec.md`). |
| `>om:plan` | Quản lý dự án | Phân tách thiết kế thành danh sách task trong (`todo.md`). |
| `>om:cook` | Lập trình viên | Viết code chuẩn xác (surgical), tự kiểm tra cú pháp sau mỗi file. |
| `>om:check` | Kỹ sư QA | Chạy test, kiểm tra bảo mật P0-P5 và xuất (`test-report.md`). |
| `>om:fix` | Kỹ sư Debug | Phân tích lỗi từ test-report và sửa lỗi khoanh vùng. |
| `>om:accept` | Nghiệm thu | Đối chiếu sản phẩm thực tế với checklist yêu cầu khách hàng. |
| `>om:doc` | Viết tài liệu | Cập nhật tài liệu kỹ thuật và hướng dẫn sử dụng. |
| `>om:learn` | Học máy | Lưu lại bài học kinh nghiệm sửa lỗi vào `knowledge-base.md`. |

### 2. Lệnh trong CLI Terminal
Chạy trực tiếp từ shell hệ thống của bạn:

| Lệnh | Mô tả | Option hữu ích |
| :--- | :--- | :--- |
| `omni init` | Khởi tạo cấu hình Omni và cấu hình IDE thích hợp. | `--onboard` (quét codebase cũ) |
| `omni run` | Khởi chạy vòng lặp SDLC tự động từ terminal. | `--spec <file>`, `--resume`, `--dry-run` |
| `omni run gate`| Chạy độc lập Quality Pipeline P0-P5 (tiện cho CI/CD). | `--only <p0/p1/p2...>` |
| `omni run log` | Xem lịch sử các bước chạy (logs) của phiên gần nhất. | `--limit <n>` |
| `omni skills` | Quản lý, cài đặt và cập nhật các bộ skill lập trình. | `add <nguồn>`, `doctor` |
| `omni map` | Tạo hoặc cập nhật sơ đồ tóm tắt mã nguồn dự án. | `--refresh` |

---

## 📂 Cấu trúc thư mục của Omni trong dự án

Sau khi chạy `omni init`, thư mục dự án của bạn sẽ xuất hiện thêm các thư mục quản lý:
```
your-project/
├── CLAUDE.md (hoặc GEMINI.md, AGENTS.md, .cursorrules...) # File cấu hình IDE siêu nhẹ (~5KB)
├── .omni/
│   ├── manifest.json               # Theo dõi trạng thái IDE và các skill đã cài
│   ├── run/                        # [Harness] Lưu log hoạt động, trạng thái chạy tự động
│   │   ├── state.json              # Trạng thái hiện tại (để resume)
│   │   └── events.ndjson           # Lịch sử chi tiết các sự kiện thực thi
│   ├── workflows/                  # Các file chỉ dẫn luồng SDLC nạp vào AI khi chat >om:
│   ├── sdlc/                       # Output của quá trình phát triển (todo.md, design-spec.md...)
│   └── knowledge/                  # Bản đồ codebase và tri thức sửa lỗi (knowledge-base.md)
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
