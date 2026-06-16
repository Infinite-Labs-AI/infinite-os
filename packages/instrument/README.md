# infinite-tag

Add analytics to your web app with one command. `infinite-tag` installs
**Google Analytics 4**, **PostHog**, and the **X (Twitter) Pixel** into your
codebase — using only your **public** keys, with changes that are idempotent and
fully reversible.

You run it **inside your own web app's repository**. It detects your framework,
writes a small managed analytics module + the wiring to load it, and records a
manifest so it can cleanly uninstall later. It never asks for — or stores — any
secret.

---

## Quick start

Run it in the root of your web app's repo:

```bash
# Preview what would change (no files written):
npx infinite-tag@latest install --ga4-measurement-id G-XXXXXXXXXX

# Apply it (writes the files):
npx infinite-tag@latest install \
  --workspace <your-infinite-workspace-id> \
  --ga4-measurement-id G-XXXXXXXXXX \
  --posthog-project-key phc_xxxxxxxxxxxxxxxx \
  --posthog-api-host https://us.i.posthog.com \
  --yes
```

> **The easy path:** run `infinite setup` — once your analytics are connected it
> prints a ready-to-paste `npx infinite-tag install …` command with your keys and
> workspace id filled in. On the same machine it also saves your public keys to
> `~/.infinite/artifacts/<workspace>.json`, so a bare `npx infinite-tag@latest install`
> discovers them automatically (pass `--workspace <id>` if you have several).

---

## Commands

| Command | What it does |
| --- | --- |
| `inspect` | Detect your framework, package manager, and current analytics state. Writes nothing. |
| `plan` | Show exactly which files would be created/modified, and any blockers. Writes nothing. |
| `install` | Plan → (with `--yes`) apply → static verification. The main command. |
| `apply` | Just apply a plan (requires `--yes` and `--workspace`). |
| `verify` | Static verification of the managed files against the manifest's recorded sha256 hashes; no build is run. |
| `uninstall` | Remove everything `infinite-tag` installed, restoring your files. Dry run unless `--yes`. |
| `help` | Usage. |

> Note: the `buildOk` field in `--json` output reflects these static checks
> only (the name is kept for compatibility); no build is executed.

## Options

| Flag | Description |
| --- | --- |
| `--ga4-measurement-id <G-…>` | Public GA4 / gtag measurement ID. |
| `--posthog-project-key <phc_…>` | Public PostHog project key. |
| `--posthog-api-host <https://…>` | PostHog ingestion host (e.g. `https://us.i.posthog.com`; reverse-proxy paths are preserved). |
| `--x-pixel-id <id>` | Public X/Twitter Pixel ID. |
| `--x-event-tag-id <id>` | X event tag ID (repeatable). |
| `--artifact-file <path>` | Read the public artifacts above from a JSON file instead of flags. |
| `--workspace <id>` | Your Infinite workspace id (recorded in the manifest). Required to apply. |
| `--app-root <path>` | App directory, if it isn't the repo root (monorepos). |
| `--package-manager <pnpm\|npm\|yarn\|bun>` | Override package-manager detection. |
| `--yes` | Actually write changes (otherwise dry run). |
| `--allow-dirty` | Proceed even if the git tree has uncommitted changes. |
| `--json` | Machine-readable output. |

Only **public** values are ever accepted. Private/server keys (e.g. a PostHog
*personal* API key) are never passed to this tool.

---

## Supported frameworks

- **Next.js** — App Router and Pages Router
- **Vite + React**
- **Static HTML** (a plain `index.html` site)

If your repo can't be confidently classified, `infinite-tag` stops and tells you,
rather than guessing.

## What it writes to your repo

- A managed analytics module (e.g. `lib/infinite-analytics.ts`) plus the minimal
  framework wiring to load it. Static-HTML sites get an
  `<!-- infinite:start --> … <!-- infinite:end -->` block in `index.html`.
- A manifest at `.infinite/install.json` recording every managed file with a
  content hash, so `uninstall` can verify and reverse the change.

Every managed file is stamped `// Managed by Infinite` so the tool can recognize
its own work.

## Uninstall

```bash
# Preview the removal:
npx infinite-tag@latest uninstall

# Actually remove it:
npx infinite-tag@latest uninstall --yes
```

Uninstall restores your files to their pre-install state byte-for-byte. If you
hand-edited a managed file, `infinite-tag` refuses to delete it (so your edits are
never lost) and tells you what to remove manually.

---

## Safety

- **Public keys only.** No secrets are accepted, requested, or stored.
- **Idempotent.** Running `install` twice does not duplicate the wiring.
- **Reversible.** `uninstall` cleanly restores your files; applies are written
  atomically and roll back on failure.
- **No clobbering.** It refuses to overwrite an existing, unmanaged analytics tag
  or a file it doesn't recognize as its own.
- **Stays in your repo.** It never writes outside the app root (no `..`, no
  absolute paths, no symlink escapes).
- **Git-aware.** It won't apply or uninstall on a dirty tree unless you pass
  `--allow-dirty`.

## Community

- Discord: <https://discord.gg/F2CT4C7R>
- X: [@InfiniteOS_](https://x.com/InfiniteOS_) — built by [@RiverKhan](https://x.com/RiverKhan)

## License

MIT — see [LICENSE](./LICENSE).
