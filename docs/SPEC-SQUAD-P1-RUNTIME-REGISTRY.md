# Spec — Squad P1: Runtime registry (adapter codex + agy, probe, conformance)

> Ngày: 2026-10-31 · Nhánh: `3.2.0` · Trạng thái: **spec để code**, chia 2 sub-phase (P1a, P1b), mỗi sub-phase một commit.
> Căn cứ: [`SQUAD-ARCHITECTURE-PLAN.md`](SQUAD-ARCHITECTURE-PLAN.md) §4 (Runtime adapter), §10 (P1), các quyết định D2, D3, D12, D15 (B4).
> Dữ kiện CLI trong spec này được đo trên máy dev ngày 2026-10-31: `codex-cli 0.147.0`, `agy 1.4.7`. Mục §14 liệt kê những gì phải kiểm lại trước khi code.

---

## 0. Mục tiêu & phạm vi

### 0.1 Mục tiêu

1. Có **một registry runtime duy nhất** (`lib/squad/runtimes/`), mỗi CLI một adapter, cùng một hợp đồng được validate bằng `zod`.
2. Hai adapter đầu tiên: **codex** và **agy**.
3. Gom toàn bộ phần **phát hiện / probe** (đường dẫn binary, version, đăng nhập, danh sách model) về registry, chạy được trên **macOS, Windows, Linux**.
4. Builder invocation **chung** (`buildHeadless`, `buildResume`, `interactiveCommand`, `permissionFlags`) để P3 (pipeline khai báo) dùng.
5. Bộ **conformance test** mà mọi adapter (kể cả OpenCode ở P4) phải qua.
6. Lệnh `omni squad runtimes` cho người dùng xem ngay: CLI nào có, version, đã đăng nhập chưa, có model nào — đúng "bước 3" của luồng init mong muốn.

### 0.2 Ngoài phạm vi P1

| Việc | Pha |
|---|---|
| Role definition, bundle skill, `mountSkills`, gitignore `.omni/squad/` | P2 |
| Pipeline khai báo, đổi `owner` → role, **chuyển các builder argv cũ của dual/harness sang `buildHeadless`** | P3 |
| Adapter OpenCode | P4 |
| `readTranscript`, `writeMcpConfig`, PTY | P2/P6 |
| Init hỏi binding theo vai | P2 (dùng `eligibleFor` của P1) |

> **Điều chỉnh so với bản kiến trúc §10-P1:** P1 chỉ gộp phần *phát hiện/probe*. Phần *dựng argv* của các call site hiện có (`buildAgyInvocation`, `live-*-invoke`, `host-cli.buildCommand`) **giữ nguyên** ở P1 và chuyển sang builder chung ở P3, khi pipeline thay máy trạng thái. Lý do: các argv đó gắn chặt ngữ nghĩa phase của dual (input path, retry hint, schema, conversation), đổi sớm chỉ tạo churn và rủi ro hồi quy mà chưa có người dùng builder chung.

### 0.3 Bất biến

- **Không đổi hành vi dual/harness hiện tại.** Mọi hàm legacy được giữ tên, chữ ký và kết quả (test cũ không sửa assertion).
- Adapter **chỉ dựng invocation, không spawn** việc thật. Spawn việc thật vẫn do các runner có lease/watchdog/scope-guard. Riêng probe (`--version`, `models`, `login status`) spawn qua `spawn-bounded.js`.
- Mọi spawn: `shell: false`, args dạng mảng, có timeout và trần output.
- CommonJS, `node:test`, không thêm dependency ở P1 (`yaml` vào ở P2).

---

## 1. Bố cục module

```
lib/squad/
  runtimes/
    index.js            — export registry mặc định (đã đăng ký codex, agy) + tiện ích
    contract.js         — schema zod, defineRuntime(), SquadRuntimeError
    registry.js         — createRegistry(): register/get/list/eligibleFor/probeAll
    resolve-binary.js   — dò binary đa OS (PATH, PATHEXT, npm cmd-shim)
    spawn-bounded.js    — spawnBoundedProcess (DI CHUYỂN từ lib/dual/capability-preflight.js)
    families.js         — modelFamily(modelId) theo tiền tố
    codex.js            — adapter codex
    agy.js              — adapter agy
lib/commands/squad.js   — handler `omni squad runtimes`
```

Chiều phụ thuộc: `lib/dual/*` và `lib/harness/*` **được phép** require `lib/squad/runtimes/*`; `lib/squad/*` **không được** require `lib/dual/*` hay `lib/harness/*` (tránh vòng require CommonJS). Test conformance kiểm điều này bằng cách grep require trong `lib/squad/`.

---

## 2. Hợp đồng adapter (`contract.js`)

### 2.1 Descriptor

