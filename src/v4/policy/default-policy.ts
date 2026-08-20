import { z } from "zod";
import type {
  FailureDecision,
  FailureInput,
  Policy,
  PreflightDecision,
  PreflightInput,
  ResumeDecision,
  ResumeInput,
} from "../contracts/policy";

export const DefaultPolicyConfigSchema = z
  .object({
    allowElevatedPermissions: z.boolean().optional(),
    maxRetriesPerStep: z.number().int().nonnegative().optional(),
    maxSameFailureCount: z.number().int().nonnegative().optional(),
    retryDelayMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export interface DefaultPolicyConfig {
  readonly allowElevatedPermissions: boolean;
  readonly maxRetriesPerStep: number;
  readonly maxSameFailureCount: number;
  readonly retryDelayMs: number;
}

export const DEFAULT_POLICY_CONFIG: DefaultPolicyConfig = {
  allowElevatedPermissions: false,
  maxRetriesPerStep: 2,
  maxSameFailureCount: 2,
  retryDelayMs: 0,
};

export class DefaultPolicy implements Policy {
  private readonly config: DefaultPolicyConfig;

  constructor(partialConfig?: Partial<DefaultPolicyConfig>) {
    if (partialConfig !== undefined) {
      DefaultPolicyConfigSchema.parse(partialConfig);
    }
    this.config = {
      allowElevatedPermissions:
        partialConfig?.allowElevatedPermissions ?? DEFAULT_POLICY_CONFIG.allowElevatedPermissions,
      maxRetriesPerStep:
        partialConfig?.maxRetriesPerStep ?? DEFAULT_POLICY_CONFIG.maxRetriesPerStep,
      maxSameFailureCount:
        partialConfig?.maxSameFailureCount ?? DEFAULT_POLICY_CONFIG.maxSameFailureCount,
      retryDelayMs: partialConfig?.retryDelayMs ?? DEFAULT_POLICY_CONFIG.retryDelayMs,
    };
  }

  evaluatePreflight(input: PreflightInput): PreflightDecision {
    const probeCaps = new Set(input.probe.capabilities);
    for (const required of input.request.requiredCapabilities) {
      if (!probeCaps.has(required)) {
        return {
          kind: "deny",
          reason: `Adapter lacks required capability: ${required}`,
        };
      }
    }

    if (input.elevatedPermissions && !this.config.allowElevatedPermissions) {
      return {
        kind: "deny",
        reason: "Elevated permissions not permitted by policy configuration",
      };
    }

    return { kind: "allow" };
  }

  decideFailure(input: FailureInput): FailureDecision {
    if (!input.failure.retryable) {
      return {
        kind: "block",
        reason: `Non-retryable failure: ${input.failure.code} - ${input.failure.message}`,
        requiredAction: "Inspect step failure details and resolve issue manually",
      };
    }

    if (input.attempt > this.config.maxRetriesPerStep) {
      return {
        kind: "block",
        reason: `Maximum retries (${this.config.maxRetriesPerStep}) exceeded for step`,
        requiredAction: "Review step prompts and error diagnostics before retrying",
      };
    }

    if (input.sameFailureCount >= this.config.maxSameFailureCount) {
      return {
        kind: "block",
        reason: `Repeated identical failure occurred ${input.sameFailureCount} times (signature: ${input.failure.signature})`,
        requiredAction: "Resolve root cause of repeated failure",
      };
    }

    return {
      kind: "retry",
      delayMs: this.config.retryDelayMs,
    };
  }

  decideResume(input: ResumeInput): ResumeDecision {
    if (input.sideEffect === "read-only") {
      return {
        kind: "retry",
        delayMs: 0,
      };
    }

    return {
      kind: "block",
      reason: `Interrupted step '${input.stepId}' has protected side-effect '${input.sideEffect}'; replay is unsafe`,
      requiredAction: "Inspect workspace manually and rerun with a fresh step request",
    };
  }
}

export function createDefaultPolicy(config?: Partial<DefaultPolicyConfig>): Policy {
  return new DefaultPolicy(config);
}
