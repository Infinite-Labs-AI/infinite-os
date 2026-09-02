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

`plan` walks the whole app root (every `.html/.tsx/.jsx/.ts/.js/.mjs/.cjs/.astro/.vue/.svelte`
file outside `node_modules`, build output and dot-directories; capped at 2,000 files and 512 KB
per file) for real provider signatures — the `gtag.js` loader or a `gtag(` call, `posthog.init(`,
`twq(`, `fbq(` — and for Google Analytics served through a **Google Tag Manager** container
(`gtm.js`, a `GTM-XXXXXX` id, or a bare `dataLayer.push(`). A requested provider that already
exists is **adopted**: it is left byte-for-byte alone, dropped from the install set, listed under
`adopted` in `--json` (`{ provider, via: "snippet" | "gtm", file }`) and under "Already on your
site" in human output, and never installed a second time. A Tag Manager container only proves
GA4 — a requested Meta or X pixel still installs beside it. When every requested provider already
exists, nothing is written and no install record is created. Infinite's own managed files and
`<!-- infinite:start -->` blocks are ignored by the scan, so a re-run never adopts itself.

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
