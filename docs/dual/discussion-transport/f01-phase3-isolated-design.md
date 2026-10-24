# F01 Phase 3 — Thiết kế discussion cho chuỗi isolated (Gói 2b-0)

Ngày: 2026-10-24. Trạng thái: **ĐÃ DUYỆT TRIỂN KHAI (Muse, 24/10/2026)** — AGY review ACCEPT WITH FIXES, bản này đã sửa đủ theo review và các chốt của Muse.
Lượt này chỉ sửa tài liệu thiết kế theo review; không triển khai, chạy test/live hay commit. Chữ ký, cơ chế và error code
dưới đây là contract thiết kế đã sửa, chưa phải behavior hiện hành. Dẫn chứng `file:line` tính từ repo root;
khoảng dòng chỉ khối mã liên quan.

Đã đọc mục 3.2, 4.4 của `docs/dual/discussion-transport/f01-phase3-retirement-survey.md`,
mục “Gói 0 — ĐÃ DUYỆT”, “Gói 2a — ĐẠT” và các chốt Muse ở mục “Gói 2b — thiết kế isolated”
của `docs/dual/discussion-transport/f01-program-status.md`; đã đối chiếu findings, H4/H7 và 5 điều kiện
tối thiểu của `docs/dual/discussion-transport/f01-phase3-isolated-design-review-agy.md`.
Giữ D1: thiếu discussion là precondition trước `phase.started`, không độc hóa task; D2: giữ builder generic.
Host wiring thuộc daemon-server, isolated cần được duyệt thiết kế trước triển khai
(`docs/dual/discussion-transport/f01-program-status.md:97-127`). Không khôi phục OLD benchmark, không thêm
hidden cold fallback; historical diagnostics ngoài phạm vi isolated
(`docs/dual/discussion-transport/f01-phase3-retirement-survey.md:150-158`).

## 0. Tiền đề và invariant

Dùng hiện trạng brief làm tiền đề, chỉ đối chiếu mã để dẫn chứng và xác định contract:

- Adapter route isolated với `...options`, nhưng authority chưa chuyển discussion xuống runner
  (`lib/dual/orchestrator-adapter.js:72-74`, `lib/dual/isolated-authority.js:167-189`).
- Runner tạo orchestrator private chưa cấp discussion, gọi scout trực tiếp rồi gọi run cho phần còn lại
  (`lib/dual/isolated-runner.js:134-160`, `lib/dual/isolated-runner.js:194`).
- Resolver chỉ nhận task/baseline, cache task|baseline|revision, seed bằng daemon cwd
  (`lib/dual/discussion/host-resolver.js:35-59`); orchestrator đã truyền workspaceRoot
  (`lib/dual/orchestrator.js:838-843`). Chuyển nguyên shared resolver chưa giải quyết cô lập.
- Scout/review thiếu discussion hiện fail `DUAL_DISCUSSION_REQUIRED`; implement vẫn đến cold loop
  (`lib/dual/orchestrator.js:820-828`, `lib/dual/orchestrator.js:906-908`).

**Invariant đề xuất:** mọi seed, provider turn và capability probe của isolated chạy với private workerRoot;
quyền chạy vẫn thuộc daemon ledger/lease/operation. Worker baseline không thay daemon.currentBaseline.
Không nhận result/handoff khi guard thất bại. Discussion không tự chứng nhận QC hoặc tích hợp source.
Ranh giới hiện tại là runner kiểm artifact/baseline/result rồi xuất handoff, authority ghi handoff riêng
(`lib/dual/isolated-runner.js:200-248`, `lib/dual/isolated-authority.js:199-212`); phải giữ nguyên.

## 1. Định danh resolver cho isolated

### 1.1 Contract đề xuất

```ts
// Additive capability tại daemon-side host; execution context do authority cấp.
host.createIsolatedDiscussion({
  workerRoot, reference, workerBaselineId, workerContractSha256,
  sessionId, taskId, planRevision, attempt, leaseId, operationId,
  authorize, guards, env, spawnImpl, signal, capability
}): Promise<{ enabled: true, sessionResolver, close }>

// Entry point shared giữ nguyên chữ ký; isolated chỉ đi qua factory.
host.sessionResolver({
  taskId, snapshotSha256, phase, workspaceRoot?
}): Promise<DiscussionSession>

// Child resolver đóng trên context đã xác thực, nhận context orchestrator hiện có.
child.sessionResolver({ taskId, snapshotSha256, phase, workspaceRoot }): Promise<DiscussionSession>
```

`executionKey` là opaque digest do factory cấp, không phải đường dẫn hay authority assertion từ model.
Session/revision/lease/operation/attempt nằm trong closure; không lấy từ brief hoặc thêm option giả vào orchestrator.
Child khóa `planRevision` từ execution closure, không gọi động `daemon.getPlanRevision()`; revision hiện hành
trong ledger chỉ dùng để xác minh/fence captured revision, không thay revision của child.
Context hiện phát từ journal baseline và repoRoot (`lib/dual/orchestrator.js:835-843`).
Runner phải xác thực binding, baseline và contract trước khi gọi factory; hiện đã đối chiếu
session/task/attempt/revision/scope và hash saved baseline/contract (`lib/dual/isolated-runner.js:70-110`).
Factory kiểm lại reference với daemon authority, không tin workerRoot tự khai.

