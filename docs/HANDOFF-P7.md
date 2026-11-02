# Bàn giao — omni squad 3.2.0, từ P7 trở đi

> Viết ngày 2026-11-02 khi bàn giao từ Claude (Opus 5.5, Claude Code) sang một agent khác. Tài liệu này **tự đủ**: agent tiếp nhận không có lịch sử hội thoại trước đó. Đọc hết §0–§4 trước khi chạm vào code.
> Branch `3.2.0`. Commit code cuối là **`f02543a`**; các commit sau đó (từ `bdde019`) chỉ là tài liệu bàn giao. Không có thay đổi chưa commit trong code; trong cây làm việc chỉ còn vài file không theo dõi, do công cụ của người dùng sinh ra.

---

## 0. Đọc ngay (TL;DR)

1. **Dự án:** `omni-coder-kit`, một CLI Node.js (CommonJS). Bản 3.2.0 biến chế độ **dual** (1 orchestrator + 1 worker) thành **squad**: N vai (orchestrator, worker-1..N, reviewer), cắm runtime CLI tùy ý (**codex**, **agy**, **claude**), liên lạc hình sao qua daemon authority. Có thêm web UI tùy chọn `omni ui`.
2. **Đã xong:** P1–P6 trên macOS, kèm các lượt chạy thật. Ba nợ kỹ thuật còn lại đã sửa ngay trước P7. `npm test`: **3103 test, 0 fail** (chạy thường và chạy dưới tải).
3. **Việc của bạn: P7, nghiệm thu 3.2.0.** Spec đã viết và người dùng đã chốt quyết định: [`docs/SPEC-SQUAD-P7-ACCEPTANCE.md`](SPEC-SQUAD-P7-ACCEPTANCE.md). Bắt đầu từ **P7a** (§10 dưới đây).
4. **Luật sắt** (§2):
   - không `git push`, không `git reset --hard`, không `rm -rf`;
   - `npm test` phải xanh ở **cả lượt thường lẫn lượt dưới tải** trước mỗi commit;
   - commit nhỏ theo Conventional Commits;
   - chỉ người dùng được duyệt cổng (gõ mã trên TTY); harness và agent không bao giờ duyệt thay.
5. **Hỏi người dùng bằng tiếng Việt.** Mỗi bước có quyết định thì hỏi, kèm phương án khuyên dùng.

---

## 1. Bối cảnh

- Repo: `/Users/ben/Documents/omni-coder-kit`; Node 24 (yêu cầu ≥ 20); test bằng `node:test`. Dependency chính: `commander`, `chalk`, `prompts`, `zod`, `yaml`, `@modelcontextprotocol/sdk`. Thêm `optionalDependencies`: `node-pty@1.1.0`, `@xterm/xterm@6.0.0`, `@xterm/addon-fit@0.11.0`.
- `main` (3199575) là 3.1.2 và **không** được dùng làm chuẩn so sánh: 3.1.2 chưa từng qua nghiệm thu. Branch `3.2.0` có 50 commit trên `main`.
- Thư mục `docs/` bị gitignore: mọi tài liệu trong đó phải **`git add -f`**.
- Tài liệu định hướng (đọc khi cần chi tiết):
  - [`SQUAD-ARCHITECTURE-PLAN.md`](SQUAD-ARCHITECTURE-PLAN.md) — kiến trúc, quyết định D1–D19, lộ trình P1–P7, tiêu chí nghiệm thu §11;
  - `SPEC-SQUAD-P1…P7-*.md` — spec từng pha. Mỗi spec có các phần: §0 phạm vi, câu hỏi Q đã chốt, mục V (phải kiểm trước khi code), DoD và phụ lục kết quả chạy thật;
  - `CLAUDE.md` (quy ước dev); `docs/orchestration-patterns.md` (đọc trước khi sửa `lib/harness/loop.js`).

---

## 2. Quy tắc làm việc (bắt buộc)

