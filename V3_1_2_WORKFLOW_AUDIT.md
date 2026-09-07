# v3.1.2 — Audit workflow Codex ↔ Antigravity/Gemini

Ngày: 2026-09-05. Trạng thái: audit baseline; triển khai đang bắt đầu theo V3_1_2_IMPLEMENTATION_PLAN.md.
Lưu tại root vì `docs/` hiện bị gitignore; báo cáo này cần nhìn thấy trong diff của nhánh mới.

## Baseline và phạm vi

- Nhánh làm việc: `codex/v3.1.2`, tạo từ `v3.x` tại `a46dff2e78307a0ad750a33154f9b3baceeb37ea`.
- Package baseline: 3.1.1; checkout sạch trước khi tạo báo cáo. Chưa đổi package version, commit, push, tag hay publish.
- Mục tiêu: người dùng chỉ thao tác trên Codex CLI; Codex điều phối worker AGY/Gemini, giữ context và quyền sửa file rõ ràng, có đường phục hồi khi phối hợp gặp lỗi.
- “Cùng phiên CLI” là cùng phiên điều phối người dùng; worker có thể là process/workspace riêng. Không giả định các model dùng chung conversation context.
- Đã kiểm tra read-only `agy --version` và `agy models` trên máy: AGY 1.1.27 liệt kê `gemini-3.8-flash-high` (cùng medium/low). Đây là model discovery, chưa phải inference/auth/quota qualification; không đổi global model config.
- Không sửa dữ liệu trong E:/brain hoặc tái sử dụng ledger dự án khác để thử nghiệm.

## Findings đã đối chiếu source hiện tại

### F1 — Bootstrap và các lệnh tiếp tục không cùng đường điều phối

`lib/commands/dual.js:647` bootstrap vào authority; `:318` status đọc authority, nhưng `:292`, `:305`, `:353` run/resume/phase đi legacy orchestrator. `:122` còn hướng dẫn authority task chạy phase/run legacy.

Hậu quả: thấy task ở status nhưng lệnh tiếp theo không tìm thấy transaction tương ứng. Cần session-aware dispatch và regression bootstrap → status → run/resume/QC; không tạo transaction thứ hai để che lỗi.

### F2 — Context và lệnh kiểm chứng mất qua các lớp

`lib/dual/contracts.js:88` khai báo `context_files`, nhưng event plan.registered (`:433`) và daemon task projection (`lib/dual/daemon-server.js:1050`) không mang trường này. Reducer (`lib/dual/authority-store.js:311`) bỏ rich task metadata, gồm validation commands. Resume có enrichment riêng (`lib/dual/daemon-server.js:1144`), còn QC CLI fallback sang npm test (`lib/commands/dual.js:1580`).

`lib/dual/orchestrator.js:389` tạo request chỉ có task ID/baseline; implement input (`:1239`) chỉ inline goal/allowed files. Không nên trông chờ worker tự tìm đủ spec, constraints và commands.

Cần một task contract bền vững xuyên register → derive → dispatch → restart → QC; context packet gồm mục tiêu, constraints, read/write scope, sources, dependency outputs, exact checks, baseline/revision/hash và quyền hạn. Context input không được tự nâng quyền bằng nội dung văn bản.

### F3 — Lease task-ID chưa giải quyết ownership theo file

`lib/dual/authority-store.js:823` chặn lease trùng task ID, không kiểm tra file overlap giữa các task khác nhau. Global clean-baseline guard (`lib/dual/orchestrator.js:380`, `:1202`) có thể chặn cả thay đổi hợp lệ từ task khác.

`lib/dual/contracts.js:123` cố ý giới hạn một AGY task mỗi immutable-baseline session. Đây là giới hạn kiến trúc đang có test, không phải chỉ một if cần xóa.

Sửa tối thiểu: queue mọi writer trong shared workspace và kiểm tra canonical file ownership. Muốn nhiều worker tiến triển độc lập cần task workspace/baseline riêng và integration coordinator. Worktree là isolation khỏi sửa nhầm, không phải security sandbox chống process cố tình truy cập ngoài scope.

### F4 — Recovery implement bị clean-start guard chặn

`lib/dual/orchestrator.js:1202` assert clean baseline trước `tryRecoverPhase` tại `:1204`. Crash sau khi worker sửa source và đã ghi output nhưng chưa ghi completion event có thể không resume được vì chính diff hợp lệ của attempt.

Cần phân biệt fresh start với recovery: xác minh attempt identity, process termination, artifact hashes, measured diff và scope trước khi phục hồi đúng một lần. Không đơn thuần chuyển guard xuống hoặc chạy model lại trên partial changes.

### F5 — Async failure thiếu trạng thái quan sát được

`lib/dual/daemon-server.js:1165` gọi adapter rồi catch rỗng. Adapter có thể throw trước khi có lease (`lib/dual/orchestrator-adapter.js:174`) hoặc release lease rồi throw (`:500`).

