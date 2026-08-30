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

> It is **not** a broad agent runtime, skill platform, or generic SQL tool. For natural-language questions it forwards your prompt to your own Claude or Codex account using your own credentials. The model gets no arbitrary shell or code execution — it can only invoke Infinite's governed, typed tool catalog (metric/analytics reads and the defined operator actions). Live or destructive operator writes (e.g. ad changes, publishing) are confirmation-gated; reviewable drafts and background jobs may be created directly from your request. Your data never leaves your machine unless you send it somewhere.

## How it works

Everything runs locally as one small stack:

- **Postgres** — your synced growth data, sync state, jobs, schedules, and queryable views (a rebuildable cache; the source of truth stays with the providers).
- **app daemon** — a local HTTP API the CLI talks to.
- **worker** — owns the scheduler and runs syncs as background jobs.
- **CLI (`infinite local`)** — the operator shell + chat interface for the self-hosted engine.
- **encrypted connector credentials** — provider keys/tokens are encrypted at rest with your `GROWTH_OS_ENCRYPTION_KEY`.

You connect a source once, sync it, then ask questions. Answers come from a typed metric layer with authority/provenance rules — not free-form SQL — so a number is either source-accurate or honestly reported as unavailable.

### Two ways to use `infinite`

The `infinite` command has two lanes:

- **`infinite local <command>`** — drives the open-source engine directly on your machine (`setup`, `connect`, `sources`, `sync`, `metrics`, `explain`, `meta`, saved reports, `--json`). No account required; this is the self-host / CI lane, and it's what the installer configures. The Desktop companion (below) is macOS-only, so on Linux/CI this is the lane you use — always invoke it explicitly as `infinite local <command>` (a bare top-level engine command like `infinite sources` is intercepted with `Use: infinite local sources`, regardless of environment). `GROWTH_OS_DEFAULT_TARGET=local` only routes a bare natural-language turn (`infinite "…"`) to the local engine; it does not un-namespace the typed commands. A bare product turn never silently falls back to the local engine.
- **`infinite "<question>"`** — a turn-only companion to the **Infinite Desktop** app. It proxies your terminal turn through Desktop's Cmd+L bridge — the same agent as the in-app palette — so it's "Cmd+L in your shell." Desktop is the sole authority for account and workspace creation (email one-time-code sign-in); the CLI creates neither, and requires an active subscription. It never runs a silent local product turn: on an interactive macOS shell with no live bridge it launches Desktop and continues into the turn once you're signed in; from a pipe, or on a non-macOS host, it prints guidance and exits non-zero.

Orchestration runs locally, but prompts and inference go to your own Codex/Anthropic account with your own credentials — Infinite OS is MIT open source.

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

Install with one command (macOS / Linux). It requires Git, Node >=20, and npm. If pnpm is not
already available, the installer provisions the repository's pinned version privately under
`~/.infinite/tooling`; it never changes your global npm prefix.

```bash
curl -fsSL https://raw.githubusercontent.com/Infinite-Labs-AI/infinite-os/main/scripts/install.sh | bash
```

This README is the canonical install contract mirrored by `infinite.fast`. Website copy must use
the exact same raw URL above and the same prerequisites: Git, Node >=20, and npm.

When an interactive terminal is available, the installer runs `infinite local setup` at the end.
In automation, CI, or another non-TTY context, setup is skipped cleanly; run it later from a real
terminal:

```bash
infinite local setup     # connect a data source + configure the model, and start the local stack
```

To install or update the checkout and launcher without running setup, pass `--skip-setup`:

```bash
curl -fsSL https://raw.githubusercontent.com/Infinite-Labs-AI/infinite-os/main/scripts/install.sh | bash -s -- --skip-setup
```

Then:

```bash
infinite local           # ask a question (interactive)
infinite local "how many page views in the last 7 days"
```

(Running the companion instead? Install the Infinite Desktop app, sign in, then ask straight from your shell: `infinite "how many page views in the last 7 days"`.)

### From source

```bash
git clone https://github.com/Infinite-Labs-AI/infinite-os.git infinite
cd infinite
./infinite local setup
./infinite local
```

