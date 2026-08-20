import type { AdapterContext, AdapterProbe, AgentAdapter, StepRequest } from "../contracts/adapter";
import type { Capability } from "../contracts/run";

export type FakeOutcome =
  | { readonly kind: "return"; readonly value: unknown }
  | { readonly kind: "throw"; readonly error: Error }
  | { readonly kind: "wait-for-abort" };

export interface FakeAdapterOptions {
  readonly id?: string;
  readonly available?: boolean;
  readonly capabilities?: readonly Capability[];
  readonly outcomes: readonly FakeOutcome[];
}

export class FakeAdapter implements AgentAdapter {
  readonly id: string;
  private readonly available: boolean;
  private readonly capabilities: readonly Capability[];
  private readonly outcomeQueue: FakeOutcome[];
  readonly calls: Array<{ request: StepRequest; context: AdapterContext }> = [];
  readonly cancelledExecutionIds: string[] = [];

  constructor(options: FakeAdapterOptions) {
    this.id = options.id ?? "fake-adapter";
    this.available = options.available ?? true;
    this.capabilities = options.capabilities ?? [
      "workspace.read",
      "workspace.write",
      "structured-output",
    ];
    this.outcomeQueue = [...options.outcomes];
  }

  async probe(_signal?: AbortSignal): Promise<AdapterProbe> {
    return {
      available: this.available,
      adapterId: this.id,
      capabilities: this.capabilities,
      diagnostics: [],
    };
  }

  async execute(request: StepRequest, context: AdapterContext): Promise<unknown> {
    this.calls.push({ request, context });

    const outcome = this.outcomeQueue.shift();
    if (!outcome) {
      throw new Error(`No queued FakeOutcome remaining in FakeAdapter '${this.id}'`);
    }

    if (outcome.kind === "return") {
      return outcome.value;
    }

    if (outcome.kind === "throw") {
      throw outcome.error;
    }

    if (outcome.kind === "wait-for-abort") {
      return new Promise((_, reject) => {
        if (context.signal.aborted) {
          return reject(context.signal.reason ?? new Error("Aborted"));
        }
        context.signal.addEventListener("abort", () => {
          reject(context.signal.reason ?? new Error("Aborted"));
        });
      });
    }

    throw new Error(`Unknown FakeOutcome kind: ${(outcome as any).kind}`);
  }

  async cancel(executionId: string): Promise<void> {
    this.cancelledExecutionIds.push(executionId);
  }
}
