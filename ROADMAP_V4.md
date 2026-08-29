# Omni v4 Long-Term Development Roadmap

> Status: Direction approved
> Created: 2026-08-12
> Planning horizon: 12 active development months
> Expected capacity: one maintainer, 1-2 days per week
> Primary goal: production-grade open-source reliability harness for Codex, Claude Code, and Antigravity

## 1. Executive Summary

Omni v4 will be a local-first, vendor-neutral reliability harness for coding agents. It will not attempt to replace the native planning, skills, tools, or subagent capabilities of Codex, Claude Code, and Antigravity. Its role is to coordinate those agents through a deterministic workflow, enforce safety policy, preserve resumable state, and require evidence before work is considered complete.

The v4 effort is a rewrite developed on a dedicated `v4` branch in the existing repository. Omni v3 remains available and receives only critical security, data-loss, and compatibility fixes while v4 is under development.

The roadmap deliberately optimizes for correctness before breadth:

1. Define stable contracts and a repeatable benchmark.
2. Build and fault-test the reliability kernel.
3. Add one agent adapter at a time.
4. Add evidence-based verification and acceptance.
5. Dogfood across representative repositories.
6. Release only after measurable reliability targets are met.

Time estimates in this document are relative to active development time. A break of several weeks does not move the project to the next milestone; only the milestone exit gate does.

## 2. Product Positioning

### 2.1 Product promise

Omni helps a coding agent finish a scoped engineering task through a workflow that is:

- Observable: every material action and decision has an event record.
- Resumable: interruption does not require restarting the task from scratch.
- Verifiable: success is based on evidence rather than agent prose.
- Safe by default: dangerous permissions require explicit opt-in.
- Vendor-neutral: projects use one policy model across supported agents.
- Local-first: core operation does not require an Omni-hosted backend.

### 2.2 Primary users

- Solo developers using coding agents for real software projects.
- Small teams that need a consistent quality process across agent vendors.
- Maintainers who want auditable local runs without adopting an enterprise platform.

### 2.3 First-class agents for the first year

Development order:

1. Codex
2. Claude Code
3. Antigravity

An adapter is first-class only when it passes the shared contract suite and the defined end-to-end benchmark. Merely generating configuration for an agent does not make its runtime adapter first-class.

### 2.4 Explicit non-goals for v4.0

- Cloud dashboard or hosted control plane.
- Multi-tenant accounts, enterprise RBAC, or billing.
- A proprietary skill marketplace.
- Broad support for every IDE and agent CLI.
- Automatic production deployment.
- Automatic commit or push without an explicit user-approved policy.
- Reimplementation of native agent capabilities that can be used through a stable adapter.

## 3. Success Criteria

Reliability is the primary product outcome. Adoption, speed, token use, and feature count are secondary.

### 3.1 v4.0 release SLOs

- At least 90% reliable completion across the official applicable-task benchmark.
- Zero false-success outcomes in the official fault-injection and benchmark suites.
- Zero state transitions after an unsuccessful or malformed provider result.
- Successful recovery for every documented crash-resume scenario.
- No repeated destructive action after resume.
- All three first-class adapters pass the same contract suite.
- Safe permission mode is the default for every adapter.
- Every final result can be traced to stored evidence.
- V3 projects have a documented, backup-first migration and rollback path.

### 3.2 Metrics captured per benchmark run

- Actual completion status.
- Reported completion status.
- False-success and false-failure result.
- Retry and repair count.
- Resume correctness.
- User-intervention count.
- Wall-clock duration.
- Input tokens, output tokens, and estimated cost when available.
- Agent CLI, adapter, and model version.
- Failed, skipped, and inconclusive gates.

### 3.3 Metric definitions

`Reliable completion rate` is the percentage of applicable benchmark tasks that produce the expected working result, pass mandatory gates, satisfy acceptance checks, and contain a complete evidence trail.

`False success` occurs when Omni reports a run as ready or successful while a mandatory requirement, gate, artifact, or provider step is actually incomplete or invalid.

