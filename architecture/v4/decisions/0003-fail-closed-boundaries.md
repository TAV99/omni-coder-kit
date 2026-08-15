# ADR-0003: Fail-Closed Boundaries

## Status
Accepted

## Context
Agent adapter outputs are inherently untrusted and can produce malformed data, unexpected structures, or malicious side effects.

## Decision
Adapter output is strictly untrusted. Only schema-valid success results, accompanied by verified artifacts and evidence, can advance a run. Skipped or inconclusive results are not passed, and elevated permissions are never selected implicitly.

## Alternatives Considered
- Trust adapter output implicitly: rejected because LLMs hallucinate fields or omit required evidence.
- Silently fix malformed output: rejected because it masks adapter bugs and degrades safety guarantees.

## Consequences
- A strict Zod validation layer must exist at all adapter boundaries.
- Any deviation from the schema results in immediate failure or block.
- Permissions require explicit configuration and cannot be granted dynamically by the agent alone.
