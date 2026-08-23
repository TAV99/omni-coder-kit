# Omni v4 P2 Reliability Design Specification

**Status:** Approved design, pending implementation-plan review

**Date:** 2026-08-20

**Priority:** P2 reliability

**Roadmap slice:** Milestone 5 — Verification and Acceptance

## 1. Goal

Build a fail-closed, project-configurable quality and acceptance subsystem that makes every forward completion claim traceable to valid deterministic or explicitly permitted agent-judgement evidence. The subsystem must support bounded repair, crash recovery, and evidence export without moving vendor-specific behavior into the core controller.

## 2. Success criteria

- Gate results implement exact four-state semantics.
- Missing configuration or evidence cannot become green.
- Every accepted mandatory requirement points to same-run valid evidence.
- Agent judgement is limited to `test: agent` requirements.
- Repair is bounded to two attempts per requirement and stops on no progress.
- Quality-driven transitions are causally valid and replay-safe.
- Fault injection produces zero false-green runs.
- P0/P1 regression remains green.

The normative atomic checklist is `.omni/sdlc/requirements.md` R1-R46.

## 3. Non-goals

- Concurrent agent steps.
- A hosted service, UI, marketplace, or remote evidence store.
- Executing arbitrary `test:` strings from Markdown.
- New model/provider integrations.
- Live host dogfood or first-class host promotion.
- Cross-process run writers.
- Optimizing token usage or wall-clock time; those belong to P3.

## 4. Architecture

```text
RunOrchestrator
├─ RunController
├─ AgentAdapter
└─ QualityCoordinator
   ├─ RequirementLoader
   ├─ GateRegistry
   ├─ GateRunner
   ├─ AcceptanceEngine
   ├─ AgentJudge
   ├─ RepairPolicy
   └─ EvidenceBundleStore
```

`RunController` remains authoritative for durable run state. It does not load Markdown, parse quality configuration, spawn commands, or evaluate requirements. `QualityCoordinator` returns typed decisions; `RunOrchestrator` persists those decisions and requests only explicitly allowed routes.

## 5. Public contracts

Create `src/v4/contracts/quality.ts` with branded IDs and strict Zod schemas.

```ts
type GateId = string & { readonly __brand: "GateId" };
type RequirementId = string & { readonly __brand: "RequirementId" };
type QualityCycleId = string & { readonly __brand: "QualityCycleId" };
type QualityEvidenceId = string & { readonly __brand: "QualityEvidenceId" };

type GateStatus = "passed" | "failed" | "skipped" | "inconclusive";
type RequirementStatus = "accepted" | "rejected" | "inconclusive";
```

### 5.1 Gate definition

```ts
interface GateDefinition {
  readonly id: GateId;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly mandatory: boolean;
  readonly requirementIds: readonly RequirementId[];
  readonly dependsOn: readonly GateId[];
  readonly sideEffect: "read-only" | "workspace-write";
  readonly retrySafe: boolean;
  readonly concurrencyKey?: string;
}
```

`command` is a binary name/path and `args` is an argv array. No field accepts a shell pipeline or interpolated command string.

### 5.2 Gate result

```ts
interface GateResult {
  readonly schemaVersion: 1;
  readonly cycleId: QualityCycleId;
  readonly gateId: GateId;
  readonly operationId: string;
  readonly status: GateStatus;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly evidenceId: QualityEvidenceId;
  readonly failureSignature?: string;
  readonly reason?: string;
}
```

Variant rules:

- `passed`: process exited `0`; evidence is valid.
- `failed`: check ran and criterion was not met.
- `skipped`: policy explicitly excluded the gate; `reason` is required.
- `inconclusive`: a required trustworthy answer could not be obtained; `reason` and stable failure signature are required.

### 5.3 Quality evidence

```ts
interface QualityEvidence {
  readonly schemaVersion: 1;
  readonly evidenceId: QualityEvidenceId;
  readonly runId: RunId;
  readonly cycleId: QualityCycleId;
  readonly gateId: GateId;
  readonly operationId: string;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly termination: ProcessResult["termination"];
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly stdoutSummary: string;
  readonly stderrSummary: string;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly artifactIds: readonly ArtifactId[];
}
```

