# Spec — Squad P3: Pipeline khai báo, vai thay tên CLI, cổng duyệt của người dùng

> Ngày: 2026-11-01 · Nhánh: `3.2.0` · Trạng thái: **spec để code**, chia 5 sub-phase (P3a–P3e), mỗi sub-phase một commit.
> Căn cứ: [`SQUAD-ARCHITECTURE-PLAN.md`](SQUAD-ARCHITECTURE-PLAN.md) §3.3 (pipeline), §3.4 (hình sao), D5, D8, D14, D15, D18; các phần chuyển từ P1b ([`SPEC-SQUAD-P1-RUNTIME-REGISTRY.md`](SPEC-SQUAD-P1-RUNTIME-REGISTRY.md) §10) và từ P2 (V10, Q5).
> Đây là pha chạm vào lõi dual nhiều nhất. Nguyên tắc xuyên suốt: **không đổi định dạng ledger đã ghi, không đổi tên state, session đang chạy phải resume được**.

---

## 0. Mục tiêu & phạm vi

### 0.1 Mục tiêu

1. `.omni/squad/pipeline.yaml` mô tả luồng: phase → vai → cổng. Có preset `dual` (khớp hành vi hiện tại) và `squad` (thêm reviewer cho phase `qc`).
2. **Vai thay tên CLI** trong plan và route: `owner: worker | orchestrator`. Dữ liệu cũ (`codex`, `agy`, `gemini`) vẫn đọc được.
3. **Worker chạy bằng bất kỳ runtime nào đã gắn** qua adapter của registry: agy như hiện nay, và **codex làm worker** (adapter đã có từ P1). Từ đây, P4 (OpenCode) chỉ cần thêm adapter.
4. Gom các chỗ dựng lệnh gọi CLI và các probe còn lại về adapter: builder argv của dual và `lib/harness/providers`, probe agy trong `capability-preflight`, probe codex trong `daemon-ports`.
5. **Cổng duyệt D8 của người dùng**: duyệt spec, duyệt plan, và trước integrate. AUTO chỉ bỏ qua cổng có `auto_ok`; **cổng trước integrate không bao giờ bỏ qua được**, và agent không tự duyệt được.
6. Sửa các lỗi thật tìm thấy ở P1/P2: effort của agy (V10), `denied_actions` (Q5), model Claude qua agy.
7. `omni squad` là lệnh chính; `omni dual …` thành alias (D14).

### 0.2 Ngoài phạm vi P3

| Việc | Pha |
|---|---|
| Vai reviewer **chạy thật** (root riêng, lượt headless QC) | P5 — P3 chỉ khai báo trong pipeline preset `squad` và validate |
| Nhiều worker song song | P5 |
| Adapter OpenCode | P4 |
| Engine tổng quát cho phase tùy ý (vd. `design`) | sau 3.2.0 — P3 chỉ chạy pipeline mà engine dual hiểu (§2.3) |
| Đổi tên nội bộ `DUAL_*`, `dual-authority`, tên state | ngoài 3.2.0 (D14) |

### 0.3 Bất biến

- **Ledger append-only, hash-chain**: không sửa event cũ; event mới chỉ thêm field tùy chọn hoặc giá trị enum mới; reader chấp nhận cả cũ lẫn mới.
- **Tên state giữ nguyên.** `AGY_SCOUT`, `AGY_IMPLEMENT`, `AGY_REVIEW` hiểu là "phase của vai worker"; `CODEX_IMPLEMENT`, `CODEX_QC` là "phase của vai orchestrator". Bảng ánh xạ ở §3.2.
- Session/task tạo trước P3 resume được và chạy tiếp đúng hành vi cũ.
- Project không có `.omni/squad/` → dual chạy y như trước P3 (trừ cổng integrate, §5.5).
- `npm test` xanh trên macOS + một lượt chạy dưới tải.

---

## 1. Hiện trạng đã khảo sát (2026-11-01)

