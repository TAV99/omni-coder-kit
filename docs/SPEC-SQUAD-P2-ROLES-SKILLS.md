# Spec — Squad P2: Vai, bộ skill theo vai, gắn CLI/model theo vai

> Ngày: 2026-11-01 · Nhánh: `3.2.0` · Trạng thái: **spec để code**, chia 3 sub-phase (P2a, P2b, P2c), mỗi sub-phase một commit.
> Căn cứ: [`SQUAD-ARCHITECTURE-PLAN.md`](SQUAD-ARCHITECTURE-PLAN.md) §3.2, §5, §8, các quyết định D1, D2, D7, D9, D10, D17, D18; nền tảng P1 ([`SPEC-SQUAD-P1-RUNTIME-REGISTRY.md`](SPEC-SQUAD-P1-RUNTIME-REGISTRY.md)).
> Dữ kiện CLI trong spec này lấy từ tài liệu chính thức qua Context7 ngày 2026-11-01 (`/openai/codex`, `/websites/antigravity_google_cli`, `/eemeli/yaml/v2.9.1`). Mục §13 liệt kê những gì phải chạy thử trước khi code.

---

## 0. Mục tiêu & phạm vi

### 0.1 Mục tiêu

1. Vai là **file khai báo YAML** trong `.omni/squad/roles/` (commit theo D9), validate bằng `zod`.
2. **Danh mục skill** `.omni/squad/skills.yaml` gán skill cho vai và cho phase; skill QC đi theo phase `qc`.
3. **Kho skill chuẩn** `.omni/skills/` là nơi duy nhất lưu nội dung skill; mỗi vai được **mount** (chép) đúng bộ của mình vào thư mục mà CLI của vai đó đọc.
4. Worker **không còn thấy skill của orchestrator**: sửa chỗ isolated-runner đang chép `.agents/skills` của project vào worker root.
5. `omni squad setup`: chọn preset, gắn CLI → model → effort cho từng vai bằng registry P1, lưu binding riêng từng người.
6. `omni skills doctor` bắt **skill trùng giữa các vai**, skill thiếu, skill lạ trong thư mục mount, và cảnh báo thư mục skill cấp người dùng.
7. Gitignore D10: `.omni/*` + `!.omni/squad/`, có di trú.

### 0.2 Ngoài phạm vi P2

| Việc | Pha |
|---|---|
| `pipeline.yaml`, đổi `owner` → vai, cổng D8, MCP `squad.next` | P3 |
| Engine dual chạy được worker không phải agy, orchestrator không phải codex | P3 (P2 lưu binding tổng quát nhưng đánh dấu chưa chạy được) |
| Vai reviewer chạy thật, root riêng của reviewer (D18 quy tắc 2) | P5 (P2 chỉ khai báo vai và bộ skill) |
| `readTranscript`, PTY, UI | P6 |
| Vai tự định nghĩa của người dùng | sau 3.2.0 |

### 0.3 Bất biến

- **Không xóa file người dùng.** Mọi thư mục skill omni mount đều có file đánh dấu; omni chỉ dọn thư mục có dấu của chính nó.
- **Không đổi `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`** để cô lập (thông tin đăng nhập nằm ở đó).
- Chế độ không squad (`ide` khác `squad`/`dual`) **không đổi hành vi**.
- Dual hiện tại chạy tiếp được: P2 vẫn ghi `manifest.workerModel/workerEffort` từ binding của worker khi worker là agy.
- `npm test` xanh trên macOS, kể cả lượt chạy dưới tải (`--test-concurrency=4`). Linux/Windows thật hoãn theo SQUAD-ARCHITECTURE-PLAN §11; test giả lập `win32` vẫn bắt buộc.

---

## 1. Dữ kiện đã kiểm (ảnh hưởng thiết kế)

