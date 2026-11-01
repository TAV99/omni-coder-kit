# Kế hoạch kiến trúc Omni Squad (3.2.0) — đa vai, đa model, đa CLI

> Ngày: 2026-10-31 · Nhánh: `3.2.0` (tách từ `main` @ `3199575`) · Trạng thái: **bản kiến trúc đã chốt qua thảo luận, chưa có code**.
> Tài liệu này là căn cứ để viết các spec triển khai từng pha (`SPEC-SQUAD-P*.md`), theo nếp `HARNESS-UPGRADE-PLAN.md` → `HARNESS-SPEC-PHASE-*.md`.

---

## 0. TL;DR

- Nâng cấp chế độ `dual` (Codex + AGY gắn cứng) thành **squad**: N agent theo **vai** (role), mỗi vai có bộ skill riêng, người dùng tự gắn bất kỳ CLI/model nào vào bất kỳ vai nào.
- Ba lớp: **Role** (omni định nghĩa, khai báo) → **Binding** (người dùng chọn) → **Runtime adapter** (mỗi CLI một adapter, cùng hợp đồng).
- Luồng là **pipeline khai báo** thay cho máy trạng thái cứng trong `lib/dual/orchestrator.js`.
- Liên lạc hình sao: mọi tin nhắn qua omni, agent không cầm session ID của nhau, độ sâu điều phối = 1.
- `omni ui` (tùy chọn): web local, nhúng PTY thật của orchestrator, timeline chung, gửi tin theo vai.
- `dual` được giữ, nhưng chỉ còn là một **preset** của squad (1 orchestrator + 1 worker). `omni dual …` thành alias của `omni squad …`.

---

## 1. Bối cảnh & vấn đề

### 1.1 Hiện trạng (3.1.2 trên `main`)

```
Codex ($om-think) → interview/spec → setup.json + todo.md + dual-plan.json
      │  omni dual bootstrap --json
      ▼
Authority daemon (daemon-server + authority-store, ledger hash-chain)
      ▼
NEW → preflight → scout → spec → route ─┬─ gemini → implement → scope → review → codex_qc
                                        └─ codex  → codex_work ───────────────→ codex_qc
                                                                 NEEDS_FIX → correction ↺
```

- scout/review đi qua discussion transport (conversation AGY bền); implement/correction đi qua isolated-runner (cold dispatch, lease, baseline, scope-guard, watchdog, checkpoint/resume).
- Các bất biến đáng giữ: fail-closed, ledger append-only hash-chain, không spawn trùng tự động, outcome unknown phải reconcile.

### 1.2 Khoảng trống

| # | Khoảng trống | Bằng chứng trong code |
|---|---|---|
| G1 | Vai gắn cứng vào nhà cung cấp | `lib/dual/contracts.js`: `owner: z.enum(['codex', 'agy'])` / `['codex', 'gemini']`; luật route viết theo tên provider |
| G2 | Skill không chia theo vai | Codex và AGY cùng đọc `.agents/skills/` của project → mọi agent thấy toàn bộ ~52 skill |
| G3 | Hai lớp provider song song | `lib/harness/providers/` (host-cli, claude-sdk) và phần codex/agy hardcode trong `lib/dual/` |
| G4 | Luồng hardcode | `orchestrator.js` cố định chuỗi state → không chèn được vai mới (design, QC…) |
| G5 | Chỉ 2 agent | Không có khái niệm nhiều instance cùng vai hay vai thứ ba |
| G6 | Khó quan sát | Không có nơi nhìn chung agent, CLI, task, hội thoại |

3.1.2 **chưa đạt nghiệm thu** — không dùng làm mốc so sánh (xem §11).

---

## 2. Quyết định đã chốt