**WorkspaceRoot:** chuẩn hóa bằng `fs.realpathSync.native()` trước MỌI so sánh root hoặc kiểm containment,
bao gồm workerRoot, root trong reference/ledger và daemon.workspaceRoot, ở cả shared lẫn isolated.
Không thay bằng so sánh chuỗi thô hoặc `path.resolve()`; realpath lỗi thì fail-closed.
WorkerRoot lấy từ reference đã xác thực; kiểm containment và symlink ở mỗi boundary.
Child resolver thiếu root hoặc root khác closure phải fail trước seed, không fallback daemon root.
Shared resolver bỏ root thì dùng daemon.workspaceRoot; root canonical bằng daemon root giữ behavior cũ.
Root khác daemon chỉ hợp lệ qua execution factory, không cấp quyền chạy arbitrary workspace từ shared resolver.

**Ba identity không được nhập làm một:**

1. `W`: canonical workerRoot.
2. `B`: worker snapshot identity, khác hash bytes của worker-baseline.json.
3. `D`: SHA256 discussion snapshot text; binding.snapshot_sha256 bằng D.

Runner hiện lưu baseline file hash rồi dùng `initialSnapshot.identity` cho spec
(`lib/dual/isolated-runner.js:86-99`). Resolver băm text chứa baseline thành D, đăng ký hash từ binding;
test khẳng định D khác input baseline (`lib/dual/discussion/host-resolver.js:43-66`,
`test/dual-discussion-host-resolver.test.js:121-123`). Thiết kế giữ ngữ nghĩa đó.

**Key isolated đề xuất:** hash serialization có cấu trúc của
`["isolated", sessionId, taskId, planRevision, W, attempt, reference.bindingSha256, B, operationId]`.
OperationId phân biệt hai execution cùng attempt sau NEEDS_CONTEXT/restart; leaseId được bind trong manifest/closure.
Không đưa phase vào key: scout/review của cùng execution chia sẻ conversation. Cache pending promise trước await
để tránh double-seed concurrent. Snapshot text isolated chứa các identity trên và workerContractSha256.
Cả hai bindings dùng execution field sẵn có `{attempt, workspace_binding_sha256}`; schema đã hỗ trợ và yêu cầu
hai bên thống nhất (`lib/dual/discussion/contracts.js:327`, `lib/dual/discussion/contracts.js:353-367`,
`lib/dual/discussion/contracts.js:439-449`); session đã chuyển options.execution vào bindings
(`lib/dual/discussion/session.js:66-75`). Không cần mở rộng public binding schema cho thiết kế này.

**StateDir/journal:** đường dẫn `.omni/runs/dual-discussion/isolated/<executionKey>` dưới daemon root,
do daemon sở hữu, ngoài worker source và runtime orchestrator; worker không có quyền can thiệp hoặc
symlink vào đây. Giữ evidence/journal sau close/QC; retention/GC/log rotation là nợ kỹ thuật sau Phase 3,
không tự GC trong gói này. Manifest immutable ghi W/B/D, reference/contract hashes, conversation IDs,
attempt/revision/lease/operation. Kiểm path/parent không symlink trước tạo/mở; key hash chỉ là tên an toàn,
manifest mới là căn cứ đối chiếu. Không copy shared journal/conversation vào worker.
StateDir hiện ghép từ encoded cacheKey (`lib/dual/discussion/host-resolver.js:53-59`);
namespace mới không được thay đường dẫn legacy.

### 1.2 Tương thích ngược

Nhánh shared mặc định giữ nguyên cache key task|baseline|revision, snapshot text, stateDir suffix,
seed cwd daemon root, supersession theo task, return shape và resolver function identity.
Không thêm execution field cho shared, không đổi env off/invalid, executable agyProjectId hoặc shutdown.
Regression contract hiện gồm same session qua scout/review, seed đúng root, stale baseline/revision bị deny
(`test/dual-discussion-host-resolver.test.js:113-150`), resolver identity/env gating/agyProjectId/close lifecycle
(`test/dual-daemon-host-wiring.test.js:95-108`, `test/dual-daemon-host-wiring.test.js:127-165`).
Đây là yêu cầu giữ nguyên các tests đang xanh theo brief, không phải kết quả chạy lại trong lượt này.

## 2. Chuyển discussion qua hai lớp và lựa chọn ownership

