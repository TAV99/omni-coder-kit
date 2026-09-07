# v3.1.2 workflow handoff

Date: 2026-09-07. Development branch: `codex/v3.1.2`.

## Outcome

The requested workflow optimization is implemented and verified for Codex coordinating AGY/Gemini workers in one user-facing CLI session. Codex remains the controller and independent verifier; isolated workers communicate through durable contracts/questions/results instead of competing edits in the source checkout.

| Requirement | Implemented result | Evidence |
|---|---|---|
| Separate branch and inspect v3.1.1 | Branch from v3.1.1 commit `a46dff2e78307a0ad750a33154f9b3baceeb37ea`; workflow/runtime audit retained | Git branch/HEAD inspection; V3_1_2_WORKFLOW_AUDIT.md |
| Codex dispatches Gemini | Unified authority-aware CLI/MCP dispatch and configurable exact model capability | Actual Gemini3.8 six-phase live run |
| Agents have adequate context | Registered metadata/validators survive replay; immutable private snapshots and artifact-bound handoffs | Contract/replay tests; live question→Codex reply→resume |
| Avoid file overwrite and conflicting ownership | Private workspaces, dependency/scope waits, controller-only integration with before/after hashes and original-byte journal | Two-task integration, same-file replay, external drift, junction and tamper regressions |
| Recover coordination failures without deleting evidence | Idempotent replies/corrections, bounded attempts, durable failed preparation outcome, orphan snapshot preservation, process-aware/deferred lease release | Recovery/correction/reopen tests, real pre-spawn controller-kill test, live completed-daemon restart |
| Usable generated workflow | Common controller contract used by all Codex-AGY native entrypoints; correct pairing text and no automatic stash/commit | Generated configuration matrix and fresh-agent reference retrieval tests |
| Consult Brain harness material | Instruction/tools/environment/state/feedback model and independent verification applied | Source references in audit report |

## Final verification

- Full current suite: **1705 pass, 0 fail, 2 skipped**, 1707 tests/223 suites, exit0; about511 seconds. File: `.omni/runs/v312-transport-final.tap`.
- Current command: `node --check bin/omni.js` followed by `node --test --test-concurrency=1 --test-reporter=dot --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination=.omni/runs/v312-transport-final.tap test/*.test.js test/**/*.test.js`.
- All37 changed JavaScript files passed syntax checks; `git diff --check` passed.
- Clean temporary `npm ci --ignore-scripts --no-audit --no-fund` passed; current tarball independently installed, CLI version check passed, all245 `bin/lib/templates` files matched current source after npm's line-ending normalization.
- Current development tarball: `C:/Users/TAV/AppData/Local/Temp/omni-v312-transport-pack-cfd8070f868d435882d47e4578cde64c/omni-coder-kit-3.1.1.tgz`.
- SHA256: `43CCBA652AA74EC5FD410E7E9E3FBDC2D453F41AD0874F7AE348AFA3D2277AD1`.
- Live: AGY1.1.27 / `gemini-3.8-flash-high`; two task outcomes, one question/reply, dependency ordering, independent QC/integration, three quality cycles, VERIFIED receipt and same receipt after daemon restart. **6/9 authorized phase calls used**, no retry. See V3_1_2_LIVE_QUALIFICATION.md.
- Post-live fixes (accepted overlap replay, preparation recovery, Stop completion budget and fresh RPC sockets) are covered by fresh regression/full-suite/package evidence. Saved live receipt was replayed with updated code without further model calls. Do not represent that replay as a second live inference run.

## Use from Codex

1. Initialize the target project using this development package and choose `Dual → Codex + Gemini via agy → AUTO`. For an existing initialized project, preserve custom rules/ledgers and review generated-config updates rather than blindly overwriting them.
2. Follow `.omni/workflows/dual-controller.md`. Declare low-risk worker tasks with `execution_mode: "isolated"`, exact files, context, typed validators and `depends_on`.
3. Use the single `omni dual bootstrap --json` entrypoint. Codex handles `pending_questions` through `omni_dual_resume.context_reply`, failed attempts through `.correction`, and private QC through `omni_dual_completion.isolated_qc` or `omni dual qc TASK-ID --json`.
4. Keep session acceptance separate from worker/task success; obtain real quality evidence and final receipt.

## Boundaries, not hidden success claims

- No software can promise zero failures for arbitrary model output or environment changes. Missing authority, tampering, unresolved external edits and uncertain process trees remain safety stops. The avoided failures are the reproduced coordination defects, not every possible failure.
- Existing shared plans remain backward-compatible; isolated mode is selected explicitly. Dispatch currently schedules workers serially, with independent snapshots and dependency ordering; parallel throughput is not claimed.
- Questions are supported at scout; bounded correction handles subsequent failed attempts. General implementation-time chat/progress/scope-expansion is not required for this delivered controller workflow and is a possible follow-up, not an implemented capability.
- Private dependency setup supports immutable single-package npm lockfiles with scripts disabled. Other package managers, monorepos, native lifecycle builds and arbitrary frameworks require explicit additional qualification.
- Pre-spawn controller death and deferred normal close are tested. Crash after spawned children requires process-tree evidence; direct PID death cannot prove detached descendants stopped. This guard was retained deliberately, not weakened to remove the word BLOCKED.
- No commit, push, merge, tag, publish, deploy or customer-project mutation was performed. **Package metadata remains3.1.1**; this is development work on the requested v3.1.2 branch, not a published v3.1.2 release.

## Status reconciliation

The initial plan included exploratory follow-ups beyond the core requested optimization. Remaining unchecked entries about universal process-tree recovery, all dependency modes, arbitrary chat/progress and parallel live throughput are explicitly unimplemented extensions/qualification limits above, not silent acceptance claims. The final independent objective audit identified two material preparation gaps; both were reproduced, fixed and reviewed before this handoff. All observed failing gates were preserved, diagnosed and superseded by the green current suite.

Canonical evidence: this handoff, V3_1_2_WORKFLOW_AUDIT.md, V3_1_2_LIVE_QUALIFICATION.md, V3_1_2_IMPLEMENTATION_PLAN.md and the referenced runtime logs. Keep the current branch/workspace as-is for user review; any integration/release action needs separate authorization.
