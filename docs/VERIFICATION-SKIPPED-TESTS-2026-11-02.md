# Verification of the 12 normally skipped tests

Date: 2026-11-02. Source branch: `3.2.0`, starting commit `60a8d4e`.
Host: macOS ARM64, Node 24.16.0. The user requested actual verification of the twelve tests skipped by the P7a normal and loaded runs.

## Results so far

| Test | Actual result | Evidence / blocker |
|---|---|---|
| PowerShell shim delegates and prints deprecation notice | Not run | `pwsh` is unavailable; temporary official PowerShell download awaits user approval |
| PowerShell shim propagates nonzero exit status | Not run | Same PowerShell dependency |
| F01: real discussion host delivers two live AGY scouts | Passed after correcting stale test expectations | Final run: 1 passed, 0 failed, 0 skipped; both ALPHA and BETA reach `SCOUT_VALID`; 199.6 s |
| G2 F1: AGY timeout, reconciliation, then resumed conversation | Passed | Actual live CLI run; 34.0 s |
| G2 F2: bogus Codex conversation never yields an available response | Passed | Actual live CLI run; 2.6 s; expected unknown outcome does not synthesize success |
| G2 F3: restart replays a successful turn and resumes its Codex conversation | Passed | Actual live CLI run; 42.7 s |
| Codex/AGY discussion preserves both conversation histories | Passed | Actual four-turn conversation; 87.1 s |
| Native Windows launcher preserves quoted/Unicode arguments | Deferred by user | Requires native Windows |
| Windows Job Object owns a grandchild after parent exit | Deferred by user | Requires native Windows Job Object APIs |
| Windows assignment failure terminates the suspended child | Deferred by user | Requires native Windows process creation/assignment APIs |
| Windows helper loss fails closed without fallback | Deferred by user | Requires the native Windows validator path |
| Live probe of installed CLIs | Passed | 1 passed, 0 failed, 0 skipped; 5.1 s |

Current total: **6 verified passes, 6 not yet run**. The remaining six are not counted as passes. No native Windows result is inferred from macOS or simulated `win32` tests.

## Reproduction

```sh
OMNI_SQUAD_LIVE=1 node --test --test-name-pattern='live probe of installed CLIs' test/squad-runtime-conformance.test.js
OMNI_DUAL_LIVE=1 node --test --test-concurrency=1 test/dual-discussion-live-acceptance.test.js test/dual-discussion-live-g2.test.js test/dual-discussion-live.test.js
```

The first combined discussion run had four passes and one F01 failure. After correcting F01, it was rerun independently:

```sh
OMNI_DUAL_LIVE=1 node --test test/dual-discussion-live-acceptance.test.js
```

Local evidence logs (not committed):

- `/tmp/omni-skipped-live-probe.log`
- `/tmp/omni-skipped-discussion-live.log` (initial failure retained)
- `/tmp/omni-skipped-f01-recheck.log` (second failure retained)
- `/tmp/omni-skipped-f01-final.log` (passing F01 run)

## F01 diagnosis and repair

The real worker produced a valid scout. Two assertions in the previously skipped test were stale:

1. The expected schema used the whole `ContextSchema` union, while the orchestrator emits the selected branch with `schemaVersion: 1` and `baselineKind: snapshot`. The user approved aligning the expected schema with this contract. The schema assertion remains in place.
2. The temporary workspace used `/var/...`, while the production context canonicalized it to `/private/var/...`. Handoff section 6.1 already requires `realpathSync.native` for macOS temporary roots. The fixture now follows that rule; the context assertion remains in place.

Only these two test lines changed. Production code, test skip conditions and human approval gates were not changed. The user approved a separate local fix commit after fresh normal and loaded checks; no push is authorized. The native Windows tests were explicitly deferred so work can continue to P7b. The two PowerShell compatibility tests remain unverified while `pwsh` is unavailable.

Fresh pre-commit verification: normal and loaded each reported 3117 tests, 3105 passed, 12 skipped, 0 failed. The normal run took 514.9 seconds and the loaded run 201.2 seconds. Their logs are `/tmp/omni-f01-normal.log` and `/tmp/omni-f01-loaded.log`. These default-run skips remain separate from the six live passes recorded above.

## Remaining environment requirements

The user was asked to approve an official macOS ARM64 PowerShell archive extracted into a temporary directory, with its PATH scoped to the PowerShell tests. No global installation has been performed. The stable release metadata observed from the official PowerShell GitHub repository identifies version 7.6.9 and SHA-256 `a1c7e98ac403da4be5ba75c1c5855af272de7787a91d478c4267466fe58fc1af` for `powershell-7.6.9-osx-arm64.tar.gz`.

No Windows VM or Windows execution tool was found on this host. A native Windows machine/VM or a user-executed run is required. A standalone bundle has been prepared at `/tmp/omni-skipped-windows-tests.zip`, containing the unchanged validator source, the test file, instructions and a per-file SHA-256 manifest. It needs no npm dependencies. Run on Windows, preferably with Node 24 to match this verification host:

```powershell
node --test --test-name-pattern='^Windows (launcher|Job Object|assignment failure|helper loss)' test/dual-validator-process.test.js
```

All four selected tests must pass on Windows before they are marked verified.