| # | Dữ kiện | Nguồn | Hệ quả |
|---|---|---|---|
| F1 | agy đọc skill workspace ở **`.agents/skills/`**, skill toàn cục ở `~/.gemini/antigravity-cli/skills/` | tài liệu migrate Gemini CLI → Antigravity CLI | Đóng P1-Q1: dùng `.agents/skills` (memory cũ ghi `.agent/skills` là sai). |
| F2 | Codex đọc skill từ: `.agents/skills` **ở mọi thư mục từ cwd đi ngược lên project root**, `<repo>/.codex/skills`, `~/.agents/skills`, `~/.codex/skills` (cũ) | `codex-rs/ext/skills/src/host_roots.rs` | Worker root nằm **trong** repo (`.omni/runs/dual-workspaces/...`) → một worker codex sẽ thấy cả `.agents/skills` ở gốc repo. |
| F3 | Project root của Codex = tổ tiên đầu tiên có `project_root_markers` (mặc định `.git` có `HEAD`); `project_root_markers = []` **tắt việc đi ngược**, chỉ xét cwd; tầng project không ghi đè được key này, tầng session (`-c`) thì được | `codex-rs/config/src/project_root_markers.rs`, `loader/mod.rs` | Worker codex chạy với `-c project_root_markers=[]` → không thấy skill, `AGENTS.md`, `.codex/config.toml` (MCP `omni_dual`, hooks) của repo cha (D18 quy tắc 2). |
| F4 | isolated-runner chép worker root bằng `scan({ copying: true })`; danh sách loại trừ `CANONICAL_CONTROL_PLANE_EXCLUDES` có `.codex`, `.claude`, `.gemini`, `.agents/{worktrees,cache,logs,scratch,tmp}` nhưng **không có `.agents/skills`** | `lib/dual/task-workspace.js`, `lib/dual/snapshot-policy.js` | Hiện tại worker agy thấy toàn bộ ~52 skill của project. Phải loại `.agents/skills` khỏi bản chép worker. |
| F5 | `collectTaskResult` quét toàn bộ worker root (trừ `runtimePath`) rồi `assertAllowedDiff` | `lib/dual/task-workspace.js:323` | Skill mount vào worker root sẽ bị coi là "worker ghi ngoài phạm vi" → phải loại thư mục mount khỏi lượt quét kết quả. |
| F6 | Thư mục skill cấp người dùng (`~/.agents/skills`, `~/.codex/skills`, `~/.gemini/antigravity-cli/skills`, `~/.claude/skills`) được **mọi** vai dùng CLI đó thấy | F1, F2 | Không cô lập được nếu không đổi HOME (cấm). Doctor chỉ cảnh báo và chỉ ra đường dẫn. |
| F7 | `yaml` 2.9.1: `parseDocument` với `schema: 'core'`, `strict`, `uniqueKeys`, `stringKeys`, `merge: false`, `resolveKnownTags: false`; `toJS({ maxAliasCount: 0 })` cấm mọi alias | `/eemeli/yaml/v2.9.1` docs/03_options.md | Đủ để parse dữ liệu thuần, chặn alias bomb và tag tùy biến (D17). |

---

## 2. Bố cục file

```
.omni/squad/                      ← commit (D9, D10)
  roles/
    orchestrator.yaml
    worker.yaml
    reviewer.yaml
  skills.yaml                     ← danh mục skill theo vai/phase
.omni/skills/<name>/SKILL.md      ← kho skill chuẩn (ignore; tái tạo được từ skills-lock.json)
.omni/squad.local.json            ← binding của người dùng cho project này (ignore)
~/.omni/squad.json                ← binding dùng gần nhất, để gợi ý lần setup sau

templates/squad/                  ← bản mẫu omni phát hành (copy khi setup)
  roles/{orchestrator,worker,reviewer}.yaml
  skills.yaml

lib/squad/
  yaml.js                         ← parse YAML an toàn (F7)
  roles.js                        ← schema vai, nạp & validate
  skills-catalog.js               ← schema skills.yaml, tính bộ skill cho từng vai
  skill-store.js                  ← kho .omni/skills: import, hash, đọc
  mount.js                        ← mount / unmount / status theo marker
  bindings.js                     ← đọc/ghi binding, kiểm hợp lệ với registry
  setup.js                        ← luồng `omni squad setup`
lib/squad/runtimes/{codex,agy}.js ← thêm mountSkills, skillDirs; codex thêm cờ cô lập (§6)
lib/commands/squad.js             ← thêm `setup`, `skills`
lib/commands/doctor.js            ← thêm nhóm kiểm squad (§9)
lib/commands/helpers.js           ← ensureGitignore di trú D10 (§10)
lib/dual/task-workspace.js        ← loại thư mục skill khỏi bản chép và lượt quét kết quả (§7)
```

Chiều phụ thuộc giữ như P1: `lib/dual`, `lib/commands` được require `lib/squad`; `lib/squad` không require `lib/dual`/`lib/harness`.

---

## 3. Parse YAML an toàn (`lib/squad/yaml.js`)

```js
parseYamlFile(filePath, { maxBytes = 64 * 1024, fsImpl }) → plain object
```

- File > `maxBytes`, không phải file thường, hoặc là symlink → `SQUAD_CONFIG_INVALID`.
- `YAML.parseDocument(text, { schema: 'core', strict: true, uniqueKeys: true, stringKeys: true, merge: false, resolveKnownTags: false, prettyErrors: true })`.
- `doc.errors.length || doc.warnings.length` → `SQUAD_CONFIG_INVALID` kèm dòng/cột (cảnh báo cũng là lỗi: tag lạ chỉ sinh warning).
- `doc.toJS({ maxAliasCount: 0 })` (cấm alias). Kết quả phải là object thường, không phải mảng/scalar.
- Sau đó luôn validate bằng schema zod của từng loại file (§4, §5).
- Dependency mới: `yaml@^2.9.1` (bản ≥ 2 tuần tuổi tại 2026-11-01). Tra lại Context7 trước khi code (CLAUDE.md).

---

## 4. File vai (`.omni/squad/roles/<id>.yaml`)

### 4.1 Schema (zod, `strict`)

