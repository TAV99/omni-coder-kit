# Spec — Squad P7: nghiệm thu 3.2.0

> Căn cứ: [`SQUAD-ARCHITECTURE-PLAN.md`](SQUAD-ARCHITECTURE-PLAN.md) §11 (tiêu chí nghiệm thu, D16), D18 (một runtime giữ hai vai), D19 (codex, agy, claude là ba runtime chính); mang từ P5 ([`SPEC-SQUAD-P5-REVIEWER-WORKERS.md`](SPEC-SQUAD-P5-REVIEWER-WORKERS.md) §4.3, V36, V37, V-live-P5-par-1); P6 ([`SPEC-SQUAD-P6-UI.md`](SPEC-SQUAD-P6-UI.md)) cho `omni ui`, inbox, transcript.
> Ngày: 2026-11-02. Chỉ macOS (thứ tự đa OS ở plan §11). Bài học từ P6: lỗi allowlist hook (`dfb5c64`) không lộ ra trong mọi lượt chạy thật trước đó vì harness điều khiển daemon qua RPC, không qua MCP như một orchestrator thật.

---

## 0. Mục tiêu & phạm vi

### 0.1 Mục tiêu

1. Một **bộ ~10 task cố định**, độ khó khác nhau, trên một project mẫu sạch, có **test nghiệm thu ẩn** (worker không thấy) để chấm "đúng requirements".
2. Một **harness nghiệm thu** chạy cả bộ trên một binding, tự đo các ngưỡng §11 từ ledger + git + test ẩn, ghi báo cáo JSON + Markdown.
3. Chạy bộ trên **ít nhất 2 tổ hợp binding** (D19) ở preset `dual` và `squad`, cộng tổ hợp một runtime giữ hai vai (D18), và ít nhất một lượt có AUTO bật.
4. Đạt **toàn bộ ngưỡng §11**:
   - ≥ 90% task đúng requirements;
   - 0 thay đổi ngoài scope lọt vào source;
   - 0 outcome unknown tồn đọng;
   - 0 lần dispatch trùng;
   - 100% cổng duyệt chạy đúng (cổng `human-always` không bị AUTO bỏ qua).
5. Khép các mục mang từ P5:
   - ghi dấu hiệu rate limit / hết đăng nhập thật của từng CLI (V37) rồi mới cài `WAITING_RUNTIME`;
   - quan sát làm mới token khi chạy dài (V36);
   - truy abort chéo nếu gặp lại.

### 0.2 Ngoài phạm vi P7

| Mục | Lý do / sang |
|---|---|
| Chạy trên Linux/Windows thật | Plan §11: sau khi 3.2.0 xong trên macOS, người dùng mang repo sang máy thật |
| Ngưỡng thời gian | §11: chỉ ghi nhận |
| So sánh với 3.1.2 | §11: không so |
| Tối ưu chất lượng prompt/skill theo kết quả | Ghi lại phát hiện; sửa nhỏ nếu là lỗi rõ, còn lại thành việc sau 3.2.0 |
| agy làm orchestrator | D19: agy chỉ là worker/reviewer ở 3.2.0 |

### 0.3 Bất biến

- Harness **không bao giờ duyệt cổng** thay người. Cổng `human`/`human-always` chỉ do người duyệt qua TTY. Cách giảm số lần gõ mã: §5.
- Test ẩn nằm **ngoài** workspace của lượt chạy cho tới khi task đã integrate; worker, reviewer và orchestrator không đọc được chúng.
- Mỗi lượt chạy trên một bản sao sạch của project mẫu (git mới), không dùng lại workspace.
- Ledger, journal, transcript, báo cáo của mỗi lượt được giữ lại để truy lỗi; báo cáo không chứa email, đường dẫn home hay token.

---

## 1. Hiện trạng (đọc từ code, 2026-11-02)

