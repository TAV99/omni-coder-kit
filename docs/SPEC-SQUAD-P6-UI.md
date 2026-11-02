# Spec — Squad P6: `omni ui`

> Căn cứ: [`SQUAD-ARCHITECTURE-PLAN.md`](SQUAD-ARCHITECTURE-PLAN.md) D6 (hình sao, omni giữ bảng vai → phiên), D11 (UI phương án B: PTY thật cho orchestrator, web local, **tùy chọn**), D13 (timeline có cả transcript người dùng ↔ orchestrator), §9 (thành phần, gửi tin, bảo mật), Q4 (giao tin inbox cho orchestrator theo CLI); P3 (cổng duyệt chỉ người, qua TTY), P4 (claude orchestrator: MCP + hook), P5 (reviewer, nhiều worker, `qc_review`, ngân sách).
> Ngày: 2026-11-02. Tài liệu thư viện tra qua Context7: `node-pty` (/microsoft/node-pty), xterm.js (/websites/xtermjs).

---

## 0. Mục tiêu & phạm vi

### 0.1 Mục tiêu

1. `omni ui`: một trang web local cho một project squad — thấy mọi vai, binding, task, lease, cổng duyệt, verdict reviewer và một **timeline chung** (ledger + journal discussion + transcript orchestrator).
2. **PTY thật cho orchestrator** trong trình duyệt: UI server chạy CLI orchestrator (codex hoặc claude) theo binding với MCP/hook omni đã ghi; đóng tab không giết tiến trình, mở lại là attach (giữ scrollback).
3. **Gửi tin theo vai** từ composer: `@orchestrator` vào inbox (không gõ phím giả vào PTY); `@worker-N` / `@reviewer` thành ghi chú cho lượt kế của vai đó (Q-P6-3). Mọi tin của người dùng vào ledger.
4. Bảo mật từ bản đầu: chỉ `127.0.0.1`, token ngẫu nhiên mỗi phiên, kiểm `Origin`/`Host`.
5. Không có UI thì squad vẫn chạy y như P5: UI là tiến trình riêng, chỉ đọc authority + gọi RPC daemon có sẵn.

### 0.2 Ngoài phạm vi P6

| Mục | Lý do / sang |
|---|---|
| **Duyệt cổng từ UI** | P3 chốt: chỉ người duyệt, qua TTY, có mã xác nhận; UI chỉ **hiện** cổng đang chờ và lệnh `omni squad approve …` để copy. Mở duyệt qua web = mở đường cho agent tự duyệt — giữ nguyên ranh giới P3. |
| PTY cho worker/reviewer | Worker/reviewer là lượt headless do omni đẩy (D5); UI hiện log lượt (stdout/stderr đã lưu, `turn-progress`), không có terminal tương tác |
| Truy cập từ máy khác / nhiều người | Chỉ loopback (§9.3) |
| Sửa role/pipeline/binding từ UI | Vẫn qua `omni squad setup` |
| Linux/Windows chạy thật | Sau macOS (plan §11); code + test phải đúng cho cả ba OS |

### 0.3 Bất biến

- Daemon, ledger, relay, scope-guard, cổng duyệt **không đổi vai trò**. UI server không ghi trực tiếp vào `.omni/runs/**`; mọi ghi đi qua RPC daemon (inbox là RPC mới, ghi event mới — §4).
- Ledger chỉ thêm loại event. `npm test` không cần `node-pty`/trình duyệt (phần PTY test bằng PTY giả qua seam).
- Phụ thuộc mới đều **optional**: thiếu thì `omni ui` báo rõ cách cài, mọi lệnh khác chạy bình thường.

---

## 1. Hiện trạng (đọc từ code, 2026-11-02)

