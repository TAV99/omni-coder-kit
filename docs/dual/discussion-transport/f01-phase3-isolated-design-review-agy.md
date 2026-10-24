# AGY Review đối kháng — Bản thiết kế discussion cho chuỗi isolated (P3-Gói 2b-0)

- **Ngày review:** 2026-10-24
- **Đối tượng review:** `docs/dual/discussion-transport/f01-phase3-isolated-design.md`
- **Người review:** AGY (Adversarial Reviewer độc lập, F01 / omni-coder-kit)
- **Tài liệu đối chiếu:** `docs/dual/discussion-transport/f01-phase3-retirement-survey.md`, `docs/dual/discussion-transport/f01-program-status.md`
- **Quy tắc thực thi:** Chỉ đọc file tĩnh và tạo đúng một file review này; không chạy lệnh shell, không sửa mã nguồn/test/bản thiết kế.

---

## 1. Kết luận chung (Verdict)

### **VERDICT: ACCEPT WITH FIXES**

**Đánh giá tổng quan:**
Bản thiết kế `f01-phase3-isolated-design.md` đã xác lập đúng hướng kiến trúc cốt lõi:
1. Lựa chọn **Phương án A** (daemon-side factory cấp child host gắn chặt với execution) là chuẩn xác; bảo toàn được mô hình phân quyền ledger/lease của daemon và tránh việc runner phải nhân bản wiring/policy.
2. Sơ đồ định danh tam phân `W` (canonical workerRoot), `B` (worker snapshot identity), `D` (discussion snapshot text sha256) và `executionKey` gắn với `operationId` là chặt chẽ, ngăn ngừa hiệu quả việc rò rỉ state giữa các attempt và executions.
3. Chính sách `NEEDS_CONTEXT` (kết thúc execution, tạo generation mới theo `operationId`, không mở journal cũ với seed IDs mới) hoàn toàn tương thích với kiểm tra registration của relay journal và cơ chế resume hiện tại của `isolated-runner.js`.
4. Khẳng định không cần sửa đổi `orchestrator.js` và `phase-bridge.js` sản xuất là chính xác; contract giao tiếp hiện tại đã đủ chỗ cho child resolver và relay facade.

Tuy nhiên, bản thiết kế tồn tại **hai thiếu sót kiến trúc mức P0 và ba thiếu sót mức P1** cần được hoàn thiện trước khi Muse phê duyệt triển khai:
- **P0-1:** Toàn bộ tầng live invoker (`live-agy-invoke.js`, `live-codex-invoke.js`) hiện tại **hoàn toàn không có điểm chèn `spawn`, `env`, hay `signal` hooks**; thiết kế đang giả định bề mặt cắm sẵn có trong khi thực tế phải tái cấu trúc điểm spawn cốt lõi.
- **P0-2:** Mô hình "Relay facade" **không thể bao bọc Seed I/O** (diễn ra trước khi relay tồn tại) và **Internal Adapter Nudge** (nudge diễn ra bên trong adapter invoke mà không qua relay), tạo ra các đường bypass guard trực tiếp.
- **P1-1:** Subprocess capability probes trong `daemon-ports.js` và `capability-preflight.js` đang ghim `cwd` vào `derived.workspaceRoot` (workspace của daemon) và không chuyển tiếp `env` vào `spawnBoundedProcess`.
- **P1-2:** Quản lý vòng đời child host trong parent host (`host-resolver.js`) chưa có cơ chế unregister tự động khi execution kết thúc, đe dọa làm treo hoặc sập `closeAll()` khi daemon shutdown.
- **P1-3:** `checkAuthority` trong `daemon-ports.js` chỉ kiểm tra lease bất kỳ của task còn `active`, thiếu ràng buộc exact `leaseId` và `operationId`.

---

## 2. Bảng kết luận các giả thuyết H1–H8

