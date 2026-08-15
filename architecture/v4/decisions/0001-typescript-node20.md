# ADR-0001: Use TypeScript strict mode on Node.js 20 for Omni v4

## Status
Accepted

## Context
V3 is CommonJS JavaScript. V4 introduces persistent schemas and cross-provider contracts where invalid variants must be rejected before state transitions.

## Decision
Build v4 in `src/v4` with TypeScript strict mode, CommonJS output, Node.js 20 minimum, Zod validation at external boundaries, and no imports from the v3 harness.

## Alternatives Considered
- Continue JavaScript with JSDoc: rejected because discriminated contracts and refactors remain easier to misuse.
- Convert all v3 code immediately: rejected because it expands rewrite risk and removes the stable fallback.
- ESM-only output: deferred because the existing package is CommonJS and v4 must coexist during development.

## Consequences
- The package Node floor becomes 20.
- V4 has an explicit build step.
- V3 remains runnable while v4 is incomplete.