Cần durable execution outcome với reason code, retryability, next action và attempt budget. Status phải phân biệt đang chạy, đang chờ, cần bổ sung context, cần sửa, và lỗi an toàn; không để EXECUTING/ROUTED che một worker đã dừng.

### F6 — Instruction contract không đồng nhất giữa entrypoints

`lib/init/strategies.js:783` chỉ thêm Dual Auto Router vào om-think. Base cook chọn unchecked todo (`templates/workflows/coder-execution.md:5`) và kiểm tra authority tồn tại (`:15`) nhưng thiếu bước owner/lease-aware trước code/QC. Đây là khoảng trống hướng dẫn; chưa chứng minh bypass runtime hook.

Dual mode dùng base workflows, standalone Codex dùng overlay (`lib/init/strategies.js:655`). Vì vậy không gán nhầm lỗi overlay cho Dual: riêng Codex overlay vẫn bảo ad-hoc install (`templates/overlays/codex/workflows/coder-execution.md:22`) và commit/stash (`:42`). `templates/integrations/dual.md` lại chứa Claude Code integration.

Cần shared controller contract ở tất cả think/plan/cook/check/fix/pass entrypoints và test trên generated project theo từng pairing, không chỉ scan base template.

### F7 — Correction loop chưa có operation tương ứng

`templates/workflows/acceptance.md:22` thêm task vào todo rồi quay lại cook. Nhưng đăng ký plan chỉ được ở CAPABILITY_SAFE (`lib/dual/daemon-server.js:970`), và bootstrap plan mới không chấp nhận session đã có execution evidence (`lib/commands/dual.js:637`).

Cần correction task/plan revision có parent evidence, baseline, scope và retry budget; không sửa graph đang chạy hoặc reset ledger. Chỉ cập nhật prose sẽ chưa giải quyết đường thực thi này.

### F8 — Integrity Git/snapshot khác nhau; context local đang lệch branch

Git scope bỏ toàn bộ .omni (`lib/dual/scope-guard.js:54`, `lib/dual/workspace.js:141`), trong khi snapshot chỉ bỏ runtime prefixes (`lib/dual/snapshot-policy.js:73`). Cần chung exclusion policy: runtime được tách, planning/policy/context vẫn được bảo vệ.

`.omni/sdlc/todo.md` local hiện là v4 Milestone 6 dù package checkout là 3.1.1. Không ghi đè tài liệu này trong audit. Cần binding project/branch/session/revision cho context được chọn. Package-lock root vẫn 3.1.0; đây là lệch metadata, chưa phải bằng chứng npm ci sẽ fail.

## Ba hướng và đề xuất

1. **Compatibility repair trong shared workspace:** thống nhất dispatch/context, queue writers, sửa recovery/observability/templates. Ít thay đổi, phù hợp maintenance patch; vẫn giới hạn concurrency và phải serialize source writes.
2. **Controller thống nhất + isolated workers (đề xuất):** làm bước 1 trước, sau đó thêm execution mode được chọn rõ ràng: worker sửa workspace riêng, Codex là integrator duy nhất. Cùng một Codex CLI session, nhiều task/worker có thể tiến triển mà không sửa chung working tree. Chi phí: lifecycle workspace, snapshot/diff transfer, dependency setup và integration tests.
3. **Viết lại orchestration kernel đa provider:** linh hoạt nhất nhưng phạm vi lớn, migration/rủi ro cao; không phù hợp một bản tối ưu v3 maintenance.

Tên nhánh v3.1.2 không tự quyết định semantic version phát hành. Bug fixes tương thích có thể là patch; API/mode mới hoặc thay đổi contract cần đánh giá version trước release.

## Hướng triển khai 2 — theo quyền code trực tiếp của AGENTS.md

Đính chính quy trình: AGENTS.md nói rõ brainstorm không bắt buộc và người dùng đã yêu cầu tối ưu workflow. Không có lời duyệt thiết kế riêng; assistant tiếp tục triển khai từ phạm vi đã giao thay vì giữ một approval gate do chính assistant đặt thêm. Các giới hạn commit/push và live-cost vẫn nguyên vẹn.