| Giả thuyết | Kết luận | Bằng chứng mã (`file:line`) | Đánh giá đối kháng |
|---|---|---|---|
| **H1:** Phương án A thực thi được với các hooks spawn/env/probe đề xuất | **PARTLY** | `lib/dual/discussion/live-agy-invoke.js:82-86`, `:300-380`, `:402-407`<br>`lib/dual/discussion/live-codex-invoke.js:76-80`<br>`lib/dual/capability-preflight.js:551-556`, `:576-581`<br>`lib/dual/task-processes.js:8-29` | Thiết kế đúng về hướng cần hooks, nhưng **giả định sai rằng đây chỉ là optional hooks nhỏ**. Hiện tại cả hai live invokers gọi `spawn` trực tiếp từ `node:child_process`, không nhận `spawnImpl`, không nhận `env`, không cắm được `trackedSpawn`. `capability-preflight.js` không forward `env` vào `spawnBoundedProcess`. Khối lượng công việc thật ở 4 module này lớn hơn nhiều so với mô tả 2 dòng trong mục 7. |
| **H2:** Sơ đồ identity/key (W/B/D + execution key gồm operationId) ngăn được rò state giữa attempt/execution | **TRUE** | `lib/dual/discussion/contracts.js:327`, `:354-368`, `:439-450`<br>`lib/dual/discussion/relay.js:215-234`<br>`lib/dual/isolated-authority.js:119`<br>`lib/dual/isolated-runner.js:86-99` | Sơ đồ toán học và định danh hoàn toàn chặt chẽ: `executionKey` chứa `operationId` (UUID cấp mới mỗi execution tại `isolated-authority.js:119`), dẫn tới `stateDir` riêng biệt (`isolated/<executionKey>/`). `snapshot.text` chứa `operationId` nên `D` thay đổi, làm `binding.snapshot_sha256` thay đổi. Journal cũ không thể bị mở nhầm vì `relay.js:223-234` fail-closed nếu bindings/snapshot không khớp. Concurrent resolve được bảo vệ bởi pending promise cache. |
| **H3:** Guard parity: facade relay + spawn hooks phủ MỌI đường I/O của một lượt discussion trong isolated | **PARTLY** | `lib/dual/discussion/session.js:61-65`<br>`lib/dual/discussion/live-agy-invoke.js:357-379`<br>`lib/dual/discussion/daemon-ports.js:59-77`, `:95-113` | **Tìm thấy ít nhất 2 đường bypass trực tiếp nếu chỉ dùng relay facade:**<br>(1) `seeds.codex` và `seeds.agy` được gọi tại `session.js:62-65` **trước khi relay được khởi tạo**, relay facade hoàn toàn không thể bọc được seed.<br>(2) Internal corrective nudge tại `live-agy-invoke.js:379` tự gọi lại `call(nudge)` bên trong adapter invoke mà không quay về `relay.dispatch`, bỏ qua mọi post-turn guard của facade. |
| **H4:** Cặp registry/reader riêng cho child ngăn được trộn authority; override "trusted execution context" cho capability probe đủ an toàn | **PARTLY** | `lib/dual/discussion/daemon-ports.js:48-53`, `:95-108`<br>`lib/dual/isolated-authority.js:31-37`, `:184-188`<br>`lib/dual/task-workspace.js:70-80` | Tách registry/reader là điều kiện tiên quyết và đúng đắn. Hiện `daemon-ports.js:97` lấy `derived.workspaceRoot` từ daemon ledger, làm probe chạy trên daemon root. Việc override bằng `trustedExecutionContext` là bắt buộc, **NHƯNG CHƯA ĐỦ AN TOÀN** nếu thiếu cơ chế xác thực nguồn: daemon factory phải đối chiếu `workerRoot` với event `task.workspace.prepared` trong ledger và chuẩn hóa qua `fs.realpathSync.native`. Đồng thời, `checkAuthority` trong `daemon-ports.js` phải được child reader thắt chặt theo exact `leaseId`/`operationId`. |
| **H5:** Khẳng định "không cần sửa orchestrator production và phase-bridge production" có đúng không | **TRUE** | `lib/dual/orchestrator.js:838-879`<br>`lib/dual/discussion/phase-bridge.js:21-30`, `:38-104`, `:159-172` | Khẳng định hoàn toàn chính xác. `orchestrator.js:838-843` truyền `{ taskId, snapshotSha256, phase, workspaceRoot }` vào `sessionResolver`, kiểm tra `session.enabled === true`, trích xuất `astra`/`argon` bindings, và gọi `runDiscussionPhase`. `phase-bridge.js` chỉ tương tác với session qua `session.relay.{inspect, receive, dispatch, reconcile}`. Một relay facade trả về từ child resolver hoàn toàn đáp ứng đầy đủ contract mà không cần chạm vào 2 file production này. |
| **H6:** Chính sách NEEDS_CONTEXT nhất quán với kiểm registration của relay và hành vi resume của isolated-runner | **TRUE** | `lib/dual/discussion/relay.js:215-234`<br>`lib/dual/isolated-runner.js:158-166`, `:180-194`<br>`lib/dual/isolated-authority.js:190-198` | Hoàn toàn nhất quán. Khi gặp câu hỏi mở, runner thoát `NEEDS_CONTEXT` và child host được close. Khi có reply, attempt mới chạy với `operationId` mới -> `executionKey` mới -> `stateDir` mới hoàn toàn trống, `relay.js` ghi `registered` mới mà không gặp lỗi `CORRELATION_INVALID`. Runner đã lưu `context.json` và `events.ndjson` nên khi resume sẽ bỏ qua scout (`isolated-runner.js:160`), chạy thẳng implement lạnh rồi đến review discussion với conversation mới. |
| **H7:** Tương thích ngược đường shared: các thay đổi additive vào host-resolver không đổi hành vi ngầm | **PARTLY** | `lib/dual/discussion/host-resolver.js:25-33`, `:35-73`, `:75-83`<br>`lib/dual/orchestrator.js:842` | Có **nguy cơ đổi ngầm (silent regressions)** ở 4 điểm:<br>(1) `closeAll()`: nếu child host đăng ký vào parent cache/registry để shutdown chung, một child lỗi sẽ làm `closeAll()` throw sập daemon.<br>(2) `authorityReader`: nếu shared và isolated dùng chung một hàm reader mà chỉ lookup theo `taskId`, state giữa hai bên sẽ bị ghi đè.<br>(3) `workspaceRoot`: `orchestrator.js:842` đã truyền `workspaceRoot: repoRoot`. Nếu shared resolver kiểm tra `workspaceRoot` lỏng lẻo (không canonical realpath), shared caller có thể bị từ chối oan.<br>(4) `planRevision`: child host không được gọi động `daemon.getPlanRevision()` mà phải khóa cứng revision từ execution closure. |
| **H8:** Năm câu hỏi mở ở mục 8 của thiết kế | **AGREE WITH CONDITIONS** | `docs/dual/discussion-transport/f01-phase3-isolated-design.md:309-321`<br>`docs/dual/discussion-transport/f01-program-status.md:109-114` (Quyết định D1) | Đối kháng đồng ý có điều kiện với cả 5 câu (chi tiết tại Mục 4). Đặc biệt: câu 1 **bắt buộc giữ isolated BLOCKED** nếu không cho phép sửa hooks; câu 4 khẳng định hai mã lỗi mới **không vi phạm D1** nếu mã factory thiếu được ném dạng Precondition Error trước `phase.started`. |

