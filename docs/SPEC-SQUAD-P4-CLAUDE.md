# Spec — Squad P4: Claude Code làm runtime thứ ba

> Căn cứ: [`SQUAD-ARCHITECTURE-PLAN.md`](SQUAD-ARCHITECTURE-PLAN.md) D2, D12, D18, **D19** (ba runtime chính: codex, agy, claude); hợp đồng runtime P1 ([`SPEC-SQUAD-P1-RUNTIME-REGISTRY.md`](SPEC-SQUAD-P1-RUNTIME-REGISTRY.md)); cách worker chạy qua adapter và chỗ worker trong discussion P3c ([`SPEC-SQUAD-P3-PIPELINE.md`](SPEC-SQUAD-P3-PIPELINE.md) §4.3b–§4.4b).
> Ngày: 2026-11-01. Bản Claude Code trên máy: `2.1.316`.

---

## 0. Mục tiêu & phạm vi

### 0.1 Mục tiêu

1. Adapter `claude` trong registry, qua đủ bộ conformance như codex/agy: phát hiện binary, version, đăng nhập, model, dựng lệnh headless/resume/interactive, quyền, skill, `parseResult`.
2. **Claude làm worker** của dual engine: implement headless, scout/review qua discussion, chạy trong worker root cách ly, không đọc `CLAUDE.md`/skill/hook của orchestrator.
3. **Claude làm orchestrator** (P4c, xem Q-P4-1): phiên tương tác có MCP `omni_dual` + hook chặn của omni, và chỗ orchestrator (`astra`) trong discussion.
4. `omni squad setup` gắn được claude cho mọi vai; doctor, cảnh báo D18 (chung tài khoản Claude) như codex.
5. Một vòng chạy thật có claude (V-live), như V20/V21.

### 0.2 Ngoài phạm vi P4

| Mục | Sang |
|---|---|
| Vai reviewer chạy thật (claude hoặc runtime khác) | P5 |
| OpenCode, model chỉ có API | Sau 3.2.0 (D19) |
| `lib/harness/providers/host-cli` qua registry (nhánh `claudecode` đã có argv riêng) | Giữ nguyên; gộp khi harness lên registry |
| Linux/Windows chạy thật | Sau macOS (plan §11) |

### 0.3 Bất biến

- Mã chỗ `codex`/`agy`/`gemini` giữ nguyên (P3b). Claude làm worker vẫn ở chỗ `agy`; làm orchestrator vẫn ở chỗ `codex`. Ledger không đổi.
- `npm test` xanh + một lượt dưới tải trước mỗi commit; session cũ resume được.
- Agy/codex giữ argv cũ y byte.

---

## 1. Sự kiện đã biết (từ `claude --help` 2.1.316 và tài liệu)

