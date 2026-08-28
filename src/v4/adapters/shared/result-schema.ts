export function createAgentStepOutcomeJsonSchema(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "AgentStepOutcome",
    description: "Structured result produced by a coding agent executing an Omni v4 step",
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["status", "executionId", "summary", "artifacts", "evidence"],
        properties: {
          status: { type: "string", enum: ["succeeded"] },
          executionId: { type: "string", minLength: 1 },
          summary: { type: "string" },
          artifacts: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["artifactId", "kind", "relativePath"],
              properties: {
                artifactId: { type: "string", minLength: 1 },
                kind: { type: "string", enum: ["file", "report", "manifest"] },
                relativePath: { type: "string", minLength: 1 },
              },
            },
          },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "schemaVersion",
                "kind",
                "producerStepId",
                "method",
                "startedAt",
                "durationMs",
                "artifactIds",
                "summary",
              ],
              properties: {
                schemaVersion: { type: "integer", enum: [1] },
                kind: {
                  type: "string",
                  enum: ["command", "artifact", "agent-judgement", "policy"],
                },
                producerStepId: { type: "string", minLength: 1 },
                method: { type: "string", minLength: 1 },
                startedAt: {
                  type: "string",
                  description: "ISO 8601 UTC timestamp string, e.g. 2026-08-28T15:00:00.000Z",
                },
                durationMs: { type: "number", minimum: 0 },
                artifactIds: {
                  type: "array",
                  items: { type: "string", minLength: 1 },
                },
                summary: { type: "string" },
              },
            },
          },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["status", "executionId", "failure"],
        properties: {
          status: { type: "string", enum: ["failed"] },
          executionId: { type: "string", minLength: 1 },
          failure: {
            type: "object",
            additionalProperties: false,
            required: ["code", "message", "retryable", "signature"],
            properties: {
              code: { type: "string", minLength: 1 },
              message: { type: "string", minLength: 1 },
              retryable: { type: "boolean" },
              signature: { type: "string", minLength: 1 },
            },
          },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["status", "executionId", "reason", "requiredAction"],
        properties: {
          status: { type: "string", enum: ["blocked"] },
          executionId: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 },
          requiredAction: { type: "string", minLength: 1 },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["status", "executionId", "reason"],
        properties: {
          status: { type: "string", enum: ["cancelled"] },
          executionId: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 },
        },
      },
    ],
  };
}

export function createCodexAgentStepOutcomeJsonSchema(): Record<string, unknown> {
  const baseSchema = createAgentStepOutcomeJsonSchema() as {
    oneOf: readonly Record<string, unknown>[];
  };

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "AgentStepOutcome",
    description: "Structured result produced by Codex executing an Omni v4 step",
    type: "object",
    additionalProperties: false,
    required: ["outcome"],
    properties: {
      outcome: {
        anyOf: baseSchema.oneOf,
      },
    },
  };
}