`Resume correctness` means the resumed run reconstructs the last durable state, does not lose accepted evidence, and does not repeat non-idempotent work without explicit policy approval.

## 4. Target Architecture

```text
CLI
 |
 v
Run Controller -----> Policy Engine
 |                         |
 |                         +-- permissions
 |                         +-- retry and timeout
 |                         +-- budget
 |                         +-- transition decisions
 |
 +----> Agent Adapters
 +----> Quality Gates
 +----> Acceptance Engine
 |
 v
Artifact Store + Append-Only Event Store
```

### 4.1 CLI

Responsibilities:

- Parse commands and configuration.
- Perform preflight checks.
- Start, resume, inspect, or cancel a run.
- Render progress and actionable failures.

The CLI must not own workflow transition logic.

### 4.2 Run Controller

Responsibilities:

- Execute the state machine.
- Validate step results before transitions.
- Persist events before externally visible state changes.
- Resume by replaying durable events.
- Stop safely on invalid or contradictory state.

The controller is deterministic and independent of any agent vendor.

### 4.3 Policy Engine

Responsibilities:

- Decide whether a requested capability is permitted.
- Resolve retry, timeout, and budget behavior.
- Decide how skipped or inconclusive gates affect a run.
- Require approval for release-sensitive or destructive operations.

Project policy may be stricter than the Omni default but may not silently weaken an explicit user restriction.

### 4.4 Agent Adapters

Responsibilities:

- Detect CLI availability and version.
- Declare capabilities.
- Translate a structured Omni request into a native agent invocation.
- Return a structured result.
- Support cancellation and resume where the host permits them.
- Capture usage and diagnostics where available.

Agent-specific commands, model identifiers, output parsing, and permission flags live only in adapters.

### 4.5 Quality and Acceptance

Responsibilities:

- Run deterministic checks before agent-based evaluation.
- Preserve command, exit code, duration, and output summary as evidence.
- Distinguish passed, failed, skipped, and inconclusive outcomes.
- Map requirements to evidence.
- Use agent judgement only for requirements that cannot be verified mechanically.

### 4.6 Artifact and Event Storage

Responsibilities:

- Store versioned artifacts with checksum and producer metadata.
- Maintain an append-only event stream.
- Support replay, inspection, migration, and corruption detection.
- Separate durable records from disposable console output.

## 5. Core Contracts

The exact implementation language shapes will be finalized in the first v4 architecture specification. The semantic contracts are fixed by this roadmap.

### 5.1 Step result

A step returns exactly one terminal result:

- `succeeded`: contains required artifacts and evidence.
- `failed`: contains a classified failure and whether retry is safe.
- `blocked`: contains the reason and a concrete required action.
- `cancelled`: contains who or what cancelled the step.

Only `succeeded` may authorize a normal forward transition, and only after its evidence and artifacts validate.

### 5.2 Gate result

A gate returns one of:

- `passed`: the check ran and met its criterion.
- `failed`: the check ran and did not meet its criterion.
- `skipped`: policy intentionally excluded the check.
- `inconclusive`: the check was expected but could not produce a trustworthy answer.

Neither `skipped` nor `inconclusive` is equivalent to `passed`.

### 5.3 Adapter capabilities

Each adapter reports capabilities such as:

- Workspace read.
- Workspace edit.
- Shell execution.
- Structured output.
- Streaming output.
- Cancellation.
- Native session resume.
- Usage reporting.
- Native subagents.

Preflight fails before execution when a workflow requires a capability the selected adapter does not provide.

### 5.4 Evidence

Evidence records include:

- Evidence type and schema version.
- Producing step or gate.
- Command or evaluation method.
- Timestamp and duration.
- Exit status or verdict.
- Relevant artifact checksum.
- Sanitized output summary.

## 6. Execution Model

```text
INTAKE -> PLAN -> EXECUTE -> VERIFY -> ACCEPT -> DOCUMENT -> READY
                     ^          |          |
                     +--- FIX --+          +--- REWORK
```