Summaries are bounded by configuration; full output is hashed before truncation. Environment values are never persisted.

### 5.4 Requirement and verdict

```ts
interface RequirementRecord {
  readonly requirementId: RequirementId;
  readonly text: string;
  readonly testStrategy: { readonly kind: "agent" } | {
    readonly kind: "hard";
    readonly sourceText: string;
  };
}

interface RequirementVerdict {
  readonly requirementId: RequirementId;
  readonly status: RequirementStatus;
  readonly evidenceIds: readonly QualityEvidenceId[];
  readonly rationale: string;
}
```

The loader preserves requirement text and hard-test source text but never executes source text. `.omni/v4/quality.json` is the sole executable mapping.

### 5.5 Quality decision

```ts
type QualityDecision =
  | { readonly kind: "advance"; readonly to: "ACCEPT" | "DOCUMENT" }
  | { readonly kind: "repair"; readonly to: "FIX" | "REWORK"; readonly requirementIds: readonly RequirementId[] }
  | { readonly kind: "block"; readonly reason: string; readonly requiredAction: string };
```

## 6. Configuration

Load `.omni/v4/quality.json` through a strict schema:

```json
{
  "schemaVersion": 1,
  "requirementsPath": ".omni/sdlc/requirements.md",
  "outputSummaryBytes": 16384,
  "maxRepairAttemptsPerRequirement": 2,
  "gates": [
    {
      "id": "unit-tests",
      "command": "npm",
      "args": ["test"],
      "cwd": ".",
      "timeoutMs": 120000,
      "mandatory": true,
      "requirementIds": ["R1"],
      "dependsOn": [],
      "sideEffect": "workspace-write",
      "retrySafe": true
    }
  ]
}
```

Rules:

- Relative paths resolve inside project root.
- Path escape rejects configuration.
- Duplicate IDs, unknown requirement IDs, invalid timeouts, and unsupported keys reject the entire config before execution.
- Missing config is `QUALITY_CONFIG_MISSING`.
- The repair limit may be configured lower than two but never higher during P2.

## 7. Requirement loading

The supported Markdown line is:

```text
- [ ] R<n> | <verbatim requirement> | test: <strategy text>
```

Accepted status markers are `[ ]`, `[x]`, and `[!]`; they are intake/acceptance display state and do not authorize runtime acceptance. Runtime verdicts come from current evidence.

The loader rejects duplicate IDs, empty text, missing `test:`, malformed separators, and unsupported status markers. `test: agent` is recognized exactly after trim; every other non-empty strategy is hard-test metadata requiring gate mapping.

## 8. Gate execution

`GateRunner` consumes one `GateDefinition`, an operation ID, a project root, `ProcessRunner`, and an abort signal. It validates containment, persists `gate.started`, invokes `ProcessRunner` with `shell: false`, creates evidence, validates it, then persists `gate.completed`.

Outcome mapping:

| Process result | Gate status |
|---|---|
| exited 0 and criterion/evidence valid | passed |
| exited nonzero | failed |
| timed-out | inconclusive |
| aborted | inconclusive |
| output-limit | inconclusive |
| spawn-error | inconclusive |
| signalled | inconclusive |
| invalid evidence persistence | inconclusive then block |

P2 uses sequential execution. P3 replaces only the scheduling strategy.

## 9. Acceptance and agent judgement

`AcceptanceEngine` evaluates deterministic mappings first. A mandatory requirement is accepted only when every mandatory mapped gate passes and at least one valid same-run evidence record is linked.

`AgentJudge` is invoked only for `test: agent`. It uses an existing compatible adapter with:

- read-only side effect;
- no elevation;
- structured output;
- exact requirement ID correlation;
- a prompt containing the requirement plus references/summaries of existing evidence.

