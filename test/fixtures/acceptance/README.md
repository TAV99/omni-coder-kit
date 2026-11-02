# Squad acceptance fixture v1 (P7a)

`bookshelf/` is the original dependency-free CommonJS project. Its eight visible tests pass while its ten assigned changes are deliberately unimplemented or incomplete. Changes to this project's contract require a new suite version.

- `tasks.json` contains the ten goals, exact scopes, context files and isolated-execution metadata. Remove the fixture-only `id` field before submitting each task to `plan.register`; `task_id` is already present. Register the entire set at once. T08/T10 have medium registration complexity despite their high conceptual difficulty.
- `hidden/T01.test.js` through `T10.test.js` are acceptance tests, with a shared `helpers.cjs`. They are controller assets. Keep them and `reference/` outside every worker/reviewer/orchestrator workspace until integration.
- `reference/Txx.patch` is one independent solution against the original project, restricted to that task's allowed files. It is for offline fixture validation, not a live worker hint.
- `bookshelf/plans/finance-format.md` is a controller-only source. Exclude it when copying the initial project. Release its contents only after T08 asks for context; cite its path, question ID and plan revision in the reply. Neither task data nor the public plan/README reveals its columns.

Run offline verification from the omni-coder-kit root:

```sh
node --test test/acceptance-fixture.test.js
```

V46 creates a separate temporary project per task, runs visible tests, verifies a genuine hidden assertion failure, applies the reference patch, then checks hidden and visible tests pass. It checks patch scope using `git apply --numstat` and validates task metadata with the production contract. It uses no model, daemon, approval or network. Nested test runners discard `NODE_TEST_CONTEXT` to avoid Node's recursive-run suppression, and must report a nonzero test count.

T05 compares the original date output across report/CLI and verifies delegation to `format.date`, allowing either an imported object or destructured function. T03 also verifies its visible tests catch the old comma-splitting parser. T06 changes only the visible test file: ten independent hidden mutation probes cover zero, numeric sign, fractional rounding/padding, NaN, both infinities, strings, null and undefined. Negative-candidate regression checks prevent source-only T03 fixes and incomplete T06 tests from being accepted.

After a task is integrated, an evaluator can copy its hidden test and `helpers.cjs` into `<workspace>/hidden/`, then run from that workspace:

```sh
node --test hidden/T01.test.js
```

The live harness, ledger-based `NEEDS_CONTEXT` measurement and human approval gates belong to later P7 sub-phases. P7a does not exercise them.

The root `npm test` discovers the V46 wrapper, not these nested fixture files. The loaded run must likewise exclude `test/fixtures/`; the fixture's visible and deliberately failing hidden tests are executed only through V46.
