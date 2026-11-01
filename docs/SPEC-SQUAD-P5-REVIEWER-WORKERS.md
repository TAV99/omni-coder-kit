# Spec — Squad P5: reviewer độc lập + nhiều worker

> Căn cứ: [`SQUAD-ARCHITECTURE-PLAN.md`](SQUAD-ARCHITECTURE-PLAN.md) D5 (bật reviewer thì QC chuyển sang kiểu đẩy), D7, D8, D18 (một tài khoản giữ nhiều vai; cảnh báo cùng họ model), §3.3 (phase `qc` thuộc reviewer, `on_needs_fix`, `max_corrections`), §5.1 (bundle QC đi theo phase), §6 B2–B3 (ngữ cảnh reviewer, leo thang), §7 B5 (ngân sách, đồng thời); P2 (vai, mount), P3 (pipeline, cổng duyệt), P4 (claude giữ vai nào cũng được).
> Ngày: 2026-11-01. Runtime chính: codex, agy, claude (D19).

---

## 0. Mục tiêu & phạm vi

### 0.1 Mục tiêu

1. **Reviewer làm QC độc lập** (preset `squad`): sau khi worker bàn giao, omni đẩy một lượt headless cho reviewer. Reviewer chỉ đọc spec + diff + evidence, trả `qc-verdict`. `NEEDS_FIX` → sửa có giới hạn (`max_corrections`), quá giới hạn → leo thang.
2. **Nhiều worker**: `worker-1..N`, mỗi worker gắn runtime/model/effort riêng; mỗi task chạy trên đúng worker được giao.
3. **Chạy song song**: nhiều task isolated chạy cùng lúc khi phụ thuộc đã xong và `allowed_files` không giao nhau; giới hạn số lượt đồng thời theo runtime.
4. **Ngân sách theo vai**: thời gian lượt, số lượt; lỗi rate limit → task chờ, không tự đổi model (B3).
5. Vòng chạy thật preset `squad` 3 vai, và tổ hợp một runtime giữ hai vai (D18).

### 0.2 Ngoài phạm vi P5

| Mục | Sang |
|---|---|
| `omni ui`, PTY, timeline, `@role` | P6 |
| Vai mới do người dùng tự định nghĩa (design…) | sau 3.2.0 |
| Shared mode cho nhiều worker (chỉ isolated mới chạy song song) | giữ shared = 1 worker, tuần tự |
| Reviewer ở shared mode | không — reviewer chỉ đọc một bản handoff isolated |
| Gộp code thông minh khi hai task xung đột | không — xung đột → `CONFLICT` → sửa (cơ chế hiện có) |

### 0.3 Bất biến

- Preset `dual` chạy y như sau P4 (V20, V21, V-live-2, V-live-3 vẫn đạt; argv codex/agy/claude không đổi).
- Ledger chỉ **thêm** loại event, không đổi event cũ; session cũ resume được.
- Mã chỗ nội bộ `codex`/`agy`/`gemini` giữ nguyên (P3b). Reviewer là chỗ **mới** (`reviewer`), không mượn chỗ `codex`.
- Cổng `integrate` luôn `human-always` (D8): reviewer `APPROVE` không bao giờ thay người duyệt.
- `npm test` xanh + một lượt dưới tải trước mỗi commit.

---

## 1. Hiện trạng (đọc từ code, 2026-11-01)