---

## 3. Danh sách Findings phân mức P0 / P1 / P2

### [P0-1] Tầng live invoker hoàn toàn thiếu điểm chèn `spawn`, `env`, và `signal` hooks
- **Mức độ:** P0 (Chặn kiến trúc / Không thể thực thi Guard Parity)
- **Mô tả:** Bản thiết kế giả định Phương án A chỉ cần thêm "optional hooks" cho invoker (mục 3 dòng 177, mục 7 dòng 296). Tuy nhiên, khảo sát mã nguồn thực tế cho thấy `runAgy` và `runCodex` đang import và gọi trực tiếp `spawn` từ module `node:child_process`. Tương tự, `createAgyAdapter`, `createCodexAdapter`, `seedAgyConversation`, `seedCodexConversation` hoàn toàn không nhận tham số `spawnImpl` hay `env`.
- **Dẫn chứng mã:**
  - `lib/dual/discussion/live-agy-invoke.js:4`, `:82-86`: `child = spawn(agyPath, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })`.
  - `lib/dual/discussion/live-agy-invoke.js:63-73`: `resolveOptions` chỉ chấp nhận `agyPath`, `cwd`, `model`, `timeoutMs`.
  - `lib/dual/discussion/live-agy-invoke.js:402-407`: `seedAgyConversation` gọi `runAgy` không truyền `env` hay `spawn`.
  - `lib/dual/discussion/live-codex-invoke.js:5`, `:76-80`: `child = spawn(options.codexPath, args, { cwd: options.cwd, shell: false, ... })`.
