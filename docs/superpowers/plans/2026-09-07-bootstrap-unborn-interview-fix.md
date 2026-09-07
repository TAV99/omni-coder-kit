# Bootstrap unborn Git và interview — Implementation Plan

> **For agentic workers:** Use subagent-driven-development and TDD. User selected exactly one coding implementer: gpt-5.6-luna / xhigh. No automatic commit or push.

**Goal:** Loại bỏ deadlock bootstrap trên repo mới chưa có HEAD, hook Stop ép interview và diagnostic commands bị chặn; tránh đánh mất handle của command chạy lâu.

**Architecture:** Fresh sessions dùng snapshot khi repository được chứng minh là unborn hợp lệ; giữ Git identity nghiêm ngặt cho repo có commit và các session đã pin baseline. Pre-authority Stop không suy ra phê duyệt từ sự tồn tại của file spec; mutation guards vẫn giữ nguyên. Status/version/help commands chỉ được allow theo exact syntax; workflow phải giữ full execution result/handle.

**Tech Stack:** Existing CommonJS Node >=20, node:test, Git CLI, Omni CLI/hooks/templates. No runtime dependencies.

## Global Constraints

- E:\LdPage remains read-only: no lock deletion, commit, daemon restart, bootstrap/resume, model calls or ledger/config/source edits.
- Existing package.json/package-lock.json version bump is user-owned; do not modify/stage/commit it.
- Work on existing codex/v3.1.2, baseline 8bb056c; no commit/push, no rewriting prior tests to hide failures.
- Never treat arbitrary Git errors/corruption/permission failure as a confirmed unborn repository. Existing pinned Git sessions never migrate automatically.
- Do not infer Git lock ownership from age, zero bytes, or process count. No automatic lock cleanup/kill.
- Observer automation remains read-only. Code implementer may edit only Omni files named below and supporting tests/docs; no AGY/model invocation for validation.

### Task 1: Bootstrap/interview diagnostic repair (single Luna coding slice)

**Files:** lib/dual/baseline.js; lib/dual/hook-bridge.js; lib/commands/dual.js only if necessary for diagnostics; templates/workflows/dual-controller.md; templates/overlays/codex/workflows/coder-execution.md; tests test/dual-baseline-git.test.js, test/dual-hook-bridge.test.js, test/dual-bootstrap.test.js and focused new test/dual-unborn-bootstrap.test.js if required. Do not expand into unrelated changes.

**Interfaces:** retain detectBaselineBackend(root,deps) -> 'git'|'snapshot'; createGitBaseline explicit mode still fails HEAD missing. No new public force/bypass CLI switch. Maintain source snapshot path/ignore/integrity policy.

- [ ] RED: real git init without commit currently detects git then capture throws DUAL_GIT_HEAD_MISSING. Write test expecting safe fresh snapshot selection; also committed repo Git, non-Git snapshot, corrupt HEAD/ref error, explicit Git capture missing HEAD still rejects. Use temporary fixtures only.
- [ ] GREEN: after identifying actual repo, inspect HEAD commit. If missing, verify symbolic HEAD points to a safe refs/heads branch and that its ref is genuinely absent (distinguish exit statuses). Only confirmed unborn chooses snapshot. On unsupported/ambiguous probe retain fail-closed error, not silent snapshot.

```js
// Required behavior, not an arbitrary-error fallback:
assert.equal(detectBaselineBackend(unbornFixture), 'snapshot');
assert.equal(detectBaselineBackend(committedFixture), 'git');
assert.throws(() => createGitBaseline({ root: unbornFixture }).capture(), { code: 'DUAL_GIT_HEAD_MISSING' });
```

- [ ] End-to-end offline fixture: fresh unborn repo can initialize snapshot authority and register a bounded plan without git add/commit and without worker model calls. Reopening keeps same baseline/session. Existing pinned Git drift tests remain green. Verify no .git/index/refs changed by snapshot capture.
- [ ] RED: stale nonempty design-spec + no authority + Stop should not force continuation while awaiting user approval. Current existence-only hook fails this.
- [ ] GREEN: pre-authority Stop returns bounded explanatory systemMessage (or empty neutral output) rather than decision:block; neither claims approval nor completion. Keep source/build/browser writes denied exactly as before design-ready/no-authority, even though Stop may return to user. No magic phrase heuristic or fabricated approval record.

```js
assert.notEqual(preAuthorityStop.decision, 'block');
assert.equal(preAuthoritySourceWrite.hookSpecificOutput.permissionDecision, 'deny');
```

- [ ] RED/GREEN exact diagnostic allowlist: omni dual status SAFE_TASK_ID, omni dual status --help, omni dual bootstrap --help and omni --version should work read-only before authority. Reject additional flags, shell operators, redirection, invalid task ID and mutating variants. Keep Get-Command blanket allowlist unchanged unless exact safe need is established; do not enable arbitrary shell execution.
- [ ] Workflow correction: all exec wrappers preserve exit_code/session_id/output (`text(r)`), poll returned handle, never retry bootstrap solely because r.output empty. CLI status syntax documented as `omni dual status <task-id>` (no unsupported --json). Never read/dump raw daemon.json containing token; diagnostics select public fields. Document missing HEAD vs index.lock as different conditions and no automatic initial commit required for fresh snapshot.
- [ ] Run focused tests after each component, record actual RED/GREEN commands and outputs. No self-certified passing claims.
- [ ] Self-review input boundaries, pinned baseline compatibility and permissions; return report `E:\omni-coder-kit\.omni\runs\bootstrap-unborn-review\luna-report.md` with files changed, test evidence and concerns.

## Controller verification and delivery

- [ ] Primary inspects patch against requirements and runs independent targeted checks. Read-only reviewer handles named security/compatibility risks; Luna addresses concrete findings and reruns covering tests.
- [ ] Full suite once after source freeze; syntax and diff check; report tests separately from live qualification.
- [ ] Update this plan with results and issue report. Do not touch original failing project or call paid worker; user decides separate live rerun.

## Diagnosis recorded before coding

- Confirmed: detectBaselineBackend checks membership only; createGitBaseline.capture requires HEAD. Repo E:\LdPage lacks HEAD.
- Confirmed: isDesignReady uses nonempty file existence; evaluatePreAuthorityPhase Stop always blocks first attempt. Stale spec can trigger before new interview approved.
- Confirmed: terminal wrapper used text(r.output), dropping process handle/exit code; silence is not process completion. Two prior bootstrap attempts' actual process lifetime is still unverified.
- Confirmed: index.lock exists, zero bytes, timestamp 14:59:39. A git.exe exists on machine; ownership of this lock is unknown. No cleanup authorized/performed.

## Status

Implementation complete in the working tree. Luna/xhigh authored the scoped code/tests; primary review corrections addressed bootstrap compatibility, branch names, TaskID and real-daemon fixture. Independent reviewer: spec PASS, quality PASS, no Critical/Important findings. Full TAP:1750 pass/0fail/2skip; final independent focused rerun67/67 pass exit0. Syntax/diff checks pass. See BOOTSTRAP_UNBORN_FIX_REPORT.md for precise evidence and live-qualification boundary. No commit/push or customer-project/runtime mutation performed.