- Codex/controller là sole writer của authority ledger và sole integrator vào workspace chính. Worker không tự commit/push/deploy hoặc tự chứng nhận hoàn thành.
- Mỗi task có input packet immutable và namespace session/task/attempt; context replies tạo revision mới ở safe boundary, không ghi đè packet đang dùng.
- Message events có ID/correlation/ack và replay idempotent: progress, question, context reply, scope request, result, correction. Không cần chia sẻ raw reasoning.
- Worker thiếu thông tin gửi NEEDS_CONTEXT để Codex trả lời từ repo/decisions. Chỉ hỏi người dùng khi thiếu quyết định hoặc quyền mà controller không có.
- Scope overlap được scheduler xếp hàng trước dispatch. Shared-workspace compatibility dùng single writer. Isolated mode dùng private checkout/snapshot không yêu cầu commit thay người dùng.
- Worker trả diff + evidence; controller kiểm tra base/content hashes, path containment, scope, tests rồi mới integrate. Nếu base đã đổi, giữ cả hai bản, thử lại từ baseline mới theo policy; không last-writer-wins.
- Resource wait, context wait, repair và safety block là các tình huống khác nhau. Retry có giới hạn, không duplicate model run khi chưa biết process cũ kết thúc; integrity/authority violation vẫn dừng an toàn.
- Resume phục hồi từ ledger, inbox và checkpoint; không phụ thuộc hội thoại còn nguyên hoặc một agent tự nói đã xong.
- Tái sử dụng v3 authority/runner/evidence đang có; không kéo v4 runtime vào nhánh này ngầm định.

## Gates cần đạt khi triển khai

- Bootstrap → run/resume → worker → handoff → Codex QC trên cùng authority lineage.
- Registered metadata và context byte/hash giữ nguyên qua daemon restart.
- Hai task trùng file không được concurrent write; thay đổi của người dùng không bị overwrite/stash/reset.
- Crash trước/sau worker result, trước/sau integration và lease expiry: không double apply, không mất diff, không fake completion.
- Context request/reply, correction sau failed QC, dependency waits có đường resume và budget hữu hạn.
- Git/snapshot đều phát hiện planning/policy mutation; Windows junction/path escape bị từ chối.
- Generated workflow matrix bảo toàn safety/ownership ở mọi entrypoint.
- Focused tests → full Dual → full repository → clean install/tarball smoke, báo riêng từng gate.
- Live Codex–AGY với exact model alias/account/cost scope đã xác nhận là gate riêng; simulated worker PASS không thay thế live qualification.

## Bằng chứng kiểm thử của audit

- Focused baseline: `node --test --test-concurrency=1 test/dual-contracts.test.js test/dual-custom-model.test.js test/dual-flow-friction.test.js test/workflow-command-contracts.test.js` → **76 pass, 0 fail, 0 skipped**, exit 0.
- Full Dual baseline: `npm run test:dual` → **573 pass, 0 fail, 2 skipped**, 575 tests, exit 0, khoảng 366 giây. Đây là existing automated suite với fake/injected workers, không phải live Gemini qualification.
- Chưa chạy npm ci, full npm test, tarball smoke hoặc live model trong audit này.

### Probe xác nhận ở lượt tiếp tục — 2026-09-05

Probe Node chạy trực tiếp trong memory, dùng API thật `replayAuthorityEvents`, `computeEventHash`, `EnvelopeSchema`, `buildWorkflows` và `readWorkflow`; không tạo ledger trên disk hoặc gọi model. Fixture gồm ba event đúng schema và hash-chain: session.created → capability.result → plan.registered.

- Event đăng ký chứa một validation command hợp lệ; derived task mất `validation_commands` (`undefined`). Đã tái hiện F2 bằng thực thi reducer, không chỉ đọc source.
- Bổ sung `context_files` vào registered task khiến EnvelopeSchema từ chối. Context propagation cần cập nhật cả schema, event projection và reducer, không thể chỉ thêm prompt text.
- Materialize workflow trong memory xác nhận standalone Codex còn `commit or stash first`, trong khi Dual/base cấm auto commit/stash/reset. Đã giữ đúng phân biệt mode ở F6.
- Các assertion xác nhận triệu chứng trên đều đạt, probe exit 0; đây là bằng chứng lỗi còn tồn tại, không phải regression PASS sau sửa.
- Worktree vẫn chỉ có báo cáo này; không có source implementation. Lượt trước là progress (nhánh, audit, baseline tests); lượt này bổ sung reproducer evidence. Chưa có xác nhận hướng isolated workers, nên chưa chuyển đề xuất thành approved spec hay triển khai kiến trúc đó.

## Tài liệu tham khảo đã đọc

- `E:/brain/02 - Knowledge/concepts/harness-engineering.md`: instruction, tools, environment, state, feedback.
- `E:/brain/02 - Knowledge/concepts/task-lifecycle-harness.md`: readiness, WIP=1, verification độc lập, handoff.
- `E:/brain/02 - Knowledge/sources/Learn Harness Engineering.md`: nguồn tri thức của hai concept trên; audit dùng bản trong vault, không tuyên bố đã xác minh toàn bộ website gốc.
- `docs/superpowers/specs/2026-08-25-dual-quality-first-communication-design.md`: thiết kế cũ approved, giữ nguyên authority/QC boundaries; đề xuất mới bổ sung context, coordination và isolation, không coi là đã được duyệt.

## Tiến độ

