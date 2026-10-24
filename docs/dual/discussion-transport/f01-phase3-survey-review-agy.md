# Báo cáo Review Đối kháng Bản Khảo sát Phase 3 (F01) — AGY Reviewer

**Người thực hiện:** AGY Reviewer  
**Đối tượng review:** `docs/dual/discussion-transport/f01-phase3-retirement-survey.md` (Codex)  
**Tài liệu tham chiếu:** `docs/dual/discussion-transport/f01-program-status.md`, `docs/dual/discussion-transport/f01-integration-design.md`  
**Môi trường:** Worktree `~/workspace/projects/omni-dual-exp`, nhánh `codex/dual-live-experiment`  
**Phương pháp:** Đọc và đối chiếu mã nguồn tĩnh độc lập (Static Code Verification); không sửa mã nguồn, không chạy test live, không commit.

---

## 1. Verdict Tổng quát

# **ACCEPT WITH FIXES**

### Đánh giá chung:
Bản khảo sát của Codex có chất lượng kỹ thuật rất cao, đào sâu đúng trọng tâm kiến trúc và đã phát hiện chính xác 2 điểm nghẽn nghiêm trọng trong hệ thống sản xuất (lỗ hổng wiring bỏ qua discussion host trong executable `bin/omni-daemon.js` và lỗ hổng rò rỉ workspace root khi nối discussion vào chuỗi `isolated`). 

Tuy nhiên, bản khảo sát cần được **chấp thuận kèm 4 điều chỉnh bắt buộc (Fixes)** trước khi Muse chốt kế hoạch triển khai (Gói 1 & Gói 2):
1. **Fix 1 (Xử lý mã lỗi D1 & Poisoning Task):** Không được ghi sự kiện `phase.failed` non-retryable vào `events.ndjson` khi lỗi xảy ra do thiếu cờ cấu hình discussion (`DUAL_DISCUSSION_REQUIRED`), vì điều này sẽ làm "độc hóa" (poison) task vĩnh viễn, chặn đứng mọi khả năng phục hồi khi khởi động daemon sau đó.
2. **Fix 2 (Phán định D2 về `buildAgyInvocation`):** Bác bỏ (Reject) phương án ép ném lỗi cứng `phase !== 'implement'` tại tầng builder cấp thấp của `agy-runner.js`; giữ builder generic và siết chặt cổng discussion-only hoàn toàn tại `orchestrator.js` để tránh làm vỡ các test boundary schema và vi phạm Separation of Concerns.
3. **Fix 3 (Phạm vi ảnh hưởng của `OMNI_DUAL_DISCUSSION_ENABLED = '0'`):** Cần làm rõ cờ opt-out này đang nằm ở phạm vi cấp file (dòng 13) của `test/dual-daemon-orchestrator.test.js`, ảnh hưởng đến toàn bộ 53 scenarios chứ không chỉ riêng Scenario 7 và 17.
4. **Fix 4 (Bổ sung từ điển lỗi CLI):** Đưa toàn bộ nhóm mã lỗi thảo luận (`DUAL_DISCUSSION_*`) vào `DUAL_ERROR_MESSAGES` của `lib/commands/dual.js` để đảm bảo thông điệp lỗi tiếng Việt chuẩn xác cho người dùng CLI.

---

## 2. Bảng Kiểm Chứng Độc Lập 8 Giả Thuyết (H1 – H8)

