export type RunId = string & { readonly __brand: "RunId" };
export type StepId = string & { readonly __brand: "StepId" };
export type EventId = string & { readonly __brand: "EventId" };
export type ArtifactId = string & { readonly __brand: "ArtifactId" };

export function asRunId(id: string): RunId {
  if (!id || typeof id !== "string" || id.trim().length === 0) {
    throw new Error("RunId must be a non-empty string");
  }
  if (id.includes("/") || id.includes("\\")) {
    throw new Error("RunId cannot contain path separators");
  }
  return id as RunId;
}

export function asStepId(id: string): StepId {
  if (!id || typeof id !== "string" || id.trim().length === 0) {
    throw new Error("StepId must be a non-empty string");
  }
  return id as StepId;
}

export function asEventId(id: string): EventId {
  if (!id || typeof id !== "string" || id.trim().length === 0) {
    throw new Error("EventId must be a non-empty string");
  }
  return id as EventId;
}

export function asArtifactId(id: string): ArtifactId {
  if (!id || typeof id !== "string" || id.trim().length === 0) {
    throw new Error("ArtifactId must be a non-empty string");
  }
  return id as ArtifactId;
}
