# Discussion Transport Implementation Plan

> **For agentic workers:** Dùng skill executing-plans để thực hiện tuần tự từng task với review checkpoints. Không tạo subagent. Argon review spec/plan rồi trực tiếp implementation theo ủy quyền người dùng; Astra chỉ là tác giả tài liệu.

**Goal:** Tạo thư viện discussion relay opt-in có contract, bounded execution, durable ownership và unknown-outcome fail-closed.

**Architecture:** Additive CommonJS library; controller gọi receive/dispatch từng lượt. Journal local single-owner; provider invocation và capability enforcement qua trusted injected ports. Không nối vào execution pipeline hiện hữu.

**Tech Stack:** Node.js built-ins: `node:fs`, `node:fs/promises`, `node:crypto`, `node:path`, `node:test`, `node:assert/strict`; không package mới. Đã xác nhận từ `package.json` (`node --test --test-concurrency=1`) và `test/dual-contracts.test.js` rằng repo sử dụng CommonJS + `node:test` + `node:assert/strict`.

## Global Constraints

- Chỉ code `lib/dual/discussion/`, tests `test/dual-discussion-*.test.js`, docs `docs/dual/discussion-transport/`.
- Không sửa file hiện hữu dirty, package, root SDLC, daemon, isolated runner hoặc leases. Nếu target đã tồn tại thì đọc và review trước, không overwrite.
- Không commit/stage/push/deploy, cài dependency, start Dual daemon hoặc messaging ngoài.
- Feature flag mặc định OFF; live capability thiếu bằng chứng thì blocked.
- Không stale-lock stealing; không retry/new attempt tự động; không coding integration.
- Defaults: 2 participants, 12 turns, 120000 ms/turn, body 16384 bytes, snapshot 65536 bytes, mỗi output stream 262144 bytes, journal 8 MiB/256 events, TTL 300000 ms tối đa 900000 ms.
- Parent lưu tài liệu bằng apply_patch. `customer-spec.md` do parent sao chép nguyên văn yêu cầu khách hàng và section Phương án v1 đã cung cấp; không suy diễn từ bản tóm tắt này.

## Trước implementation

Argon đọc AGENTS/rules áp dụng, xác nhận source/test paths bằng focused reads, kiểm tra dirty worktree chỉ đọc. Đối chiếu thiết kế với supplied excerpts; không tuyên bố đã audit toàn repo. Nếu runtime không có node:test hoặc các path mới xung đột, ghi blocker cụ thể để review thay vì thay package hay sửa tests cũ. Không cần user approval giữa các task đã chốt; ba checkpoints dưới đây là quality gates.

## File map

- `lib/dual/discussion/contracts.js`: validation, canonical hashes, limits, DiscussionError.
- `lib/dual/discussion/journal.js`: exclusive owner, append/sync/replay validation, readonly inspect.
- `lib/dual/discussion/adapter.js`: trusted adapter wrapper, bounded invocation và classification boundary.
- `lib/dual/discussion/relay.js`: receive/dispatch/result/recovery state machine.
- `lib/dual/discussion/index.js`: exports createDiscussionRelay, createDiscussionAdapter, inspectJournal, DiscussionError; side-effect free.
- `test/dual-discussion-contracts.test.js`, `test/dual-discussion-journal.test.js`, `test/dual-discussion-adapter.test.js`, `test/dual-discussion-relay.test.js`, `test/dual-discussion-recovery.test.js`.

Fixtures nhỏ để inline trong test files; helper chỉ export bên trong namespace mới nếu thực sự dùng chung. Không framework hay abstraction bổ sung.

## Task 1 — Contracts và limits

**Produces:** `validateBinding(value) -> Binding`, `bindingRef(binding) -> string`, `validateEnvelope(value, {bindings,messages,nextSequence,now,limits}) -> StoredEnvelope`, `validatePayload(value, limits) -> Payload`, `validateSnapshot(value,limits) -> Snapshot`, `resolveLimits(overrides) -> Limits`, `DiscussionError` trong contracts.js. Input/output chính xác theo design-spec; validation thuần, không I/O.