```yaml
schema_version: 1
id: worker                      # /^[a-z][a-z0-9-]{1,31}$/, khớp tên file
description: Scout, implement, correction trong worker root cô lập
cardinality: "1..N"             # "1" | "0..1" | "1..N"
phases: [scout, implement, correction]   # phase vai giữ mặc định; qc xử lý ở §5.3
permission: full-auto-isolated  # interactive | read-only | full-auto-isolated  (hai giá trị sau khớp §5.1 spec P1)
requires: [headless, write]     # tên capability của registry P1
optional: [resume, structuredOutput]
root: isolated                  # project | isolated  (orchestrator = project; worker = isolated; reviewer = isolated, chạy ở P5)
```

- `requires`/`optional` phải là tên trong `CAPABILITY_KEYS` của P1.
- `permission: full-auto-isolated` bắt buộc đi với `root: isolated` (B4).
- `permission: interactive` nghĩa là CLI chạy tương tác với người dùng và tự hỏi quyền theo cơ chế của nó; omni không dựng cờ quyền. Chỉ hợp lệ với `root: project`. Orchestrator dùng giá trị này, vì nó phải ghi spec/plan nhưng mọi thao tác ghi đều qua bước duyệt của người dùng.
- `id` trùng tên file; không có hai file cùng `id`.
- Ba vai bắt buộc có trong P2: `orchestrator` (`cardinality: "1"`, `root: project`), `worker` (`"1..N"`, `isolated`), `reviewer` (`"0..1"`, `isolated`).

### 4.2 Bản mẫu omni phát hành (`templates/squad/roles/`)

| Vai | phases | permission | requires | root |
|---|---|---|---|---|
| orchestrator | `spec`, `plan`, `integrate` | `interactive` | `interactive`, `mcp` | project |
| worker | `scout`, `implement`, `correction` | `full-auto-isolated` | `headless`, `write` | isolated |
| reviewer | (nhận `qc` theo §5.3) | `read-only` | `headless` | isolated |

`omni squad setup` chép bản mẫu khi project chưa có file; **không ghi đè** file đã có (người dùng có thể đã sửa). `--update-templates` hiện diff và hỏi trước khi thay.

---

## 5. Danh mục skill (`.omni/squad/skills.yaml`)

### 5.1 Schema

```yaml
schema_version: 1
shared_core: [karpathy-guidelines, verification-before-completion]
roles:
  orchestrator: [om-think, om-spec, om-plan, ...]
  worker: [om-cook, om-fix, ...]
  reviewer: []
phases:
  qc: [om-check, om-pass, requesting-code-review]
stack:                       # skill theo công nghệ; mặc định cho worker
  worker: [vitest, react-state-management]
exclude: [using-superpowers, find-skills, subagent-driven-development, using-git-worktrees, writing-skills]
```

### 5.2 Bản mẫu mặc định (từ SQUAD-ARCHITECTURE-PLAN §5.1, bổ sung các skill `om-*`)

| Nhóm | Skill |
|---|---|
| shared_core | karpathy-guidelines, verification-before-completion |
| orchestrator | om-think, om-spec, om-plan, om-go, om-scan, om-map, om-memo, om-skill, om-doc, om-ship, brainstorming, writing-plans, dispatching-parallel-agents, receiving-code-review, api-and-interface-design, documentation-and-adrs, context-engineering, git-workflow-and-versioning, shipping-and-launch, deprecation-and-migration, ci-cd-and-automation, finishing-a-development-branch |
| worker | om-cook, om-fix, test-driven-development, systematic-debugging, executing-plans, source-driven-development |
| phases.qc | om-check, om-pass, requesting-code-review |
| stack.worker | do `omni squad setup` điền từ `detectDNA` + danh mục `lib/skills.js` (UI → frontend-ui-engineering, tailwind-design-system…; test → vitest, javascript-testing-patterns…); ghi tường minh vào file để mọi máy giống nhau |
| exclude | using-superpowers, find-skills, subagent-driven-development, using-git-worktrees, writing-skills |

### 5.3 Tính bộ skill của một vai

```
bundle(role) = shared_core
             ∪ roles[role]
             ∪ (role === 'worker' ? stack.worker : stack[role] ?? [])
             ∪ ⋃ phases[p]  với mọi phase p mà vai đang giữ
             − exclude
```

- Phase `qc`: nếu binding có reviewer → `qc` thuộc reviewer; không có → thuộc orchestrator. P3 sẽ lấy chủ phase từ `pipeline.yaml`; P2 dùng luật này (khớp D5 và §3.2 kiến trúc).
- Hàm thuần: `resolveBundles({ catalog, roles, bindings }) → { orchestrator: Set, worker: Set, reviewer?: Set, owners: Map<skill, role[]> }`.

### 5.4 Luật chống chồng chéo (doctor, §9)

- Skill nằm trong `bundle` của ≥ 2 vai mà không thuộc `shared_core` → **lỗi** `SQUAD_SKILL_OVERLAP` (in tên skill và các vai).
- Skill trong danh mục mà không có trong kho `.omni/skills` → **lỗi** `SQUAD_SKILL_MISSING`.
- Skill có trong cả `exclude` và một vai → **lỗi** (danh mục tự mâu thuẫn).

---

## 6. Kho skill và mount

### 6.1 Kho `.omni/skills/`