| Quy tắc | Chi tiết |
|---|---|
| Không push / deploy | Chỉ commit local. Không `git push`, `git reset --hard`, `rm -rf` (khớp deny-list `tools/shell.js`). |
| Test xanh trước commit | Chạy cả hai lượt ở §6.1: lượt thường (khoảng 8–9 phút) và lượt dưới tải `--test-concurrency=4` (khoảng 3–4 phút). Module mới phải có test `node:test`; test cũ giữ xanh. |
| Commit | Conventional Commits; subject tiếng Anh, body có thể tiếng Việt. Mỗi sub-phase một commit (vd. `feat(ui): … (P6b)`), mỗi bản sửa một commit `fix(...)` kèm test. Spec dùng tiếng Việt và cập nhật mục "Đã làm" ngay khi làm khác spec. |
| Sửa tối thiểu | Không refactor ngoài phạm vi. Giữ nguyên mã lỗi `DUAL_*`, đường dẫn `dual-authority`, tên event ledger (D14). |
| Thư viện ngoài | Tra tài liệu phiên bản hiện hành trước khi viết code (Context7 hoặc trang chính thức), không dựa vào trí nhớ. |
| Cổng duyệt | Chỉ người duyệt, qua `omni squad approve <gate>` trên TTY với mã xác nhận. Không có MCP tool nào duyệt cổng; hook chặn agent chạy lệnh duyệt. Harness phải **chờ** người duyệt, không ghi `gate.approved` thay. |
| Người dùng | Trả lời bằng tiếng Việt. Khi cần quyết định thì hỏi, nêu phương án khuyên dùng trước. Người dùng hay gõ nhầm mã cổng: luôn in **lệnh đầy đủ** để họ dán vào terminal, và nhắc rằng mã lần trước không dùng lại được. |
| Đa OS | Mọi pha làm và nghiệm thu trên **macOS trước**. Code vẫn phải đúng cho Linux và Windows (giữ test giả lập `win32`). Chạy trên máy Linux/Windows thật là việc của người dùng **sau** khi 3.2.0 xong trên macOS. |

---

## 3. Trạng thái các pha

| Pha | Nội dung | Commit chính | Ghi chú |
|---|---|---|---|
| P1 | Runtime registry (`lib/squad/runtimes`): adapter codex, agy; probe; conformance | (trước P3) | DoD tick ở 297ef87 |
| P2 | Vai + skill theo vai (YAML, `lib/squad/roles.js`, skill store, mount) | (trước P3) | |
| P3 | Pipeline khai báo + cổng duyệt người (spec / plan / integrate), `omni squad` | 2489e72, de7f0a3, 1f0a263 | Chạy thật V20–V21 |
| P4 | Adapter **Claude Code**; claude làm worker và orchestrator | 623a4a1, be89867, 911e69a, 9149ee2 | |
| P5 | Reviewer QC độc lập, worker theo task, worker song song, ngân sách vai | c93bb1a, f2dde11, 5842ade, c85090b, 42deb3a | V36/V37/abort chéo dời sang P7 |
| P6 | `omni ui`: chỉ đọc → PTY orchestrator → inbox/tin theo vai → transcript | 31fd210, 687952d, 636f08f, a44b5ae, 7011e34 | Còn V44 (Safari/Firefox, thử tay) |
| Sửa trước P7 | allowlist MCP trong hook (dfb5c64); codex orchestrator config (f7826ea); daemon chạy code cũ (fc552b0); task worker phải isolated khi có pipeline (f02543a) | | |
| **P7** | Nghiệm thu §11 | spec fe6ca27, quyết định 67285f5 | **Chưa có code** |

---

## 4. Kiến trúc nén