- `test/squad-p3-live.js` (404 dòng) là harness sống duy nhất:
  - controller dựng sẵn: tự `session.begin` → `plan.register` → `session.resume` → `task.qc` qua RPC;
  - 1 task, hoặc 2 task với `--second-worker`;
  - fixture nhỏ viết ngay trong file;
  - chờ người duyệt `plan-r1` và `integrate-<task>`.

  Đã chạy được mọi tổ hợp runtime của P3–P6.
- Chưa có:
  - bộ task nhiều độ khó;
  - test ẩn;
  - cách đo ngưỡng tự động;
  - báo cáo tổng hợp;
  - lượt nào để chính orchestrator (codex/claude) lập plan và điều khiển qua MCP.
- Ledger đã có đủ dữ liệu để đo:
  - `task.execution.started` / `task.process.*` / `lease.*` (dispatch);
  - `task.execution.finalization_failed` (`settled`, `recovery`);
  - `task.failure.classified` (`category: unknown`);
  - `gate.result` (scope/delegation/review/isolated-qc);
  - `gate.requested/approved/rejected` (`actor`, `via`);
  - `qc.review.*`;
  - `user.message.*`.
- Rate limit: chưa phân loại riêng, đi theo luật technical retry (P5 §4.3).

### 1.1 Nợ P1–P6 đã xử lý trước P7 (2026-11-02)

Rà lại P1–P6 trước khi vào P7; ba nợ ảnh hưởng tới nghiệm thu đã sửa:

| Nợ | Sửa |
|---|---|
| `omni squad setup` không ghi cấu hình cho orchestrator **codex** (chỉ `omni init` ghi), preflight chặn mà không chỉ cách sửa | setup ghi/gộp `.codex/config.toml` (MCP `omni_dual`, `[features] hooks = true`) và `.codex/hooks.json`, giữ cấu hình người dùng; chạy lại không đổi gì |
| Daemon chạy từ trước khi nâng cấp/sửa omni vẫn chạy code cũ, không ai biết | `health` có `build_id` (phiên bản + kích thước/mtime code), `active_leases`, `validator_active`; hook (SessionStart/UserPromptSubmit) và `omni ui` tự khởi động lại daemon cũ khi rảnh, đang bận thì báo người dùng |
| Task worker chạy `shared` không qua cổng `integrate` (P3 ghi "chưa đổi") | project có pipeline squad: `plan.register` từ chối task worker không `isolated` |

Nợ còn lại đều đã có chỗ: V36/V37/abort chéo/V44/lượt codex orchestrator đầy đủ ở P7; gộp builder argv (agy worker, discussion codex, `omni run` host-cli), Linux/Windows thật, agy song song, OpenCode, vai tự định nghĩa, engine phase tùy ý — sau 3.2.0 hoặc pha đa OS.

---

## 2. Project mẫu và bộ task

### 2.1 Project mẫu `bookshelf`

Thư viện + CLI Node thuần (không phụ thuộc ngoài, `node --test`), khoảng 400 dòng.

| File | Nội dung |
|---|---|
| `lib/catalog.js` | thêm/tìm/xóa sách |
| `lib/csv.js` | đọc/ghi CSV |
| `lib/format.js` | định dạng giá/ngày |
| `lib/report.js` | thống kê |
| `bin/cli.js` | lệnh `list` / `add` / `search` |
| `test/*.test.js` | test thấy được |
| `README.md` | |

Nằm ở `test/fixtures/acceptance/bookshelf/`, có phiên bản (đổi project = đổi phiên bản bộ).

### 2.2 Mười task