| # | Hiện trạng | Vị trí |
|---|---|---|
| H1 | Có **hai tầng máy trạng thái**: tầng phiên `DISCOVERED → CAPABILITY_SAFE → INTERVIEWING → PLANNED → EXECUTING → ACCEPTANCE → VERIFIED` (+`BLOCKED`); tầng task `REGISTERED → ROUTED → AGY_SCOUT → AGY_IMPLEMENT → SCOPE_VALID → AGY_REVIEW → CODEX_QC → TASK_VERIFIED` (nhánh `CODEX_IMPLEMENT`). Bên trong một lần chạy worker, `orchestrator.js` còn máy riêng `NEW → preflight → scout → spec → route → implement → scope → review → codex_qc` | `lib/dual/contracts.js:510`, `orchestrator.js:747` |
| H2 | Owner gắn tên CLI ở nhiều chỗ: plan `owner: codex|agy`, route `owner: codex|gemini`, luật "agy ≤ 10 file", "isolated chỉ cho agy" | `contracts.js:101,131,143,322,855,884` |
| H3 | Orchestrator (Codex) điều khiển daemon qua 14 MCP tool `omni_dual_*` (begin, register_plan, status, quality, completion, resume, acceptance_*, session_block, coverage_inspect/approve) | `lib/dual/mcp-server.mjs` |
| H4 | **Integrate xảy ra khi Codex gọi `omni_dual_completion` (isolated_qc)** — không có cổng chờ người dùng | `mcp-server.mjs:1069`, `isolated-qc.js` |
| H5 | **Agent tự duyệt được spec coverage** qua MCP `omni_dual_coverage_approve` | `mcp-server.mjs:822` |
| H6 | Dựng argv rải rác: `agy-runner.buildAgyInvocation`, `discussion/live-agy-invoke`, `discussion/live-codex-invoke`, `lib/harness/providers/host-cli.buildCommand` | — |
| H7 | Dual **luôn truyền `--effort`** cho agy và **bắt buộc có effort** (`workerConfigurationError`) → với model Claude qua agy luôn lỗi; với model có hậu tố mức, effort phải trùng hậu tố (V10) | `agy-model.js:91`, `agy-runner.js:79`, `live-agy-invoke.js` |
| H8 | `live-agy-invoke` tìm `denied_actions` ở `usage.denied_actions`, nhưng output thật của agy 1.4.12 đặt **`denied_actions` ở cấp ngoài cùng** (V6) → nhánh "denial-aware nudge" không bắt được trường hợp thật | `live-agy-invoke.js:399` |
| H9 | Probe agy trong `capability-preflight` có `prespawnGuard`, mã retry `EAGAIN/EMFILE/ENFILE`, regex version chặt; probe codex trong `daemon-ports` chấp nhận model ẩn trong cache | P1 §10 |

---

## 2. Pipeline khai báo (P3a)

### 2.1 File `.omni/squad/pipeline.yaml` (commit, D9)

```yaml
schema_version: 1
preset: dual
phases:
  - { id: spec,      role: orchestrator, gate: human, auto_ok: true }
  - { id: plan,      role: orchestrator, gate: human, auto_ok: true }
  - { id: scout,     role: worker }
  - { id: implement, role: worker }
  - { id: review,    role: worker }
  - { id: qc,        role: orchestrator, on_needs_fix: implement, max_corrections: 3 }
  - { id: integrate, role: orchestrator, gate: human-always }
```

- Parse bằng `lib/squad/yaml.js` (P2a), validate zod (`strict`).
- `gate`: không có | `human` (chờ người dùng; AUTO bỏ qua nếu `auto_ok: true`) | `human-always` (không bao giờ bỏ qua). `auto_ok` chỉ hợp lệ với `gate: human`.
- `role` phải là vai đã định nghĩa trong `.omni/squad/roles/`. Khi có `pipeline.yaml`, **pipeline là nguồn duy nhất cho chủ phase**. Trường `phases` trong file vai (P2) chỉ còn dùng khi chưa có pipeline. Vì vậy project đã setup ở P2 (vd. repo này, `worker.yaml` có `correction` nhưng không có `review`) không phải sửa file vai. Phase `correction` của P2 tương ứng với `on_needs_fix: implement` của pipeline.
- Preset `squad`: giống `dual` nhưng `qc.role: reviewer` (validate được, **chưa chạy được tới P5**; engine từ chối với `SQUAD_PIPELINE_ENGINE_UNSUPPORTED`).

### 2.2 Bản mẫu

`templates/squad/pipelines/dual.yaml`, `templates/squad/pipelines/squad.yaml`. `omni squad setup` chép `pipeline.yaml` theo preset nếu chưa có (không ghi đè). Skill catalog (P2) lấy chủ phase `qc` từ pipeline thay cho luật tạm của P2 (`phaseOwners`).

