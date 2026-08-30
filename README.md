# Infinite OS

**The local engine inside [Infinite](https://infinite.fast), the AI marketing Desktop app for Mac.**

Infinite gives founders and small teams one AI marketing workspace for SEO + AEO, social content,
ads, email, landing pages and experiments, and AI CMO workflows. The signed Desktop app contains this
open-core engine, an embedded PGlite database, its background daemon, governed tools, and the
`infinite` CLI. There is no separate runtime to assemble after installation.

<p align="center">
  🌐 <b>Site:</b> <a href="https://infinite.fast">infinite.fast</a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  𝕏 <b>Project:</b> <a href="https://x.com/InfiniteOS_">@InfiniteOS_</a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <b>Maker:</b> <a href="https://x.com/RiverKhan">@RiverKhan</a>
</p>

## Install Infinite

Infinite is a **macOS-only, Apple-silicon app** and requires macOS 12 or newer.

```bash
npx infinite-os@latest
```

Or install without npm:

```bash
curl -fsSL https://raw.githubusercontent.com/Infinite-Labs-AI/infinite-os/main/scripts/install.sh | bash
```

Both commands install the exact signed and notarized Desktop product served by
[`infinite.fast/download`](https://infinite.fast/download). The installer verifies the production
bundle identity, Developer ID team, signature, and notarization before placing `Infinite.app` in
`/Applications`, then opens it. A healthy existing app is opened without being replaced.

The app installs its bundled `infinite` command on first launch. The curl path needs no Node, Docker,
Git, package manager, or separate database. The npx path only needs Node to invoke this alternative
installer; the installed app does not depend on it.

### Installer safety

- The Desktop download is an ordinary `GET` through `infinite.fast/download` and follows the public
  signed-release redirect.
- Installation happens through a unique same-volume staging directory and becomes visible only after
  the staged app passes verification again.
- An existing app that does not match Infinite's production signature is never overwritten.
- The old installer-owned `~/.local/bin/infinite` wrapper is moved to a recoverable backup only when
  its exact legacy marker and target match. Any unrelated command is preserved.
- Temporary mounts, downloads, and staging directories are cleaned up on success or failure.

Run `npx infinite-os@latest -- --help` or append `--help` to the curl script to see installer options.

## What ships in Desktop

- **Local engine + daemon** — governed typed tools and background work run on the Mac.
- **Embedded PGlite** — local project data without a separately managed database.
- **Connector runtime** — GA4, PostHog, Stripe, Meta, Shopify, and read-only X metrics.
- **Bundled CLI** — `infinite "<question>"` is the Desktop agent in your terminal.
- **Operator controls** — live or destructive native actions require operator confirmation.

Prompts and inference use the customer's own Codex or Anthropic account. Connector credentials are
encrypted at rest. See [SECURITY.md](SECURITY.md) for the trust boundary.

## Open-core source

This repository contains the TypeScript engine source that is frozen into each signed Desktop build:

| Path | Purpose |
|---|---|
| `apps/cli` | Bundled `infinite` terminal companion and operator shell |
| `apps/app` | Local HTTP daemon bundled into Desktop |
| `apps/worker` | Background sync and scheduling runtime |
| `packages/*` | Database, connectors, governed runtime, setup, metadata, and analytics engine |
| `packages/desktop-installer` | The zero-dependency `infinite-os` npm bootstrap package |
| `packages/instrument` | Published [`infinite-tag`](https://www.npmjs.com/package/infinite-tag) website instrumentation package |

The source tree and its development containers are for maintainers and contributors. They are not a
second supported end-user product or a Linux distribution. Infinite's supported product is the
signed macOS Desktop app installed above.

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) before sending a change. The maintainer-only engine topology
is documented in [docs/local-and-docker-quickstart.md](docs/local-and-docker-quickstart.md); it is not
an installation path for customers.

## Ecosystem

- [Infinite Skills](https://github.com/Infinite-Labs-AI/infinite-skills)
- [Press Agent](https://github.com/Infinite-Labs-AI/infinite-press-agent)
- [Public agents catalog](https://infinite.fast/agents/)

## License

MIT © 2026 Ultima AI, Inc — see [LICENSE](LICENSE).

`ui-tui/packages/ink/` is vendored third-party work (Ink, the Nous Research Hermes Agent fork, and
Meta's Yoga — all MIT). Attributions are in [NOTICE](NOTICE) and
[`ui-tui/packages/ink/LICENSE`](ui-tui/packages/ink/LICENSE).