```js
// Mỗi adapter export: module.exports = defineRuntime({ ... })
{
  id: 'codex',                       // /^[a-z][a-z0-9-]{1,31}$/
  displayName: 'Codex CLI',
  binary: {
    name: 'codex',                   // tên tìm trên PATH
    envOverride: 'OMNI_CODEX_PATH',  // biến môi trường ghi đè đường dẫn
    extraCandidates: (ctx) => [...], // đường dẫn ưu tiên thêm (vd. ~/.local/bin/codex)
  },
  capabilities: {                    // tất cả boolean, bắt buộc đủ key
    interactive, mcp, hooks, headless, write, resume,
    structuredOutput, transcript, sandbox, usage, multiModel,
  },
  efforts: ['low', 'medium', 'high', 'xhigh'] | null,  // null = runtime không có khái niệm effort

  // Probe (async, nhận ProbeContext, KHÔNG throw — lỗi trả trong kết quả)
  detect(ctx)     → DetectResult
  version(ctx)    → VersionResult
  authStatus(ctx) → AuthResult
  listModels(ctx) → ModelsResult

  // Builder (sync, thuần, throw SquadRuntimeError khi input sai)
  buildHeadless(turn, ctx)            → Invocation
  buildResume(sessionRef, turn, ctx)  → Invocation     // bắt buộc nếu capabilities.resume
  interactiveCommand(binding, ctx)    → Invocation     // bắt buộc nếu capabilities.interactive
  permissionFlags(profile, opts)      → string[]

  // Tùy chọn — khai báo ở P1 nhưng chưa cài; capability tương ứng phải là false
  mountSkills?, writeMcpConfig?, readTranscript?
}
```

**Luật capability ⇔ method** (conformance §11.1 kiểm): `resume:true` ⇒ có `buildResume`; `interactive:true` ⇒ có `interactiveCommand`; `transcript:true` ⇒ có `readTranscript`. Ở P1, codex và agy khai `transcript:false` (cài ở P6) — capability chỉ được bật khi method đã có.

### 2.2 Kiểu dữ liệu

```js
ProbeContext = {
  env, homedir, platform,            // mặc định process.env / os.homedir() / process.platform
  fsImpl,                            // { existsSync, statSync, readFileSync } — tiêm cho test
  spawnImpl,                         // cho spawn-bounded — tiêm cho test
  timeoutMs = 15_000, maxOutputBytes = 64 * 1024,
  cwd,                               // thư mục chạy probe (mặc định os.tmpdir())
  resolved,                          // DetectResult đã có (tránh dò lại)
}

DetectResult  = { found: true,  command, prefixArgs: string[], path, source: 'env'|'candidate'|'path'|'shim' }
              | { found: false, code, reason, searched: string[] }
VersionResult = { ok: true, version: string, raw } | { ok: false, code, reason }
AuthResult    = { state: 'authenticated'|'unauthenticated'|'unknown', method: string|null, evidence: string }
ModelsResult  = { ok: true, source: 'cli'|'cache'|'none', models: ModelInfo[], note?: string }
              | { ok: false, code, reason }
ModelInfo     = { id, label, family, efforts: string[] | null, defaultEffort: string | null }

HeadlessTurn = {
  prompt: string,                    // bắt buộc, ≤ 256 KiB; truyền nguyên văn làm 1 phần tử argv
  cwd: string,                       // tuyệt đối
  model: string, effort?: string,
  permission: 'read-only' | 'workspace-write' | 'full-auto',
  isolatedRoot?: boolean,            // bắt buộc true khi permission === 'full-auto' (B4)
  outputFormat?: 'text' | 'json',    // mặc định 'json'
  jsonSchemaPath?: string,           // tuyệt đối, nằm trong cwd hoặc addDirs
  addDirs?: string[],
  timeoutMs: number,                 // > 0
}
Invocation = { command, args: string[], cwd, timeoutMs, env?: object, redactedArgs: string[] }
```

`redactedArgs`: bản sao `args` với phần tử prompt thay bằng `<prompt:${bytes}B:${sha256-12}>` — dùng cho log/ledger, không lưu prompt thô.

### 2.3 Lỗi

`class SquadRuntimeError extends Error { code }`, các mã:

| Mã | Khi nào |
|---|---|
| `SQUAD_RUNTIME_INVALID_DESCRIPTOR` | `defineRuntime` nhận descriptor sai schema / vi phạm luật capability ⇔ method |
| `SQUAD_RUNTIME_DUPLICATE` | đăng ký trùng `id` |
| `SQUAD_RUNTIME_UNKNOWN` | `get(id)` không có |
| `SQUAD_RUNTIME_BAD_TURN` | `HeadlessTurn` sai schema (cwd tương đối, timeout ≤ 0, model rỗng, effort ngoài `efforts`…) |
| `SQUAD_RUNTIME_UNSAFE_PERMISSION` | `full-auto` mà `isolatedRoot !== true` |
| `SQUAD_RUNTIME_PERMISSION_UNSUPPORTED` | runtime không có cách thực thi profile quyền được yêu cầu (vd. agy `workspace-write` ở headless) |
| `SQUAD_RUNTIME_CAPABILITY_MISSING` | gọi `buildResume`/`interactiveCommand` trên runtime không hỗ trợ |

