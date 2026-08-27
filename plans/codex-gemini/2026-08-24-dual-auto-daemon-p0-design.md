# Dual AUTO Authority Daemon P0 Design

**Date:** 2026-08-24

**Status:** User-approved design, pending written-spec review

**Incident source:** `C:\Users\TAV\.codex\attachments\d735ea5c-54f8-4725-ac04-ccf4e6356f50\pasted-text.txt`

## 1. Goal

Make `Dual + Codex + Agy + AUTO` an enforced runtime workflow instead of an optional prompt convention. After the user invokes `$om-think`, Omni must own the Dual session, route bounded work to Agy, preserve Codex architecture and final-QC authority, and refuse a valid completion when delegation or mandatory acceptance evidence is missing.

The implementation must run from Windows CMD, Windows PowerShell, Linux, and macOS on Node.js 20 or later. It must support greenfield directories without Git, never initialize or mutate Git automatically, and fail closed when the authority daemon or a mandatory quality capability is unavailable.

## 2. Incident Findings

The AI4Teacher session proved that initialization alone is insufficient:

- the manifest correctly recorded `mode: auto`, `dualPair: codex-agy`, and the Agy worker policy;
- the native Dual skills were installed;
- Codex still implemented every task directly;
- no Dual transaction or Agy call was created;
- Bash-only setup instructions stopped AUTO on Windows;
- browser QA was recorded as `SKIP` while the summary incorrectly reported `Blocked: 0`;
- three quality cycles and todo state depended on agent bookkeeping rather than durable state.

The immediate trigger was agent non-compliance. The product root cause was the absence of a machine-owned session authority and completion gate.

## 3. Approved Decisions

1. Use a long-running, workspace-scoped Omni Node.js daemon as the Dual session and quality authority.
2. Do not depend on the experimental Codex app-server daemon. The installed Codex CLI 0.149.1 exposes stable hooks and MCP support; Omni must integrate through verified stable surfaces and its own daemon.
3. Use both Codex hooks and a stdio MCP bridge. Hooks enforce lifecycle boundaries; MCP exposes explicit session and task operations.
4. If required hook denial, hook trust, MCP, daemon health, or ledger integrity cannot be verified, the Dual AUTO session is `BLOCKED`. It never degrades to prompt-only success.
5. Support two baseline backends behind one interface:
   - `git`: existing repository with an established `HEAD`;
   - `snapshot`: immutable filesystem fingerprint for greenfield directories without Git.
6. Never run `git init`, `git add`, `git commit`, `git push`, `git stash`, `git reset`, or deployment commands automatically.
7. Treat mandatory UI browser QA as fail-closed. `UNAVAILABLE`, `BLOCKED`, or `FAILED` prevents completion. `OPTIONAL_SKIPPED` is valid only when the gate was declared optional in the approved spec before execution.
8. Replace Bash-only `setup.sh` orchestration with typed, platform-neutral setup actions executed by Node with explicit executable and argv records.
9. Keep `gemini-3.7-flash-high`, effort `high`, and the approved Agy `--dangerously-skip-permissions` policy. Codex retains final QC and all commit/push authority.

## 4. Threat and Trust Boundary

This daemon enforces workflow integrity, ownership, evidence, and completion semantics. It is not an operating-system security boundary against a hostile process running as the same user.

If a user launches Codex outside the generated trusted hooks/MCP configuration, edits files with another program, kills the daemon, or modifies runtime files, Omni may not prevent the filesystem mutation. It must detect the divergence through baseline fingerprints and refuse `VERIFIED` or release-qualified status.

No design claim may state that the daemon can make arbitrary same-user filesystem writes impossible.

## 5. Process Topology

```text
Codex hooks ----+
Codex MCP ------+--> Omni workspace daemon ---> Agy worker process
Omni CLI -------+            |
                             +-- session/task state machine
                             +-- append-only evidence ledger
                             +-- Git or snapshot baseline
                             +-- leases and ownership
                             +-- quality and acceptance gates
```

### 5.1 Workspace daemon

The daemon is a Node.js 20+ process scoped to one canonical workspace root. It starts on demand for a Dual AUTO session and exits after a configurable idle period when there are no active tasks or leases. It is not installed as a permanent OS service.

The daemon owns:

- session and task identifiers;
- owner and phase transitions;
- baseline identity and diff fingerprints;
- Agy process launches;
- quality-cycle records;
- acceptance gate results;
- completion receipts;
- append-only transaction events.

