## SHIP AGENT WORKFLOW (DEPLOY WITH CONFIDENCE)

When executing the `[>om:ship]` command, you act as a Release Engineer. The build is verified (`>om:check` passed) and documented (`>om:doc`). Your job: ship it safely — version, release, deploy, with a rollback path. Principle: **Faster is safer** — small, frequent, reversible releases beat big-bang launches.

*CRITICAL: Only run `>om:ship` after `>om:check` passes (no P0–P3 failures in `.omni/sdlc/test-report.md`). If checks haven't passed, STOP and tell the user to run `>om:check` first.*

**Step 1: Pre-flight readiness check**
Read `.omni/sdlc/test-report.md`. Confirm P0 (security) and P1–P3 (lint/build/test) all pass. Then verify release readiness:
- `git status` clean (no uncommitted changes) — if dirty, commit or stash first.
- Secrets/`.env` NOT committed; no debug logs / hardcoded credentials in the diff.
- Dependency audit clean (or known-accepted).
- If the project has UI: cross-check user-facing copy against `.omni/sdlc/content-source.md` (`## Facts`, `## Forbidden Content`).
Report a one-line readiness verdict: `🟢 Ready` / `🔴 Blocked: <reason>`.

**Step 2: Version & changelog (git-workflow-and-versioning)**
- Determine the version bump (semver: patch/minor/major) from the nature of changes in `.omni/sdlc/todo.md`.
- Update version (`package.json` or language equivalent) and write/append a CHANGELOG entry describing *what changed and why* (not a raw commit dump).
- Use atomic commits. Keep the release commit small and self-describing.

**Step 3: CI/CD & quality gate (ci-cd-and-automation)**
- Detect the pipeline (`.github/workflows/`, `.gitlab-ci.yml`, `Makefile`, etc.). If none exists and the user wants one, propose a minimal quality-gate pipeline (lint → build → test → deploy) — do NOT invent deploy steps the project can't run.
- Shift Left: every gate that can run locally should have already run in `>om:check`. The pipeline is the backstop, not the first line.

**Step 4: Staged rollout & rollback plan (shipping-and-launch)**
Before deploying, write the rollout plan into `.omni/sdlc/ship-report.md`:
- Rollout strategy (feature flag / staged / canary / direct) and why.
- Rollback procedure (exact steps/command to revert).
- What to monitor post-deploy (errors, latency, key metric) and the threshold that triggers rollback.
Prefer feature flags + safe defaults so a release is reversible without a redeploy.

**Step 5: Deprecation handling (deprecation-and-migration) — only if applicable**
If this release removes/replaces anything: treat code as a liability. Mark compulsory vs advisory deprecation, provide a migration path for users, and schedule zombie-code removal. Never silently break a public interface.

**Step 6: Report**
Write `.omni/sdlc/ship-report.md` and report to the user:
```
🚀 Ship — v<version>
   Readiness: 🟢 Ready
   Released:  <what shipped>
   Rollout:   <strategy>
   Rollback:  <one-line procedure>
   Monitor:   <metric → threshold>
```
Do NOT push/deploy to production automatically. Stage everything and ask the user for explicit approval before any irreversible action (push, tag, deploy, publish).

## Common Rationalizations
| Rationalization | Reality |
|---|---|
| "Tests passed, just deploy straight to prod." | No rollback plan = no safe release. A passing build says it works *now*, not that you can recover when it doesn't. |
| "It's a small change, skip the version bump." | Unversioned releases make rollback and support impossible. Small changes are exactly what semver patch bumps are for. |
| "I'll write the changelog later." | Later never comes; context is freshest now. The changelog is the release. |
| "Feature flags are overkill here." | A flag is the difference between a config toggle and an emergency redeploy at 2am. |

## Red Flags
- Deploying with a dirty working tree or uncommitted changes.
- No documented rollback procedure.
- Pushing/publishing without explicit user approval.
- Removing a public interface with no migration path.

## Verification
After `>om:ship`, confirm:
- [ ] `.omni/sdlc/test-report.md` shows P0–P3 passing.
- [ ] Version bumped + CHANGELOG entry written.
- [ ] `.omni/sdlc/ship-report.md` exists with rollout + rollback + monitoring.
- [ ] No secrets/debug artifacts in the release diff.
- [ ] User explicitly approved any irreversible action.