Mã lỗi probe (trả trong kết quả, không throw): `SQUAD_RUNTIME_NOT_FOUND`, `SQUAD_RUNTIME_WINDOWS_SHIM`, `SQUAD_RUNTIME_PROBE_TIMEOUT`, `SQUAD_RUNTIME_PROBE_FAILED`, `SQUAD_RUNTIME_PARSE_FAILED`.

---

## 3. Dò binary đa OS (`resolve-binary.js`)

```js
resolveBinary(descriptor.binary, ctx) → DetectResult
```

Thứ tự ứng viên (dừng ở ứng viên đầu tiên **tồn tại và là file**):

1. `env[envOverride]` nếu là chuỗi không rỗng sau `trim()` → `source: 'env'`. Nếu đặt mà không tồn tại → **không** rơi xuống tiếp, trả `found:false, code: SQUAD_RUNTIME_NOT_FOUND, reason: 'override path missing'` (ghi đè sai phải lộ ra, không âm thầm dùng binary khác).
2. `extraCandidates(ctx)` theo thứ tự → `source: 'candidate'`.
3. Duyệt `env.PATH` (tách bằng `path.delimiter` của `ctx.platform`) → `source: 'path'`.
   - POSIX: thử `dir/name`.
   - Windows: thử `dir\name` + từng đuôi trong `env.PATHEXT` (mặc định `.COM;.EXE;.BAT;.CMD`), không phân biệt hoa thường.

**Windows `.cmd`/`.bat` (npm cmd-shim):** Node không cho spawn `.cmd`/`.bat` với `shell:false` (EINVAL). Khi ứng viên là `.cmd`/`.bat`:
- Đọc file (≤ 16 KiB), tìm dòng gọi node dạng npm cmd-shim: `"%_prog%"  "%dp0%\<rel>.js" %*` hoặc `node "%~dp0\<rel>.js" %*`.
- Nếu tìm được và `<dp0>\<rel>.js` tồn tại → `command = process.execPath`, `prefixArgs = [<abs>.js]`, `source: 'shim'`.
- Nếu shim trỏ tới `.exe` thật → dùng `.exe` đó.
- Không phân giải được → `found:false, code: SQUAD_RUNTIME_WINDOWS_SHIM`, kèm `reason` gợi ý đặt `OMNI_<X>_PATH` trỏ tới `.exe`/`.js`.
- **Không bao giờ** chuyển sang `shell:true`.

`prefixArgs` được mọi builder chèn **trước** args của adapter (cơ chế giống `agyPrefixArgs` hiện có).

`extraCandidates` của từng adapter:

| Adapter | extraCandidates |
|---|---|
| codex | `~/.local/bin/codex`, `~/bin/codex`, `<CODEX_HOME|~/.codex>/packages/standalone/current/bin/codex` (POSIX); `<CODEX_HOME|%USERPROFILE%\.codex>\packages\standalone\current\bin\codex.exe`, `%APPDATA%\npm\codex.cmd` (Windows) — xem Phụ lục V3 |
| agy | `~/.local/bin/agy`, `~/bin/agy` (POSIX); `%LOCALAPPDATA%\agy\bin\agy.exe` (Windows) — xem Phụ lục V4 |

---

## 4. Probe theo adapter

Mọi probe chạy qua `spawnBoundedProcess(command, [...prefixArgs, ...args], { cwd, env, timeoutMs, maxOutputBytes, spawnImpl })`.

### 4.1 codex

| Probe | Lệnh / nguồn | Diễn giải |
|---|---|---|
| version | `codex --version` | stdout khớp `/codex-cli\s+(\d+\.\d+\.\d+\S*)/` |
| authStatus | `codex login status` | exit 0 + stdout chứa `Logged in` → `authenticated`, `method` = phần sau `using ` (vd. `ChatGPT`); exit ≠ 0 + chứa `Not logged in` → `unauthenticated`; còn lại → `unknown` |
| listModels | đọc `<CODEX_HOME|~/.codex>/models_cache.json` (≤ 1 MiB) | `models[].slug` → `id`, `display_name` → `label`, chỉ lấy `visibility === 'list'`; `efforts` = `supported_reasoning_levels[].effort` **của từng model** (khác nhau theo model, vd. `low…ultra` hoặc `low…xhigh`), `defaultEffort` = `default_reasoning_level`. Không có file → `{ ok:true, source:'none', models:[], note:'chạy codex một lần để tạo cache' }` |

### 4.2 agy

