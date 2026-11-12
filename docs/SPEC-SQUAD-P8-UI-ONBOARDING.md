# SPEC-SQUAD-P8 — Squad onboarding in the web UI

Status: draft for review (2026-11-12). Base: `main` 7ffea7b (3.2.0).

## 1. Goal

A user who picks **Squad** in `omni init` lands in `omni ui` straight away and sets up roles, CLIs and models **on the web**. The terminal asks nothing squad-specific.

Everything else stays as it is:
- the core CLI (`omni init`, `skills`, `map`, `rules`, `agent-files`);
- the single-agent SDLC workflows (`>om-*`). A single-agent choice in `omni init` behaves exactly as today and never opens the UI.

## 2. What exists today (evidence)

| Piece | Today | File |
|---|---|---|
| `omni init` tool choice | `Dual mode` (pair `codex-agy`) plus single agents; no Squad entry | `lib/commands/init.js:165` |
| Squad bindings | `omni squad setup --bind <role>=<runtime>:<model>[:<effort>]`, or interactive prompts | `lib/squad/setup.js` `runSetup` |
| `omni ui` start | Exits with "chưa có .omni/squad — chạy omni squad setup trước" when `.omni/squad` is missing | `lib/commands/ui.js:32` |
| Binding editor on the web | `/api/bindings/preflight`, `/drafts`, `/apply` edit an **existing** setup only | `lib/ui/binding-service.js` |
| UI access | Loopback only; a per-start token after `#` in the URL | `lib/ui/server.js` |

## 3. Flow

1. `cd <project>` → `omni init` → choose **Squad (đội agent theo vai, cấu hình trên web)**.
2. init asks the questions it asks every user: SDLC mode, personal rules, agent-file visibility, and Project Map if the project already exists. It writes the shared files (§4). It asks nothing about roles, CLIs or models.
3. init starts `omni ui` in the same process and opens the browser. Use `--no-open` for headless use.
4. With no `.omni/squad/` present, the page opens in **setup mode** (§5).
5. When the user presses **Lưu**, the page runs the same setup as `omni squad setup`. It then switches to the normal workspace and starts the orchestrator, exactly like today's `omni ui`.

## 4. `omni init` changes

- Add the choice `{ title: 'Squad — đội agent theo vai (cấu hình trên web)', value: 'squad' }` as the first item, above `Dual mode`.
- **Files written:** squad writes the same files as `dual`: `CLAUDE.md` + `AGENTS.md` and `.omni/workflows/*`. The orchestrator may be claude or codex, and both read one of these. The orchestrator-specific hooks/MCP stay with `runSetup` (§5), because only then is the orchestrator runtime known.
- **Skipped questions:**
  - the `dualPair` question (the pair is chosen on the web);
  - the sub-agent question (squad has its own workers).
- **Manifest:** records `ide: 'squad'` so that `omni ui` and `omni skills` can tell squad projects apart. Wherever existing code reads `ide === 'dual'` and the same behaviour applies, it treats `squad` the same way. Each such site is listed in the implementation PR.
- **Last step:** call `handleUi({ open: options.open })` instead of printing the usual "next steps".
- **Interrupted UI start:** init's own files stay written. Running `omni ui` again resumes setup mode.

## 5. `omni ui` setup mode

### 5.1 Server

