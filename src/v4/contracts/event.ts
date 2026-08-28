import { z } from "zod";
import { asEventId, asRunId, asStepId, type EventId, type RunId, type StepId } from "./ids";
import { RunPhaseSchema, SideEffectClassSchema, type RunPhase, type SideEffectClass } from "./run";
import { ArtifactRecordSchema, type ArtifactRecord } from "./artifact";
import { StepResultSchema, type StepResult } from "./step-result";
import {
  PreflightDecisionSchema,
  FailureDecisionSchema,
  ResumeDecisionSchema,
  type PreflightDecision,
  type FailureDecision,
  type ResumeDecision,
} from "./policy";
import {
  GateIdSchema,
  RequirementIdSchema,
  QualityCycleIdSchema,
  GateResultSchema,
  QualityEvidenceSchema,
  RequirementVerdictSchema,
  QualityDecisionSchema,
  type GateId,
  type RequirementId,
  type QualityCycleId,
  type GateResult,
  type QualityEvidence,
  type RequirementVerdict,
  type QualityDecision,
} from "./quality";

const BaseEventFields = {
  schemaVersion: z.literal(1),
  eventId: z.string().min(1).transform(asEventId),
  runId: z.string().min(1).transform(asRunId),
  sequence: z.number().int().nonnegative(),
  at: z.string().datetime({ offset: true }),
};

