export type RunId = string & { readonly __brand: "RunId" };
export type StepId = string & { readonly __brand: "StepId" };
export type EventId = string & { readonly __brand: "EventId" };
export type ArtifactId = string & { readonly __brand: "ArtifactId" };

export function asRunId(id: string): RunId {
  if (!id) throw new Error("RunId cannot be empty");
  return id as RunId;
}

export function asStepId(id: string): StepId {
  if (!id) throw new Error("StepId cannot be empty");
  return id as StepId;
}

export function asEventId(id: string): EventId {
  if (!id) throw new Error("EventId cannot be empty");
  return id as EventId;
}

export function asArtifactId(id: string): ArtifactId {
  if (!id) throw new Error("ArtifactId cannot be empty");
  return id as ArtifactId;
}