- `handleUi` no longer exits when `.omni/squad` is missing. It starts the server with `mode: 'setup'` and does **not** auto-start an orchestrator.
- `GET /api/state` returns `{ mode: 'setup' | 'workspace', ... }`. In setup mode, every workspace route (PTY, inbox, files, terminals) answers `409 SQUAD_SETUP_REQUIRED`.
- New routes. All of them are token-checked, loopback-only and same-origin, like the existing ones.
  - `GET /api/setup/runtimes` returns `registry.probeAll()` (reusing `omni squad runtimes`): for each runtime its version, login status and models with efforts. Results are cached for 60 s; `?refresh=1` re-probes.
  - `POST /api/setup/preflight` takes `{ preset: 'squad'|'dual', workers (squad 1..8, dual 1, from PRESETS), binds: { orchestrator, 'worker-1'.., reviewer? } }` and returns `checkBinding` errors and warnings, plus the trust verdict for the orchestrator runtime (`projectTrust`, read-only). It writes nothing.
  - `POST /api/setup/apply` takes the same body plus `{ displace: boolean }`. It calls `runSetup({ projectRoot, preset, workers, binds, yes: true, displace })`. On success it switches the server to `workspace` mode in place, without a restart: the file watchers and the PTY host start then. Then it auto-starts the orchestrator, unless the UI was started with `--no-start`.
    - `apply` refuses when `.omni/squad` already exists. After setup, edits go through the existing binding editor.
    - `apply` is idempotent per request id. A second apply while one is running gets `409`.
- No new authority: setup never approves a gate, writes no ledger event and does not start a daemon session.

### 5.2 Page

One screen with three blocks:

1. **Preset:** `Squad` (orchestrator + workers + reviewer) or `Dual` (orchestrator + 1 worker), and the worker count (squad only).
2. **One row per role:** CLI, model and effort selects, filled from `/api/setup/runtimes`.
   - A CLI that is missing or not logged in is shown disabled, with the exact command to fix it.
   - Defaults are the last-used bindings (`readUserDefaults`), the same ones `--yes` uses today.
3. **Check and save:**
   - **Kiểm tra** shows preflight errors and warnings inline, including the trust warning with its one-time fix.
   - The **displace** checkbox: "Chuyển skill không thuộc orchestrator vào `.omni/skills/.displaced` (không xoá)". Default on, as with `--yes` today.
   - **Lưu** applies the setup.

After a successful save the page shows a one-line **commit reminder**. With a git baseline, the coverage scout refuses untracked or modified files that setup just wrote (`AGENTS.md`, `CLAUDE.md`, `.codex/`, `.claude/`, `.gitignore`, `.mcp.json`; seen in DemoOm). omni never commits for the user.

## 6. Out of scope

- Approving gates on the web (gates stay human-only on a TTY; the embedded PTY already is one). This gets its own spec.
- Starting a task request from a web form, and showing results/preview on the web: these are the next specs.
- Headless browser runner for UI evidence.
- Windows/Linux live runs. Code stays portable and keeps the simulated win32 tests, following the existing OS-order decision.

## 7. Tests (`node:test`, written to fail first)

- **init:**
  - choosing `squad` writes the dual file set, records `ide: 'squad'`, skips the pair and sub-agent questions, and calls `handleUi` (stubbed);
  - every single-agent choice is unchanged (snapshot of the written paths).
- **ui:**
  - `handleUi` without `.omni/squad` starts in setup mode instead of exiting;
  - workspace routes answer `409 SQUAD_SETUP_REQUIRED`.
- **setup routes:**
  - `runtimes`: uses an injected registry and honours the cache;
  - `preflight`: reports errors and trust without writing a file;
  - `apply`: writes exactly what `runSetup` writes, switches the mode, refuses a second apply and an existing `.omni/squad`, and needs the token;
  - a cross-origin `POST` is refused.
- **Page:** a static check that the setup bundle has no route that approves a gate, matching the existing P6c test.

## 8. Done when

- `npm test` is green, both normal and loaded.
- A manual run on a fresh git project shows the whole flow: `omni init` → Squad → browser opens on setup mode → bind claude orchestrator + claude worker → Lưu → orchestrator starts in the page.
- `omni init` with a single agent shows no difference from 3.2.0.
- One Conventional Commit per sub-step: P8a init, P8b server setup mode, P8c page.

## 9. Open questions for the user

1. **Decided (user, 2026-11-12):** Squad sits **above** Dual mode in the init list; Dual mode stays.
2. Should init still ask "Manual / Auto" for squad? Proposed: yes. It sets the SDLC mode that `>om-*` workflows read, and that is unrelated to squad AUTO for gates.