### 5.2 IPC

The initial P0 transport is loopback HTTP with JSON requests on a dynamically allocated `127.0.0.1` port. WebSocket support is out of scope.

Runtime discovery data lives under `.omni/runtime/` and contains the workspace identity, PID, start time, port, protocol version, and a random bearer token. Runtime files are excluded from source baselines and transaction diffs. On POSIX, token files use owner-only permissions. On Windows, Omni applies the strongest owner-only ACL supported by the host and reports a blocking configuration error if it cannot establish the required local protection policy.

Every request includes protocol version, workspace identity, session ID where applicable, and bearer authentication. The daemon rejects requests for another canonical workspace even when the token is valid.

### 5.3 Single instance

The daemon acquires a workspace lock with exclusive creation. A lock records PID, start time, workspace identity, and daemon endpoint. A contender must verify both PID liveness and an authenticated health response before deciding the lock is active. It may reclaim a stale lock only when the process is absent or the recorded process identity no longer matches.

## 6. Activation and Enforcement Flow

1. A generated session-start hook performs capability preflight and starts or connects to the workspace daemon.
2. Invocation of `$om-think` opens a Dual session through the native Omni skill/MCP operation. A user-prompt hook provides a second activation signal when that hook capability is available and verified.
3. Codex completes the requirements interview and registers the approved design and task graph with the daemon.
4. The router assigns each task one of:
   - `AGY_OWNED`: daemon invokes Agy; Codex source mutation is denied;
   - `CODEX_OWNED`: Codex may mutate only the declared scope;
   - `CODEX_QC`: Codex may inspect, run deterministic verification, and record the final verdict.
5. A verified pre-tool hook asks the daemon before source-writing tools or mutating shell commands execute. The daemon returns allow or deny from task owner, phase, scope, and lease state.
6. A post-tool hook records observed mutations and refreshes the workspace diff fingerprint. It is detection and evidence, not retroactive prevention.
7. A stop hook asks the daemon for a completion receipt. The daemon refuses when task, quality-cycle, delegation, review, or acceptance evidence is incomplete.
8. Omni `check`, `pass`, `ship`, and Dual status commands query the same authority. They cannot report a release-qualified success without a valid daemon-derived completion record.

P0 acceptance must prove the exact hook request/response contract against the supported Codex CLI. Hook event names or denial semantics inferred from third-party output are assumptions until the contract test passes. If the installed host lacks a required blocking hook, Dual AUTO fails capability preflight instead of silently reducing enforcement.

## 7. State Model

### 7.1 Session states

```text
DISCOVERED -> CAPABILITY_SAFE -> INTERVIEWING -> PLANNED
           -> EXECUTING -> ACCEPTANCE -> VERIFIED
```

Any non-terminal state can transition to `BLOCKED` on a fail-closed error. `VERIFIED` is terminal for the approved plan version and baseline identity. A changed plan or baseline creates a new revision rather than rewriting the verified record.

### 7.2 Task states

```text
REGISTERED -> ROUTED
           -> AGY_SCOUT -> AGY_IMPLEMENT -> SCOPE_VALID -> AGY_REVIEW -> CODEX_QC
           -> CODEX_IMPLEMENT -> CODEX_QC
           -> TASK_VERIFIED
```

Architecture, security, migration, broad cross-module, or ambiguous tasks remain Codex-owned. Agy receives bounded tasks with at most three production files, typed validation commands, and no commit/push/deploy authority.

### 7.3 Durable authority

Append-only NDJSON events are the durable authority. Derived JSON summaries are replaceable caches. Each event includes schema version, session/task ID, monotonic sequence, causation ID, phase, owner, plan revision, baseline identity, timestamp, and hashes of referenced artifacts.

Runtime port/token/heartbeat data is ephemeral and never authorizes a durable transition by itself.

## 8. Baseline Backends

Both backends implement:

```text
capture() -> BaselineIdentity
diff(baseline) -> ChangedPath[]
fingerprint(baseline) -> sha256
assertScope(changes, allowedFiles, denyPatterns) -> ScopeVerdict
```

### 8.1 Git backend

The Git backend records canonical repository root and `HEAD`, reads NUL-delimited status/diff output, and preserves the existing fail-closed checks for stale commits, dirty source changes, path traversal, symlink/junction escape, and review-time mutations.

### 8.2 Snapshot backend