### 6.1 Transition rules

- Provider failure never advances the run.
- Missing or invalid artifacts never advance the run.
- Mandatory gate failure transitions to a bounded repair flow.
- Repeated identical failure without progress transitions to `BLOCKED`.
- Inconclusive mandatory verification transitions according to explicit policy, with fail-closed as the default.
- `READY` means ready for handoff or release preparation; it does not mean deployed.

### 6.2 Failure handling

- Timeout and cancellation are distinct outcomes.
- Retry is allowed only when policy declares the operation retry-safe.
- Two repeated attempts with the same failure signature and no changed evidence stop the loop by default.
- A process crash is recovered from the last durable event, not from console text.
- Corrupt state or artifact checksum mismatch stops the run and reports a recovery path.
- Every blocked result identifies the action required from the user or maintainer.

## 7. Twelve-Month Roadmap

### Milestone 0: Contract and Baseline

**Target duration:** active month 1

**Purpose:** define what v4 must guarantee before implementation begins.

**Deliverables:**

- Dedicated `v4` development branch.
- Architecture records for the state machine, provider contract, event schema, policy model, and v3 migration boundary.
- A fixed benchmark of 10-15 representative engineering tasks.
- A fault taxonomy covering provider, process, filesystem, policy, and verification failures.
- Recorded v3 baseline results.
- A versioned v4 compatibility policy.

**Exit gate:**

- Contracts are internally consistent and reviewable.
- Every benchmark task has objective expected results.
- Baseline captures completion, false-success, intervention, duration, and resume behavior.
- No production agent integration is required to pass this milestone.

**Deferred implementation plans:**

- Core contract specification.
- Benchmark harness and fixtures.
- Architecture decision record set.

### Milestone 1: Reliability Kernel

**Target duration:** active months 2-3

**Purpose:** prove deterministic orchestration without relying on a real agent.

**Deliverables:**

- Pure state machine.
- Versioned event and artifact schemas.
- Append-only event store with replay.
- Policy engine for capability, retry, timeout, budget, and approval.
- Fake adapter and deterministic test driver.
- Fault-injection suite for timeout, crash, malformed result, missing evidence, stale artifact, and interrupted persistence.

**Exit gate:**

- Every allowed and forbidden transition is tested.
- A crash at each state resumes to the expected next safe action.
- Malformed or unsuccessful results cannot advance state.
- Event replay produces the same state as uninterrupted execution.
- Duplicate event delivery does not repeat a protected side effect.

**Deferred implementation plans:**

- State machine package.
- Event and artifact storage package.
- Policy package.
- Fault-injection test infrastructure.

**P0 Implementation Evidence (2026-08-20):**
- `npm run typecheck:v4`: PASSED (0 errors, strict mode)
- `npm run test:v4`: PASSED (34/34 tests passing across contracts, transitions, policy, storage, controller, recovery, and fault-injection)
- `npm run build:v4`: PASSED (produces CommonJS build in `dist-v4`)
- `npm test`: PASSED (all 976 existing v3 tests pass + 34 v4 tests pass = 1010 total passing tests)
- Single-process append-only durability validated on Windows (Node.js 20+). Cross-process concurrent file locking is unsupported in P0. No external agent adapters claimed yet.

### Milestone 2: Codex Adapter

**Target duration:** active month 4

**Purpose:** validate the adapter contract against the first real host.

**Deliverables:**

- Codex availability and version preflight.
- Capability declaration.
- Safe and explicitly elevated permission modes.
- Structured request and result translation.
- Cancellation, timeout, output capture, and usage capture where supported.
- Shared adapter contract tests.
- Codex slice of the official benchmark.

**Exit gate:**

- Contract suite passes.
- Safe mode never adds a bypass flag.
- Provider failure cannot be reported as success.
- Required artifacts and evidence are validated after every applicable step.
- Compatibility record identifies the verified Codex CLI version.

