# Omni v4 Host Compatibility Registry

This directory contains the machine-readable compatibility matrix (`hosts.json`) and verified evidence logs for supported coding agent CLIs.

## Per-Host Status & Verified Evidence

| Host | Binary | Baseline Version | Help / Flags Verified | Contract Test Gate | Live Smoke Gate | Current Status | Known Limitations |
|---|---|---|---|---|---|---|---|
| **Codex** | `codex` | `0.150.1` | `--json`, `--strict-config`, `--ignore-user-config`, `--output-schema`, `--output-last-message`, `--skip-git-repo-check`, `--sandbox`, `--approve-for-me`, `--cd` | **PASSED** | **PASSED** on `win32-x64` | `first-class` on `win32-x64` | Requires exact installed version/platform match; structured result and workspace mutation are verified independently. |
| **Claude Code** | `claude` | `2.1.185` | `--print`, `--output-format`, `--json-schema`, `--permission-mode`, `--allowedTools`, `--session-id` | Not promoted | Deferred: account unavailable | `experimental` | Authentication is required before a fresh live qualification. |
| **Antigravity** | `agy` | `1.1.16` | `--print`, `--output-format`, `--json-schema`, `--mode`, `--sandbox`, `--add-dir`, `--print-timeout` | Not promoted | Not qualified end-to-end | `experimental` | Do not infer promotion from probe success or partial workspace mutation. |

---

## Promotion Rules

An adapter is classified into one of four statuses:

1. **`first-class`**:
   - The installed CLI version strictly matches `verifiedVersion`.
   - Every flag listed in `requiredFlags` is proven present in CLI `--help` output.
   - `contractVerified` is `true` (passes shared contract test suite).
   - `liveSmokeVerified` is `true` (completed approved smoke run on a real repository).
   - The current `${process.platform}-${process.arch}` is in `verifiedPlatforms`.

2. **`experimental`**:
   - The binary is executable and all required flags are present.
   - The version differs from `verifiedVersion`, or live smoke evidence has not yet been collected for the platform.
   - Requires explicit opt-in via `allowExperimental: true`.

3. **`incompatible`**:
   - The version cannot be parsed, one or more `requiredFlags` are missing, or the probe execution fails.

4. **`unavailable`**:
   - The binary does not exist on PATH or cannot be spawned.

> [!IMPORTANT]
> Editing `hosts.json` alone does not promote an adapter. Any promotion must be accompanied by exact dated test execution logs, model-cost approval, and platform verification records.

Smoke evidence is produced separately as dated JSON and Markdown. Promotion validation rejects stale host/version/platform mismatches and never edits `hosts.json` automatically.