- Mỗi skill: `.omni/skills/<name>/SKILL.md` (+ file phụ). Validate theo `docs/skill-anatomy.md` (tái dùng `validateSkillContent` của `lib/commands/doctor.js`).
- `skill-store.importFrom(dir)`: chép thư mục skill vào kho nếu tên chưa có; tên trùng nội dung khác → không ghi đè, báo `SQUAD_SKILL_CONFLICT`.
- `skill-store.hashOf(name)`: sha256 trên danh sách (đường dẫn tương đối, nội dung) đã sắp xếp — dùng cho marker và doctor.
- Nguồn nạp kho: (a) skill đang có trong thư mục skill của project (`.agents/skills`, `.claude/skills`) khi chạy setup lần đầu; (b) skill mới do `omni skills add` cài (lệnh này cài qua CLI `npx skills`, ghi thẳng vào thư mục skill của project): `omni squad skills sync` nhập chúng vào kho trước khi mount — **thay đổi khi code P2b**, thay cho việc sửa `saveSkillFile`; (c) skill bundled `templates/bundled-skills` khi offline.

### 6.2 Adapter mount (bổ sung vào runtime P1)

Thêm vào descriptor (field tùy chọn đã có chỗ trong contract P1):

```js
skillDirs(rootKind) → string[]      // thư mục tương đối mà CLI đọc ở root đó
mountSkills({ root, skills, store, roleId }) → MountResult
```

| Runtime | skillDirs (project và isolated) | Ghi chú |
|---|---|---|
| codex | `.agents/skills` | Không dùng `.codex/skills`: `.codex/` đang bị loại khỏi bản chép worker và là nơi omni ghi config/hook |
| agy | `.agents/skills` | F1 |

Codex và agy dùng chung `.agents/skills`, nên ở **một** root chỉ được có **một** vai (đúng theo thiết kế: project root = orchestrator; mỗi worker một root).

### 6.3 Marker & quy tắc mount

- Mỗi skill mount: `<skillDir>/<name>/` + file `<skillDir>/<name>/.omni-squad-mount.json`:
  `{ schema_version: 1, role, skill, sha256, mounted_at }`.
- Mount = **chép file** (không symlink: `scan` của dual từ chối symlink; Windows cần quyền đặc biệt).
- Thư mục skill **không có marker** trong `skillDir` = skill "lạ" của người dùng: **không xóa, không ghi đè**; doctor cảnh báo `SQUAD_SKILL_UNMANAGED` vì nó lọt vào bộ skill của vai.
- `mount` là idempotent: skill có marker mà hash khác → thay; có marker mà không còn trong bundle → xóa thư mục đó (chỉ thư mục có marker hợp lệ của đúng `role`).
- Lần setup đầu, skill đang có ở `.agents/skills` được **import vào kho** rồi để nguyên chỗ cũ; setup hỏi một lần "chuyển N skill không thuộc vai orchestrator ra khỏi `.agents/skills`?" (mặc định có; `--yes` đồng ý). Khi chuyển: thư mục được **di chuyển** vào `.omni/skills/.displaced/<timestamp>/` (không xóa), in đường dẫn để khôi phục.

### 6.4 Cô lập worker codex (F2, F3)

- Khi `HeadlessTurn.isolatedRoot === true`, `codex.buildHeadless`/`buildResume` thêm `-c project_root_markers=[]`.
- Hệ quả: codex chỉ xét worker root làm project root → không thấy `.agents/skills`, `AGENTS.md`, `.codex/config.toml` của repo cha.
- agy: hành vi đi ngược thư mục cha **chưa rõ** → kiểm V8 (§13) trước khi code. Nếu agy cũng đi ngược, phương án dự phòng là đặt worker root ra ngoài repo — **dừng và hỏi người dùng** trước khi làm, vì đổi vị trí worker root chạm tới integrate/recovery.

---

## 7. Worker root: không chép skill của project, không tính skill mount là thay đổi

Sửa `lib/dual/task-workspace.js` (chỉ phần này của dual được đụng ở P2):

> **Ghi chú khi code P2c (2026-11-01):** (a) trường binding được đặt tên `workerOwnedPaths` (= `skillDirs` của adapter + `.git`), thay cho `roleSkillDirs`; (b) mọi thay đổi ở mục này **chỉ bật khi project có `.omni/squad/`**: project dual cũ giữ nguyên hành vi (vẫn chép `.agents/skills`, không `git init`); (c) cô lập và mount làm ngay trong `prepareTaskWorkspace`, **trước** khi isolated-runner chụp worker baseline, với marker không có dấu thời gian, nên skill mount là một phần của baseline: bước kiểm scope không thấy thay đổi, còn worker sửa skill mount thì vẫn bị bắt. `prepareCheckpointResume` (`lib/dual/checkpoint.js`) gọi lại cùng hàm `isolateWorkerRoot` để worker root của lần resume khớp baseline gốc; (d) bước dọn file tạm và quét checkpoint cũng bỏ qua `workerOwnedPaths`, vì nếu không, bước dọn sẽ xóa các thư mục rỗng mà `.git` cần.