| # | Sự kiện | Nơi |
|---|---|---|
| F1 | QC hôm nay = orchestrator: người điều phối đọc artifact, có thể **từ chối handoff** kèm findings (`rejectTaskHandoff`), rồi `task.qc` chạy `validation_commands` trong worker root và integrate sau cổng duyệt | `isolated-qc.js` `completeIsolatedTask`, `handoff-rejection.js` |
| F2 | Từ chối → `requestTaskCorrection` (attempt + 1, có `recoveryPolicy` budget) → dispatch lại worker cho attempt mới | `task-correction.js` |
| F3 | Worker có phase `review` riêng (qua discussion), ra `review.json` theo `ReviewSchema` (`recommendation APPROVE/NEEDS_FIX/REJECT`, `findings`, `review_checks`, `challenge_summary`) | `contracts.js`, pipeline `review` thuộc worker |
| F4 | Daemon chỉ chạy **một** worker một lúc: cờ `isWorkerRunning`; `runTask` duyệt task tuần tự | `daemon-server.js` `dispatchWorker`, `orchestrator-adapter.js` |
| F5 | QC chờ khi có **bất kỳ** lease đang hoạt động ("until per-file reservations land") | `isolated-qc.js` |
| F6 | Runtime worker là **một** giá trị toàn cục (`manifest.workerRuntime`); model/effort theo task hoặc manifest | `agy-model.js` |
| F7 | Bindings đã có `worker-1..N` và `reviewer` (P2); `engineSupport` chặn: "only one worker", "no reviewer role yet" | `bindings.js` |
| F8 | `pipelines/squad.yaml` hợp lệ nhưng engine từ chối ("reviewer làm QC chạy được từ P5") | `pipeline.js` `assertEngineSupports` |
| F9 | `reviewer.yaml`: `permission: read-only`, `requires: [headless]`, `root: isolated`, `cardinality 0..1` | templates |
| F10 | Bundle QC (`om-check`, `om-pass`, `requesting-code-review`) gắn phase `qc`; reviewer bound thì bundle chuyển sang reviewer (P2 `resolveBundles`) | `skills-catalog.js` |
| F11 | Ba adapter có profile `read-only`: codex `-s read-only`, agy `--mode plan`, claude `--tools Read,Grep,Glob,Skill` (P4 R1) | runtimes |
| F12 | Cảnh báo D18 đã có: chung tài khoản, reviewer cùng họ model với worker/orchestrator | `bindings.js` `sharingWarnings` |
| F13 | `max_corrections` mới chỉ được khai báo và hiển thị trong pipeline; engine giới hạn correction bằng `recoveryPolicy` (`policy.authorizeCorrection`). P5a phải nối `max_corrections` của phase `qc` vào giới hạn này | `pipeline.js`, `task-correction.js` |

---

## 2. Reviewer QC (P5a)

### 2.1 Luồng

```
worker handoff (attempt n) ──▶ reviewer QC (đẩy, headless, read-only)
        │                          │
        │               APPROVE ───┴──▶ task.qc: validation_commands ──▶ cổng integrate (human-always) ──▶ integrate
        │               NEEDS_FIX ────▶ rejectTaskHandoff(findings nguyên văn, actor reviewer)
        │                               └─▶ correction n+1 (≤ max_corrections) ──▶ worker
        │               REJECT / quá max_corrections ──▶ NEEDS_DECISION → orchestrator → người dùng (B3)
```

- Chỉ chạy khi pipeline có `qc: { role: reviewer }` **và** binding có reviewer. Không có reviewer → giữ nguyên F1 (preset `dual`).
- Reviewer chạy **trước** `validation_commands` (Q-P5-2): verdict của reviewer dựa trên evidence của worker; lệnh máy vẫn chạy lại độc lập trong `task.qc` như hôm nay.
- Findings đi **nguyên văn** từ `qc-verdict` vào handoff rejection (anti-pattern C: không paraphrase). Handoff rejection chỉ nhận file trong `allowed_files`: finding chỉ file ngoài phạm vi được gắn vào file phạm vi đầu tiên, đường dẫn gốc giữ trong mô tả `[SEVERITY] (path:line) …`. Giới hạn sửa = min(`max_corrections`, ngân sách correction sẵn có của engine: 3 attempt khi chưa cấu hình recovery policy).

### 2.2 Reviewer root (D7, D18)