| Tiêu chí | A — Daemon-side factory cấp child host | B — Isolated tự dựng host riêng |
|---|---|---|
| Cô lập workspace | Reference đã kiểm; seeds/adapters riêng bind W; không đổi cwd shared | Runner có sẵn W nhưng phải nhân đôi wiring/probe/policy daemon |
| Conversation lifecycle | Daemon quản lý child registry/shutdown, runner close execution handle | Runner dễ close ở return/error, nhưng daemon khó quản lý host khi shutdown/recovery |
| Authority | Đọc daemon ledger, bind exact lease/operation; không acquire lease thứ hai | Vẫn phải inject daemon reader/authorize; worker ledger riêng không chứng minh controller permission |
| Baseline | Child registry giữ B/D riêng, không ghi shared task registry | Registry riêng đơn giản nhưng dễ đồng nhất worker state với quyền chạy |
| Chi phí | Additive factory, forwarding hai lớp, adapters theo execution và guard facade | Runner coupling với daemon ports/config, có nguy cơ policy drift |

**CHỌN A:** daemon-side factory tạo child host theo execution, dùng authority store và lease daemon đã cấp.
Runner cung cấp worker identity đã xác thực và guard hooks, không tự tạo authority ledger/acquire lease.
Không tái dùng shared adapter bằng cách mutate cwd. Daemon hiện sở hữu adapters/authority envelope reader
(`lib/dual/daemon-server.js:448-475`), runner nhận authorize từ authority owner
(`lib/dual/isolated-runner.js:40-49`); A giữ được phân quyền này.

**Luồng đề xuất:**

1. Host công bố `createIsolatedDiscussion` cạnh sessionResolver. Default factory và executable cùng chuyển
   capability đó trong discussion option, giữ nguyên resolver shared và helper ownership của Gói 2a.
2. Adapter đã chuyển `...options`; isolated-authority thêm forwarding factory tới runIsolatedTask.
   Authority bind exact leaseId/operationId/authorize sau acquire lease và begin operation.
   Ownership hiện nằm tại `lib/dual/isolated-authority.js:118-155`.
3. Runner hoàn tất binding/baseline/contract, onPrepared và dependencies rồi yêu cầu child trước scout.
   Factory kiểm reference trong authority, task isolated, attempt, lease/operation còn active trước mọi seed.
4. Runner cấp `{enabled: true, sessionResolver: guardedResolver}` vào orchestrator private;
   cùng child phục vụ scout trực tiếp và review qua run. Không chuyển resolver shared xuống nguyên trạng.
5. Missing/disabled discussion: zero seed, giữ seam DUAL_DISCUSSION_REQUIRED theo D1, không cold fallback.
   Enabled nhưng thiếu factory: ném `DUAL_ISOLATED_DISCUSSION_FACTORY_REQUIRED` dạng precondition
   trước `orchestrator.runPhase`/`phase.started`, zero provider I/O, không ghi `phase.failed` (D1).
6. Runner finally quiesce/close child trên NEEDS_CONTEXT, handoff và error; daemon shutdown close cả child
   đang pending seed. Lifecycle chi tiết bên dưới; không xóa journal. Child chưa dừng thì không settle/release giả.

**Child lifecycle (P1-2/H7):** parent giữ registry child active/pending riêng với shared session cache.
`child.close()` lũy đẳng: các lần gọi concurrent dùng cùng close promise, ngừng nhận I/O mới, abort/drain
pending seed và tracked children, đợi quiescence rồi tự unregister khỏi registry parent. Gọi lại sau khi
đã đóng trả fulfilled; không ném lỗi “đã đóng”. Không unregister hoặc báo đóng xong khi child còn sống;
lỗi cleanup thật giữ evidence và trạng thái cần recovery, không giả quiescent.
`parent.closeAll()` chỉ đóng child active/pending, bỏ qua child đã quiesce/unregister; concurrent close với
runner phải an toàn, lũy đẳng và không throw vì child đã đóng. Lỗi quiescence thật vẫn phải được báo cáo,
không bị nuốt thành shutdown thành công. Giữ lifecycle shared hiện có, không trộn child vào cache shared.

**Resume policy đề xuất:** cùng execution dùng cached conversation. NEEDS_CONTEXT kết thúc execution và close;
lần có reply dùng operationId mới, conversation mới trong cùng attempt, giữ phase artifacts đã thành công.
Runner hiện bỏ scout theo saved state, trả NEEDS_CONTEXT và kiểm replies trước run
(`lib/dual/isolated-runner.js:158-192`). Không scout lại chỉ để tạo conversation mới.
Chỉ seed generation mới khi generation cũ đã terminal/quiescent; crash có pending seed/outcome_unknown phải
recovery/fence trước. Không mở journal cũ với IDs seed mới: relay kiểm registration khi mở journal
(`lib/dual/discussion/relay.js:220-232`). Continuity cross-process của cùng conversation không thuộc gói tối thiểu;
Muse đã chốt không hydrate conversation cross-process trong gói này.

## 3. Guard parity

Wrapper lạnh hiện kiểm guard/dependency receipt/runtime/replies/cwd trước processRunner và runtime/replies/guard
sau result (`lib/dual/isolated-runner.js:137-148`). Runtime kiểm path/type/depth/count
(`lib/dual/isolated-runner.js:17-29`); replies dùng absence hoặc exact bytes
(`lib/dual/isolated-runner.js:123-130`). Không guard nào được bỏ khi đổi transport.

