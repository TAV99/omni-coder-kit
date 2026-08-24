# Cross-Platform Codex–Agy Dual Orchestrator Design

**Date:** 2026-08-24

**Status:** Approved design

**Incident source:** `E:\DemoSite\docs\AI4TEACHER-DUAL-WORKFLOW-INCIDENT-REPORT.md`

## 1. Goal

Replace the generated PowerShell orchestration logic for `dual + codex-agy` with one maintained Node.js orchestrator exposed as `omni dual`. The workflow must run consistently from Windows CMD, Windows PowerShell, Linux shells, and macOS shells while Codex remains the manager and final verifier and Gemini 3.7 Flash High remains the bounded worker through `agy`.

The resulting workflow must remove manual prompt relay, survive interruption without repeating successful model calls, fail closed at every contract boundary, and preserve enough raw evidence to diagnose worker or transport failures.

## 2. Approved Decisions

- Use a Node.js orchestrator inside the Omni package. Do not implement separate orchestration logic per shell.
- Support Node.js 20 and later on Windows, Linux, and macOS.
- Expose the workflow through `omni dual`; npm supplies the Windows command shim and Unix executable entry point.
- Keep `ai-flow.ps1` only as a temporary compatibility shim that delegates to `omni dual phase` and prints a deprecation notice.
- Invoke child processes with an argv array and `shell: false`.
- Use `gemini-3.7-flash-high` with effort `high`.
- For the supported `codex-agy` pair, invoke Agy with `--dangerously-skip-permissions` from the first worker phase. This authority is project workflow policy, not permission to alter global Agy configuration.
- Codex owns task specification, architecture, routing authority, scope enforcement, final validation, and all commit/push decisions.
- Agy may scout, implement, and review only within the bounded transaction contract.
- Normal tests never call a live model. Live Agy smoke tests require a separate explicit opt-in and credentials.

## 3. Root Causes Addressed

The incident exposed failures at four independent boundaries:

1. **Transport:** PowerShell 5.1 string-based process arguments corrupted prompts containing quotes, JSON, Unicode, or multiline content.
2. **Workspace:** `--add-dir` did not guarantee that Agy treated the repository as its artifact root, allowing scratch-workspace paths and edits.
3. **Evidence:** Agy envelope status and final structured payload could disagree, while implement and review lacked strict schema enforcement and complete raw logs.
4. **State:** A monolithic script allowed stale preflight data, route-before-Scout behavior, repeated expensive calls, and ambiguous recovery after interruption.

The redesign fixes these boundaries independently rather than extending the existing monolithic PowerShell script.

## 4. Architecture

```text
Codex native $om-* skill
          |
          v
omni dual new|run|resume|status|phase
          |
          +-- transaction state machine
          +-- Git and workspace guards
          +-- schema/evidence validator
          +-- Agy transport (Node spawn, argv, shell:false)
          +-- scope and diff verifier
          |
          v
agy --model gemini-3.7-flash-high --effort high
          |
          v
Gemini bounded scout / implement / review
```

### 4.1 Module boundaries

The implementation will introduce focused modules under `lib/dual/`:

- `orchestrator.js`: coordinates public commands and requests state transitions; it does not parse native Agy output or construct platform-specific command strings.
- `state-store.js`: owns append-only transaction events, attempt numbering, idempotency, and derivation of current state.
- `agy-runner.js`: constructs argv, launches Agy with `shell: false`, captures output, applies process timeout, and returns an untrusted transport result.
- `agy-output.js`: extracts candidate payloads from supported Agy envelopes and reports compatibility warnings.
- `contracts.js`: validates request, context, spec, route, evidence, review, and raw-attempt metadata.
- `workspace.js`: resolves the canonical Git root, checks base commit and source cleanliness, validates repo-relative paths, and rejects workspace escape.
- `scope-guard.js`: compares Git changes with `allowed_files`, detects review mutations, and produces fail-closed scope verdicts.
- `artifacts.js`: materializes versioned prompt/schema inputs for each attempt and writes immutable raw evidence.