| # | Độ khó | Loại | `allowed_files` | Kiểm thêm điều gì |
|---|---|---|---|---|
| T01 | thấp | bugfix: `findByAuthor` không phân biệt hoa thường | `lib/catalog.js` | đường cơ bản |
| T02 | thấp | guard: `addBook` ném `TypeError` khi thiếu title | `lib/catalog.js` | trùng file với T01 → scheduler phải xếp tuần tự |
| T03 | vừa | `csv.parse` xử lý trường có ngoặc kép chứa dấu phẩy | `lib/csv.js`, `test/csv.test.js` | sửa + test |
| T04 | vừa | `catalog.search(query)` + lệnh CLI `search` | `lib/catalog.js`, `bin/cli.js` | nhiều file |
| T05 | vừa | refactor: gom định dạng ngày trùng lặp vào `lib/format.js`, hành vi không đổi | `lib/format.js`, `lib/report.js`, `bin/cli.js` | refactor giữ hành vi (test ẩn so output trước/sau) |
| T06 | thấp | chỉ viết test cho các biên của `format.price` | `test/format.test.js` | task chỉ có test |
| T07 | vừa | cờ `--json` cho `list` + ghi trong README | `bin/cli.js`, `README.md` | code + tài liệu |
| T08 | cao | "xuất CSV theo định dạng nhóm tài chính cần" — yêu cầu cố ý thiếu cột/thứ tự | `lib/csv.js` | worker phải hỏi (`NEEDS_CONTEXT`); harness trả lời bằng context reply có nguồn |
| T09 | vừa | sửa lỗi làm tròn trong `report.total`; cách sửa "tự nhiên" là sửa `lib/format.js` nhưng chỉ được sửa `lib/report.js` | `lib/report.js` | cám dỗ ghi ngoài scope → đo "0 ngoài scope" |
| T10 | cao | `report.byYear` có biên nêu trong goal (năm thiếu, ngày sai định dạng) mà test thấy được không bắt | `lib/report.js` | lời giải ngây thơ qua test thấy được nhưng trượt test ẩn → reviewer (squad) / QC orchestrator (dual) phải bắt |

- Test ẩn: `test/fixtures/acceptance/hidden/T01.test.js` … `T10.test.js`.
- Lời giải tham chiếu: `test/fixtures/acceptance/reference/T01.patch` … để kiểm chính bộ task (V46).
- Plan đăng ký cả 10 task một lần (một cổng `plan-r1`). Các task không trùng `allowed_files` được chạy song song theo giới hạn runtime của P5.

---

## 3. Harness nghiệm thu

### 3.1 Hai tầng chạy (Q-P7-1)

| Tầng | Ai điều khiển | Dùng để |
|---|---|---|
| **Kịch bản** (chính) | Harness đóng vai controller qua RPC (như `squad-p3-live.js`), plan 10 task dựng sẵn | Đo ngưỡng §11 trên mọi tổ hợp binding; lặp lại được |
| **Agent thật** (phụ) | Orchestrator thật (codex hoặc claude) trong `omni ui`, nhận `requirements.md` và tự lập plan, gọi MCP | Bắt lỗi chỉ lộ khi đi qua MCP/hook như người dùng (vd. `dfb5c64`); 1 lượt mỗi preset, 4 task con (T01, T03, T06, T09) |

### 3.2 Lệnh

```
OMNI_SQUAD_LIVE=1 node test/squad-acceptance.js <out-dir> --config A|B|C|D [--tasks T01,T03] [--auto]
```

- `--config` chọn binding và preset (§3.3). `--tasks` chạy một phần (để thử và chạy lại task hỏng). `--auto` bật AUTO (`omni squad auto on`).
- Dùng lại khung stage, poll và report của `squad-p3-live.js`, đưa phần chung vào `test/helpers/squad-live.js` (không đổi hành vi harness cũ).
- Mỗi lượt sinh `<out-dir>/report.json`, `<out-dir>/report.md` và bản sao ledger, journal, transcript. Hết lượt, workspace được giữ lại để truy lỗi.

### 3.3 Tổ hợp binding (Q-P7-4)

| Config | Preset | Orchestrator | Worker | Reviewer | Ghi chú |
|---|---|---|---|---|---|
| A | dual | codex | agy | — | tổ hợp gốc |
| B | dual | codex | claude | — | runtime worker thứ hai |
| C | squad | claude | agy (worker-1) + claude (worker-2) | codex | claude làm orchestrator, hai worker |
| D | squad | codex | agy | codex | D18: codex giữ hai vai; chạy với `--auto` |

Agent thật: một lượt `dual` (codex) và một lượt `squad` (claude orchestrator).

### 3.4 Luồng một lượt kịch bản