```
Người dùng ─┬─ CLI orchestrator (codex | claude) ──MCP omni_dual──┐
            │      (hook omni-hook.js mỗi SessionStart/Prompt/Tool) │
            └─ omni ui (web 127.0.0.1, PTY orchestrator, timeline, │
               composer @role)                                      ▼
                                              Authority daemon (lib/dual/daemon-server.js)
                                              ledger append-only hash chain
                                              .omni/runs/dual-authority/events.ndjson
                                                     │ đẩy lượt headless
                          ┌──────────────────────────┼──────────────────────────┐
                    worker-1..N (agy|codex|claude)   reviewer (codex|agy|claude)  discussion (astra=orchestrator slot)
                    root isolated + scope-guard      root chỉ đọc spec/diff/evidence
```

- **Slot nội bộ:** `codex` = slot orchestrator (còn gọi astra), `agy` = slot worker. Đây chỉ là tên slot, runtime thật lấy từ binding. `normalizePlanOwner`: `orchestrator→codex`, `worker→agy`. Task có trường `worker` (`worker-N`).
- **Binding:**
  - binding của từng người ở `.omni/squad.local.json`: `roles.orchestrator`, `roles.worker[]`, `roles.reviewer`, `limits.concurrency`;
  - vai và pipeline của project nằm trong `.omni/squad/` và được commit;
  - `.omni/manifest.json` vẫn giữ các field cũ (`workerRuntime/Model`, `orchestratorRuntime…`).
- **Luồng 1 task isolated:**
  1. `plan.register` → cổng `plan-r<N>`;
  2. worker chạy scout → implement → review trong root riêng, sau đó handoff;
  3. reviewer QC nếu có (`AWAITING_REVIEW`; NEEDS_FIX thì tự sửa có giới hạn);
  4. `task.qc` → cổng `integrate-<task>` (`AWAITING_HUMAN_APPROVAL`) → integrate → `TASK_VERIFIED`.
- **Cổng:**
  - `lib/dual/approval-gates.js`; ledger ghi `gate.requested/approved/rejected` với `actor` + `via`;
  - AUTO chỉ bỏ qua cổng có `auto_ok`; `integrate` là `human-always`;
  - mã xác nhận = `confirmationCode(gate)` (6 hex, tính từ digest).
- **Inbox (P6c):**
  - ledger ghi `user.message.posted/delivered`;
  - orchestrator nhận tin qua MCP `omni_dual_inbox` hoặc qua hook (`additionalContext`);
  - worker nhận tin ở pha kế (`Notes from the user`); reviewer nhận qua file `user-notes.md`.
- **Daemon:** tự bật khi hook chạy (SessionStart/UserPromptSubmit) hoặc từ `omni ui`. `health` có `build_id`: daemon chạy code cũ sẽ tự khởi động lại khi rảnh (`lib/dual/daemon-freshness.js`).
- **Danh sách tool MCP:** `lib/dual/mcp-tools.js` (15 tool). Hook cho qua đúng danh sách này; một test fail nếu server và danh sách lệch nhau.

### 4.1 Bản đồ file

| Vùng | File |
|---|---|
| Runtime | `lib/squad/runtimes/{contract,registry,codex,agy,claude,transcript,resolve-binary,spawn-bounded}.js` |
| Vai / pipeline / binding | `lib/squad/{roles,pipeline,bindings,setup,doctor,skills-catalog,skill-store,mount,worker-mount}.js`, `templates/squad/{roles,pipelines}/` |
| Cấu hình orchestrator | `lib/squad/claude-orchestrator.js`, `lib/squad/codex-orchestrator.js` |
| Daemon / ledger | `lib/dual/daemon-server.js` (RPC), `authority-store.js` (replay/derive), `contracts.js` (zod schema event), `daemon-client.js` |
| Worker / QC | `lib/dual/{isolated-authority,isolated-runner,orchestrator,worker-runtime,agy-runner,worker-scheduler,reviewer-qc,task-correction,handoff-rejection,role-budget}.js` |
| Hook / MCP | `lib/dual/hook-bridge.js`, `bin/omni-hook.js`, `lib/dual/mcp-server.mjs`, `lib/dual/mcp-tools.js` |
| Cổng / inbox | `lib/dual/approval-gates.js`, `lib/dual/inbox.js` |
| UI | `lib/ui/{server,state,feed,pty-host,inbox-bridge,transcript-source}.js`, `lib/ui/static/*`, `lib/commands/ui.js` |
| Lệnh CLI | `bin/omni.js` (nhóm `squad` từ khoảng dòng 299), `lib/commands/squad.js` (`handleSquadApprove` …) |
| Harness sống | `test/squad-p3-live.js` (1–2 task, controller dựng sẵn qua RPC) |
| Test helper | `test/helpers/{squad-project,squad-fakes,dual-discussion-stub,auto-approve-gates}.js`; fixture CLI thật ở `test/fixtures/squad-cli/` |

