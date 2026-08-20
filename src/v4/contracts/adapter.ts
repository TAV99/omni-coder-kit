import { z } from "zod";
import type { ArtifactId, RunId, StepId } from "./ids";
import { CapabilitySchema, RunPhaseSchema, SideEffectClassSchema, type Capability, type RunPhase, type SideEffectClass } from "./run";

export const AdapterProbeSchema = z
  .object({
    available: z.boolean(),
    adapterId: z.string().min(1),
    binary: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    capabilities: z.array(CapabilitySchema).readonly(),
    diagnostics: z.array(z.string()).readonly(),
  })
  .strict();

export interface AdapterProbe {
  readonly available: boolean;
  readonly adapterId: string;
  readonly binary?: string | undefined;
  readonly version?: string | undefined;
  readonly capabilities: readonly Capability[];
  readonly diagnostics: readonly string[];
}

export interface StepRequest {
  readonly runId: RunId;
  readonly stepId: StepId;
  readonly phase: RunPhase;
  readonly operationId: string;
  readonly workspaceDir: string;
  readonly prompt: string;
  readonly requiredCapabilities: readonly Capability[];
  readonly sideEffect: SideEffectClass;
  readonly timeoutMs: number;
}

export interface AdapterContext {
  readonly signal: AbortSignal;
  readonly elevatedPermissions: boolean;
  readonly resumeSessionId?: string;
}

export interface AgentAdapter {
  readonly id: string;
  probe(signal?: AbortSignal): Promise<AdapterProbe>;
  execute(request: StepRequest, context: AdapterContext): Promise<unknown>;
  cancel(executionId: string): Promise<void>;
}
