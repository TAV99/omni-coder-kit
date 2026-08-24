# Dual Mode: Codex manager + Gemini worker via Antigravity

**Status:** Approved architecture; awaiting review of this written specification before implementation.

## Goal

Extend `omni init`'s existing `dual` option without changing its current default. Users may choose either the existing **Claude Code + Codex** pairing or a new **Codex + Gemini via Antigravity (`agy`)** pairing. The new pairing lets Codex own technical decisions and independent QC while Gemini performs bounded reconnaissance, implementation, and pre-review.

## Non-goals for the first release

- Do not replace or rename the existing Claude Code + Codex dual behavior.
- Do not add a direct Gemini CLI v4 adapter or ACP integration.
- Do not automatically run implementation, review, commits, pushes, deploys, or any live-model benchmark during `omni init`.
- Do not treat generated agent output as approval evidence.

## Init interaction and compatibility

`dual` remains the visible IDE mode. Immediately after it is selected, `omni init` asks for an agent pairing:

1. **Claude Code + Codex** — default and current behavior.
2. **Codex + Gemini (Antigravity / agy)** — the new behavior.

The manifest preserves `ide: "dual"` and records the selected pairing:

```json
{
  "ide": "dual",
  "dualPair": "codex-agy",
  "workerProvider": "antigravity"
}
```

Absent fields mean legacy Claude Code + Codex behavior. This prevents older manifests and callers of `buildInitConfig("dual", ...)` from changing behavior.

## Generated project surface for `codex-agy`

```text
AGENTS.md
.codex/skills/omni-codex-gemini/
  SKILL.md
.omni/codex-gemini/
  ai-flow.ps1
  prompts/
    scout.md
    implement.md
    review.md
    repair.md
  schemas/
    context.schema.json
    evidence.schema.json
    review.schema.json
    correction.schema.json
  runs/                         # created only by ai-flow; local runtime state
```

`AGENTS.md` contains only the activation and authority rule: for a delegated implementation task Codex invokes `omni-codex-gemini`; Codex is the manager and final verifier; `agy` is the worker; commit/push/deploy/external writes require explicit user authority. Long guidance remains in the native skill and prompt files.

The skill is emitted under `.codex/skills/` so Codex can discover it natively. `agy` receives a generated bounded prompt and reads the project `AGENTS.md`; it does not need a duplicate copy of the skill.

## Task transaction model

Each task has an explicit ID and a local artifact directory:

```text
.omni/codex-gemini/runs/<task-id>/
  request.md
  preflight.json
  context.json
  spec.json
  evidence.json
  review.json
  correction.json
  raw/
```

Artifacts appear only when their phase has completed. The inferred state is:

```text
request -> preflight -> context -> spec -> evidence -> review -> VERIFIED | REJECTED | BLOCKED
```

The directory is intentionally separate from `.omni/v4/runs` and is runtime state, not an Omni v4 event-store replacement.

## Roles and evidence boundaries

| Phase | Owner | Allowed work | Output |
|---|---|---|---|
| `new` | wrapper + user | Create task shell and request template | `request.md` |
| `preflight` | wrapper | Read-only repository and `agy` availability checks | `preflight.json` |
| `scout` | Gemini one-shot | Read source, find exact symbols/tests/constraints; no edits | `context.json` |
| `spec` | Codex | Decide WHAT/WHY, scope, invariants, acceptance | `spec.json` |
| `implement` | Gemini persistent session | Implement and routine self-repair within the approved spec | `evidence.json` |
| `review` | Gemini independent one-shot | Inspect spec/evidence/diff; no edits and no approval authority | `review.json` |
| final QC | Codex | Read real diff/source and rerun selected validation | `VERIFIED`, correction, or `BLOCKED` |

Evidence precedence is immutable: current source and diff > fresh command output > generated artifact > approved spec > Gemini prose. A Gemini result can reduce Codex's search space but cannot approve its own code.

## MVP command contract

Only these commands are implemented in the first increment:

```powershell
.\.omni\codex-gemini\ai-flow.ps1 new <task-id>
.\.omni\codex-gemini\ai-flow.ps1 preflight <task-id>
.\.omni\codex-gemini\ai-flow.ps1 scout <task-id>
```

`new` validates a safe task ID, creates `request.md` and `raw/`, and never overwrites an existing request.

`preflight` runs read-only checks: working directory, `git status --short --branch`, current HEAD, `agy --version`, and supported model discovery. It writes normalized JSON with `safe|warning|blocked`, dirty-tree information, availability, warnings, and forbidden actions. It must not call a model.

`scout` refuses to run unless `request.md` and a non-blocked preflight exist. It calls `agy -p` with a fixed read-only prompt, JSON output, a context schema, bounded timeout, and no auto-approval mode. It stores raw output under `raw/`, validates the structured result, and writes `context.json` only after validation. Malformed output, unavailable `agy`, timeout, or missing required findings yields an explicit non-success status and no false `context.json` success.

The operator manually asks Codex to produce `spec.json` from `request.md`, `preflight.json`, and `context.json`. Implementation/review wrappers are intentionally deferred until the artifact protocol has been exercised on real tasks.

## Future implementation and repair policy

The native skill defines, but MVP does not automate, these later phases:

- Implementation uses one managed `agy` session; Codex preserves its session/conversation identity.
- Gemini may perform up to five routine self-repairs for local test/type/lint failures.
- Gemini must stop for architecture change, scope expansion, requirement conflict, security/data-integrity decision, or no progress.
- Review runs in a separate one-shot context, has no write access, and only flags risk regions.
- Codex produces an exact correction list (`expected`, `actual`, `required_fix`, `verify`).
- Codex permits at most two correction rounds; repeated failure with no meaningful evidence change is `BLOCKED`.

Neither the skill nor wrapper grants commit, push, deploy, persistent permissions, broad auto-approval, or model-cost authorization.

## Tests and acceptance gates

Implementation must be test-first and add coverage for:

1. Legacy `dual` init produces the same files, startup hints, manifest semantics, and no new prompt requirement beyond the defaulted pairing.
2. `dualPair: codex-agy` produces `AGENTS.md`, the Codex native skill, and only the selected generated support files.
3. `new` rejects unsafe IDs and preserves an existing request.
4. `preflight` normalizes clean, dirty, absent-`agy`, and unsupported-model outcomes without model execution.
5. `scout` uses the required `agy` invocation contract; valid structured output writes context; malformed/failed output fails closed and preserves raw evidence.
6. Generated `.omni/codex-gemini/runs/` is ignored as runtime state and never overlaps `.omni/v4/runs`.

The relevant existing suite must remain green, at minimum `npm test` and any focused tests added for init and the wrapper. No claim of runtime compatibility may rely only on mocked tests: before promotion, run an explicitly authorized local `agy` smoke task and record its CLI/model/version evidence.

## Rollback

Removing `dualPair: codex-agy` restores the legacy dual behavior. The feature's files are additive and generated only for the selected pairing. A project may delete `.omni/codex-gemini/` and `.codex/skills/omni-codex-gemini/` to reverse the integration without touching `.omni/v4/` or normal Omni workflows.

## Specification self-review

- No placeholders, unbounded autonomy, or hidden release authority remain.
- Legacy dual behavior is explicit and default-preserving.
- The MVP is limited to `new`, `preflight`, and `scout`; implementation/review automation is deferred.
- Artifact ownership, source-of-truth precedence, failure behavior, and acceptance tests are defined.