---

## 5. Quyết định đã chốt (nén)

- **D1–D19** (plan §2):
  - vai là file khai báo; binding 4 tầng `role → runtime → model → effort`;
  - hình sao; skill orchestrator ở project root, skill worker mount vào root isolated;
  - cổng mặc định spec/plan/integrate; vai và pipeline commit trong `.omni/squad/`;
  - UI phương án B (PTY thật);
  - **D18:** một tài khoản giữ được nhiều vai, mỗi vai một session và một root riêng, không bao giờ resume `--last`;
  - **D19:** ba runtime chính là codex, agy, claude; OpenCode và model chỉ có API để sau 3.2.0.
- **Quyết định P5:**
  - NEEDS_FIX tự sửa có giới hạn;
  - reviewer chạy trước validation;
  - giữ pha review của worker;
  - mỗi attempt mở một phiên reviewer mới;
  - giới hạn đồng thời `codex 2, claude 2, agy 1`.
- **Quyết định P6:**
  - SSE + POST;
  - tin `@worker` / `@reviewer` thành ghi chú cho lượt kế;
  - `@orchestrator` nhận qua cả MCP lẫn hook;
  - UI chạy CLI orchestrator;
  - xterm là `optionalDependencies`.
- **Quyết định P7** (spec §8):
  - **Q-P7-1:** hai tầng chạy: harness kịch bản đo ngưỡng trên mọi config, cộng 1 lượt agent thật mỗi preset;
  - **Q-P7-2:** `omni squad approve --all`;
  - **Q-P7-3:** project mẫu tự viết `bookshelf`;
  - **Q-P7-4:** bốn config A–D;
  - **Q-P7-5 (mặc định):** `WAITING_RUNTIME` chỉ cài cho CLI đã lộ dấu hiệu rate limit thật.

---

## 6. Chạy và kiểm

### 6.1 Test

```bash
# Lượt thường (≈ 8–9 phút; perl alarm chặn treo)
perl -e 'alarm 590; exec @ARGV' npm test
# Lượt dưới tải (≈ 3–4 phút). Dùng /usr/bin/find: hook rtk trên máy này viết lại `find` và làm sai lệnh.
{ /usr/bin/find test -maxdepth 1 -name '*.test.js' -print0; /usr/bin/find test -mindepth 2 -name '*.test.js' -print0; } | xargs -0 perl -e 'alarm 590; exec "node","--test","--test-concurrency=4","--test-timeout=90000",@ARGV'
```

- Lượt dưới tải phải ra **cùng số test** với lượt thường. Lúc bàn giao là 3103: 3091 pass + 12 skip.
- Bẫy test chỉ gặp trên macOS:
  - `os.tmpdir()` nằm dưới `/var` → `/private/var`, nên fixture phải `realpathSync.native`;
  - lần exec đầu của một script mới ghi mất khoảng 250 ms;
  - `noProgressMs` của watchdog phải ≥ 250 ms;
  - hệ thống file không phân biệt hoa thường.

### 6.2 Lệnh hữu ích

```bash
node bin/omni.js squad runtimes            # probe codex/agy/claude: version, đăng nhập, model
node bin/omni.js squad setup --preset squad --workers 2 --bind orchestrator=codex:gpt-6.1-sol:high --bind worker-1=agy:gemini-3.8-flash-high --bind worker-2=claude:sonnet:low --bind reviewer=codex:gpt-6-luna:low -y
node bin/omni.js squad approve [gateId]    # người dùng chạy trên TTY; không có gateId thì liệt kê cổng
node bin/omni.js ui [--no-open] [--no-start] [--resume] [--port N]
node bin/omni.js dual daemon stop          # dừng daemon của project hiện tại
```