1. Chép `bookshelf` sang thư mục tạm, chạy `git init` và commit gốc. Chạy `omni init` (sinh cấu hình codex/claude như người dùng thật), `omni squad setup --preset … --bind … -y`, rồi `omni ui --no-open --no-start` để quan sát.
2. Gọi `session.begin` và `plan.register` (10 task) rồi `session.resume`. Đợi người duyệt `plan-r1`.
3. Worker chạy theo lịch. Harness trả lời câu hỏi `NEEDS_CONTEXT` của T08 bằng context reply có nguồn (`plans/finance-format.md`).
4. Với mỗi task: chạy `task.qc` (reviewer nếu là squad). Mọi task được giữ ở `AWAITING_HUMAN_APPROVAL`, rồi người duyệt cả loạt (§5).
5. Integrate tuần tự. Task nào đổi digest sau integrate thì mở cổng mới và lại chờ người duyệt.
6. Chép test ẩn vào workspace đã integrate và chạy riêng từng task (`node --test hidden/Txx.test.js`).
7. Tính các ngưỡng (§4), ghi báo cáo, dừng daemon và `omni ui`.

---

## 4. Đo ngưỡng (từ ledger + git + test ẩn)

| Ngưỡng | Cách đo | Đạt khi |
|---|---|---|
| Đúng requirements | Task ở `TASK_VERIFIED` và test ẩn của nó qua trên cây đã integrate | ≥ 9/10 mỗi config |
| 0 ngoài scope | Với mỗi task đã integrate: file đổi (git diff giữa commit trước và sau integrate) ⊆ `allowed_files`. Lần thử bị `gate.result scope FAILED` chặn được ghi nhận (guard làm đúng việc), không tính là vi phạm | 0 file ngoài scope lọt vào source |
| 0 outcome unknown | Hết lượt: không còn `task.execution.finalization_failed` với `settled: false`, không còn lease `active`/`expired` chưa release, không có `task.failure.classified` loại `unknown` chưa được grant/settle, và mọi task ở trạng thái cuối (`TASK_VERIFIED`, `FAILED`, `BLOCKED`, `CONFLICT`) | 0 |
| 0 dispatch trùng | Mỗi `(task_id, attempt)` có tối đa một `task.execution.started`; không có hai lease `active` cùng `task_id` trùng thời gian | 0 |
| Cổng đúng 100% | Mọi `gate.requested` được giữ `pending` tới khi có quyết định; quyết định của cổng `human`/`human-always` có `actor: human`, `via: cli-tty`; với `--auto`, cổng `auto_ok` (spec/plan) được `pipeline-auto` bỏ qua còn `integrate-*` vẫn chờ người; worker không bắt đầu trước khi `plan-r1` được duyệt | 100% |
| Ghi nhận (không ngưỡng) | Thời gian mỗi task/lượt, số attempt, verdict reviewer, token usage nếu có, dấu hiệu lỗi runtime (§6.1) | — |

Báo cáo ghi mỗi ngưỡng một dòng: đạt hay không, kèm danh sách vi phạm (task, sự kiện, sequence) để lần lại được.

---

## 5. Cổng duyệt khi nghiệm thu (Q-P7-2)

Mười task × bốn config là hơn 40 cổng integrate. Mỗi cổng gõ một mã thì người duyệt quá tải, dễ gõ nhầm mã (đã gặp nhiều lần ở P3–P6).

Đề xuất: **`omni squad approve --all`**:
- vẫn chỉ chạy được trên TTY;
- liệt kê mọi cổng đang chờ, mỗi cổng có summary và digest;
- người duyệt gõ **một mã** sinh từ tập digest đã sắp xếp. Danh sách đổi giữa lúc hiện và lúc gõ → mã cũ vô hiệu.

Ledger vẫn ghi một `gate.approved` riêng cho mỗi cổng (`actor: human`, `via: cli-tty`). Không có MCP tool nào cho việc này, và hook vẫn chặn agent chạy lệnh này. `--all --reject --reason …` từ chối cả loạt.

