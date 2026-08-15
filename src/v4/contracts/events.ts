import { z } from "zod";
import { asEventId, asRunId, asStepId } from "./ids";
import { StepResultSchema } from "./step-result";
import { RunPhaseSchema, CapabilitySchema } from "./run";

const BaseEventSchema = z.object({
  eventId: z.string().transform(asEventId),
  runId: z.string().transform(asRunId),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
});

export const RunEventSchema = z.discriminatedUnion("type", [
  BaseEventSchema.extend({
    type: z.literal("RunStarted"),
    initialPhase: RunPhaseSchema,
  }).strict(),
  BaseEventSchema.extend({
    type: z.literal("StepStarted"),
    stepId: z.string().transform(asStepId),
  }).strict(),
  BaseEventSchema.extend({
    type: z.literal("StepCompleted"),
    stepId: z.string().transform(asStepId),
    result: StepResultSchema,
  }).strict(),
  BaseEventSchema.extend({
    type: z.literal("CapabilityRequested"),
    capability: CapabilitySchema,
    reason: z.string(),
  }).strict(),
  BaseEventSchema.extend({
    type: z.literal("RunPhaseChanged"),
    phase: RunPhaseSchema,
  }).strict(),
  BaseEventSchema.extend({
    type: z.literal("RunFailed"),
    reason: z.string(),
  }).strict(),
  BaseEventSchema.extend({
    type: z.literal("RunSucceeded"),
  }).strict(),
]);

export type RunEvent = z.infer<typeof RunEventSchema>;