- [x] Viết tests R03–R07/R18/R21, từng case theo bảng requirements, dùng node:test/assert.
- [x] Chạy `node --test test/dual-discussion-contracts.test.js`; RED phải do module/export chưa có, không do syntax test.
- [x] Implement strict schemas và canonical hashing; reject unsupported fields, size kiểm theo Buffer.byteLength. Ví dụ test boundary thực thi:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePayload } = require('../lib/dual/discussion/contracts');
test('UTF8 byte ceiling', () => {
  assert.throws(() => validatePayload({schema_version:1,kind:'reply',body:'ế'.repeat(6000)}, {maxBodyBytes:16384}), {code:'LIMIT_EXCEEDED'});
});
```

- [x] Thêm duplicate/correlation tests với hai bindings fixture, thay riêng từng field để chứng minh hash và conflict behavior; sequence bắt đầu 1.
- [x] Chạy lại command trên đến GREEN; tự review không có filesystem/provider dependency.

## Task 2 — Durable journal và owner

**Consumes:** contracts hashes/errors/limits. **Produces:** `openJournal({stateDir,maxBytes,maxEvents}) -> Journal`, `inspectJournal({stateDir}) -> JournalView`; Journal `append(event)`, `read()`, `close()`. Events: registered bindings/snapshot hash, received, dispatch_intent, observation, response, outcome_unknown, reconciled. Index/hash/time metadata do journal sinh; event-specific fields từ relay.

- [x] Viết tests với fs.mkdtemp trong OS temp, tách test fixture cleanup khỏi production behavior. Test exclusive open, retained lock, wrong-token release, malformed tail/hash/index, sync-before-ACK và quota. Không xóa broad paths.
- [x] Chạy `node --test test/dual-discussion-journal.test.js` để thấy RED.
- [x] Implement open('wx'), owner token, serialized append + FileHandle.sync; verify existing journal trước mutable use. Không rewrite/truncate khi corrupt. Failure poison giữ lock.
- [x] Kiểm thử owner cụ thể:

```js
const a = await openJournal({stateDir,maxBytes:8388608,maxEvents:256});
await assert.rejects(openJournal({stateDir,maxBytes:8388608,maxEvents:256}), {code:'OWNER_BUSY'});
await a.append({type:'received',message_id:'m1'});
assert.equal((await a.read()).events.length, 1);
await a.close();
```

Test event schema tối thiểu phải dùng đúng required fields của journal implementation; receipt full envelope được relay tests kiểm tra. Test malformed/half-written record chỉ tạo trong temp fixture, không dùng recovery code sửa nó.

- [x] GREEN command trên; chứng minh clean close/reopen và crash fixture không thể reopen dù PID cũ không còn.

### Checkpoint 1 — Contract/ownership review

Chạy `node --test test/dual-discussion-contracts.test.js test/dual-discussion-journal.test.js`. Review R03–R07/R12–R14/R18/R22; chưa claim toàn G0. Argon xác nhận lock không dựa timeout/PID để takeover và không có execution mutation.

## Task 3 — Adapter boundary và positive completion

**Consumes:** payload validation/errors/limits. **Produces:** `createDiscussionAdapter({id,provider,version,mode,profile,invoke,classify}) -> Adapter`; adapter invoke/classify signatures giữ nguyên design-spec. Wrapper kiểm output bounds, version identity, `profile.allowlistedTerminalMarkers`, `observedConversationId === binding.conversation_id`, `raw.exitCode === 0`, `!raw.hasTerminalError`, và classifier shape; caller-supplied live profile không được mặc định success.

- [x] Viết `test/dual-discussion-adapter.test.js`: fake provider allowlist duy nhất `terminal: 'fixture.completed'`, exact conversation correlation và exit0. Fixtures synthetic phải được ghi rõ không phải AGY/Codex output thật.
- [x] RED: `node --test test/dual-discussion-adapter.test.js`.
- [x] Implement wrapper, reject invalid profile; test positive classification predicate:

```js
const positive = raw.exitCode === 0 &&
  raw.terminal === 'fixture.completed' &&
  raw.conversation_id === binding.conversation_id;