**Mô hình bắt buộc gồm 3 chốt, dùng chung guard set của runner:**

1. **Seed Guard Wrapper tại runner:** bọc trực tiếp `seeds.codex`/`seeds.agy` bằng pre-check và
   post-check trong finally **trước khi** truyền vào `createDiscussionSession`. Seed chạy trước khi relay
   tồn tại (`lib/dual/discussion/session.js:61-81`), vì vậy không giao seed guard cho facade.
2. **Prespawn Guard Callback tại adapter:** inject `prespawnGuard` từ runner, await ngay trước **MỖI**
   spawn, gồm seed, resume turn, internal nudge và repair. Mỗi `call(nudge, remainingMs)` nội bộ cũng phải
   chạy lại callback, dù không quay qua relay.dispatch (`lib/dual/discussion/live-agy-invoke.js:357-379`).
   Guard thất bại/abort thì zero spawn tiếp, không chuyển thành schema retry. Resolver cũng pre-check
   trước resolve; probe dùng cùng prespawn policy để không tạo đường bypass.
3. **Relay Facade:** chỉ bọc boundary `receive`/`dispatch`/`reconcile`/`inspect`, giữ bindings/return shape;
   pre-check → await → post-check trong finally. Facade không tuyên bố bao phủ mọi I/O.
   Phase-bridge tiếp tục gọi facade, không import isolated runner
   (`lib/dual/discussion/phase-bridge.js:38-55`, `lib/dual/discussion/phase-bridge.js:159-171`).

Nếu operation lẫn post-check đều lỗi, giữ original error cùng guard diagnostic; mọi guard failure chặn
I/O tiếp. Prespawn check giữa hai process phát hiện tamper sau process đầu, trước nudge/repair kế tiếp.

| Guard | Chốt 1 — Seed Wrapper (pre/finally post) | Chốt 2 — Prespawn Callback (mỗi spawn) | Chốt 3 — Relay Facade (pre/finally post) |
|---|---|---|---|
| guard()/authorize | Exact lease/operation/lineage trước và sau từng seed | Recheck trước seed/turn/nudge/repair/probe; revoke thì không spawn | Recheck mọi boundary và trước nhận result/handoff |
| validateRuntime | Kiểm path/type/depth/count dù seed throw | Recheck trước mỗi process, kể cả nudge nội bộ | Finally check dù provider throw/unknown; violation fail-closed |
| validateReplies | Absence hoặc exact bytes của controller context trước/sau seed | Tamper giữa hai process chặn process kế tiếp | Không nhận result nếu model tạo/sửa context |
| cwd check | Immutable seed cwd=W; native realpath/binding check | Seed/resume/repair/probe cwd=W, realpath check và actual spawn audit | Root không redirect; metadata/prompt không chứng minh cwd |
| Dependency receipt | Verify trước/sau seed | Verify mỗi spawn/re-dispatch, onTick guard/signal | Recheck sau boundary và trước handoff; giữ cold implement check |
| env/spawn/signal | Truyền env scrub/ceiling, tracked spawn và signal | Dùng đúng execution hooks; abort trước spawn chặn I/O | Drain/kill, có exited evidence trước settle; unknown không retry thiếu proof |

### 3.1 Contract invoker/preflight hooks (P0-1)

Đây là **tái cấu trúc điểm spawn cốt lõi** của 4 module live-agy-invoke, live-codex-invoke,
daemon-ports, capability-preflight, không phải thêm vài optional hooks nhỏ. Chữ ký mở rộng giữ các
tham số/options hiện có và bổ sung thống nhất như sau (pseudocode):

```ts
type ExecutionHooks = { spawnImpl?: typeof spawn; env?: NodeJS.ProcessEnv; signal?: AbortSignal };
// Defaults chỉ cho shared: spawnImpl = spawn, env = process.env; signal tùy caller.
createAgyAdapter(options: ExistingAgyOptions & ExecutionHooks & { prespawnGuard? }): Adapter
createCodexAdapter(options: ExistingCodexOptions & ExecutionHooks & { prespawnGuard? }): Adapter
seedAgyConversation(options: ExistingAgySeedOptions & ExecutionHooks & { prespawnGuard? }): Promise<Seed>
seedCodexConversation(options: ExistingCodexSeedOptions & ExecutionHooks & { prespawnGuard? }): Promise<Seed>
runAgy(agyPath, args, options: ExistingAgyRunOptions & ExecutionHooks & { prespawnGuard? }): Promise<Raw>
runCodex(options: ExistingCodexOptions, args,
  runOptions: ExistingCodexRunOptions & ExecutionHooks & { prespawnGuard? }): Promise<Raw>
defaultCodexProbe(args, workspaceRoot, hooks: ExecutionHooks & { prespawnGuard? }): Promise<Probe>
runCapabilityPreflight(workspaceRoot,
  options: ExistingPreflightOptions & ExecutionHooks & { prespawnGuard? }): Promise<Capability>
```

