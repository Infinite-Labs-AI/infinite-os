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