| Probe | Lệnh | Diễn giải |
|---|---|---|
| version | `agy --version` | stdout khớp `/(\d+\.\d+\.\d+\S*)/` (giữ tương thích `parseAgyVersionOutput`) |
| authStatus | `agy models` | agy **không có** lệnh login/status (đã kiểm `agy --help` 1.4.7). Exit 0 và ≥ 1 model → `authenticated` (`method: 'inferred:models'`; nếu env có `GEMINI_API_KEY` thì `method: 'api-key'`); exit ≠ 0 với stderr khớp `/please sign in\|authentication required\|not signed in/i` → `unauthenticated` (fix: `chạy agy không tham số để đăng nhập`); stderr khớp `/keyring is locked/i` → `unknown` (fix: `mở khóa keyring của hệ điều hành`); còn lại → `unknown`. Xem Phụ lục V5 |
| listModels | `agy models` | bỏ dòng `Fetching available models...`; mỗi dòng `id<TAB>label`; thử JSON trước (giữ nhánh JSON của `parseAgyModelsOutput`) |

`agy models` gọi mạng — `authStatus` và `listModels` **dùng chung một lần spawn** khi được gọi qua `probeAll` (cache trong ProbeContext theo `runtimeId`).

**Effort của agy:** cờ `--effort` nhận `low|medium|high|xhigh|max` (đã kiểm `agy --help`). Một số id model đã chứa mức (`gemini-3.8-flash-high`). `ModelInfo.efforts` của agy = `['low','medium','high','xhigh','max']` cho mọi model ở P1; việc model nào thực sự tôn trọng `--effort` ghi ở câu hỏi mở Q2.

---

## 5. Builder invocation & ánh xạ quyền

### 5.1 `permissionFlags(profile, { isolatedRoot })`

| profile | codex | agy |
|---|---|---|
| `read-only` | `['-s', 'read-only']` | `['--mode', 'plan']` |
| `workspace-write` | `['-s', 'workspace-write']` | **không hỗ trợ** → throw `SQUAD_RUNTIME_PERMISSION_UNSUPPORTED` |
| `full-auto` | `['--dangerously-bypass-approvals-and-sandbox']` | `['--mode', 'accept-edits', '--dangerously-skip-permissions']` |

- `full-auto` mà `isolatedRoot !== true` → throw `SQUAD_RUNTIME_UNSAFE_PERMISSION` (B4: chỉ trong worker root cô lập). Conformance kiểm `read-only` không bao giờ chứa chuỗi `dangerously`.
- **agy `workspace-write`:** ở headless, `--mode accept-edits` vẫn bị agy tự từ chối `write_file`, kể cả khi có `--new-project` (Phụ lục V6). Cách cấp quyền ghi có phạm vi duy nhất là luật `permissions.allow: ["write_file(<root>)"]` trong `~/.gemini/antigravity-cli/settings.json` (file toàn cục của người dùng). P1 **không** tự sửa file đó; worker agy tiếp tục chạy `full-auto` trong worker root cô lập như dual hiện tại. Việc omni có được quản lý luật này (có hỏi ý người dùng) để chốt ở P2 — câu hỏi mở Q4.
- Thêm mã lỗi `SQUAD_RUNTIME_PERMISSION_UNSUPPORTED` vào bảng §2.3 (runtime không có cách thực thi profile quyền đó).

### 5.2 `buildHeadless(turn)`

**codex:**
```
[...prefixArgs, 'exec', '--skip-git-repo-check', '--json',
 '-C', turn.cwd,
 '-m', turn.model,
 ...(turn.effort ? ['-c', `model_reasoning_effort="${turn.effort}"`] : []),
 ...permissionFlags(turn.permission, turn),
 ...turn.addDirs.flatMap((d) => ['--add-dir', d]),
 ...(turn.jsonSchemaPath ? ['--output-schema', turn.jsonSchemaPath] : []),
 turn.prompt]
```
`outputFormat: 'text'` → bỏ `--json`.

**agy:**
```
[...prefixArgs,
 '-p', turn.prompt,
 '--output-format', turn.outputFormat ?? 'json',
 '--model', turn.model,
 ...(turn.effort ? ['--effort', turn.effort] : []),
 ...permissionFlags(turn.permission, turn),
 '--add-dir', turn.cwd, ...turn.addDirs.flatMap((d) => ['--add-dir', d]),
 ...(turn.jsonSchemaPath ? ['--json-schema', turn.jsonSchemaPath] : []),
 '--print-timeout', `${Math.max(30, Math.floor((turn.timeoutMs - 30_000) / 1000))}s`]
```
`--print-timeout` thấp hơn timeout OS ít nhất 30 s (bài học trong `host-cli.js`: agy trả kết quả trước khi omni SIGKILL). Luôn `--add-dir cwd` (bài học SPEC-FIX-ANTIGRAVITY-WORKSPACE: agy bỏ qua cwd của shell).

