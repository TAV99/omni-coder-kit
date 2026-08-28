# Omni-Coder Kit (Phiên bản v3.x)

[![Version](https://img.shields.io/badge/version-3.0.0-blue.svg)](https://github.com/TAV99/omni-coder-kit/releases/tag/v3.0.0)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![V4 Next-Gen](https://img.shields.io/badge/Next--Gen-Omni%20v4%20Harness-purple.svg)](./README_V4.md)

> **Tài liệu cho Omni-Coder Kit v3.0.0**. Nếu bạn quan tâm đến kiến trúc Reliability Kernel thế hệ mới (TypeScript, Deterministic State Machine, DAG Quality Gates), vui lòng xem [README_V4.md](./README_V4.md).

---

## 📖 Giới thiệu

**Omni-Coder Kit** là bộ công cụ CLI inject tư duy phát triển phần mềm chuẩn mực (**Karpathy Mindset**), quy trình SDLC tinh gọn và các kỹ năng chuyên sâu vào các AI coding agents hàng đầu:
- **CLI Agents:** Claude Code, Codex CLI, Antigravity CLI (`agy`), Gemini CLI.
- **AI IDEs:** Cursor, Windsurf, Claude Code, Antigravity IDE.

Hệ thống giúp AI hoạt động với kỷ luật của một Senior Software Engineer: lập trình chính xác (surgical coding), tuân thủ kiểm thử nghiêm ngặt (TDD), vượt qua các Quality Gates tự động và loại bỏ tối đa lỗi ảo tưởng (hallucination).

---

## 🌟 Tính năng nổi bật của v3.0.0

1. **Dual AUTO Authority Daemon (Codex + Gemini qua Antigravity):**
   - Phân định rõ vai trò: **Codex** (Kiến trúc sư, Router, Final QC) và **Gemini 3.7 Flash High** qua `agy` (Worker xử lý các phần việc nặng).
   - Quản lý phiên bằng Authority Ledger với hash-chain, lease chống xung đột, snapshot baseline và quality gates nghiêm ngặt.
2. **Autonomous SDLC Harness (`omni run`):**
   - Vận hành vòng lặp 6 pha: `INTAKE` → `PLAN` → `EXECUTE` → `VERIFY` → `ACCEPT` → `DOCUMENT`.
   - Chạy tự động từ file đặc tả khách hàng (`--spec`), tự viết code, chạy test và nghiệm thu 100% yêu cầu.
3. **Chat Workflows (`>om-*` / `/om-*`):**
   - 14 lệnh tương tác nhanh gọn trong khung chat IDE.
   - Hỗ trợ cả chế độ **AUTO** (tự động chạy Think → Skill → Plan → Cook) và **MANUAL**.
4. **Hệ thống Quality Gates P0–P5:**
   - Security → Lint → Typecheck/Build → Unit/Integration Test → Content/Requirements Conformance.
   - Vòng lặp 3 chu kỳ chất lượng (`cook` → `check` → `fix`).
5. **Quản lý Agent Files & Skills:**
   - Ẩn/hiện cấu hình agent trên Git (`omni agent-files hide|show`).
   - Cài đặt và xác thực tính toàn vẹn của skills với SHA-256 checksums (`omni skills`).

---

## 📦 Cài đặt & Khởi tạo nhanh

### 1. Cài đặt toàn cục (Global)
Yêu cầu **Node.js >= 20.0.0**:
```bash
npm install -g omni-coder-kit
```

### 2. Khởi tạo trong dự án
```bash
cd my-project
omni init
```
*CLI sẽ tự động nhận diện DNA dự án (ngôn ngữ, framework, test runner, build tool) và cấu hình rules/skills tương thích cho các IDE/Agent.*

Trong quá trình `omni init`, bạn có thể chọn:
- **Hiện agent files (Mặc định):** Commit cấu hình rules vào Git để đồng bộ giữa các máy và đồng đội.
- **Ẩn agent files:** Thêm block cấu hình vào `.gitignore` để giữ repo sạch dấu vết AI tooling.

Quản lý ẩn/hiện bất cứ lúc nào:
```bash
omni agent-files status   # Kiểm tra trạng thái: visible | hidden
omni agent-files hide     # Ẩn file cấu hình agent qua .gitignore
omni agent-files show     # Bỏ ẩn file cấu hình agent
```

---

## 🚀 Ba chế độ sử dụng chính

```
                               ┌─────────────────────────┐
                               │     Omni-Coder Kit      │
                               └────────────┬────────────┘
                                            │
        ┌───────────────────────────────────┼──────────────────────────────────┐
        │                                   │                                  │
        ▼                                   ▼                                  ▼
┌──────────────────┐               ┌──────────────────┐               ┌──────────────────┐
│  1. Chat Mode    │               │ 2. Terminal Run  │               │ 3. Dual AUTO     │
│  (>om-* in IDE)  │               │   (omni run)     │               │ (Codex + Gemini) │
└──────────────────┘               └──────────────────┘               └──────────────────┘
```

---

### Cách 1: Chế độ tương tác trong Chat (`>om-*`) — Dành cho AI IDE

Sử dụng trực tiếp trong khung chat của **Cursor, Windsurf, Claude Code, Antigravity, Gemini CLI**.

#### 1. Lập trình tự động trọn gói (One-shot)
```text
>om-go Xây dựng hệ thống Authentication với JWT, bcrypt và đầy đủ unit tests
```

#### 2. Lập trình từng bước (Tự kiểm soát)
* **Khảo sát & Thiết kế:** `>om-think Thiết kế hệ thống thanh toán qua Stripe` (AI phỏng vấn & xuất `design-spec.md`)
* **Cài đặt kỹ năng:** `>om-skill` (AI tự tìm và cài skill phù hợp với stack)
* **Lập kế hoạch:** `>om-plan` (AI phân tách task chi tiết vào `todo.md`)
* **Lập trình chính xác:** `>om-cook` (AI viết code và chạy 3 Quality Cycles)
* **Kiểm định QA:** `>om-check` (AI chạy linter, build, và test P0–P5)
* **Sửa lỗi tập trung:** `>om-fix` (AI phân tích root cause từ test report và vá lỗi)
* **Nghiệm thu chất lượng:** `>om-pass` (AI chấm sản phẩm thực tế vs 100% checklist yêu cầu)
* **Tài liệu hóa:** `>om-doc` (AI cập nhật README, API docs, changelog)
* **Đóng gói phát hành:** `>om-ship` (AI tạo release notes, versioning, rollback plan)

---

### Cách 2: Chế độ tự động hoàn toàn (`omni run`) — Dành cho Terminal

Không cần mở khung chat IDE, bộ điều phối Harness của Omni sẽ tự động dẫn dắt agent thực thi từ đầu đến cuối.

#### 1. Chạy tự động từ file đặc tả yêu cầu
```bash
omni run --spec spec.md
```
*Omni sẽ tự động phân tích `spec.md` thành checklist nghiệm thu nguyên tử (`requirements.md`), sinh kế hoạch, viết code, chạy test suite và lặp sửa lỗi cho đến khi đạt 100% yêu cầu.*

#### 2. Các lệnh điều khiển Terminal hữu ích:
* **Tiếp tục phiên bị gián đoạn:** `omni run --resume`
* **Chạy nháp (Dry-run):** `omni run --dry-run`
* **Chạy kiểm định Quality Gates độc lập (cho CI/CD):** `omni run gate`
* **Chạy riêng bước nghiệm thu (Acceptance):** `omni run accept --accept requirements.md`
* **Xem nhật ký sự kiện:** `omni run log --follow`
* **Thống kê token & chi phí:** `omni run stats`

---

### Cách 3: Dual AUTO Authority Daemon — Codex + Gemini qua Agy

Chế độ phối hợp sức mạnh đa mô hình: **Codex** (Reasoning & QC) + **Gemini 3.7 Flash High** qua `agy` (Fast Worker).

```
┌───────────────────────────────────────────────────────────────┐
│                    Codex (Architect & QC)                    │
└───────────────────────────────┬───────────────────────────────┘
                                │ 1. Interview, Plan & Setup
                                ▼
┌───────────────────────────────────────────────────────────────┐
│               Omni Dual Authority Daemon Ledger               │
│         (Task Ownership, Lease, Hash-Chain, Quality Gates)    │
└───────────────────────────────┬───────────────────────────────┘
                                │ 2. Dispatch worker tasks
                                ▼
┌───────────────────────────────────────────────────────────────┐
│            Gemini 3.7 Flash High via Antigravity              │
│                 (Scout, Implement, Review)                   │
└───────────────────────────────┬───────────────────────────────┘
                                │ 3. Evidence & Artifacts
                                ▼
┌───────────────────────────────────────────────────────────────┐
│                    Codex Final Verification                   │
│                     (task.completed & promote)                │
└───────────────────────────────┘
```

#### 1. Khởi tạo và sử dụng:
```bash
omni init
# Chọn: Dual -> Codex + Gemini via agy -> AUTO
```
Sau đó trong Codex chat, gọi `>om-think` (hoặc `$om-think`). Khi interview hoàn tất, controller tự động tạo authority session, quản lý worker qua `agy`, và trả về Codex để kiểm định chất lượng cuối cùng.

#### 2. Quản lý Daemon:
```bash
omni dual daemon start     # Khởi động daemon thủ công nếu cần
omni dual daemon status    # Kiểm tra trạng thái kết nối & active lease
omni dual daemon stop      # Dừng daemon an toàn
omni dual bootstrap --json # Bootstrap authority session từ plan
```

---

## 🛠️ Danh mục tra cứu lệnh đầy đủ

### 1. Lệnh trong khung Chat (`>om-*` / `/om-*`)

| Lệnh | Vai trò | Mô tả & Đầu ra chính |
| :--- | :--- | :--- |
| `>om-go` | All-in-one | Tự động chạy toàn bộ quy trình SDLC từ đầu đến cuối. |
| `>om-think` | Kiến trúc sư | Khảo sát yêu cầu, phỏng vấn DNA, xuất `design-spec.md`. |
| `>om-scan` | Onboarding | Quét codebase dự án cũ, trích xuất cấu trúc và cài đặt rules/skills. |
| `>om-spec` | Đặc tả | Chuyển đổi yêu cầu khách hàng thành checklist nguyên tử `requirements.md`. |
| `>om-plan` | Quản lý dự án | Phân rã thiết kế thành các micro-tasks trong `todo.md`. |
| `>om-cook` | Lập trình viên | Viết code chuẩn xác (surgical) kèm 3 Quality Cycles. |
| `>om-check` | Kỹ sư QA | Chạy pipeline kiểm thử P0–P5, xuất `test-report.md`. |
| `>om-fix` | Kỹ sư Debug | Phân tích root cause từ test report và sửa lỗi khoanh vùng. |
| `>om-pass` | Nghiệm thu | Chấm điểm sản phẩm thực tế so với checklist `requirements.md`. |
| `>om-doc` | Kỹ sư Tài liệu | Cập nhật tài liệu kỹ thuật, API docs và README tiếng Việt. |
| `>om-ship` | Release Engineer | Tạo version, changelog, rollout & rollback plan (`ship-report.md`). |
| `>om-memo` | Quản lý Tri thức | Lưu các bài học kinh nghiệm và giải pháp debug vào `knowledge-base.md`. |
| `>om-skill` | Skill Manager | Cài đặt và đề xuất kỹ năng chuyên sâu từ kho kỹ năng. |
| `>om-map` | Kiến trúc sư | Quét codebase và vẽ bản đồ kiến trúc `project-map.md`. |

---

### 2. Nhóm lệnh CLI Terminal (`omni <nhóm>`)

| Lệnh | Chức năng | Các tham số quan trọng |
| :--- | :--- | :--- |
| `omni init` | Khởi tạo cấu hình dự án, DNA scanner và IDE adapter. | `--onboard`, `--dry-run` |
| `omni run` | Khởi chạy vòng lặp SDLC tự động. | `--spec <file>`, `--resume`, `--dry-run`, `--yolo` |
| `omni run gate` | Chạy riêng pipeline kiểm thử P0–P5. | `--only <P0,P1,P3>` |
| `omni run accept` | Chạy riêng vòng nghiệm thu Acceptance. | `--accept <file>`, `--yolo`, `--quiet` |
| `omni run log` | Xem nhật ký sự kiện thực thi (.ndjson). | `--limit <n>`, `--follow` |
| `omni run stats` | Tổng hợp token sử dụng, chi phí và thời gian chạy. | *(không)* |
| `omni dual` | Điều phối chế độ Dual Codex + Gemini qua Agy. | `daemon`, `bootstrap`, `setup`, `baseline` |
| `omni skills` | Quản lý kỹ năng agent (cài đặt, kiểm tra sức khỏe). | `add <nguồn>`, `doctor` |
| `omni map` | Tạo hoặc làm mới bản đồ cấu trúc mã nguồn. | `--refresh` |
| `omni rules` | Quản lý và đồng bộ Personal Rules. | `[action]`, `--dry-run` |
| `omni agent-files` | Ẩn/hiện cấu hình agent khỏi Git qua `.gitignore`. | `hide`, `show`, `status` |

---

## 📂 Cấu trúc thư mục Omni trong dự án

```
your-project/
├── AGENTS.md (hoặc CLAUDE.md, .cursor/rules/, .windsurf/rules/...) # Config nhẹ cho IDE
├── .agents/                        # Bộ quy tắc, workflows và skills dùng chung
│   ├── rules/                      # Quy tắc lõi (core-mindset, workflow-commands, yolo-guardrails...)
│   ├── skills/                     # Kỹ năng chuyên sâu (TDD, debugging, visual-design...)
│   └── workflows/                  # Chỉ dẫn luồng thực thi SDLC
└── .omni/
    ├── manifest.json               # Trạng thái dự án, IDE detected, installed skills
    ├── codex-gemini/               # [Dual Orchestrator] Transaction runs & raw attempt logs
    ├── runs/dual-authority/        # [Dual Authority] Ledger, snapshots & receipts
    ├── run/                        # [Harness] State (state.json) & Event stream (events.ndjson)
    ├── sdlc/                       # Output phát triển (todo.md, design-spec.md, requirements.md)
    └── knowledge/                  # Bản đồ mã nguồn (project-map.md) & Tri thức (knowledge-base.md)
```

---

## 🔄 Bảng chuyển đổi lệnh 2.x → 3.0

Phiên bản 3.0 đã loại bỏ các hidden alias để chuẩn hóa CLI:

| Lệnh 2.x (Đã gỡ bỏ) | Lệnh chuẩn 3.0 |
| :--- | :--- |
| `omni equip <src>` | `omni skills add <src>` |
| `omni auto-equip` / `omni status` | `omni skills` |
| `omni skills:doctor` | `omni skills doctor` |
| `omni gate` | `omni run gate` |
| `omni trace` | `omni run log` |
| `omni stats` | `omni run stats` |
| `omni onboard` | `omni init --onboard` |

---

## 📄 Giấy phép

Mã nguồn được phân phối theo giấy phép **ISC**.
Phát triển và duy trì bởi **TAV** (<tav99.dev@gmail.com>).
