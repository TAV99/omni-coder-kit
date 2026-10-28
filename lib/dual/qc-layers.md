# Isolated QC layers

Task plans can opt into behavioral QC with these optional fields:

```json
{
  "behavior_commands": [{"program":"node","args":["scripts/qc-behavior.mjs"],"cwd":"."}],
  "qc_evidence": {
    "requirements_path":"scripts/qc-requirements.json",
    "evidence_path":"scripts/qc-evidence.json"
  }
}
```

Commands use the existing validator executable resolver, environment, tracked
processes, 60-second timeout and 64-KiB output bounds. At most 50 behavior
commands are accepted. Checkers run first; only after every checker passes do
behavior commands run. This adds no new filesystem or network permissions.

Each behavior command must exit zero and print exactly one block on stdout:

```text
---QC-BEHAVIOR-RESULTS-BEGIN---
{"tests":[{"name":"cart starts empty","passed":true}]}
---QC-BEHAVIOR-RESULTS-END---
```

Missing, malformed, empty or duplicate results fail closed. Names must be unique
within and across commands. A nonzero exit or failed behavior result records
`DUAL_QC_BEHAVIOR_FAILED` and returns `NEEDS_FIX` before integration.

Requirements use `{"requirements":[{"id":"R1","text":"Cart starts empty"}]}`;
evidence uses
`{"entries":[{"requirement_id":"R1","tests":["cart starts empty"]}]}`.
Every requirement needs a nonempty mapping to existing passing tests. Unknown
requirement IDs, duplicate IDs/entries and malformed JSON also fail closed.
Both JSON paths must remain inside the private worker root; canonical task path
checks reject traversal and symlinks. Evidence failures record
`DUAL_QC_EVIDENCE_FAILED` and return `NEEDS_FIX` before integration.

`qc-layers.js` exports pure `parseBehaviorResults`, `validateEvidenceMapping`
and `composeQcVerdict` functions. The first two return `{passed, failures}`
(the parser also returns `tests`). Composition preserves the three layer
objects and findings; all layers must pass and no finding may have severity
`ERROR`. Existing independent acceptance review and workspace mutation gates
still apply before a task can become `TASK_VERIFIED`.

Opted-in QC responses include `qcLayers: {checker, behavior, evidence, findings,
passed}`. Missing individual layers are marked `skipped`. Successful layer
results are persisted in the isolated QC gate and returned on verified retries.
When both optional fields are absent, the legacy command execution, response
shape and gate details remain unchanged.

Demo behavioral assets and mutation evaluation are separate QC-author work.
The product module does not add a DOM dependency. A demo harness must carry its
runtime in the snapshot because baseline snapshots exclude `node_modules`.