### 5.3 `buildResume(sessionRef, turn)`

- codex: `[...prefixArgs, 'exec', 'resume', '--skip-git-repo-check', sessionRef, turn.prompt, '--json', '-m', turn.model, ...effort, ...resumeSandbox]` — thứ tự giống `live-codex-invoke.js` hiện tại. **`exec resume` không có `-C`, `-s`, `--add-dir`** (Phụ lục V2), nên:
  - quyền: `read-only`/`workspace-write` → `['-c', 'sandbox_mode="<mode>"']`; `full-auto` → `['--dangerously-bypass-approvals-and-sandbox']` (có trên resume);
  - `addDirs` → `['-c', 'sandbox_workspace_write.writable_roots=[...]']` (mảng TOML, mỗi phần tử là chuỗi JSON-escape);
  - thư mục làm việc lấy từ `Invocation.cwd` (cwd của tiến trình), không truyền cờ;
  - `jsonSchemaPath` → `--output-schema` (có trên resume).
- agy: `buildHeadless(turn)` + `['--conversation', sessionRef]`.
- `sessionRef` phải khớp `/^[A-Za-z0-9._:-]{1,128}$/`, sai → `SQUAD_RUNTIME_BAD_TURN`.

### 5.4 `interactiveCommand(binding)`

Chỉ dựng, chưa dùng tới P6:
- codex: `[...prefixArgs, '-m', model, ...effort-config, '-C', cwd]`
- agy: `[...prefixArgs, '--model', model, ...(effort ? ['--effort', effort] : []), '--add-dir', cwd]`

### 5.5 Capability khai báo ở P1

| | codex | agy |
|---|---|---|
| interactive | true | true |
| mcp | true | true |
| hooks | true | true |
| headless | true | true |
| write | true | true |
| resume | true | true |
| structuredOutput | true (`--output-schema`) | true (`--json-schema`) |
| transcript | false (P6) | false (P6) |
| sandbox | true (`-s`) | true (`--sandbox`) |
| usage | false | true (JSON có `usage.input_tokens/output_tokens`, Phụ lục V6) |
| multiModel | false | true (Gemini + Claude + GPT-OSS qua cùng CLI) |

---

## 6. Họ model (`families.js`)

`modelFamily(id)` theo tiền tố, không phân biệt hoa thường:

| Tiền tố | Họ |
|---|---|
| `gpt-`, `codex-`, regex `/^o\d/` | `openai` |
| `gemini-` | `google` |
| `claude-` | `anthropic` |
| `deepseek` | `deepseek` |
| `qwen` | `alibaba` |
| `gpt-oss-` | `openai-oss` (khớp trước `gpt-`) |
| khác | `unknown` |

Ví dụ thật: agy liệt kê `claude-sonnet-4-6` → họ `anthropic` dù runtime là agy (minh chứng D-“khác hệ tính theo model”). `unknown` → lớp trên (P5/UI) cảnh báo không xác minh được tính độc lập QC.

---

## 7. Registry (`registry.js`)

```js
createRegistry({ runtimes = [] } = {}) → {
  register(descriptor),                 // validate lại bằng defineRuntime; trùng id → SQUAD_RUNTIME_DUPLICATE
  get(id),                              // không có → SQUAD_RUNTIME_UNKNOWN
  list(),                               // descriptor đã đóng băng (Object.freeze sâu)
  eligibleFor(requirements),            // requirements: string[] tên capability; trả các id có đủ cờ khai báo
  async probe(id, ctx),                 // detect → version → authStatus → listModels; tuần tự, dừng khi detect fail
  async probeAll(ctx),                  // chạy song song giữa các runtime, tuần tự trong một runtime
}
```

`probe` trả `RuntimeReport`:

```js
{ id, displayName, detect, version, auth, models, capabilities,
  ready: detect.found && version.ok && auth.state === 'authenticated' && models.ok,
  problems: [{ code, message, fix }] }   // fix = gợi ý hành động cho người dùng
```

Gợi ý `fix` (tiếng Việt), ví dụ: `codex` chưa đăng nhập → `chạy: codex login`; không tìm thấy → `cài CLI hoặc đặt OMNI_CODEX_PATH`; Windows shim → `đặt OMNI_AGY_PATH trỏ tới agy.exe`.

`eligibleFor` ở P1 chỉ lọc theo **cờ khai báo**. P2 sẽ kết hợp với `RuntimeReport.ready` (probe thật) khi init hỏi binding theo vai.

`index.js` export `defaultRegistry` (đã register codex, agy) và `createRegistry`.

---

## 8. Lệnh `omni squad runtimes`

`bin/omni.js` thêm command `squad` với subcommand `runtimes`:

```
omni squad runtimes [--json] [--runtime <id>] [--timeout <ms>]
```