| # | Sự kiện | Nguồn |
|---|---|---|
| C1 | Headless: `claude -p "<prompt>"`; `--output-format text\|json\|stream-json`. `json` = **một object** kết quả. | help |
| C2 | Object kết quả: `type: "result"`, `subtype` (`success` \| `error_max_turns` \| `error_during_execution` \| `error_max_budget_usd` \| `error_max_structured_output_retries`), `is_error`, `session_id`, `result` (chỉ khi success), `structured_output` (khi có `--json-schema`), `usage`, `total_cost_usd`, `num_turns`, `stop_reason`, `permission_denials[]`, `errors[]` | tài liệu headless + Agent SDK `SDKResultMessage` |
| C3 | `--json-schema <schema>`: chuỗi JSON Schema, Claude Code tự kiểm và thử lại; hết lượt → `error_max_structured_output_retries` | help, tài liệu |
| C4 | `--model <alias\|tên đủ>` (alias `fable`, `opus`, `sonnet`, …); `--effort low\|medium\|high\|xhigh\|max`; `--fallback-model` | help |
| C5 | Resume: `-r/--resume <id>`; **`--session-id <uuid>`** đặt trước id cho phiên mới; `--fork-session`; `--no-session-persistence` | help |
| C6 | Quyền: `--permission-mode acceptEdits\|auto\|bypassPermissions\|manual\|dontAsk\|plan`; `--dangerously-skip-permissions`; `--permission-prompts none` (với `-p`: thứ gì cần hỏi thì tự từ chối); `--allowedTools/--disallowedTools`, `--tools` | help |
| C7 | Thư mục: `--add-dir <dirs…>` | help |
| C8 | Cách ly cấu hình: `--setting-sources user,project,local`; `--settings <file\|json>`; `--strict-mcp-config` + `--mcp-config`; `--bare` (bỏ hook/CLAUDE.md/keychain **nhưng chỉ nhận `ANTHROPIC_API_KEY`** → không dùng được với đăng nhập gói thuê bao); `--safe-mode`; `--disable-slash-commands` | help |
| C9 | **`CLAUDE.md` đọc ngược từ cwd lên tới gốc hệ thống file** (không dừng ở git root); chặn bằng `claudeMdExcludes` (glob trên đường dẫn tuyệt đối, đặt ở mọi scope settings, mảng gộp qua các scope) | tài liệu memory |
| C10 | Skill project: `.claude/skills/` ở cwd **và mọi thư mục cha tới repository root**; skill user `~/.claude/skills` | tài liệu skills |
| C11 | Đăng nhập: `claude auth status` in JSON `{ loggedIn, authMethod, apiProvider, subscriptionType, … }` (V22: `authMethod: "claude.ai"`). Shell sandbox của phiên phát triển báo `loggedIn: false` (không đọc được keychain) — mọi lượt claude thật do người dùng chạy | V22 |
| C12 | `claude -p /model --output-format json` trả danh sách alias trong `result` (`Available: sonnet, opus, haiku, fable, best, …, or a full model ID.`), không gọi model (cost 0, ~40 ms) | V31 |
| C14 | `--tools <list>` thu hẹp tool có mặt: tool không có trong danh sách thì claude không thấy (không phải bị từ chối → `permission_denials` rỗng). Đây là cách giới hạn quyền đáng tin; `plan`/`acceptEdits` thì không (V25) | V25, R1–R2 |
| C13 | Chế độ tương tác: `claude` (TUI), nhận `--model`, `--effort`, `--add-dir`, `--mcp-config`, `--settings` | help |

---

## 2. Adapter `claude` (P4a)

`lib/squad/runtimes/claude.js`, đăng ký trong `defaultRegistry`.

| Phần | Cách làm |
|---|---|
| binary | `claude`, env `OMNI_CLAUDE_PATH`; ứng viên thêm: `~/.local/bin/claude`, `~/.claude/local/claude`, npm global (`userBinCandidates`); win32 `%APPDATA%\npm\claude.cmd` |
| capabilities | interactive, mcp, hooks, headless, write, resume, structuredOutput, usage, sandbox (permission mode) = true; multiModel = false; transcript = false (P6) |
| efforts | `['low','medium','high','xhigh','max']` (C4) |
| `version` | `claude --version` → regex `^(\d+\.\d+\.\d+\S*)\s+\(Claude Code\)` |
| `authStatus` | `claude auth status` → JSON; `loggedIn: true` → authenticated (method = `authMethod`); `false` → unauthenticated, fix "chạy: claude auth login"; lỗi parse → unknown |
| `listModels` | `claude -p /model --output-format json --permission-prompts none` (C12), tách danh sách sau `Available:` tới `, or a full model ID` → `source: 'cli'`; lỗi/không khớp → dự phòng tĩnh `fable`, `opus`, `sonnet`, `haiku` (`source: 'static'`). `efforts` = toàn bộ C4 cho mọi model. Tên đủ (`claude-…`) luôn hợp lệ ("or a full model ID") |
| `permissionFlags` | Giới hạn bằng **danh sách tool** (C14), luôn kèm `--permission-prompts none`: `read-only` → `--tools Read,Grep,Glob,Skill`; `workspace-write` → `--permission-mode acceptEdits --tools Read,Grep,Glob,Skill,Edit,Write` (không Bash); `full-auto` (chỉ isolatedRoot) → `--permission-mode bypassPermissions` (đủ tool). **Không** dùng `--permission-mode plan`: nó ghi file plan vào `~/.claude/plans` và không báo từ chối (V25) |
| `buildHeadless` | `claude -p <prompt> --output-format json --model <m> [--effort e] <quyền> <cờ cách ly §3 khi isolatedRoot> [--add-dir …] [--json-schema <nội dung file, inline>]`. cwd là thư mục tiến trình (không cần `--add-dir <cwd>`); không đặt `--session-id` — `session_id` đọc từ output (V23), như `thread_id` của codex |
| `buildResume` | cùng argv `buildHeadless` + `--resume <sessionRef>` |
| `interactiveCommand` | `claude --model <m> [--effort e]`, cwd = thư mục project (MCP/hook: P4c) |
| `parseResult` | đọc C2 (field thật: V23): `type: result`, `subtype: success` + `is_error: false` → succeeded; subtype lỗi hoặc `is_error` → failed (`SQUAD_RUNTIME_TURN_FAILED`); `permission_denials` khác rỗng → failed `SQUAD_RUNTIME_DENIED_ACTIONS` (giống Q5 của agy; với `--tools` thường rỗng — C14); payload = `structured_output`, không có thì thử parse `result`; sessionRef = `session_id`; usage = `usage.input_tokens/output_tokens`, thinking = `usage.output_tokens_details.thinking_tokens` |
| `skillDirs` / `mountSkills` | `.claude/skills` (C10) |
| `userSkillDirs` | `<CLAUDE_CONFIG_DIR \|\| ~/.claude>/skills` |
| `userInstructionFiles` (mới, optional trong descriptor) | `<CLAUDE_CONFIG_DIR \|\| ~/.claude>/CLAUDE.md` → doctor cảnh báo `SQUAD_USER_INSTRUCTIONS_GLOBAL` (Q-P4-2) |