### 2.3 Engine hỗ trợ gì ở P3

Engine dual hiện là máy trạng thái cố định (H1). P3 **không** viết lại engine; P3 cho engine **đọc** từ pipeline:
- vai sở hữu từng phase (thay cho tên CLI ở H2),
- cổng duyệt (§5),
- `max_corrections` (thay hằng số hiện có).

`assertEngineSupports(pipeline)`: thứ tự phase phải đúng `spec, plan, scout, implement, review, qc, integrate`; `scout/implement/review` thuộc `worker`; `spec/plan/integrate` thuộc `orchestrator`; `qc` thuộc `orchestrator` (P5 mở `reviewer`). Sai → `SQUAD_PIPELINE_ENGINE_UNSUPPORTED` kèm phase lệch. Engine tổng quát (thêm/bớt phase) để sau 3.2.0.

### 2.4 Lệnh

`omni squad pipeline` — in pipeline đang dùng, cổng, và kết quả `assertEngineSupports`.

---

## 3. Vai thay tên CLI (P3b)

### 3.1 Contract

| Chỗ | Trước | Sau P3 |
|---|---|---|
| Plan task `owner` | `codex \| agy` | `orchestrator \| worker`; đọc thêm `codex → orchestrator`, `agy → worker` |
| Route `owner` | `codex \| gemini` | `orchestrator \| worker`; đọc thêm `codex`, `gemini → worker` |
| Luật "agy ≤ 10 file", "isolated chỉ cho agy" | theo tên CLI | theo vai `worker` |
| Event ledger | ghi `owner: 'agy'` | event **mới** ghi tên vai; event cũ giữ nguyên, reader chuẩn hóa qua `normalizeOwner()` |

- `normalizeOwner(value)` ở một chỗ duy nhất (`lib/dual/contracts.js`), dùng ở mọi reader. Không viết lại ledger.
- Workflow sinh plan (`templates/workflows`, prompt `om-plan` của dual) đổi sang `owner: worker|orchestrator`.

### 3.1b Cách làm thực tế (P3b, 2026-11-01) — lệch so với 3.1

Khảo sát lúc code: token `codex`/`agy`/`gemini` xuất hiện ở ~117 chỗ so sánh trong `lib/dual/` và nằm trong ledger có chuỗi hash. Đổi event mới sang tên vai thì mọi reader phải hiểu hai dạng và replay phải chuẩn hóa, rủi ro cao mà không thêm giá trị. Nên:

- **Token cũ giữ làm mã nội bộ của "chỗ"**: `codex` = chỗ orchestrator, `agy` (plan, ledger) / `gemini` (route) = chỗ worker. Ledger và mọi event giữ nguyên, không cần replay chuẩn hóa.
- **Đầu vào nhận tên vai**: `PlanOwnerSchema` (plan task, MCP `register_plan`) nhận `orchestrator|worker|codex|agy`; route nhận `orchestrator|worker|codex|gemini|agy`. Quy về mã nội bộ tại `normalizePlanOwner` / `normalizeRouteOwner` (`lib/dual/contracts.js`). Enum đầu vào liệt kê đủ để danh sách tool MCP quảng bá tên vai.
- **Đầu ra hiện tên vai**: MCP `status` thêm `owner_role`; CLI in `worker (agy)` qua `ownerLabel`. Daemon vẫn chỉ nói mã nội bộ — `status` từ chối tên vai từ daemon (fail closed như cũ).
- Runtime thật lấp chỗ worker do binding quyết định (P3c), không do token.
- Workflow `task-planning.md` dạy `owner: "worker"`; plan cũ `"agy"` vẫn hợp lệ, parse ra y hệt.
- Luật "≤ 10 file", "isolated chỉ cho worker" giữ nguyên code vì đã gắn vào chỗ `agy` = vai worker.

### 3.2 Bảng ánh xạ state (tên giữ nguyên)

| State | Nghĩa từ P3 |
|---|---|
| `AGY_SCOUT` | worker đang chạy phase `scout` (runtime bất kỳ) |
| `AGY_IMPLEMENT` | worker đang chạy phase `implement` |
| `AGY_REVIEW` | worker đang chạy phase `review` |
| `CODEX_IMPLEMENT` | orchestrator tự làm task (task `owner: orchestrator`) |
| `CODEX_QC` | chủ phase `qc` đang QC (orchestrator ở P3; reviewer ở P5) |

