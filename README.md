# Omni-Coder Kit

**Omni-Coder Kit** là một bộ công cụ CLI giúp inject mindset phát triển phần mềm chuẩn mực (Karpathy Mindset), SDLC workflows và các kỹ năng chuyên sâu vào AI coding agents (Claude Code, Antigravity CLI, Cursor, Windsurf, Codex, Gemini CLI...). Công cụ này định hướng AI hoạt động với kỷ luật của một Senior Engineer, tuân thủ quy trình SDLC nghiêm ngặt và hạn chế tối đa lỗi ảo tưởng (hallucination).

Trong phiên bản mới nhất (**v3.0.0**), Omni-Coder Kit hoạt động như một **Agent Harness & Loop Runtime** — tự lái vòng lặp SDLC: gọi LLM → thực thi quality gates (lint, build, test, security) → tự động sửa lỗi (fix loop) → tự động nghiệm thu (acceptance loop).

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
CLI gọn nhẹ với các nhóm lệnh điều khiển chính:

| Nhóm lệnh | Mô tả | Option / Subcommand hữu ích |
| :--- | :--- | :--- |
| `omni init` | Khởi tạo DNA dự án và cấu hình IDE thích hợp. | `--onboard` (ép quét codebase cũ), `--dry-run`; hỏi ẩn/hiện agent files; chọn chế độ Dual |
| `omni dual` | Điều phối Codex + Gemini qua agy (cross-platform). | `new`, `run`, `resume`, `status`, `phase <phase>` |
| `omni run` | Khởi chạy vòng lặp SDLC tự động từ terminal. | `--spec <file>`, `--resume`, `--dry-run`, `--yolo` |
| `omni run gate` | Chạy độc lập Quality Pipeline P0-P5 (tiện cho CI/CD). | `--only <P0,P1,P3>` |
| `omni run log` | Xem nhật ký sự kiện thực thi của phiên chạy gần nhất. | `--limit <n>`, `--follow` |
| `omni run stats` | Tổng hợp token, chi phí và thời gian từ event log. | *(không)* |
| `omni run accept` | Chạy riêng state ACCEPTANCE trên build hiện tại (CI). | `--accept <specs>`, `--yolo`, `--quiet` |
| `omni skills` | Quản lý các bộ skill lập trình (cài đặt/kiểm tra). | Subcommand: `add <nguồn>`, `doctor` |
| `omni map` | Tạo hoặc cập nhật sơ đồ tóm tắt mã nguồn dự án. | `--refresh` |
| `omni rules` | Quản lý quy tắc cá nhân (Personal Rules sync). | `[action]`, `--dry-run` |
| `omni agent-files` | Ẩn/hiện file agent (`AGENTS.md`, `CLAUDE.md`, IDE dirs…) khỏi git qua `.gitignore`. | `hide`, `show`, `status` |

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

### Cách 3: Dual AUTO Authority Daemon — Codex + Gemini qua Agy

Ở chế độ này, **Codex** giữ vai trò Architect, Router và Final QC; **Gemini 3.7 Flash High** qua `agy` đảm nhiệm các phần việc worker đủ điều kiện. Authority daemon giữ session, ownership, lease và quality gates bằng ledger hash-chain; Gemini không thể tự xác nhận hoàn thành.

#### 1. Khởi tạo và dùng hằng ngày

```bash
omni init
# Chọn Dual -> Codex + Gemini via agy -> AUTO
```

Sau đó, trong Codex chỉ cần gọi `$om-think` (hoặc `>om-think`). Khi interview/spec hoàn tất, workflow tạo `setup.json`, `todo.md` và full graph `dual-plan.json`, rồi gọi một controller `omni dual bootstrap --json`. Controller chạy setup trước, sau đó mới tạo authority, đăng ký graph thật một lần, route task, gọi AGY khi phù hợp và trả về Codex QC. Planning artifacts không được đăng ký thành task tạm.

Codex phải trust project để project hooks được chạy. Config được sinh dùng `[features] hooks = true`, `.codex/hooks.json` và MCP stdio bằng Node/package path tuyệt đối của máy hiện tại; không phụ thuộc global `omni`, PowerShell hay Bash.

