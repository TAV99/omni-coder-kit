import { z } from "zod";
import type { RunId, StepId } from "./ids";
import type { RunPhase, SideEffectClass } from "./run";
import type { AdapterProbe, StepRequest } from "./adapter";
import type { AgentStepOutcome } from "./step-result";

export const PreflightDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("allow") }).strict(),
  z.object({ kind: z.literal("deny"), reason: z.string().min(1) }).strict(),
]);

export type PreflightDecision = z.infer<typeof PreflightDecisionSchema>;

export const FailureDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("retry"), delayMs: z.number().nonnegative() }).strict(),
  z
    .object({
      kind: z.literal("block"),
      reason: z.string().min(1),
      requiredAction: z.string().min(1),
    })
    .strict(),
]);

export type FailureDecision = z.infer<typeof FailureDecisionSchema>;

export const ResumeDecisionSchema = FailureDecisionSchema;
export type ResumeDecision = z.infer<typeof ResumeDecisionSchema>;

export const PolicyDecisionSchema = z.union([PreflightDecisionSchema, FailureDecisionSchema]);
export type PolicyDecision = PreflightDecision | FailureDecision;

export interface PreflightInput {
  readonly request: StepRequest;
  readonly probe: AdapterProbe;
  readonly elevatedPermissions: boolean;
}

export interface FailureInput {
  readonly request: StepRequest;
  readonly failure: Extract<AgentStepOutcome, { status: "failed" }>["failure"];
  readonly attempt: number;
  readonly sameFailureCount: number;
}

export interface ResumeInput {
  readonly runId: RunId;
  readonly phase: RunPhase;
  readonly stepId: StepId;
  readonly operationId: string;
  readonly sideEffect: SideEffectClass;
  readonly attempt: number;
}

export interface Policy {
  evaluatePreflight(input: PreflightInput): PreflightDecision;
  decideFailure(input: FailureInput): FailureDecision;
  decideResume(input: ResumeInput): ResumeDecision;
}