- [x] Kiểm tra checkout và tạo nhánh.
- [x] Audit source/workflow; đọc Brain; cross-check hai reviewer read-only.
- [x] Chạy focused baseline.
- [x] Chạy full Dual baseline; 2 platform-conditional skips, không tuyên bố tất cả platform đã được kiểm chứng.
- [ ] Chốt hướng kiến trúc với người dùng.
- [ ] Viết approved spec và implementation plan.
- [ ] Triển khai với regression tests và independent verification.
- [ ] Qualification; không commit/push/release nếu chưa được yêu cầu.

## Implementation checkpoint — metadata và worker briefing

Các findings phía trên là baseline v3.1.1, không tự động chuyển thành closed chỉ vì đã bắt đầu sửa.

- F2: đã nối optional context_files vào registered event/spec; reducer giữ rich task metadata. Ba regression replay/reopen/status red→green; bộ authority/contracts/MCP 99 pass, 0 fail.
- Worker scout/implement/review nhận full registered spec và đường dẫn semantic artifacts. Hai integration tests với fake process red→green và vẫn đi đến Codex QC. Chưa có immutable source-content snapshot/message inbox.
- Kiểm tra context nguồn trước dispatch: thiếu file, directory và junction escape; kiểm tra task/baseline correlation trước scout; recheck context mỗi retry, không cho spec biến mất hoặc đổi contract giữa phase. Bốn focused regression red→green.
- Fresh-context reviewer read-only đã phát hiện hai lỗi pre-scout correlation và spec-less retry downgrade; đã tái hiện và sửa bằng tests. Không coi review này là cross-model Gemini qualification.
- Syntax check 5 production JS files pass. Package không có lint/typecheck/build scripts; không tạo PASS giả cho các gate không tồn tại.
- `npm audit --audit-level=high` exit 0, nhưng có 1 moderate vulnerability ở transitive qs. Chưa auto audit-fix hoặc đổi dependency.
- Một broad test run trước đó đã gặp regression correlation vừa thêm trong lúc source còn thay đổi; không dùng run đó làm gate PASS. Full Dual checkpoint sau sửa đã kết thúc exit 0: **580 pass, 0 fail, 2 skipped**, 582 tests, 53 suites, khoảng 325 giây. TAP: `.omni/runs/v312-context-checkpoint-1.tap`. Lệnh: `node --test --test-concurrency=1 --test-reporter=dot --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination=.omni/runs/v312-context-checkpoint-1.tap test/dual-*.test.js`.
- Chưa hoàn thành mục tiêu: authority-aware run/resume, workspace isolation/integration, durable message/reply và correction recovery vẫn cần triển khai theo plan. Không commit/push/release.

## Implementation checkpoint — authority CLI routing

- `lib/commands/dual.js` now detects an authority task before `run`/`resume`; it calls the existing daemon lineage, prints durable state and never creates `.omni/codex-gemini/runs/<task>` for authority-only tasks. `phase` refuses direct legacy execution when an authority task exists.
- `lib/dual/daemon-server.js` validates optional `task_id` and `plan_revision` on `session.resume`, and filters the dispatched task set to the requested task. Unknown task/stale revision are rejected without dispatch.
- Fresh CLI integration suite: `node --test --test-concurrency=1 test/dual-authority-cli-routing.test.js test/dual-flow-friction.test.js test/dual-cli.test.js test/dual-daemon-cli.test.js` → **35 pass, 0 fail**, exit 0.
- This closes the duplicate legacy routing defect, not workspace isolation or durable message exchange. A worker task can still mutate the shared workspace; Slice 4 remains required.

## Implementation checkpoint — private snapshot runner