| # | Sự kiện | Nơi |
|---|---|---|
| F1 | Phụ thuộc runtime: `@modelcontextprotocol/sdk`, `chalk`, `commander`, `prompts`, `yaml`, `zod`; chưa có web server/PTY | `package.json` |
| F2 | Daemon: HTTP loopback + token trong file discovery; client `createDaemonClient` đọc discovery; RPC `session.status` trả task/lease/`approvals`/`awaiting_gate`/`qc_review` | `daemon-server.js`, `daemon-client.js` |
| F3 | Authority đọc được từ tiến trình khác (CLI, hook, harness); `derive()` đọc lại khi gặp ghi dở (P5) | `authority-store.js` |
| F4 | Journal discussion: `.omni/runs/dual-discussion/**/journal.jsonl` (hash chain, envelope + observation) | `discussion/journal.js` |
| F5 | Adapter khai `transcript: false` cho cả ba runtime; hợp đồng đã có chỗ `readTranscript` (P1 để P6) | `lib/squad/runtimes/*` |
| F6 | `interactiveCommand(binding)` có cho codex/agy/claude (argv TUI) | runtimes |
| F7 | Orchestrator claude: `.mcp.json` + `.claude/settings.json` hook (P4c); codex: `.codex/config.toml` + `hooks.json` | setup, init |
| F8 | Hook-bridge chặn agent duyệt cổng; tin trả lời ngữ cảnh worker đã có (`task.message` reply qua daemon) | `hook-bridge.js`, `postTaskMessage` |
| F9 | Chưa có inbox cho orchestrator (Q4 còn mở) | — |
| F10 | Node ≥ 20: không có WebSocket server sẵn (chỉ client toàn cục từ Node 22) | Node |
| F11 | `node-pty`: Linux/macOS/Windows (ConPTY, Windows 1809+); `npm install` có thể tải bản build sẵn, không có thì cần Python + C++ (Windows: VS Build Tools + Spectre libs) | Context7 /microsoft/node-pty |

---

## 2. Kiến trúc

```
Trình duyệt ──(127.0.0.1, token, Origin)──▶ UI server (omni ui, tiến trình riêng)
                                              ├ static: index.html + xterm assets (từ node_modules, offline)
                                              ├ GET  /api/state        ← daemon RPC session.status + binding + pipeline
                                              ├ GET  /api/events (SSE) ← tail ledger + journal + transcript
                                              ├ PTY  /api/pty/*         ← PTY host (node-pty) chạy CLI orchestrator
                                              └ POST /api/message      → daemon RPC inbox.post (mới)
                                                        │ RPC loopback (token discovery, như CLI)
                                              Authority daemon (không đổi)
```

- `omni ui [--port N] [--no-open]`: cần project squad (`.omni/squad`), bật daemon nếu chưa chạy (như `omni squad run`), in URL `http://127.0.0.1:<port>/#token=<…>` và mở trình duyệt (trừ `--no-open`).
  - *Đã làm ở P6a:* UI chỉ đọc nên **không** bật daemon — sidebar đọc thẳng `.omni/squad*` và `derive()` của ledger, timeline tail file; daemon chỉ cần từ P6c (`POST /api/message`). Thiếu/sai token cũng trả 403 (không 401), để không phân biệt được lý do từ chối.
- UI server sống tới khi người dùng `Ctrl-C`; đóng tab không giết PTY.
- Module: `lib/ui/server.js` (HTTP + auth + SSE + PTY routes), `lib/ui/feed.js` (gộp nguồn sự kiện), `lib/ui/pty-host.js` (spawn/attach/scrollback qua seam `spawnPty`), `lib/ui/static/` (HTML/CSS/JS thuần, không bundler).

### 2.1 Giao vận (Q-P6-1)

Đề xuất **SSE + POST**, không thêm WebSocket:
- Server → trình duyệt: `GET /api/events` (timeline) và `GET /api/pty/stream` (byte PTY, base64 theo chunk) là `text/event-stream`; tự nối lại với `Last-Event-ID` (scrollback lấy từ bộ đệm vòng).
- Trình duyệt → server: `POST /api/pty/input` (phím, gom theo khung ~16 ms), `POST /api/pty/resize`, `POST /api/message`.
- Lý do: không thêm phụ thuộc runtime ngoài `node-pty`/xterm; loopback nên độ trễ POST không đáng kể; SSE tự reconnect.

### 2.2 Bảo mật (§9.3, từ bản đầu)

| Mối nguy | Chặn |
|---|---|
| Trang web khác gọi API (CSRF, DNS rebinding) | Chỉ bind `127.0.0.1`; mọi request cần token 32 byte ngẫu nhiên mỗi lần chạy (header `Authorization: Bearer` hoặc cookie `SameSite=Strict` đặt từ fragment `#token`); kiểm `Host` ∈ {`127.0.0.1:<port>`, `localhost:<port>`} và `Origin` (nếu có) cùng origin; sai → 403, không tiết lộ gì |
| Token lộ qua URL/log | Token chỉ ở fragment (không gửi lên server, không vào log/Referer); `Referrer-Policy: no-referrer`, CSP `default-src 'self'` |
| PTY = shell từ trình duyệt | Chỉ PTY của CLI orchestrator theo binding (không phải shell tùy ý); không có route chạy lệnh tùy ý |
| Agent tự duyệt cổng qua UI | UI không có route duyệt (0.2) |
| XSS từ nội dung agent | Mọi nội dung timeline hiện bằng `textContent`; không `innerHTML` với dữ liệu |