- Chạy `probeAll` (hoặc `probe(id)`), in bảng: runtime · trạng thái · version · đăng nhập · số model · vấn đề + cách sửa.
- `--json`: in `RuntimeReport[]` (không có màu, ổn định cho máy đọc).
- Exit code: `0` nếu ≥ 1 runtime `ready`; `1` nếu không runtime nào ready; `2` lỗi tham số.
- Không ghi file, không đổi cấu hình.

Handler ở `lib/commands/squad.js`, export qua `lib/commands/index.js` theo nếp các command khác.

---

## 9. Di chuyển `spawnBoundedProcess` (P1a)

- Chuyển nguyên văn thân hàm `spawnBoundedProcess` từ `lib/dual/capability-preflight.js:54` sang `lib/squad/runtimes/spawn-bounded.js`.
- `capability-preflight.js` thay định nghĩa bằng `const { spawnBoundedProcess } = require('../squad/runtimes/spawn-bounded');` và **giữ** nó trong `module.exports`.
- Các file đang require từ `capability-preflight` (`isolated-qc.js`, `private-dependencies.js`, `discussion/daemon-ports.js`, `orchestrator.js`) **không sửa** ở P1.
- Đây là thay đổi duy nhất vào file cũ trong P1a; test cũ phải xanh không sửa.

---

## 10. P1b — nối phần phát hiện/probe cũ vào registry

Nguyên tắc: hàm cũ giữ tên, chữ ký, kết quả; bên trong gọi registry. Test cũ không đổi assertion.

| File | Thay đổi | Giữ nguyên |
|---|---|---|
| `lib/dual/binary-paths.js` | `codexPathCandidates`/`agyPathCandidates` lấy danh sách từ `descriptor.binary.extraCandidates({ platform: 'linux', homedir })` + override env (cùng thứ tự hiện tại). Hàm legacy **ép `platform: 'linux'`** để danh sách không đổi khi test chạy trên Windows; dò đa OS thật chỉ có ở `detect()` mới | Fallback `/usr/bin/codex` (codex) và chuỗi trần `'agy'` (agy) của **hàm legacy**; `restoreCommands` không đổi |
| `lib/dual/capability-preflight.js` | Probe `agy --version` / `agy models` gọi `agy.version()` / `agy.listModels()` | `parseAgyModelsOutput`, `parseAgyVersionOutput` vẫn export, vẫn đúng như cũ (có thể cài lại bằng parser mới nhưng test cũ phải xanh) |
| `lib/dual/discussion/daemon-ports.js` | `defaultCodexProbe` dùng `codex.version()` + `codex.listModels()` | Hành vi “không có cache → chỉ dựa vào version” giữ nguyên |

Không đụng: `agy-runner.js`, `orchestrator.js`, `live-codex-invoke.js`, `live-agy-invoke.js`, `isolated-*`, `daemon-server.js`, `lib/harness/providers/*` (chuyển ở P3).

---

## 11. Test

### 11.1 `test/squad-runtime-conformance.test.js` — chạy cho **mọi** runtime trong `defaultRegistry`

1. Descriptor qua `defineRuntime` (schema zod) và đủ 11 key capability.
2. Luật capability ⇔ method (§2.1).
3. `buildHeadless` với turn hợp lệ: `args` là mảng chuỗi; prompt xuất hiện **đúng một lần, nguyên văn** (prompt chứa `"; rm -rf / $(x) \n` không bị tách/escape); `cwd` tuyệt đối; `redactedArgs` không chứa prompt.
4. Turn sai (cwd tương đối, timeout ≤ 0, model rỗng, effort ngoài `efforts`, prompt > 256 KiB) → `SQUAD_RUNTIME_BAD_TURN`.
5. `permissionFlags('read-only')` không chứa `dangerously`; `full-auto` thiếu `isolatedRoot` → `SQUAD_RUNTIME_UNSAFE_PERMISSION`.
6. `prefixArgs` từ DetectResult luôn đứng đầu `args`.
7. Probe với `spawnImpl` giả: timeout → `SQUAD_RUNTIME_PROBE_TIMEOUT`; output vượt trần → không treo; probe không bao giờ throw.
8. `lib/squad/**` không require `lib/dual/**` hay `lib/harness/**`.
9. **Live (skip mặc định):** khi `OMNI_SQUAD_LIVE=1` và `detect` thấy binary → chạy `probe` thật, kiểm `RuntimeReport` hợp schema. Không gọi `buildHeadless` thật.

### 11.2 Unit