- Thư mục mới cạnh worker root: `.omni/runs/dual-workspaces/<s>/<t>/attempt-n/review/` — bản chép **chỉ đọc** cây kết quả của worker (cùng snapshot handoff), `git init` riêng như worker root (P2b), không chép skill dir của các vai.
- Mount bundle của reviewer (QC + shared-core) vào `runtime.skillDirs()` của runtime reviewer; marker vai `reviewer`.
- Cờ cách ly theo runtime: codex `project_root_markers=[]`, claude `disableAllHooks` + `claudeMdExcludes` + `--strict-mcp-config` (P4), agy: git root riêng (V8).
- Quyền: profile `read-only` (F11). Reviewer **không** chạy lệnh test (đó là việc của `task.qc`); thấy kết quả lệnh qua evidence. Prompt luôn ghi "Do not run shell commands…" (V33: thiếu câu này agy `--mode plan` thử chạy lệnh, bị auto-deny và không trả kết quả).
- Phạm vi chép: `allowed_files` (bản sau sửa) + `context_files`, tối đa 2 MiB; diff = `raw/review.<n>.diff.txt` mới nhất của phase review của worker, không có thì dựng diff đơn giản từ project ↔ worker root.

### 2.3 Đầu vào (B2) và đầu ra

| Đầu vào (file trong reviewer root) | Có | Không |
|---|---|---|
| `spec.json` (task brief đã đăng ký), coverage nếu có | ✓ | |
| `diff.patch` (handoff so với baseline) + cây sau sửa | ✓ | |
| `evidence.json` (lệnh + exit code + output) | ✓ | |
| `context.json`, `review.json`, log discussion, `decision_log` lập luận của worker | | ✗ (B2) |

Đầu ra `qc-verdict@1`: dùng lại `ReviewSchema` (F3) + trường `reviewer: { runtime, model }`; schema truyền qua `--output-schema` (codex strict), `--json-schema` inline (claude), `--json-schema` path (agy). Lưu `review/qc-verdict.json`, hash vào ledger.

### 2.4 Ledger (chỉ thêm)

| Event | Khi |
|---|---|
| `qc.review.started` | `{ task_id, attempt, reviewer: {runtime, model}, input_sha256 }` |
| `qc.review.completed` | `{ task_id, attempt, verdict, verdict_sha256, findings_count }` |
| `qc.review.failed` | lỗi kỹ thuật (timeout, output hỏng) — thử lại theo luật technical retry hiện có, không tính vào `max_corrections` |

`task.qc` khi reviewer bound mà attempt hiện tại chưa có `qc.review.completed` với `APPROVE` → trả `status: AWAITING_REVIEW` (đang chờ/đã kích review) hoặc `REVIEW_REJECTED` (handoff đã bị reviewer từ chối), không chạy lệnh QC; người gọi poll lại. (Đổi từ lỗi `DUAL_REVIEWER_QC_REQUIRED` khi code: trạng thái chờ hợp với vòng poll của orchestrator/harness hơn.)

### 2.5 Phiên reviewer

Mỗi attempt một phiên mới (Q-P5-4): reviewer không mang định kiến từ lần trước; findings cũ chỉ đến qua correction của worker, không qua bộ nhớ reviewer.

---

## 3. Nhiều worker (P5b)

### 3.1 Binding → task

- `squad.local.json` đã có `worker-1..N` (P2). Manifest legacy giữ `workerRuntime/Model/Effort` của `worker-1` để preset `dual` cũ không đổi.
- Plan task thêm trường tùy chọn `worker: "worker-2"` (cạnh `owner: worker`). Không ghi → omni giao (Q-P5-5).
- `resolveTaskWorker(root, task)` → `{ id, runtime, model, effort }`: task.worker → binding; thiếu → quy tắc giao; task.model/effort vẫn ghi đè model/effort như hôm nay.
- Mọi chỗ đang gọi `resolveConfiguredWorkerRuntime(root)` trong luồng task (orchestrator, isolated-runner, discussion host, preflight) chuyển sang worker **của task**. Chỗ nội bộ vẫn là `agy`.

### 3.1b Đã làm (P5b)

