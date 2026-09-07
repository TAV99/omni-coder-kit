# Dual incident root fixes — Implementation Plan

> **For agentic workers:** Use executing-plans task-by-task with TDD. AGY authors implementation/test patches; Codex applies them, runs independent checks, and returns concrete counterexamples for correction. No commit or push.

**Goal:** Remove the reproduced E:\LdPage orchestration failures without weakening isolated-worker, authority, or dependency-integrity boundaries.

**Architecture:** Separate source-project selection from isolated process arguments; fingerprint dependencies using bounded reads and explicit finite limits. Treat external MCP operations as exact, opt-in task capabilities rather than fictional filesystem paths. Report actionable preparation blockers without pretending that CLI/model availability proves worker readiness.

**Tech Stack:** Existing CommonJS Node.js >=20, node:test, Zod, typed Omni authority ledger and CLI/MCP adapters. No new runtime dependencies.

## Global constraints

- Canonical development checkout: `E:\omni-coder-kit`, existing `codex/v3.1.2`; preserve all pre-existing tracked and untracked work.
- `E:\LdPage` and its ledger, package/lock, bindings and dependency tree remain read-only. No attempt 3, restart of its daemon, remote Stitch mutation, release, commit, push or deployment.
- AGY model: available `gemini-3.7-flash-high`, effort high. Headless filesystem permission is unavailable: use evidence-in/patch-out delegation, not permission bypass. Never claim AGY independently ran tests.
- Each patch must have a failing regression before production changes and independent Codex verification afterwards.
- Keep raw unsafe worker project/conversation/directory flags rejected. Do not erase users' project mappings.
- Keep lockfile immutability, disabled install scripts, link containment, 50,000 file count, 64-level depth and 1 GiB total dependency limits.
- Policy change: support individual dependency files up to 256 MiB using <=1 MiB read buffers. This is an explicit bounded policy, not a special exemption for a filename. Test both sides of the boundary; explain larger files as unsupported rather than bypassing the cap.
- Existing v4 `.omni/sdlc/todo.md` is unrelated and must not be overwritten. This document is the current task checklist.

## Task 1 — Project routing and truthful preparation diagnostics (Cycle 1)

**Files:** `bin/omni-daemon.js`, `lib/dual/orchestrator-adapter.js`, `lib/dual/agy-project.js`, `test/dual-isolated-runner.test.js`, focused new `test/dual-incident-routing.test.js` if needed.

**Interfaces:** daemon passes optional `agyProjectId` separately to `createOrchestratorAdapter`; adapter produces source-project args only for shared execution. Existing explicitly supplied `agyPrefixArgs` remain unchanged and subject to isolated runner rejection.

- [ ] AGY writes regression patch first: registered source project + isolated task reaches private execution without source flags; shared task retains project selection; unexpected explicit `--project` still rejects.
- [ ] Codex runs the regression against original code and preserves expected failure.
- [ ] AGY implements mode-specific routing. Intended adapter expression:

```js
agyPrefixArgs: task.execution_mode === 'isolated' || !agyProjectId
    ? agyPrefixArgs
    : [...agyPrefixArgs, '--project', agyProjectId],
```

- [ ] Test source manifest and global fallback mapping unchanged. Do not repair the incident by editing either mapping.
- [ ] Review failure reporting to distinguish controller lease/preparation from model phase; preserve actual error code and bounded actionable detail, never expose credentials/raw CLI payloads.
- [ ] Codex runs focused routing/isolated/daemon regressions, syntax checks and diff checks; AGY reviews resulting code and counterexamples.

## Task 2 — Dependency fingerprint resource policy (Cycle 2)

**Files:** `lib/dual/private-dependencies.js`, `test/dual-private-dependencies.test.js`; new focused fingerprint test file only if separation improves review.

**Interfaces:** `preparePrivateDependencies` and `verifyPrivateDependencies` retain return contracts and synchronous verification. Fingerprint byte encoding/order stays compatible for previously accepted files. Finite policy constants govern file, total, count, depth and buffer size.

- [ ] AGY supplies tests for a 74,882,048-byte synthetic dependency, changed last byte, oversized file, escaping link and old receipt compatibility.
- [ ] Codex observes old implementation reject the supported binary case before applying production patch.
- [ ] AGY implements bounded incremental hashing, for example:

```js
const fd = fs.openSync(target, 'r');
try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        fileHash.update(buffer.subarray(0, read));
    }
} finally { fs.closeSync(fd); }
```

- [ ] Add actual-byte and file-identity/size checks so file growth/replacement cannot defeat the budget; retain containment and reject unsupported file types. Limit failures identify relative path, limit and observed size without dumping content.
- [ ] Codex verifies fingerprints against the preserved incident dependency tree read-only, without npm install/model execution in that project.
- [ ] Run dependency, isolated runner, integration/replay tests; send results to AGY for adversarial review/correction.

## Task 3 — Exact external operation authority, planning and recovery (Cycle 3)

