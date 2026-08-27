# Codex Windows Hook Launcher Design

## Problem

Dual AUTO emits an absolute Windows hook command in the form `"node.exe" "omni-hook.js"`. The command is valid in `cmd.exe` but PowerShell parses the second quoted path as an unexpected token and exits with code 1. As a result, every Codex hook event fails before `bin/omni-hook.js` starts.

## Approved design

- Keep the POSIX `command` unchanged for Linux and macOS.
- Emit the Windows `commandWindows` with PowerShell's call operator: `& "<absolute-node>" "<absolute-hook>"`.
- Keep absolute executable and script paths so a project-local `node.exe` cannot shadow the trusted runtime.
- Treat Windows Codex's hook shell as PowerShell; launching Codex from CMD remains supported because Codex selects the Windows hook command independently of the parent terminal.
- Add a Windows-only integration assertion that the generated command consumes a real hook payload and exits 0 under PowerShell. Keep static quoting assertions on every platform.
- Regenerate project hooks through Omni's existing config builder after the source test passes.

## Boundaries

- Do not change daemon, authority, AGY, timeout, or hook fallback behavior.
- Do not hide failures with `|| true` or equivalent.
- Do not commit, push, or deploy without separate authorization.
- Recovery of the externally deleted `E:\DemoSite` workspace is a separate user-authorized action.

## Acceptance

1. The pre-fix test fails because `commandWindows` lacks `&`.
2. The generated Windows command returns `{}` and exit 0 for a real `UserPromptSubmit` payload in PowerShell.
3. Existing init, Codex smoke, hook bridge, and Dual suites remain green.
4. `git diff --check` remains green.
