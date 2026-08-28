# Omni v4 Milestone 6 Dogfood and Resilience Design

**Ngày:** 2026-08-29
**Trạng thái:** Đã được người dùng duyệt
**Nhánh điều phối:** `v4`

## 1. Mục tiêu

Hoàn thành chương trình Milestone 6 theo sáu gate độc lập:

1. External Dogfood #1 trên dự án JavaScript `E:\demoSite`.
2. External Dogfood #2 trên dự án non-JavaScript.
3. External Dogfood #3 trên dự án có test configuration bất thường hoặc chưa đầy đủ.
4. Chaos và resume qualification.
5. So sánh reliability v4 với v3 và chứng minh migration backup/dry-run/rollback.
6. Chứng minh reliable completion rate đạt tối thiểu 90%.

Chương trình ưu tiên correctness trước efficiency. Không gate nào được coi là PASS chỉ vì agent báo thành công hoặc file đã thay đổi.

## 2. Quyết định đã khóa

- Dùng staged evidence program; mỗi gate có baseline, report, exit criteria và commit riêng.
- `E:\demoSite` được tạo baseline commit local trước Dogfood #1. `node_modules/`, `dist/`, `.env` và `.omni/` không thuộc baseline source.
- Dogfood #1 là reliability-maintenance task: chuẩn hóa `npm test` thành Vitest CI deterministic và bổ sung regression coverage cần thiết.
- Không gọi production waitlist endpoint. Network behavior dùng mock hoặc local test server với dữ liệu giả.
- Codex là host first-class duy nhất cho qualification chính thức tại thời điểm thiết kế.
- AGY có thể hỗ trợ experimental nhưng mọi output phải qua Codex QC và không được tính vào first-class SLO.
- Claude tiếp tục deferred cho đến khi có tài khoản và live qualification riêng.
- Không push, deploy, tag hoặc promote compatibility nếu chưa có yêu cầu riêng và evidence tương ứng.

## 3. Chiến lược kiến trúc

### 3.1 Control plane

Omni v4 giữ checked-in benchmark manifest và case definitions. Absolute machine paths không được commit vào manifest. Một local binding bị Git ignore ánh xạ case ID tới:

- source repository root;
- pinned Git revision;
- dependency-staging policy;
- optional local toolchain metadata.

Runner phải xác nhận binding, revision và baseline cleanliness trước khi tạo temporary workspace.

### 3.2 External project staging

External source được stage từ pinned revision vào workspace tạm do runner sở hữu. Runner không copy:

- `.git/`;
- `node_modules/`, `dist/`, build output;
- `.env*` chứa runtime values;
- `.omni/` ledger cũ;
- credentials, tokens hoặc machine-local configuration.

Dependency setup chạy bằng typed command và được ghi evidence. Workspace cleanup chỉ nhắm đúng temporary directory do runner tạo.

### 3.3 Live task contract

External case phải khai báo:

- task prompt cụ thể;
- allowed files hoặc allowed path prefixes;
- required capabilities;
- side-effect mode;
- timeout;
- quality gates;
- expected final phase và acceptance status.

Live adapter result chỉ hợp lệ khi schema-valid, correlation ID đúng và `status === "succeeded"`. Runner phải kiểm tra diff thực tế, scope và secret scan trước independent gates. Adapter success nhưng không có required mutation là failure.

### 3.4 Evidence và report

Mỗi report ghi tối thiểu:

- source revision và dirty-state decision;
- manifest/config hashes;
- workspace diff fingerprint;
- adapter, CLI version, model/session/usage metadata khi có;
- executed typed commands, exit codes và bounded summaries;
- artifact/evidence IDs;
- expected vs actual result;
- retry, repair, resume và user-intervention counts;
- false-success và false-failure classification.

Report JSON là authority artifact; Markdown là human-readable view được sinh từ cùng data.

## 4. Gate 1 — External JavaScript Dogfood

### Target

`E:\demoSite`, React 19 + Vite 8 + TypeScript + Vitest.

### Baseline

- Bổ sung ignores tối thiểu cho dependencies và build output.
- Chạy targeted Vitest, full test, typecheck, build và audit.
- Tạo initial local commit; không push.
- Tạo isolated worktree cho task mutation.

### Workload

Chuẩn hóa `npm test` để mặc định chạy một lần trong CI, không vào watch mode. Chỉ sửa `package.json` và test/config liên quan trực tiếp nếu regression chứng minh cần thiết.

### Independent gates

- clean install hoặc dependency proof tái lập;
- `npm run typecheck`;
- `npm test`;
- `npm run build`;
- credential scan;
- exact allowed-file diff check.

### Exit

PASS khi Codex trả structured success, mutation đúng scope, toàn bộ mandatory gates PASS và report tái lập được. External endpoint không được gọi.