1. Hằng `ROLE_SKILL_DIRS = ['.agents/skills']` (lấy từ hợp của `skillDirs('isolated')` của các adapter đã đăng ký, không viết cứng ở dual).
2. `excluded(file)` khi **chép** worker root: bỏ qua mọi đường dẫn dưới `ROLE_SKILL_DIRS`. Không sửa `CANONICAL_CONTROL_PLANE_EXCLUDES` (danh sách đó còn dùng cho baseline snapshot — đổi nó làm lệch định danh baseline của session đang chạy).
3. Binding mới có trường `roleSkillDirs` (ghi lúc prepare). `collectTaskResult` và `scan` của lượt quét kết quả bỏ qua các đường dẫn này (giống cách đang bỏ `runtimePath`).
4. `prepareTaskWorkspace` từ chối task có `allowedFiles`/`generatedOutputs` chồng lên `ROLE_SKILL_DIRS` (`DUAL_TASK_SCOPE_INVALID`: "task không được sở hữu thư mục skill của vai"). Muốn sửa nội dung skill thì sửa ở kho, ngoài luồng worker.
5. Sau khi chép và trước khi gọi worker, isolated-runner gọi `mountSkills({ root: workerRoot, skills: bundle(worker), roleId: 'worker-N' })`.
6. Binding cũ (không có `roleSkillDirs`) đọc như trước — resume session cũ không đổi hành vi.

Kiểm chứng bắt buộc (§12): task có worker root sau P2 chứa **đúng** bundle worker, không có skill orchestrator; integrate không báo ngoài phạm vi; `evidence()` của watchdog không tính skill mount là tiến độ.

---

## 8. Binding và `omni squad setup`

### 8.1 Binding (`.omni/squad.local.json`, schema zod)

```json
{
  "schema_version": 1,
  "preset": "dual",
  "roles": {
    "orchestrator": { "runtime": "codex", "model": "gpt-6.1-sol", "effort": "high" },
    "worker": [{ "id": "worker-1", "runtime": "agy", "model": "gemini-3.8-flash-high", "effort": "high" }],
    "reviewer": null
  },
  "probed": { "codex": "0.166.0", "agy": "1.4.12" },
  "updated_at": "2026-11-01T00:00:00Z"
}
```

- Preset `dual` = orchestrator + 1 worker; preset `squad` = orchestrator + 1..N worker + reviewer.
- `~/.omni/squad.json` lưu binding dùng gần nhất (theo preset) để gợi ý lần sau; **không** dùng thay binding của project.
- Kiểm hợp lệ khi đọc: runtime có trong registry; vai có đủ `requires`; model nằm trong `listModels` (nếu runtime có danh sách); effort thuộc `efforts` của model (codex: theo từng model, P1 V1).

### 8.2 Luồng setup

```
omni squad setup [--preset dual|squad] [--workers N] [--yes]
                 [--bind <vai>=<runtime>:<model>[:<effort>]]...   # không tương tác
```

1. `registry.probeAll()` một lần; in bảng như `omni squad runtimes`.
2. Chép bản mẫu vai + `skills.yaml` nếu chưa có (§4.2); điền `stack.worker` từ `detectDNA`.
3. Với từng vai theo preset: runtime ứng viên = `eligibleFor(role.requires)` ∩ runtime `ready`. Không còn ứng viên → dừng, in cách sửa (cài CLI / đăng nhập). Chọn runtime → model (từ `listModels`; codex/agy có danh sách) → effort (từ `efforts` của model; gợi ý `defaultEffort`).
4. Cảnh báo theo D18: ≥ 2 vai cùng runtime → "chung tài khoản và quota"; orchestrator và reviewer cùng họ model → cảnh báo; reviewer cùng họ với worker → cảnh báo mạnh (họ model theo `modelFamily` P1).
5. Engine dual hiện tại chỉ chạy được orchestrator = codex, worker = agy. Binding khác vẫn được lưu nhưng `setup` in rõ "chưa chạy được bằng `omni dual` cho tới P3", và `omni dual` từ chối với mã `SQUAD_BINDING_ENGINE_UNSUPPORTED`.
6. Ghi `.omni/squad.local.json`, cập nhật `~/.omni/squad.json`; nếu worker-1 là agy: ghi `manifest.workerModel/workerEffort` (dual cũ đọc hai trường này).
7. Di trú gitignore (§10), nạp kho skill (§6.1), mount bundle orchestrator vào project root (§6.3).
8. Chạy nhóm kiểm squad của doctor (§9) và in kết quả.

### 8.3 Lệnh phụ

- `omni squad skills status`: bảng vai → số skill → đã mount/lệch/thiếu.
- `omni squad skills sync`: mount lại bundle orchestrator ở project root theo kho + danh mục (worker được mount tự động mỗi lần chạy task).

---

## 9. `omni skills doctor` — nhóm kiểm squad

Chỉ chạy khi có `.omni/squad/`. Mức lỗi làm `doctor` thoát mã khác 0.

