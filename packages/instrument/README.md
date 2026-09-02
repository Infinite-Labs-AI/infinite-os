# infinite-tag

**By [Infinite](https://infinite.fast) — the agent-first growth operator for founders.** Docs, dashboards and the server lane live at [infinite.fast](https://infinite.fast); source on [GitHub](https://github.com/Infinite-Labs-AI/infinite-os/tree/main/packages/instrument).

`infinite-tag` installs browser analytics into an existing web app using public
artifacts only. It supports Infinite first-party website collection, GA4,
PostHog, X, and Meta across Next.js, Vite/React, and static HTML. Installs are
idempotent, manifest-backed, and reversible.

Run it inside the website repository. It never provisions an Infinite source,
calls a cloud control plane, or reads a desktop session. Verified source
creation happens outside this open-core package.

Installing the npm package is not the instrumentation step. After
`npm i infinite-tag` / `pnpm add -D infinite-tag`, run
`npx infinite-tag install ...` (or the matching package-manager command) from
the website repo so the managed runtime, imports, and proxy rewrites are written.

## Quick Start

Preview a GA4 + PostHog install (each provider installs natively and independently):

```bash
npx infinite-tag@latest install \
  --workspace <workspace-id> \
  --ga4-measurement-id G-XXXXXXXXXX \
  --posthog-project-key phc_xxxxxxxxxxxxxxxx \
  --posthog-api-host https://us.i.posthog.com
```

Apply a first-party Infinite install to a Vercel-hosted static or Vite site:

```bash
npx infinite-tag@latest install \
  --workspace <workspace-id> \
  --infinite-site-source-key site_xxxxxxxxxxxxxxxx \
  --infinite-production-host example.com \
  --infinite-production-host www.example.com \
  --infinite-static-proxy vercel \
  --infinite-consent-mode required \
  --yes
```

If the main conversion button goes through a first-party route before Stripe,
booking, or another external checkout, set that route explicitly:

```bash
npx infinite-tag@latest install \
  --workspace <workspace-id> \
  --infinite-site-source-key site_xxxxxxxxxxxxxxxx \
  --infinite-production-host example.com \
  --infinite-static-proxy vercel \
  --infinite-consent-mode not-required \
  --infinite-download-destination-path /checkout \
  --yes
```

`infinite local setup` can save public artifacts under
`~/.infinite/artifacts/<workspace-id>.json`. A bare install discovers a single
saved file, or `--workspace` selects one when several exist. A workspace ID is
manifest ownership only: it never fabricates a source key or enables Infinite
collection.

Infinite first-party collection has no implicit consent mode. Every new install
must explicitly choose `required` or `not-required`. A bare interactive install
with a legacy artifact that has no `consentMode` prints a blocker instead of
guessing; it does not prompt because the choice changes the site's privacy
contract. Noninteractive `--yes` and `apply` runs fail on the same blocker.

## Commands

| Command | Behavior |
| --- | --- |
| `inspect` | Detect framework, package manager, and existing providers. |
| `plan` | Print deterministic changes and blockers without writing. |
| `install` | Plan, apply with approval, then verify managed files. |
| `apply` | Apply directly; requires `--yes` and `--workspace`. |
| `verify` | Check managed hashes and forbidden external-loader routes. |
| `uninstall` | Preview removal, or reverse it with `--yes`. |
| `server-lane --brief` | Print the server-lane agent brief for this repo's stack (no install). |
| `harness` | One runbook: adopt existing tags, install what is missing, mark conversions, verify receipts, report per provider. See [The harness](#the-harness-infinite-tag-harness--infinite-analytics). |

## Public Artifact Flags

| Flag | Description |
| --- | --- |
| `--infinite-site-source-key <site_...>` | Public, source-bound browser key created after domain verification. |
| `--infinite-production-host <host>` | Verified hostname for the shared browser runtime; repeatable. Origins, paths, ports, queries, and fragments are rejected. |
| `--infinite-collect-path <path>` | Same-origin browser route. Defaults to `/infinite/ledger` (an artifact that already records another path keeps it). |
| `--infinite-api-origin <https://host>` | The API host the same-origin route proxies to. Defaults to `https://api.ultima.inc`; the `INFINITE_API_ORIGIN` env var is the same override. Must be an https origin with no path. |
| `--infinite-download-destination-path <path>` | Same-origin conversion click path for `app_download_click`. Defaults to `/download`; use `/checkout` only when the site intentionally routes checkout through its own page first. Direct Stripe-hosted payment surfaces are detected automatically as structural checkout-intent `site_click` buckets. |
| `--infinite-autocapture <on\|off>` | Unmarked-click autocapture (default `on`). `off` stops unmarked links and buttons from emitting; marked `data-analytics-cta-id` CTAs, the conversion destination, Stripe checkout buckets, `data-conversion` markers and sign-up paths still emit. |
| `--infinite-static-proxy vercel` | Explicit proof that a static/Vite install may create Vercel rewrites. |
| `--infinite-consent-mode <required\|not-required>` | Required for Infinite first-party collection. There is no default. `required` waits for the external consent event below; `not-required` collects Infinite events unless DNT/GPC blocks them. Neither mode touches GA4/PostHog consent. |
| `--ga4-measurement-id <G-...>` | Public GA4 measurement ID. |
| `--posthog-project-key <phc_...>` | Public PostHog project key. |
| `--posthog-api-host <https://...>` | PostHog ingestion host. |
| `--posthog-proxy` | Install the managed same-origin `/ingest` Vercel/Next rewrites. |
| `--posthog-ui-host <https://...>` | Optional PostHog toolbar host when proxying. |
| `--x-pixel-id <id>` | Public X pixel ID. |
| `--x-event-tag-id <id>` | Public X event tag ID; repeatable. |
| `--meta-pixel-id <id>` | Public Meta pixel ID. Installs with Meta's Automatic Configuration off (`fbq('set','autoConfig','false', id)` before `init`): no button clicks or page metadata are sent to Meta by default. |
| `--artifact-file <path>` | Read the same public artifact shape from JSON. |
| `--server-lane` | Add the lossless server lane (see below). Works alone or with the artifact flags. |
| `--workspace <id>` | Install-manifest ownership; required for apply. |
| `--app-root <path>` | App directory in a monorepo. |
| `--package-manager <pnpm\|npm\|yarn\|bun>` | Override package-manager detection. |
| `--yes` | Approve writes. |
| `--allow-dirty` | Bypass the clean-tree gate. |
| `--json` | Machine-readable output. |

The removed external-loader flags fail with a migration error and are not
reinterpreted.

## Infinite Runtime

The generated runtime is self-contained in the managed site code. It posts only
to the configured root-relative collection path and never loads an Infinite
script from another origin. The browser artifact is:

```ts
interface InfinitePublicArtifact {
  siteSourceKey: string
  collectPath: string
  productionHosts: string[]
  staticProxy?: "vercel"
  // Optional only for reading legacy files; planning blocks until this is explicit.
  consentMode?: "required" | "not_required"
  // Optional; defaults to "/download".
  downloadDestinationPath?: string
  // Optional; false turns unmarked-click autocapture off (absent = on).
  autocapture?: boolean
}
```

The runtime owns one logical initial website view and SPA route views. It
normalizes canonical paths, removes query strings and fragments, tracks the
configured same-origin conversion destination, detects hosted Stripe payment
surfaces as structural checkout-intent `site_click` buckets, and autocaptures
safe DOM clicks. Same-origin links are grouped by destination path
(`auto_pricing`, `auto_checkout`, etc.); standalone unmarked buttons stay under
the generic `button` CTA id plus structural location; obvious sign-up routes
emit `sign_up_click`; non-checkout external links are bucketed by class
(`external_booking` or `external_link`) without storing the external URL. It
never captures DOM text, link text, button text, form values, query strings, or
fragments.

`data-analytics-cta-id` and `data-analytics-cta-location` are still supported as
explicit overrides for cleaner reporting. Stripe-hosted payment surfaces use
structural destination buckets (`/external/stripe_payment_link`,
`/external/stripe_checkout`, `/external/stripe_invoice`); custom external
checkout domains can opt in with `data-conversion="checkout"`, which emits
`/external/marked_checkout`. The actual checkout URL and query string are never
sent to Infinite. Download anchors may additionally retain the
backward-compatible `data-download-location` placement attribute; a valid
`data-analytics-cta-location` takes precedence when both are present. Both use
the same `^[A-Za-z0-9_-]{1,64}$` structural-token constraint, and one click
still emits only one browser event.

Every `site_page_view` carries one bounded property, `nav`: `"navigate"` for the
initial document load and `"history"` for a History-API route change. The runtime
emits nothing when `navigator.webdriver` is true (automation-driven browsers —
Playwright, Puppeteer, Lighthouse — are not visitors).

### What the pixel sends

The event envelope is the public contract in `contracts/browser-collect-v1.schema.json`
(the cloud pins the same file by hash): `siteSourceKey`, `eventId`, `eventName` (one of
`site_page_view`, `site_click`, `app_download_click`, `sign_up_click`), `occurredAt`, the
runtime's own random `anonymousId` / `sessionId`, `url` (origin + canonical path — the query
string and fragment are stripped), an optional `referrer` reduced to its host, and a bounded
`properties` object. On the **initial** page view (`nav: "navigate"`) the runtime also attaches
an allowlisted campaign block read from the landing URL:

| Property | Value |
| --- | --- |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` | The parameter's value — trimmed, control characters stripped, truncated to 100 characters; absent when empty. |
| `has_gclid`, `has_fbclid`, `has_ttclid`, `has_msclkid` | `true` when the click id is present. **The id value is never sent.** |

Any other query parameter is dropped, History-API route views carry `nav: "history"` only,
and click events never carry the block. Nothing else about the page — DOM text, link text,
button text, form values — ever leaves the browser.

**Providers are independent (0.6.0).** GA4 and PostHog install as fully native
bootstraps — Google's own `gtag.js` snippet with its default `page_view`, and
PostHog's own `posthog.init` with PostHog's defaults (`defaults: '2025-05-24'`:
autocapture, page views, pageleave, session recording and opt-in state are
PostHog's). The Infinite runtime never forwards browser events into a provider,
never loads a provider on its behalf, and never changes a provider's configuration
or consent; consent for GA4 / PostHog is the site's own, exactly as with a
hand-pasted snippet. Mirror mode (the pre-0.6.0 translation of `site_page_view`
into GA4 `page_view` / PostHog `$pageview`) is gone. Without an Infinite source
key no Infinite runtime is embedded at all; with one, it emits only from hosts
on its validated `productionHosts` allowlist.

Infinite collection respects DNT and Global Privacy Control in both modes. In `required`
mode, the runtime starts dormant and the site's existing consent UI must dispatch
the following signal after every grant, denial, or revocation:

```js
window.dispatchEvent(new CustomEvent("infinite:analytics-consent-change", {
  detail: { granted: true } // false on denial or revocation
}))
```

The runtime stores this decision under `infinite_analytics_consent`. `verify`
checks that the managed required-mode runtime contains this event bridge, then
instructs the founder to exercise the external consent UI in a browser; static
verification cannot prove that an app-owned UI dispatches the event.

The consent signal governs Infinite collection only: a grant (re-)emits the
current page as the initial view, a revocation stops future Infinite events. It
never touches GA4 or PostHog in either mode — those providers run their own
native consent handling.

### Handoff context

The runtime exposes exactly one accessor to the page, for sites that hand a
browser journey to a native app:

```ts
window.__infiniteHandoffContext?.(): {
  siteSourceKey: string
  anonymousId: string
  sessionId: string
  url: string
} | null
```

It is context, not a capability: there is no `track()`, no dispatch, no event
emitter, no workspace/authority/environment, and no endpoint. It mints no new
identity either — the ids are the same random `localStorage`/`sessionStorage`
values the runtime already uses for its own events, so reading it can never
create a visitor the site would not otherwise have had.

The accessor is installed **only** for a configured source key on a validated
production host, so a page with no Infinite source, a preview host, loopback, or
an automation-driven browser has no `__infiniteHandoffContext` at all. Consent is
re-checked on every call: a stored denial, a DNT/GPC default, or a revocation
returns `null` rather than an identity.

Localhost and IPv4/IPv6 loopback do not emit. Every shared runtime uses its exact,
non-empty validated `productionHosts` allowlist, so a verified Vercel production
host works while custom-domain and Vercel previews remain suppressed unless
explicitly listed. A source key with an empty allowlist is a planning blocker.

## Server lane (lossless analytics)

> server-side analytics: every page your server serves and every outcome it confirms, counted where ad-blockers can't reach. A floor for people, never an exact share — installed by your agent in ten minutes.

Browser tags see a fraction of real traffic behind ad-blockers and consent gates. The
server lane counts on the other side of that wall: the customer's **server** records
every HTML document it serves and every conversion it confirms, signs each record with a
per-source secret, and posts it to Infinite. The board that comes back — Visitors, the
declared outcome (downloads, sign-ups, purchases), and the rate between them — matches
server logs, not a sample. The raw IP and full user agent never leave the customer's
server: it hashes the visit identity itself (`visitKey` = HMAC of IP + UA + a 30-minute
window under the secret) and sends only the hash, the path, the host, and the UA family.

```bash
# Writes a runnable lane for the framework AND the host: Next.js middleware, Vercel's
# framework-agnostic root middleware, a Netlify Edge Function, a Cloudflare Pages
# functions/_middleware.ts, or a Node module — plus lib/infinite-outcome and
# INSTALL-SERVER-LANE.md. Every file is manifest-tracked and reverses byte-for-byte.
npx infinite-tag@latest install --server-lane --workspace <workspace-id> --yes

# No host signal in the repo: writes + prints INSTALL-SERVER-LANE.md — the agent brief IS the install.
npx infinite-tag@latest server-lane --brief

# After deploying with the two env vars set, prove receipts arrive:
INFINITE_SERVER_EVENT_SECRET=… INFINITE_SITE_SOURCE_KEY=site_… \
  npx infinite-tag@latest verify --server-lane https://example.com/
```

Next.js keeps its own lane on every host. For every **other** framework the target comes from
where the site is **hosted** (`vercel.json` / `.vercel/project.json` / `@vercel/*` → Vercel;
`netlify.toml` / `netlify/` / `@netlify/*` → Netlify; `wrangler.*` / `functions/_middleware` /
`@cloudflare/*` → Cloudflare; an `express` dependency → Node. `vercel.json` wins every tie):

| Stack | Behavior |
| --- | --- |
| Next.js, no middleware | Creates `middleware.ts` (`proxy.ts` on Next.js 16+) with the standard document matcher, wrapping nothing. |
| Next.js, existing middleware | Inserts fenced `// infinite-tag:server-lane:start … :end` blocks that wrap the existing handler (its body is untouched) — only for shapes it recognizes and only when the matcher already lets every document through. Otherwise the file is left alone and the brief carries the exact addition. Recorded edits reverse byte-for-byte on `uninstall`. |
| Any framework on **Vercel** (Vite, static, SvelteKit…) | Creates the root `middleware.ts` Vercel runs for [any framework](https://vercel.com/docs/routing-middleware), plus `lib/infinite-server-lane.ts`. The entry imports `@vercel/functions` (for `next()` and `waitUntil`), so the CLI and the brief name the one `npm install` to run. |
| **Netlify** | Creates `netlify/edge-functions/infinite-server-lane.ts`, declared [in-file](https://docs.netlify.com/build/edge-functions/declarations/) with `export const config` — `netlify.toml` is never edited. Assets are excluded per extension (Netlify's own `["/*.css", "/*.js"]` shape); a blanket `/*.*` would over-exclude, because URLPattern's wildcard is greedy across `/`. |
| **Cloudflare Pages** | Creates [`functions/_middleware.ts`](https://developers.cloudflare.com/pages/functions/middleware/), reading its secret from `context.env`. A plain Worker (a `wrangler` config with a `main` entrypoint) gets the brief's Worker snippet instead — there is no file of ours to add safely. |
| **Express / any Node server** | Creates `lib/infinite-server-lane.js`. Nothing auto-wires your server file: the brief names the exact `app.use(infiniteServerLane())` line and where it goes. |
| No host signal | Writes the agent brief only; `server-lane --brief > INSTALL-SERVER-LANE.md` saves it anywhere. |

Every target also writes **`lib/infinite-outcome`**, exporting `postInfiniteOutcome({ type, path,
eventId, accountKey, visitKeyInputs })`, so any server route — a Vercel `api/` function confirming a
paid Stripe session, a webhook, a job — reports an outcome in three lines and carries the same
`visitKey` as the page view that produced it. Report outcomes from where they become real (a
committed row, a captured payment, a served file), never from a click.

If a file it would create already exists and Infinite does not manage it, that file is left alone
and its exact content goes into the brief; an unmanaged `lib/infinite-server-lane.*` is a planning
blocker rather than an overwrite. `uninstall` removes only the files it wrote and only the
directories it had to create — a `netlify/` or `functions/` directory you already had stays.

`--infinite-api-origin` (or `INFINITE_API_ORIGIN`) moves the **server** lane with the browser lane:
the resolved origin is baked into every generated lane and outcome helper, printed in the brief, and
used by `verify --server-lane` for the receipt route.

Two environment variables, never written to files by infinite-tag: `INFINITE_SERVER_EVENT_SECRET`
(minted once in the Infinite desktop → Site Analytics → Settings → Conversions → Server events) and
`INFINITE_SITE_SOURCE_KEY` (the public source key; the generated Next.js module falls back to the
key baked at install time). Without the secret the lane stays dormant — it never throws into a
request. Delivery is fire-and-forget (`event.waitUntil`, 2 s cap); assets, `/api/*`, non-GET,
prefetch, non-HTML requests, and the pixel's own collect path are skipped; the raw IP, full UA,
cookies, query strings, and bodies are never sent. What it produces is **a floor for real people,
never an exact share** — it counts every page your server serves, and the obvious bots it can name
are filed as `automation`, not as visitors.

The contract (endpoint, headers, both body shapes, recipes) and reference implementations for
Express / any Node server, Cloudflare Workers, and Netlify Edge live in the brief. Every sentence
of that brief is in `src/server-lane/copy.ts`; the recipe vectors shared with the receiving side
are in `contracts/server-lane-v1.vectors.json`.

`verify --server-lane <url>` loads the page once as `infinite-tag-verify` — a self-identified
automation user agent, not a fake Chrome — then polls Infinite's receipt endpoint with the same
source headers (the signature covers the raw query string) for up to a minute and prints PASS with
received / lastPath / lastReceivedAt, or FAIL with the most likely cause. The request is genuinely
recorded, because proving your middleware runs is the point, but it is classified `automation`, so a
check never adds a visitor to your own numbers. Bot protection can refuse a self-identified monitor;
when it answers 401/403/405/406/429 the failure names that first.

## Existing tags are adopted, not replaced

`plan` walks the whole app root for real provider signatures and **adopts** a requested provider
that already exists: it is left byte-for-byte alone, dropped from the install set, listed under
`adopted` in `--json` (`{ provider, via: "snippet" | "gtm", file }`) and under "Already on your
site" in human output, and never installed a second time. When every requested provider already
exists, nothing is written and no install record is created.

What counts as evidence (a false positive would silently drop a provider from the install, so the
rules are deliberately narrow):

| Provider | `via: "snippet"` | `via: "gtm"` |
| --- | --- | --- |
| GA4 | the `gtag.js` loader or a `gtag(` call; `@next/third-parties/google` `<GoogleAnalytics>`; `react-ga4` / `ReactGA.initialize(`; `vue-gtag`; `nuxt-gtag`; `@analytics/google-analytics` | the `gtm.js` loader; `dataLayer.push(` beside `googletagmanager.com`; a `gtmId` prop (`<GoogleTagManager gtmId="GTM-…">`); a quoted `GTM-…` id on a line that mentions gtm. **Never** a bare `GTM-XXXX` token or a bare `dataLayer.push(`. A Tag Manager container proves GA4 only — a requested Meta or X pixel still installs beside it. |
| PostHog | `posthog.init(`, the `i.posthog.com` host, `posthog-js/react` `<PostHogProvider>`, `@posthog/nextjs` | — |
| X | `twq(` or `static.ads-twitter.com` | — |
| Meta | `fbevents.js`, `fbq(` or `connect.facebook.net` | — |

The walk reads `.html/.htm/.tsx/.jsx/.ts/.js/.mjs/.cjs/.astro/.vue/.svelte` files, capped at
2,000 files and 512 KB per file. It skips `node_modules`, `.git`, `.next`, `dist`, `build`, `out`,
`.vercel`, `coverage`, `public`, `static`, `__tests__`, `__mocks__`, `.storybook` and `emails`,
plus `*.d.ts`, `*.test.*`, `*.spec.*`, `*.stories.*` and `*.min.js` files (type declarations,
mocks and minified vendor bundles are not installs). Infinite's own managed files and
`<!-- infinite:start -->` blocks are ignored, so a re-run never adopts itself. If a hit is wrong,
delete the file it names (`file` in the `adopted` entry) or move it under a skipped directory.

## The harness: `infinite-tag harness` / `infinite analytics`

One command that knows its job and gets it done. Two front doors, one runbook:

```bash
npx infinite-tag harness [--check | --plan | --apply | --verify-only] [flags]   # standalone
infinite analytics [--check | --plan | --apply | --verify-only] [flags]          # desktop CLI
```

`infinite analytics` adds only what the standalone tag cannot know — the Desktop's active
workspace, the public keys `infinite setup` saved under `~/.infinite/artifacts/<workspaceId>.json`,
and a verification backend that reads receipts back through the running Desktop (the CLI holds no
cloud credential; the app makes the call with its own session) — then runs the same eleven steps. The `infinite` CLI is fully
paid: `--plan`, the default apply, `--verify-only` — anything that writes or reaches the cloud —
goes through the same Desktop readiness gate as the rest of the product (signed in, workspace
linked, subscription active) and prints the standard onboarding guidance otherwise, touching
nothing. `--check` (read-only, local) runs ungated so an unpaid founder can see the state table
for their site; when Desktop is not ready its report ends with "Complete onboarding in Infinite
Desktop to install, mark and verify". The standalone `npx infinite-tag harness`
is the open-source installer and stays ungated; its only cloud contact is the optional verify
read-back, which reports `subscription required` honestly when the cloud answers 402. Three depths: `--check`
(inspect + report, writes nothing), `--plan` (write the plan, the proposed conversions and
`.infinite/REPORT.md`; apply nothing), and the default `--apply` (plan → confirm → apply → verify).

### The runbook

Every step names its own failure code and whether the run **halts** or **continues degraded**;
either way the run ends with all seven provider rows.

| # | Step | Success | Failure code (next) |
|---|---|---|---|
| 1 | Preflight | Node ≥ 18; git tree clean for `--apply` | `INF_ENV_DIRTY_TREE` (halt; `--allow-dirty` overrides) |
| 2 | Inspect | one supported framework; every existing provider (incl. Tag Manager) with file + line | `INF_DETECT_NO_FRAMEWORK` (halt; `--brief` writes the agent brief instead) |
| 3 | Resolve keys | flags → saved artifacts → real `.env` files (a key found only in `.env.example` is missing, and that file is never written) | `INF_POSTHOG_NO_KEY` (continue; only when PostHog was explicitly requested) |
| 4 | Classify | one action per provider: `absent → install`, `unmanaged → adopt`, `managed → upgrade`, `gtm → manual`, `conflict → report` | never fatal |
| 5 | Plan | deterministic file plan for install/upgrade providers | `INF_PLAN_UNMANAGED_TARGET` / `INF_PLAN_BLOCKED` (halt) |
| 6 | Confirm | explicit yes (`--yes` skips this one) | clean exit, nothing written |
| 7 | Apply | managed files written and hash-verified | `INF_APPLY_ROLLED_BACK` (halt; every file restored) |
| 8 | Conversions | proposed → confirmed → marked (below) | `INF_MARK_STALE_ELEMENT` (continue, per row) |
| 9 | Server lane | the target the plan chose was written, or the brief only | never fatal |
| 10 | Verify | a receipt read back per provider | `INF_VERIFY_NO_RECEIPT` (continue) |
| 11 | Report + handoff | `.infinite/REPORT.md` and the pasteable line | never fatal |

A non-interactive `--apply` with neither `--conversions <file>` nor `--no-mark` exits `2` with
`INF_ARGS_CONVERSIONS_REQUIRED` rather than guess. Failures are also printed on stderr as one
line — `inf-error: <CODE> — <message>` — for headless callers.

### The state table

A provider is a state machine, not a boolean. All seven rows print every run, including the ones
the run did nothing to — a silent provider is the bug:

```
provider     state                                                       key         evidence
ga4          adopted, not ours to verify                                 G-ABC123    index.html
gtm          skipped                                                     —           no Tag Manager container found
posthog      installed, not verifiable (no query key — pass --posthog-query-key, or run infinite analytics from the desktop CLI)  phc_…  index.html
meta         installed, not verifiable (Meta has no install-time read-back; open Events Manager → Test Events)  1234567890  index.html
x            skipped                                                     —           no key resolved (flags, saved artifacts, or .env)
infinite     verified (receipt at 2026-09-02T10:01:03.000Z)              site_…      index.html
server_lane  installed, no receipt                                       —           middleware.ts
```

States: `absent` / `adopted` / `installed` / `verified` / `conflict` / `skipped`. **`verified` is
printed only with a receipt timestamp read back from the provider.** `installed` means a file was
written; `adopted` means an existing tag (a hand-pasted snippet, or GA4 through a Tag Manager
container) was found and left byte-for-byte alone — never reduced, never installed twice, and
never claimed as verified by us. Two different ids for one provider, or a managed install beside
an unmanaged snippet, is a `conflict`: nothing is installed for it and the report names both.

### Conversion marking

The runtime already reads `data-analytics-cta-id` and `data-analytics-cta-location`, so the
marking step writes exactly those two attributes. It is three phases with a human gate:

1. **Propose (read-only).** The app's source is scanned (same bounds as provider detection) for
   `<a>`, `<Link>` and `<button>` elements. Each gets a `cta_id` token (`^[A-Za-z0-9_-]{1,64}$`)
   derived from its visible text, then its href, then its tag, with evidence
   `{ file, line, column, tag, hrefOrHandler, textSnippet, lineHash }` — the element's offset in
   the line and the sha256 of the exact line, so two candidates on one line are two rows.
   Elements the runtime already counts are skipped and listed: the download destination,
   Stripe hosts, anything carrying `data-conversion` or already marked. The proposal is written to
   `.infinite/conversions.proposed.json` and **gitignored by the harness** inside a
   `# infinite:start … # infinite:end` block: it quotes link text and hrefs and never leaves the machine.
2. **Confirm.** Interactive runs ask `Mark these N elements now? [y/N]` — a separate answer,
   default No; `--yes` never approves marking, because a company's conversion vocabulary is a data
   contract. The non-interactive path is `--conversions <file>`: edit the proposal (rename, drop
   rows) and pass it back. `--no-mark` skips the phase.
3. **Apply.** Each row is located by its line hash (the recorded line number is a hint — the
   installer's own `<head>` injection shifting lines never stales a mark) and the proposed tag
   must still sit at the recorded column; the attributes are inserted right after that tag name
   and nothing else on the line is touched — no `id`, `class`, `href` or handler. Several rows on
   one line are applied right-to-left and share the line's after-hash. Only `--apply` marks:
   `--plan --conversions <file>` validates and counts the file and writes nothing. Every write is recorded with before/after hashes in
   `.infinite/conversions.json`; `unmarkConversions` (exported) removes exactly the inserted text,
   hash-gated on both sides. A changed line is reported as `INF_MARK_STALE_ELEMENT` for that row
   and the rest still apply; re-running with the same file is a no-op.

Out of scope for the harness, and said so in the report's next steps: GA4 key events (the cloud
designates them from the desktop) and PostHog actions (they need a write key).

### Verification, honestly

Step 10 loads `--url` (or `https://<first production host>/`) **once**, as
`infinite-tag-verify/<version> (+https://infinite.fast; server-lane monitor)` — a self-identified
automation agent, so your own numbers record a flagged agent row, never a visitor — then polls each
provider's read-back for up to 60 s at 3 s intervals. The loader runs no JavaScript, so browser
tags fire only when a real browser opens the page during the window; the CLI says so before it polls.

| Provider | Standalone `infinite-tag harness` | `infinite analytics` |
|---|---|---|
| Infinite pixel, GA4, server lane | `installed, not verifiable (run infinite analytics from the desktop CLI to verify)` | read back **through the running Infinite Desktop** — the CLI POSTs the app's loopback bridge (`analytics.verify.v1`) and the app calls `POST /api/analytics/verify` with its own session, so no token is ever handled here |
| PostHog | with `--posthog-query-key <personal key with Query Read>`: one bounded HogQL poll for a `$pageview` since the load, on the region's app host; without it, `not verifiable (no query key)` | same, then the cloud |
| Meta | never verifiable at install time: `open Events Manager → Test Events` | same |
| adopted / GTM | `adopted, not ours to verify` | same |

A backend answer of `verified` without a receipt timestamp is downgraded to `not verifiable` and
says so. A cloud that rejects the session (401/403), has no verify route yet (404), or is
unreachable is reported as exactly that — never as a receipt, never as a failure of your site. The
same honesty covers the app: a Desktop that is signed out, unlinked, unsubscribed or still booting
answers `409 not_ready` **before** any cloud read, and the lane reads
`not verifiable (Infinite Desktop is not ready (<state>) — complete onboarding)`; a Desktop too old
to carry the verb says `update the Infinite app`.

With no Desktop at all (CI, a server), `infinite analytics --api-token-env [NAME]` opts explicitly
into the direct cloud backend, reading a bearer from `NAME` (default `INFINITE_API_TOKEN`);
`INFINITE_API_ORIGIN` overrides the host. It is an advanced escape hatch: a token found in the
environment is **never** used implicitly, because a stale one silently verifying against another
account is worse than an honest "not verifiable".

### Flags

| Flag | Meaning |
|---|---|
| `--check` / `--plan` / `--apply` (default) / `--verify-only` | the depth |
| `--providers ga4,posthog,meta,x,infinite` | restrict the set; default = every resolvable provider |
| `--adopt-existing` (default) / `--no-adopt-existing` | adopt an unmanaged tag, or refuse to install beside it (`conflict`) |
| `--conversions <file>` | pre-approved conversions (the non-interactive marking path) |
| `--no-mark` | skip conversion marking |
| `--server-lane` | add the lossless server lane for the detected host (or the brief) |
| `--url <prod-url>` | the URL verification loads; defaults to the first production host |
| `--posthog-query-key <key>` | optional personal API key with Query Read, to read PostHog back |
| `--yes` | skip the **install** confirmation only |
| `--allow-dirty` | override the clean-git-tree gate |
| `--json` | print the report as JSON |
| `--brief` | write `.infinite/harness-brief.json` and stop |
| `--workspace`, `--root`, `--app-root`, `--package-manager`, the artifact flags | as for `install` |

With `--json`, stdout carries exactly one JSON document (the report); every preview, proposal
table and brief goes to stderr.

Every run that writes ends with `.infinite/REPORT.md` — the table, the failures, the conversion
counts, a "Verify before merging" checklist — and the pasteable line for your agent:

> Open `.infinite/REPORT.md` and work through its 'Verify before merging' checklist: investigate each item, then list the changes you'd make and get my approval before applying any of them.

### Uninstall

`infinite-tag uninstall` reverses the managed install, then the harness's own writes, which are
recorded separately and reversed by two exported functions it calls: `.infinite/conversions.json` (every marked
element, before/after hashes) → `unmarkConversions(root)`; `.infinite/harness.json` (REPORT.md, the
proposal, the brief, conversions.json, and the `.gitignore` fenced block with whether the file was
created) → `removeHarnessOutputs(root)`, which deletes only recorded `.infinite/` files and strips
the block only when it is byte-identical. `infinite-tag uninstall --yes` runs both after reversing
the managed install (the dry run lists what they would undo).

## Proxy Matrix

| Framework | Infinite same-origin route |
| --- | --- |
| Next.js App Router | Creates a managed `next.config.mjs` rewrite when no config exists. |
| Next.js Pages Router | Creates the same managed Next rewrite. |
| Vite + React | Merges `vercel.json` only when one exists or `--infinite-static-proxy vercel` is explicit. |
| Static HTML | Uses the same Vercel proof rule and instruments every discovered source page. |

An existing unmanaged `next.config.*` is never edited. Planning prints the exact
manual integration and a rerun statically proves those literal rewrites before apply.
Static and Vite installs stop when no
supported proxy can be proven; GA4/PostHog/X/Meta remain independently
installable without an Infinite artifact.

When PostHog proxying and Infinite collection are both enabled, managed PostHog
routes are ordered before the exact Infinite collector route. Existing `vercel.json`
files receive only manifest-recorded insertions; uninstall hash-checks and reverses
those insertions to restore the original bytes. Customer rules are never inferred
from a matching destination.

## Files And Reversal

Framework installs create a managed analytics module and minimal load wiring.
Static sites receive an `<!-- infinite:start -->` managed block in every source
HTML page. Proxy installs may also create or merge `next.config.mjs` or
`vercel.json`.

`.infinite/install.json` records managed files, content hashes, and generated-config
ownership. `verify`
rejects drift and forbidden external-loader routes. `uninstall --yes` restores
modified source files byte-for-byte and deletes files it created. It refuses to
discard hand-edited generated configs or Vercel files.

## Safety

- Public artifacts only; no cloud credential or desktop session.
- A workspace ID alone cannot enable collection.
- Browser code cannot select workspace, environment, authority, or dispatch.
- Infinite uses a same-origin collection route with a source-bound public key.
- Provider initialization order is GA4, PostHog, X, Meta, then Infinite — each native and independent; Infinite never forwards events into another provider.
- Installs are idempotent, atomic, path-contained, and dirty-tree guarded.
- Existing unmanaged analytics is adopted (left untouched, never duplicated); existing configuration is not overwritten.

## License

MIT. See [LICENSE](./LICENSE).

## Links

- Product + docs: https://infinite.fast
- Server lane guide (`infinite-tag server-lane --brief`) and the desktop app: https://infinite.fast
- Source, issues, changelog: https://github.com/Infinite-Labs-AI/infinite-os/tree/main/packages/instrument
