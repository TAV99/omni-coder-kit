# External JavaScript Dogfood Gate 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Qualify Omni v4 against the pinned local `E:\demoSite` repository using a real Codex workspace-write run, deterministic independent gates, allowed-diff enforcement, and reproducible JSON/Markdown evidence.

**Architecture:** Keep case 15 disabled in the checked-in manifest and activate it only through an explicit runner/CLI override. Resolve the absolute external path and pinned revision from a strict Git-ignored local binding, stage only Git-tracked bytes into an owned temporary workspace, execute Codex, validate its structured outcome, then independently validate mutation scope, secrets, typecheck, test, and build before accepting the case.

**Tech Stack:** TypeScript 5.x build target, Node.js 20+, Zod, Node test runner, Git CLI with `shell:false`, Codex CLI 0.150.1, React/Vite/Vitest target repository.

## Global Constraints

- Checked-in manifest keeps external slots disabled; activation is runtime-only and exact-case-ID based.
- Absolute machine paths and local toolchain values live only in `.omni/v4/benchmarks/external-bindings.json` and are never committed.
- Source repository must be clean, have a commit, and have `HEAD` exactly equal to the binding revision.
- Stage only files reachable from the pinned Git tree; never stage `.git`, untracked files, `.env*`, `.omni`, `node_modules`, `dist`, credentials, or machine-local configuration.
- Every subprocess is `{command,args,cwd,timeoutMs}` with `shell:false`; no shell command strings.
- Live execution requires all three existing cost approvals plus exact runtime activation.
- Adapter output must parse with `StepResultSchema`, have matching `executionId`, and have `status === "succeeded"`.
- A successful adapter response without an allowed source mutation fails closed.
- Never call the production waitlist endpoint; all test networking remains mocked or local.
- Do not push, tag, deploy production, or promote compatibility.

---

### Task 0: Make the benchmark baseline reproducible from a clean checkout

**Files:**
- Track: `.omni/sdlc/requirements.md`
- Track: `benchmarks/v4/fixtures/pass-all/.omni/sdlc/requirements.md`
- Track: `benchmarks/v4/fixtures/pass-all/.omni/v4/quality.json`
- Modify: `.gitignore`
- Test: `test/v4/requirements-traceability.test.ts`
- Test: `test/v4/benchmark-runner.test.ts`

**Interfaces:**
- Produces: a clean worktree containing every immutable input consumed by the v4 test suite.
- Preserves: `.omni/**` ignored except the three explicit immutable inputs above.

- [x] **Step 1: Record the existing RED evidence**

Run: `npm run test:v4`

Expected: FAIL with `ENOENT` for `benchmarks/v4/fixtures/pass-all` and `.omni/sdlc/requirements.md`.

- [x] **Step 2: Add narrow ignore exceptions and immutable files**

Append these rules after the final `.omni/` ignore:

```gitignore
!.omni/
.omni/*
!.omni/sdlc/
.omni/sdlc/*
!.omni/sdlc/requirements.md
!benchmarks/v4/fixtures/pass-all/.omni/
!benchmarks/v4/fixtures/pass-all/.omni/sdlc/
!benchmarks/v4/fixtures/pass-all/.omni/sdlc/requirements.md
!benchmarks/v4/fixtures/pass-all/.omni/v4/
!benchmarks/v4/fixtures/pass-all/.omni/v4/quality.json
```

Materialize the exact bytes already used by the primary checkout; do not regenerate requirement text.

- [x] **Step 3: Verify the repaired baseline**

Run: `npm run test:v4`

Expected: `196` tests, `0` failures, `2` skipped.

---

### Task 1: Define strict external binding and live-task contracts

**Files:**
- Create: `src/v4/benchmark/external-binding.ts`
- Modify: `src/v4/benchmark/contracts.ts`
- Test: `test/v4/benchmark-external-binding.test.ts`

**Interfaces:**
- Produces: `ExternalBindingFileSchema`, `ExternalCaseBinding`, and `loadExternalBindings(bindingPath: string): Promise<ExternalBindingFile>`.
- Produces: `BenchmarkLiveTaskSchema` with `prompt`, `allowedPaths`, `requiredCapabilities`, `sideEffect`, `timeoutMs`, `setupCommands`, `requirements`, and `gates`.
- Binding record: `{ repositoryRoot: string; revision: string; dependencyPolicy: "clean-install" | "existing-lockfile"; toolchain?: Record<string,string> }`.