| Mã | Mức | Điều kiện |
|---|---|---|
| `SQUAD_CONFIG_INVALID` | lỗi | YAML/schema của vai hoặc danh mục sai (kèm dòng/cột) |
| `SQUAD_SKILL_OVERLAP` | lỗi | §5.4 |
| `SQUAD_SKILL_MISSING` | lỗi | skill trong danh mục không có trong kho |
| `SQUAD_SKILL_DRIFT` | cảnh báo | skill đã mount có hash khác kho → gợi ý `omni squad skills sync` |
| `SQUAD_SKILL_UNMANAGED` | cảnh báo | thư mục skill không có marker trong thư mục mount của vai |
| `SQUAD_USER_SKILLS_GLOBAL` | cảnh báo | thư mục skill cấp người dùng của runtime đang được gán vai có skill (F6); in đường dẫn và số lượng, giải thích mọi vai dùng CLI đó đều thấy |
| `SQUAD_BINDING_INVALID` | lỗi | §8.1 |

Ví dụ thật trên máy dev: `~/.claude/skills` hiện có 52 skill → nếu sau này gán Claude Code cho một vai, doctor sẽ cảnh báo `SQUAD_USER_SKILLS_GLOBAL`.

---

## 10. Gitignore D10 (`ensureGitignore`)

- Mẫu mới: `.omni/*` và `!.omni/squad/` (thay cho `.omni/`).
- Project mới: ghi hai dòng mới.
- Project cũ: nếu dòng `.omni/` nằm **trong khối `# Omni-Coder Kit (generated)`** → thay bằng hai dòng mới, giữ nguyên phần còn lại của file. Nếu `.omni/` nằm ngoài khối (người dùng tự viết) → không sửa, in cảnh báo kèm hai dòng cần thay.
- Kiểm bằng `git check-ignore` trong test: `.omni/squad/roles/worker.yaml` không bị ignore; `.omni/skills/x/SKILL.md`, `.omni/squad.local.json`, `.omni/runs/a` bị ignore.

---

## 11. Câu hỏi đã chốt và còn mở

| # | Nội dung | Trạng thái |
|---|---|---|
| P1-Q1 | Thư mục skill của agy | **Đã chốt:** `.agents/skills` (F1) |
| Q4 (spec P1) | omni có thêm luật `permissions.allow: write_file(<worker root>)` vào `~/.gemini/antigravity-cli/settings.json` để bỏ `--dangerously-skip-permissions` không | **Đã chốt 2026-11-01 (người dùng): không.** omni không ghi vào file cấu hình toàn cục của agy; worker agy giữ `full-auto` trong worker root cô lập. Lý do: luật ở file toàn cục ảnh hưởng mọi phiên agy khác của người dùng và phải dọn khi worker root bị xóa |
| P1-Q2 | agy: `--effort` hay mức trong tên model (`…-flash-high`) thắng | **Đã chốt bằng V10:** không bên nào "thắng" — lệch nhau là lỗi cứng. Mức trong tên model là nguồn đúng; xem Phụ lục §6.6 |
| P2-Q1 | Có cho phép worker sửa nội dung skill qua task không | **Đề xuất: không** (§7 bước 4); sửa skill là việc của người dùng/orchestrator ở kho |

---

## 12. Test

### 12.1 Unit

- `test/squad-yaml.test.js`: alias (`&a`/`*a`) bị chặn; tag tùy biến (`!!js/function`, `!foo`) bị chặn; khóa trùng; khóa không phải chuỗi; merge key `<<`; file > 64 KiB; symlink; lỗi có dòng/cột.
- `test/squad-roles.test.js`: bản mẫu hợp lệ; `id` khác tên file; capability lạ; `full-auto-isolated` với `root: project` bị từ chối; thiếu vai bắt buộc.
- `test/squad-skills-catalog.test.js`: công thức §5.3 với/không reviewer (qc chuyển chủ); overlap → lỗi; shared_core không tính overlap; exclude mâu thuẫn.
- `test/squad-skill-store.test.js`: import, xung đột cùng tên khác nội dung, hash ổn định không phụ thuộc thứ tự đọc thư mục.
- `test/squad-mount.test.js`: mount idempotent; thay khi hash lệch; dọn chỉ thư mục có marker của đúng vai; **không chạm** thư mục không marker; displaced được di chuyển chứ không xóa; đường dẫn `win32` giả lập.
- `test/squad-bindings.test.js`: schema; runtime/model/effort không hợp lệ; cảnh báo D18; ghi `manifest.workerModel/workerEffort` khi worker là agy.
- `test/squad-setup.test.js`: luồng không tương tác `--bind`; không có runtime ready → dừng kèm cách sửa; không ghi đè file vai người dùng đã sửa.
- `test/squad-gitignore.test.js`: §10, gồm `git check-ignore` trong repo tạm (realpath thư mục tạm — bẫy macOS trong memory).
- Bổ sung `test/squad-runtime-codex.test.js`: `isolatedRoot: true` → có `-c project_root_markers=[]` ở cả headless và resume; `false` → không có.
- Bổ sung conformance P1: runtime khai `skillDirs` thì phải có `mountSkills`.

### 12.2 Dual (hồi quy + tính năng)