- `test/squad-resolve-binary.test.js`: env override thắng; override sai không rơi xuống; extraCandidates trước PATH; PATH POSIX; PATH + PATHEXT Windows (fixture `platform:'win32'`); cmd-shim → `process.execPath` + `.js`; shim không phân giải → `SQUAD_RUNTIME_WINDOWS_SHIM`; không ứng viên → `searched` liệt kê đủ.
- `test/squad-runtime-codex.test.js`: parse version; 3 nhánh `login status`; parse `models_cache.json` (fixture rút gọn từ cấu trúc thật: `fetched_at`, `etag`, `client_version`, `models[].slug/display_name/visibility`); thiếu cache; argv golden cho `buildHeadless`/`buildResume`/`interactiveCommand`.
- `test/squad-runtime-agy.test.js`: parse `agy models` dạng TAB (fixture có dòng `Fetching available models...`) và dạng JSON; auth suy luận 3 nhánh; dùng chung 1 spawn cho auth + models trong `probeAll`; argv golden; `--print-timeout` ≥ 30 s và < timeout OS.
- `test/squad-families.test.js`: bảng §6, đặc biệt `gpt-oss-` trước `gpt-`.
- `test/squad-registry.test.js`: trùng id, unknown, `eligibleFor`, `probe` dừng sau detect fail, `ready` đúng.
- `test/squad-command.test.js`: `--json` hợp schema; exit code 0/1/2 với registry giả.

### 11.3 Hồi quy

`npm test` toàn bộ xanh, đặc biệt `dual-binary-paths`, `dual-capability-preflight`, `harness-providers`, `host-cli-antigravity` — **không sửa assertion** của các test này.

---

## 12. Commit

| Commit | Nội dung |
|---|---|
| `feat(squad): add runtime registry with codex and agy adapters (P1a)` | §1–§9 + test §11.1, §11.2; di chuyển `spawnBoundedProcess`; command `omni squad runtimes` |
| `refactor(dual): route binary and capability probes through squad registry (P1b)` | §10 + chạy lại §11.3 |

Kèm commit P1a: cập nhật `SQUAD-ARCHITECTURE-PLAN.md` §10-P1 theo điều chỉnh ở §0.2 (nếu chưa commit cùng spec).

---

## 13. Điều kiện xong P1 (DoD)

- [ ] `npm test` xanh; test cũ không đổi assertion.
- [ ] Conformance §11.1 pass cho codex và agy.
- [ ] `omni squad runtimes` trên máy dev macOS báo cả hai `ready` với version/model thật.
- [ ] Unit Windows (fixture `win32`) pass; nếu có máy Windows/Linux thật: chạy `omni squad runtimes` và ghi kết quả vào phụ lục spec.
- [ ] `lib/squad/**` không require `lib/dual/**`/`lib/harness/**`.
- [ ] Không thêm dependency.

---

## 14. Phải kiểm lại trước khi code (theo `CLAUDE.md`: tài liệu hiện hành, không dựa trí nhớ)

| # | Cần kiểm | Cách |
|---|---|---|
| V1 | Codex: `login status` ổn định qua các bản (0.147 → 0.164); tập giá trị `model_reasoning_effort` hợp lệ | Context7 / tài liệu Codex CLI; `codex exec --help` |
| V2 | Codex: `exec resume` chấp nhận `-C`, `-s`, `--output-schema` không; TUI gốc (`codex` không subcommand) nhận `-m`, `-c`, `-C` không | `codex exec resume --help`, `codex --help` |
| V3 | Codex trên Windows: npm cài ra `codex.cmd` trỏ tới `.js` hay `.exe` gốc | tài liệu cài đặt Codex; máy Windows nếu có |
| V4 | agy: đường cài mặc định trên Windows/Linux; có `agy.exe` không | tài liệu Antigravity CLI qua Context7 (`/google-antigravity/antigravity-cli`) |
| V5 | agy: thông điệp lỗi khi chưa đăng nhập (để phân loại `unauthenticated`) | thử trên máy đã đăng xuất hoặc tài liệu |
| V6 | agy: `--mode plan` có thật sự chặn ghi file không (ánh xạ `read-only`) | thử nghiệm có kiểm soát trong thư mục tạm |

Kết quả kiểm ghi vào phụ lục cuối spec này trước commit P1a.

---

## 15. Câu hỏi mở

| # | Câu hỏi | Đề xuất |
|---|---|---|
| Q1 | Bản kiến trúc ghi skill agy ở `.agents/skills/`, nhưng memory đã kiểm (2026-06-27) ghi `.agent/skills/` (số ít) | Không ảnh hưởng P1; phải chốt ở P2 trước khi cài `mountSkills` |
| Q2 | agy có cả `--effort` lẫn model id chứa mức (`…-flash-high`) — cái nào thắng? | P1 truyền cả hai như dual hiện tại; P2 đo và chốt |
| Q3 | `codex` có thể chạy model nhà khác qua `--oss` / `model_provider` | P1 coi codex `multiModel:false`; mở ở P4 nếu cần |
| Q4 | agy headless chỉ ghi được với `--dangerously-skip-permissions` hoặc luật `permissions.allow` trong file cấu hình toàn cục | P1 giữ `full-auto` trong worker root cô lập. P2 chốt: omni có được thêm luật `write_file(<worker root>)` (hỏi ý người dùng lúc init) để bỏ cờ nguy hiểm không |
| Q5 | agy soft-deny: exit 0, `status: SUCCESS` nhưng có `denied_actions` và response rỗng | P3 (`parseOutput`) phải coi `denied_actions` khác rỗng là thất bại có mã riêng, không phải thành công |