### Milestone 3: Claude Code Adapter

**Target duration:** active month 5

**Purpose:** prove that the core contract is vendor-neutral.

**Deliverables:**

- Claude Code availability and version preflight.
- Native CLI or agent SDK integration with actual workspace and tool capability.
- Capability declaration and permission mapping.
- Structured result handling without relying on final prose for transitions.
- Shared contract tests and benchmark slice.

**Exit gate:**

- The adapter passes the same suite used by Codex.
- Direct SDK mode is exposed only if it can perform the declared workspace operations.
- Unsupported capabilities fail during preflight.
- Compatibility record identifies the verified Claude Code version and mode.

### Milestone 4: Antigravity Adapter

**Target duration:** active month 6

**Purpose:** support the maintainer's primary multi-agent environment without weakening safety defaults.

**Deliverables:**

- Antigravity availability, workspace, and version preflight.
- Capability and model-selection mapping isolated in the adapter.
- Safe default invocation and explicit elevated mode.
- Robust timeout, output, and workspace handling.
- Shared contract tests and benchmark slice.

**Exit gate:**

- The adapter passes the shared suite.
- Workspace scope is verified before the run starts.
- Dangerous permission flags appear only after explicit opt-in.
- CLI output changes fail visibly rather than being misclassified as success.

### Milestone 5: Verification and Acceptance

**Target duration:** active months 7-8

**Purpose:** make completion evidence-based and project-configurable.

**Deliverables:**

- Gate registry and project gate policy.
- Deterministic command evidence collection.
- Correct four-state gate semantics.
- Requirement-to-evidence mapping.
- Agent judgement fallback with recorded rationale.
- Evidence bundle export.
- Bounded repair and acceptance loops.

**Exit gate:**

- Missing test configuration cannot silently produce a green test result.
- Mandatory inconclusive gates obey fail-closed policy.
- Every accepted requirement points to valid evidence.
- Fault injection produces zero false-green runs.
- Repair loops stop when progress is absent.

### Milestone 6: Dogfood and Resilience

**Implementation status (2026-08-29):** deterministic control-plane work now covers disabled runtime-activated external contracts, atomic event durability, artifact tamper recovery, repeated-timeout/filesystem fault handling, strict reliability/profile/version-comparison aggregation, backup-first migration/rollback, and dated compatibility smoke evidence. Gate 1 JavaScript live dogfood is qualified. Gate 2 is blocked on reproducible Python test dependencies plus paid-run approval; Gate 3 is blocked on an immutable Git baseline, a failing Tailwind/PostCSS baseline build, and paid-run approval. Therefore Milestone 6 is not yet release-qualified.

**Target duration:** active months 9-10

**Purpose:** validate v4 under real workloads and hostile operating conditions.

**Test projects:**

- Omni itself.
- One representative frontend or full-stack JavaScript project.
- One representative non-JavaScript project.
- One project with partial or unusual test configuration.

**Chaos scenarios:**

- Kill the Omni process during every major state.
- Agent CLI exits unsuccessfully with and without structured output.
- Network disappears during an agent step.
- CLI output format changes.
- Filesystem becomes unavailable or full during persistence.
- The same timeout repeats.
- Artifact contents change after evidence capture.
- Resume occurs after a protected side effect.

**Deliverables:**

- Reproducible dogfood reports.
- Reliability comparison against the v3 baseline.
- Performance and context-size profile.
- Migration assistant with backup and dry-run support.
- Compatibility smoke-test workflow.

**Exit gate:**

- Reliable completion rate reaches at least 90% for applicable benchmark tasks.
- Every defined crash scenario resumes correctly.
- No defined chaos scenario creates a false success.
- Migration leaves the original v3 files recoverable.
- Correctness regressions are resolved before token or speed optimization.

### Milestone 7: Public Beta and Stable Release

**Target duration:** active months 11-12

**Purpose:** ship v4 without converting early adopters into involuntary testers.