| # | Quyết định |
|---|---|
| D1 | Vai do omni định nghĩa bằng **file khai báo**; mỗi vai có bundle skill, quyền, phase, capability yêu cầu. Thêm vai mới (design, QC…) = thêm file định nghĩa + phase trong pipeline. |
| D2 | Binding 4 tầng: `role → runtime (CLI) → model → effort`, người dùng chọn. |
| D3 | Model chỉ có API (DeepSeek, OpenRouter, Ollama…) chạy **qua CLI đa model** (vd. OpenCode). Omni không giữ API key. *(Sau 3.2.0 — D19.)* |
| D4 | Người dùng làm việc trực tiếp với orchestrator. |
| D5 | Orchestrator **kéo việc** qua MCP (`squad.next` / `squad.submit`); omni **đẩy việc** headless cho mọi vai còn lại. Bật reviewer thì QC chuyển sang kiểu đẩy. |
| D6 | Liên lạc hình sao, omni giữ bảng `role → session id` và relay qua authority; agent không gọi nhau trực tiếp. |
| D7 | Skill của orchestrator ở project root; skill của worker mount vào worker root (isolated) và loại khỏi integrate. |
| D8 | Điểm dừng mặc định: duyệt spec, duyệt plan, trước integrate/promote. AUTO chỉ bỏ cổng có `auto_ok`; cổng trước promote **không bao giờ** được bỏ. |
| D9 | Vai + pipeline là của project, **commit** trong `.omni/squad/`. Binding là của từng người, chọn lại lúc khởi động omni — ai có CLI/model nào thì cắm nấy. |
| D10 | Gitignore: `.omni/*` + `!.omni/squad/` (mở ngoại lệ, có di trú dòng `.omni/` cũ). |
| D11 | UI phương án B: PTY thật cho orchestrator; web local `omni ui`; **tùy chọn**. |
| D12 | Hỗ trợ macOS, Windows, Linux. |
| D13 | Timeline hiện cả cuộc chat người dùng ↔ orchestrator (qua transcript reader của adapter). |
| D14 | Tên chế độ: **squad**; `dual` = preset, alias. Mã lỗi `DUAL_*`, đường dẫn `dual-authority`, event ledger giữ nguyên ở đợt đầu. |
| D15 | Mặc định B1–B5 (§5–§7) được duyệt nguyên. |
| D16 | Tiêu chí nghiệm thu tuyệt đối (§11), không so với 3.1.2. |
| D17 | File vai/pipeline viết bằng **YAML**. Thêm dependency `yaml` (npm, bản 2.x — 2.9.1 tại 2026-10-31; tra lại tài liệu qua Context7 trước khi code). Parse xong phải validate bằng `zod` như mọi contract khác; chỉ parse dữ liệu thuần (không tag tùy biến, không anchor/alias vượt giới hạn). |
| D18 | **Một runtime/tài khoản giữ được nhiều vai** (vd. 1 tài khoản Codex làm orchestrator + reviewer với model/effort khác nhau, agy làm worker). Binding khóa theo **role instance**, không có ràng buộc runtime duy nhất. Mỗi vai là một session CLI độc lập, bảng D6 khóa theo tên vai. Quy tắc: (1) không bao giờ resume ngầm (`--last` hoặc tương đương) — luôn resume bằng session ID của vai đó, vì `~/.codex/sessions` là chung; (2) mỗi vai chạy ở root riêng (§5.3) để không kế thừa `.codex/config.toml` (MCP `omni_dual`, hooks) và skill của vai khác; hook bridge bỏ qua payload có `session_id` không thuộc vai nào; (3) vẫn dùng chung `CODEX_HOME` (§5.3); (4) preflight cảnh báo khi ≥ 2 vai dùng chung một tài khoản (chung quota), lỗi rate limit → task chờ (B3); (5) orchestrator và reviewer cùng họ model → chỉ cảnh báo; reviewer cùng họ với worker → cảnh báo mạnh. Đã thấy (V21, 2026-11-01): hai phiên codex cùng tài khoản chạy song song ~9 phút không bị đăng xuất. Chưa kiểm: hai tiến trình cùng làm mới token trong `auth.json` khi token hết hạn giữa chừng (V7, spec P1 §14); với claude, các phiên cùng dùng `~/.claude` — kiểm tương tự ở P4. |
| D19 | **Ba runtime chính của 3.2.0: codex, agy, claude (Claude Code CLI)** — ba hãng người dùng dùng nhiều nhất (người dùng chốt 2026-11-01). Adapter thứ ba (P4) là **Claude Code**, không phải OpenCode. Theo D18, mỗi tài khoản (Codex, Antigravity, Claude) có thể mở nhiều session CLI và giữ nhiều vai cùng lúc. OpenCode và nhánh model chỉ có API (D3) dời sang sau 3.2.0; registry vẫn giữ cửa mở cho chúng. |