export const RunCreatedPayloadSchema = z
  .object({
    startedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const StepStartedPayloadSchema = z
  .object({
    stepId: z.string().min(1).transform(asStepId),
    operationId: z.string().min(1),
    phase: RunPhaseSchema,
    sideEffect: SideEffectClassSchema,
    workspaceDir: z.string().min(1),
  })
  .strict();

export const ArtifactRecordedPayloadSchema = z
  .object({
    record: ArtifactRecordSchema,
  })
  .strict();

export const StepSucceededPayloadSchema = z
  .object({
    stepId: z.string().min(1).transform(asStepId),
    operationId: z.string().min(1),
    result: StepResultSchema.and(
      z.object({
        status: z.literal("succeeded"),
      })
    ),
  })
  .strict();

export const StepFailedPayloadSchema = z
  .object({
    stepId: z.string().min(1).transform(asStepId),
    operationId: z.string().min(1),
    result: StepResultSchema.and(
      z.object({
        status: z.literal("failed"),
      })
    ),
  })
  .strict();

export const StepBlockedPayloadSchema = z
  .object({
    stepId: z.string().min(1).transform(asStepId),
    operationId: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export const StepCancelledPayloadSchema = z
  .object({
    stepId: z.string().min(1).transform(asStepId),
    operationId: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export const StepInterruptedPayloadSchema = z
  .object({
    stepId: z.string().min(1).transform(asStepId),
    operationId: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export const PolicyDecidedPayloadSchema = z.discriminatedUnion("stage", [
  z
    .object({
      stage: z.literal("preflight"),
      stepId: z.string().min(1).transform(asStepId),
      operationId: z.string().min(1),
      decision: PreflightDecisionSchema,
    })
    .strict(),
  z
    .object({
      stage: z.literal("failure"),
      stepId: z.string().min(1).transform(asStepId),
      operationId: z.string().min(1),
      decision: FailureDecisionSchema,
    })
    .strict(),
  z
    .object({
      stage: z.literal("resume"),
      stepId: z.string().min(1).transform(asStepId),
      operationId: z.string().min(1),
      decision: ResumeDecisionSchema,
    })
    .strict(),
]);

export const RunTransitionedPayloadSchema = z
  .object({
    stepId: z.string().min(1).transform(asStepId),
    operationId: z.string().min(1),
    from: RunPhaseSchema,
    to: RunPhaseSchema,
    causedByEventId: z.string().min(1).transform(asEventId),
  })
  .strict();

export const RunBlockedPayloadSchema = z
  .object({
    reason: z.string().min(1),
    requiredAction: z.string().min(1),
    causedByEventId: z.string().min(1).transform(asEventId),
  })
  .strict();

export const RunCancelledPayloadSchema = z
  .object({
    reason: z.string().min(1),
    causedByEventId: z.string().min(1).transform(asEventId),
  })
  .strict();

export const QualityStartedPayloadSchema = z
  .object({
    cycleId: QualityCycleIdSchema,
    phase: RunPhaseSchema,
    startedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const GateStartedPayloadSchema = z
  .object({
    cycleId: QualityCycleIdSchema,
    gateId: GateIdSchema,
    operationId: z.string().min(1),
    startedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const GateCompletedPayloadSchema = z
  .object({
    result: GateResultSchema,
    evidence: QualityEvidenceSchema.optional(),
  })
  .strict();

export const RequirementEvaluatedPayloadSchema = z
  .object({
    verdict: RequirementVerdictSchema,
  })
  .strict();

export const QualityCompletedPayloadSchema = z
  .object({
    cycleId: QualityCycleIdSchema,
    decision: QualityDecisionSchema,
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const RepairDecidedPayloadSchema = z
  .object({
    cycleId: QualityCycleIdSchema,
    requirementIds: z.array(RequirementIdSchema).min(1).readonly(),
    attempt: z.number().int().positive(),
    reason: z.string().min(1),
  })
  .strict();

export const RunRoutedPayloadSchema = z
  .object({
    from: RunPhaseSchema,
    to: RunPhaseSchema,
    causedByEventId: z.string().min(1).transform(asEventId),
  })
  .strict();

export type RunEventType =
  | "run.created"
  | "step.started"
  | "step.succeeded"
  | "step.failed"
  | "step.blocked"
  | "step.cancelled"
  | "step.interrupted"
  | "artifact.recorded"
  | "policy.decided"
  | "run.transitioned"
  | "run.blocked"
  | "run.cancelled"
  | "quality.started"
  | "gate.started"
  | "gate.completed"
  | "requirement.evaluated"
  | "quality.completed"
  | "repair.decided"
  | "run.routed";

export type RunEvent =
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "run.created";
      readonly payload: { readonly startedAt: string };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "step.started";
      readonly payload: {
        readonly stepId: StepId;
        readonly operationId: string;
        readonly phase: RunPhase;
        readonly sideEffect: SideEffectClass;
        readonly workspaceDir: string;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "artifact.recorded";
      readonly payload: { readonly record: ArtifactRecord };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "step.succeeded";
      readonly payload: {
        readonly stepId: StepId;
        readonly operationId: string;
        readonly result: StepResult & { readonly status: "succeeded" };
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "step.failed";
      readonly payload: {
        readonly stepId: StepId;
        readonly operationId: string;
        readonly result: StepResult & { readonly status: "failed" };
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "step.blocked";
      readonly payload: {
        readonly stepId: StepId;
        readonly operationId: string;
        readonly reason: string;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "step.cancelled";
      readonly payload: {
        readonly stepId: StepId;
        readonly operationId: string;
        readonly reason: string;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "step.interrupted";
      readonly payload: {
        readonly stepId: StepId;
        readonly operationId: string;
        readonly reason: string;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "policy.decided";
      readonly payload:
        | {
            readonly stage: "preflight";
            readonly stepId: StepId;
            readonly operationId: string;
            readonly decision: PreflightDecision;
          }
        | {
            readonly stage: "failure";
            readonly stepId: StepId;
            readonly operationId: string;
            readonly decision: FailureDecision;
          }
        | {
            readonly stage: "resume";
            readonly stepId: StepId;
            readonly operationId: string;
            readonly decision: ResumeDecision;
          };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "run.transitioned";
      readonly payload: {
        readonly stepId: StepId;
        readonly operationId: string;
        readonly from: RunPhase;
        readonly to: RunPhase;
        readonly causedByEventId: EventId;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "run.blocked";
      readonly payload: {
        readonly reason: string;
        readonly requiredAction: string;
        readonly causedByEventId: EventId;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "run.cancelled";
      readonly payload: {
        readonly reason: string;
        readonly causedByEventId: EventId;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "quality.started";
      readonly payload: {
        readonly cycleId: QualityCycleId;
        readonly phase: RunPhase;
        readonly startedAt: string;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "gate.started";
      readonly payload: {
        readonly cycleId: QualityCycleId;
        readonly gateId: GateId;
        readonly operationId: string;
        readonly startedAt: string;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "gate.completed";
      readonly payload: {
        readonly result: GateResult;
        readonly evidence?: QualityEvidence | undefined;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "requirement.evaluated";
      readonly payload: {
        readonly verdict: RequirementVerdict;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "quality.completed";
      readonly payload: {
        readonly cycleId: QualityCycleId;
        readonly decision: QualityDecision;
        readonly completedAt: string;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "repair.decided";
      readonly payload: {
        readonly cycleId: QualityCycleId;
        readonly requirementIds: readonly RequirementId[];
        readonly attempt: number;
        readonly reason: string;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly eventId: EventId;
      readonly runId: RunId;
      readonly sequence: number;
      readonly at: string;
      readonly type: "run.routed";
      readonly payload: {
        readonly from: RunPhase;
        readonly to: RunPhase;
        readonly causedByEventId: EventId;
      };
    };

export const RunEventSchema: z.ZodType<RunEvent> = z.discriminatedUnion("type", [
  z.object({ ...BaseEventFields, type: z.literal("run.created"), payload: RunCreatedPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("step.started"), payload: StepStartedPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("artifact.recorded"), payload: ArtifactRecordedPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("step.succeeded"), payload: StepSucceededPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("step.failed"), payload: StepFailedPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("step.blocked"), payload: StepBlockedPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("step.cancelled"), payload: StepCancelledPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("step.interrupted"), payload: StepInterruptedPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("policy.decided"), payload: PolicyDecidedPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("run.transitioned"), payload: RunTransitionedPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("run.blocked"), payload: RunBlockedPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("run.cancelled"), payload: RunCancelledPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("quality.started"), payload: QualityStartedPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("gate.started"), payload: GateStartedPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("gate.completed"), payload: GateCompletedPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("requirement.evaluated"), payload: RequirementEvaluatedPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("quality.completed"), payload: QualityCompletedPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("repair.decided"), payload: RepairDecidedPayloadSchema }).strict(),
  z.object({ ...BaseEventFields, type: z.literal("run.routed"), payload: RunRoutedPayloadSchema }).strict(),
]);