`prespawnGuard(context)` trả void/Promise<void> hoặc throw; context nêu loại seed/turn/nudge/repair/probe,
immutable cwd và execution identity. Luôn await callback trước spawn, recheck signal sau callback.
Options normalization không được làm rơi hooks. Adapter factory capture hooks rồi chuyển xuống mọi call;
seed functions cũng chuyển xuống runAgy/runCodex. Với runCodex, execution hooks trong runOptions là nguồn
đã capture, không lấy override từ model/envelope. Mỗi low-level spawn dùng
`spawnImpl(command, args, { cwd: W, env, signal, shell: false, ...stdioOptions })`.
Isolated bắt buộc cấp đủ tracked spawnImpl, env đã scrub (gồm `GIT_CEILING_DIRECTORIES`), signal và guard;
thiếu thì fail-closed, không dùng defaults shared hay merge lại env daemon sau scrub.

`defaultCodexProbe` và mọi nhánh subprocess của `runCapabilityPreflight` (AGY version/models, Codex version)
phải chuyển `{ spawnImpl, env, signal, cwd: W }` vào `spawnBoundedProcess`. Đường bounded process phải thực
thi signal/abort, kill/drain và giữ exit evidence; không chỉ nhận rồi bỏ signal. Prespawn policy áp dụng cho
mỗi probe spawn. Không miễn cwd/env/process tracking vì đây là probe.

**Phân quyền tracking, tránh double-track:** authority cấp `spawnImpl` đã bọc đúng **một lần** bằng
`createTrackedSpawn` của `task-processes.js`, bind taskId/leaseId của execution; operationId được đối chiếu
qua closure authorize trước mỗi spawn, không giả định ledger process event đã có operationId.
Chỉ tracked spawn ghi daemon ledger `task.process.intent`, `task.process.started`, `task.process.exited`
cho mỗi subprocess (kể cả seed/nudge/probe). Adapter không bọc lại tracked spawn hoặc tự ghi các event này.
`trackInvocation` nội bộ vẫn quản lý active token/latest invocation, providerTerminal/providerOutcome và
recovery theo conversation; nó không ghi daemon process ledger. Hai lớp cùng quan sát một child, nhưng
không sinh hai process record. Guard deny trước spawn không sinh process intent; spawn throw/close do
tracked spawn ghi exit theo contract. Provider terminal không chứng minh process đã chết: chỉ settle/release
khi daemon có exit/quiescence evidence cho toàn bộ child, kể cả seed chưa có binding/conversation ID.

Relay đã kiểm authority trước dispatch, sau observation, và trong recovery
(`lib/dual/discussion/relay.js:415-425`, `lib/dual/discussion/relay.js:615-634`,
`lib/dual/discussion/relay.js:734-759`); không thay được runtime/replies guards.
Authorize hiện kiểm session/revision/baseline/task contract/readiness/lease và operation
(`lib/dual/isolated-authority.js:141-158`); child dùng closure đó, không thay bằng “có active lease bất kỳ”.
Revoke giữa hai seed phải ngăn seed còn lại, lưu IDs đã tạo và drain child.
Close là cleanup và vẫn phải chạy khi mất authority; không bỏ cleanup vì guard lỗi.
Guard failure không được đổi thành provider failed-retry/schema nudge. Wrapper implement giữ nguyên.

## 4. Authority và baseline identity

Hiện reader lookup registry bằng taskId và trả expectedSnapshotSha256 từ binding hash; registry pending
để expectation rỗng, slow seed không được ghi đè generation mới
(`lib/dual/discussion/host-resolver.js:25-32`, `lib/dual/discussion/host-resolver.js:50-71`).
Daemon ports replay ledger, so snapshot binding với expectation, không so trực tiếp daemon.currentBaseline.id
(`lib/dual/discussion/daemon-ports.js:31-53`). Nhưng capability verifier lấy cwd từ derived.workspaceRoot
của ledger (`lib/dual/discussion/daemon-ports.js:95-112`): sửa seed cwd riêng chưa đủ.

**Registry/reader đề xuất phải là một cặp của child host:**

- Shared registry[taskId] giữ nguyên; isolated registry nằm riêng, scope gồm session/task/W/attempt/binding hash/
  operation. Shared reader và isolated reader tách lookup, không dùng chung lookup chỉ theo taskId.
  Child reader đóng trên scope, kiểm cả binding refs/conversation IDs/execution reference.
- Missing/sai namespace/stale scope/pending seed/superseded generation đều deny, tuyệt đối không fallback shared.
  Một scope chỉ có một generation hợp lệ. Parent active-execution pointer theo session/task khiến attempt cũ
  mất quyền ngay khi authority chuyển attempt; cache cũ không hồi sinh authority.
- Slow seed chỉ publish khi generation còn current và authorize còn true. Nếu generation mới pending, expectation
  vẫn deny, không lấy D cũ. Failed seed xóa pending cache nhưng giữ diagnostics/partial IDs để cleanup/recovery.
