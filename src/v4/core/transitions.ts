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