- Added `task-workspace.js`, `task-integration.js` and `isolated-runner.js`. The runner uses the existing orchestrator in a private snapshot, retains source bytes, and hands off semantic artifact hashes plus the scoped binary-safe result. Separate controller integration keeps original bytes in a validated journal.
- Completed private runs resume without repeating worker phases. Prepared input pins task/model and snapshot hashes. Artifact task/baseline mismatches, missing validation output, rewritten evidence+event log, changed model and runtime junction redirection are rejected.
- Fresh focused `node --test test/dual-isolated-runner.test.js` after fixes: 10 pass, 0 fail. Tests use fake model responses; the integration scenario additionally executes an actual Node syntax validator before applying the result in a temporary fixture.
- The last full-suite saved log at `.omni/runs/v312-final-npm-test.log` ends with 1641 pass, 0 fail, 2 skipped, 1643 total. It predates this runner and must not be presented as full verification of current runner code.
- Still open: ledger persistence of prepared/handoff references, daemon adapter selection, per-task QC/integration receipts, multi-task checkpoints, context questions/replies, correction cycles and live Gemini qualification. Default CLI worker execution remains the existing shared-workspace path until these are connected and tested.
- Git ancestor prevention follows [official Git environment documentation](https://git-scm.com/docs/git#Documentation/git.txt-codeGITCEILINGDIRECTORIEScode): a ceiling does not exclude the current directory or override explicit GIT_DIR. The private runner sets the parent attempt directory as ceiling, clears inherited repository overrides, and is tested with actual Git on Windows. This prevents accidental parent discovery, not intentional commands targeting another repository.

## Implementation checkpoint — isolated authority wiring

- Added lease-checked `task.workspace.prepared` and `task.workspace.handoff` ledger events. Reducer retains anchored binding and handoff references without marking the task verified.
- Added `isolated-authority.js` and adapter routing for explicit `execution_mode: isolated`. Typed plan/daemon/MCP preserve the selection; unspecified tasks keep shared execution for compatibility.
- Completed handoff resumes from reopened authority without model calls. It revalidates artifact/result hashes, canonical source root, revision, scope, goal, commands and routed/capability model. Worker boundaries check current baseline/task/lease before proceeding.
- Red→green evidence: registered mode survives bootstrap; private adapter persists references and releases lease; foreign root, tampered handoff, stale revision and same-revision model drift reject. Latest focused gate: 71 pass, 0 fail; no live model.
- Remaining before declaring isolated workflow usable end-to-end: daemon/CLI QC of private handoff, controller integration and task completion receipt; durable failure outcomes; correction/message protocol; multi-task scheduling/checkpoints; generated workflow defaults; fresh full-suite/package/live qualification.

## Implementation checkpoint — isolated Codex QC (2026-09-06)

- Added `isolated-qc.js`: independently resolves and runs exact registered commands (shell:false, bounded runtime/output), checks current authority and unchanged private handoff, integrates anchored result, records a QC gate with integration receipt digest, then appends Codex-verified task completion.
- Added authenticated/session-correlated `task.qc` RPC and client method. `omni dual qc` routes explicit isolated tasks to it. Existing MCP completion tool accepts a separate optional `isolated_qc` request; no extra tool or synthetic session VERIFIED result.
- Validation failure returns NEEDS_FIX without source integration. Initial source/context conflict returns CONFLICT without integration. Interruptions after some file writes retain a recovery journal; this is not a cross-filesystem atomic transaction, and callers must not describe it as one.
- Verified replay checks handoff, receipt hash and integrated source after-state. User revert returns CONFLICT; corrupted receipt is not accepted as completion. Isolated task.completed requires matching handoff and QC/integration gate in reducer.
- Fresh gate: `node --test --test-concurrency=1 test/dual-daemon-client.test.js test/dual-isolated-runner.test.js test/dual-mcp-server.test.js test/dual-authority-store.test.js` → 99 pass, 0 fail, exit 0. Syntax and diff whitespace checks pass. This is not a fresh full repository or live Gemini qualification.
- Still open: multiple isolated workers/dependencies/checkpoints, durable question/reply/correction/failure lifecycle, supported dependency preparation and generated workflow adoption, clean-install/tarball and live qualification. Shared remains compatibility default; no commit/push.

## Implementation checkpoint — task scheduling (2026-09-06)

- Added pure task graph ordering/readiness (`task-scheduler.js`), optional typed `depends_on`, registration/replay graph validation and CLI dependency/scope wait display.
- Multiple AGY tasks are accepted only for an all-isolated worker graph. Shared tasks cannot declare dependencies that the shared executor would ignore. Isolated slices must remain eligible low-risk AGY-owned tasks; Codex controller work must not be registered as an impossible isolated worker task.
- Private dispatch and QC check readiness. Dependency handoff alone is insufficient: predecessor must be TASK_VERIFIED after integration. Write/read-context overlap is serialized deterministically in dependency order, with portable case and path-prefix comparison.
- Tests prove (1) dependent workspace is absent while predecessor awaits QC, (2) its eventual snapshot contains integrated predecessor bytes, (3) two independent tasks each integrate only their own changed file. No parallel-throughput claim: adapter still dispatches serially.
- Verification: 68 focused tests passed; latest post-review scheduler/bootstrap/CLI/private-runner set passed 39/39. Source syntax and whitespace checks pass. Missing live concurrent qualification and dependency output-drift audit remain explicit.

## Implementation checkpoint — controller questions/replies (2026-09-06)

- Added `task.questions` batch and `task.message` reply events, `task-messages.js` acknowledgments/idempotency and active-lease/released-worker guards. Question text is data; replies cannot modify file scope or task ownership.
- Isolated scout open_questions now stops before implementation, records the entire question batch atomically, releases lease and returns NEEDS_CONTEXT. Replies are persisted through task.reply RPC and MCP resume.context_reply; MCP status exposes pending questions. Resume uses the same workspace/scout, writes immutable controller clarification, and includes it in subsequent phase inputs and handoff hashes.
- Security/recovery tests: no scope changes through reply, invalid/blank reply never consumes question, ID reuse cannot replace content, question batch cannot be partially ingested, worker-created controller clarification rejected even without a question, controller bytes rechecked before/after process boundaries.
- Latest focused gate: 95/95 tests pass, exit 0. Independent reviewer findings were reproduced and fixed. This is not full-package/live qualification.
- Remaining: implementation-time questions, progress/events, explicit correction lifecycle after failed QC, stale process/lease recovery, supported dependency setup, generated workflow defaults, live Codex/Gemini and full release gates. Goal remains active.

## Implementation checkpoint — correction and session receipt (2026-09-06)

- `task.execution.outcome` makes worker failure / QC NEEDS_FIX / source CONFLICT durable. MCP status exposes bounded outcome summaries; ordinary resume returns the recorded outcome rather than blindly repeating the model call.
- `task.correction.requested` binds a fresh attempt to prior workspace hash, request ID and correction reason. Maximum three attempts; prior workspaces/ledger evidence remain intact. Same scope and plan revision; controller feedback is pinned into the next worker spec.
- Added session-correlated task.correct RPC and optional MCP resume.correction. Request history replay stays idempotent after later corrections; active lease, exhausted budget and partial integration journal prevent new attempt creation.
- Red→green tests: failing independent value check → correction → second private attempt → passing independent check → integration; bounded retries, preserved originals, historical request replay. Review found historical-idempotency bug and it was reproduced/fixed.
- Isolated QC now records validated delegation, scope and review gates from the anchored private evidence. A dedicated real temporary daemon fixture accepts three independently executed syntax quality cycles and produces the existing session VERIFIED receipt; this does not replace product/live quality checks.
- Full repo test runner completed: 1681 pass, 0 fail, 2 skipped; 1683 tests, 223 suites, exit 0, about 386 seconds. TAP is `.omni/runs/v312-correction-gate.tap`. Commands: `node --test --test-concurrency=1 --test-reporter=dot --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination=.omni/runs/v312-correction-gate.tap test/*.test.js test/**/*.test.js`; separate changed-module syntax/diff whitespace checks pass.
- Remaining: generated workflows/templates adopting these APIs, nontrivial project dependency preparation, process-kill/lease recovery and concurrency qualification, fresh clean install/tarball smoke and scoped Gemini live run. No commit/push/publish performed.

## Implementation checkpoint — workflow generation and package smoke (2026-09-06)

- New controller reference `templates/workflows/dual-controller.md` supplies exact context_reply/correction/isolated_qc calls, state-driven waits, plan modes and evidence boundaries. Every Codex-AGY native workflow points to it before generic task execution. Actual generated pairing text and Codex dirty-tree/setup instructions are repaired.
- Reference usability baseline: a fresh agent reading old docs marked reply/correction/dependency APIs UNDOCUMENTED. Updated-reference fresh agent correctly selected exact payloads, preserved scope and ordered overlapping workers through controller QC/integration. This is documentation retrieval evidence, not model-runtime qualification.
- `node --test --test-concurrency=1 test/dual-controller-workflows.test.js test/workflow-command-contracts.test.js test/init.test.js test/init-all-ides.test.js test/workflows.test.js test/codex-smoke.test.js` → 261 pass, 0 fail, exit 0. Diff whitespace and changed init syntax pass.
- Clean install in a fresh temp copy: `npm ci --ignore-scripts --no-audit --no-fund` → exit 0, 104 packages. Existing workspace node_modules was not changed. Lockfile metadata still has its historical version mismatch; install did not fail from that metadata.
- `npm pack --json --pack-destination <qualification-root>` and `npm install --prefix <qualification-root>/installed --ignore-scripts --no-audit --no-fund <tarball>` succeeded. Independently installed CLI reports 3.1.1 and dual --help works. All eight new runtime modules and the controller workflow were present; six generated native entrypoints resolve the controller reference.
- Packed artifact SHA256: D4BE257AD8C5B7815DB860E53FE14A4F39A01E2633E3F77411191FB74287B46C. Location: C:/Users/TAV/AppData/Local/Temp/omni-v312-qualification-e1ba12bf75134ae29cf2b4d1538ac58a/omni-coder-kit-3.1.1.tgz. This is a local development snapshot, not an npm release or final v3.1.2 qualification.
- Still required: nontrivial private dependency/validator preparation, process/lease recovery evidence, current full-suite after workflow changes, and scoped live Codex–AGY qualification. No commit/push/tag/publish.

## Implementation checkpoint — private locked npm dependencies (2026-09-06)

- Added `private-dependencies.js`, explicit dependency_mode npm-ci in plan/spec/daemon/MCP, and lease-bound task.dependencies.prepared receipt. Installation happens in private cwd before any model invocation; source node_modules is not shared or changed.
- Reuses shell-free package-manager resolver, npm ci with --ignore-scripts/--no-audit/--no-fund/--install-links, bounded subprocess runtime/output, package/lock hashes and full dependency-tree fingerprint. Private result collection excludes node_modules only after verifying that anchored receipt/tree; changed install bytes cannot hide in the exclusion.
- Tests execute actual npm: empty locked project and a file:vendor/helper package yielding 42. A postinstall marker stays absent. Missing lock/authority, competing shrinkwrap, local path escape, receipt mutation and dependency mutation are rejected. Package and lock are immutable for npm-ci slices.
- Independent reviewer reproduced an npm-shrinkwrap precedence bypass with an outside local dependency; regression now rejects shrinkwrap before setup and verify. Dedicated dependency suite 6/6 pass; broader pre-final-review set 112 pass, 0 fail. No live inference.
- Mode currently supports single-package npm only; workspaces and lifecycle/native build steps require a separate declared capability. Process-interruption setup recovery, build output handling, current full-suite and scoped live qualification remain open.

## Implementation checkpoint — process evidence and bounded recovery (2026-09-06)

- Added task-processes.js and controller/process intent/start/exit/release-request/recovery events. Real worker, private dependency setup and Codex QC spawns are tracked; argv/secrets are not put in ledger.
- Normal cleanup cannot release while tracked subprocess state is pending/running. It records deferred release intent and finishes when close arrives. This addresses timeout paths that settle before child-close, without inferring termination from a timeout alone.
- task.recover RPC and MCP resume.recovery use ledger PIDs and OS liveness, never caller-supplied PIDs. Pre-spawn dead-controller recovery is tested with an actual killed Node controller and reopened store. Live controller/worker and uncertain intent are refused.
- Important boundary: reviewer demonstrated a detached descendant survives direct worker exit. The implementation now refuses recovery for any crashed execution with recorded spawned PIDs absent process-tree evidence. This is an explicit unqualified case, not an assertion all process descendants are stopped. No unsafe auto-kill/release workaround was added.
- Verification: process tests8 pass; broader authority/runner/dependencies/client81 pass; MCP recovery test pass. Full runner started with current files and TAP `.omni/runs/v312-recovery-full.tap`; completion will be recorded only after terminal output. No live Gemini run, commit/push/publish.

## Current verification handoff (2026-09-06)

- `.omni/runs/v312-recovery-full.tap` completed: 1700 pass, 0 fail, 2 skipped, 1702 tests/223 suites, exit0, about264 seconds. All35 changed JavaScript files passed `node --check`; diff whitespace checks passed.
- Code is on codex/v3.1.2 with uncommitted work; package version still3.1.1. No npm publish/tag/deploy/commit/push performed.
- Next live evidence requires explicit cost scope: proposed two small tasks in a temporary workspace, Gemini alias gemini-3.8-flash-high, at most nine total phase invocations, controller QC and handoff. No customer source tree is part of this qualification. Live operation remains unproven until that run actually completes.
- This checkpoint is not full goal completion. Crash recovery after a spawned process still requires process-tree evidence; direct-PID-only release is intentionally refused. Current recovery proof covers recorded pre-spawn controller death and normal deferred cleanup. Other unsupported project dependency modes are documented rather than represented as qualified.

## Updated package snapshot while awaiting live authority (2026-09-06)

- Repacked after dependency/process-recovery changes into C:/Users/TAV/AppData/Local/Temp/omni-v312-recovery-pack-3df047e20256499d8fddcd658b42d9c2/omni-coder-kit-3.1.1.tgz; SHA256 A94EFEA4A569C2AE28A4425F1C9B536CB443C345029E503F595310D72509F088. This supersedes the earlier development tarball for runtime parity checks.
- Independent `npm install --ignore-scripts --no-audit --no-fund` succeeded (105 packages). Installed CLI --version returned3.1.1. Ten new runtime modules matched current source bytes; generated controller entrypoints and recovery contract were present. No publish or source mutation was performed by this packaging check.
- Original implementation turn made progress; this continuation adds current-package evidence. Live-model permission request remains unanswered; automatic goal continuation is not that approval. Do not rerun unchanged full tests or create new model attempts solely to fill this wait.

## Goal blocked audit — awaiting live-run authority (2026-09-06)

The same missing live-cost authorization has persisted through three consecutive goal turns: first requested after the full recovery gate, then re-requested after updated tarball verification, and revalidated now. No user approval for inference has arrived. The latest continuation cannot substitute for that approval.

Goal is not complete. Current branch codex/v3.1.2 remains at base HEAD a46dff2e78307a0ad750a33154f9b3baceeb37ea with task changes uncommitted; current test log ends 1700 pass/0 fail/2 skipped, and latest independent tarball SHA256 remains A94EFEA4A569C2AE28A4425F1C9B536CB443C345029E503F595310D72509F088.

Next user action: explicitly authorize the bounded live qualification (two temporary tasks, gemini-3.8-flash-high, at most nine phase invocations, model usage allowed, no commit/push/deploy/customer-source mutation), or supply a different budget/scope. After authorization, revalidate worktree/capability and continue the original goal, including unresolved qualification limits; do not mark success from these offline gates alone.

## Live authorization resolved and executed (2026-09-06)

User explicitly approved the two temporary tasks / maximum9 phase calls. The actual run consumed6 calls with AGY1.1.27 and gemini-3.8-flash-high, passed both task validators and three quality cycles, and reached session VERIFIED without blockers. The same receipt was verified after restarting the temporary daemon, with no additional AGY calls and all leases released. Full evidence and scope boundaries are recorded in V3_1_2_LIVE_QUALIFICATION.md. Earlier statements that live authorization is pending are historical and superseded; do not repeat that permission blocker.

## Post-live correction — accepted overlapping edits (2026-09-07)

- Found and reproduced a remaining coordination defect: A and B both correctly integrate changes to index.js in order, but rechecking A compared live source only against A's old output and returned a false CONFLICT.
- Updated isolated-qc.js verified replay to follow later task.completed records for relevant source/context paths. Each later handoff and integration receipt must still validate, its result must match the completion, and its before hash/mode must equal the previously accepted after-state. Only this verified chain can replace the expected final source bytes.
- Regression covers valid A→B overwrite, replay with no ledger writes, later external drift and tampered B receipt. Focused command: `node --test --test-concurrency=1 test/dual-isolated-runner.test.js test/dual-task-integration.test.js test/dual-task-scheduler.test.js test/dual-authority-store.test.js` →81 pass,0 fail,exit0. Independent read-only reviewer found no concrete issue in this bounded delta; deeper chain/path-type cases remain optional coverage expansions.
- Replayed both tasks from the preserved live session with the new verifier: both TASK_VERIFIED, unchanged authority hash, zero model calls. This does not requalify a new live model execution; previous live receipt and phase count remain unchanged.
- Current source now includes this post-live fix and differs from the previously packed/live-tested implementation in isolated-qc.js. Do not claim old tarball byte parity for this updated source; refresh broad/package gates before final delivery.

## Final-audit gaps closed (2026-09-07)

- Independent completion audit found that failures before onPrepared had no durable outcome and that a created-but-unregistered attempt directory could not be resumed/corrected. Added reproductions: missing context produces FAILED before any model call; simulated interruption leaves an orphan snapshot, reopen sees its failed attempt, correction2 proceeds and original binding bytes remain unchanged.
- Outcome/correction reducer now correlates the current attempt even without a registered workspace. Only this case uses previous_binding_sha256:null; registered binding hashes still must match. Failure outcome, released lease, sequential budget and partial-integration refusal remain enforced. Independent source review confirmed no scope/authority bypass in these fixes.
- Fresh focused preparation/authority/integration/process/contracts gate:115 pass,0 fail,exit0; `.omni/runs/v312-preparation-focused.tap`.
- The broad run `.omni/runs/v312-overlap-final.tap` found two Stop-hook completion timeouts after500ms under host load. Completion performs snapshot work, so it now uses a separate bounded10000ms request; health remains500ms. Three focused Stop-hook tests pass. That broad run is not a PASS result for current code and remains preserved as failure evidence.
- A pre-preparation-fix tarball was built and installed successfully at C:/Users/TAV/AppData/Local/Temp/omni-v312-overlap-pack-d7afdbd5097a4eb782fc21a3ebafb5f5/omni-coder-kit-3.1.1.tgz, SHA256092CE3001AC7DB884B1AA77E66CAE673F4635924D5B5B1947BA57E3DD77806D8;245 installed source/template files matched after CRLF normalization. It is superseded by these code changes and must not be called the final current artifact.

## Final transport and delivery gate (2026-09-07)

- Another preserved broad run (`v312-final-freeze.tap`) failed2 internal RPC requests with ECONNRESET while waiting on worker phases. Node24's global HTTP agent was pooling keep-alive sockets. Added a deterministic regression proving socket reuse, then configured each daemon RPC with agent:false; each request now gets a fresh connection without automatic replay of a possibly mutating request. Client suite15/15 pass; the two targeted orchestration tests also pass.
- Final frozen-source runner `.omni/runs/v312-transport-final.tap`: **1705 pass,0 fail,2 skipped**,1707 tests/223 suites,exit0,511489ms. The two skips require file-symlink privileges unavailable on this host. All37 changed JavaScript files passed syntax; diff whitespace passed.
- Final independently installed candidate: C:/Users/TAV/AppData/Local/Temp/omni-v312-transport-pack-cfd8070f868d435882d47e4578cde64c/omni-coder-kit-3.1.1.tgz. SHA25643CCBA652AA74EC5FD410E7E9E3FBDC2D453F41AD0874F7AE348AFA3D2277AD1. Install105 packages succeeded;245 packaged runtime/template files matched current source after line-ending normalization; CLI version3.1.1 passed. Saved live receipt replayed with updated transport, unchanged ledger and zero new model calls.
- Final objective/evidence mapping, usage instructions and scope boundaries are in V3_1_2_HANDOFF.md. Branch remains codex/v3.1.2 at base HEADa46dff2 with all requested work uncommitted; no commit/push/merge/tag/publish/deploy. Development optimization is delivered, not a published release or universal zero-failure guarantee.