`jsonSchemaPath` trong hợp đồng turn giữ nguyên; adapter đọc file và truyền nội dung (C3 — V24: đường dẫn bị từ chối `--json-schema is not valid JSON`). Schema **không** strict hóa: schema evidence thật (có field optional) qua thẳng, `structured_output` khớp zod (V24). Giới hạn kích thước: schema > 64 KiB → `SQUAD_RUNTIME_BAD_TURN` (argv an toàn trên win32).

Conformance P1 chạy cho claude; fixture output thật ghi ở V23–V24.

---

## 3. Cách ly khi claude chạy trong worker root

Worker root nằm trong project (`.omni/runs/dual-workspaces/…`) và là git root riêng (P2b).

| Rò rỉ | Chặn |
|---|---|
| `CLAUDE.md`/`CLAUDE.local.md`/`.claude/rules` của project và mọi thư mục cha (C9) | `--settings '{"claudeMdExcludes":[…]}'` liệt kê tuyệt đối `<projectRoot>/CLAUDE.md`, `<projectRoot>/CLAUDE.local.md`, `<projectRoot>/.claude/rules/**` và mọi tổ tiên của worker root tới gốc (trừ chính worker root) |
| `.claude/skills` của project (C10) | dừng ở repository root = worker root (git init P2b) — V26, R3: skill cha không thấy, skill của worker thấy |
| `.claude/settings.json` (hook/MCP của orchestrator) của project | không nằm ở worker root nên không được đọc (V26, R3: hook cha không chạy); `--strict-mcp-config` không kèm `--mcp-config` → không MCP nào. **Không** dùng `--setting-sources user`: nó ẩn luôn skill của chính worker (V26) |
| Skill/`CLAUDE.md` cấp user (`~/.claude`) | **Không chặn được** khi dùng đăng nhập thuê bao (`--bare` đòi API key — C8); ghi rõ như F6 của P2 (doctor đã cảnh báo skill cấp user) |

Mount skill của worker claude: bundle worker vào `<workerRoot>/.claude/skills` (thêm vào `workerOwnedPaths`, như `.agents/skills` ở P2b). omni không ghi `.claude/settings.json` vào worker root.

Bộ cờ cách ly (V26 + R3 đã chạy thật): `--strict-mcp-config --settings '{"claudeMdExcludes":[…]}'`, danh sách = với mỗi tổ tiên `d` của worker root tới `/`: `d/CLAUDE.md`, `d/CLAUDE.local.md`, `d/.claude/rules/**`.