### 6.3 Harness sống hiện có (mẫu cho P7c)

```bash
OMNI_SQUAD_LIVE=1 node test/squad-p3-live.js <report.json> [--worker agy|codex|claude] [--orchestrator codex|claude] [--reviewer codex|agy|claude] [--second-worker …] [--planted-bug] [--setup-only]
```

- Nên chạy trong một tab terminal mà người dùng nhìn thấy được. Harness in lệnh `approve` khi tới cổng, rồi chờ.
- Đọc `report.json` để biết đang ở stage nào: `report.awaiting` chứa `gateId` và `command`.
- Workspace của mỗi lượt nằm dưới `$TMPDIR/omni-squad-live-*/workspace` và được giữ lại để truy lỗi.
- Model đã dùng ổn:
  - worker agy `gemini-3.8-flash-high`;
  - worker claude `sonnet` effort `low` (haiku quá yếu ở vai worker/review);
  - codex `gpt-6.1-sol` / `gpt-6-luna`, `gpt-6.1-terra` low (thử pane);
  - claude orchestrator `sonnet`.
- Không chèn tên model mới vào spec mà không probe lại bằng `omni squad runtimes`.

---

## 7. Bẫy đã gặp (đừng giẫm lại)

| Bẫy | Cách xử lý |
|---|---|
| Harness điều khiển daemon qua RPC nên **không đi qua MCP/hook** như một orchestrator thật. Vì thế lỗi allowlist (dfb5c64) đã sống từ v3.1.0 mà không ai thấy. | Chính là lý do P7 có tầng "agent thật". |
| Cửa sổ trust thư mục (codex, claude) và cửa sổ **"Hooks need review"** của codex (V42) hiện ra lần đầu ở mỗi thư mục mới | Người dùng tự chọn trong pane PTY. Lệnh hook của omni phải giữ **ổn định** giữa các lần ghi, nếu không codex lại đòi duyệt. |
| node-pty 1.1.0 đóng gói `spawn-helper` mode 644 nên mọi spawn lỗi `posix_spawnp failed` | `pty-host.ensureSpawnHelper` tự `chmod` (đã làm). |
| Agent con được bật từ bên trong một phiên agent kế thừa các biến `CLAUDECODE` / `CLAUDE_CODE_*`, khiến claude tắt lưu transcript | `pty-host.childEnv` xóa danh sách `PARENT_SESSION_ENV`. |
| Gõ chữ cùng Enter trong một lần ghi: claude coi là dán, chỉ xuống dòng thay vì gửi | Trang gửi `\r` thành một lần ghi riêng. |
| Daemon còn sót từ trước khi sửa code | Đã tự xử lý bằng `build_id`. Nếu thấy hành vi lạ thì vẫn chạy `omni dual daemon stop` trong workspace đó. |
| Stop hook ở trạng thái session ACCEPTANCE đòi đủ quality cycle 1–3, đẩy claude tiếp tục làm | Khi thử pane trong lúc harness đang điều khiển: chạy `omni ui --no-start` và chỉ bật orchestrator **sau** khi harness xong; dặn orchestrator "không làm gì khác". |
| Harness và daemon đọc ledger cùng lúc | `derive()` đã có retry. Harness ở tiến trình khác phải đọc qua `createAuthorityStore(...).derive()`, không tự parse file. |
| Hook rtk viết lại lệnh `find` / `grep` trong shell của máy này | Dùng `/usr/bin/find`, `command grep`. |
| `git add -p` không chạy được (cần tương tác) | Khi hai thay đổi chung một file mà muốn tách commit: tạo patch theo hunk rồi `git apply --cached`. |

---

