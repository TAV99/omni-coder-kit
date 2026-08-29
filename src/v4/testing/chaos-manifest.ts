export type RequiredChaosScenarioId =
  | "network-disconnect"
  | "cli-nonzero-structured"
  | "cli-nonzero-unstructured"
  | "cli-output-drift"
  | "event-persistence-failure"
  | "artifact-persistence-failure"
  | "evidence-persistence-failure"
  | "repeated-timeout"
  | "artifact-tamper"
  | "protected-workspace-side-effect"
  | "protected-external-side-effect";

export interface RequiredChaosScenario {
  readonly id: RequiredChaosScenarioId;
  readonly testFile: `test/v4/${string}.test.ts`;
  readonly testName: string;
  readonly expectedOutcome: "blocked" | "failed" | "inconclusive" | "corrupt-log-rejected";
  readonly faultScenario?: string;
  /** Component evidence is necessary but does not itself qualify the hostile-process R83 gate. */
  readonly qualification: "component";
}

export const REQUIRED_CHAOS_SCENARIOS: readonly RequiredChaosScenario[] = [
  {
    id: "network-disconnect",
    testFile: "test/v4/fault-injection.test.ts",
    testName: "fault-injection: table-driven suite over all fault scenarios / networkDisconnect",
    expectedOutcome: "blocked",
    faultScenario: "networkDisconnect",
    qualification: "component",
  },
  {
    id: "cli-nonzero-structured",
    testFile: "test/v4/codex-parser.test.ts",
    testName: "codex-parser: non-zero exit returns failure even if result text exists",
    expectedOutcome: "failed",
    qualification: "component",
  },
  {
    id: "cli-nonzero-unstructured",
    testFile: "test/v4/codex-parser.test.ts",
    testName: "codex-parser: non-zero exit without structured result returns failure",
    expectedOutcome: "failed",
    qualification: "component",
  },
  {
    id: "cli-output-drift",
    testFile: "test/v4/antigravity-parser.test.ts",
    testName: "antigravity-parser: rejects an ambiguous response with trailing content",
    expectedOutcome: "failed",
    qualification: "component",
  },
  {
    id: "event-persistence-failure",
    testFile: "test/v4/event-store.test.ts",
    testName: "event-store: filesystem faults preserve the last durable log",
    expectedOutcome: "failed",
    qualification: "component",
  },
  {
    id: "artifact-persistence-failure",
    testFile: "test/v4/fault-injection.test.ts",
    testName: "fault-injection: table-driven suite over all fault scenarios / filesystemUnavailable",
    expectedOutcome: "blocked",
    faultScenario: "filesystemUnavailable",
    qualification: "component",
  },
  {
    id: "evidence-persistence-failure",
    testFile: "test/v4/quality-fault-injection.test.ts",
    testName: "zero_false_green",
    expectedOutcome: "blocked",
    qualification: "component",
  },
  {
    id: "repeated-timeout",
    testFile: "test/v4/fault-injection.test.ts",
    testName: "fault-injection: table-driven suite over all fault scenarios / repeatedTimeout",
    expectedOutcome: "blocked",
    faultScenario: "repeatedTimeout",
    qualification: "component",
  },
  {
    id: "artifact-tamper",
    testFile: "test/v4/recovery.test.ts",
    testName: "recovery: re-verifies recorded artifacts before trusting READY",
    expectedOutcome: "blocked",
    qualification: "component",
  },
  {
    id: "protected-workspace-side-effect",
    testFile: "test/v4/recovery.test.ts",
    testName: "recovery: workspace-write step inFlight recovers as blocked with no adapter calls",
    expectedOutcome: "blocked",
    faultScenario: "crashAfterStepStartedWorkspaceWrite",
    qualification: "component",
  },
  {
    id: "protected-external-side-effect",
    testFile: "test/v4/fault-injection.test.ts",
    testName: "fault-injection: table-driven suite over all fault scenarios / crashAfterStepStartedExternal",
    expectedOutcome: "blocked",
    faultScenario: "crashAfterStepStartedExternal",
    qualification: "component",
  },
] as const;