---

## 4. Claude làm worker (P4b)

Theo đúng đường codex-làm-worker của P3c-3.

| Chỗ | Thay đổi |
|---|---|
| `worker-runtime.js` | `WORKER_RUNTIMES` thêm `claude`; `workerCommandFor('claude')` → `resolveClaudePath()`/`claude`; `buildWorkerInvocation` qua `claude.buildHeadless` (implement: worker root → `full-auto`, shared → `workspace-write`, khác → `read-only`; `--session-id` mới mỗi lượt); `extractWorkerPayload` qua `claude.parseResult`, ánh xạ lỗi về `DUAL_AGY_*`; `workerOutputSchema('claude')` bỏ `toolAction/toolSummary`, **không** strict hóa (C3, kiểm V24) |
| Probe worker | `capability-preflight` đã đi qua `defaultRegistry` (P3c-2) → tự có claude; `probeStandaloneCapability` thêm nhánh claude (version + auth thay cho danh sách model) |
| Discussion | `discussion/live-claude-invoke.js` (seed bằng `--session-id`, lượt sau `--resume`), `worker-slot.js` thêm nhánh claude: `provider: 'agy'`, read-only (`--tools Read,Grep,Glob,Skill`), cách ly §3 |
| `agy-model.workerConfigurationError` | model claude (`claude-*` hoặc alias) qua runtime claude: effort tùy chọn, hợp lệ theo C4 — tách luật theo runtime thay vì đoán theo tên model (luật `claude-*` hiện tại là của agy) |
| Bindings/setup | `engineSupport` nhận worker `claude`; `legacyManifestFields` ghi `workerRuntime: 'claude'` |
| Mount | `worker-mount` dùng `runtime.skillDirs()` của runtime worker thay cho `.agents/skills` cố định |

---

## 5. Claude làm orchestrator (P4c — chờ Q-P4-1)

| Chỗ | Thay đổi |
|---|---|
| `omni init`/`squad setup` | khi orchestrator = claude: ghi `.mcp.json` (server `omni_dual`), `.claude/settings.json` hook `PreToolUse/PostToolUse/SessionStart/UserPromptSubmit/Stop` gọi `omni-hook` (cùng bridge), skill/workflow `dual-controller` vào `.claude/skills` |
| `hook-bridge` | nhận payload hook của Claude Code (cùng khung `hook_event_name/tool_name/tool_input/session_id`, kiểm V28); tên tool shell của claude là `Bash`; luật chặn `omni squad approve` (P3d) phủ cả claude |
| Discussion `astra` | chỗ `codex` trong discussion lấy adapter theo runtime orchestrator: claude → `live-claude-invoke` với `provider: 'codex'` |
| `engineSupport` | orchestrator ∈ {codex, claude} |
| Interactive | `omni squad start` (hoặc hướng dẫn) mở `claude` với MCP/hook đã ghi |

---

## 6. Phải kiểm trước khi code (V22–V30)

| # | Cần kiểm | Cách |
|---|---|---|
| V22 | `claude auth status` ở terminal người dùng: JSON, `loggedIn`, `authMethod` khi đăng nhập thuê bao; vì sao shell sandbox báo `false` | người dùng chạy 1 lệnh |
| V23 | `claude -p --output-format json` thật: các field C2 (fixture), `session_id`, `usage` | 1 lượt rẻ (`--model haiku --effort low`, read-only) |
| V24 | `--json-schema`: nhận chuỗi hay cả đường dẫn file; schema evidence thật của dual (có field optional) có qua không; `structured_output` khớp zod | 1 lượt với schema thật |
| V25 | `--permission-mode plan` + `--permission-prompts none`: ghi file bị từ chối và hiện trong `permission_denials`; `acceptEdits` + `none`: Bash bị từ chối | 2 lượt trong thư mục tạm |
| V26 | Worker root lồng trong project có `CLAUDE.md` + `.claude/skills` + `.claude/settings.json` (hook): với cờ §3, claude **không** thấy chúng (hỏi claude liệt kê skill/instruction, kiểm hook không chạy) | thư mục tạm, 1–2 lượt |
| V27 | `--session-id <uuid>` rồi `--resume <uuid>` giữ ngữ cảnh; hai phiên claude song song cùng tài khoản không đăng xuất nhau (V7 cho claude, D18) | 2–3 lượt |
| V28 | Payload hook của Claude Code 2.1.316 (`PreToolUse`) và cách deny (`permissionDecision: deny`/exit 2) — khớp `hook-bridge` không | tài liệu + 1 hook thử trong thư mục tạm (chỉ P4c) |
| V29 | `full-auto` (`bypassPermissions`) trong worker root sửa được file và trả `structured_output` | lượt thật — **người dùng chạy** (bộ phân loại quyền đã chặn lệnh tương tự ở V19) |
| V30 | Claude làm orchestrator nhận MCP `omni_dual` từ `.mcp.json` + `--strict-mcp-config` không | tài liệu + 1 lượt (chỉ P4c) |
| V31 | Lấy danh sách model của claude không tương tác: `/model` trong `-p`, hoặc nguồn khác claude dùng cho `/model` (settings `availableModels`, cache trong `~/.claude`) | thử `claude -p "/model" --output-format json` + đọc tài liệu |