The snapshot backend records normalized repository-relative paths, file type, size, and SHA-256 content hashes, then derives a deterministic root hash. It excludes `.omni/runtime/`, transaction raw output, `.git/`, dependency caches such as `node_modules/`, generated build directories declared by policy, and OS/editor temporary files.

Changes are calculated in Node.js as created, modified, or deleted paths. Existing files outside allowed scope are never automatically deleted or restored. Rollback is an explicit, separately authorized operation; normal failure preserves evidence and blocks the transaction.

If the user later creates a Git repository and initial commit, `omni dual baseline promote` may switch future transactions to Git only after verifying that the committed tree corresponds to the accepted snapshot workspace. Promotion never creates the commit.

## 9. Agy Execution

The daemon reuses the existing typed Agy runner and output adapter:

- `child_process.spawn` with explicit argv and `shell: false`;
- repo-relative materialized prompt/schema files;
- `gemini-3.7-flash-high` and effort `high`;
- `plan` mode for scout/review and `accept-edits` for implementation;
- `--dangerously-skip-permissions` from the first worker phase;
- immutable stdout, stderr, metadata, schema, and input evidence;
- local schema validation before any state transition;
- bounded retry only for classified transient transport failures.

Agy review is advisory. Only Codex can record the independent QC verdict.

## 10. Platform-Neutral Setup

Planning emits a typed setup manifest rather than `setup.sh`:

```json
{
  "program": "npm",
  "args": ["install"],
  "cwd": ".",
  "kind": "package-manager"
}
```

The setup runner resolves only supported program kinds. Native executables are launched directly. On Windows, package-manager `.cmd` wrappers are not assumed to be safely executable with `shell: false`; the resolver must select a verified native executable or the package manager's Node CLI entry point. Unknown wrappers, shell operators, command strings, redirections, and inline pipelines are rejected.

Package-manager detection uses the approved spec first, then a deterministic lockfile mapping. Conflicting lockfiles are `BLOCKED`. Setup failures record stdout/stderr/exit code and remain resumable without asking the user to translate Bash manually.

## 11. Quality Cycles and Acceptance

For `N` registered implementation tasks, quality cycles trigger after verified task counts:

- cycle 1: `ceil(N / 3)`;
- cycle 2: `ceil(2N / 3)`;
- cycle 3: `N`.

Each cycle record contains the plan revision, completed task IDs, baseline/diff fingerprint, gate commands, exit codes, durations, fix attempts, and verdict. The next task slice cannot begin until the current required cycle is `PASSED`. Each cycle allows at most three bounded fix attempts.

Gate statuses are:

- `PASSED`: executed and satisfied;
- `FAILED`: executed and failed;
- `BLOCKED`: a prerequisite or external condition prevents execution;
- `UNAVAILABLE`: the required tool/runtime does not exist or cannot start;
- `OPTIONAL_SKIPPED`: omitted only because the approved design declared it optional.

Mandatory `FAILED`, `BLOCKED`, or `UNAVAILABLE` gates prevent `TASK_VERIFIED`, session `VERIFIED`, and shipping. UI projects require real browser evidence for the approved viewport and reduced-motion matrix. Missing browser runtime is `UNAVAILABLE`, not `SKIP`.

## 12. Recovery and Leases

An active task lease renews every 10 seconds and expires after 30 seconds. Only the lease owner can request a phase transition. Lease expiry does not imply failure or success; it permits recovery after evidence replay.

On restart, the daemon:

1. authenticates the workspace and acquires the single-instance lock;
2. replays the append-only event ledger;
3. verifies referenced artifact hashes and monotonic transitions;
4. classifies incomplete attempts as interrupted;
5. recalculates the current Git or snapshot diff;
6. blocks on unexplained mutation;
7. resumes from the last durable successful phase without repeating successful Agy calls.

The daemon never stashes, resets, reverts, commits, pushes, or deletes user source during recovery.

## 13. Component Boundaries

Planned focused modules:

- `daemon-server.js`: lifecycle, loopback RPC, authentication, health;
- `daemon-lock.js`: single instance and stale-lock recovery;
- `session-store.js`: session/task/lease events and derived state;
- `baseline-git.js`: Git-backed baseline adapter;
- `baseline-snapshot.js`: greenfield fingerprint/diff adapter;
- `hook-bridge.js`: hook stdin/stdout contract and daemon client;
- `mcp-server.js`: stdio MCP tools backed by daemon RPC;
- `setup-runner.js`: typed setup action resolution and execution;
- `quality-ledger.js`: cycle thresholds, attempts, gate records;
- `ui-gate.js`: browser capability and required evidence contract.

