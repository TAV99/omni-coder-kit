# Dual Codex + Antigravity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the repository's `codex-antigravity-orchestration` skill for the delegated implementation. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a backward-compatible `dual` pairing that configures Codex as manager and Gemini through `agy` as worker, with a native Codex skill and an MVP run wrapper.

**Architecture:** `dual` remains the persisted IDE value. A `dualPair` option selects legacy Claude+Codex or `codex-agy`; only the latter emits the Codex skill and `.omni/codex-gemini` support files. The wrapper is a local PowerShell transaction runner that creates artifacts, performs no-model preflight, and invokes a schema-constrained read-only `agy` scout.

**Tech Stack:** Node.js CommonJS, `prompts`, PowerShell 5.1+, JSON Schema, Node built-in test runner.

## Global Constraints

- Legacy `dual` behavior stays default-compatible when no pairing is supplied.
- `codex-agy` must never grant commit, push, deploy, global permission, or model-cost authority.
- MVP actions are exactly `new`, `preflight`, and `scout`; implement/review/repair are prompt references only.
- `scout` must use `agy -p` JSON output plus a schema and fail closed.
- Runtime artifacts are under `.omni/codex-gemini/runs`, separate from `.omni/v4/runs`.
- Do not commit or push; the user has not authorized either action.

---

### Task 1: Pair-aware dual init contract

**Files:**
- Modify: `lib/commands/init.js`
- Modify: `lib/init/strategies.js`
- Modify: `lib/commands/helpers.js` only if generated files need an ignore rule
- Modify: `test/init.test.js`
- Modify: `test/init-all-ides.test.js`

**Interfaces:**
- `buildInitConfig('dual', { dualPair: 'claude-codex' | 'codex-agy' })` returns the normal init object.
- For `codex-agy`, its manifest contains `dualPair: 'codex-agy'` and `workerProvider: 'antigravity'`.
- Legacy invocations without `dualPair` behave as `claude-codex`.

- [ ] **Step 1: Write failing unit tests for the new pairing.**