## 8. Nợ còn lại (đã xếp chỗ)

- **Trong P7:**
  - V36: làm mới token khi chạy dài;
  - V37 → `WAITING_RUNTIME`;
  - truy abort chéo nếu tái hiện (V-live-P5-par-1);
  - V44: Safari/Firefox;
  - một lượt đầy đủ với codex làm orchestrator.
- **Sau 3.2.0 hoặc pha đa OS:**
  - gộp builder argv: worker agy vẫn dùng `buildAgyInvocation`, discussion codex dùng `live-codex-invoke`, `omni run` vẫn dùng `lib/harness/providers/host-cli.js` thay vì registry;
  - chạy thật trên Linux/Windows, kèm hai chỗ `TODO(win32)` trong `lib/squad/runtimes/claude.js` và `lib/squad/claude-orchestrator.js`;
  - agy chạy song song (đang giới hạn 1);
  - OpenCode và model chỉ có API; vai do người dùng tự định nghĩa; engine cho phase tùy ý.
- **Chưa thử bằng vòng thật:** ba bản sửa trước P7 (f7826ea, fc552b0, f02543a). P7 sẽ đi qua cả ba; gặp lỗi thì sửa kèm test.

---

## 9. Làm việc với người dùng

- **Trang tiến độ:**
  - Artifact claude.ai `https://claude.ai/artifact/TfAeVYPJL42BSEk6vvS8wC` ("Omni Squad 3.2.0"), một cột, cập nhật sau mỗi mốc;
  - nếu bạn **không** có công cụ publish Artifact, đừng cố. Báo tiến độ trong chat, rồi ghi mốc vào mục "Đã làm" của spec P7.
- **Ở mỗi mốc,** báo cho người dùng:
  1. đã làm gì (kèm commit);
  2. test (số pass/fail ở cả hai lượt);
  3. cái gì chưa kiểm;
  4. một câu hỏi cho bước kế, nếu có.
- **Khi cần duyệt cổng:**
  - in lệnh đầy đủ trong khối `bash`, kèm đường dẫn workspace;
  - nói rõ: "gõ mã nó in ra, không dùng mã cũ";
  - sau khi người dùng báo đã duyệt, kiểm ledger (`approvals[gateId].status`) trước khi đi tiếp.

---

## 10. Kế hoạch P7 (thực hiện theo thứ tự)

Spec đầy đủ: [`SPEC-SQUAD-P7-ACCEPTANCE.md`](SPEC-SQUAD-P7-ACCEPTANCE.md). Đọc §2 (bộ task), §3 (harness), §4 (cách đo), §5 (`--all`), §6 (mang từ P5) trước khi bắt đầu.

### P7a — project mẫu + 10 task + test ẩn (`test(squad): acceptance fixture and task suite (P7a)`)

1. Tạo `test/fixtures/acceptance/bookshelf/`: Node thuần, không dependency, khoảng 400 dòng.
   - code: `lib/catalog.js`, `lib/csv.js`, `lib/format.js`, `lib/report.js`, `bin/cli.js` (lệnh `list`/`add`/`search`);
   - test thấy được: `test/*.test.js`, qua trên project gốc;
   - `README.md`, `package.json` với `"test": "node --test"`;
   - `plans/plan.md` (mô tả 10 task cho cổng plan); `plans/finance-format.md` (nguồn để trả lời câu hỏi của T08).
2. Viết T01–T10 theo spec §2.2. Mỗi task gồm:
   - goal rõ ràng;
   - `allowed_files` đúng bảng;
   - `validation_commands` là test thấy được;
   - **test ẩn** `test/fixtures/acceptance/hidden/Txx.test.js`;
   - **lời giải tham chiếu** `test/fixtures/acceptance/reference/Txx.patch`.

   Thiết kế cố ý:
   - T02 trùng file với T01;
   - T05 trùng file với T04, T07, T09 (scheduler phải xếp tuần tự);
   - T08 phải dẫn tới `NEEDS_CONTEXT`;
   - T09 có cám dỗ ghi ngoài scope;
   - T10 có biên mà test thấy được không bắt.