- `test/dual-task-workspace.test.js` (thêm case): source có `.agents/skills/a` → worker root không có `a`; sau mount có đúng bundle worker; `collectTaskResult` không thấy skill mount; task có `allowedFiles` dưới `.agents/skills` bị từ chối; binding cũ không có `roleSkillDirs` vẫn thu kết quả như trước.
- `test/dual-isolated-runner.test.js` (thêm case): watchdog `evidence()` không tính skill mount là tiến độ.
- `npm test` toàn bộ xanh; một lượt `--test-concurrency=4` xanh.

### 12.3 Live (skip mặc định, `OMNI_SQUAD_LIVE=1`)

- V8/V9 (§13) đóng gói thành test live để chạy lại khi CLI cập nhật.

---

## 13. Phải kiểm trước khi code

| # | Cần kiểm | Cách |
|---|---|---|
| V8 | agy chạy trong thư mục con có `--add-dir <con>` có thấy skill ở `.agents/skills` của **thư mục cha** không | Dựng cha/con trong thư mục tạm, mỗi nơi một skill có tên riêng; chạy `agy -p` (model rẻ nhất, `--mode plan`) hỏi danh sách slash command/skill đang có; xem tên skill của cha có xuất hiện không |
| V9 | `codex exec -c project_root_markers=[]` có thật sự không thấy `.agents/skills` của thư mục cha (repo có `.git`) | Tương tự V8 với codex, model rẻ nhất, `-s read-only` |
| V10 | agy: `--model gemini-3.8-flash-low --effort high` dùng mức nào | Hỏi model tự báo không đáng tin → so `usage.thinking_tokens` của hai lượt cùng prompt (`-low` + `--effort high` vs `-high`); nếu không phân biệt được thì ghi "không xác định" và giữ cảnh báo |
| V11 | `yaml` 2.9.1: các tùy chọn ở §3 đúng tên/hành vi | Context7 `/eemeli/yaml/v2.9.1` + test §12.1 |

Kết quả ghi vào phụ lục spec này trước commit P2a. Nếu V8 cho thấy agy đi ngược thư mục cha: **dừng, báo người dùng** (xem §6.4).

---

## 14. Commit

| Commit | Nội dung |
|---|---|
| `feat(squad): role definitions, skill catalog and safe YAML (P2a)` | §3, §4, §5, template, `yaml` dependency, test §12.1 (yaml/roles/catalog) |
| `feat(squad): skill store, per-role mount and setup command (P2b)` | §6, §8, §10, doctor §9, adapter `mountSkills`/`skillDirs`, cờ cô lập codex, test tương ứng |
| `fix(dual): keep project skills out of worker roots (P2c)` | §7, Phụ lục §6.5 (`git init` worker root, bỏ `.git` của worker khỏi lượt quét kết quả) + test §12.2, kèm test: worker root có `.git` riêng; kết quả task không chứa `.git`; lệnh git trong worker không chạm repo cha |

P2a cũng gồm sửa adapter agy theo Phụ lục §6.6 (effort theo hậu tố model) và test golden/conformance tương ứng.

---

## 15. Điều kiện xong P2 (DoD)

- [x] `npm test` xanh trên macOS + một lượt dưới tải xanh; test cũ không đổi assertion (trừ test dual mới thêm case).
- [x] `omni squad setup --preset dual` trên repo này (2026-11-01, codex `gpt-6.1-sol`/`high` + agy `gemini-3.8-flash-high`): tạo 3 file vai + `skills.yaml`, binding, kho 52 skill, `stack.worker` 12 skill, orchestrator 27 skill (nhận cả 27), chuyển 25 skill sang `.omni/skills/.displaced/` (không xóa). Phát hiện: 17 thư mục skill trong số đó (43 file) đang được git theo dõi trong repo này nên hiện là "deleted" trong `git status`; `.gitignore` của repo có dòng `.omni/` tự viết nên `.omni/squad/` chưa commit được (setup chỉ cảnh báo).
- [x] `omni skills doctor` trên repo này: 0 lỗi squad, 1 cảnh báo `SQUAD_USER_SKILLS_GLOBAL`: `~/.agents/skills` có 31 skill mà orchestrator codex đều thấy. Không có cảnh báo cho `~/.claude/skills` vì Claude Code không được gán vai. Ghi chú: lệnh đúng là `omni skills doctor`; tên `skills:doctor` đã bỏ từ trước (`test/cli-simplify.test.js`), gợi ý in ra đã sửa.
- [x] Một task dual (fixture nhỏ, worker giả lập) chạy qua isolated-runner thật: worker root chỉ có bundle worker; integrate thành công (`test/dual-isolated-runner.test.js`). Chưa chạy với agy thật.
- [x] Phụ lục V8–V11 đã ghi.
- [ ] Linux/Windows thật: hoãn (SQUAD-ARCHITECTURE-PLAN §11).

---

## Phụ lục — Kết quả kiểm V8–V11 (2026-11-01)