---

## 3. Các màn hình (bố cục §9.1)

| Vùng | Nội dung | Nguồn |
|---|---|---|
| Sidebar | vai → runtime/model/effort, preflight (sẵn sàng/không), task (trạng thái, worker, attempt, `qc_review`), lease đang chạy, cổng đang chờ + lệnh `omni squad approve <id>` để copy | `/api/state` |
| Pane chính | PTY orchestrator (xterm); tab phụ: log lượt của worker/reviewer (đọc `raw/*.stdout/stderr`, `turn-progress.ndjson`, chỉ đọc) | PTY host, file run |
| Timeline | sự kiện ledger (đã lọc, người đọc được), envelope discussion, tin người dùng, transcript orchestrator (D13); lọc theo vai/task | `/api/events` |
| Composer | `@orchestrator`, `@worker-N`, `@reviewer`, `@all` + nội dung | `/api/message` |

Không parse chữ hiển thị trên terminal (plan §4.3): timeline lấy từ ledger/journal/transcript, không từ byte PTY.

---

## 4. Gửi tin (§9.2, Q4)

### 4.1 Ledger + RPC

- RPC daemon mới `inbox.post { session_id, to: 'orchestrator'|'worker-N'|'reviewer'|'all', body, message_id }` → event mới `user.message.posted { message_id, to, body_sha256, body (≤ 8 KiB) }`; `inbox.read { session_id, to, after }` trả tin chưa đọc; `inbox.ack` → `user.message.delivered { message_id, to, via }`.
- `message_id` do UI sinh (UUID) → gửi lại cùng id là idempotent, khác nội dung → từ chối (như reply P3).

### 4.2 Tới orchestrator (Q-P6-4)

- **Kéo:** MCP tool mới `omni_dual_inbox` (đọc + ack) — chạy với mọi CLI có MCP (codex, claude).
- **Đẩy:** hook `UserPromptSubmit`/`SessionStart` của omni-hook đính tin chưa đọc vào lượt kế (`additionalContext` của claude; tương đương của codex — V42) rồi ack `via: 'hook'`.
- Không gõ phím giả vào PTY.

### 4.3 Tới worker / reviewer (Q-P6-3)

- Ghi chú cho **lượt kế** của vai đó trong task đang chạy: worker — chèn vào input lượt kế như "controller clarification data" (đường reply P3 đã có, không mở rộng quyền ghi); reviewer — chèn vào prompt review kế.
- Không có task/lease phù hợp → tin vẫn vào ledger, UI báo "chưa có lượt nào để nhận".
- Mọi ghi file của worker vẫn qua scope-guard + QC; tin của người dùng không mở rộng `allowed_files`.

---

## 5. PTY orchestrator (P6b)

- PTY host spawn `runtime.interactiveCommand({ model, effort, cwd: projectRoot })` của orchestrator theo binding, env của người dùng + biến omni cần (không đổi `CODEX_HOME`/`CLAUDE_CONFIG_DIR`).
- Một PTY mỗi project; bộ đệm vòng 1 MiB cho scrollback; nhiều tab cùng attach (chỉ một tab gõ tại một lúc — tab sau xin quyền gõ).
- CLI thoát → UI hiện "orchestrator đã thoát (exit N)" + nút chạy lại.
- `node-pty` thiếu (cài lỗi/không có bản build) → pane chính hiện hướng dẫn cài + lệnh chạy CLI tay trong terminal; phần còn lại của UI vẫn chạy (chế độ chỉ đọc).
- Resume phiên orchestrator: chạy lại dùng session của vai nếu adapter có `buildResume` tương tác (D18: không resume ngầm `--last`) — V43.
- *Đã làm ở P6b:*
  - `omni ui` tự chạy orchestrator khi mở (`--no-start` để chờ nút Start, `--resume` để mở lại phiên trước). `interactiveCommand` nhận `session`: claude `{ newId }` → `--session-id` (omni chọn id), `{ resumeId }` → `--resume`; codex chỉ `{ resumeId }` → `codex resume <id>`, id lấy từ dòng `codex resume <id>` CLI in khi thoát. Id lưu ở `.omni/ui/orchestrator.json` (ngoài `.omni/runs`).
  - Tab attach đầu tiên được gõ; tab gõ rời đi thì không ai gõ tới khi một tab bấm "Take control". Route: `GET /api/pty/stream` (SSE, `hello` cấp `client_id`, dữ liệu là chuỗi JSON, `Last-Event-ID` = số thứ tự chunk, `reset` khi phần thiếu đã rời bộ đệm), `POST /api/pty/{start,claim,input,resize}` chỉ nhận `application/json` (form thường không gửi được).
  - PTY host sửa quyền `spawn-helper` (V39) và xóa biến đánh dấu phiên agent cha (V40); trang gửi Enter thành lần ghi riêng (V40).
  - CSP thêm `style-src 'unsafe-inline'` vì xterm.js chèn `<style>` lúc chạy; `script-src` vẫn chỉ `'self'`.
  - Tắt `omni ui` (Ctrl-C) gửi SIGHUP cho CLI orchestrator.

