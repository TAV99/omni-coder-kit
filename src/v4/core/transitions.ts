import type { RunPhase } from "../contracts/run";

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionError";
  }
}

export const successTransitions: ReadonlyArray<readonly [RunPhase, RunPhase]> = [
  ["INTAKE", "PLAN"],
  ["PLAN", "EXECUTE"],
  ["EXECUTE", "VERIFY"],
  ["VERIFY", "ACCEPT"],
  ["FIX", "VERIFY"],
  ["ACCEPT", "DOCUMENT"],
  ["REWORK", "EXECUTE"],
  ["DOCUMENT", "READY"],
] as const;

const successTransitionMap = new Map<RunPhase, RunPhase>(
  successTransitions.map(([from, to]) => [from, to])
);

export const qualityRoutes: ReadonlyArray<readonly [RunPhase, RunPhase]> = [
  ["VERIFY", "ACCEPT"],
  ["VERIFY", "FIX"],
  ["ACCEPT", "DOCUMENT"],
  ["ACCEPT", "REWORK"],
] as const;

export function nextPhaseOnSuccess(phase: RunPhase): RunPhase {
  const next = successTransitionMap.get(phase);
  if (!next) {
    throw new TransitionError(`No normal success transition defined from phase: ${phase}`);
  }
  return next;
}

export function isAllowedTransition(from: RunPhase, to: RunPhase): boolean {
  const expected = successTransitionMap.get(from);
  return expected === to;
}

export function isAllowedQualityRoute(from: RunPhase, to: RunPhase): boolean {
  return qualityRoutes.some(([f, t]) => f === from && t === to);
}
