# Omni v4 Host Compatibility Registry

This directory contains the machine-readable compatibility matrix (`hosts.json`) and verified evidence logs for supported coding agent CLIs.

## Per-Host Status & Verified Evidence

| Host | Binary | Baseline Version | Help / Flags Verified | Contract Test Gate | Live Smoke Gate | Current Status | Known Limitations |
|---|---|---|---|---|---|---|---|
| **Codex** | `codex` | `0.147.0` | `--json`, `--strict-config`, `--ignore-user-config`, `--output-schema`, `--output-last-message`, `--sandbox`, `--approve-for-me`, `--cd` | **PASSED** (`test/v4/codex-adapter.test.ts`) | Opt-in required (`OMNI_V4_ALLOW_MODEL_COST=1`) | `experimental` | Requires `codex exec resume` for session continuity; model output strictly validated from result file. |
| **Claude Code** | `claude` | `2.1.185` | `--print`, `--output-format`, `--json-schema`, `--permission-mode`, `--allowedTools`, `--session-id` | **PASSED** (`test/v4/claude-adapter.test.ts`) | Opt-in required (`OMNI_V4_ALLOW_MODEL_COST=1`) | `experimental` | Tool capabilities derived dynamically from active tool policy (`writeTools`, `shellPatterns`). |
| **Antigravity** | `agy` | `1.1.16` | `--print`, `--output-format`, `--json-schema`, `--mode`, `--sandbox`, `--add-dir`, `--print-timeout` | **PASSED** (`test/v4/antigravity-adapter.test.ts`) | Opt-in required (`OMNI_V4_ALLOW_MODEL_COST=1`) | `experimental` | Requires outer `timeoutMs > 30000` and native print timeout strictly less than request deadline. |

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