---

## 6. Transcript orchestrator (D13, P6d)

- Thêm `readTranscript(sessionRef | { cwd, since })` cho adapter codex và claude (agy sau, nếu định dạng ổn định) → `transcript: true`.
- Chỉ đọc file phiên của **chính phiên orchestrator** UI đã chạy (tìm theo cwd + thời điểm bắt đầu PTY, xác nhận bằng session id); không quét phiên khác của người dùng.
- Đọc giới hạn kích thước, bỏ qua dòng không nhận ra; lỗi → timeline chỉ hiện sự kiện omni (hạ cấp có kiểm soát, plan §4.3).

---

## 7. Phải kiểm trước khi code (V39–V45)

| # | Cần kiểm | Cách |
|---|---|---|
| V39 | `npm i node-pty` trên macOS (arm64): có bản build sẵn hay build từ nguồn; khai `optionalDependencies` thì `npm i -g omni-coder-kit` không lỗi khi build hỏng | thử trong thư mục tạm |
| V40 | Chạy `codex` và `claude` TUI trong `node-pty` (resize, màu, thoát) và qua xterm trong trình duyệt | 1 lượt mỗi CLI |
| V41 | Vị trí + định dạng transcript: codex `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, claude `~/.claude/projects/<slug>/<session>.jsonl`; cách gắn với phiên PTY; trường nào là lượt người dùng/assistant | đọc file thật (chỉ phiên thử) |
| V42 | Hook của codex và claude có đính được văn bản vào lượt kế không (`additionalContext` / tương đương) | 1 hook thử mỗi CLI |
| V43 | Resume TUI theo session id (`codex resume <id>`, `claude --resume <id>`) | 1 lượt |
| V44 | SSE qua `127.0.0.1`: Safari/Chrome/Firefox tự reconnect, `Last-Event-ID` | thử tay |
| V45 | Windows ConPTY (sau macOS, máy thật) | người dùng |

---

## 8. Câu hỏi mở

| # | Câu hỏi | Đề xuất |
|---|---|---|
| Q-P6-1 | Giao vận UI ↔ server: WebSocket (thêm `ws`) hay SSE + POST (không thêm gì)? | **Đã chốt 2026-11-02: SSE + POST** — không phụ thuộc runtime mới; loopback nên đủ nhanh cho gõ phím. |
| Q-P6-2 | Tài nguyên xterm: `@xterm/xterm` + `@xterm/addon-fit` là `optionalDependencies` phục vụ offline, hay tải từ CDN? | **optionalDependencies** (mặc định đề xuất, người dùng chưa phản đối), phục vụ từ `node_modules` (offline, phiên bản ghim, CSP `'self'`). |
| Q-P6-3 | `@worker-N` / `@reviewer` ở 3.2.0: ghi chú cho lượt kế, hay can thiệp ngay vào lượt đang chạy? | **Đã chốt: ghi chú cho lượt kế** (không ngắt lượt headless; dùng đường reply có sẵn). |
| Q-P6-4 | Giao tin cho orchestrator: chỉ MCP tool (kéo), chỉ hook (đẩy), hay cả hai? | **Đã chốt: cả hai** — MCP tool chạy mọi CLI có MCP; hook đẩy khi CLI có hook (V42). |
| Q-P6-5 | UI chạy CLI orchestrator (UI là cửa chính) hay chỉ quan sát một CLI người dùng mở ở terminal khác? | **Đã chốt: UI chạy CLI** (PTY host), vẫn cho phép mở CLI tay — khi đó pane PTY trống, timeline vẫn đủ. |

---

## 9. Sub-phase & commit

| Commit | Nội dung | Phụ thuộc |
|---|---|---|
| `feat(ui): read-only omni ui (P6a)` | `omni ui`, server + auth + SSE timeline (ledger, journal) + sidebar; không PTY, không gửi tin | Q-P6-1, Q-P6-2, V44 |
| `feat(ui): orchestrator PTY (P6b)` | PTY host qua `node-pty` (optional), xterm, attach/scrollback, hạ cấp khi thiếu | P6a, V39, V40, V43 |
| `feat(dual): user inbox and role messages (P6c)` | `inbox.post/read/ack`, event `user.message.*`, MCP `omni_dual_inbox`, hook đính tin, ghi chú lượt kế worker/reviewer, composer | P6a, V42, Q-P6-3, Q-P6-4 |
| `feat(squad): orchestrator transcripts (P6d)` | `readTranscript` codex + claude, timeline D13 | P6a, V41 |
| `test(ui): live P6 run` | vòng thật: mở UI, chạy orchestrator trong PTY, gửi `@orchestrator`, xem timeline tới `TASK_VERIFIED` | P6a–P6d |

---

## 10. Test

- **P6a:** token/Host/Origin sai → 403 mọi route; token chỉ ở fragment; SSE gửi sự kiện ledger theo thứ tự, `Last-Event-ID` nối lại không trùng/mất; nội dung độc hại hiện bằng text; server không ghi `.omni/runs/**`; daemon chưa chạy → UI bật như `omni squad run`.
- **P6b:** PTY giả qua seam `spawnPty`: input/resize đi đúng; scrollback vòng; hai tab — một tab gõ; CLI thoát → trạng thái; `node-pty` thiếu → UI vẫn chạy chế độ chỉ đọc.
- **P6c:** `inbox.post` idempotent theo `message_id`; tin vào ledger; MCP tool đọc + ack; hook đính tin một lần; ghi chú worker xuất hiện trong input lượt kế (không đổi `allowed_files`); không có route duyệt cổng.
- **P6d:** đọc transcript fixture thật (V41) của codex/claude; file lạ/hỏng → hạ cấp.
- Toàn bộ: `npm test` + một lượt `--test-concurrency=4`; không test nào cần `node-pty` thật hay trình duyệt.

---

## 11. Điều kiện xong P6 (DoD)

- [ ] `omni ui` trên macOS: sidebar + timeline đúng trạng thái một phiên squad đang chạy (cổng, task, reviewer).
- [ ] Orchestrator (codex hoặc claude) chạy trong PTY trên trình duyệt; đóng/mở tab attach lại được.
- [ ] `@orchestrator` tới được orchestrator (MCP hoặc hook) và vào ledger; `@worker-1` thành ghi chú lượt kế.
- [ ] Transcript orchestrator hiện trong timeline (codex và claude).
- [ ] Kiểm bảo mật: loopback, token, Host/Origin, không route duyệt cổng.
- [ ] Không có `node-pty` thì `omni ui` chỉ đọc vẫn chạy, các lệnh khác không đổi.
- [ ] `npm test` xanh trên macOS + một lượt dưới tải.
- [x] Phụ lục V39–V43 đã ghi (Phụ lục A); V44 còn Safari/Firefox (V45 sau macOS).

---

## Phụ lục A — Kết quả V39–V43 (macOS arm64, 2026-11-02)

Môi trường: Node 24.16.0, `node-pty` 1.1.0, `@xterm/headless` + `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, codex-cli 0.166.0, Claude Code 2.1.316. Thử trong một thư mục tạm có git; script thử để ngoài repo (scratchpad), không commit.

| # | Kết quả | Ghi chú cho P6b–P6d |
|---|---|---|
| V39 | **Đạt, có 1 bẫy.** `npm i node-pty@1.1.0` 1,7 s, không biên dịch: có prebuild `darwin-arm64`, `darwin-x64`, `win32-*`; Linux không có prebuild → `node-gyp rebuild`. Một optional dependency build hỏng: `npm i` và `npm i -g` vẫn exit 0, gói bị bỏ, `require` bắt lỗi được. **Bẫy:** tarball 1.1.0 đóng gói `prebuilds/darwin-*/spawn-helper` mode 644 → mọi `spawn` lỗi `posix_spawnp failed`; `chmod 755` là chạy. | `pty-host` kiểm `spawn-helper` có quyền chạy trước lần spawn đầu, tự `chmod` nếu được, không thì hạ cấp với thông báo rõ. Khai `node-pty` trong `optionalDependencies`. |
| V40 | **Đạt cả hai CLI.** Trong `node-pty` (render bằng `@xterm/headless`): TUI hiện đủ, màu 24-bit, alt-screen, resize reflow, một lượt thật (`V40-OK`), thoát sạch (claude `/exit` → 0; codex Ctrl-C ×2 → 0). Qua trình duyệt (SSE base64 + POST, xterm.js phục vụ từ `node_modules`): gõ phím, lượt thật, resize 110→44 cột cả hai CLI vẽ lại đúng, tải lại trang attach lại từ bộ đệm vòng. | (1) **Gửi Enter riêng:** gộp chữ + `\r` trong một lần ghi thì claude coi là dán → xuống dòng thay vì gửi; flush phím đang gom rồi ghi `\r` riêng. (2) **Lọc env:** chạy từ bên trong một phiên agent, biến `CLAUDECODE`/`CLAUDE_CODE_*` (vd. `CLAUDE_CODE_CHILD_SESSION`) làm claude tắt lưu transcript → `pty-host` xóa `CLAUDECODE`, `CLAUDE_*`, `AI_AGENT`, `MCP_*`, `CODEX_*` trừ khi người dùng đặt rõ. (3) Lần đầu mỗi thư mục cả hai CLI hỏi "trust this folder" — hiện trong pane PTY cho người dùng chọn, omni không tự chọn. |
| V41 | **Đạt.** claude: `~/.claude/projects/<cwd, ký tự ngoài [A-Za-z0-9-] → '-'>/<sessionId>.jsonl`; bản ghi `type: user|assistant` có `message.role`, `message.content` (chuỗi hoặc khối `text`/`tool_use`/`tool_result`), `uuid`, `parentUuid`, `timestamp`, `isSidechain`, `origin.kind: human`, `promptSource: typed`. File còn chứa `api-request-blob` (system prompt, nội dung CLAUDE.md…) → chỉ đọc `user`/`assistant`, bỏ `isMeta`/`isSidechain`. codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`; dòng đầu `session_meta` (`id`, `cwd`, `originator: codex-tui`); chữ sạch ở `event_msg` `item_completed` (`UserMessage`, `AgentMessage` `phase: final_answer`); `response_item` user còn chứa AGENTS.md/`environment_context` chèn vào → không dùng. | Gắn phiên: claude nhận `--session-id <uuid>` → omni chọn id khi spawn, biết đúng file. codex không có cờ đó → lấy từ stdin hook (`session_id`, `transcript_path`, xem V42), dự phòng: rollout mới nhất có `session_meta.cwd` = project và thời điểm ≥ lúc spawn; khi thoát codex in `codex resume <id>`. |
| V42 | **Đạt cả hai.** Hook `UserPromptSubmit` trả `{hookSpecificOutput:{hookEventName:'UserPromptSubmit', additionalContext}}` → model thấy ngay lượt đó (trả `PAPAYA-42`). stdin hook có `session_id`, `transcript_path`, `cwd`, `prompt` ở cả hai CLI. claude: hook project chạy luôn. **codex: hook project mới/đổi phải được duyệt trong TUI** ("Hooks need review": review / trust all / chạy không hook); chưa duyệt thì hook cài nhưng không chạy. | P6c: lệnh hook omni ghi phải **ổn định** (đổi lệnh = phải duyệt lại); lần đầu người dùng duyệt trong pane PTY; MCP `omni_dual_inbox` là đường kéo dự phòng khi hook chưa chạy. Hook cũng là nguồn gắn transcript cho V41. |
| V43 | **Đạt cả hai.** `claude --resume <id>` và `codex resume <id>` trong PTY mở lại đúng phiên (nhớ lượt trước: trả `V40-OK-AGAIN`), ghi tiếp vào cùng file transcript. | Đúng D18: resume theo id omni đã ghi, không `--last`. |
| V44 | **Một phần.** SSE + `Last-Event-ID` đã có test tự động (P6a) và thử trên Chromium (pane trình duyệt của app): nối lại, cookie sau khi bỏ token khỏi URL. Safari/Firefox chưa thử tay. | Thử tay Safari/Firefox ở lượt chạy thật P6. |

Phụ chú: lượt thử để lại cấu hình trust cho đúng thư mục tạm (claude `~/.claude.json`, codex trust thư mục + hook thử) — không chạm project thật.