---

## 3. Kiến trúc đích

### 3.1 Ba lớp

```
┌─ ROLE (khai báo, commit trong .omni/squad/roles/) ─────────────┐
│ orchestrator ×1 · worker ×1..N · reviewer ×0..1 · (design…)    │
│ → skills · permissions · phases · requires · input/output      │
└──────────────────────────────┬─────────────────────────────────┘
                               │ binding (của từng người dùng)
┌─ BINDING (~/.omni/squad.json + override local, gitignore) ─────┐
│ orchestrator → codex       / sol-6.1          / high           │
│ worker-1     → agy         / gemini-3.8-flash / high           │
│ reviewer     → claude      / claude-opus-…    / high           │
└──────────────────────────────┬─────────────────────────────────┘
                               │
┌─ RUNTIME ADAPTER REGISTRY (lib/squad/runtimes/) ───────────────┐
│ codex · agy · claude  (sau 3.2.0: opencode · …)                │
│ cùng một hợp đồng + bộ conformance test                        │
└──────────────────────────────┬─────────────────────────────────┘
                               │
┌─ AUTHORITY (giữ nguyên lõi daemon/ledger/lease/scope-guard) ───┐
│ owner đổi từ tên provider → tên role instance                  │
└────────────────────────────────────────────────────────────────┘
```

### 3.2 Định nghĩa vai (role definition)

Một file YAML mỗi vai trong `.omni/squad/roles/` (D17). Ví dụ:

```yaml
id: design
description: Mockup + design token trước implement
cardinality: "0..1"
phases: [design]
permissions:
  write: ["design/**", "**/*.css"]
  shell: false
skills:
  - tailwind-design-system
  - high-end-visual-design
  - minimalist-ui
requires: [headless, write]        # capability runtime bắt buộc
optional: [vision]
input:  { schema: spec@1 }
output: { schema: design-artifact@1 }
budget: { turn_minutes: 30, max_turns: 6 }
```

Catalog khởi đầu:

| Vai | Số lượng | Trách nhiệm | Kiểu gọi |
|---|---|---|---|
| orchestrator | đúng 1 | interview, spec, plan, route, đầu mối người dùng; kiêm QC khi không có reviewer | kéo (MCP) |
| worker | 1..N | scout, implement, correction | đẩy (headless) |
| reviewer | 0..1 | QC độc lập | đẩy (headless) |

Người dùng **chưa** được tự định nghĩa vai ở 3.2.0 (tránh phá mục tiêu không chồng chéo skill). Vai mới do omni phát hành.

### 3.3 Pipeline khai báo

`.omni/squad/pipeline.yaml` mô tả phase → vai → artifact → cổng:

```yaml
preset: squad
phases:
  - { id: spec,      role: orchestrator, out: spec@1,  gate: human }            # D8
  - { id: plan,      role: orchestrator, out: plan@1,  gate: human }            # D8
  - { id: scout,     role: worker,       in: plan@1,   out: scout@1 }
  - { id: implement, role: worker,       in: plan@1,   out: evidence@1, parallel: true }
  - { id: qc,        role: reviewer,     in: [spec@1, evidence@1], out: qc-verdict@1,
      on_needs_fix: implement, max_corrections: 3 }
  - { id: integrate, role: orchestrator, gate: human-always }                   # không bao giờ auto
```

- Preset `dual` = spec → plan → scout → implement → qc(orchestrator) → integrate, phải tái hiện hành vi đường hiện tại.
- Cổng: `human` (dừng chờ duyệt; AUTO bỏ qua nếu có `auto_ok: true`), `human-always` (không bao giờ bỏ), `machine` (schema/scope/test).
- Ledger, lease, scope-guard, relay giữ nguyên; chỉ đọc vai từ pipeline thay vì tên cứng.

### 3.4 Liên lạc hình sao

```
            ┌──────────── omni (relay + authority + journal) ────────────┐
            │  role→session map · inbox · lease · ledger                  │
            └───▲───────────────▲────────────────▲───────────────▲───────┘
   MCP kéo việc │   headless đẩy │   headless đẩy │      inbox.post │
          orchestrator      worker-1          reviewer        người dùng (UI)
```