3. Mô tả task dạng dữ liệu, `test/fixtures/acceptance/tasks.json`: id, title, goal, `allowed_files`, `context_files`, `validation_commands`, risk/complexity/category hợp lệ cho isolated.
   - Isolated đòi `risk: low`, `complexity` khác `high`, `category` không thuộc `architecture|migration|security|ambiguous|database|infra|review|design|auth`; xem `lib/dual/contracts.js` khoảng dòng 147.
   - Task "khó" thì để `complexity: medium`.
4. **V46** — `test/acceptance-fixture.test.js`, chạy trong `npm test`, offline. Với mỗi task:
   - chép project gốc ra thư mục tạm;
   - test ẩn phải **trượt**;
   - áp `reference/Txx.patch` (bằng `git apply`, hoặc tự áp nếu tránh git) thì test ẩn **qua**;
   - test thấy được qua ở cả hai trạng thái;
   - patch tham chiếu chỉ đụng `allowed_files` của task.
5. Commit, chạy full + dưới tải, rồi báo người dùng.

### P7b — `omni squad approve --all` (`feat(squad): approve all pending gates (P7b)`)

- Sửa `lib/commands/squad.js` (`handleSquadApprove`, `runSquadApprove`), `lib/dual/approval-gates.js` (`confirmationCode`, `decideGate`, `pendingGates`), và khai cờ trong `bin/omni.js`.
- Hành vi:
  - cần TTY;
  - liệt kê mọi cổng pending (phase, task, summary, digest rút gọn);
  - **một mã** sinh từ tập digest đã sắp xếp: gợi ý `sha256(sortedDigests.join(','))` lấy 6 hex đầu, cùng kiểu với `confirmationCode`;
  - trước khi ghi, đọc lại danh sách; danh sách đổi → báo lỗi, không ghi gì;
  - ghi **từng** `gate.approved` (`actor: human`, `via: cli-tty`);
  - `--all --reject --reason …` từ chối cả loạt.
- Daemon đang chạy: đi qua RPC `gate.decide` như lệnh hiện tại (xem cách `runSquadApprove` gọi), lặp cho từng cổng.
- Hook đã chặn mọi lệnh `omni … squad approve`. Thêm test cho dạng `--all`.
- Test:
  - không có TTY thì từ chối;
  - mã sai thì từ chối;
  - danh sách đổi giữa lúc hiện và lúc gõ thì từ chối;
  - mỗi cổng có một event;
  - `--reject` thiếu `--reason` thì từ chối;
  - hook chặn khi agent gọi.

### P7c — harness nghiệm thu (`test(squad): acceptance harness (P7c)`)

- Rút phần chung của `test/squad-p3-live.js` (stage, poll, report, spawn daemon, `waitForApproval`, `answerContext`) sang `test/helpers/squad-live.js`, không đổi hành vi harness cũ. Chạy lại test liên quan và `--setup-only` để chắc.
- `test/squad-acceptance.js <out-dir> --config A|B|C|D [--tasks …] [--auto]` theo luồng ở spec §3.4:
  - chép `bookshelf`, `git init`, rồi `omni squad setup … -y`. Kể từ f7826ea, setup tự ghi cấu hình MCP/hook cho orchestrator codex và claude.
  - `omni init` **chỉ chạy tương tác**: không có cờ `--ide` hay `-y` (đã kiểm). Tầng kịch bản không cần nó; `test/squad-p3-live.js` tự dựng cấu hình bằng `buildCodexConfig` / `buildCodexHooks` của `lib/init`.
  - đăng ký 10 task, chờ người duyệt plan;
  - trả lời T08 bằng context reply có nguồn (`plans/finance-format.md`);
  - giữ mọi task ở `AWAITING_HUMAN_APPROVAL`, rồi nhờ người dùng chạy `approve --all`;
  - integrate tuần tự; chạy test ẩn trên cây đã integrate;
  - tính ngưỡng, ghi `report.json` + `report.md`.