- `resolveConfiguredWorker{Runtime,Model,Effort}(root, { worker })`: tên worker có binding → runtime/model/effort của worker đó (effort thiếu = `null`, không kế thừa worker-1); task.model/effort vẫn đè; tên không có binding → đường manifest cũ (đăng ký plan đã chặn trước).
- Đăng ký plan: `worker` chỉ cho task worker và phải có binding (`DUAL_PLAN_INVALID`); model/effort ghim theo worker vào `plan.registered`.
- **Capability theo worker:** worker của task agy đầu tiên giữ `details.agy_*` như cũ; mỗi worker khác được preflight riêng một lần lúc đăng ký → `details.workers[id] = { runtime, version, model }`; lỗi → `BLOCKED` kèm id worker. `workerCapability(details, task.worker)` thay mọi chỗ đọc `agy_version/agy_model` theo task (runner, authority, adapter).
- Discussion isolated dùng runtime của worker của task; shared mode giữ worker-1 (§0.2).
- Sửa lỗi P3b phát hiện khi test: RPC `plan.register` gọi thẳng (không qua schema MCP) coi `owner: "orchestrator"` là worker — `planTaskOwner` nay chuẩn hóa tên vai.

### 3.2 Ledger

`plan.registered` đã lưu task nguyên văn → thêm `worker` vào task schema (optional). `task.dispatch` ghi `worker_id` (event mới `task.worker.assigned` khi omni tự giao).

---

## 4. Song song (P5c)

### 4.1 Lập lịch

- `isWorkerRunning` (F4) → tập task đang chạy. Task sẵn sàng khi: phụ thuộc đã `TASK_VERIFIED`, `allowed_files` không giao với task đang chạy/chờ QC, worker được giao còn chỗ, runtime còn chỗ.
- Giới hạn đồng thời theo runtime (`squad.local.json` → `limits.concurrency`, mặc định Q-P5-6) và theo worker (1 lượt / worker).
- Reviewer cũng tính vào giới hạn runtime của nó.

### 4.2 Lease và QC

- Lease worker (isolated) chỉ ghi trong worker root → không còn chặn QC của task khác. F5 đổi thành: `task.qc`/integrate chờ khi có lease **integrate** khác đang hoạt động hoặc lease ghi source (shared mode), không chờ lease isolated.
- Integrate vẫn tuần tự (một lần một task). `integratedConflicts` (hiện có) bắt khi task B đụng file task A vừa integrate → `CONFLICT` → correction.

### 4.2b Đã làm (P5c) — điều chỉnh so với §4.2

- `lib/dual/worker-scheduler.js` `runScheduled`: `runTask` của adapter chạy các task isolated đủ điều kiện qua pool: task bắt đầu khi worker của nó rảnh (1 lượt/worker), runtime còn chỗ (`limits.concurrency` trong `squad.local.json`, mặc định codex 2, claude 2, agy 1 — Q-P5-6) và `allowed_files` không giao task đang chạy (`repoPathsOverlap`); task sau vừa chỗ được chạy trước task trước đang bị chặn; kết quả trả theo thứ tự plan. Plan có task shared → vòng tuần tự cũ.
- **Giữ F5:** `task.qc`/integrate vẫn chờ khi còn lease worker đang chạy. Lý do (đọc code): quyền ghi của worker isolated (`authorize` trong `isolated-authority`) gắn với `currentBaseline` lúc bắt đầu; integrate task A giữa lượt task B sẽ thu quyền B. Song song chỉ ở phần worker (scout/implement/review); integrate vẫn tuần tự và đi sau các worker đang chạy — các lượt worker dài hơn nhiều so với lượt integrate nên ít tốn thời gian.
- Handoff nhiều task trên cùng baseline đã được hỗ trợ trước P5 (`integratedConflicts` dựa trên lịch sử integrate).

### 4.3 Rate limit / đăng nhập