- Không có kênh worker↔worker hay worker↔reviewer trực tiếp.
- Mọi envelope có ID, sequence, correlation, hash; ghi journal (kế thừa discussion transport F01).

---

## 4. Runtime adapter

### 4.1 Hai loại nhà cung cấp

| Loại | Ví dụ | Cách chạy |
|---|---|---|
| Agent CLI (có vòng lặp công cụ) | Codex CLI, agy, Claude Code, Gemini CLI, OpenCode, Qwen Code… | adapter điều khiển CLI |
| Chỉ có API model | DeepSeek, OpenAI API, OpenRouter, Ollama… | qua CLI đa model (D3) |

"Khác hệ" tính theo **hãng của model**, không theo CLI (Claude Code chạy DeepSeek = hệ DeepSeek).

### 4.2 Hợp đồng adapter (khái niệm)

| Nhóm | Hàm |
|---|---|
| Phát hiện | `detect()` (đường dẫn theo OS) · `version()` · `authStatus()` · `listModels()` |
| Chạy | `interactiveCommand(binding)` (cho PTY) · `invokeHeadless(turn)` · `resume(sessionRef, turn)` |
| Môi trường | `mountSkills(bundle, root)` · `writeMcpConfig(root)` · `permissionFlags(profile)` |
| Quan sát | `readTranscript(sessionRef)` · `parseOutput(raw, schema)` |
| Khai báo | `capabilities: { interactive, mcp, hooks, headless, write, resume, structuredOutput, transcript, sandbox, usage }` |

### 4.3 Capability: khai báo nhưng phải probe

- Preflight chạy probe thật (cài chưa, đăng nhập chưa, model có trong `listModels` không, headless có chạy không). Không tin lời khai.
- Chạy lại preflight mỗi lần `omni squad` khởi động, không chỉ lúc init.
- Điều kiện vai:
  - **orchestrator:** `interactive` + `mcp` + `transcript` (hooks tùy chọn).
  - **worker / reviewer:** `headless` + `write` (reviewer: chỉ đọc + ghi artifact) + chế độ quyền không hỏi; `resume`, `structuredOutput` là điểm cộng.
- Init chỉ hiện runtime đủ điều kiện cho từng vai.
- Thiếu capability không bắt buộc → hạ cấp có kiểm soát + báo rõ (vd. không có transcript → timeline chỉ hiện sự kiện omni). **Không parse chữ hiển thị trên terminal.**

### 4.4 Registry & conformance test

- `lib/squad/runtimes/<id>.js` đăng ký vào registry; gộp `lib/harness/providers/` và phần codex/agy trong `lib/dual/` (G3) để mỗi CLI chỉ có **một** adapter.
- Bộ conformance test chung (`test/squad-runtime-conformance.test.js`): mọi adapter phải qua; phần live đánh dấu skip khi CLI không có trên máy.
- Thêm CLI mới = viết adapter + qua conformance, không sửa lõi.
- Tổng quát hóa `lib/dual/binary-paths.js` (đang chỉ có codex/agy) thành cơ chế dò đường dẫn theo adapter.

### 4.5 Quyền & sandbox (B4)

- Adapter dịch profile quyền của vai → cờ sandbox/approval của CLI.
- CLI không tự sandbox được → chỉ được chạy trong worker root cô lập; scope-guard là tầng chặn cuối.
- Không đặt cờ kiểu `--dangerously-skip-permissions` làm mặc định.

---

## 5. Skill theo vai

### 5.1 Bundle khởi đầu

| Bộ | Skills |
|---|---|
| orchestrator | om-think, om-spec, om-plan, brainstorming, writing-plans, dispatching-parallel-agents, receiving-code-review, api-and-interface-design, documentation-and-adrs |
| worker (chung) | test-driven-development, systematic-debugging |
| worker (theo stack) | chọn sau scan project, vd. react-state-management, vitest, tailwind-design-system, nextjs-app-router-patterns |
| QC (gắn theo **phase** `qc`) | om-check, om-pass, requesting-code-review |
| shared-core | karpathy-guidelines, verification-before-completion |
| loại khỏi squad | using-superpowers, find-skills, subagent-driven-development (trùng vai trò omni) |