- Reader đọc hash-chained daemon leaseEvents mới nhất; không rewrite workspaceRoot/currentBaseline trong events.
  Kiểm session/revision hiện hành với captured lineage, không thay planRevision trong closure.
  **Child reader KHÔNG dùng `checkAuthority` mặc định của daemon-ports** (chỉ tìm active lease bất kỳ).
  Bọc authority check bằng closure `authorize` từ `isolated-authority`: exact leaseId phải khớp lease đã cấp
  và `assertOperationAuthorized({ authorityStore, taskId, leaseId, operationId })` phải thành công trước I/O
  và trước nhận result. Lease mới cùng task không cứu được child đã stale/fenced
  (`lib/dual/discussion/daemon-ports.js:44-53`, `lib/dual/isolated-authority.js:141-155`).
- Expectation child bằng **D của child**, không B hoặc daemon baseline. B nằm trong snapshot text và được
  so với worker reference/contract; daemon baseline thuộc authorize lineage. Hai baseline không ghi đè nhau.

**Capability trusted context (P1-1/H4):** `createDaemonHostDeps({ ...existingOptions,
trustedExecutionContext?: { workerRoot, spawnImpl, env }, signal, prespawnGuard })` giữ shared context
optional; khi isolated, context và toàn bộ 3 fields là bắt buộc. Factory đối chiếu workerRoot/reference
với event `task.workspace.prepared` đúng session/task/attempt/binding trong daemon ledger, sau đó chuẩn hóa
cả root nhận vào và root từ ledger bằng `fs.realpathSync.native()` trước so khớp và cấp context.
Không tìm được prepared event đúng scope, root không tồn tại hoặc mismatch thì deny trước probe/seed.
`verifyCapability` chỉ dùng W đã xác thực trong context, chuyển cùng spawnImpl/env/signal/guard xuống
`defaultCodexProbe`/`runCapabilityPreflight` và `spawnBoundedProcess` (mục 3.1); env phải giữ
`GIT_CEILING_DIRECTORIES` và các biến Git đã scrub. Isolated không fallback `derived.workspaceRoot`
hoặc daemon root ở bất kỳ bước nào. Chỉ shared không có context dùng derived.workspaceRoot như trước.
Không nhận root/hook override từ envelope/model.
AGY model lấy từ verified worker capability/contract. Factory tạo reader/ports/seed/adapters/journal cùng context;
không ráp worker resolver với shared reader hoặc ngược lại, không dựng worker authority ledger thứ hai.

## 5. Kế hoạch test và phân tầng

Đây là kế hoạch, chưa sửa/chạy tests. FakeWorker hiện phát cả scout/implement/review theo prompt lạnh,
expect ba process calls và resume không tăng calls (`test/dual-isolated-runner.test.js:38-82`).
Di trú sang hai kênh, không dùng cold fallback để giữ assertion cũ:

1. Helper discussion stub dùng chung Gói 2b/2c: bindings hợp lệ, relay receive/inspect/dispatch/reconcile,
   messages, counters phase/task/execution; tạo scout/review từ spec của workerRoot đã bound.
   Có hooks trước/sau seed/turn, prespawnGuard cho nudge/repair, payload transform, recovery và close;
   không gọi provider thật. `test/helpers/dual-discussion-stub.js` do Gói 2b sở hữu bản execution-aware,
   Gói 2c tái dùng để xử lý nợ fixture, không nhân đôi helper.
2. Factory stub assert W/B/attempt/reference và cấp lifecycle handle. Shared tái dùng payload/session core;
   integration không hardcode daemon cwd/baseline/authorize=true. Stub không thay real authority coverage.
3. Fake processRunner chỉ implement, vẫn assert env/project flags; gọi cho scout/review phải fail.
   Happy path = hai discussion phases + một implement call. Resume handoff không tăng cả hai loại call.
   NEEDS_CONTEXT giữ scout một lần, review sau reply đúng worker baseline, context immutable.
4. Chuyển hook mutation/fencing từ processRunner sang đúng discussion phase, tránh vô tình đổi vị trí lỗi
   scout/review sang implement. Giữ case authority fencing/context tampering/correction/dependencies hiện có
   (`test/dual-isolated-runner.test.js:351-375`, `test/dual-isolated-runner.test.js:632-737`,
   `test/dual-isolated-runner.test.js:908-930`).