## 5. Gate 2 — External Non-JavaScript Dogfood

Candidate ban đầu là `E:\MindXTool_LMS\backend`, có Python `requirements.txt` và parent Git repository. Trước activation phải:

- đọc repo rules;
- xác nhận repository cleanliness và pinned revision;
- xác nhận Python/toolchain/dependency setup;
- xác định một bounded maintenance task có objective assertions;
- chạy baseline tests.

Nếu baseline hoặc toolchain không tái lập được, gate là BLOCKED. Không thay bằng JavaScript fixture rồi gọi là external non-JavaScript.

## 6. Gate 3 — External Unusual-Test Dogfood

Candidate ban đầu là `E:\DemoKit`, hiện có build/lint scripts nhưng không có standard test script. Workload dự kiến là thêm deterministic test harness tối thiểu, không redesign UI.

Trước activation phải xác nhận Git history, repo rules, baseline build/lint và exact task scope. Nếu repo không thể tạo immutable baseline an toàn, gate là BLOCKED.

## 7. Gate 4 — Chaos và Resume

Lập matrix bao phủ tám scenario roadmap:

1. Omni bị dừng trong từng major state.
2. Agent CLI exit nonzero có structured output.
3. Agent CLI exit nonzero không có structured output.
4. Network mất trong agent step.
5. CLI output format thay đổi.
6. Filesystem unavailable hoặc persistence write failure.
7. Cùng timeout lặp lại.
8. Artifact thay đổi sau evidence capture hoặc resume sau protected side effect.

Tái sử dụng fault scenarios hiện có khi assertions đã chứng minh đúng contract. Chỉ bổ sung gap tests bằng TDD. Tất cả destructive simulation chạy trong disposable workspace hoặc injected fake boundary; không kill repo/process không thuộc runner và không làm đầy filesystem thật.

Exit gate:

- mọi crash scenario có deterministic resume/block result;
- không protected side effect nào tự động replay khi authority không đủ;
- `falseSuccessCount === 0`;
- corrupted/missing evidence không thể tạo accepted verdict.

## 8. Gate 5 — V3 Comparison và Migration

### Comparison

V3 và v4 dùng cùng task definitions, fixture inputs và acceptance expectations khi applicable. Báo cáo tách:

- actual completion;
- reported completion;
- false success/failure;
- wall-clock và gate duration;
- retry/repair/resume counts;
- available usage/context metadata.

Không kết luận v4 tốt hơn chỉ từ số lượng feature hoặc prose review.

### Migration

Workflow bắt buộc:

1. inspect source;
2. dry-run và deterministic plan;
3. tạo backup có manifest/checksum;
4. apply chỉ khi explicit write mode được cho phép;
5. verify migrated artifacts;
6. rollback và byte-level comparison với original.

Migration failure phải giữ original recoverable và trả BLOCKED/FAILED có stable signature.

## 9. Gate 6 — Reliability Qualification

Reliable completion rate được tính:

`reliable accepted runs / applicable completed runs`

Một run chỉ là reliable accepted khi:

- expected acceptance là accepted;
- actual acceptance là accepted;
- không false success/failure;
- mandatory evidence hợp lệ;
- report integrity hợp lệ;
- không có unacknowledged external side effect.

Blocked, timeout, malformed output, evidence mismatch và unexpected mutation không được tính success. Skipped chỉ bị loại khỏi denominator khi case thật sự non-applicable và lý do được ghi rõ.

Exit Milestone 6:

- completion rate tối thiểu 90% trên repeated clean runs;
- mọi defined crash scenario resume hoặc block đúng;
- zero defined chaos false success;
- migration original recoverable;
- correctness regressions được xử lý trước performance optimization.

## 10. Failure và stop conditions

Chương trình dừng ở gate hiện tại khi gặp:

- dirty/unpinned source không thể cô lập;
- missing authority hoặc model-cost approval;
- baseline mandatory gate failure;
- live adapter malformed/ambiguous output;
- unexpected file mutation;
- secret/credential exposure;
- external target hoặc toolchain chưa được xác nhận;
- ba remediation attempts không giải quyết cùng một contract failure.

Không tự đổi target repo, hạ mandatory gate, mở rộng allowed scope hoặc promote experimental host để đạt con số 90%.

## 11. Delivery boundaries

- Mỗi gate có spec/plan/report và atomic commit riêng.
- Baseline/project commits là local trừ khi người dùng yêu cầu push.
- Omni control-plane changes được thực hiện trên branch/worktree cô lập.
- AGY chỉ nhận task bounded, low-risk, có allowed files và validation commands; Codex giữ orchestration, review, acceptance và final reporting.
- Production endpoint, deployment, tag và public release nằm ngoài phạm vi tự động của chương trình này.