Bundle QC gắn với **phase** chứ không gắn với vai: phase `qc` thuộc vai nào thì vai đó được mount bundle QC. Không có reviewer thì orchestrator nhận; bật reviewer thì bundle chuyển sang reviewer và rời khỏi orchestrator. Nhờ vậy QC không bao giờ bị nạp trùng vào hai vai. Nguyên tắc chung: skill của một phase đi theo vai đang giữ phase đó.

### 5.2 Chống chồng chéo

- `omni skills doctor` báo lỗi khi, sau khi đã gán phase theo pipeline, một skill bị mount vào ≥ 2 vai mà không đánh dấu `shared-core`.
- `SKILL.md` là định dạng gốc; adapter chuyển sang vị trí CLI đọc (`.claude/skills`, `.agents/skills`…) hoặc chèn vào file chỉ dẫn/prompt nếu CLI không có khái niệm skill.

### 5.3 Cô lập (D7)

- Project root: chỉ skill của orchestrator, đặt đúng thư mục CLI orchestrator đọc.
- Worker root (isolated-runner): mount bundle của worker; loại khỏi integrate.
- Cùng một CLI đóng cả hai vai vẫn đúng vì worker chạy ở root riêng. Reviewer cũng có root riêng (chỉ đọc + ghi artifact) để cùng CLI làm orchestrator + reviewer không lẫn config/skill (D18).
- **Không** đổi `CODEX_HOME`/`CLAUDE_CONFIG_DIR` để cô lập (thông tin đăng nhập nằm ở đó).

---

## 6. Hợp đồng artifact, ngữ cảnh, leo thang (B1–B3)

- **B1 — Artifact:** mỗi vai khai báo `input/output` bằng schema có version; omni validate ở mọi lần bàn giao; artifact đi nguyên văn, không paraphrase.
- **B2 — Ngữ cảnh:** orchestrator thấy toàn bộ; worker chỉ thấy brief + `allowed_files`; reviewer thấy spec + diff + evidence, **không** thấy lập luận của worker. Chỉ orchestrator ghi knowledge base.
- **B3 — Leo thang:** worker vượt `max_corrections` → orchestrator → người dùng. Runtime bị rate limit / hết đăng nhập → task chờ, không tự đổi model; fallback chỉ khi binding khai báo sẵn.

## 7. Ngân sách & đồng thời (B5)

- Hạn mức theo vai: thời gian lượt, số lượt, token (khi runtime báo `usage`). Kế thừa watchdog + hạn mức lượt 30 phút.
- Giới hạn số lượt chạy đồng thời theo runtime (quota Codex 5H đã ghi nhận trong F01).
- Nhiều worker song song: `allowed_files` không giao nhau; integrate xử lý khi nhiều nhánh cùng xong.

---

## 8. Cấu hình & khởi động

### 8.1 Vị trí

| Thứ | Vị trí | Git |
|---|---|---|
| Vai, pipeline | `.omni/squad/roles/*`, `.omni/squad/pipeline.yaml` | commit |
| Binding mặc định của người dùng | `~/.omni/squad.json` | — |
| Override binding theo project | trong `.omni/` (ngoài `squad/`) | ignore |
| Runtime: runs, journal, ledger | `.omni/runs/…` | ignore |

### 8.2 Gitignore (D10)

```
.omni/*
!.omni/squad/
```

- `ensureGitignore` (`lib/commands/helpers.js`) thay dòng `.omni/` cũ bằng hai dòng trên **chỉ trong khối `# Omni-Coder Kit (generated)`**; nếu `.omni/` do người dùng tự viết thì cảnh báo, không tự sửa.

### 8.3 Luồng khởi động

1. `omni init` → chọn chế độ squad → chọn preset (`dual` / `squad`) → ghi vai + pipeline vào `.omni/squad/`.
2. Với từng vai: liệt kê runtime đủ điều kiện → chọn runtime → `listModels()` → chọn model → effort.
3. Preflight từng adapter; lỗi thì chỉ rõ cách sửa (cài CLI, đăng nhập, cấu hình provider).
4. Mount skill, ghi MCP config cho orchestrator, khởi tạo authority.
5. Máy khác clone repo: đã có vai + pipeline; chỉ chạy bước 2–4 với CLI/model của máy đó.

---