Each module exposes data-only inputs and outputs so it can be tested without invoking a shell or live model.

### 4.2 CLI surface

```text
omni dual new <task-id>
omni dual run <task-id>
omni dual resume <task-id>
omni dual status <task-id>
omni dual phase <phase> <task-id>
```

- `new` verifies that the current directory belongs to a Git repository with an existing commit and no source changes, then creates a transaction skeleton.
- `run` advances through every currently valid automatic phase and stops at Codex ownership, a blocking failure, or Codex QC handoff.
- `resume` derives the last durable state and advances without repeating successful phases.
- `status` reports current state, owner, base commit, attempt counts, last failure, and the exact next command.
- `phase` is the low-level recovery/debug interface and enforces the same transition rules as `run`.

## 5. Transaction and Artifact Contract

Each task lives under:

```text
.omni/codex-gemini/runs/<task-id>/
  request.md
  spec.json
  context.json
  route.json
  evidence.json
  review.json
  events.ndjson
  state.json
  raw/
    <phase>.<attempt>.input.md
    <phase>.<attempt>.schema.json
    <phase>.<attempt>.meta.json
    <phase>.<attempt>.stdout.json
    <phase>.<attempt>.stderr.txt
```

`events.ndjson` is the transaction authority. `state.json` is a replaceable derived cache and cannot authorize a transition by itself. Successful semantic artifacts are written by the orchestrator, never by the worker.

Every durable event and semantic artifact carries:

- schema version;
- task ID;
- canonical repository identity;
- expected base commit;
- phase and attempt number;
- Omni package version;
- timestamp;
- hashes of the materialized input and schema where applicable.

Raw attempt files are immutable. A retry receives a new attempt number instead of overwriting prior evidence.

### 5.1 Spec contract

`spec.json` must contain:

- `schema_version`;
- `task_id`;
- `expected_base_commit`;
- `goal`;
- `allowed_files` as normalized repo-relative paths;
- `deny_patterns`;
- `validation_commands` as typed executable-plus-argv records, not shell command strings;
- `risk_flags`;
- `permission_authority` identifying the approved Dual bypass policy.

The router assigns Gemini only when the spec is complete, has at most three allowed files, includes validation commands, and has no architecture, security, migration, cross-module, or ambiguity risk. Every other task remains Codex-owned.

## 6. Workspace Contract

- The repository root is resolved from `git rev-parse --show-toplevel` and canonicalized with real-path semantics.
- A transaction requires an existing `HEAD`; Omni never initializes or commits a repository automatically.
- `new` records the base commit before creating transaction files.
- Preflight rejects source changes outside the current transaction directory.
- Agy is started with `cwd` set to the canonical repository root plus `--new-project` and `--add-dir <repoRoot>`.
- Worker outputs may contain only normalized repository-relative paths.
- Absolute paths, drive-qualified paths, UNC paths, `..` traversal, and symlink/junction escapes are rejected.
- Codex-side validation resolves every worker-reported path and verified symbol against the local repository before routing.
- Implement starts only when `HEAD` still equals `expected_base_commit` and there are no pre-existing source changes.
- After implement, changes are allowed only in `allowed_files`.
- Review starts from the exact post-implement diff fingerprint and must leave that fingerprint unchanged.
- Scope violations are preserved for investigation and never auto-reverted.

## 7. Agy Transport Contract

Production execution uses Node's child-process API with an explicit executable and argv array. Shell interpolation, command strings, and raw JSON prompt embedding are forbidden.

Every worker invocation includes:

- `--new-project`;
- `--add-dir <canonical repo root>`;
- `--model gemini-3.7-flash-high`;
- `--effort high`;
- phase-appropriate `--mode plan|accept-edits`;
- `--dangerously-skip-permissions`;
- `--output-format json`;
- `--json-schema <materialized attempt schema>`;
- a short `-p=<instruction>` that references the materialized repo-local input file.