```js
it('dual codex-agy emits the native Codex worker integration', () => {
  const result = buildInitConfig('dual', { ...DEFAULT_OPTS, dualPair: 'codex-agy' });
  assert.equal(result.manifest.dualPair, 'codex-agy');
  assert.equal(result.manifest.workerProvider, 'antigravity');
  assert.ok(result.files.some(f => f.path === path.join('.codex', 'skills', 'omni-codex-gemini', 'SKILL.md')));
  assert.ok(result.files.some(f => f.path === path.join('.omni', 'codex-gemini', 'ai-flow.ps1')));
});

it('dual without a pairing remains the Claude Code plus Codex default', () => {
  const result = buildInitConfig('dual', DEFAULT_OPTS);
  assert.equal(result.manifest.dualPair, undefined);
  assert.equal(result.files.some(f => f.path.includes('omni-codex-gemini')), false);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail because `dualPair` is unsupported.**

Run: `node --test test/init.test.js`

Expected: the new `codex-agy` assertions fail.

- [ ] **Step 3: Add the init prompt and thread the selected pair into `buildInitConfig`.**

Add a second `prompts` select only after `response.ide === 'dual'`, with `claude-codex` as default and `codex-agy` as the second value. Pass the selection as `dualPair` to `buildInitConfig`; keep existing non-dual calls unchanged.

- [ ] **Step 4: Make `buildInitConfig` pair-aware with additive files and manifest fields.**

Extend its options destructuring with `dualPair = null`. For `dualPair === 'codex-agy'`, append generated files from Task 2 and set the two manifest fields. Preserve existing `CLAUDE.md`, `AGENTS.md`, workflows, commands, and advanced behavior unless a later focused test proves a codex-agy-specific omission is required.

- [ ] **Step 5: Run focused init tests.**

Run: `node --test test/init.test.js test/init-all-ides.test.js`

Expected: PASS.

### Task 2: Native Codex skill and immutable support templates

**Files:**
- Create: `templates/codex-gemini/SKILL.md`
- Create: `templates/codex-gemini/ai-flow.ps1`
- Create: `templates/codex-gemini/prompts/scout.md`
- Create: `templates/codex-gemini/prompts/implement.md`
- Create: `templates/codex-gemini/prompts/review.md`
- Create: `templates/codex-gemini/prompts/repair.md`
- Create: `templates/codex-gemini/schemas/context.schema.json`
- Create: `templates/codex-gemini/schemas/evidence.schema.json`
- Create: `templates/codex-gemini/schemas/review.schema.json`
- Create: `templates/codex-gemini/schemas/correction.schema.json`
- Modify: `lib/init/strategies.js`

**Interfaces:**
- `SKILL.md` is copied to `.codex/skills/omni-codex-gemini/SKILL.md`.
- The wrapper and references are copied byte-for-byte to `.omni/codex-gemini/`.
- The context schema requires summary, relevant_files, exact_symbols, validation_commands, constraints, risks, and open_questions.

- [ ] **Step 1: Write a failing generated-file test.**

```js
it('codex-agy supplies a schema-constrained scout package', () => {
  const result = buildInitConfig('dual', { ...DEFAULT_OPTS, dualPair: 'codex-agy' });
  const contextSchema = result.files.find(f => f.path === path.join('.omni', 'codex-gemini', 'schemas', 'context.schema.json'));
  assert.ok(contextSchema);
  assert.match(contextSchema.content, /"exact_symbols"/);
  const skill = result.files.find(f => f.path === path.join('.codex', 'skills', 'omni-codex-gemini', 'SKILL.md'));
  assert.match(skill.content, /Codex is the manager/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails.**

Run: `node --test test/init.test.js`

Expected: missing generated files.

- [ ] **Step 3: Create concise native-skill and prompt templates.**

The skill must state the phase order, evidence hierarchy, forbidden actions, terminal stop conditions, and independent QC. `scout.md` must be read-only, require exact source-grounded symbols, and forbid commits/pushes/deploys. Later-phase prompts must be marked as references; they must not make the MVP wrapper implement those actions.

- [ ] **Step 4: Create strict JSON Schemas.**

Use JSON Schema draft-compatible object schemas with `additionalProperties: false` for top-level contracts. Each schema must require the documented terminal fields; `context.schema.json` must require a boolean `verified` on every exact symbol and a non-empty `path` for relevant files.

- [ ] **Step 5: Add template collection helpers in `lib/init/strategies.js`.**

Read each template from `templates/codex-gemini`, emit it as inline `content`, and create the matching parent directories. Do not use runtime absolute paths in generated content.

- [ ] **Step 6: Re-run focused init tests.**

Run: `node --test test/init.test.js test/init-all-ides.test.js`

Expected: PASS.

### Task 3: Safe PowerShell MVP wrapper

**Files:**
- Modify: `templates/codex-gemini/ai-flow.ps1`
- Create: `test/fixtures/codex-gemini/fake-agy.ps1`
- Create: `test/codex-gemini-wrapper.test.js`

**Interfaces:**
- `ai-flow.ps1 new <task-id>` creates one run directory and does not overwrite `request.md`.
- `preflight` writes valid normalized JSON and never calls `agy -p`.
- `scout` reads the request/preflight, invokes `agy -p --output-format json --json-schema <path>`, stores raw output, and writes context only on a successful schema-valid response.

- [ ] **Step 1: Write failing wrapper contract tests.**

```js
it('new rejects unsafe IDs and preserves an existing request', () => {
  const first = runFlow('new', 'AUTH-017');
  assert.equal(first.status, 0);
  fs.writeFileSync(requestPath, '# Request\nKeep me');
  const second = runFlow('new', 'AUTH-017');
  assert.notEqual(second.status, 0);
  assert.match(fs.readFileSync(requestPath, 'utf8'), /Keep me/);
});

it('scout writes context only from a successful structured agy result', () => {
  runFlow('new', 'AUTH-017');
  runFlow('preflight', 'AUTH-017');
  const result = runFlow('scout', 'AUTH-017', { OMNI_AGY_BIN: fakeAgy });
  assert.equal(result.status, 0);
  assert.ok(fs.existsSync(contextPath));
  assert.ok(fs.existsSync(rawScoutPath));
});

it('scout fails closed on malformed output', () => {
  runFlow('new', 'AUTH-018');
  runFlow('preflight', 'AUTH-018');
  const result = runFlow('scout', 'AUTH-018', { OMNI_AGY_BIN: malformedFakeAgy });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(contextPathFor('AUTH-018')), false);
});
```

- [ ] **Step 2: Run wrapper tests and verify they fail because the wrapper is not yet functional.**

Run: `node --test test/codex-gemini-wrapper.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement `new` and `preflight` minimally.**

Validate IDs using `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Resolve the repository root with `git rev-parse --show-toplevel`; create directories beneath it only. Capture git and `agy` observations as data. A missing `agy` or matching model is a `blocked` preflight, not an exception that falsely reports safe.

- [ ] **Step 4: Implement `scout` fail-closed.**

Require a `safe` preflight plus non-empty request. Use `OMNI_AGY_BIN` only as a test seam, defaulting to `agy`. Save stdout/stderr raw evidence. Parse the JSON envelope; accept only `status === 'SUCCESS'` with a schema-valid `structured_output`; otherwise exit nonzero without writing `context.json`.

- [ ] **Step 5: Run wrapper tests.**

Run: `node --test test/codex-gemini-wrapper.test.js`

Expected: PASS on Windows PowerShell.

### Task 4: Full regression and independent QC

**Files:**
- Modify only files created or changed by Tasks 1–3.

- [ ] **Step 1: Inspect scope and whitespace.**

Run: `git status --short; git diff --check; git diff --stat`

Expected: only the planned source, tests, templates, and plan/spec files changed; no whitespace errors.

- [ ] **Step 2: Run all repository gates.**

Run: `npm test`

Expected: exit 0.

- [ ] **Step 3: Run the exact generated-wrapper smoke test without live model execution.**

Generate the `codex-agy` init fixture, run `new` and `preflight`, and assert no `agy -p` invocation occurred. Do not run `scout` against a live model without explicit separate authorization.

- [ ] **Step 4: Report evidence and wait.**

Report files changed, focused/full command outputs, any skipped live smoke, and the fact that commit/push remain unperformed.
