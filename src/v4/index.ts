export const V4_SCHEMA_VERSION = 1 as const;

export * from "./contracts";
export {
  QualityError,
  QUALITY_ERROR_CODES,
  type QualityErrorCode,
} from "./quality/errors";
export { loadRequirements } from "./quality/requirements";
export {
  loadQualityConfig,
  QualityConfigSchema,
  type QualityConfig,
} from "./quality/config";
export { GateRegistry } from "./quality/gate-registry";
export { GateRunner, type GateRunnerContext } from "./quality/gate-runner";
export {
  GateScheduler,
  validateGateDag,
  type GateSchedulerOptions,
  type GateScheduleResult,
} from "./quality/gate-scheduler";
export {
  type RunMetrics,
  RunMetricsSchema,
  type AdapterIdentity,
} from "./metrics/contracts";
export { MetricsCollector, type MetricsCollectorInput } from "./metrics/collector";
export {
  BudgetPolicy,
  type BudgetEvaluationResult,
  type BudgetBreach,
} from "./metrics/budget-policy";
export {
  type BenchmarkManifest,
  type BenchmarkCase,
  type BenchmarkExpectation,
  BenchmarkManifestSchema,
  BenchmarkCaseSchema,
  BenchmarkExpectationSchema,
} from "./benchmark/contracts";
export { loadBenchmarkManifest } from "./benchmark/manifest";
export {
  BenchmarkRunner,
  type BenchmarkCaseResult,
  type BenchmarkRunReport,
  type BenchmarkRunnerOptions,
} from "./benchmark/runner";
export {
  generateBenchmarkJson,
  generateBenchmarkMarkdown,
  writeBenchmarkArtifacts,
} from "./benchmark/report";
export {
  aggregateBenchmarkReliability,
  renderBenchmarkAggregateMarkdown,
  BenchmarkAggregationInputSchema,
  BenchmarkAggregateSchema,
  type BenchmarkAggregationInput,
  type BenchmarkAggregate,
} from "./benchmark/aggregate";
export {
  profileBenchmarkRuns,
  renderBenchmarkProfileMarkdown,
  BenchmarkProfileInputSchema,
  BenchmarkProfileSchema,
  type BenchmarkProfileInput,
  type BenchmarkProfile,
} from "./benchmark/profile";
export {
  compareBenchmarkVersions,
  renderVersionComparisonMarkdown,
  VersionComparisonInputSchema,
  VersionComparisonSchema,
  type VersionComparisonInput,
  type VersionComparison,
} from "./benchmark/version-comparison";
export {
  AcceptanceEngine,
  type AgentJudgement,
} from "./quality/acceptance-engine";
export { AgentJudge, type JudgeContext } from "./quality/agent-judge";
export {
  RepairPolicy,
  type RepairDecision,
  type RepairPolicyOptions,
} from "./quality/repair-policy";
export {
  EvidenceBundleStore,
  EvidenceBundleSchema,
  type EvidenceBundle,
  type EvidenceBundleStoreOptions,
} from "./quality/evidence-bundle-store";
export {
  QualityCoordinator,
  type QualityCoordinatorDeps,
} from "./quality/quality-coordinator";
export {
  RunOrchestrator,
  type RunOrchestratorDeps,
  type OrchestrationResult,
} from "./orchestration/run-orchestrator";
export { RunController, type RunControllerDeps } from "./core/controller";
export { recoverRun, type ResumeResult } from "./core/recovery";
export {
  createInitialState,
  reduceEvent,
  EventSequenceError,
  InvalidStateError,
} from "./core/reducer";
export {
  nextPhaseOnSuccess,
  isAllowedTransition,
  successTransitions,
  TransitionError,
} from "./core/transitions";
export {
  createDefaultPolicy,
  DefaultPolicy,
  DEFAULT_POLICY_CONFIG,
  type DefaultPolicyConfig,
} from "./policy/default-policy";
export {
  FileEventStore,
  replayRun,
  CorruptEventLogError,
  EventSequenceConflictError,
  type EventStore,
} from "./storage/event-store";
export {
  FileArtifactStore,
  type ArtifactStore,
  type ArtifactRecordInput,
  type ArtifactVerificationInput,
  type ArtifactVerification,
} from "./storage/artifact-store";
export { resolveRunDir, resolveEventsPath } from "./storage/paths";

export { NodeProcessRunner } from "./process/node-process-runner";
export type {
  ProcessRequest,
  ProcessOutput,
  ProcessResult,
  ProcessRunner,
} from "./process/types";

export {
  loadCompatibilityManifest,
  HostSpecSchema,
  CompatibilityManifestSchema,
  type HostSpec,
  type CompatibilityManifest,
} from "./compatibility/manifest";
export {
  probeHost,
  extractSemver,
  type CompatibilityStatus,
  type HostCompatibilityResult,
} from "./compatibility/probe";
export {
  createSmokeEvidence,
  renderSmokeEvidenceMarkdown,
  writeSmokeEvidence,
  validatePromotionEvidence,
  SmokeEvidenceSchema,
  type SmokeEvidence,
  type SmokeEvidenceInput,
  type PromotionRequest,
  type PromotionPlan,
} from "./compatibility/smoke-evidence";
export {
  runCompatibilitySmoke,
  type CompatibilitySmokeOptions,
  type CompatibilitySmokeResult,
} from "./compatibility/smoke-runner";
export {
  createMigrationPlan,
  applyMigration,
  verifyBackup,
  rollbackMigration,
  MigrationPlanSchema,
  type MigrationPlan,
  type MigrationReceipt,
} from "./migration/migrator";
export {
  parseMigrationCliArgs,
  runMigrationCli,
  type MigrationCliArgs,
} from "./migration/cli";

export {
  CodexAdapter,
  type CodexAdapterOptions,
} from "./adapters/codex/adapter";
export {
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterOptions,
} from "./adapters/claude/adapter";
export {
  DEFAULT_CLAUDE_TOOL_POLICY,
  type ClaudeToolPolicy,
} from "./adapters/claude/command";
export {
  AntigravityAdapter,
  type AntigravityAdapterOptions,
} from "./adapters/antigravity/adapter";
export {
  createAdapter,
  listAdapterStatuses,
  UnsupportedAdapterError,
  AdapterNotReadyError,
  type HostId,
  type AdapterRegistryOptions,
  type AdapterHostOptions,
} from "./adapters/registry";

import { FakeAdapter, type FakeAdapterOptions, type FakeOutcome } from "./testing/fake-adapter";
import { faultScenarios, type FaultScenarioFixture } from "./testing/fault-scenarios";
import { runAdapterContractSuite, type AdapterFactory, type AdapterContractOptions } from "./testing/adapter-contract";

export const testing = {
  FakeAdapter,
  faultScenarios,
  runAdapterContractSuite,
} as const;

export type {
  FakeAdapterOptions,
  FakeOutcome,
  FaultScenarioFixture,
  AdapterFactory,
  AdapterContractOptions,
};