Existing `lib/dual/` contracts, Agy runner, artifacts, scope guard, and orchestrator are reused or adapted; they are not duplicated inside the daemon.

## 14. Codex and Agy Ownership

Codex owns:

- public contracts and state-transition authority;
- security and trust boundaries;
- deterministic task routing;
- hook capability verification;
- integration across daemon, current Dual orchestrator, and CLI;
- independent tests and final QC;
- all commit/push decisions.

Agy receives bounded implementation slices for:

1. daemon lifecycle, lock, and loopback RPC;
2. snapshot baseline engine;
3. platform-neutral setup resolver;
4. quality ledger and UI gate;
5. hook client and MCP bridge.

Each Agy slice has no more than three production files, explicit tests, an allowed-file list, and a Codex review gate. Agy never changes architecture contracts, self-approves a result, commits, pushes, or deploys.

## 15. Verification Strategy

### 15.1 Deterministic tests

- daemon single-instance, token rejection, workspace mismatch, idle shutdown;
- stale lock, expired lease, interrupted phase, event replay and hash corruption;
- hook allow/deny/timeout behavior with fail-closed daemon loss;
- MCP initialization and tool contract validation;
- Git and snapshot backends producing equivalent changed-path verdicts;
- create/modify/delete, Unicode, spaces, case behavior, symlink/junction escape;
- setup argv resolution on Windows, Linux, and macOS without shell strings;
- quality thresholds for small and uneven task counts;
- mandatory `UNAVAILABLE` and `BLOCKED` preventing completion;
- Agy phase idempotency, scope violation, review mutation, malformed output;
- bypass mutation detected by fingerprint mismatch.

### 15.2 Host capability tests

The supported Codex adapter must prove against the installed host:

- project hooks are discovered and trusted;
- the pre-mutation hook can deny a controlled write attempt;
- post-tool and stop hooks receive the documented input and produce accepted output;
- loss of daemon connectivity blocks the controlled completion attempt;
- stdio MCP tools initialize and correlate with the same workspace daemon.

No release claim may be based solely on generated hook JSON or source tests.

### 15.3 CI and live smoke

Fake-only CI runs on Windows, Ubuntu, and macOS with Node.js 20 and the current LTS. Live smoke is separately opt-in and records exact Codex, Agy, model, OS, Node, hook, MCP, and browser runtime versions.

The AI4Teacher acceptance scenario must be rerun in a fresh greenfield directory. Passing requires at least one Agy transaction, Codex-owned architecture evidence, Codex final QC, three durable quality cycles, real browser QA at 390/768/1024/1440 plus reduced motion, and no automatic commit/push/deploy.

## 16. Acceptance Criteria

1. `$om-think` creates a daemon-owned Dual session before implementation begins.
2. A Codex source-write attempt during an `AGY_OWNED` task is denied by a verified hook contract.
3. Missing daemon, untrusted hooks, MCP failure, or hook contract mismatch blocks Dual AUTO.
4. A greenfield directory completes bounded Dual work using a snapshot baseline without Git initialization or commit.
5. Existing Git projects preserve HEAD and scope enforcement.
6. Windows setup requires neither Bash nor WSL; Linux and macOS require neither PowerShell nor CMD.
7. No setup or worker command embeds shell operators or raw contract JSON in argv.
8. Agy is invoked with the approved model, effort, permission policy, and phase mode.
9. Codex cannot obtain a valid completion record when required delegation evidence is absent.
10. The three quality cycles are derived from the durable task ledger and cannot be skipped by checkbox drift.
11. Mandatory browser QA marked `UNAVAILABLE` blocks the UI project.
12. Crash recovery does not repeat a successful model phase.
13. Scope violation, review mutation, unexplained filesystem mutation, or corrupt ledger blocks completion and preserves evidence.
14. Codex independently verifies accepted work and remains the only final-QC and commit/push authority.
15. Deterministic CI passes on Windows, Ubuntu, and macOS, followed by a successful fresh AI4Teacher live smoke.

## 17. Non-Goals

- Reimplementing the Codex app server, Codex sandbox, or OS access control.
- Treating the daemon as protection against a hostile same-user process.
- Supporting an unverified prompt-only fallback.
- Automatically creating or mutating Git history.
- Giving Agy architecture, security, migration, or final approval authority.
- Running live Codex/Agy/browser tests in default credential-free CI.
- Adding WebSocket IPC or installing a permanent OS service in P0.
