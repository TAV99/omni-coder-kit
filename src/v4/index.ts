export const V4_SCHEMA_VERSION = 1 as const;

export * from "./contracts";
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