`local setup` installs/builds the workspace if needed, configures model auth, and starts the bundled Docker stack.

## Commands

**Companion — Infinite Desktop must be running and signed in:**

| Command | What it does |
|---|---|
| `infinite` | Start an interactive session, proxied through Desktop's Cmd+L bridge |
| `infinite "<question>"` | Ask one question and print the answer |
| `infinite app status` / `infinite app "<message>"` | Desktop bridge status / one-shot message through the running Desktop |
| `infinite help` / `version` | Show help / print the version and commit |
| `infinite update` | The agent ships with Infinite Desktop and updates with it |

**Local engine — `infinite local …`, the self-host / CI lane (no account needed):**

| Command | What it does |
|---|---|
| `infinite local setup` | Connect a data source, configure the model, start the stack |
| `infinite local setup status` | Show what's ready and what's blocked |
| `infinite local connect <provider>` | Connect/reconnect a source (`ga4`, `posthog`, `stripe`, `meta`, `shopify`, `x`) |
| `infinite local sources` | List connected sources |
| `infinite local sync [provider] [window]` | Sync data (windows: `incremental`, `30_days`, `3_months`, `all_time`, …) |
| `infinite local metrics` / `infinite local explain <metric>` | List metrics / explain a metric's authority & provenance |
| `infinite local meta …` | Meta Ads operator commands (creates land paused) |
| `infinite local saved-report …` | Create / run / export saved reports |
| `infinite local start` / `stop` / `status` / `logs [service]` | Manage the local Docker stack |
| `infinite local update` | Pull the latest code on this branch and restart |
| `infinite local help` | Full local engine command list |

A bare engine command is intercepted with the namespaced form to use — e.g. `infinite sources` prints `Use: infinite local sources`.

A source checkout keeps itself current automatically: on any `infinite` invocation the
launcher fast-forwards the checkout to the latest version on your branch (at most once a
day, only when your tree is clean, silently skipped when offline) and rebuilds. Run
`infinite local update` to update on demand, or set `INFINITE_NO_AUTO_UPDATE=1` to turn
the on-launch update off.

## Connectors

**Connectable:** Google Analytics 4 · PostHog · Stripe · Meta · Shopify · X (read-only public post metrics). Deeper attribution and content analysis are on the roadmap.

## Install the tracking tag on your site

GA4 and PostHog only start collecting data once their tracking tag is on your website. After `infinite local setup` connects an analytics source, install the tag into **your own site's repo** with our published npm package, **[`infinite-tag`](packages/instrument/README.md)** — it uses only your **public** keys, auto-detects your framework, and writes idempotent, fully reversible changes:

```bash
# run inside your website's code repo
npx infinite-tag@latest install
```

`infinite local setup` prints a ready-to-paste `npx infinite-tag install …` command with your Measurement ID / PostHog key and workspace id already filled in (and saves your public keys to `~/.infinite/artifacts/`, so a bare `npx infinite-tag install` discovers them automatically). See **[`packages/instrument/README.md`](packages/instrument/README.md)** for all flags and the supported frameworks (Next.js, Vite + React, static HTML).

## Configuration & data safety

`infinite local setup` writes your config and secrets into a gitignored `.growth-os/` directory; connector credentials are encrypted at rest. **Your synced growth data stays on your machine.** Orchestration runs locally too, but prompts and inference go to your own Codex/Anthropic account with your own credentials — nothing else is sent anywhere unless you do it. See [SECURITY.md](SECURITY.md) for the trust model and the full variable list.

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test
```

See [docs/local-and-docker-quickstart.md](docs/local-and-docker-quickstart.md) for the Docker path, [CONTRIBUTING.md](CONTRIBUTING.md) to contribute, and [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

MIT © 2026 Ultima AI, Inc — see [LICENSE](LICENSE).

`ui-tui/packages/ink/` is vendored third-party work (Ink, the Nous Research Hermes Agent fork, and Meta's Yoga — all MIT). Attributions are in [NOTICE](NOTICE) and [`ui-tui/packages/ink/LICENSE`](ui-tui/packages/ink/LICENSE).