- **Tác động:** Nếu không tái cấu trúc điểm spawn cốt lõi, mọi tiến trình AGY và Codex trong chuỗi isolated sẽ:
  1. Không thể nhận biến môi trường đã scrub (`GIT_CEILING_DIRECTORIES`), vi phạm nghiêm trọng an toàn Git (`isolated-runner.js:111-114`).
  2. Không thể sử dụng `createTrackedSpawn` (`task-processes.js:8-29`), dẫn đến tiến trình mồ côi (orphaned processes) không được ghi nhận vào ledger daemon khi xảy ra timeout hoặc crash.
- **Yêu cầu sửa đổi thiết kế:**
  Bản thiết kế phải nâng cấp phạm vi: quy định rõ chữ ký mở rộng cho `createAgyAdapter`, `createCodexAdapter`, `seedAgyConversation`, `seedCodexConversation`, `runAgy`, `runCodex` để chấp nhận:
  `{ spawnImpl = spawn, env = process.env, signal }`.
  Đồng thời phải làm rõ cơ chế tương thích giữa `createTrackedSpawn` (phát sinh event `task.process.intent/started/exited`) và `trackInvocation` nội bộ của adapter.

---

### [P0-2] Relay facade không bao bọc được Seed I/O và Internal Adapter Nudge
- **Mức độ:** P0 (Lỗ hổng Guard Bypass)
- **Mô tả:** Bản thiết kế đề xuất dùng "Relay facade" để bọc pre-check và post-check (`validateRuntime`, `validateReplies`, `guard`, `cwd check`) cho mọi thao tác I/O (mục 3 dòng 156-162). Tuy nhiên:
  1. **Seed I/O:** Trong `createDiscussionSession` (`session.js:61-65`), hàm seed provider (`seedCodexConversation`, `seedAgyConversation`) được thực thi **trước khi `createDiscussionRelay` được gọi**. Do đó, Relay Facade hoàn toàn chưa tồn tại ở thời điểm seed.
  2. **Internal Adapter Nudge:** Trong `createAgyAdapter.invoke` (`live-agy-invoke.js:357-379`), khi model trả về payload không đúng định dạng schema, adapter tự động thực hiện lượt gọi thứ hai: `return call(nudge, remainingMs);`. Lượt gọi này diễn ra hoàn toàn bên trong adapter, không quay trở lại `relay.dispatch`, do đó bypass toàn bộ post-turn và pre-turn checks của facade.
- **Dẫn chứng mã:**
  - `lib/dual/discussion/session.js:61-65`: `conversationIds.codex = codex.conversationId ?? (await (seeds.codex ?? seedCodexConversation)(codex.seedOptions)).conversationId;` (chạy trước dòng 81 `createDiscussionRelay`).
  - `lib/dual/discussion/live-agy-invoke.js:357-379`: `const first = await call(prompt, ...); ... return call(nudge, remainingMs);`.
- **Tác động:** Worker có thể thực hiện I/O hoặc làm ô nhiễm workspace trong quá trình seed hoặc giữa hai lần gọi của internal nudge mà không bị guard phát hiện.
- **Yêu cầu sửa đổi thiết kế:**
  Không được phó thác toàn bộ trách nhiệm guard cho Relay Facade. Thiết kế phải phân rã thành **3 chốt chặn bắt buộc**:
  1. *Seed Guard Wrapper:* Runner phải bọc trực tiếp hàm seed (`seeds.codex`, `seeds.agy`) với pre-check và post-check trước khi truyền vào `createDiscussionSession`.
  2. *Adapter Prespawn Hook:* Live adapter phải chấp nhận một `prespawnGuard` callback được kích hoạt trước *mỗi lần* gọi `spawn` (bao gồm cả lượt gọi nudge nội bộ).
  3. *Relay Facade:* Chỉ phụ trách bọc các boundary message cấp cao (`receive`, `dispatch`, `reconcile`, `inspect`).

---