Lỗi rate limit hoặc hết đăng nhập của một runtime → task của runtime đó `WAITING_RUNTIME` (không tốn attempt), task runtime khác chạy tiếp; không tự đổi model (B3). Phân loại lỗi qua `parseResult`/stderr của adapter. **Chưa làm ở commit P5c:** cần dấu hiệu thật của từng CLI (V37) trước khi phân loại; làm trong commit riêng trước khi đóng DoD P5. Tới lúc đó lỗi rate limit đi theo luật technical retry hiện có.

---

## 5. Ngân sách (P5d)

- Role YAML thêm `budget: { turn_minutes, max_turns }` (optional; mặc định = hạn mức hiện có: lượt 30 phút).
- `max_turns` = số lượt headless tối đa của vai cho **một task** (worker: scout + implement + correction; reviewer: số lần review) — chạm trần → `NEEDS_DECISION`.
- Token: chỉ ghi nhận (`usage` từ `parseResult`) vào ledger; không chặn ở 3.2.0.

---

## 6. Engine, pipeline, bề mặt

| Chỗ | Thay đổi |
|---|---|
| `assertEngineSupports` | nhận `qc: reviewer` (preset `squad`); vẫn bắt `on_needs_fix: implement`, `integrate: human-always` |
| `engineSupport` | bỏ "no reviewer role yet" (P5a), bỏ "only one worker" (P5b) |
| Phase `review` của worker ở preset `squad` | Q-P5-3 |
| Status / MCP `omni_dual_status` | mỗi task: `worker_id`, `qc_review: { verdict, attempt }`; trạng thái `REVIEWING`, `WAITING_RUNTIME` |
| `omni squad pipeline` | không còn báo "chạy được từ P5" |
| `doctor` | reviewer chưa có QC bundle → lỗi; reviewer cùng tài khoản/họ model → cảnh báo (F12) |

---

## 7. Phải kiểm trước khi code (V33–V38)

| # | Cần kiểm | Cách |
|---|---|---|
| V33 | Mỗi runtime (codex, agy, claude) làm reviewer read-only trong review root: đọc diff/evidence, trả JSON đúng `ReviewSchema`, không ghi file nào | 3 lượt rẻ trong thư mục tạm |
| V34 | agy `--mode plan` có ghi file plan ở đâu đó (như claude plan ở V25) và có trả đúng `structured_output` không | 1 lượt |
| V35 | Hai lượt headless song song **khác runtime** (codex + claude) và **cùng runtime** (2 × codex) không giẫm session/đăng nhập | 2 lượt song song, người dùng chạy phần codex bypass nếu cần |
| V36 | Token hết hạn giữa chừng khi 2 tiến trình cùng làm mới (V7 còn nợ) — codex và claude | quan sát trong vòng thật dài; ghi nhận, không chặn |
| V37 | Dấu hiệu rate limit của từng CLI (exit code, chuỗi stderr, field JSON) để phân loại `WAITING_RUNTIME` | đọc tài liệu + fixture thật nếu gặp |
| V38 | Reviewer khác hệ thật sự bắt được lỗi: task cài sẵn một bug nhỏ mà test không bắt | vòng thật |

Kết quả ghi ở Phụ lục A.

---

## 8. Câu hỏi mở

