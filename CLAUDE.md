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