Ghi bảng này vào `docs/` và comment cạnh `TaskAuthorityStateSchema`.

---

## 4. Worker chạy qua adapter (P3c)

### 4.1 Mở rộng contract runtime (P1)

Thêm method tùy chọn cho runtime có `headless`:

```js
parseResult(raw, { phase, expectedSchema }) → {
  completion: 'succeeded' | 'failed' | 'unknown',
  payload,            // object khớp schema phase, hoặc null
  sessionRef,         // conversation/thread id để resume
  deniedActions,      // [] nếu không có
  usage,              // { inputTokens, outputTokens, thinkingTokens } | null
  errorCode,          // mã ổn định khi failed
}
```

- **agy**: đọc JSON `-p --output-format json`: `status`, `response`/structured output, `conversation_id`, `usage`, **`denied_actions` ở cấp ngoài cùng**. `denied_actions` khác rỗng → `completion: 'failed'`, `errorCode: 'SQUAD_RUNTIME_DENIED_ACTIONS'` (Q5), kể cả khi `status: SUCCESS`.
- **codex**: đọc JSONL `--json` (`thread.started` → `sessionRef`, `item.completed`/agent message → payload, `turn.completed|turn.failed`, usage). Với `--output-schema`, payload là message cuối.
- Conformance: runtime có `headless` phải có `parseResult`; test bằng output thật đã ghi lại (fixture) của từng CLI.

### 4.2 Dual dùng adapter

| Call site | Thay đổi |
|---|---|
| `agy-runner.buildAgyInvocation` (isolated implement) | Thành wrapper gọi `runtime.buildHeadless` của **runtime đã gắn cho worker**, `permission: 'full-auto'`, `isolatedRoot: true`; giữ tên/chữ ký cũ để không vỡ caller; test golden đảm bảo argv agy **trùng byte** với hiện tại, trừ phần effort sửa theo V10 |
| `discussion/live-agy-invoke`, `live-codex-invoke` | Dựng argv bằng `buildHeadless`/`buildResume`; phân loại kết quả bằng `parseResult`; sửa H8 |
| `agy-model.workerConfigurationError` | Effort **không còn bắt buộc**: bắt buộc khi model có danh sách effort > 1; cấm khi model không nhận effort (Claude qua agy); model có hậu tố mức → không truyền `--effort` (sửa H7) |
| `capability-preflight` (probe agy) | Gọi `runtime.version/listModels` với ctx có `prespawnGuard`; adapter trả kèm `raw` để preflight giữ mã retry và regex chặt của mình (yêu cầu mở rộng §4.3) |
| `discussion/daemon-ports` (probe codex) | `codex.listModels({ includeHidden: true })` để giữ hành vi chấp nhận model ẩn |
| `lib/harness/providers/host-cli` | Nhánh `codex`/`antigravity` dựng argv bằng adapter; nhánh claude/gemini/opencode giữ nguyên tới P4 |

### 4.3 Mở rộng probe của adapter (chuyển từ P1b)

- `ProbeContext.prespawnGuard`: `runProbe` gọi trước mỗi spawn (giống `spawnBoundedProcess`).
- Kết quả probe có thêm `raw` (kết quả spawn gốc, gồm symbol mã tài nguyên) để caller cũ phân loại retry.
- `codex.listModels({ includeHidden })`.
- Test parity P1b (`squad-legacy-parity`) mở rộng: preflight sau khi nối vẫn cho đúng `checks[]` như trước trên các fixture cũ.

### 4.4 Codex làm worker

- `engineSupport` (P2 bindings) bỏ điều kiện "worker phải là agy": worker ∈ runtime có `headless`, `write`, `parseResult`.
- Worker codex chạy trong worker root với `full-auto` + `-c project_root_markers=[]` (đã có ở P2b) + `--output-schema` theo phase.
- Scout/review của worker codex đi qua discussion transport hiện có (codex adapter discussion đã có `live-codex-invoke`).
- D18: orchestrator và worker cùng codex → hai session riêng; resume luôn bằng session id của vai; cảnh báo chung quota (đã có ở P2).

---

## 5. Cổng duyệt của người dùng (P3d)