| # | Câu hỏi | Đề xuất |
|---|---|---|
| Q-P5-1 | Reviewer `NEEDS_FIX` → omni **tự** mở correction cho worker (đẩy, D5), hay dừng chờ orchestrator quyết? | **Đã chốt 2026-11-01: tự mở correction** với findings nguyên văn, tới `max_corrections`; quá thì leo thang orchestrator → người dùng (B3). Orchestrator vẫn từ chối/ghi đè được qua MCP như hôm nay. |
| Q-P5-2 | Reviewer chạy trước hay sau `validation_commands`? | **Đã chốt: reviewer trước** — lượt LLM rẻ hơn khi bắt lỗi sớm; lệnh máy vẫn chạy lại độc lập trong `task.qc`. |
| Q-P5-3 | Preset `squad` có giữ phase `review` của worker (tự review qua discussion) không? | **Đã chốt: giữ** (đã có, rẻ, bắt lỗi trước khi tốn lượt reviewer); có thể tắt bằng pipeline. |
| Q-P5-4 | Phiên reviewer: mới mỗi attempt hay giữ suốt task? | **Mới mỗi attempt** (độc lập, không mang định kiến). Mặc định đề xuất, người dùng chưa phản đối. |
| Q-P5-5 | Task không ghi `worker`: giao thế nào? | Worker rảnh đầu tiên theo thứ tự `worker-1..N` mà runtime còn chỗ; ghi `task.worker.assigned`. Mặc định đề xuất, người dùng chưa phản đối. |
| Q-P5-6 | Giới hạn đồng thời mặc định theo runtime? | **Đã chốt: `codex: 2, claude: 2, agy: 1`** (agy chưa kiểm song song); sửa được trong `squad.local.json`. |

---

## 9. Sub-phase & commit

| Commit | Nội dung | Phụ thuộc |
|---|---|---|
| `feat(dual): independent reviewer QC (P5a)` | §2 + engine/pipeline nhận reviewer + doctor + test e2e reviewer giả lập (APPROVE, NEEDS_FIX → correction, quá giới hạn → NEEDS_DECISION) | V33, V34, Q-P5-1..4 |
| `feat(dual): per-task worker bindings (P5b)` | §3, vẫn tuần tự | P5a |
| `feat(dual): parallel isolated workers (P5c)` | §4 + lease/QC + `WAITING_RUNTIME` | P5b, V35, V37, Q-P5-5..6 |
| `feat(squad): role budgets (P5d)` | §5 | P5c |
| `test(squad): live P5 runs` | `test/squad-p3-live.js` → thêm `--reviewer` và `--workers 2` | P5a–P5d |

---

## 10. Test

- **P5a:** reviewer root chỉ chứa spec/diff/evidence/cây sau sửa (không `context.json`/`review.json`); argv read-only theo runtime; `qc-verdict` sai schema → `qc.review.failed` + retry kỹ thuật; `NEEDS_FIX` → `task.handoff.rejected` với findings nguyên văn + `task.correction.requested`; attempt `max_corrections + 1` → `NEEDS_DECISION`; `task.qc` từ chối khi chưa có `APPROVE` (`DUAL_REVIEWER_QC_REQUIRED`); preset `dual` không đổi (test cũ xanh).
- **P5b:** `resolveTaskWorker` theo thứ tự; discussion và isolated runner dùng runtime của task; manifest legacy = worker-1.
- **P5c:** hai task không giao `allowed_files` chạy song song (đo bằng thời điểm `task.execution.started`); task giao nhau chờ; giới hạn runtime tôn trọng; integrate tuần tự; xung đột sau integrate → `CONFLICT`; rate limit → `WAITING_RUNTIME` không tốn attempt.
- **P5d:** chạm `max_turns` → `NEEDS_DECISION`; `usage` ghi ledger.
- Toàn bộ: `npm test` + một lượt `--test-concurrency=4`.

---

## 11. Điều kiện xong P5 (DoD)

- [x] Vòng thật preset `squad`: orchestrator codex + worker agy + reviewer claude → cổng plan → worker → reviewer `APPROVE` → QC lệnh → cổng integrate → `TASK_VERIFIED` (V-live-P5-1).
- [ ] Vòng thật có reviewer `NEEDS_FIX` (V38: bug cài sẵn) → correction → `APPROVE` → `TASK_VERIFIED`.
- [ ] Tổ hợp D18: codex orchestrator + codex reviewer (model/effort khác) + agy worker chạy trọn vòng.
- [x] Hai worker (khác runtime) chạy hai task song song, integrate tuần tự, cả hai `TASK_VERIFIED` (V-live-P5-par-3).
- [ ] Preset `dual` vẫn đạt như V20/V21 (một vòng thật chạy lại sau P5c).
- [ ] `npm test` xanh trên macOS + một lượt dưới tải.
- [ ] Phụ lục V33–V38 đã ghi.