The judgement schema permits `accepted`, `rejected`, or `inconclusive`, rationale, and existing evidence IDs. It cannot return new command evidence or authorize a hard-test requirement. Missing adapter, malformed output, unknown evidence, or correlation mismatch is `inconclusive`.

## 10. Routing and event model

Add these event variants without changing existing P0/P1 event payloads:

```text
quality.started
gate.started
gate.completed
requirement.evaluated
quality.completed
repair.decided
run.routed
```

Allowed quality routes:

```text
VERIFY -> ACCEPT
VERIFY -> FIX
ACCEPT -> DOCUMENT
ACCEPT -> REWORK
```

`run.routed` references the earlier same-run `quality.completed` or `repair.decided` that authorized the exact route. Replay rejects missing, later, cross-run, or mismatched causes. Existing normal success transitions retain their current semantics.

## 11. Repair policy

Repair state is indexed per requirement ID. A progress fingerprint is SHA-256 over canonical JSON containing:

```text
failure signature
sorted failed requirement IDs
sorted referenced evidence digests
```

The policy returns:

- repair when the requirement has fewer than two attempts and fingerprint changed;
- `REPAIR_NO_PROGRESS` when the fingerprint is unchanged;
- `REPAIR_BUDGET_EXHAUSTED` after two attempts.

Any repair invalidates verdicts for affected requirements. The next verification/acceptance cycle must collect fresh evidence.

## 12. Recovery

- A quality cycle is complete only after `quality.completed` is durable.
- An interrupted cycle never authorizes a route.
- Resume preserves old events but creates a fresh cycle ID and operation IDs.
- Read-only gates may rerun.
- Workspace-write gates may rerun only when `retrySafe` is true.
- Missing/ambiguous attempt context blocks with `QUALITY_RECOVERY_UNSAFE`.
- Repeated resume is idempotent and cannot duplicate a route or repair count.

## 13. Evidence bundle

Store under `.omni/v4/runs/<runId>/quality/`:

```text
bundle.json
bundle.record.json
```

`bundle.json` contains schema version, run/cycle IDs, config hash, requirements hash, ordered gate results, evidence, requirement verdicts, repair history, and final decision. `bundle.record.json` contains SHA-256, byte size, and recorded timestamp. Write to a temporary file, sync, rename atomically, then sync the containing directory where supported.

Checksum mismatch, missing bundle, unknown evidence, or bundle/run mismatch blocks acceptance.

## 14. Error taxonomy

Stable P2 codes:

```text
QUALITY_CONFIG_MISSING
QUALITY_CONFIG_INVALID
REQUIREMENTS_MISSING
REQUIREMENTS_INVALID
GATE_TIMEOUT
GATE_ABORTED
GATE_OUTPUT_LIMIT
GATE_EXIT_NONZERO
GATE_EVIDENCE_INVALID
AGENT_JUDGE_UNAVAILABLE
AGENT_JUDGE_MALFORMED
MANDATORY_GATE_SKIPPED
MANDATORY_GATE_INCONCLUSIVE
REPAIR_NO_PROGRESS
REPAIR_BUDGET_EXHAUSTED
QUALITY_RECOVERY_UNSAFE
```

After `quality.started` is durable, operational/parser errors are normalized and persisted. Persistence failure is the only permitted thrown boundary; the caller must report blocked recovery rather than infer success.

## 15. Verification strategy

- Contract and strict-schema tests.
- Requirements parser and no-execution tests.
- Gate runner/process/evidence tests.
- Four-state semantics tables.
- Requirement-evidence correlation tests.
- Agent-judge negative-path tests.
- Routing causation and legacy replay tests.
- Repair progress/budget tests.
- Crash injection at every quality event cut-point.
- Evidence bundle corruption tests.
- End-to-end real stores + fake adapter tests.
- Full P0/P1/v3 regression.

## 16. P2 exit gate

P2 is complete only when R1-R46 pass, all P0/P1 regression tests pass, mandatory missing/inconclusive evidence cannot reach `DOCUMENT`, every accepted requirement has valid evidence, recovery is idempotent, and the quality fault suite reports zero false-green runs.