## 9. `omni ui` (tùy chọn)

### 9.1 Thành phần

```
Trình duyệt (omni ui)
 ├ Sidebar: vai → binding, trạng thái preflight, cây task/lease
 ├ Pane chính: PTY orchestrator (CLI thật); tab live log cho worker/reviewer
 └ Timeline: journal + ledger + transcript orchestrator; composer @orchestrator @worker-1 @reviewer @all
        │ WebSocket (127.0.0.1 + token phiên + kiểm Origin)
UI server (tiến trình riêng)
 ├ PTY host: spawn CLI orchestrator theo binding, giữ scrollback, attach lại khi mở tab
 ├ Event feed: tail journal/ledger (chỉ đọc) + transcript reader của adapter
 └ Inbox proxy → daemon RPC
        │ RPC loopback
Authority daemon (không đổi vai trò)
```

- UI server tách khỏi daemon: PTY hay trình duyệt lỗi không ảnh hưởng authority.
- Đóng tab không giết tiến trình; mở lại là attach.
- `node-pty` khai báo `optionalDependency`; thiếu thì `omni ui` báo rõ, `omni squad` vẫn chạy.

### 9.2 Gửi tin

- `@orchestrator`: vào inbox; orchestrator nhận qua MCP tool đọc inbox hoặc hook đính kèm lượt kế. Không gõ phím giả vào PTY.
- `@worker-N` / `@reviewer`: qua relay; không có lease thì chặn; mọi ghi file vẫn qua scope-guard + QC.
- Mọi tin của người dùng ghi journal.

### 9.3 Bảo mật

Bind `127.0.0.1` duy nhất, token ngẫu nhiên mỗi phiên, kiểm Origin — bật từ bản đầu (PTY qua trình duyệt về bản chất là shell).

---

## 10. Lộ trình (thay theo lớp, mỗi pha một spec riêng)

| Pha | Nội dung | Điều kiện xong |
|---|---|---|
| P1 | Runtime registry: adapter codex + agy; gộp phần **phát hiện/probe** (binary đa OS, version, đăng nhập, model); builder invocation chung; conformance test; `omni squad runtimes`. Spec: [`SPEC-SQUAD-P1-RUNTIME-REGISTRY.md`](SPEC-SQUAD-P1-RUNTIME-REGISTRY.md) | `npm test` xanh; conformance pass cho 2 adapter |
| P2 | Role definition: orchestrator/worker/reviewer; bundle skill; mount theo vai; `skills:doctor` kiểm chồng chéo; gitignore D10. Spec: [`SPEC-SQUAD-P2-ROLES-SKILLS.md`](SPEC-SQUAD-P2-ROLES-SKILLS.md) | Doctor bắt được skill trùng; worker root không chứa skill orchestrator |
| P3 | Pipeline khai báo + preset `dual`; `owner` → role instance; cổng D8; MCP `squad.next/submit`; chuyển các builder argv cũ (dual + `lib/harness/providers`) sang builder chung của registry; nối probe agy của `capability-preflight` và probe codex của `daemon-ports` vào adapter (chuyển từ P1b, cần adapter nhận `prespawnGuard`, trả mã retry, parse chặt, tùy chọn gồm model ẩn — SPEC-SQUAD-P1 §10) | Preset `dual` chạy trọn vòng qua daemon. Spec: [`SPEC-SQUAD-P3-PIPELINE.md`](SPEC-SQUAD-P3-PIPELINE.md) |
| P4 | Adapter thứ ba **Claude Code** (D19): CLI khác hẳn codex/agy (hook, MCP, permission mode, `.claude/skills`), chứng minh registry không bị đúc khuôn; claude giữ được vai nào cũng được (orchestrator, worker, reviewer) | Tổ hợp binding có claude chạy trọn vòng (vd. worker claude; codex + claude cùng tài khoản riêng) |
| P5 | Reviewer + nhiều worker song song + ngân sách/đồng thời theo runtime | Preset `squad` 3 vai chạy trọn vòng |
| P6 | `omni ui` chỉ đọc → PTY → inbox/gửi tin theo vai | Ba OS chạy được; kiểm bảo mật loopback/token/Origin |
| P7 | Nghiệm thu §11 | Đạt toàn bộ ngưỡng |