| Tầng | Case giữ/thêm | Assertion quan trọng |
|---|---|---|
| Isolated boundary | Missing/disabled discussion, enabled thiếu factory, wrong W/task/B/reference, unsafe flags, symlink runtime/journal | Zero seed/turn/cold scout-review khi precheck fail; factory-required trước phase.started, không phase.failed; identity-invalid terminal security error; source nguyên vẹn |
| Guard parity | Revoke trước/giữa seed, dispatch, sau result, nudge/reconcile; runtime/reply/dependency tamper sau call đầu trước internal nudge/repair | Prespawn guard bắt nudge nội bộ: không spawn lần hai dù không qua relay; không nhận result/handoff; cleanup vẫn chạy |
| Authority integration | Exact lease/operation, expired/fenced lease, unresolved tracked child, failed close | Không settle/release giả, không integrate/verify; evidence giữ nguyên |
| Resolver/ports | Shared/isolated cùng taskId; hai W; khác attempt/operation; slow seed; revision đổi; probe env/cwd và prepared event mismatch | Reader lookup tách scope; child revision khóa; native realpath cả shared (kể cả symlink alias); probe actual spawn cwd=W, env scrub có ceiling; mismatch zero spawn, không fallback |
| Lifecycle | Concurrent resolve/close, NEEDS_CONTEXT/resume, pending/partial seed, unknown restart; child tự unregister rồi parent.closeAll() | Không double-seed/reseed thiếu quiescence; registry hết child đã đóng; close/closeAll lũy đẳng, bỏ qua quiesced child, không throw vì đã đóng; giữ evidence |
| Result/QC | Hash/baseline correlation, command outputs, scope/source conflict, correction/dependencies | Giữ semantics hiện có; validator độc lập, chỉ QC tích hợp source |

**Đã thuộc orchestrator, không nhân bản toàn bộ:** error semantics thiếu discussion/resolver/bindings,
schema nudge bounds, raw artifact recovery, review diff, unknown không cold retry. Coverage hiện ở
`test/dual-discussion-orchestrator.test.js:117-153`, `test/dual-discussion-orchestrator.test.js:215-279`,
`test/dual-discussion-orchestrator.test.js:387-408`, `test/dual-discussion-orchestrator.test.js:469-527`.
Isolated vẫn cần wiring assertions và guard-at-nudge/recovery vì đó là boundary riêng.
Có ít nhất một end-to-end offline dùng real host/ports + daemon ledger thật + fake provider adapters:
stub relay không chứng minh authority. Source isolation phải đo bytes/diff thực tế, không chỉ nhìn cwd metadata.

**Cổng dự kiến:** focused isolated + host-resolver + host-wiring + discussion orchestrator/bridge;
ports/live-invoker suites cho spawn/env/probe changes; toàn bộ discussion và integration callers isolated
(tìm bằng rg khi triển khai), rồi full quality gate cuối gói. Nợ 33 fail dual-daemon-orchestrator thuộc Gói 2c,
không mở rộng sửa cả suite ở đây (`docs/dual/discussion-transport/f01-program-status.md:160-164`).
Live isolated acceptance sau offline gate và Muse duyệt bắt buộc **process audit thật** cho seed/resume,
internal nudge/repair và probe: actual cwd bằng workerRoot, env Git đã scrub có `GIT_CEILING_DIRECTORIES`,
intent/started/exited tương ứng và **no-orphan** sau completion/abort/close. Metadata cwd trong JSON hoặc
prompt không đủ; không lấy benchmark OLD-vs-NEW làm chứng nhận cô lập.

## 6. Rủi ro, phương án lùi và điều kiện dừng

| Rủi ro | Chặn/phát hiện | Nếu không chứng minh được |
|---|---|---|
| Seed đúng W nhưng resume/probe về daemon cwd | Adapters riêng, immutable root, spawn audit cả provider/probes | BLOCKED trước live, không dùng shared adapters mặc định |
| State/conversation rò giữa attempts | Namespace/manifest/execution binding/exact authority/active pointer | Deny generation cũ, giữ journal, không xóa/reseed lén |
| Crash/unknown còn process sống | Tracked children, recovery đúng adapter instance, quiescence trước generation mới | Không settle completed/release; controller recovery |
| TOCTOU runtime/context/dependencies | Pre/post brackets, safe path/exact bytes/hash, check trước handoff | Không nhận result hoặc QC/integrate |
| Guard bypass qua repair/probe | Bracket seed/adapter, spawn hooks, fault injection | Dừng nếu còn I/O không qua execution policy |
| Hồi quy shared/trộn authority | Legacy branch không đổi, real daemon ledger, regression tests | Không rollout isolated trước khi shared gate đạt |

**Phương án lùi:** giữ isolated fail-closed như sau Gói 1, ngừng cấp isolated capability mới ở wiring;
shared discussion và cold implement không đổi. Không bật lại cold scout/review, không đổi env off thành fallback.
Có execution in-flight thì ngừng nhận isolated mới, drain/reconcile và fence operation trước rollback.
Giữ manifests/journals/artifacts phục vụ recovery; không xóa directory để ép retry.

**Điều kiện dừng bắt buộc:** seed/turn/probe ở daemon workspace; cross-scope baseline/binding được accept;
không kiểm được exact lease/operation; child còn sống mà operation settled; unknown reseed thiếu proof;
guard fail vẫn có I/O tiếp; không giữ được shared tests hiện có. Đây là BLOCKED cần AGY/Muse xử lý,
không chữa bằng bypass guard hoặc fallback lạnh.

## 7. Phạm vi file dự kiến sửa

Chỉ liệt kê cho implementation sau duyệt; **không sửa các file này trong lượt thiết kế**.

