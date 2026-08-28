# Release checklist — Omni-Coder Kit (CLI)

Target model: **Approach A** — CLI-only on `main`; website is a separate product.

## Preflight (local)

```bash
git status -sb                    # clean or intentional only
git fetch --prune
npm ci
npm test
npm pack --dry-run                # must list bin/, lib/, templates/ only — no .next, no src/app
node bin/omni.js --version        # must match package.json
```

Confirm:

- [ ] `package.json` version is the version you intend to ship
- [ ] `CHANGELOG.md` has a section for that version (Breaking / Added / Changed)
- [ ] README version text + migration table (if major)
- [ ] No Next.js / website tree on `main`
- [ ] Full test suite green

## Version & tag (maintainer)

```bash
# After commit(s) for the release:
git tag -a v3.1.0 -m "v3.1.0 — Dual AUTO Authority Daemon (Codex + Gemini via agy)"
# Do not push until review:
# git push origin main
# git push origin v3.1.0
```

## npm publish (maintainer — explicit)

```bash
npm publish --access public   # or your usual access settings
```

## GitHub Release (maintainer — explicit)

- Create release from tag `v3.1.0`
- Paste CHANGELOG section body
- Note migration table for major versions

## Website extract (do **not** merge into CLI `main`)

Branch: `website` / `origin/website` (Next.js app `demo-omni`).

### Option 1 — new repo from branch tip

```bash
# from a clone of omni-coder-kit
git fetch origin website
git checkout -B website origin/website
# create empty repo on GitHub (e.g. omni-coder-kit-website), then:
git remote add website-origin git@github.com:TAV99/omni-coder-kit-website.git
git push -u website-origin website:main
```

### Option 2 — subtree split (preserves only website paths if history mixed)

Only needed if you must filter paths; current `website` branch is already a separate tree tip.

### After extract

1. Add README pointer on CLI repo (optional one-liner under docs/inspiration).
2. Delete local/remote `website` branch **only after** the new repo is verified.
3. CI/Pages for the site lives in the **website** repo, not in the CLI package.

## Branch prune (after user approve)

See `.omni/sdlc/branch-audit.md` for the full list. Summary:

**Safe delete (fully merged):**  
`feat/agent-files-visibility`, `feat/harness-and-skills-upgrade`, `feat/observability-heartbeat`,  
`refactor/standardize-om-commands`, `codex-cli-overlay-optimization`,  
`feat/skill-search-optimize`, `feat/strictness-level`, `feat/2.5.7`

**Obsolete (do not merge):**  
`feat/gemini-cli-optimization` — main already has augment-style Gemini overlays.

**Extract first:**  
`website`

```bash
# examples — run only when you intend to delete remotes
git branch -d feat/agent-files-visibility
git push origin --delete feat/gemini-cli-optimization
```

## Post-release

- [ ] `npm view omni-coder-kit version` matches tag
- [ ] Open issues for any deferred deep refactors (large module splits)
- [ ] Start `[Unreleased]` empty section in CHANGELOG
