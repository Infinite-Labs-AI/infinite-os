# Infinite OS

**Your growth data, on your own machine — ask it anything in plain English.**

Infinite OS is a self-hosted, local-first growth-analytics runtime. It connects your data sources — Google Analytics 4, PostHog, Stripe, Meta, Shopify, and read-only X public post metrics — into a Postgres database on your own machine, keeps it synced, and lets you ask questions like *"how many page views in the last 7 days?"* or *"which channels drove the most traffic?"* and get real answers from governed, source-accurate metrics.

<p align="center">
  🌐 <b>Site:</b> <a href="https://infinite.fast">infinite.fast</a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  𝕏 <b>Project:</b> <a href="https://x.com/InfiniteOS_">@InfiniteOS_</a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <b>Maker:</b> <a href="https://x.com/RiverKhan">@RiverKhan</a>
</p>

> It is **not** a broad agent runtime, skill platform, or generic SQL tool. For natural-language questions it forwards your prompt to your own Claude or Codex account using your own credentials; it executes no tools or shell commands. Your data never leaves your machine unless you send it somewhere.

## How it works

Everything runs locally as one small stack:

- **Postgres** — your synced growth data, sync state, jobs, schedules, and queryable views (a rebuildable cache; the source of truth stays with the providers).
- **app daemon** — a local HTTP API the CLI talks to.
- **worker** — owns the scheduler and runs syncs as background jobs.
- **CLI (`infinite`)** — the operator shell + the chat interface.
- **encrypted connector credentials** — provider keys/tokens are encrypted at rest with your `GROWTH_OS_ENCRYPTION_KEY`.

You connect a source once, sync it, then ask questions. Answers come from a typed metric layer with authority/provenance rules — not free-form SQL — so a number is either source-accurate or honestly reported as unavailable.

## Example questions

Once a source is connected and synced, just ask — in plain English:

- *"How many page views did I get in the last 7 days?"*
- *"What were my top pages this week?"*
- *"Which channels drove the most traffic last month?"*
- *"How many new users this week vs last week?"*
- *"What's my engagement rate over the last 30 days?"*
- *"How much revenue did I make in the last 30 days?"* (Stripe)
- *"Compare this week's traffic to the previous week."*

Infinite figures out the right metric, runs it against your synced data, and answers with the numbers + a short read — citing the source and flagging anything it can't verify (it won't guess).

## Quickstart

Install with one command (macOS / Linux). It checks you have git, Node ≥ 20, and pnpm (it won't install or change them for you), puts Infinite at `~/.infinite/app`, drops an `infinite` command on your PATH, and runs setup:

```bash
curl -fsSL https://raw.githubusercontent.com/Infinite-Labs-AI/infinite-os/main/scripts/install.sh | bash
```

Then:

```bash
infinite setup     # connect a data source + configure the model, and start the local stack
infinite           # ask a question
infinite "how many page views in the last 7 days"
```

### From source

```bash
git clone https://github.com/Infinite-Labs-AI/infinite-os.git infinite
cd infinite
./infinite setup
./infinite
```

`setup` installs/builds the workspace if needed, configures model auth, and starts the bundled Docker stack.

## Commands

| Command | What it does |
|---|---|
| `infinite` | Start an interactive session (ask questions in natural language) |
| `infinite "<question>"` | Ask one question and print the answer |
| `infinite setup` | Connect a data source, configure the model, start the stack |
| `infinite setup status` | Show what's ready and what's blocked |
| `infinite connect <provider>` | Connect/reconnect a source (`ga4`, `posthog`, `stripe`, `x`, …) |
| `infinite sources` | List connected sources |
| `infinite sync [provider] [window]` | Sync data (windows: `incremental`, `30_days`, `3_months`, `all_time`, …) |
| `infinite metrics` / `explain <metric>` | List metrics / explain a metric's authority & provenance |
| `infinite version` | Print the version and commit |
| `infinite start` / `stop` / `status` / `logs [service]` | Manage the local Docker stack |
| `infinite update` | Pull the latest code on this branch and restart |
| `infinite help` | Full command list |

Infinite keeps itself current automatically: on launch it fast-forwards the
checkout to the latest version on your branch (at most once a day, only when your
tree is clean, silently skipped when offline) and rebuilds. Run `infinite update`
to update on demand, or set `INFINITE_NO_AUTO_UPDATE=1` to turn the on-launch
update off.

## Connectors

**Connectable:** Google Analytics 4 · PostHog · Stripe · Meta · Shopify · X (read-only public post metrics). Deeper attribution and content analysis are on the roadmap.

## Install the tracking tag on your site

GA4 and PostHog only start collecting data once their tracking tag is on your website. After `infinite setup` connects an analytics source, install the tag into **your own site's repo** with our published npm package, **[`infinite-tag`](packages/instrument/README.md)** — it uses only your **public** keys, auto-detects your framework, and writes idempotent, fully reversible changes:

```bash
# run inside your website's code repo
npx infinite-tag@latest install
```

`infinite setup` prints a ready-to-paste `npx infinite-tag install …` command with your Measurement ID / PostHog key and workspace id already filled in (and saves your public keys to `~/.infinite/artifacts/`, so a bare `npx infinite-tag install` discovers them automatically). See **[`packages/instrument/README.md`](packages/instrument/README.md)** for all flags and the supported frameworks (Next.js, Vite + React, static HTML).

## Configuration & data safety

`infinite setup` writes your config and secrets into a gitignored `.growth-os/` directory; connector credentials are encrypted at rest. **Your data stays on your machine** — nothing is sent anywhere unless you do it. See [SECURITY.md](SECURITY.md) for the trust model and the full variable list.

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test
```

See [docs/local-and-docker-quickstart.md](docs/local-and-docker-quickstart.md) for the Docker path, [CONTRIBUTING.md](CONTRIBUTING.md) to contribute, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

MIT © Ultima AI, Inc.