Vai mới sau 3.2.0 (design…) = thêm file vai + phase, không đổi lõi.

---

## 11. Tiêu chí nghiệm thu 3.2.0 (D16)

Chốt trước khi code; không so với 3.1.2.

- Bộ ~10 task cố định, độ khó khác nhau, chạy trên workspace sạch, ở cả preset `dual` (2 vai) và `squad` (3 vai, có reviewer).
- Ngưỡng:
  - ≥ 90% task hoàn thành đúng requirements;
  - 0 lần ghi ngoài scope;
  - 0 outcome unknown tồn đọng;
  - 0 lần dispatch trùng;
  - 100% cổng chờ người duyệt chạy đúng (kể cả cổng `human-always` không bị AUTO bỏ qua).
- Ít nhất 2 tổ hợp binding khác nhau trên ba runtime chính (D19), vd. (codex, agy) và (codex, claude). Preset `squad` chạy thêm tổ hợp một runtime giữ hai vai (codex orchestrator + codex reviewer, agy worker — D18).
- Thời gian chỉ ghi nhận, không đặt ngưỡng ở đợt này.

**Thứ tự kiểm đa hệ điều hành (người dùng quyết, 2026-11-01).** Mọi pha P1–P7 được phát triển và nghiệm thu trên **macOS trước**: `npm test` xanh, kể cả khi chạy dưới tải. Khi 3.2.0 hoàn thiện trên macOS, người dùng mang repo sang **Linux và Windows thật** để chạy `npm test`, `omni squad runtimes` và bộ nghiệm thu, rồi phát triển và sửa lỗi riêng của từng hệ điều hành ngay trên máy đó. Trong lúc làm trên macOS: code vẫn phải viết đúng cho cả ba hệ điều hành (D12), và test giả lập `win32` vẫn bắt buộc. Chỉ việc chạy trên máy thật là hoãn lại.

---

## 12. Câu hỏi mở

| # | Câu hỏi | Ghi chú |
|---|---|---|
| ~~Q1~~ | ~~Định dạng file vai/pipeline~~ | **Đã chốt 2026-10-31: YAML** (D17). |
| ~~Q2~~ | ~~Xác nhận OpenCode là adapter thứ ba~~ | **Đã chốt 2026-11-01 (D19): adapter thứ ba là Claude Code**; OpenCode sau 3.2.0. |
| Q3 | Transcript của agy nằm ở đâu, định dạng gì? | Codex: `~/.codex/sessions/*.jsonl`; Claude Code: `~/.claude/projects/`; agy chưa khảo sát. Ảnh hưởng D13. |
| Q4 | Cơ chế giao tin inbox cho orchestrator theo từng CLI | MCP tool đọc inbox chạy được mọi CLI có MCP; hook chỉ CLI có hooks. |
| Q5 | Đổi tên nội bộ `DUAL_*`, `dual-authority` | Ngoài phạm vi 3.2.0; nếu làm phải đọc được cả tên cũ. |
| Q6 | Implement qua conversation bền (Quyết định D của F01) | Vẫn đóng; điều kiện mở lại giữ nguyên `f01-program-status.md`. |

---

## 13. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Đổi `owner` + pipeline khai báo làm vỡ lõi dual | P3 có preset `dual` làm hồi quy; giữ toàn bộ test dual xanh |
| Interface adapter bị "đúc khuôn" codex/agy | P4 bắt buộc một CLI khác hẳn (Claude Code — D19) |
| `node-pty` native khó cài trên một số máy | `optionalDependency`; squad chạy không cần UI |
| PTY qua web thành lỗ hổng shell | Loopback + token + Origin từ bản đầu |
| Nhiều worker song song xung đột file | `allowed_files` không giao nhau; giới hạn đồng thời |
| Rate limit khi nhiều agent cùng runtime | Giới hạn đồng thời theo runtime; task chờ thay vì đổi model |
| Một tài khoản giữ nhiều vai: resume nhầm session, lẫn config/hook, chung quota | D18: resume luôn bằng ID, root riêng mỗi vai, hook lọc theo `session_id`, preflight cảnh báo |
| Di trú gitignore phá file của người dùng | Chỉ sửa trong khối omni sinh ra; ngoài khối thì cảnh báo |