---

## Phụ lục — Kết quả kiểm V1–V6 (2026-10-31)

Máy kiểm: macOS (darwin, arm64), `codex-cli 0.147.0` (cài bản standalone), `agy 1.4.7`. Nguồn tài liệu qua Context7: `/openai/codex`, `/websites/antigravity_google_cli`.

| # | Kết quả | Ảnh hưởng tới spec |
|---|---|---|
| V1 | `codex login status`: đã đăng nhập → stdout `Logged in using ChatGPT`, exit 0; với `CODEX_HOME` trống → stdout `Not logged in`, exit 1. Mức effort **khác nhau theo model**, đọc được từ `models_cache.json` → `supported_reasoning_levels[].effort` (vd. `gpt-5.6-sol`: low, medium, high, xhigh, max, ultra; `gpt-5.5`: low…xhigh) và `default_reasoning_level`. Giá trị hợp lệ của `sandbox_mode`: `read-only`, `workspace-write`, `danger-full-access` (config schema của Codex). | §4.1: `efforts` lấy theo từng model thay vì danh sách cố định |
| V2 | `codex exec resume --help`: có `-m`, `-c`, `--json`, `--output-schema`, `--skip-git-repo-check`, `--dangerously-bypass-approvals-and-sandbox`; **không có** `-C`, `-s`, `--add-dir`. TUI gốc `codex` có `-m`, `-c`, `-s`, `-C`, `--add-dir`, `-a`. | §5.3: resume đặt sandbox qua `-c sandbox_mode=…`, cwd qua tiến trình. §5.4 giữ nguyên |
| V3 | Có hai kiểu cài Codex. **Standalone** (installer chính thức): macOS đã thấy `~/.local/bin/codex` → symlink tới `~/.codex/packages/standalone/current/bin/codex`; Windows (theo `install.ps1`) cài vào `<CODEX_HOME hoặc %USERPROFILE%\.codex>\packages\standalone`. **npm**: shim `codex.js` (chạy bằng node) tự tìm `vendor/<triple>/bin/codex.exe`; trên Windows npm sinh `codex.cmd` trỏ tới `codex.js`. Chưa kiểm được trên máy Windows thật: tên chính xác của thư mục `current` sau khi cài standalone. | §3: thêm ứng viên standalone, tôn trọng `CODEX_HOME`; cơ chế cmd-shim → `node codex.js` phù hợp |
| V4 | Theo tài liệu cài đặt: macOS/Linux → `~/.local/bin/agy`; Windows → `C:\Users\<user>\AppData\Local\agy\bin` (tức `%LOCALAPPDATA%\agy\bin\agy.exe`). | §3: sửa đường dẫn Windows của agy (bản trước ghi sai `Programs\agy`) |
| V5 | Chạy `agy models` với `HOME` tạm: stderr `Error: Please sign in to view available models. Launch the CLI without arguments to sign in.`, exit 1. Tài liệu headless: môi trường không có terminal thì báo `authentication required`. Tài liệu troubleshooting có thêm lỗi `failed to retrieve token: secret keyring is locked`. Đăng nhập bằng `GEMINI_API_KEY` (khi `modelProvider: "gemini"`) bỏ qua bước sign-in. | §4.2: regex phân loại `unauthenticated` / `unknown`, thêm `method: 'api-key'` |
| V6 | Ba lượt `agy -p` thật trong thư mục tạm, model `gemini-3.8-flash-low`, prompt yêu cầu tạo `probe.txt`: (1) `--mode plan` → không tạo file, model trả lời đã lập kế hoạch; (2) `--mode accept-edits` → không tạo file, JSON có `denied_actions: [write_file]`, stderr gợi ý thêm `permissions.allow` hoặc `--dangerously-skip-permissions`; (3) `--mode accept-edits --new-project` → kết quả như (2). Cả ba đều exit 0, `status: SUCCESS`. JSON output có `usage` (token). | §5.1: `read-only` → `--mode plan` đúng; agy `workspace-write` không hỗ trợ ở headless; §5.5 `usage: true`; thêm Q4, Q5 |

Tác dụng phụ của lượt kiểm: lượt (3) đăng ký thêm 1 project tạm vào `~/.gemini/config/projects/` của máy dev (12 → 13 mục). Thư mục tạm đã xóa; mục đăng ký chưa xóa, để người dùng quyết định.