- [ ] **Step 1: Write strict-schema tests**

Cover valid absolute Windows/POSIX roots, exact 40-hex revisions, strict unknown-key rejection, missing case binding, relative path rejection, and binding-file parse errors.

Run: `node scripts/run-v4-tests.cjs --test-name-pattern external_binding`

Expected: FAIL because `external-binding.ts` and live-task fields do not exist.

- [ ] **Step 2: Implement schemas and loader**

Use Zod `.strict()`, `path.isAbsolute`, bounded non-empty strings, `CapabilitySchema`, `SideEffectClassSchema`, and `GateDefinitionSchema`. Convert every parse/read failure to `QualityError("BENCHMARK_EXTERNAL_BINDING_INVALID", safeMessage)` without echoing file contents.

- [ ] **Step 3: Verify contract tests**

Run: `node scripts/run-v4-tests.cjs --test-name-pattern external_binding`

Expected: PASS.

---

### Task 2: Stage a clean pinned external Git tree

**Files:**
- Create: `src/v4/benchmark/external-workspace.ts`
- Test: `test/v4/benchmark-external-workspace.test.ts`

**Interfaces:**
- Produces: `inspectExternalRepository(binding): ExternalSourceMetadata`.
- Produces: `stagePinnedTrackedTree(binding, destination): Promise<ExternalSourceMetadata>`.
- `ExternalSourceMetadata`: `{ repositoryRoot; revision; isDirty: false; trackedFileCount; treeSha256 }`.

- [ ] **Step 1: Write repository safety tests**

Create temporary Git repos and assert rejection for no commit, dirty tracked/untracked state, stale binding revision, symlink/escape path, and excluded tracked paths. Assert a clean repo stages exact bytes while omitting `.git`, `.env`, `.omni`, `node_modules`, and `dist`.

Run: `node scripts/run-v4-tests.cjs --test-name-pattern external_workspace`

Expected: FAIL because staging functions do not exist.

- [ ] **Step 2: Implement pinned staging**

Invoke Git with `execFileSync("git", argv, {cwd, shell:false, windowsHide:true})`. Read names from `git ls-tree -r -z --name-only <revision>` and bytes from `git show <revision>:<path>`. Validate every destination path with containment checks before writing; calculate `treeSha256` from sorted `path + NUL + contentSha256` records.

- [ ] **Step 3: Verify staging tests**

Run: `node scripts/run-v4-tests.cjs --test-name-pattern external_workspace`

Expected: PASS.

---

### Task 3: Add exact runtime activation without mutating the manifest

**Files:**
- Modify: `src/v4/benchmark/runner.ts`
- Modify: `benchmarks/v4/manifest.json`
- Test: `test/v4/benchmark-runner.test.ts`
- Test: `test/v4/benchmark-manifest.test.ts`

**Interfaces:**
- Extend `BenchmarkRunnerOptions` with `activateCaseIds?: readonly string[]` and `externalBindingPath?: string`.
- Runtime enabled state is `case.enabled || activateCaseIds.includes(case.id)`; unknown IDs fail before workspaces or adapter calls.
- Case 15 remains `enabled:false` but declares the Codex live task contract and `liveModelCostOptIn:true`.

- [ ] **Step 1: Write activation tests**

Assert default run still skips exactly three external slots, activation affects only the exact requested case, unknown/duplicate activation IDs fail closed, and disabled cases cannot become live merely from environment/model-cost approval.

Run: `node scripts/run-v4-tests.cjs --test-name-pattern runtime_activation`

Expected: FAIL because runner has no activation options.

- [ ] **Step 2: Implement runtime activation and case 15 contract**

Declare prompt: `Change package.json so npm test runs Vitest once in deterministic CI mode. Add or adjust only directly necessary regression tests. Do not call any external endpoint.` Allowed paths: `package.json`, `src/components/WaitlistForm.test.tsx`. Required capabilities: `workspace.read`, `workspace.write`, `shell`, `structured-output`. Timeout: `180000` ms. Setup: `npm ci`. Gates: `npm run typecheck`, `npm test`, `npm run build`.