### 5.1 Ledger

Event mới (append-only):

```
gate.requested  { gate_id, phase, task_id?, plan_revision, digest, requested_at }
gate.approved   { gate_id, actor: 'human', via: 'cli-tty', approved_at, digest }
gate.rejected   { gate_id, actor: 'human', reason, rejected_at }
```

- `digest` gắn với đúng nội dung được duyệt (spec digest, plan revision + digest, hoặc `resultSha256` của task). Nội dung đổi sau khi duyệt → cổng mở lại.
- Engine không chuyển qua phase sau cổng khi chưa có `gate.approved` khớp digest.

### 5.2 Ba cổng mặc định (D8)

| Cổng | Khi nào | AUTO |
|---|---|---|
| `spec` | trước khi đăng ký plan (thay cho/ bọc `coverage approve` hiện tại) | bỏ qua nếu `auto_ok: true` |
| `plan` | sau `register_plan`, trước khi route task đầu tiên | bỏ qua nếu `auto_ok: true` |
| `integrate` | sau QC `TASK_VERIFIED`, **trước** khi ghi vào source | **không bao giờ** bỏ qua |

### 5.3 Cách người dùng duyệt — agent không tự duyệt được

- Lệnh: `omni squad approve [<gate_id>] [--reject --reason …]`. Không có `gate_id` → liệt kê cổng đang chờ, kèm tóm tắt và digest.
- **Chỉ chạy khi stdin là TTY** và người dùng gõ lại mã xác nhận ngắn in trên màn hình. Lệnh chạy không có TTY (cách agent chạy shell) bị từ chối với `SQUAD_GATE_TTY_REQUIRED`.
- **Không có MCP tool để duyệt cổng.** MCP `omni_dual_status` trả `awaiting_gate: { gate_id, phase, summary, how: "Người dùng chạy: omni squad approve <id>" }` để orchestrator báo cho người dùng.
- `omni_dual_coverage_approve` (H5): khi project có squad, tool này **chỉ được chuẩn bị** bản duyệt (ghi `gate.requested` cho cổng `spec`), không tự duyệt được nữa. Project không squad giữ hành vi cũ.
- Hook của Codex (hook-bridge, đã có) thêm luật chặn lệnh shell khớp `omni squad approve` / `omni dual approve`, làm lớp phòng thủ thứ hai.
- Mô hình đe dọa: chặn **tự duyệt nhầm hoặc theo thói quen** của agent; không nhằm chống một agent chủ động giả lập TTY. Ghi rõ trong tài liệu.

### 5.4 UI P6

UI `omni ui` (P6) sẽ có nút duyệt gọi cùng RPC phía daemon, yêu cầu token phiên của UI. P3 chỉ làm đường CLI.

### 5.5 Project không squad

Cổng `integrate` **cũng áp dụng** cho dual không squad, vì đây là quyết định an toàn D8 cho mọi người dùng 3.2.0. Thông báo đổi hành vi ghi vào CHANGELOG. Cổng `spec`/`plan` chỉ áp dụng khi có pipeline.

---

## 6. `omni squad` là lệnh chính (P3e)

- Thêm `omni squad run|status|resume|approve|pipeline` tương ứng các lệnh `omni dual` cùng chức năng.
- `omni dual …` giữ nguyên, in một dòng gợi ý "alias của omni squad (preset dual)".
- MCP server giữ tên tool `omni_dual_*` (đổi tên là thay đổi phá vỡ cho config Codex đã sinh); thêm mô tả nhắc tên mới.

---

## 7. Câu hỏi mở (cần chốt trước khi code phần liên quan)

| # | Câu hỏi | Đề xuất |
|---|---|---|
| Q-P3-1 | Cổng `integrate` áp dụng cả dual không squad (§5.5)? | **Đã chốt 2026-11-01: có** — đúng tinh thần D8; ghi CHANGELOG |
| Q-P3-2 | Mức bảo vệ cổng: TTY + mã xác nhận + hook chặn đủ chưa, hay cần ký bằng khóa riêng của người dùng? | **Đã chốt: TTY + mã + hook cho 3.2.0**; ký khóa để sau |
| Q-P3-3 | Có làm codex-làm-worker ngay P3 (§4.4) hay để P4 cùng OpenCode? | **Đã chốt: ngay P3** — phép thử đầu tiên rằng worker không còn gắn agy |
| Q-P3-4 | `omni_dual_coverage_approve` (H5) với project squad: bỏ hẳn hay chỉ "chuẩn bị"? | **Đã chốt: chỉ chuẩn bị** (§5.3) để Codex vẫn trình được coverage cho người dùng |