### [P1-1] Capability preflight probes làm rò rỉ daemon workspaceRoot và bỏ rơi env
- **Mức độ:** P1 (Rò rỉ môi trường / Invariant Violation)
- **Mô tả:** Trong `daemon-ports.js:95-103`, hàm `verifyCapability` trích xuất `workspaceRoot` từ ledger của daemon (`derived.workspaceRoot`). Khi chạy isolated, giá trị này trỏ về thư mục gốc của daemon (shared repo root), không phải `workerRoot`. Hơn nữa, `defaultCodexProbe` (`daemon-ports.js:59-62`) chạy với `cwd: workspaceRoot` mà không nhận `spawnImpl` hay `env`. Trong khi đó, `runCapabilityPreflight` (`capability-preflight.js:551-556`, `:576-581`) dù nhận `options` nhưng không chuyển tiếp `env` vào `spawnBoundedProcess`.
- **Dẫn chứng mã:**
  - `lib/dual/discussion/daemon-ports.js:96-97`: `const derived = replay(state, now()); const workspaceRoot = derived.workspaceRoot;`.
  - `lib/dual/discussion/daemon-ports.js:60-62`: `spawnBoundedProcess(preflight.codexPath ?? '/usr/bin/codex', ['--version'], { cwd: workspaceRoot, timeoutMs: ... })`.
  - `lib/dual/capability-preflight.js:551-556`: `spawnBoundedProcess(..., { spawnImpl, timeoutMs, maxOutputBytes, cwd: workspaceRoot })` — thiếu `env`.
- **Tác động:** Subprocess probe (`codex --version`, `agy --version`, `agy models`) bị chạy trong shared daemon directory, đọc nhầm `.codex/config.toml` của daemon thay vì worker, vi phạm Invariant đề xuất ở dòng 30-31 ("mọi seed, provider turn và capability probe của isolated chạy với private workerRoot").
- **Yêu cầu sửa đổi thiết kế:**
  Thiết kế phải quy định rõ:
  1. `createDaemonHostDeps` nhận `trustedExecutionContext` bắt buộc chứa `{ workerRoot, spawnImpl, env }`.
  2. `defaultCodexProbe` và `runCapabilityPreflight` phải truyền `env` (chứa `GIT_CEILING_DIRECTORIES`) vào `spawnBoundedProcess`.
  3. Factory phải kiểm tra `workerRoot` hợp lệ trước khi gán vào context, không fallback về daemon root trong chuỗi isolated.

---

### [P1-2] Thiếu cơ chế unregister child host gây nguy cơ rò rỉ bộ nhớ và sập shutdown
- **Mức độ:** P1 (Lỗi quản lý vòng đời / Quiescence Failure)
- **Mô tả:** Mục 2 (dòng 113, 137) nêu "Daemon quản lý child registry/shutdown, runner close execution handle... daemon shutdown close cả child đang pending seed". Tuy nhiên, trong `host-resolver.js:75-83`, hàm `closeAll()` lặp qua toàn bộ `cache.values()`. Nếu parent host lưu trữ tham chiếu đến tất cả các child host của từng execution:
  - Khi một execution kết thúc bình thường (`NEEDS_CONTEXT`, `handoff`, hoặc error), runner gọi `child.close()`. Nếu child không tự unregister khỏi parent, parent host sẽ tích lũy rác (memory leak) qua hàng chục executions.
  - Khi daemon shutdown và gọi `parent.closeAll()`, việc gọi lại `child.close()` trên các child đã settled có thể gây ra unhandled rejection hoặc làm `failure` trigger dòng 82 (`if (failure) throw failure.reason`), làm sập tiến trình đóng daemon một cách bất thường.
- **Dẫn chứng mã:**
  - `lib/dual/discussion/host-resolver.js:75-83`: `closeAll()` gom lỗi qua `closed.find((r) => r.status === 'rejected')` và throw.
- **Tác động:** Rò rỉ tài nguyên tiến trình và làm hỏng cơ chế clean shutdown của daemon server.
- **Yêu cầu sửa đổi thiết kế:**
  Bản thiết kế phải bổ sung contract quản lý child host trong parent:
  1. Runner gọi `child.close()` phải đảm bảo tính lũy đẳng (idempotent), trả về fulfilled ngay cả khi đã đóng trước đó.
  2. Khi `child.close()` hoàn tất, child host phải tự động kích hoạt callback unregister để gỡ bỏ chính nó khỏi child registry của parent host.
  3. `closeAll()` của parent host chỉ đóng các child còn active/pending và bỏ qua các child đã quiesced.

