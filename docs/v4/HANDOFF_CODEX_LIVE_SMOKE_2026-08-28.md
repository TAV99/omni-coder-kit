# Handoff — Omni v4 Codex Live Smoke

> Ngày: 2026-08-28
> Branch: `v4`
> Base trước thay đổi: `a9182f2`
> Host: Codex CLI `0.150.1`, `win32-x64`
> Trạng thái: **BLOCKED — live smoke chưa đạt**

## Mục tiêu

Re-qualify Codex adapter của Omni v4 bằng một live smoke có model cost: tạo temporary Git repository, yêu cầu Codex thêm dòng `Smoke test passed.` vào `README.md`, rồi chỉ chấp nhận khi adapter trả `StepResult.status === "succeeded"` với structured output hợp lệ.

## Kết quả hiện tại

- Actual-host compatibility probe chạy được với Codex `0.150.1` và không thiếu required flag.
- Adapter vẫn phải được coi là `experimental` vì `compatibility/v4/hosts.json` chưa có contract, live-smoke và platform evidence hợp lệ.
- Typecheck, build và automated v4 suite đều pass trên diff hiện tại.
- Codex đã sửa đúng temporary `README.md` trong live smoke cuối.
- Live gate vẫn fail vì adapter chạm deadline `60_000ms` trước khi trả structured `succeeded`.
- Không cập nhật `contractVerified`, `liveSmokeVerified`, `verifiedPlatforms` hoặc `verifiedVersion` trong compatibility manifest.
- Không push, publish hoặc release.

## Hai incompatibility đã sửa

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

## Files đã thay đổi

- `src/v4/adapters/codex/adapter.ts`
- `src/v4/adapters/codex/command.ts`
- `src/v4/adapters/codex/parser.ts`
- `src/v4/adapters/shared/result-schema.ts`
- `test/v4/adapter-contract.test.ts`
- `test/v4/codex-command.test.ts`
- `test/v4/codex-parser.test.ts`

## Evidence mới nhất

```text
npm run typecheck:v4  -> PASS
npm run build:v4      -> PASS
npm run test:v4       -> 189 pass, 0 fail, 2 skip (191 total)
git diff --check      -> PASS
diff secret scan      -> PASS
```

Official live command:

```powershell
$env:OMNI_V4_ALLOW_MODEL_COST = "1"
$env:OMNI_V4_LIVE_HOST = "codex"
node --import tsx --test test/v4/host-smoke.test.ts
```

Kết quả live cuối:

```text
tests 1
pass 0
fail 1
duration 60.228s
actual status: failed
expected status: succeeded
```

Temporary workspace còn lại sau failure cho thấy:

```markdown
# Test Repo

Smoke test passed.
```

Điều này chứng minh workspace edit đã xảy ra, nhưng không chứng minh structured completion hợp lệ.

## Lịch sử ba QA cycles

1. Reproduce CLI exit `2`; sửa conflict giữa `--sandbox workspace-write` và `--approve-for-me` bằng TDD.
2. Reproduce API `invalid_json_schema`; sửa object-root Structured Outputs schema và parser envelope bằng TDD.
3. Live smoke vượt qua hai lỗi trên và sửa file đúng, nhưng hết deadline 60 giây trước successful structured completion.

Circuit breaker đã đạt ba cycles. Không retry thêm trong cùng phiên kiểm tra.

## Bước resume bắt buộc

1. Giữ `compatibility/v4/hosts.json` nguyên trạng cho đến khi live smoke pass hoàn toàn.
2. Trong một QA cycle mới, sửa test harness để lưu sanitized `StepResult`, terminal JSONL event và result-file state khi failure; không chỉ assert `status`.
3. Chạy targeted automated tests trước khi gọi model:

   ```powershell
   node --import tsx --test test/v4/adapter-contract.test.ts test/v4/codex-command.test.ts test/v4/codex-parser.test.ts test/v4/codex-adapter.test.ts
   ```

4. Chỉ sau khi có explicit model-cost approval mới chạy lại live smoke.
5. Nếu evidence xác nhận model hoàn tất sau mốc 60 giây mà không có lifecycle defect, thêm một timeout policy có test thay vì hard-code tăng deadline tùy tiện.
6. Sau live PASS, chạy lại `npm run typecheck:v4`, `npm run build:v4`, `npm run test:v4`, rồi lưu dated evidence cho Codex version và `win32-x64`.
7. Chỉ khi mọi evidence khớp mới cập nhật compatibility manifest; sau đó chuyển sang Claude live smoke.

## Guardrails

- Không coi temporary file mutation là live-smoke success.
- Không biến timeout, missing result hoặc malformed output thành synthetic success.
- Không bỏ Zod validation hoặc nới `additionalProperties` để làm test xanh.
- Không cập nhật compatibility status chỉ dựa vào unit/contract tests.
- Không commit tiếp, push, publish hoặc release nếu chưa có lệnh rõ ràng từ người dùng.