---

## 8. Phải kiểm trước khi code

| # | Cần kiểm | Cách |
|---|---|---|
| V12 | `codex exec --json --output-schema <file>`: định dạng JSONL (tên event, nơi chứa message cuối, usage, id thread) trên 0.166.0 | chạy thật 1 lượt rẻ (`gpt-6-luna`, `low`, `-s read-only`), lưu fixture |
| V13 | agy `-p --output-format json --json-schema <file>`: payload có cấu trúc nằm ở đâu (`response` dạng chuỗi JSON hay field riêng) | chạy thật 1 lượt rẻ, lưu fixture |
| V14 | agy `denied_actions`: vị trí và dạng phần tử ở chế độ `--json-schema` (V6 chỉ đo không có schema) | kèm V13, yêu cầu hành động bị từ chối |
| V15 | Hook của Codex 0.166.0 có chặn được lệnh shell theo mẫu (PreToolUse/BeforeShell…) không, hook-bridge hiện dùng sự kiện nào | tài liệu Codex qua Context7 + đọc `lib/dual/hook-bridge.js` |
| V16 | Codex chạy lệnh shell có TTY không (để chắc `SQUAD_GATE_TTY_REQUIRED` chặn được) | chạy `codex exec` yêu cầu `test -t 0 && echo tty || echo notty` trong thư mục tạm, `-s read-only` |

Kết quả ghi vào phụ lục spec này trước commit đầu của P3c/P3d.

---

## 9. Sub-phase & commit

| Commit | Nội dung | Phụ thuộc |
|---|---|---|
| `feat(squad): declarative pipeline with dual/squad presets (P3a)` | §2 + template + `omni squad pipeline` + catalog lấy chủ `qc` từ pipeline | P2 |
| `refactor(dual): role-based owners with legacy owner normalization (P3b)` | §3 | P3a |
| `feat(dual): run workers through runtime adapters (P3c)` | §4 (gồm sửa H7, H8, probe P1b, codex làm worker) | P3b, V12–V14 |
| `feat(dual): human approval gates for spec, plan and integrate (P3d)` | §5 | P3a, V15–V16 |
| `feat(squad): omni squad as the primary command (P3e)` | §6 | P3d |

---

## 10. Test

- **P3a**: schema pipeline (gate/auto_ok/role/phase), `assertEngineSupports` với preset dual (qua) và squad (từ chối có mã), pipeline sai thứ tự; catalog lấy chủ `qc` từ pipeline.
- **P3b**: `normalizeOwner` cho mọi giá trị cũ/mới; **replay ledger cũ** (fixture từ test dual hiện có) → state và owner như trước; plan mới ghi tên vai; luật "≤ 10 file"/"isolated" theo vai.
- **P3c**: golden argv agy trùng byte với `buildAgyInvocation` cũ (trừ effort theo V10); `parseResult` của agy/codex trên fixture thật V12–V14; `denied_actions` cấp ngoài cùng → failed; model Claude qua agy chạy được (không `--effort`); preflight giữ `checks[]`, mã retry, `prespawnGuard`; một task trọn vòng với **worker codex** (worker giả lập phát JSONL codex) qua isolated-runner thật.
- **P3d**: thiếu `gate.approved` → không qua; digest đổi → cổng mở lại; AUTO bỏ qua `spec/plan` có `auto_ok`, **không** bỏ `integrate`; `omni squad approve` không TTY → `SQUAD_GATE_TTY_REQUIRED`; MCP không có tool duyệt; `omni_dual_completion` dừng ở `AWAITING_HUMAN_APPROVAL` trước integrate; session cũ resume được.
- **P3e**: `omni squad run/status` và `omni dual run/status` cho cùng kết quả.
- Toàn bộ: `npm test` + một lượt `--test-concurrency=4`.

---

## 11. Điều kiện xong P3 (DoD)