---

### [P1-3] Replay check trong `daemon-ports.js` thiếu ràng buộc exact `leaseId` và `operationId`
- **Mức độ:** P1 (Authority Verification Gap)
- **Mô tả:** Hàm `checkAuthority` trong `daemon-ports.js:48-53` xác minh lease bằng cách duyệt `derived.leases`:
  `Object.values(derived.leases).some((lease) => lease.task_id === binding.task_id && computeLeaseStatus(lease, time) === 'active')`.
  Cơ chế này chỉ đòi hỏi có *ít nhất một lease* đang active cho `task_id` đó. Trong môi trường isolated, nếu một lease cũ bị thu hồi và lease mới được cấp (hoặc trong tình huống lease recovery), kiểm tra mặc định của `daemon-ports.js` không phát hiện được sự thay đổi của `leaseId` hay `operationId`.
- **Dẫn chứng mã:**
  - `lib/dual/discussion/daemon-ports.js:48-53`.
  - `lib/dual/isolated-authority.js:151-154`: `assertOperationAuthorized({ authorityStore, taskId, leaseId: lease.lease_id, operationId })`.
- **Tác động:** Một turn discussion có thể tiếp tục dispatch thành công dù `operationId` hoặc `leaseId` thực tế của execution đó đã bị supersede trong authority store.
- **Yêu cầu sửa đổi thiết kế:**
  Mục 4 của bản thiết kế đã nhận ra điểm này (dòng 209-210), nhưng cần chuyển thành yêu cầu thiết kế bắt buộc: Child host reader KHÔNG ĐƯỢC dùng hàm `checkAuthority` mặc định của `daemon-ports.js`. Child host phải bọc authority check bằng closure `authorize()` được truyền từ `isolated-authority.js` (dòng 141-155), buộc phải đối chiếu khớp chính xác `lease_id` và `assertOperationAuthorized(operationId)`.

---

### [P2-1] Mở rộng chữ ký `host.sessionResolver` gây mơ hồ ranh giới giữa Shared và Isolated
- **Mức độ:** P2 (Code Smells & API Ambiguity)
- **Mô tả:** Mục 1.1 (dòng 49-51) đề xuất mở rộng chữ ký của entry point shared `host.sessionResolver` để nhận thêm `execution?: { attempt, workspace_binding_sha256 }, executionId?`. Trong khi đó, dòng 55 định nghĩa `child.sessionResolver` riêng biệt cho isolated execution.
- **Dẫn chứng mã:**
  - `docs/dual/discussion-transport/f01-phase3-isolated-design.md:49-56`.
- **Tác động:** Tạo ra hai cách khác nhau để resolve isolated session. Nếu một caller vô tình truyền `execution` vào shared `host.sessionResolver`, nó có thể kích hoạt luồng xử lý không qua kiểm chứng đầy đủ của factory, hoặc làm phức tạp hóa logic cache của shared host resolver.
- **Yêu cầu sửa đổi thiết kế:**
  Giữ nguyên chữ ký của `host.sessionResolver` dùng cho shared mode (chỉ nhận `taskId, snapshotSha256, phase, workspaceRoot?`). Mọi isolated execution bắt buộc phải đi qua factory `host.createIsolatedDiscussion(...)` để nhận `child.sessionResolver`. Không thêm các trường isolated vào interface của shared host resolver.

---

### [P2-2] So sánh `workspaceRoot` cần dùng `fs.realpathSync.native` thay vì so sánh chuỗi
- **Mức độ:** P2 (Platform Portability & Symlink Robustness)
- **Mô tả:** Mục 1.1 (dòng 65-68) nhắc đến việc so sánh canonical realpath của `workerRoot` và `daemon.workspaceRoot`. Trong Node.js trên Linux và macOS, các thư mục tạm (`/tmp`, `/var`) thường là symlink (ví dụ `/tmp` -> `/var/tmp` hoặc `/private/tmp`).
- **Dẫn chứng mã:**
  - `lib/dual/daemon-server.js:570-577`: Daemon server đã phải dùng `fsImpl.realpathSync?.native` để chuẩn hóa `workspaceRoot`.
  - `lib/dual/task-workspace.js:6-7`: Hàm `readTaskBinding` sử dụng canonical path.