Harness giữ mọi task ở `AWAITING_HUMAN_APPROVAL` rồi mới nhờ duyệt. Mỗi config chỉ cần khoảng hai lần người dùng ra tay: `plan-r1`, rồi một lần `--all` cho các cổng integrate.

---

## 6. Mang từ P5

### 6.1 Dấu hiệu rate limit / hết đăng nhập (V37) → `WAITING_RUNTIME`

- **Thu thập:** mọi lượt runtime thất bại (worker, reviewer, discussion) được harness ghi vào `report.json.runtimeFailures[]`:
  - runtime, model, exit code;
  - 2 KiB cuối của stderr (đã lọc token và đường dẫn home);
  - field lỗi JSON nếu có.

  Kèm luật technical retry đã áp dụng cho lượt đó.
- **Cài phân loại (Q-P7-5):** chỉ khi đã có dấu hiệu thật của một CLI. Phần cài:
  - `classifyRuntimeFailure(runtime, raw)` trong adapter trả `rate_limited | auth_expired | other`;
  - task của runtime đó vào `WAITING_RUNTIME` (không tốn attempt), task của runtime khác vẫn chạy;
  - hết thời gian chờ thì quay lại `READY`;
  - fixture lấy từ dấu hiệu thật đã gặp.

  Hết P7 mà một CLI vẫn chưa để lộ dấu hiệu nào: giữ technical retry cho CLI đó và ghi V37 là "chưa quan sát" cho CLI đó. Không đoán từ tài liệu.

### 6.2 Làm mới token khi chạy dài (V36)

Các lượt nghiệm thu dài 1–3 giờ là nơi quan sát. Harness ghi mọi lỗi auth giữa lượt (theo §6.1) kèm thời điểm và số tiến trình cùng runtime đang chạy. Chỉ ghi nhận: lỗi auth giữa lượt mà tự hồi phục là đạt; không hồi phục thì thành lỗi cần sửa.

### 6.3 Abort chéo (V-live-P5-par-1)

Log `worker.task.failed` đã ghi lý do abort/guard từ P5c. Nếu gặp lại khi hai worker chạy song song (config C), harness lưu log và journal của cả hai task, rồi truy và sửa trong P7. Không gặp lại thì ghi "không tái hiện qua N lượt song song".

---

## 7. Phải kiểm trước khi code (V46–V50)

| # | Kiểm | Cách |
|---|---|---|
| V46 | Bộ task tự đúng: với mỗi task, test ẩn **trượt** trên project gốc và **qua** khi áp lời giải tham chiếu; test thấy được qua ở cả hai | Test `node:test` offline (`test/acceptance-fixture.test.js`), chạy trong `npm test` |
| V47 | Ước thời gian và chi phí một task cho mỗi runtime, từ các lượt thật P3–P6 (report và `turnUsage`) → ước một config 10 task | Đọc report cũ |
| V48 | `omni init` + `omni squad setup` trên repo mới sinh đủ cấu hình để orchestrator thật gọi MCP/hook (codex: `.codex/config.toml` + `hooks.json`; claude: `.mcp.json` + `.claude/settings.json`), kể cả bước duyệt hook của codex (V42) | Thử một lượt ngắn |
| V49 | Prompt nhiều cổng trên TTY (`prompts`): hiện danh sách dài, mã một lần, hủy được | Thử tay |
| V50 | Tầng agent thật: orchestrator nhận `requirements.md` có lập được plan hợp lệ qua `omni dual bootstrap` / MCP trong thời gian hợp lý không | Thử 1 lượt 2 task |

---

## 8. Câu hỏi mở

