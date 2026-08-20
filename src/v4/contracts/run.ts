import { z } from "zod";
import type { RunId, StepId } from "./ids";

export const RUN_PHASES = [
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
] as const;

export const RunPhaseSchema = z.enum(RUN_PHASES);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

export const CAPABILITIES = [
  "workspace.read",
  "workspace.write",
  "shell",
  "structured-output",
  "streaming",
  "cancel",
  "native-resume",
  "usage",
  "subagents",
] as const;

export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;

export const SIDE_EFFECT_CLASSES = [
  "read-only",
  "workspace-write",
  "external",
] as const;

export const SideEffectClassSchema = z.enum(SIDE_EFFECT_CLASSES);
export type SideEffectClass = z.infer<typeof SideEffectClassSchema>;

export interface RunState {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly phase: RunPhase;
  readonly sequence: number;
  readonly attempt: number;
  readonly sameFailureCount: number;
  readonly lastFailureSignature?: string | undefined;
  readonly inFlight?:
    | {
        readonly stepId: StepId;
        readonly operationId: string;
        readonly sideEffect: SideEffectClass;
      }
    | undefined;
  readonly startedAt: string;
  readonly updatedAt: string;
}