**Release progression:**

1. `4.0.0-alpha`: contract and storage format may still change with migration notes.
2. `4.0.0-beta`: public CLI and artifact schema are frozen except for critical corrections.
3. `4.0.0-rc`: only release-blocking fixes and documentation corrections.
4. `4.0.0`: all release SLOs met across repeated clean runs.

**Deliverables:**

- Installation and quickstart documentation.
- Provider setup and compatibility matrix.
- Policy examples for safe, CI, and explicitly elevated operation.
- Troubleshooting and recovery guide.
- V3 migration and rollback guide.
- Local report export for reliability metrics.
- Curated changelog and release notes.

**Exit gate:**

- All v4.0 release SLOs pass in repeated clean environments.
- All three adapters are first-class or the release scope is explicitly reduced before release.
- A fresh user can complete setup, run, inspect, interrupt, and resume from the documentation.
- No release step commits, pushes, publishes, or deploys without explicit approval.

## 8. Dependency Order

```text
Contracts and benchmark
        |
        v
Reliability kernel
        |
        +------> Codex adapter
        |             |
        +------> Claude adapter
        |             |
        +------> Antigravity adapter
                      |
                      v
          Verification and acceptance
                      |
                      v
             Dogfood and resilience
                      |
                      v
               Beta and stable
```

No adapter may define state-machine behavior. Verification work may begin experimentally during adapter development, but it does not become a release dependency until the adapter contract is stable.

## 9. Maintenance Operating Model

### 9.1 Work cadence

- Keep one active implementation workstream.
- Use 4-6 week development cycles.
- End each cycle with benchmark execution, documentation refresh, and dependency review.
- Each cycle must produce an independently testable deliverable.
- Milestone completion depends on its exit gate, not elapsed calendar time.

### 9.2 Priority order

1. P0 correctness and safety: invalid transitions, false success, state loss, or unauthorized execution.
2. P1 compatibility: supported CLI or operating-system behavior breaks.
3. P2 reliability: diagnostics, retry, resume, and evidence quality.
4. P3 efficiency: token use, wall-clock time, and concurrency.
5. P4 convenience: additional commands, templates, interfaces, or providers.

P3 and P4 work does not displace unresolved P0-P2 work.

### 9.3 Cycle checklist

At the start of a cycle:

- Select one milestone slice and write its focused design specification.
- Convert that specification into a task-level implementation plan.
- Record the benchmark cases affected by the slice.
- Confirm that the branch and working tree do not contain unrelated changes.

During a cycle:

- Keep changes independently testable and reviewable.
- Add failure-path tests before implementing orchestration behavior.
- Record architecture changes as decisions, not only in commit messages.
- Do not combine provider-specific behavior with core behavior.

At the end of a cycle:

- Run unit, contract, fault-injection, and applicable benchmark tests.
- Compare reliability metrics with the previous accepted baseline.
- Update compatibility records and user documentation.
- Record deferred findings without expanding the active scope.

## 10. Compatibility Policy

- Each adapter owns fixtures and smoke tests for its native interface.
- Every release records the most recently verified host CLI version.
- Automated compatibility failure changes an adapter status from first-class to experimental until corrected.
- Core releases are independent from provider release schedules.
- Model identifiers, pricing, and native command flags do not live in core.
- Structured output is preferred, but no adapter may invent success when structured output is unavailable.
- Operating-system claims require tests on that operating system.

## 11. V3 Maintenance and Migration

### 11.1 While v4 is under development

V3 accepts only:

- Security fixes.
- Data-loss or state-corruption fixes.
- Severe compatibility fixes.
- Documentation corrections needed to prevent unsafe use.

New orchestration features belong to v4.

### 11.2 Migration rules

- Migration begins with preflight and a dry-run report.
- Existing v3 files are backed up before any conversion.
- V4 artifacts use a distinguishable schema version.
- Migration never overwrites an unrecognized or user-modified artifact silently.
- Rollback instructions are tested against representative v3 projects.