| # | Câu hỏi | Quyết định (2026-11-02) |
|---|---|---|
| Q-P7-1 | Ai điều khiển lượt nghiệm thu: harness kịch bản, orchestrator thật, hay cả hai? | **Đã chốt: cả hai** — kịch bản đo ngưỡng trên mọi config; agent thật 1 lượt/preset (4 task) để bắt lỗi chỉ lộ qua MCP/hook |
| Q-P7-2 | Duyệt hơn 40 cổng integrate thế nào? | **Đã chốt: `omni squad approve --all`** (TTY, một mã cho cả loạt, mỗi cổng vẫn một sự kiện riêng) |
| Q-P7-3 | Bộ task trên project mẫu tự viết hay repo mã nguồn mở có thật? | **Đã chốt: project mẫu tự viết** (`bookshelf`, Node thuần, test ẩn, lời giải tham chiếu) |
| Q-P7-4 | Bao nhiêu config? | **Đã chốt: bốn (A–D)** — phủ cả 3 runtime ở mọi vai cần thiết, D18 và AUTO. Ước tốn: §7 V47 |
| Q-P7-5 | `WAITING_RUNTIME` khi chưa gặp dấu hiệu thật? | **Đề xuất mặc định (người dùng chưa phản đối):** chỉ cài cho CLI đã lộ dấu hiệu thật; CLI chưa lộ giữ technical retry, V37 ghi "chưa quan sát" |

---

## 9. Sub-phase & commit

| Commit | Nội dung | Cần trước |
|---|---|---|
| `test(squad): acceptance fixture and task suite (P7a)` | `bookshelf`, 10 task, test ẩn, lời giải tham chiếu, `acceptance-fixture.test.js` (V46) | — |
| `feat(squad): approve all pending gates (P7b)` | `omni squad approve --all` (+ `--reject`), mã cho cả loạt, test TTY giả | Q-P7-2 |
| `test(squad): acceptance harness (P7c)` | `test/helpers/squad-live.js`, `test/squad-acceptance.js`, đo §4, báo cáo, thu dấu hiệu lỗi (§6.1) | P7a, P7b, V48 |
| `test(squad): acceptance runs A–D (P7d)` | Chạy A–D (+ chạy lại task hỏng), báo cáo vào `docs/ACCEPTANCE-3.2.0.md` | P7c |
| `feat(dual): WAITING_RUNTIME for observed rate limits (P7e)` | §6.1 cho các CLI đã lộ dấu hiệu | P7d (V37) |
| `test(squad): agent-driven acceptance (P7f)` | 2 lượt agent thật (V50) | P7c |
| Sửa lỗi phát hiện | Mỗi lỗi một commit `fix(...)` kèm test; chạy lại phần bộ bị ảnh hưởng | — |

---

## 10. Test

- **P7a:**
  - V46 cho cả 10 task (ẩn trượt ở gốc, qua với lời giải);
  - project mẫu không có phụ thuộc ngoài;
  - test thấy được qua ở gốc.
- **P7b:**
  - `--all` cần TTY;
  - mã đổi khi tập cổng đổi;
  - mỗi cổng một `gate.approved` (`actor: human`, `via: cli-tty`);
  - `--reject` cần `--reason`;
  - hook chặn agent chạy `approve --all`.
- **P7c:** các hàm đo §4 chạy trên ledger dựng sẵn:
  - một vi phạm của mỗi ngưỡng bị phát hiện, đúng task và sequence;
  - ledger sạch thì báo đạt;
  - báo cáo không chứa email, home, token.
- **P7e:** fixture dấu hiệu thật → phân loại đúng; task vào `WAITING_RUNTIME` không tốn attempt; task runtime khác vẫn chạy.

---

## 11. Điều kiện xong P7 (DoD)

- [ ] Bộ task + V46 xanh trong `npm test`.
- [ ] Config A–D chạy xong, mỗi config đạt đủ 5 ngưỡng §4; `docs/ACCEPTANCE-3.2.0.md` có số liệu từng config.
- [ ] Hai lượt agent thật xong, lỗi phát hiện đã sửa hoặc ghi rõ.
- [ ] V37: mỗi CLI hoặc đã có phân loại theo dấu hiệu thật, hoặc ghi "chưa quan sát"; V36 và abort chéo đã ghi kết quả.
- [ ] `npm test` xanh trên macOS + một lượt dưới tải.
- [ ] V44 (Safari/Firefox, từ P6) đã thử tay.
- [ ] Sẵn sàng mang sang Linux/Windows thật (plan §11).