- Các hàm đo ngưỡng (§4 spec) viết thành module thuần, vd. `test/helpers/acceptance-metrics.js`: nhận `events` / `derived` / git diff / kết quả test ẩn, trả kết quả kèm danh sách vi phạm. Có **test đơn vị** riêng trên ledger dựng sẵn: mỗi ngưỡng bị vi phạm một lần thì bắt được; ledger sạch thì báo đạt.
- Thu dấu hiệu lỗi runtime (§6.1 spec) vào `report.runtimeFailures[]`: runtime, model, exit code, stderr tail 2 KiB đã lọc token / home / email.
- Kiểm **V48** ở đây: trên repo mới, orchestrator thật phải gọi được MCP/hook. Nó còn cần `AGENTS.md` (luật controller dual), mà file này hiện chỉ `omni init` (tương tác) sinh ra.
  - Cách 1: harness gọi hàm sinh trong `lib/init/` (tìm chỗ init ghi `AGENTS.md` cho `ide: dual`).
  - Cách 2: nhờ người dùng chạy `omni init` một lần trên workspace của lượt agent thật (P7f).

  Hỏi người dùng chọn cách nào.

### P7d — chạy config A–D (`test(squad): acceptance runs A–D (P7d)`)

- Chạy từng config trong tab terminal người dùng thấy được. Mỗi config cần khoảng hai lần người dùng ra tay: duyệt `plan-r1`, rồi một lần `--all`.
- Config A (dual codex + agy) chạy trước để soát harness.
- Task hỏng do harness hoặc omni: sửa (commit `fix` kèm test), rồi chạy lại phần bị ảnh hưởng (`--tasks`).
- Task hỏng do model mà vẫn đạt ≥ 9/10: ghi lại, không sửa.
- Tổng hợp vào `docs/ACCEPTANCE-3.2.0.md`: mỗi config một bảng ngưỡng, thời gian, attempt, verdict reviewer, lỗi runtime gặp được.
- Config D chạy với `--auto`: kiểm cổng `auto_ok` được bỏ qua còn `integrate` vẫn chờ người.

### P7e — `WAITING_RUNTIME` (chỉ khi P7d thu được dấu hiệu thật)

Phân loại theo spec §6.1. Fixture lấy từ dấu hiệu thật đã gặp; CLI chưa lộ dấu hiệu thì ghi "chưa quan sát" và giữ technical retry. Có thể cần event ledger mới: thêm vào `contracts.js` và `authority-store.js` (replay) như các event P6c đã làm.

### P7f — lượt agent thật (V50)

- Mỗi preset một lượt: `dual` với codex orchestrator, `squad` với claude orchestrator. Dùng 4 task (T01, T03, T06, T09); orchestrator chạy trong `omni ui` (pane PTY), nhận `requirements.md` và tự lập plan qua MCP.
- Đo cùng các ngưỡng. Lỗi chỉ lộ qua MCP/hook là mục tiêu chính.

### Kết thúc P7

- Tick DoD ở spec P7 §11; nhờ người dùng thử V44.
- Báo người dùng là sẵn sàng mang repo sang Linux/Windows thật.
- Việc gộp `3.2.0` vào `main` do người dùng quyết; không tự merge.

---

## 11. Prompt gợi ý cho agent tiếp nhận

> Bạn tiếp nhận dự án omni-coder-kit ở branch `3.2.0` (commit code cuối f02543a). Đọc `docs/HANDOFF-P7.md` §0–§4, rồi `docs/SPEC-SQUAD-P7-ACCEPTANCE.md`. Tuân thủ §2 (không push, test xanh hai lượt trước mỗi commit, chỉ người dùng duyệt cổng). Chạy `npm test` một lần để xác nhận đang xanh (3103 test). Sau đó làm **P7a** theo §10, báo tiến độ bằng tiếng Việt, và hỏi người dùng trước mỗi quyết định không có trong spec.
