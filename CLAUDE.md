# CLAUDE.md

The working agreement for this repo lives in **[AGENTS.md](AGENTS.md)** — read it
before changing code. It covers the repo layout, the branch → PR → review →
squash-merge workflow, the verify gates, and the non-negotiable data-safety rules.

Claude Code specifics:

- `main` is protected — **never push to it**; always open a PR and let CI (`ci`) gate it.
- Run the full verify locally before pushing:
  `pnpm typecheck && pnpm test && PUBLIC_SURFACE=1 scripts/ci/repo-tripwire.sh`
  (CI gates on a curated vitest subset that excludes the env-dependent
  `llm-controller` suite — see AGENTS.md → Tests; CI is the source of truth.)
- Keep authoring and review in **separate passes** — don't self-approve your own diff;
  have a fresh reviewer pass read it.
- Never commit secrets or personal data; `.env*` and `.growth-os/` are gitignored.
- **We publish an npm package: [`infinite-tag`](https://www.npmjs.com/package/infinite-tag) (= `packages/instrument`).** It's the founder-run installer that adds the GA4 / PostHog / X tracking tags into the *user's own website repo* (`npx infinite-tag install`, public keys only). `infinite setup` surfaces a pre-filled `npx infinite-tag install …` after analytics connect. When anything touches "install the tag on the user's site," remember this package exists — don't reinvent it. (See AGENTS.md → repo layout.)
- **Versioning lives in AGENTS.md → "Versioning & releases."** The runtime ships as a *git checkout* (not an npm package), so "latest version" = the `origin/<branch>` tip; the launcher auto-updates on launch and the root `package.json` `version` is bumped **by hand** (SemVer) in the PR that completes the work. **Watch the name collision:** a **git tag** (`vX.Y.Z`, a release marker on a commit) is *not* the **`infinite-tag`** npm package above — cutting a release never touches `infinite-tag`.