- **Tác động:** Nếu triển khai so sánh `workspaceRoot` bằng so sánh chuỗi thông thường (`===`) hoặc `path.resolve()`, hệ thống sẽ hiểu nhầm một đường dẫn hợp lệ là xâm phạm ranh giới, dẫn đến lỗi `DUAL_ISOLATED_WORKSPACE_MISMATCH` giả.
- **Yêu cầu sửa đổi thiết kế:**
  Quy định rõ trong thiết kế: mọi thao tác so sánh hoặc kiểm tra containment của `workspaceRoot` và `workerRoot` bắt buộc phải đi qua `fs.realpathSync.native()` trước khi kiểm tra ranh giới.

---

## 4. Phản biện chi tiết 5 câu hỏi mở (Mục 8 của thiết kế)

### Câu 1: Chấp thuận Phương án A và mở rộng hooks spawn/env/probe?
- **Lập trường đối kháng:** **ĐỒNG Ý CÓ ĐIỀU KIỆN.**
- **Biện luận:**
  Lập trường đối kháng hoàn toàn ủng hộ vế: **Nếu phạm vi không cho phép các hooks này, BẮT BUỘC giữ isolated BLOCKED.**
  Không thể chấp nhận việc đưa discussion vào isolated mà lại để tiến trình model chạy tự do không có `GIT_CEILING_DIRECTORIES`, không có process tracking trong ledger, và probe chạy sai thư mục làm việc.
  *Điều kiện:* Bản thiết kế phải chi tiết hóa việc sửa đổi 4 module (`live-agy-invoke.js`, `live-codex-invoke.js`, `daemon-ports.js`, `capability-preflight.js`) với contract tham số chuẩn hóa, không được xem đây là "chi tiết phụ".

### Câu 2: Chấp thuận generation theo `operationId` khi resume `NEEDS_CONTEXT`?
- **Lập trường đối kháng:** **ĐỒNG Ý.**
- **Biện luận:**
  Trong chuỗi isolated, `scout` đã hoàn tất và xuất ra `context.json` trước khi `NEEDS_CONTEXT` được trả về cho controller (`isolated-runner.js:180-182`). Khi controller cung cấp câu trả lời, runner resume và chuyển thẳng sang implement lạnh rồi mới tới review discussion.
  Phase `review` không cần và không nên chia sẻ chat session với `scout` (review chỉ cần so sánh diff và đối chiếu contract). Việc tạo conversation mới với `operationId` mới cho phase review đảm bảo tuân thủ tuyệt đối quy tắc của `relay.js` (không mở journal cũ với ID mới) và giữ cho các execution hoàn toàn độc lập.

### Câu 3: Chốt `stateDir` dưới daemon và chính sách retention?
- **Lập trường đối kháng:** **ĐỒNG Ý CÓ ĐIỀU KIỆN.**
- **Biện luận:**
  Giữ nguyên vẹn bằng chứng (evidence) và journal là nguyên tắc cốt lõi của hệ thống audit trong F01.
  *Điều kiện:*
  1. Đường dẫn phải chuẩn hóa thống nhất theo Gói 2a: `.omni/runs/dual-discussion/isolated/<executionKey>`.
  2. Quyền sở hữu thư mục này phải thuộc về daemon; tuyệt đối cấm worker có symlink hay quyền can thiệp vào thư mục này.
  3. Ghi nhận retention policy / log rotation vào technical debt backlog sau Phase 3 để tránh cạn kiệt inode/dung lượng disk.