| File | Thay đổi dự kiến |
|---|---|
| `lib/dual/discussion/host-resolver.js` | Child factory, registry/cache/identity/stateDir/lifecycle riêng, giữ shared branch |
| `lib/dual/daemon-server.js` | Factory cấp adapters/probes/context riêng, forwarding capability và shutdown |
| `bin/omni-daemon.js` | Chuyển capability từ cùng helper, giữ executable lifecycle/agyProjectId |
| `lib/dual/isolated-authority.js` | Bind exact lease/operation/authorize, forward factory/spawnImpl/env/signal, cleanup accounting |
| `lib/dual/isolated-runner.js` | Child sau prepare, Seed Guard Wrapper trước createDiscussionSession, prespawn callback + relay facade, inject discussion, finally close |
| `lib/dual/discussion/daemon-ports.js` | Tái cấu trúc điểm spawn probe: trustedExecutionContext đã kiểm ledger/native realpath, spawnImpl/env/signal, child authority closure exact |
| `lib/dual/discussion/live-agy-invoke.js`, `lib/dual/discussion/live-codex-invoke.js` | Tái cấu trúc điểm spawn cốt lõi theo mục 3.1: factories/seeds/run nhận và chuyển spawnImpl/env/signal, prespawnGuard mọi spawn kể cả internal nudge/repair, tách daemon tracking và trackInvocation; giữ shared defaults |
| `lib/dual/capability-preflight.js` | Tái cấu trúc toàn bộ đường spawn probe: runCapabilityPreflight chuyển spawnImpl/env/signal/cwd vào spawnBoundedProcess, thực thi abort/drain + prespawn policy |
| `test/dual-isolated-runner.test.js` | Di trú fixture và thêm boundary/guard/lifecycle cases, giữ QC semantics |
| `test/dual-discussion-host-resolver.test.js`, `test/dual-daemon-host-wiring.test.js` | Giữ tests cũ, thêm child identity/factory/shutdown |
| `test/dual-discussion-orchestrator.test.js`, `test/dual-discussion-phase-bridge.test.js` | Regression seam/facade contract khi cần |
| Các suite ports/live invokers và caller isolated trong `test/` | Probe/spawn/env parity, di trú caller chạy scout/review |
| `test/helpers/dual-discussion-stub.js` (mới, đề xuất) | Shared helper payload/session/counters/fault hooks, phối hợp Gói 2c |

Không dự kiến sửa builder, public binding schema, orchestrator production hoặc phase-bridge production:
execution field/resolver context đã đủ, facade nằm ở isolated boundary. Nếu thực thi chứng minh cần thay
các contract này, quay lại review phạm vi. Không sửa harness OLD, program-status, requirements/todo/KI
hoặc tài liệu khác trong lượt này.

## 8. Năm câu hỏi — ĐÃ CHỐT bởi Muse

Các quyết định dưới đây đã được Muse chốt trong mục Gói 2b của program-status; bản sửa thiết kế này
vẫn chờ Muse duyệt triển khai, chưa cho phép viết code.

1. **ĐÃ CHỐT — Phương án A:** dùng daemon lease/operation và child host; bắt buộc tái cấu trúc hooks
   spawnImpl/env/signal tại 4 module live-agy-invoke, live-codex-invoke, daemon-ports, capability-preflight
   theo mục 3.1, kèm guard 3 chốt. Thiếu hooks thì isolated giữ BLOCKED.
2. **ĐÃ CHỐT — Generation theo operationId:** NEEDS_CONTEXT close execution; resume giữ phase artifacts
   nhưng tạo conversation mới theo operationId mới trong cùng attempt. Không hydrate conversation
   cross-process trong gói này; generation cũ phải quiescent/recovered trước generation mới.
3. **ĐÃ CHỐT — StateDir/retention:** `.omni/runs/dual-discussion/isolated/<executionKey>` do daemon sở hữu,
   worker không can thiệp/symlink vào; giữ evidence. Retention/GC/log rotation ghi nợ kỹ thuật sau Phase 3,
   không tự GC trong gói này.
4. **ĐÃ CHỐT — Error semantics:** `DUAL_ISOLATED_DISCUSSION_FACTORY_REQUIRED` là **precondition error**
   khi enabled nhưng thiếu factory, ném trước `orchestrator.runPhase`/`phase.started`, không ghi
   `phase.failed`, đúng D1 và cho phép retry khi wiring sẵn sàng. `DUAL_ISOLATED_DISCUSSION_IDENTITY_INVALID`
   là **terminal security error** khi baseline/contract/workerRoot không khớp authority reference: ghi nhận
   vi phạm và dừng ngay, không retry/fallback lạnh. Giữ `DUAL_DISCUSSION_REQUIRED` đúng D1 và ngữ nghĩa mã cũ.
5. **ĐÃ CHỐT — Helper/live acceptance:** Gói 2b sở hữu `test/helpers/dual-discussion-stub.js` bản
   execution-aware, Gói 2c tái dùng. Live acceptance phải có process audit thật chứng minh cwd workerRoot,
   env Git đã scrub/ceiling và no-orphan sau hoàn thành; metadata JSON đơn thuần không đủ.