- [ ] **Step 3: Verify default and activated behavior**

Run: `node scripts/run-v4-tests.cjs --test-name-pattern "future_real_repo_slots|runtime_activation|fake_adapter_default"`

Expected: PASS with zero model calls in the default run.

---

### Task 4: Validate live adapter outcome before quality gates

**Files:**
- Modify: `src/v4/benchmark/runner.ts`
- Test: `test/v4/benchmark-runner.test.ts`

**Interfaces:**
- Parse `await adapter.execute(...)` using `StepResultSchema`.
- Use `operationId = live-exec-${case.id}` and require `result.executionId === operationId`.
- For external live tasks pass their prompt, capabilities, side effect, and timeout verbatim.

- [ ] **Step 1: Write malformed/failed/correlation tests**

Assert malformed output, `failed`, `blocked`, `cancelled`, or mismatched execution ID produce a failed case and zero independent gate executions. Assert the request is `workspace-write`, not `read-only`.

Run: `node scripts/run-v4-tests.cjs --test-name-pattern live_adapter_outcome`

Expected: FAIL because current runner discards adapter output.

- [ ] **Step 2: Implement fail-closed validation**

Import `StepResultSchema`; return stable errors `BENCHMARK_ADAPTER_RESULT_INVALID`, `BENCHMARK_ADAPTER_EXECUTION_MISMATCH`, or `BENCHMARK_ADAPTER_NOT_SUCCEEDED`. Preserve normalized native metadata for reporting.

- [ ] **Step 3: Verify adapter validation tests**

Run: `node scripts/run-v4-tests.cjs --test-name-pattern live_adapter_outcome`

Expected: PASS.

---

### Task 5: Enforce required mutation, allowed diff, fingerprint, and credential scan

**Files:**
- Extend: `src/v4/benchmark/external-workspace.ts`
- Modify: `src/v4/benchmark/runner.ts`
- Test: `test/v4/benchmark-external-workspace.test.ts`
- Test: `test/v4/benchmark-runner.test.ts`

**Interfaces:**
- Produces: `captureWorkspaceSnapshot(root): Promise<WorkspaceSnapshot>`.
- Produces: `compareWorkspaceSnapshots(before, after, allowedPaths): WorkspaceDiffEvidence`.
- `WorkspaceDiffEvidence`: `{ modifiedFiles; patchSha256; secretFindings }`.

- [ ] **Step 1: Write diff-security tests**

Assert zero mutation fails, exact allowed mutation passes, outside-scope mutation fails, generated dependency/build files are excluded, path deletion is fingerprinted, and credential-like assigned string values fail without including the secret in the error.

Run: `node scripts/run-v4-tests.cjs --test-name-pattern external_diff`

Expected: FAIL because snapshot/diff functions do not exist.

- [ ] **Step 2: Implement deterministic snapshot comparison**

Hash sorted regular files while excluding `.git`, `.omni`, `node_modules`, `dist`, coverage, and `.env*`. Reject symlinks. Fingerprint normalized change kind/path/beforeHash/afterHash. Run credential regexes only on changed UTF-8 text and report path plus rule ID, never matched values.

- [ ] **Step 3: Integrate before independent gates**

Capture after staging/setup and before adapter; compare immediately after adapter. Store evidence on `BenchmarkCaseResult.actual` and fail before gates when the mutation contract is violated.

- [ ] **Step 4: Verify diff-security tests**

Run: `node scripts/run-v4-tests.cjs --test-name-pattern "external_diff|live_adapter_outcome"`

Expected: PASS.

---

### Task 6: Wire external setup, CLI activation, real Codex adapter, and report metadata

**Files:**
- Modify: `src/v4/benchmark/runner.ts`
- Modify: `src/v4/benchmark/cli.ts`
- Modify: `src/v4/benchmark/report.ts`
- Modify: `scripts/run-benchmark.cjs`
- Test: `test/v4/benchmark-cli.test.ts`
- Test: `test/v4/report.test.ts`

**Interfaces:**
- CLI: `npm run benchmark:v4 -- --activate case-15-external-js-slot --bindings .omni/v4/benchmarks/external-bindings.json --allow-model-cost`.
- CLI creates `NodeProcessRunner` and `createAdapter(..., {hostId:"codex", tempDir})` for the activated case.
- Report records source metadata, adapter native metadata, `modifiedFiles`, `diffFingerprint`, commands, and binding hash while normalizing absolute binding paths.