The complete request/spec/evidence JSON is never placed in argv. The orchestrator builds a versioned input file from bundled Omni templates and transaction artifacts, hashes it, and gives Agy a short instruction to read that file.

The transport records redacted argv, working directory, Agy version, start/end timestamps, elapsed time, exit code, timeout state, stdout, and stderr. Permission bypass is recorded as enabled, but no credentials or unrelated environment values are persisted.

Default phase timeouts are explicit and configurable within bounded limits. A timeout terminates the child process, records the attempt, and returns a blocking transport result; it is never reported as empty success.

## 8. Evidence and Compatibility Contract

The orchestrator validates every payload locally against the materialized schema after Agy returns.

Payload extraction order is:

1. native `structured_output`;
2. exact JSON in the known `response` field for the compatibility window;
3. fenced JSON in `response` only as a measured legacy fallback.

The process exit code must be zero. A non-zero process exit is always a transport failure even if stdout contains a candidate payload.

An outer `ERROR` with exit code zero may be accepted only when the final extracted payload passes the exact local schema. Such an attempt is recorded as `accepted_with_warning` with the original envelope status and extraction mode. Missing fields, invalid enums, malformed JSON, prose-only output, or a payload that fails schema validation remains a hard failure.

Compatibility fallbacks are isolated in `agy-output.js`, covered by metrics/tests, and must not weaken the state machine. Fenced JSON support is eligible for removal after two consecutively verified Agy versions produce native structured output for all three worker phases.

## 9. State Machine

```text
NEW
  -> PREFLIGHT_SAFE
  -> SCOUT_VALID
  -> SPEC_VALID
  -> ROUTED
     -> CODEX_OWNED
     or
     -> IMPLEMENT_VALID
     -> SCOPE_VALID
     -> REVIEW_VALID
     -> CODEX_QC
```

Rules:

- A route cannot be created before both Scout output and the task spec validate against the same base commit.
- A Gemini-owned implement cannot start from a Codex-owned or incomplete route.
- Review cannot start before implementation evidence and scope validation succeed.
- Gemini review is advisory and cannot mark a task complete.
- `CODEX_QC` is a handoff state. Codex independently inspects the diff and reruns validation commands from the repository source.
- No phase commits, pushes, deploys, modifies global configuration, or authorizes release.
- A stale artifact, mismatched task ID/base commit, invalid event sequence, or changed repository identity blocks the transaction.

## 10. Recovery and Idempotency

- A successful phase is idempotent. Reissuing it returns the existing durable result without launching Agy.
- `resume` replays `events.ndjson`, verifies referenced artifact hashes, and continues from the last valid phase.
- Automatic transport retry is limited to two attempts and only covers timeout or classified transient network interruption.
- Schema failure, permission failure, workspace escape, stale base commit, scope violation, and review mutation never auto-retry.
- Each retry records its reason and receives a new immutable attempt.
- Repeated failure with no state progress stops as `BLOCKED`; no unlimited loop is allowed.
- A crash after raw output but before semantic artifact persistence is recoverable: resume validates the raw attempt and either finalizes it once or starts a new attempt according to the recorded event boundary.
- The orchestrator never stashes, resets, reverts, deletes, commits, or pushes user changes during recovery.

## 11. Native Skill Behavior

For `dual + auto + codex-agy`, `$om-think` remains the user entry point. After design/spec/plan preparation, Codex creates bounded task transactions and calls one `omni dual run <task-id>` command per task. It does not manually relay Agy prompts or reproduce worker exploration in Codex context.

The native skill must:

- let deterministic routing keep architectural/high-risk work with Codex;
- delegate eligible Scout/implementation/review work to Gemini;
- read compact transaction summaries instead of injecting raw worker transcripts into Codex context;
- perform independent Codex QC after `CODEX_QC` handoff;
- request separate authority before commit or push.

