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

import { FakeAdapter, type FakeAdapterOptions, type FakeOutcome } from "./testing/fake-adapter";
import { faultScenarios, type FaultScenarioFixture } from "./testing/fault-scenarios";

export const testing = {
  FakeAdapter,
  faultScenarios,
} as const;

export type { FakeAdapterOptions, FakeOutcome, FaultScenarioFixture };