- [ ] **Step 1: Write CLI/report tests**

Assert unknown flags fail, activation/binding/cost flags wire exact runner options, no flag keeps default offline behavior, and JSON plus Markdown show source revision and diff fingerprint without absolute source root.

Run: `node scripts/run-v4-tests.cjs --test-name-pattern "benchmark_cli|external_report"`

Expected: FAIL because CLI arguments and metadata fields do not exist.

- [ ] **Step 2: Implement argv parsing and adapter factory**

Parse only exact flags, require a bindings path with activation, keep the three-part cost gate, and construct Codex via `createAdapter` using `compatibility/v4/hosts.json` and an owned temporary adapter directory.

- [ ] **Step 3: Extend normalized report projection**

Include semantically relevant hashes, revision, diff, status, and command argv. Replace absolute roots with `<external-root>` in Markdown and normalized JSON.

- [ ] **Step 4: Verify CLI/report tests**

Run: `node scripts/run-v4-tests.cjs --test-name-pattern "benchmark_cli|external_report|reproducible"`

Expected: PASS.

---

### Task 7: Baseline `E:\demoSite` and run the real Codex dogfood

**Files in `E:\demoSite`:**
- Modify: `.gitignore`
- Baseline: all project source/config files except `.omni`, `.claude`, `.codex`, `node_modules`, `dist`, and `.env` runtime values
- Expected live mutation: `package.json`; optionally `src/components/WaitlistForm.test.tsx`

**Local-only file in Omni worktree:**
- Create ignored: `.omni/v4/benchmarks/external-bindings.json`

**Interfaces:**
- Baseline commit pins the exact revision used in the binding.
- Live report JSON is the authority artifact under `.omni/v4/benchmarks/<run-id>/report.json`.

- [ ] **Step 1: Prepare and verify the target baseline**

Add `node_modules/`, `dist/`, `.env`, `.env.*`, `!.env.example`, `.omni/`, `.claude/`, and `.codex/` to `.gitignore`. Run `npm ci`, targeted WaitlistForm tests, full deterministic test command, `npm run typecheck`, `npm run build`, and `npm audit --audit-level=high`.

- [ ] **Step 2: Create the authorized initial local baseline commit**

Inspect staged files and credential scan, then commit once with `chore: establish AI4Teacher dogfood baseline`. Do not push.

- [ ] **Step 3: Write the ignored binding with exact evidence**

Use repository root `E:\demoSite`, the full baseline SHA, dependency policy `clean-install`, and observed Node/npm versions.

- [ ] **Step 4: Run Gate 1 live**

Run with `OMNI_V4_ALLOW_MODEL_COST=1` and the CLI command documented in Task 6. The runner must stage the baseline, run `npm ci`, call Codex once, validate the diff, then run typecheck/test/build independently.

- [ ] **Step 5: Reconcile the report**

Require case status `passed`, final phase `DOCUMENT`, acceptance `accepted`, `falseSuccess=false`, at least three passed mandatory gates, non-empty allowed `modifiedFiles`, exact source SHA, non-empty diff fingerprint, adapter session/model metadata when available, and no secret findings.

- [ ] **Step 6: Run all three quality cycles**

Cycle 1: focused external benchmark tests. Cycle 2: `npm run typecheck:v4 && npm run build:v4 && npm run test:v4`. Cycle 3: `npm test`. Any failure is fixed through TDD up to three attempts; no gate is weakened.

## Self-review

- Spec coverage: Gate 1 baseline, clean pinned source, local binding, tracked-only staging, runtime activation, live structured validation, required mutation, allowed diff, credential scan, independent gates, evidence/report, and no endpoint call are each assigned to a task.
- Placeholder scan: no `TBD`, deferred implementation, or unnamed error handling remains.
- Type consistency: runner options, binding fields, live-task fields, source metadata, diff evidence, and report fields are named once and reused by downstream tasks.
- Delivery boundary: implementation is isolated on `codex/m6-external-js-dogfood`; only the target baseline commit is pre-authorized. Omni changes remain uncommitted until explicit approval.