Manual Dual mode keeps explicit phase control through `omni dual phase` while sharing the same contracts and guards.

## 12. Cross-Platform Testing

### 12.1 Unit tests

- argv preserves empty strings, spaces, quotes, backslashes, Unicode, and multiline logical input without shell parsing;
- task IDs and repository-relative paths reject every escape form on Windows and POSIX;
- symlink/junction resolution cannot escape the repository;
- schemas reject missing fields, invalid enums, unexpected shapes, and cross-task/base artifacts;
- state transitions reject skipped, duplicate, stale, and out-of-order events;
- payload extraction covers native success, outer `ERROR` plus valid payload, malformed output, empty output, and legacy fallback warnings;
- scope comparison rejects files outside the allowlist and review-time mutations.

### 12.2 Fake-Agy integration tests

The test worker is a Node.js fixture, not a PowerShell script. It supports deterministic scenarios for:

- native structured success;
- outer `ERROR` with schema-valid final payload;
- malformed or empty JSON;
- permission denial;
- timeout and forced termination;
- scratch/absolute path output;
- worker edit outside scope;
- review source mutation;
- resume after a completed phase without a repeated worker call.

### 12.3 End-to-end fixture

A temporary Git repository exercises:

```text
clean repository -> new -> preflight -> scout -> route -> implement
-> scope validation -> review -> CODEX_QC handoff
```

The test verifies task/base correlation, immutable attempts, exact allowed changes, raw evidence completeness, idempotent resume, and absence of commit/push/global configuration mutations.

### 12.4 CI matrix

Run the deterministic suite on:

- `windows-latest`;
- `ubuntu-latest`;
- `macos-latest`;
- Node.js 20 plus the current Node.js LTS.

Linux and macOS execution must not require PowerShell. Normal CI never runs a live model. A live Agy smoke workflow requires an explicit manual/secret-gated opt-in and records the exact Agy/model version used.

## 13. Acceptance Criteria

1. `$om-think` in Dual Auto creates bounded specs and invokes `omni dual run` without manual prompt relay.
2. The same workflow entry points operate from Windows CMD, Windows PowerShell, Linux, and macOS.
3. No raw request/spec/evidence JSON is embedded in process command-line arguments.
4. Agy cannot establish a scratch workspace as the source of repository paths or accepted edits.
5. Route cannot run before preflight, Scout, and spec validation succeed for the same base commit.
6. Implement cannot be accepted when Git changes include a path outside `allowed_files`.
7. Review cannot be accepted if it changes the post-implement diff.
8. Every worker phase records complete raw evidence and locally validates its structured payload.
9. `resume` never repeats a successful model phase and can recover from a process interruption at a durable boundary.
10. Permission bypass is present for the approved Dual worker invocation but no global Agy setting is changed.
11. Codex independently runs final QC and retains exclusive commit/push authority.
12. Deterministic unit, integration, and end-to-end tests pass on Windows, Ubuntu, and macOS without live model cost.

## 14. Migration and Non-Goals

### Migration

- Newly initialized Dual projects use `omni dual` directly.
- Existing generated `ai-flow.ps1` remains as a delegating compatibility shim for one deprecation window.
- Existing run artifacts are not trusted implicitly. A migration/import path may read them only after schema, repository identity, and base-commit validation; otherwise users start a new transaction.
- Bundled prompt/schema versions are materialized per attempt, so project-local patches are no longer the maintained implementation source.

### Non-goals

- Automatically initializing Git, committing, pushing, deploying, or changing global Agy configuration.
- Giving Gemini architecture, security, migration, cross-module, or ambiguous tasks.
- Treating Gemini review as final approval.
- Auto-reverting worker changes after a failure.
- Making live model calls part of the default test suite.
- Maintaining separate orchestrators for PowerShell, CMD, Bash, and Zsh.
