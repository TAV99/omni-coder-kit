# Handoff — Omni v4 Codex Live Smoke

> Ngày: 2026-08-28
> Branch: `v4`
> Base trước thay đổi: `a9182f2`
> Host: Codex CLI `0.150.1`, `win32-x64`
> Trạng thái: **PASSED — Codex 0.150.1 live smoke & compatibility verified**

## Mục tiêu

Re-qualify Codex adapter của Omni v4 bằng một live smoke có model cost: tạo temporary Git repository, yêu cầu Codex thêm dòng `Smoke test passed.` vào `README.md`, rồi chỉ chấp nhận khi adapter trả `StepResult.status === "succeeded"` với structured output hợp lệ.

## Kết quả hiện tại

- Actual-host compatibility probe chạy được với Codex `0.150.1` và vượt qua toàn bộ required flags.
- Đã giải quyết triệt để 3 vấn đề tương thích:
  1. Loại bỏ xung đột `--sandbox workspace-write` và `--approve-for-me`.
  2. Bọc JSON schema trong object-root envelope (`type: object`, `outcome: { anyOf: [...] }`).
  3. Cho phép ISO 8601 datetime có timezone offset (`{ offset: true }`) trong Evidence và contracts.
- Live smoke test với model cost đã thực thi thành công hoàn toàn; lần verify độc lập mới nhất hoàn tất trong khoảng `51.65s`:
  - Workspace mutation: file `README.md` được ghi thêm dòng `Smoke test passed.`.
  - Structured output: `StepResult.status === "succeeded"` được validate nghiêm ngặt fail-closed qua Zod.
- Đã cập nhật `compatibility/v4/hosts.json`: `verifiedVersion: "0.150.1"`, `contractVerified: true`, `liveSmokeVerified: true`, `verifiedPlatforms: ["win32-x64"]`.
- Typecheck, build và automated v4 suite đều PASS (`191 pass, 0 fail, 2 skip`).
- Không push, publish hoặc release.

## Các incompatibility đã sửa

### 1. Workspace-write flags của Codex 0.150.1

Invocation cũ truyền đồng thời:

```text
--sandbox workspace-write --approve-for-me
```

Codex `0.150.1` trả exit code `2` vì hai options này mutually exclusive. Invocation mới dùng riêng `--approve-for-me`; read-only vẫn dùng `--sandbox read-only`, elevated vẫn dùng `--dangerously-bypass-approvals-and-sandbox`.

### 2. Structured Outputs schema

Schema cũ dùng top-level `oneOf`; Codex API trả `invalid_json_schema`. Schema Codex mới:

- dùng root `type: object`;
- có một required property `outcome`;
- đặt union trong nested `anyOf`;
- bắt buộc mọi declared property trong mỗi object schema;
- giữ Zod `AgentStepOutcomeSchema` làm validation fail-closed sau khi unwrap envelope;
- từ chối envelope có field ngoài `outcome`.

Shared schema cho Claude và Antigravity vẫn giữ shape trực tiếp. Chỉ Codex adapter dùng object-root envelope mới.

### 3. Datetime và live timeout

- Các v4 contracts chấp nhận ISO 8601 datetime có timezone offset, bao gồm output dạng `+07:00` từ host thực.
- Live smoke dùng timeout mặc định `120000ms` và cho phép override bằng `OMNI_V4_LIVE_TIMEOUT_MS`.
- Override chỉ nhận positive safe integer; input rỗng, số âm, số thập phân hoặc chuỗi có suffix bị reject thay vì bị `parseInt()` chấp nhận một phần.

## Files đã thay đổi

- `src/v4/adapters/codex/adapter.ts`
- `src/v4/adapters/codex/command.ts`
- `src/v4/adapters/codex/parser.ts`
- `src/v4/adapters/shared/result-schema.ts`
- `src/v4/contracts/artifact.ts`
- `src/v4/contracts/event.ts`
- `src/v4/contracts/evidence.ts`
- `src/v4/contracts/quality.ts`
- `src/v4/quality/evidence-bundle-store.ts`
- `compatibility/v4/hosts.json`
- `test/v4/adapter-contract.test.ts`
- `test/v4/codex-command.test.ts`
- `test/v4/codex-parser.test.ts`
- `test/v4/host-smoke.test.ts`
- `docs/v4/HANDOFF_CODEX_LIVE_SMOKE_2026-08-28.md`

## Evidence mới nhất

```text
npm run typecheck:v4  -> PASS
npm run build:v4      -> PASS
npm run test:v4       -> 191 pass, 0 fail, 2 skip (193 total)
git diff --check      -> PASS
diff secret scan      -> PASS
```

Official live command:

```powershell
$env:OMNI_V4_ALLOW_MODEL_COST = "1"
$env:OMNI_V4_LIVE_HOST = "codex"
# Optional: $env:OMNI_V4_LIVE_TIMEOUT_MS = "120000"
node --import tsx --test test/v4/host-smoke.test.ts
```

Kết quả live mới nhất:

```text
live-smoke: executes real CLI in temporary repository -> PASS
tests 1, pass 1, fail 0
duration approximately 51.65s
```

Temporary workspace và assertions:
- `README.md` đã được ghi dòng `Smoke test passed.`.
- `parsedOutcome` bóc envelope thành công, validate Zod schema thành công với status `succeeded` và executionId `smoke-op-1`.

## Lịch sử các QA cycles

1. Reproduce CLI exit `2`; sửa conflict giữa `--sandbox workspace-write` và `--approve-for-me` bằng TDD.
2. Reproduce API `invalid_json_schema`; sửa object-root Structured Outputs schema và parser envelope bằng TDD.
3. Chạy live smoke phát hiện timeout `60_000ms` và Zod reject datetime có offset timezone (`+07:00`).
4. Cấu hình timeout linh hoạt (`OMNI_V4_LIVE_TIMEOUT_MS`), cập nhật `EvidenceSchema` và các contracts dùng `z.string().datetime({ offset: true })`.
5. Live smoke PASS 100%, cập nhật `compatibility/v4/hosts.json` cho Codex `0.150.1` trên `win32-x64`.

## Bước tiếp theo

1. Giữ Codex ở trạng thái first-class miễn là binary version, platform và adapter contract không đổi.
2. Chuyển sang Claude live smoke theo cùng gate: actual-host probe, temporary workspace mutation và structured `succeeded` result.
3. Chỉ chạy lại Codex live smoke khi version/platform/contract thay đổi hoặc khi có regression liên quan; mọi lần gọi model vẫn cần explicit model-cost approval.

## Guardrails

- Không coi temporary file mutation là live-smoke success.
- Không biến timeout, missing result hoặc malformed output thành synthetic success.
- Không bỏ Zod validation hoặc nới `additionalProperties` để làm test xanh.
- Không cập nhật compatibility status chỉ dựa vào unit/contract tests.
- Không push, publish hoặc release nếu chưa có lệnh rõ ràng từ người dùng.