---

## Phụ lục A — kết quả V-check (2026-11-01)

| # | Kết quả |
|---|---|
| V33 ✓ | Review root lồng project (có `CLAUDE.md` cha), file `lib/util.js` cài sẵn bug "`null` không bị từ chối" mà test không bắt; argv thật của adapter (`read-only`, `isolatedRoot`, schema `ReviewSchema`). **claude `sonnet` low** (14 s), **codex `gpt-6-luna` low** (19 s), **agy `gemini-3.8-flash-high`** (53 s): cả ba `NEEDS_FIX`, finding nêu đúng bug `null`, JSON qua zod, không tạo/sửa file, không đọc `CLAUDE.md` cha. Fixture `*-reviewer-verdict.txt`. |
| V34 ✓/⚠ | agy `--mode plan` làm reviewer: lần đầu thử chạy lệnh shell → auto-deny "a tool required the command permission" → không có output (`SQUAD_RUNTIME_DENIED_ACTIONS`). Thêm câu "Do not run shell commands… only read files" vào prompt → trả `structured_output` đúng. Không thấy file nào được tạo trong review root. |
| V-live-P5-1 ✓ | Vòng thật preset `squad`: orchestrator codex `gpt-6.1-sol`, worker agy `gemini-3.8-flash-high`, reviewer claude `sonnet` low. Cổng plan giữ → người duyệt → 7 phase của worker → daemon đẩy review (20 s): `APPROVE`, 5 `review_checks` cụ thể, 1 finding INFO (thiếu test cho nhánh `TypeError`, ngoài phạm vi) → `task.qc` chạy lệnh → giữ ở cổng integrate → người duyệt → `TASK_VERIFIED`; ledger `qc.review.started/completed`, cả hai cổng `human`; 9 phút. |
| V-live-P5-par-1 ✗ | `--second-worker claude --reviewer codex`: hai worker chạy song song (lease xen kẽ), nhưng task B (worker-2 claude) `CAPABILITY_BLOCKED`: `daemon-ports.verifyCapability` preflight runtime mặc định (agy) với model `sonnet` — sót của P5b, đã sửa (truyền `worker` của task) + test. Task A cũng fail: seed agy của A bị abort ~1 s sau khi B fail và lỗi văng thành exception khỏi `runTask` → `runScheduled` nay biến exception của một task thành kết quả `FAILED` riêng (test "một task fail, task kia vẫn bàn giao") và ghi lý do abort/guard vào log `worker.task.failed`. **Chưa xác định** cơ chế abort chéo (không lặp lại ở lần 2–3 khi không task nào fail); log mới sẽ ghi lý do nếu gặp lại. |
| V-live-P5-par-2 ✗ | Cả hai task bàn giao song song, reviewer bắt đầu; harness (tiến trình khác) đọc ledger đúng lúc daemon đã ghi record operation mà chưa ghi event commit → `DUAL_OPERATION_CORRUPT`. Daemon không lỗi. Sửa: `authority-store.derive()` đọc lại tối đa 5 lần (ngủ đồng bộ ngắn) khi gặp `DUAL_OPERATION_CORRUPT`; ledger hỏng thật vẫn fail closed; test bằng fs giả có nửa dòng record. Ảnh hưởng chung mọi bộ đọc ngoài tiến trình (CLI status, hook-bridge). |
| V-live-P5-par-3 ✓ | Orchestrator codex, worker-1 agy `gemini-3.8-flash-high`, worker-2 claude `sonnet` low, reviewer codex `gpt-6-luna` low: hai lease worker chồng nhau 205 s; reviewer `APPROVE` cả hai; task B integrate trước, task A sau (tuần tự); 3 cổng người duyệt; cả hai `TASK_VERIFIED`; 11 phút. |