- [ ] Preset `dual` chạy trọn vòng **qua daemon thật** với codex + agy thật trên fixture nhỏ: spec → (cổng) → plan → (cổng) → scout/implement/review → QC → **dừng ở cổng integrate** → người dùng duyệt qua TTY → integrate.
- [ ] Cùng fixture với **worker codex** (binding codex cho cả hai vai, D18): chạy trọn vòng.
- [ ] Session dual tạo trước P3 resume được.
- [ ] `npm test` xanh trên macOS + một lượt dưới tải.
- [ ] Phụ lục V12–V16 đã ghi.
- [ ] Linux/Windows thật: hoãn (SQUAD-ARCHITECTURE-PLAN §11).

---

## Phụ lục — Kết quả kiểm V12–V16 (2026-11-01)

Máy kiểm: macOS arm64, `codex-cli 0.166.0`, `agy 1.4.12`; model rẻ (`gpt-6-luna`/`low`, `gemini-3.8-flash-low`), thư mục tạm đã xóa. Output thật lưu ở `test/fixtures/squad-cli/` để làm fixture cho test `parseResult` của P3c.

| # | Kết quả | Ảnh hưởng |
|---|---|---|
| V12 | `codex exec --json --output-schema` → JSONL 4 sự kiện: `thread.started` (`thread_id` = session ref), `turn.started`, `item.completed` với `item.type: "agent_message"` và **payload theo schema nằm trong `item.text` dưới dạng chuỗi JSON**, `turn.completed` có `usage` (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`). Lệnh shell xuất hiện thành `item.type: "command_execution"` với `aggregated_output`. Lưu ý: chạy tay phải đóng stdin (`< /dev/null`), nếu không codex chờ đọc thêm. | `codex.parseResult`: payload = `JSON.parse` của `agent_message.text` cuối cùng; `sessionRef` = `thread_id`; `turn.failed` → failed |
| V13 | agy `-p --output-format json --json-schema` → JSON một object: `status: "SUCCESS"`, `conversation_id`, `response` (cùng nội dung dạng chuỗi), **`structured_output` (object đã parse)**, `json_schema`, `usage` (`input_tokens`, `output_tokens`, `thinking_tokens`, `cache_read_tokens`, `total_tokens`). | `agy.parseResult`: payload = `structured_output`; không có thì thử parse `response` |
| V14 | agy bị từ chối quyền (yêu cầu chạy `ls` ở `--mode accept-edits`, không bỏ quyền): exit 0, `status: "SUCCESS"`, `response: ""`, **không có `structured_output`**, **`denied_actions: [{ action: "command", display_name: "RunCommand" }]` ở cấp ngoài cùng**; stderr có gợi ý `permissions.allow`. | Khẳng định H8 và Q5: `denied_actions` khác rỗng → `completion: failed`, `SQUAD_RUNTIME_DENIED_ACTIONS` |
| V15 | Hook `PreToolUse` của Codex chặn được lệnh: stdout `{"hookSpecificOutput":{"permissionDecision":"deny",…}}` hoặc `{"decision":"block","reason":…}`, hoặc exit 2 kèm lý do ở stderr; input hook có `tool_name`, `tool_input.command`. **Fail-open**: hook lỗi, hết giờ, exit khác 0/2 hoặc JSON hỏng → lệnh vẫn chạy. `lib/dual/hook-bridge.js` đã xử lý `PreToolUse` và nhánh `deny`. | Luật chặn `omni squad approve` đặt ở hook-bridge; matcher phải phủ **mọi** công cụ chạy shell của Codex (Bash/`exec_command`/unified exec), và hook-bridge phải trả `deny` chắc chắn cho mẫu này (không để rơi vào nhánh lỗi → fail-open) |
| V16 | Ở `codex exec` (headless), lệnh shell **không có TTY** (`STDIN_NOTTY`, `STDOUT_NOTTY`). Nhưng tài liệu Codex cho thấy bộ chạy lệnh hỗ trợ `tty: true` (PTY) — trong phiên tương tác, agent **có thể** mở PTY. | **Điều kiện TTY + mã xác nhận chỉ chặn chạy nhầm, không chặn agent cố ý** (agent trong PTY thấy mã và gõ lại được). Hàng rào chính là hook (V15). Rủi ro còn lại: hook fail-open hoặc project chưa trust hook → ghi rõ trong mô hình đe dọa §5.3; đường duyệt mạnh hơn là UI P6 (token phiên chỉ người dùng có) |
