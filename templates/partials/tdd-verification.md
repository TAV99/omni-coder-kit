**TDD Discipline — Test-Driven Development:**
Before writing production code, follow Red-Green-Refactor:

| Step | Action | Verify |
|------|--------|--------|
| RED | Write ONE failing test for the next behavior | Run test — must FAIL (feature missing, not typo) |
| GREEN | Write minimal code to pass | Run test — PASS. All other tests still pass. |
| REFACTOR | Clean up (duplication, names) | All tests still green |

Iron Law: No production code without a failing test first. Wrote code before test? Delete it. Start over.
Good tests: Minimal (one behavior), Clear (name = behavior), Real (no mocks unless unavoidable).
Reject: "Too simple to test" → 30 seconds. "Test after" → proves nothing. "TDD slows me down" → faster than debugging.

**Verification Discipline — Evidence Before Claims:**
Before claiming ANY task is complete:
1. IDENTIFY what command proves the claim
2. RUN the command fresh
3. READ output, check exit code
4. Only THEN claim the result

"Should work", "probably passes", "looks correct" = NOT verified. Run the command.