### Câu 4: Chốt hai mã lỗi mới và ranh giới với Quyết định D1?
- **Lập trường đối kháng:** **ĐỒNG Ý CÓ ĐIỀU KIỆN RANH GIỚI.**
- **Biện luận:**
  Quyết định D1 quy định: `DUAL_DISCUSSION_REQUIRED` là **Precondition Error TRƯỚC `phase.started`, KHÔNG ghi `phase.failed`** nhằm tránh độc hóa task.
  Đối với hai mã mới đề xuất:
  1. `DUAL_ISOLATED_DISCUSSION_FACTORY_REQUIRED`: Xảy ra khi discussion được bật nhưng daemon authority không cung cấp factory. Đây là lỗi cấu hình/wiring của hạ tầng. **BẮT BUỘC ném dạng Precondition Error TRƯỚC khi gọi `orchestrator.runPhase` hoặc trước `phase.started`**, không ghi `phase.failed` để task có thể chạy lại khi wiring sẵn sàng. Điều này 100% tuân thủ D1.
  2. `DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID`: Xảy ra khi hash của baseline, contract, hoặc workerRoot không khớp với reference của authority. Đây là vi phạm bảo mật/toàn vẹn dữ liệu (tương tự `DUAL_ISOLATED_WORKSPACE_MISMATCH`). Mã này là **Terminal Error**, PHẢI ghi nhận và dừng ngay lập tức.
  Sự phân định ranh giới này hoàn toàn giải tỏa nguy cơ xung đột ngữ nghĩa với D1.

### Câu 5: Chốt quyền sở hữu helper test Gói 2b/2c và nghiệm thu live?
- **Lập trường đối kháng:** **ĐỒNG Ý.**
- **Biện luận:**
  Gói 2b sở hữu helper stub có nhận thức execution (`test/helpers/dual-discussion-stub.js`), hỗ trợ mô phỏng child factory và guard hooks. Gói 2c tái sử dụng helper này để thanh toán nợ 33 test fail của `dual-daemon-orchestrator`.
  *Điều kiện nghiệm thu live:* Khi nghiệm thu live isolated, không chấp nhận việc chỉ kiểm tra metadata cwd trong output JSON; kiểm tra phải chứng minh qua process audit thật sự: tiến trình được spawn với cwd đúng là `workerRoot`, biến môi trường Git đã được scrub, và không có tiến trình mồ côi sau khi hoàn thành.

---

## 5. Điều kiện tối thiểu trước khi Muse duyệt triển khai

Để bản thiết kế đủ điều kiện chuyển sang giai đoạn thi công (implementation), tác giả bản thiết kế cần cập nhật tài liệu `f01-phase3-isolated-design.md` nhằm đáp ứng **5 điều kiện tối thiểu** sau:

1. **Bổ sung đặc tả kỹ thuật cho tầng Invoker & Preflight Hooks:**
   Quy định rõ ràng interface mở rộng của `createAgyAdapter`, `createCodexAdapter`, `seedAgyConversation`, `seedCodexConversation`, `runAgy`, `runCodex`, `defaultCodexProbe`, và `runCapabilityPreflight` để nhận và chuyển tiếp `{ spawnImpl, env, signal }`.

2. **Hoàn thiện mô hình 3 chốt chặn Guard Parity:**
   Xóa bỏ giả định "Relay Facade bao phủ mọi I/O". Thay thế bằng kiến trúc 3 chốt chặn rõ ràng: (1) Seed Guard Wrapper tại runner, (2) Prespawn Guard Callback tại adapter (bắt cả internal nudge), và (3) Relay Facade tại relay boundary.

3. **Bịt lỗ rò rỉ `workspaceRoot` của Capability Probes:**
   Quy định rõ ràng `createDaemonHostDeps` nhận `trustedExecutionContext` và bắt buộc dùng `workerRoot` đã qua kiểm chứng (kèm `spawnImpl`/`env`) cho `verifyCapability` và `defaultCodexProbe`.

4. **Xác lập vòng đời lũy đẳng và tự hủy (Unregister) của Child Host:**
   Đặc tả rõ cơ chế tự unregister của child host khi runner gọi `close()`, và đảm bảo `parent.closeAll()` là an toàn, lũy đẳng, không throw crash khi gặp child đã đóng.

5. **Làm rõ ranh giới ném lỗi của mã mới theo D1:**
   Khẳng định dứt khoát trong thiết kế: `DUAL_ISOLATED_DISCUSSION_FACTORY_REQUIRED` ném dạng Precondition Error trước `phase.started`, không ghi `phase.failed`; `DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID` ném dạng Terminal Security Error.
