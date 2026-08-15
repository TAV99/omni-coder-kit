import { z } from "zod";
import type { RunId, StepId } from "./ids";

export const RunPhaseSchema = z.enum([
  "INTAKE",
  "PLAN",
  "EXECUTE",
  "VERIFY",
  "FIX",
  "ACCEPT",
  "REWORK",
  "DOCUMENT",
  "READY",
  "BLOCKED",
  "CANCELLED",
]);

export type RunPhase = z.infer<typeof RunPhaseSchema>;

export const CapabilitySchema = z.enum([
  "workspace.read",
  "workspace.write",
  "shell",
  "structured-output",
  "streaming",
  "cancel",
  "native-resume",
  "usage",
  "subagents",
]);

export type Capability = z.infer<typeof CapabilitySchema>;

export type SideEffectClass = "read-only" | "workspace-write" | "external";

export interface RunState {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly phase: RunPhase;
  readonly sequence: number;
  readonly attempt: number;
  readonly sameFailureCount: number;
  readonly lastFailureSignature?: string;
  readonly inFlight?: {
    readonly stepId: StepId;
    readonly operationId: string;
    readonly sideEffect: SideEffectClass;
  };
  readonly startedAt: string;
  readonly updatedAt: string;
}