**Files:** `lib/dual/contracts.js`, `lib/dual/daemon-server.js`, `lib/dual/hook-bridge.js`, relevant authority/bootstrap metadata propagation, `test/dual-hook-bridge.test.js`, `test/dual-daemon-orchestrator.test.js`, `test/dual-controller-workflows.test.js`, `templates/workflows/dual-controller.md`, `templates/workflows/task-planning.md`.

**Interfaces:** optional task `external_operations` entries contain exact `tool_name`, exact JSON `tool_input`, and an `evidence_file` already in `allowed_files`; Codex/shared only. No wildcard tools/inputs. Default is no grant. Hook matches daemon-derived registered task data before forwarding normal lease/scope evaluation against the evidence file. External calls remain writes, not reads. Registration/replay preserve grants; ambiguity, mismatched inputs, inactive owner or missing grants deny.

- [ ] AGY proposes and Codex reviews minimal schema/propagation patch; reject any blanket Stitch/MCP allowlist or invented path added to provider arguments.
- [ ] Red tests: exact `create_project({title})` grant succeeds with authority; changed title/tool, extra fields, AGY owner, unknown task, missing lease/grant and duplicate grants do not.
- [ ] Apply implementation only after red evidence; verify both PreToolUse and PostToolUse handling, preserving fail-closed default and immutable plan hash.
- [ ] Stop hook: recorded failed preparation with no active worker stops with precise required action, without requesting the same automatic continuation or marking session complete. Active work and genuine runnable work retain normal continuation behavior.
- [ ] Planning template explicitly rejects mixed Codex/shared + multiple AGY graphs before setup; document supported decomposition. Schema stays strict and validation errors explain this restriction.
- [ ] Explain preflight's boundary: CLI/model/config checks are not private dependency readiness; preparation failure does not mean model failure. Recovery preserves ledger and uses bounded correction, not delete/recreate sessions to evade attempt limits.
- [ ] Codex verifies schema/registration/replay/hooks/generated workflow tests, then conducts fresh-context security review. AGY responds to specific findings and supplies corrections before final acceptance.

## Final acceptance

- [ ] P0: `npm audit --audit-level=high`, inspect scoped diff for credentials/unsafe process and permission changes.
- [ ] P1/P2: changed JS syntax checks, `git diff --check`, CLI help smoke. No frontend/build script exists; do not claim a browser or bundle gate.
- [ ] P3: full `node --test --test-concurrency=1 test/*.test.js test/**/*.test.js`; preserve TAP evidence and exact totals. Fix regressions before completion.
- [ ] Three quality-cycle records distinguish AGY-authored patches, Codex-run tests and independent review. No worker self-certification.
- [ ] Report requirement-by-requirement conformance and any remaining external-service/live qualification separately.
- [ ] Save final report beside this plan; do not overwrite historical v3.1.2 handoff evidence or user memories.

## Delivery status

## Execution reconciliation

The checklist above preserves the original intended steps. Actual implementation and departures are recorded here and in `DUAL_INCIDENT_2026_09_07_REPORT.md`:

- [x] AGY authored routing/fingerprint/external-operation/readiness patches and review responses; Codex applied/integrated them and independently tested. AGY did not execute filesystem tools because headless read permission was unavailable. No bypass was enabled.
- [x] Preserve existing checkout changes using an ignored baseline copy; no worktree/branch reset or source binding removal. Tests use disposable fixtures. Integration was applied in the existing development checkout, not in an AGY-owned filesystem workspace.
- [x] Cycle 1/2 routing + fingerprint: 44 focused tests passed. Subsequent boundary/growth/compatibility and real shared-argv tests also passed.
- [x] Cycle 3 exact external grants, durable reservation/observation, readiness, Stop and generated workflow changes implemented. Initial focused suite 148 pass; subsequent findings reproduced and corrected.
- [x] Independent security review: fixed release event switch placement, expired lease handling, local-path fallthrough, original owner validation and missing MCP transport field. Last review 36/36 focused tests passed with no remaining material finding.
- [x] Keep source file cap finite at 256 MiB with 1 MiB reads; tested 74,882,048-byte incident-size fixture and real preserved incident dependency tree without writes/install/model calls.
- [x] Scope evidence is NOT provider evidence. External observation does not require the file to be created immediately or pretend remote success; task QC remains independent. Existing Codex ROUTED interactive authority is retained, rather than inventing an incompatible required lease.
- [x] Source readiness now rejects known package/path/resource failures before ensureSession; it is not a private dependency receipt.
- [x] No standalone binding-repair command or automatic permission/config mutation: mode-specific routing removes the need to delete those mappings. Provider IAM and unknown future remote IDs remain explicit capability/authority boundaries.
- [x] Syntax checks, diff check, CLI help, high-severity dependency audit gate and temporary clean npm ci passed. Moderate qs advisory remains reported, not silently upgraded.
- [x] Final fresh full suite: 1,743 pass / 0 fail / 2 skipped (1,745 tests, 223 suites), exit 0; final targeted regression 156/156 pass. Final report: `DUAL_INCIDENT_2026_09_07_REPORT.md`; logs under `.omni/runs/incident-final-*.tap`.

No commit, push, release, automatic AGY retry in E:\LdPage or live Stitch mutation is part of this completion.