#### 2. Lifecycle và recovery

```bash
omni dual daemon start
omni dual daemon status
omni dual daemon stop
omni dual bootstrap --json
```

- `SessionStart` tự bootstrap hoặc attach daemon. `omni dual daemon start` là repair command khi cần chạy thủ công.
- Session/task tiếp tục từ ledger và tái sử dụng AGY phases đã thành công; capability version/model được kiểm tra một lần rồi dùng lại.
- Greenfield project dùng snapshot baseline, không tự `git init` hoặc commit. Git project dùng HEAD hiện tại.
- Sau khi session snapshot đã `VERIFIED` và người dùng chủ động tạo Git commit phù hợp, `omni dual baseline promote` revalidate receipt, accepted snapshot, clean tree và daemon shutdown trước khi promote.
- Không sửa/xóa thủ công `.omni/runs/dual-authority` hay `.omni/runtime/dual` như cách recovery thông thường. Ledger/lock/discovery hỏng hoặc ngoại lai sẽ fail closed.
- `omni dual bootstrap` có thể archive/adopt một legacy planning-only session chỉ khi setup receipt khớp, không có lease/gate/execution evidence và drift chỉ nằm trong planning/package artifacts.

Các lệnh `omni dual new|run|resume|status|phase` vẫn được giữ cho transaction v1 và debug compatibility; chúng không thay thế authority session của Dual AUTO mới.

#### 3. Runtime data

- `.omni/runtime/dual/daemon.json`, `daemon.lock`: discovery và single-daemon lock theo workspace.
- `.omni/runs/dual-authority/`: authority ledger, initial/accepted snapshot và receipt-bound state.
- `.omni/codex-gemini/runs/<task-id>/`: semantic artifacts và raw immutable AGY attempts.
- `.omni/sdlc/setup.json`: typed setup actions; chạy idempotent bằng `omni dual setup run`.
- `.omni/sdlc/dual-plan.json`: strict versioned full task graph; controller hash/validate trước mọi daemon side effect.

#### 4. Safety contracts

- AGY worker dùng exact `gemini-3.7-flash-high`, effort `high`, argv bounded với `shell: false`, và `--dangerously-skip-permissions` theo lựa chọn Dual init của người dùng; Omni không đặt token budget cho AGY và không sửa global AGY config.
- Scout/implement/review phải nộp research trace, alternatives/failure modes, self-review và independent challenge theo strict schema. Output rỗng, malformed, sai schema, timeout, network hoặc non-zero exit được tự retry tối đa 3 attempts với correction hint ngắn.
- Để tiết kiệm token Codex, success path chỉ đọc semantic artifacts/MCP summaries; raw stdout/stderr chỉ dùng khi failure, hash/correlation mismatch hoặc crash recovery.
- Trong lúc AGY lease còn active, Codex chỉ điều phối và không ghi source/build/browser artifacts. Codex bắt đầu Final QC sau khi lease đã được release bền vững và task tới `CODEX_QC`.
- Owner/allowlist/deny-pattern được kiểm tra trước write và diff được kiểm tra lại sau implement/review. Daemon mất kết nối thì source mutation bị deny fail-closed.
- Chỉ Codex QC mới có thể ghi `task.completed`; mọi task, ba quality cycles và mandatory gates phải pass trước `session.verified`.
- Commit, push, deploy, stash, reset và external-system mutation luôn cần quyền riêng của người dùng.
- Node runtime dùng cùng exact argv trên Windows CMD/PowerShell, Linux và macOS; `ai-flow.ps1` chỉ là deprecated compatibility shim.

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

**Ẩn file agent khỏi git (tuỳ chọn):** nếu chọn *Ẩn* lúc `init` hoặc chạy `omni agent-files hide`, Omni thêm block có marker vào `.gitignore` (root config + IDE dirs như `.claude/`, `.agents/`, …). File vẫn tồn tại local — chỉ không commit. `omni agent-files show` gỡ block đó. File **đã track** trước đó cần bạn tự `git rm --cached` nếu muốn untrack.

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