### 11.3 V3 end of maintenance

- Announce the maintenance window when v4 reaches beta reliability.
- Continue critical maintenance for six months after that announcement.
- Move v3 to archived or LTS status after the window; do not delete its history or documentation.

## 12. Risk Register

| Risk | Early signal | Mitigation | Stop condition |
|---|---|---|---|
| Rewrite takes too long | No executable kernel after two active months | Reduce schemas and commands to the minimum required by the fake adapter | Pause adapter work until kernel exit gate passes |
| Provider CLI churn | Fixtures or smoke tests fail after host update | Isolate native details and record verified versions | Downgrade adapter to experimental |
| False confidence from tests | Unit suite passes but benchmark fails | Require benchmark and fault-injection gates | Do not publish stable |
| Scope expands into a platform | Dashboard, marketplace, or cloud work enters milestones | Enforce v4.0 non-goals | Move proposal to post-v4 backlog |
| Solo-maintainer overload | More than one active subsystem or unresolved P0 backlog grows | WIP limit of one and severity-first triage | Suspend feature development |
| Agent prose drives state | Parser depends on free-form success language | Require structured result plus artifact validation | Treat response as invalid |
| Unsafe native defaults | Adapter always adds elevated permission flags | Central policy and adapter contract tests | Adapter cannot be first-class |
| Cross-platform claims drift | Windows-only or Unix-only assumptions appear | OS-specific CI and declared support matrix | Narrow documented support |
| V3 and v4 confuse users | Commands or artifacts overlap without version markers | Explicit prerelease naming and migration guide | Delay public beta |

## 13. Decision Gates

The maintainer should explicitly reconsider the project at these points:

### After Milestone 1

Continue only if the kernel demonstrates replayable state and fail-closed transitions. If not, simplify the workflow states and artifact model before integrating agents.

### After the Codex adapter

Confirm that the adapter contract is practical with a real host. Revise the contract once here if required; avoid carrying a known-bad abstraction into the other adapters.

### After all three adapters

Compare maintenance burden. If one host requires disproportionate special cases, keep it experimental rather than contaminating core.

### Before beta

Compare v4 against v3 and direct native-agent use. V4 must show a measurable reliability advantage, not merely a more elaborate workflow.

### Before stable

Release only if the SLOs pass repeatedly in clean environments. A calendar target is not sufficient justification.

## 14. Post-v4 Backlog

These items may be reconsidered only after v4 reliability is stable:

- Public plugin SDK for community adapters and custom gates.
- Standardized CI/headless execution profile.
- Full Windows, Linux, and macOS compatibility matrix.
- Signed evidence and provenance.
- Local event-timeline dashboard.
- Gemini or Cursor runtime adapters based on demonstrated demand.
- Team policy sharing without a hosted control plane.

Cloud services, a marketplace, and enterprise administration require separate product validation and architecture decisions.

## 15. How to Resume Work Later

When returning after a long pause:

1. Read this roadmap and identify the first milestone whose exit gate is not met.
2. Read the latest architecture decisions and compatibility records for that milestone.
3. Run the accepted test and benchmark baseline before changing code.
4. Select one deliverable from the milestone.
5. Write a focused design specification for that deliverable.
6. Write a task-level implementation plan with exact files and tests.
7. Implement only that slice and re-run the affected benchmark cases.
8. Update the milestone evidence and exit-gate status.

This sequence is the canonical restart point; the age of the roadmap does not imply that unfinished milestones should be skipped.

## 16. Roadmap Governance

Changes to product positioning, first-class agent scope, safety defaults, core contracts, v3 lifecycle, or stable-release SLOs require an explicit architecture or product decision record.

Routine task decomposition, implementation details, test fixtures, and compatibility patches do not require changes to this roadmap unless they alter a milestone outcome or exit gate.

The roadmap should be reviewed at the end of each milestone and updated only with evidence from implementation, benchmark results, or material changes in supported agent platforms.