assert.equal(positive, true);
```

Classifier thực tế phải parse provider-specific fixtures; predicate trên chỉ là oracle fake test. Thêm error+valid payload, missing marker, malformed JSON/JSONL, exit nonzero, mismatch và oversize. Không tái dùng existing agy-output như success gate.

- [x] Thêm fake invoke đếm calls; thiếu capability phải được relay chặn trước khi adapter invoke. Bounded capture là obligation của trusted invoke port; wrapper reject observation vượt cap, live verifier phải xác nhận capture policy trước spawn.
- [x] GREEN command; không thêm CLI command builder đoán flags, không built-in live profile chưa kiểm chứng.

## Task 4 — Functional opt-in relay

**Consumes:** contracts, journal, adapters và trusted ports từ spec. **Produces:** createDiscussionRelay và Relay API đầy đủ; index exports không side effect.

- [x] Viết `test/dual-discussion-relay.test.js`: default OFF zero I/O; registered pair; receive duplicate; stale authority; capability expiry; two-way fake dialogue; schema/provider/task separation; simultaneous dispatch; 12-turn ceiling và expiry.
- [x] RED: `node --test test/dual-discussion-relay.test.js`.
- [x] Implement order: validate config -> acquire journal owner -> register immutable bindings -> receive durable -> dispatch authority/capability check -> durable intent -> bounded invoke -> record observation -> validate payload -> recheck authority/expiry -> record correlated response. Serialize state transitions, không giữ queue khiến second dispatch vô tình chạy sau first khi caller kỳ vọng reject busy.
- [x] Contract usage test:

```js
const relay = await createDiscussionRelay(options);
await relay.receive(questionEnvelope);
const first = await relay.dispatch(questionEnvelope.message_id);
assert.equal(first.provider, 'succeeded');
assert.equal(first.task_acceptance, 'not_requested');
const second = await relay.dispatch(first.response_message_id);
assert.equal(second.provider, 'succeeded');
await relay.close();
```

`options` gồm `enabled:true`, temp `stateDir`, hai bindings cùng scope, snapshot hashed, fake adapters với allowlist ở T3, `authority.check` trả `true`, `capabilityVerifier` trả fixture evidence còn hạn và khớp đầy đủ `{bindingRef, provider, adapterId, adapterVersion, conversationId, snapshotSha256, stage:'dispatch'}`. `questionEnvelope` sequence 1 A->B, expiry trong giới hạn. Tests phải định nghĩa các fixture này inline bằng contract T1; không gọi provider thật.

- [x] Implement reconcile theo spec: current owner + authority + verified process AND provider evidence; unresolved không mở khóa. Không publish late result tự động. close unknown giữ lock.
- [x] GREEN command; validate R01/R08–R11/R15–R20. Không authority write callback trong API.

### Checkpoint 2 — G0 và functional API

Chạy `node --test test/dual-discussion-contracts.test.js test/dual-discussion-journal.test.js test/dual-discussion-adapter.test.js test/dual-discussion-relay.test.js`. Yêu cầu tất cả PASS; review usable two-way fake flow, strict completion và missing-capability blocking. G1 vẫn NOT VERIFIED.

## Task 5 — Deterministic faults, evidence và handoff

**Creates:** `test/dual-discussion-recovery.test.js`. **Updates:** chỉ docs feature namespace với observed evidence sau chạy, không sửa customer-spec nguyên văn.

- [x] Viết fault tests cho mọi boundary: received-before-ACK, intent-before-invoke, invoke-before-observation, observation-before-response, unknown-before-close. Dùng controlled promises/clock và fixture processes offline khi cần kiểm process termination; không network/CLI providers.
- [x] RED: `node --test test/dual-discussion-recovery.test.js`.
- [x] Hoàn thiện fail-closed code chỉ trong files mới. Với mỗi test assert call count, stored state, lock retained/released và response absent/present. Clock injection không đủ cho timeout scheduling: dùng test runner mock timer nếu runtime hỗ trợ; nếu không dùng timeout override nhỏ với controlled promise, tránh sleep dài.
- [x] Recovery assertion tối thiểu:

```js
assert.equal((await relay.inspect()).blocked, true);
await assert.rejects(relay.dispatch(nextMessageId), {code:'OUTCOME_UNKNOWN'});
assert.equal(invokeCalls, 1);
await assert.rejects(relay.close(), {code:'OUTCOME_UNKNOWN'});
```

Test reconcile process-only/provider-only/deny đều giữ blocked; cả hai verified mới cho phép lệnh mới, không repeat invocation cũ. Controller crash fixture luôn OWNER_BUSY; chỉ readonly inspect khả dụng, không reset helper trong production.

- [x] Chạy toàn bộ năm test files bằng command checkpoint 3; ghi pass/fail thực tế, không dùng nhận xét model làm evidence.
- [x] Ghi qualification table: G1/live G2/benchmark chưa verified nếu chưa có capability/profile; không chạy live chỉ để hoàn thành checklist. Benchmark protocol phải chọn paired sample size/thresholds trước một đợt live được phép, không bịa số đo.

### Checkpoint 3 — Deterministic G2 và handoff

Chạy `node --test --test-concurrency=1 test/dual-discussion-contracts.test.js test/dual-discussion-journal.test.js test/dual-discussion-adapter.test.js test/dual-discussion-relay.test.js test/dual-discussion-recovery.test.js` (`21/21` PASS trong 5 suites), `node --check` trên toàn bộ 10 file mới (`PASS`), và `git diff --check` (`PASS`). Kiểm tra status/diff scoped để bảo toàn tất cả dirty changes cũ; không stage. Đã xác nhận từ `package.json` rằng lệnh baseline của repo là `npm test` (`node --test --test-concurrency=1`): test kế cận `test/dual-contracts.test.js` PASS `39/39`, trong khi full baseline có 1 lỗi sẵn có không liên quan tại `test/dual-task-workspace.test.js` (`UNKNOWN: unknown error, scandir '.../bad-source'` trên Windows). Chi tiết đầy đủ ghi tại `docs/dual/discussion-transport/implementation-report.md`.

Handoff gồm R-ID matrix, commands/results, changed-file list, capability blockers và trạng thái từng Q. Không gọi implementation/live qualification/coding approval là một trạng thái chung. Spec/plan cần Argon review; implementation chỉ bắt đầu sau khi review đã chốt, không cần hỏi lại user giữa các bước. Các câu hỏi live còn mở không chặn offline implementation nhưng tuyệt đối chặn live dispatch tương ứng.