Kết quả ghi vào phụ lục spec này trước commit đầu của P4a/P4b/P4c tương ứng.

---

## 7. Câu hỏi mở

| # | Câu hỏi | Đề xuất |
|---|---|---|
| Q-P4-1 | Làm claude-làm-orchestrator (§5) ngay P4 hay để P5 cùng reviewer? | **Đã chốt 2026-11-01: ngay P4 (P4c).** |
| Q-P4-2 | Không chặn được skill/`CLAUDE.md` cấp user khi đăng nhập thuê bao: chấp nhận (doctor cảnh báo) hay yêu cầu `ANTHROPIC_API_KEY` để dùng `--bare`? | **Đã chốt: chấp nhận + doctor cảnh báo** (như F6). |
| Q-P4-3 | Lấy danh sách model claude thế nào (C12)? | **Người dùng: "claude có `/model`"** → lấy danh sách từ chính claude nếu chạy được không tương tác (V31); nếu không, danh sách tĩnh + cho gõ tên tự do (cảnh báo khi tên lạ). |
| Q-P4-4 | Worker claude ở shared mode: chỉ sửa file, không Bash (không chạy được test trong lượt implement) — chấp nhận? | **Đã chốt: chấp nhận**; khuyến nghị isolated cho worker claude. Thực thi bằng `--tools` không có Bash (R2) vì `acceptEdits` vẫn chạy Bash (V25). |

---

## 8. Sub-phase & commit

| Commit | Nội dung | Phụ thuộc |
|---|---|---|
| `feat(squad): Claude Code runtime adapter (P4a)` | §2 + §3 (cờ cách ly trong adapter) + conformance + fixture V23–V25/V31 (bỏ email/org khỏi fixture auth) + `omni squad runtimes` thấy claude | V22–V26, V31, R1–R3 ✓ |
| `feat(dual): Claude Code as the dual worker (P4b)` | §4 + mount `.claude/skills` + test e2e isolated với worker claude giả lập | P4a, V27, V29 |
| `feat(dual): Claude Code as the orchestrator (P4c)` | §5 (nếu Q-P4-1 = có) | P4b, V28, V30 |
| `test(squad): live P4 run with a Claude worker` | `test/squad-p3-live.js --worker claude` (+ `--orchestrator claude` nếu P4c) | P4b |

---

## 9. Test

- **P4a:** conformance cho claude (đủ bộ P1); `parseResult` trên fixture thật V23/V24 (success, structured_output, permission_denials → failed, subtype lỗi); `authStatus` trên JSON thật; `listModels` tĩnh; `permissionFlags` (full-auto chỉ isolatedRoot); cờ cách ly §3 có đủ `claudeMdExcludes` cho mọi tổ tiên.
- **P4b:** argv golden worker claude (isolated/shared/read-only); extract evidence thật → `EvidenceSchema`; agy/codex argv không đổi; `workerConfigurationError` theo runtime; e2e `runIsolatedTask` với worker claude giả lập (scout/review qua discussion stub, implement trả JSON claude); mount skill vào `.claude/skills` và `workerOwnedPaths`.
- **P4c:** init ghi `.mcp.json`/hook đúng; hook-bridge xử lý payload claude (fixture V28) và chặn `omni squad approve`; discussion astra claude.
- Toàn bộ: `npm test` + một lượt `--test-concurrency=4`.