| Giả thuyết | Phán định | Bằng chứng mã nguồn (File:Dòng) | Phân tích kiểm chứng đối kháng |
|---|---|---|---|
| **H1:** `createDiscussionHost` có đúng MỘT call site sản xuất trong toàn repo. | **ĐÚNG** | - Khai báo: [`lib/dual/discussion/host-resolver.js:9`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/discussion/host-resolver.js#L9)<br>- Import: [`lib/dual/daemon-server.js:73`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/daemon-server.js#L73)<br>- Call site: [`lib/dual/daemon-server.js:556`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/daemon-server.js#L556) | Quét toàn bộ `lib/`, `bin/`, `scripts/`, `templates/`. Không có bất kỳ call site nào khác trong code sản xuất. `lib/dual/index.js` và `lib/dual/discussion/index.js` không re-export hàm này. `bin/omni-daemon.js` không gọi hàm này. Các call site còn lại chỉ nằm trong thư mục `test/` (ví dụ `test/dual-discussion-host-resolver.test.js`). |
| **H2:** `buildAgyInvocation` có đúng MỘT caller sản xuất (`orchestrator.js:~905`); không còn caller dạng chuỗi/động/re-export nào bị bỏ sót. | **ĐÚNG** | - Khai báo: [`lib/dual/agy-runner.js:27`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/agy-runner.js#L27)<br>- Export: [`lib/dual/agy-runner.js:211`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/agy-runner.js#L211)<br>- Re-export: [`lib/dual/index.js:36`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/index.js#L36)<br>- Call site sản xuất: [`lib/dual/orchestrator.js:905`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/orchestrator.js#L905) | Trong production runtime, hàm chỉ được gọi duy nhất tại `lib/dual/orchestrator.js:905` bên trong vòng lặp lạnh của `executeAgyWithRetry`. Khảo sát đã ghi nhận chính xác việc re-export tại `lib/dual/index.js:36` và một call site phục vụ đo benchmark implement độc lập tại [`test/dual-phase2-implement-exp.js:140`](file:///home/hatch/workspace/projects/omni-dual-exp/test/dual-phase2-implement-exp.js#L140). Không có caller dạng chuỗi hay dynamic lookup nào khác. |
| **H3:** Khẳng định "executable `bin/omni-daemon.js` bỏ qua discussion host" — truy vết `runDaemon` → `startDaemonServer`. | **ĐÚNG** | - Tạo adapter thiếu discussion: [`bin/omni-daemon.js:65-69`](file:///home/hatch/workspace/projects/omni-dual-exp/bin/omni-daemon.js#L65-L69)<br>- Inject vào daemon: [`bin/omni-daemon.js:73-77`](file:///home/hatch/workspace/projects/omni-dual-exp/bin/omni-daemon.js#L73-L77)<br>- Điều kiện triệt tiêu host: [`lib/dual/daemon-server.js:555`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/daemon-server.js#L555)<br>- Adapter nhận option: [`lib/dual/orchestrator-adapter.js:36-51`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/orchestrator-adapter.js#L36-L51) | Truy vết luồng: `bin/omni-daemon.js` tự tạo `orchestratorAdapter` chỉ với `{ workspaceRoot, authorityStore, agyProjectId }` (thiếu `discussion`). Khi truyền `orchestrator` vào `startDaemonServer`, điều kiện `orchestrator === undefined` ở `daemon-server.js:555` bị `false`, khiến `discussionHost = null`. Adapter được inject cũng không tự đọc biến môi trường. Do đó, binary `bin/omni-daemon.js` hiện tại **HOÀN TOÀN KHÔNG DỰNG DISCUSSION HOST**. Test harness live Phase 2 chỉ xanh vì đã cố tình bỏ qua `orchestrator` để rơi vào default factory. |
| **H4:** Chuỗi isolated: discussion rơi ở đâu chính xác; khẳng định private orchestrator chạy scout VÀ review lạnh có đúng cả hai phase không. | **ĐÚNG** | - Rơi lần 1: [`lib/dual/isolated-authority.js:167-189`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/isolated-authority.js#L167-L189)<br>- Rơi lần 2: [`lib/dual/isolated-runner.js:134-150`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/isolated-runner.js#L134-L150)<br>- Scout lạnh: [`lib/dual/isolated-runner.js:160`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/isolated-runner.js#L160)<br>- Review lạnh: [`lib/dual/isolated-runner.js:194`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/isolated-runner.js#L194) | 1. Điểm rơi: Bị rơi ở **CẢ HAI NƠI**. `executeIsolatedAuthorityTask` nhận `options` từ adapter nhưng không truyền `discussion` vào `runIsolatedTask`. Đồng thời, `runIsolatedTask` cũng không truyền `discussion` khi khởi tạo `createDualOrchestrator`.<br>2. Hai phase lạnh: Hoàn toàn chính xác. Scout được gọi trực tiếp bằng `orchestrator.runPhase('scout')` (:160), còn Review được gọi gián tiếp qua `orchestrator.run()` (:194, tiến trình qua implement -> scope -> review). Vì orchestrator private không có discussion, cả hai phase đều rơi xuống vòng lặp `while` lạnh (:899). |
| **H5:** Bảng di trú test mục 4: kiểm chứng 3 file LOẠI và 3 file GỒM; quét các suite chạy cold scout/review bị bỏ sót. | **PHẦN ĐÚNG** | - 3 file LOẠI: [`dual-authority-cli-routing:108`](file:///home/hatch/workspace/projects/omni-dual-exp/test/dual-authority-cli-routing.test.js#L108), [`dual-incident-routing:114`](file:///home/hatch/workspace/projects/omni-dual-exp/test/dual-incident-routing.test.js#L114), [`dual-contracts:1`](file:///home/hatch/workspace/projects/omni-dual-exp/test/dual-contracts.test.js#L1)<br>- 3 file GỒM: [`dual-orchestrator:37`](file:///home/hatch/workspace/projects/omni-dual-exp/test/dual-orchestrator.test.js#L37), [`dual-cli:223`](file:///home/hatch/workspace/projects/omni-dual-exp/test/dual-cli.test.js#L223), [`dual-e2e:190`](file:///home/hatch/workspace/projects/omni-dual-exp/test/dual-e2e.test.js#L190)<br>- Cờ cấp file: [`dual-daemon-orchestrator:13`](file:///home/hatch/workspace/projects/omni-dual-exp/test/dual-daemon-orchestrator.test.js#L13) | 1. Phân loại 3 file LOẠI và 3 file GỒM là **chính xác 100%**.<br>2. Điểm khảo sát chưa nêu hết: Trong `test/dual-daemon-orchestrator.test.js`, biến `process.env.OMNI_DUAL_DISCUSSION_ENABLED = '0'` được đặt ở **dòng 13 cấp module**, ảnh hưởng đến **toàn bộ 53 scenarios** trong file chứ không chỉ riêng Scenario 7 hay Scenario 17. Nếu không xử lý fixture discussion ở cấp file, suite này sẽ vỡ diện rộng hơn dự kiến của khảo sát. |
| **H6:** Kết luận mục 2.3 "giữ khối tiền kiểm capability": nơi tiêu thụ `cachedAgyVersion` và thứ tự precheck-trước-resolver. | **ĐÚNG** | - Khai báo: [`lib/dual/orchestrator.js:504`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/orchestrator.js#L504)<br>- Tiền kiểm: [`lib/dual/orchestrator.js:783-813`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/orchestrator.js#L783-L813)<br>- Resolver gate: [`lib/dual/orchestrator.js:820-827`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/orchestrator.js#L820-L827)<br>- Tiêu thụ: [`lib/dual/orchestrator.js:748`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/orchestrator.js#L748)<br>- Schema: [`lib/dual/contracts.js:364`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/contracts.js#L364) | 1. `cachedAgyVersion` là biến closure nội bộ, chỉ được đọc duy nhất tại `saveAttemptEvidence` (:748) để ghi vào `raw/<phase>.<attempt>.meta.json`. Schema `AttemptMetaSchema` (:364) bắt buộc trường này không rỗng.<br>2. Thứ tự tiền kiểm (:783-813) chạy trước resolver check (:820). Nếu authoritative capability hỏng hoặc agy CLI thiếu, hệ thống phải ném lỗi capability (`DUAL_PREFLIGHT_*`) trước khi xét tới discussion. Giữ khối này là đúng đắn về mặt kiến trúc. |
| **H7:** Quyết định D2: Siết `buildAgyInvocation` chỉ nhận phase 'implement', phase khác → lỗi typed. | **SAI (Bác bỏ quyết định D2)** | - Builder: [`lib/dual/agy-runner.js:50, 65`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/agy-runner.js#L50)<br>- Direct test: [`test/dual-agy-runner.test.js:85, 110, 140`](file:///home/hatch/workspace/projects/omni-dual-exp/test/dual-agy-runner.test.js#L85)<br>- Boundary test: [`test/dual-agy-schema-boundary.test.js:29, 33`](file:///home/hatch/workspace/projects/omni-dual-exp/test/dual-agy-schema-boundary.test.js#L29)<br>- Custom model test: [`test/dual-custom-model.test.js:161`](file:///home/hatch/workspace/projects/omni-dual-exp/test/dual-custom-model.test.js#L161) | **Tấn công quyết định D2:** Siết cứng `phase === 'implement'` trong builder là sai lầm kiến trúc (xem mục 4):<br>1. Vi phạm Separation of Concerns: `agy-runner` là CLI argument builder cấp thấp, không nên mang tri thức phân luồng transport của orchestrator.<br>2. Làm vỡ vô lý 3 test suite cấp thấp đang kiểm tra tính tương thích của JSON schema root và model arguments (`dual-agy-schema-boundary`, `dual-agy-runner`, `dual-custom-model`).<br>3. `orchestrator.js:905` đã là caller sản xuất duy nhất; chỉ cần chặn ở orchestrator là đủ 100% mục tiêu Phase 3 mà không cần phá vỡ API của builder. |
| **H8:** Quyết định D1: Thêm mã lỗi MỚI `DUAL_DISCUSSION_REQUIRED` cho scout/review khi discussion bị tắt/thiếu. | **PHẦN ĐÚNG (Đồng ý kèm điều kiện)** | - Error map: [`lib/commands/dual.js:39-124`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/commands/dual.js#L39-L124)<br>- Discussion errors: [`lib/dual/discussion/contracts.js:5-17`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/discussion/contracts.js#L5-L17)<br>- Event schema: [`lib/dual/contracts.js:326`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/contracts.js#L326)<br>- Orchestrator seam: [`lib/dual/orchestrator.js:820-826`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/orchestrator.js#L820-L826) | 1. Không xung đột với bất kỳ mã lỗi sẵn có nào trong `DUAL_ERROR_MESSAGES`, `ERROR_CODES`, hay `PUBLIC_ERROR_MESSAGES`. Phù hợp với `EventSchema.error_code`.<br>2. Phân định rõ 3 trạng thái: `DUAL_DISCUSSION_REQUIRED` (chưa bật transport), `DUAL_DISCUSSION_RESOLVER_REQUIRED` (bật nhưng thiếu resolver), `DUAL_DISCUSSION_SESSION_DISABLED` (resolver trả về phiên bị tắt). Không gây nhầm lẫn.<br>3. **Điều kiện bắt buộc:** Không được gộp vào `RESOLVER_REQUIRED` vì sẽ gây chẩn đoán sai lệch cho CLI; nhưng bắt buộc phải xử lý lỗi này như Precondition Error (không ghi terminal failure vào ledger) và phải thêm bản dịch vào `DUAL_ERROR_MESSAGES`. |

---

## 3. Findings Bổ Sung (Xếp hạng P0 → P2)

### Finding 1 [P0] — Executable production `bin/omni-daemon.js` triệt tiêu hoàn toàn Discussion Host
- **Mô tả:** Trong [`bin/omni-daemon.js:65-77`](file:///home/hatch/workspace/projects/omni-dual-exp/bin/omni-daemon.js#L65-L77), daemon production tự khởi tạo `orchestratorAdapter` độc lập mà không truyền option `discussion`, rồi inject vào `startDaemonServer`. Tại [`lib/dual/daemon-server.js:555`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/daemon-server.js#L555), điều kiện dựng discussion host là `orchestrator === undefined`. Do đó, `discussionHost` luôn bị gán bằng `null`.
- **Bằng chứng:** 
  ```javascript
  // bin/omni-daemon.js:65-69
  const orchestratorAdapter = createOrchestratorAdapter({
      workspaceRoot: canonicalWorkspace,
      authorityStore,
      ...(agyProjectId ? { agyProjectId } : {}),
  }); // -> Hoàn toàn không có discussion!
  ```
  ```javascript
  // lib/dual/daemon-server.js:555
  const discussionHost = orchestrator === undefined && discussionEnabledFromEnv(process.env)
      ? createDiscussionHost(...) : null; // -> Trả về null vì orchestrator !== undefined!
  ```
- **Hệ quả:** Binary `omni-daemon` chạy thực tế trên production chưa bao giờ kích hoạt discussion. Khi Phase 3 cắt bỏ đường lạnh ở `orchestrator.js`, toàn bộ các task chạy qua `bin/omni-daemon.js` sẽ lập tức crash ở phase `scout`.
- **Sửa đề xuất (Gói 2):** Thống nhất quyền sở hữu tại `daemon-server.js`. Nếu caller truyền vào một `orchestratorAdapter` chưa có discussion, factory phải tự inject `{ enabled: true, sessionResolver: discussionHost.sessionResolver }` vào adapter đó trước khi chạy, thay vì bỏ qua hoàn toàn việc tạo host.

---

### Finding 2 [P0] — Lỗ hổng rò rỉ Workspace Root khi nối Discussion vào Chuỗi Isolated
- **Mô tả:** Chuỗi isolated task hiện đang làm rơi options `discussion` tại [`lib/dual/isolated-authority.js:167`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/isolated-authority.js#L167) và [`lib/dual/isolated-runner.js:134`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/isolated-runner.js#L134). Tuy nhiên, nguy hiểm hơn là cấu hình của `createDiscussionHost` tại [`lib/dual/discussion/host-resolver.js:58-59`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/discussion/host-resolver.js#L58-L59) đang ghim cứng thư mục làm việc của model:
  ```javascript
  codex: { seedOptions: { cwd: daemon.workspaceRoot } },
  agy: { seedOptions: { cwd: daemon.workspaceRoot } },
  ```
- **Bằng chứng:** Trong `host-resolver.js`, `sessionResolver` nhận `workspaceRoot` từ orchestrator (`:835`) nhưng hoàn toàn bỏ qua, mà chỉ dùng `daemon.workspaceRoot` được capture qua closure khi tạo host.
- **Hệ quả:** Nếu triển khai Gói 2 một cách ngây thơ bằng cách chuyển tiếp `sessionResolver` của daemon vào `isolated-runner`, tiến trình model của worker sẽ chạy lệnh và đọc ghi trực tiếp trên `daemon.workspaceRoot` (mã nguồn chính) thay vì `workerRoot` (thư mục cô lập tạm thời). Điều này làm vô hiệu hóa toàn bộ cơ chế bảo vệ isolated workspace, gây ô nhiễm mã nguồn chính và rò rỉ dữ liệu.
- **Sửa đề xuất (Gói 2):** Cải tiến `host-resolver.js` để hỗ trợ session resolver nhận biết dynamic `workspaceRoot` hoặc tạo một scoped discussion session factory riêng cho isolated task, bảo đảm cwd và snapshot text bám đúng `workerRoot` và baseline của task.

---

### Finding 3 [P1] — Nguy cơ "Độc Hóa" Task Ledger (Poisoning Task) khi ném `DUAL_DISCUSSION_REQUIRED`
- **Mô tả:** Khảo sát mục 2.1 và 6.1 đề xuất: khi thiếu hoặc tắt discussion cho scout/review, orchestrator phải tạo failure artifact và ghi terminal event `phase.failed` non-retryable.
- **Bằng chứng:** Trong [`lib/dual/orchestrator.js:1116-1127`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/orchestrator.js#L1116-L1127), hàm `findTerminalPhaseFailure` sẽ quét `events.ndjson`. Bất kỳ task nào có sự kiện `phase.failed` với `retryable: false` sẽ bị chặn vĩnh viễn không cho chạy lại `runPhase`.
- **Hệ quả:** Nếu một người dùng hoặc script kiểm thử gọi lệnh CLI độc lập (ví dụ `omni dual phase scout TASK-1`) vốn không có discussion host, hệ thống sẽ ghi ngay `phase.failed` non-retryable vào `events.ndjson`. Sau đó, kể cả khi người dùng khởi động daemon và gọi `omni dual run TASK-1` (đã có discussion đầy đủ), task đó cũng **không thể chạy tiếp được nữa** và bị hỏng vĩnh viễn.
- **Sửa đề xuất (Gói 1):** Thiếu discussion transport là một lỗi tiền điều kiện (Precondition Error) của môi trường gọi, tương tự như `DUAL_PREFLIGHT_AUTHORITY_INVALID` ([`orchestrator.js:804`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/orchestrator.js#L804)). Nó phải ném lỗi TRƯỚC KHI gọi `store.append({ type: 'phase.started' })` và TUYỆT ĐỐI KHÔNG ghi sự kiện `phase.failed` vào `events.ndjson`.

---

### Finding 4 [P1] — Cờ opt-out cấp file trong `dual-daemon-orchestrator.test.js` bao trùm toàn bộ 53 Scenarios
- **Mô tả:** Bản khảo sát mục 4.3 ghi nhận `test/dual-daemon-orchestrator.test.js:11-13` đặt `process.env.OMNI_DUAL_DISCUSSION_ENABLED = '0'` và nhắc đến Scenario 7 và 17.
- **Bằng chứng:** 
  ```javascript
  // test/dual-daemon-orchestrator.test.js:13
  process.env.OMNI_DUAL_DISCUSSION_ENABLED = '0';
  ```
  Dòng code này nằm ở phạm vi top-level module, thực thi ngay khi file test được load.
- **Hệ quả:** Toàn bộ 4007 dòng và 53 scenarios trong file này đều chạy trong trạng thái discussion bị tắt. Khi Gói 1 biến trạng thái tắt discussion thành lỗi fail-closed (`DUAL_DISCUSSION_REQUIRED`), không chỉ Scenario 7 và 17 mà rất nhiều scenarios khác có kích hoạt worker AGY sẽ đồng loạt thất bại nếu không có chiến lược di trú fixture tổng thể.
- **Sửa đề xuất (Gói 2):** Xóa bỏ gán cờ toàn cục ở dòng 13. Thay vào đó, thiết lập fixture discussion stub mặc định cho suite daemon này, và chỉ set `OMNI_DUAL_DISCUSSION_ENABLED = '0'` cục bộ bên trong đúng 1 test case negative kiểm chứng hành vi fail-closed.

---

### Finding 5 [P2] — Thiếu toàn bộ ánh xạ mã lỗi Discussion trong `DUAL_ERROR_MESSAGES` của CLI
- **Mô tả:** Bộ từ điển lỗi CLI tại [`lib/commands/dual.js:39-124`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/commands/dual.js#L39-L124) hiện chưa có bất kỳ mã lỗi thảo luận nào: không có `DUAL_DISCUSSION_RESOLVER_REQUIRED`, `DUAL_DISCUSSION_SESSION_DISABLED`, `DUAL_DISCUSSION_BINDINGS_REQUIRED`, `DUAL_DISCUSSION_FAILED`, và mã mới `DUAL_DISCUSSION_REQUIRED`.
- **Bằng chứng:** Khi gặp các lỗi này, hàm `handleDualError` (:269-280) phải in fallback tiếng Anh thô từ `error.message`.
- **Hệ quả:** Trải nghiệm CLI thiếu đồng bộ, vi phạm nguyên tắc ngôn ngữ tiếng Việt của dự án.
- **Sửa đề xuất (Gói 2):** Khai báo đầy đủ các mã lỗi này trong `DUAL_ERROR_MESSAGES`, hướng dẫn rõ ràng: *"Giai đoạn scout/review bắt buộc phải có phiên đối thoại thông qua daemon; CLI độc lập không hỗ trợ tự chạy đối thoại."*

---

### Finding 6 [P2] — Bẫy thiết kế API khi ép `buildAgyInvocation` ném lỗi typed
- **Mô tả:** Đề xuất siết `buildAgyInvocation` chỉ nhận `phase: 'implement'` (Quyết định D2) tạo ra một signature API bất thường: hàm nhận tham số `phase` nhưng sẽ crash nếu truyền bất kỳ giá trị nào khác ngoài `'implement'`.
- **Bằng chứng:** [`lib/dual/agy-runner.js:27-50`](file:///home/hatch/workspace/projects/omni-dual-exp/lib/dual/agy-runner.js#L27-L50).
- **Hệ quả:** Phá vỡ tính trực giao của thư viện `agy-runner`. Làm hỏng các bài kiểm thử biên độc lập (`dual-agy-schema-boundary.test.js`) mà không giải quyết thêm rủi ro nào ở runtime, vì `orchestrator.js` đã là caller sản xuất duy nhất.
- **Sửa đề xuất:** Giữ nguyên hàm builder generic hoặc đặt giá trị mặc định `phase = 'implement'`, tập trung toàn bộ chốt chặn fail-closed tại `orchestrator.js`.

---

## 4. Phán Định Riêng Cho 2 Quyết Định Thiết Kế (D1 / D2)

### Quyết định D1: Thêm mã lỗi MỚI `DUAL_DISCUSSION_REQUIRED` cho Scout/Review khi Discussion bị tắt/thiếu
- **Phán định:** **ĐỒNG Ý KÈM ĐIỀU KIỆN (ACCEPT WITH CONDITIONS)**
- **Lý do & Phân tích:**
  1. *Sự cần thiết của mã mới:* Việc phân tách giữa `DUAL_DISCUSSION_REQUIRED` (chưa bật hoặc không có transport) và `DUAL_DISCUSSION_RESOLVER_REQUIRED` (đã bật `enabled: true` nhưng thiếu hàm `sessionResolver`) là hoàn toàn chính xác về mặt ngữ nghĩa kỹ thuật.
  2. *Cái giá của việc gộp mã:* Nếu gộp chung vào `DUAL_DISCUSSION_RESOLVER_REQUIRED`, khi người dùng chạy lệnh CLI standalone hoặc chạy daemon với `OMNI_DUAL_DISCUSSION_ENABLED=0`, hệ thống sẽ báo "thiếu resolver". Thông báo này gây đánh lừa người vận hành rằng họ chỉ cần cung cấp hàm resolver, trong khi bản chất là tính năng discussion đang bị tắt hoặc chưa được cấu hình ở chế độ standalone.
  3. *Điều kiện bắt buộc:*
     - Lỗi `DUAL_DISCUSSION_REQUIRED` phải được ném ra như một **Precondition Error** (trước `phase.started`), không được ghi terminal failure non-retryable vào `events.ndjson` để tránh độc hóa task store (Finding 3).
     - Phải bổ sung định nghĩa và thông điệp tiếng Việt tương ứng vào `DUAL_ERROR_MESSAGES` tại `lib/commands/dual.js` (Finding 5).

---

### Quyết định D2: Siết `buildAgyInvocation` chỉ nhận phase 'implement', phase khác → lỗi typed
- **Phán định:** **BÁC BỎ (REJECT)**
- **Lý do & Phân tích:**
  1. *Vi phạm nguyên tắc phân tầng (Layering & Separation of Concerns):* `lib/dual/agy-runner.js` là module wrapper hạ tầng cấp thấp (low-level process execution helper), có trách nhiệm định dạng đối số dòng lệnh CLI cho tiến trình con `agy`. Chính sách nghiệp vụ "scout và review phải dùng discussion, implement dùng process runner" thuộc về tầng điều phối (`lib/dual/orchestrator.js`). Ép ràng buộc nghiệp vụ này xuống tầng helper làm méo mó trách nhiệm của module.
  2. *Code smell ở Interface:* Một hàm nhận tham số `phase` (thuộc tập 7 phase trong `PhaseSchema`) nhưng lại ném lỗi với 6/7 giá trị là một thiết kế API dị tật. Nếu chỉ cho phép implement, hàm nên được đổi tên thành `buildAgyImplementInvocation` và bỏ luôn tham số `phase`.
  3. *Gây vỡ test vô ích (Pointless Breakage):* `buildAgyInvocation` hiện đang được dùng trong các bài kiểm thử contract độc lập như `test/dual-agy-schema-boundary.test.js` để xác minh rằng Draft7 schema của Context/Evidence/Review đều tương thích với cờ `--json-schema` của AGY. Siết cứng phase implement sẽ phá vỡ các bài test này một cách không cần thiết.
  4. *Thực tế sản xuất đã an toàn 100%:* Bằng chứng độc lập H2 đã chứng minh `orchestrator.js:905` là caller sản xuất **DUY NHẤT** trong toàn bộ repo. Chỉ cần đóng nhánh lạnh tại `orchestrator.js:820` là 100% lưu lượng sản xuất của scout/review đã được chuyển sang discussion, mục tiêu retirement của Phase 3 đã hoàn thành trọn vẹn mà không cần sửa đổi thô bạo vào `agy-runner.js`.

---

## 5. Kết Luận & Khuyến Nghị Cho Muse

1. Bản khảo sát của Codex đủ điều kiện nghiệm thu để bước vào giai đoạn thực thi sau khi cập nhật 4 nội dung Fix nêu trên.
2. Thứ tự thực thi nên giữ nguyên 2 gói:
   - **Gói 1:** Khóa chặt nhánh discussion tại `orchestrator.js:820` với mã `DUAL_DISCUSSION_REQUIRED` (ném lỗi dạng precondition), giữ nguyên tính generic của `buildAgyInvocation`, và cập nhật các suite test orchestrator cơ bản.
   - **Gói 2:** Xử lý triệt để 2 lỗ hổng P0 về wiring daemon (`bin/omni-daemon.js`) và isolated workspace root binding (`host-resolver.js`), dọn dẹp cờ opt-out toàn cục trong `dual-daemon-orchestrator.test.js`, và bổ sung từ điển lỗi CLI.
3. Không thực hiện bất kỳ commit hay thay đổi mã nguồn nào trong lượt review này theo đúng kỷ luật brief.
