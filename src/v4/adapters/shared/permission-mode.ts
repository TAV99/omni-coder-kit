import type { AdapterContext, StepRequest } from "../../contracts/adapter";

export type AdapterPermissionMode = "read-only" | "workspace-write" | "elevated";

export class AdapterPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterPolicyError";
  }
}

export function resolvePermissionMode(
  request: StepRequest,
  context: AdapterContext
): AdapterPermissionMode {
  if (context.elevatedPermissions) {
    return "elevated";
  }
  if (request.sideEffect === "read-only") {
    return "read-only";
  }
  if (request.sideEffect === "workspace-write") {
    return "workspace-write";
  }
  if (request.sideEffect === "external") {
    throw new AdapterPolicyError(
      `Step '${request.stepId}' with external side-effects requires explicit elevated permissions context`
    );
  }
  return "workspace-write";
}