---

## 10. Điều kiện xong P4 (DoD)

- [ ] `omni squad runtimes` thấy claude: version, đăng nhập, model.
- [ ] Conformance pass cho ba adapter codex, agy, claude.
- [ ] Vòng chạy thật **orchestrator codex + worker claude** qua daemon: cổng plan → 7 phase → QC → cổng integrate → `TASK_VERIFIED`.
- [ ] (P4c) Vòng chạy thật **orchestrator claude + worker agy hoặc codex**.
- [ ] Worker claude không đọc `CLAUDE.md`/skill/hook của project (V26 trong vòng chạy thật).
- [ ] `npm test` xanh trên macOS + một lượt dưới tải.
- [ ] Phụ lục V22–V31 đã ghi.

---

## Phụ lục A — kết quả V22–V27, V31, R1–R3 (2026-11-01, claude 2.1.316, người dùng chạy ở terminal của họ, model `haiku`, effort `low`)

| # | Kết quả |
|---|---|
| V22 ✓ | `claude auth status` exit 0, JSON `loggedIn: true`, `authMethod: "claude.ai"`, `apiProvider: "firstParty"`, `subscriptionType`. JSON có email/org → fixture phải bỏ. `claude --version` = `2.1.316 (Claude Code)`. |
| V23 ✓ | `-p --output-format json`: một object `type: "result"`, `subtype: "success"`, `is_error`, `session_id`, `result`, `num_turns`, `stop_reason`, `total_cost_usd`, `usage` (`input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`, cache…), `modelUsage` (có cả model phụ, vd. `claude-sonnet-5-5` cạnh `claude-haiku-5-5`), `permission_denials`. |
| V24 ✓ | `--json-schema` nhận **chuỗi** schema evidence thật (không strict): `structured_output` có mặt, qua `EvidenceSchema` zod. Đường dẫn file → exit 1 `--json-schema is not valid JSON`. |
| V25 ⚠ | `plan` + `--permission-prompts none`: không ghi file nhưng `permission_denials` rỗng, và ghi một file plan vào `~/.claude/plans`. `acceptEdits` + `none`: ghi file **và chạy Bash** (`bash.txt` có). → bỏ cách giới hạn bằng permission mode, dùng `--tools` (C14). |
| V26 ✓/⚠ | Worker root lồng trong project (git root riêng): `claudeMdExcludes` chặn `CLAUDE.md` cha (lượt đối chứng không cờ thì đọc). Skill cha và hook cha không thấy ngay cả không cờ. `--setting-sources user` ẩn luôn skill của worker → bỏ. |
| V27 ✓ | `--session-id <uuid>` được giữ; `--resume <uuid>` nhớ ngữ cảnh. Hai phiên song song cùng tài khoản đều success, `session_id` khác nhau, sau đó vẫn `loggedIn: true`. |
| V31 ✓ | `claude -p /model --output-format json`: `result` = `Current model: … Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.`, cost 0, ~40 ms. |
| R1 ✓ | `--tools Read,Grep,Glob`: đọc được, không tạo file nào, không chạy Bash, không thêm file plan; claude trả lời rằng Write/Bash không có. `permission_denials` rỗng. |
| R2 ✓ | `--permission-mode acceptEdits --tools Read,Grep,Glob,Edit,Write`: `edit.txt` được tạo, `bash.txt` không. |
| R3 ✓ | Không `--setting-sources`, chỉ `--tools Read,Grep,Glob,Skill --strict-mcp-config --settings {claudeMdExcludes: tổ tiên}`: worker-skill **có**, parent-skill không, không dòng MARKER nào từ `CLAUDE.md` cha, hook cha không chạy. |

Còn lại: V28, V30 (trước P4c); V29 `bypassPermissions` thật trong worker root (người dùng chạy, trước P4b live). Fixture: `test/fixtures/squad-cli/claude-*.json` lấy từ các lượt trên.

