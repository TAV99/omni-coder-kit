# SPEC F17 — a daemon-owned browser runner for the UI gate

Status: draft for review (2026-11-15). Source: omni-p8-test session `f2522f66`, the
first session to reach `ACCEPTANCE`. LANDING-2 was `TASK_VERIFIED` at 06:07; the session
then stalled because the UI gate can never pass.

## 1. Problem

- `bin/omni-daemon.js:34` builds `createTrustedUiAdapter()` with no `mcpClient` and no
  `headlessRunner`, so `evaluateAdaptiveVisualQa` (`lib/dual/visual-qa.js`) always returns
  `runtime_status: UNAVAILABLE` ("Browser runtime adapter unavailable; static CSS is
  advisory only").
- No headless runner exists anywhere in omni. `omni dual qc` accepts
  `options.browserAdapter` (`lib/commands/dual.js:2060`), but nothing supplies one.
- A required UI gate turns `UNAVAILABLE` into a non-passing gate (`lib/dual/ui-gate.js:197`).
  So every project with a UI and a required UI policy stops at acceptance.
- The daemon re-measures any `AVAILABLE` evidence and needs it to equal the submitted
  evidence, artifact hashes included (`daemon-server.js` ~4412–4445). Two independent
  screenshot runs must therefore be byte-identical, which a page with motion or WebGL
  does not guarantee.

## 2. Goal

A required UI gate passes on real browser evidence, measured once, by the daemon, in a
fenced child process, with the existing evidence contract and verdict rules unchanged.

Out of scope: visual diffing against a reference, Lighthouse scores, and acceptance
decisions beyond the gate's existing rules.

## 3. Design

### 3.1 Runner child (`lib/dual/ui-runner-child.js`, new)

- A Node script omni owns, run as a child of the daemon:
  `node ui-runner-child.js --input <json>`.
- It loads Playwright **from the project** (`createRequire(<workspace>/package.json)`,
  trying `playwright` then `@playwright/test`), never from omni's own dependencies.
  It does not install anything.
- For each requested viewport width (the policy's `viewport_widths`, today
  390/768/1024/1440), it:
  - opens a page at that width (height 900) with `reducedMotion: 'reduce'`;
  - loads the page (§3.3) and waits for `load` plus network idle, bounded at 15 s;
  - measures `horizontal_overflow = documentElement.scrollWidth > innerWidth`;
  - sets `passed = !horizontal_overflow && no uncaught page error`. Console warnings and a
    missing module (404) are recorded but are not failures;
  - writes a full-page PNG to `<artifactDir>/<width>.png`.
- Reduced motion: under `reduce`, `document.getAnimations()` must have no running
  animation with infinite iterations. Its result fills `reduced_motion: { tested, passed }`.
- It prints one JSON object in the shape `validateRuntimeResult` already accepts:
  `{ success, source_fingerprint, viewports[], reduced_motion, screenshots[{ path, width }] }`.

### 3.2 Fence and process

- The child runs through the existing validator path under the macOS write fence:
  `sourceRoot` is the workspace, and `workerRoot` is the UI artifact directory
  (`.omni/runs/dual-authority/ui/<session>/<generation>`). Only screenshots can be
  written inside the workspace.
- Its env comes from `buildValidatorEnv`, with a 120 s overall timeout and output caps.
  The process group is tracked like the other validators.
- `computeUiSourceFingerprint` is checked before and after the run, as it already is. Any
  change discards the evidence.

### 3.3 What page is loaded (decision needed)

- **A. Static server (proposed for phase 1).** The daemon serves the workspace read-only
  on `127.0.0.1:<ephemeral>` with plain MIME types and no transforms; `/` maps to
  `index.html`.
  - TypeScript and bare imports are not transformed, so module scripts fail and the page
    shows its no-JS state. This fits static landing pages and their no-JS requirement.
    For LANDING-2 that is exactly the state under review, since `main.ts` arrives in
    LANDING-3.
  - It runs no project code besides Playwright and the browser.
- **B. Project dev server (phase 2).** The UI policy may name an approved serve command
  (for example `vite --port {port} --strictPort`). It is approved like validation
  commands and run under the fence with the cache sent to the artifact directory.
  - This is needed for pages whose UI comes from JS or TypeScript, such as the LANDING-3
    3D scene.
  - It runs project tooling, so it needs the same approval as `validation_commands`.

### 3.4 One measurement, by the daemon

- New completion input `ui_measure: true` (MCP `omni_dual_completion` and
  `omni dual qc`). The daemon runs the runner once and evaluates its own evidence
  through `evaluateUiGate`, with no second run.
- The current submitted-evidence path stays for compatibility. It then compares
  measurements and verdicts but no longer artifact hashes: hashes bind the daemon's own
  files, and a second run's pixels may differ.
- `createTrustedUiAdapter` in `bin/omni-daemon.js` gets the runner as its
  `headlessRunner`.

### 3.5 Failure semantics

| Situation | `runtime_status` | Reason (exact) |
|---|---|---|
| No Playwright in the project | `UNAVAILABLE` | `Playwright not found in the project (install @playwright/test)` |
| Playwright present, no browser binary | `UNAVAILABLE` | `Playwright browser missing (run: npx playwright install chromium)` |
| Page fails to load, timeout, crash | `UNAVAILABLE` | the first error line, path-free |
| Fence unavailable | `BLOCKED` | the fence's precondition message |
| Measured | `AVAILABLE` | per-viewport `passed` decides the verdict |

`UNAVAILABLE` keeps today's meaning: a required gate does not pass, and the
orchestrator relays the exact reason to the user.

## 4. Tests (`node:test`, failing before the change)

1. Runner contract: a fixture page with no overflow at 390/768/1024/1440 gives
   `AVAILABLE`, four passing viewports and four PNGs under the artifact directory.
   Skipped when Chromium is absent.
2. A fixture with a 2000 px element gives `horizontal_overflow: true` and `passed: false`.
3. An infinite CSS animation without a `prefers-reduced-motion` rule gives
   `reduced_motion.passed: false`.
4. No Playwright in the fixture project gives `UNAVAILABLE` with the exact reason.
5. `ui_measure: true` runs the adapter once, and the gate verdict matches its evidence.
6. A UI source change during capture discards the evidence.
7. Under the fence, a write outside the artifact directory is denied.

## 5. Questions for review

1. Is phase 1 (static server) enough to close the p8 session now, with phase 2 in a
   separate change before LANDING-3?
2. Viewport height 900 and full-page screenshots: agreed?
3. Reduced-motion rule: should it be "no infinite animation", or "no animation running at
   all"?
4. Is a missing `prefers-reduced-motion` CSS rule only advisory, as it is today
   (`css_analysis.has_reduced_motion`), or a failure?

## 6. Unchanged

`UiEvidenceSchema`, `evaluateUiGate` verdict rules, policy hashing, the source-fingerprint
binding, and the advisory-only role of static CSS analysis.
