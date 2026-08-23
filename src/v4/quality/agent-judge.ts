import { z } from "zod";
import {
  asQualityEvidenceId,
  asRequirementId,
  indexAndValidateEvidenceCollection,
  QualityEvidenceIdSchema,
  RequirementIdSchema,
  RequirementStatusSchema,
  type QualityCycleId,
  type QualityEvidence,
  type QualityEvidenceId,
  type RequirementRecord,
} from "../contracts/quality";
import { asStepId, type RunId, type StepId } from "../contracts/ids";
import type { AgentAdapter, StepRequest } from "../contracts/adapter";
import { QualityError } from "./errors";
import type { AgentJudgement } from "./acceptance-engine";

export interface JudgeContext {
  readonly runId: RunId;
  readonly cycleId: QualityCycleId;
  readonly stepId: StepId;
  readonly operationId: string;
  readonly workspaceDir: string;
  readonly adapter?: AgentAdapter | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly existingEvidence?: readonly QualityEvidence[] | undefined;
}

const StructuredJudgementSchema = z
  .object({
    requirementId: RequirementIdSchema,
    status: RequirementStatusSchema,
    rationale: z.string().min(1),
    evidenceIds: z.array(QualityEvidenceIdSchema),
  })
  .strict();

const AdapterOutcomeSchema = z.union([
  z.object({
    status: z.literal("succeeded"),
    summary: z.string().optional(),
    resultText: z.string().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    failure: z
      .object({
        code: z.string().optional(),
        message: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    status: z.enum(["blocked", "cancelled"]),
    reason: z.string().optional(),
  }),
]);

export class AgentJudge {
  async judgeRequirement(
    req: RequirementRecord,
    context: JudgeContext
  ): Promise<AgentJudgement> {
    if (req.testStrategy.kind !== "agent") {
      throw new QualityError(
        "AGENT_JUDGE_MALFORMED",
        `Cannot use AgentJudge on hard requirement '${req.requirementId}'`
      );
    }

    if (!context.adapter) {
      const msg = "AGENT_JUDGE_UNAVAILABLE: No adapter provided";
      return {
        status: "inconclusive",
        rationale: msg,
        reason: msg,
        evidenceIds: [],
      };
    }

    try {
      const probeRes = await context.adapter.probe(context.signal);
      if (!probeRes.available) {
        const msg = `AGENT_JUDGE_UNAVAILABLE: Adapter '${context.adapter.id}' is not available: ${probeRes.diagnostics.join("; ")}`;
        return {
          status: "inconclusive",
          rationale: msg,
          reason: msg,
          evidenceIds: [],
        };
      }
    } catch (err: unknown) {
      const msg = `AGENT_JUDGE_UNAVAILABLE: Adapter probe threw error: ${err instanceof Error ? err.message : String(err)}`;
      return {
        status: "inconclusive",
        rationale: msg,
        reason: msg,
        evidenceIds: [],
      };
    }

    let valColl: ReturnType<typeof indexAndValidateEvidenceCollection> | undefined;
    if (context.existingEvidence && context.existingEvidence.length > 0) {
      valColl = indexAndValidateEvidenceCollection(context.existingEvidence, {
        runId: context.runId,
        cycleId: context.cycleId,
      });

      if (!valColl.valid) {
        const msg = `AGENT_JUDGE_MALFORMED: Existing evidence validation failed: ${valColl.reason}`;
        return {
          status: "inconclusive",
          rationale: msg,
          reason: msg,
          evidenceIds: [],
        };
      }
    }

    const evidenceMeta = (context.existingEvidence ?? []).map((ev) => ({
      evidenceId: ev.evidenceId,
      gateId: ev.gateId,
      exitCode: ev.exitCode,
      stdoutSha256: ev.stdoutSha256,
      stderrSha256: ev.stderrSha256,
    }));

    const prompt = [
      `You are an automated quality acceptance judge.`,
      `Evaluate whether the workspace satisfies this requirement:`,
      `Requirement ID: ${req.requirementId}`,
      `Requirement Text: ${req.text}`,
      `Available Existing Evidence Metadata: ${JSON.stringify(evidenceMeta)}`,
      ``,
      `You MUST respond ONLY with a raw, valid JSON object with NO markdown code fences and NO surrounding text.`,
      `Required JSON schema:`,
      `{ "requirementId": "${req.requirementId}", "status": "accepted" | "rejected" | "inconclusive", "rationale": "<explanation>", "evidenceIds": ["<id>"] }`,
    ].join("\n");

    const stepReq: StepRequest = {
      runId: context.runId,
      stepId: context.stepId,
      phase: "ACCEPT",
      operationId: context.operationId,
      workspaceDir: context.workspaceDir,
      prompt,
      requiredCapabilities: ["workspace.read"],
      sideEffect: "read-only",
      timeoutMs: 30000,
    };

    let rawOutcome: unknown;
    try {
      rawOutcome = await context.adapter.execute(stepReq, {
        signal: context.signal ?? new AbortController().signal,
        elevatedPermissions: false,
      });
    } catch (err: unknown) {
      const msg = `Agent judge adapter threw error: ${err instanceof Error ? err.message : String(err)}`;
      return {
        status: "inconclusive",
        rationale: msg,
        reason: msg,
        evidenceIds: [],
      };
    }

    const parsedOutcome = AdapterOutcomeSchema.safeParse(rawOutcome);
    if (!parsedOutcome.success) {
      const msg = "AGENT_JUDGE_MALFORMED: Adapter outcome did not match expected structure";
      return {
        status: "inconclusive",
        rationale: msg,
        reason: msg,
        evidenceIds: [],
      };
    }

    if (parsedOutcome.data.status !== "succeeded") {
      const failMsg =
        parsedOutcome.data.status === "failed"
          ? parsedOutcome.data.failure?.message
          : parsedOutcome.data.reason;
      const msg = `Agent judge execution ${parsedOutcome.data.status}: ${failMsg ?? "unknown reason"}`;
      return {
        status: "inconclusive",
        rationale: msg,
        reason: msg,
        evidenceIds: [],
      };
    }

    const text = parsedOutcome.data.resultText ?? parsedOutcome.data.summary;
    if (!text || typeof text !== "string") {
      const msg = "AGENT_JUDGE_MALFORMED: Succeeded outcome missing text content";
      return {
        status: "inconclusive",
        rationale: msg,
        reason: msg,
        evidenceIds: [],
      };
    }

    const trimmed = text.trim();
    if (trimmed.startsWith("```")) {
      const msg = "AGENT_JUDGE_MALFORMED: Response contained forbidden markdown code fences";
      return {
        status: "inconclusive",
        rationale: msg,
        reason: msg,
        evidenceIds: [],
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(trimmed);
    } catch {
      const msg = "AGENT_JUDGE_MALFORMED: Response is not valid JSON";
      return {
        status: "inconclusive",
        rationale: msg,
        reason: msg,
        evidenceIds: [],
      };
    }

    const schemaRes = StructuredJudgementSchema.safeParse(parsedJson);
    if (!schemaRes.success) {
      const msg = `AGENT_JUDGE_MALFORMED: Invalid schema: ${schemaRes.error.message}`;
      return {
        status: "inconclusive",
        rationale: msg,
        reason: msg,
        evidenceIds: [],
      };
    }

    if (schemaRes.data.requirementId !== req.requirementId) {
      const msg = `AGENT_JUDGE_MALFORMED: Returned requirementId '${schemaRes.data.requirementId}' does not match expected '${req.requirementId}'`;
      return {
        status: "inconclusive",
        rationale: msg,
        reason: msg,
        evidenceIds: [],
      };
    }

    const citedIds = schemaRes.data.evidenceIds;

    // Check duplicate cited IDs
    const seenCited = new Set<QualityEvidenceId>();
    for (const cid of citedIds) {
      if (seenCited.has(cid)) {
        const msg = `AGENT_JUDGE_MALFORMED: Duplicate evidenceId '${cid}' in evidenceIds list`;
        return {
          status: "inconclusive",
          rationale: msg,
          reason: msg,
          evidenceIds: [],
        };
      }
      seenCited.add(cid);
    }

    if (citedIds.length > 0) {
      if (!valColl || !valColl.valid) {
        const msg = "AGENT_JUDGE_MALFORMED: Cited evidence IDs when no existing evidence is available";
        return {
          status: "inconclusive",
          rationale: msg,
          reason: msg,
          evidenceIds: [],
        };
      }

      for (const cid of citedIds) {
        if (!valColl.index.byId.has(cid)) {
          const msg = `AGENT_JUDGE_MALFORMED: Cited unknown or cross-run/cycle evidence ID '${cid}'`;
          return {
            status: "inconclusive",
            rationale: msg,
            reason: msg,
            evidenceIds: [],
          };
        }
      }
    }

    return {
      status: schemaRes.data.status,
      rationale: schemaRes.data.rationale,
      reason: schemaRes.data.rationale,
      evidenceIds: citedIds,
    };
  }
}