Máy kiểm: macOS arm64, `codex-cli 0.166.0`, `agy 1.4.12`. Mỗi lượt dùng thư mục tạm (đã realpath) gồm `parent/` (có skill `zebra-parent-probe`) và `parent/child/` (có skill `otter-child-probe`); chạy CLI trong `child`, hỏi model tên skill có chứa "zebra"/"otter". Thư mục tạm đã xóa sau khi kiểm.

| # | Kết quả | Ảnh hưởng |
|---|---|---|
| V8 | **agy đi ngược lên tới gốc git gần nhất để tìm skill.** `parent` là git repo → thấy cả `zebra-parent-probe`. Đặt `GIT_CEILING_DIRECTORIES=parent` → **vẫn thấy** (agy không tôn trọng biến này). `parent` không phải git repo → chỉ thấy `otter-child-probe`. `child/.git` là thư mục rỗng → vẫn thấy cả hai. `child` được `git init` → chỉ thấy `otter-child-probe`. Ngoài ra agy liệt kê rất nhiều skill toàn cục/plugin từ `~/.gemini` (khẳng định F6). | Worker root hiện nằm trong repo có `.git` → **worker agy thấy skill ở gốc repo kể cả sau §7**. Theo §6.4 phải dừng và hỏi người dùng. Hướng đã kiểm là chạy được: `git init` worker root (không cần commit). Xem §6.5. |
| V9 | **codex**: không cờ → thấy cả hai skill; có `-c project_root_markers=[]` → chỉ thấy `otter-child-probe`. Lưu ý khi chạy tay: `codex exec` chờ đọc thêm stdin nếu stdin không đóng (`Reading additional input from stdin...`); adapter P1 và dual đều spawn với stdin `ignore` nên không bị ảnh hưởng. `gpt-5.4-mini` không còn dùng được với tài khoản ChatGPT trên 0.166.0. | §6.4 đúng như thiết kế. |
| V10 | **agy: `--effort` phụ thuộc model.** Model có hậu tố mức (`gemini-3.8-flash-low`, `…-high`, `gpt-oss-120b-medium`): `--effort` khác hậu tố → `exit 1`, `status: ERROR`, lỗi `--model X conflicts with --effort=Y`; `--effort` trùng hậu tố → chạy. Model Claude qua agy (`claude-sonnet-4-6`): mọi `--effort` → lỗi `--effort is not supported for model`. Tên gốc không có trong danh sách (`gemini-3.8-flash`) + `--effort high` → chạy. Đo `thinking_tokens` cùng câu hỏi: `-low` 0–300, `-high` 850–1080. | **Adapter agy của P1 sai**: khai mọi model có đủ 5 mức effort. P2a sửa (§6.6). Dual cũ luôn truyền `--effort` (`agy-runner`, `live-agy-invoke`) và bắt buộc có effort (`workerConfigurationError`) → với model Claude qua agy, dual hiện **luôn lỗi**; với model có hậu tố, `workerEffort` phải trùng hậu tố. P2 setup ghi `workerEffort` trùng hậu tố; sửa dual cho model không nhận effort chuyển sang P3. |
| V11 | Tùy chọn của `yaml` 2.9.1 ở §3 khớp tài liệu (`/eemeli/yaml/v2.9.1` docs/03_options.md): `schema`, `strict`, `uniqueKeys`, `stringKeys`, `merge`, `resolveKnownTags`, `prettyErrors`; `toJS({ maxAliasCount })`. | Kiểm hành vi thật bằng test §12.1. |

### 6.5 (bổ sung theo V8) Cô lập worker agy

**Đã chốt 2026-11-01 (người dùng chọn phương án này).** Sau khi chép worker root, chạy `git init -q` trong worker root (dùng `shell:false`, env có `GIT_CEILING_DIRECTORIES` như hiện tại) để worker root là gốc git của chính nó.
- `.git` của worker root được ghi vào `roleSkillDirs`/danh sách bỏ qua của lượt quét kết quả (§7 bước 3), không bao giờ tính là thay đổi của worker, không bao giờ integrate.
- Hệ quả phụ: lệnh git chạy trong worker giờ chạy trên một repo trống thay vì báo lỗi "not a git repository". Không commit baseline để tránh nhân đôi dung lượng repo lớn.
- Codex vẫn giữ `-c project_root_markers=[]` (phòng thủ hai lớp).
- Phương án thay thế: đặt worker root ra ngoài repo. Thay đổi lớn hơn (integrate, recovery, đường dẫn trong ledger) nên không chọn nếu `git init` đủ.

### 6.6 (bổ sung theo V10) Effort của agy

- `listModels`: model có hậu tố `-(low|medium|high|xhigh|max)` → `efforts = [hậu tố]`, `defaultEffort = hậu tố`; model `claude-*` → `efforts = null`; còn lại → `efforts = null` (không biết chắc → không đề xuất effort).
- `buildHeadless`/`buildResume`/`interactiveCommand`: model có hậu tố → **không truyền `--effort`**; nếu turn có effort khác hậu tố → `SQUAD_RUNTIME_BAD_TURN`. Model không hậu tố → chỉ truyền `--effort` khi turn có effort.
- Test golden và conformance của agy cập nhật theo.
