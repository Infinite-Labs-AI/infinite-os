# Changelog — infinite-tag

All notable changes to the `infinite-tag` npm package (`packages/instrument`). Versions before
0.5.0 are recorded in git history only (`git log -- packages/instrument`).

## Unreleased

- **The server lane is no longer Next.js-only.** `install --server-lane` now writes runnable,
  manifest-managed, byte-exact reversible files for the host a site actually deploys to, chosen from
  file and dependency evidence in the repo (`vercel.json` wins every tie):
  - **Vercel, any framework** — the root `middleware.ts` Vercel runs framework-agnostically, plus
    `lib/infinite-server-lane.ts`. A Vite/React or static site on Vercel finally gets a real lane.
    The entry imports `@vercel/functions`; the CLI and the brief name the one `npm install` to run.
  - **Netlify** — `netlify/edge-functions/infinite-server-lane.ts`, declared in-file with
    `export const config`, so `netlify.toml` is never edited.
  - **Cloudflare Pages** — `functions/_middleware.ts`, reading its secret from `context.env`. A plain
    Worker still gets the brief's snippet: there is no file of ours to add safely.
  - **Express / any Node server** — `lib/infinite-server-lane.js` plus the exact one-line mount the
    brief names. No server file is edited automatically.
- **An outcome helper every server route can import.** Each target also writes `lib/infinite-outcome`
  exporting `postInfiniteOutcome({ type, path, eventId, accountKey, visitKeyInputs })`, so a Vercel
  `api/` function confirming a paid Stripe session reports a purchase in three lines, carrying the
  same `visitKey` as the page view. The brief gains a "Post a purchase from a server route" section.
- **The pixel's collect path joins the skip list** in every **non-Next** generated lane and matcher,
  alongside `/api/*`, `/_next/*`, `/_vercel/*`, prefetches, non-GETs, non-HTML and anything with an
  extension. The Next.js lane is unchanged and still byte-identical to earlier installs; adding the
  collect path there would move bytes every Next customer already has, so it is a separate change.
  The path is read from the artifact and defaults to `DEFAULT_INFINITE_COLLECT_PATH`, never a copy.
- **`--infinite-api-origin` now moves the server lane too.** The override used to re-point only the
  browser proxy, so a founder who set it would have had a browser lane on one host and a server lane
  on the default one. The resolved origin now flows into every generated lane (Next included), both
  outcome helpers, the brief's transport and verify sections, and `verify --server-lane`'s receipt
  URL. With no override every generated file is byte-identical to before.
- **Uninstall prunes only directories the lane created.** `serverLane.createdDirs` records them (and
  carries across re-runs), so a `netlify/` or `functions/` directory the customer already had — for
  `netlify/`, the very evidence that picked the host — is never removed.
- **Netlify's asset exclusion is per-extension, not `/*.*`.** `excludedPath` takes URLPattern
  expressions and its wildcard is greedy across `/`, so `/*.*` would have excluded any path with a
  dot at any depth, silently dropping a real page like `/v1.0/pricing`. The declaration now lists the
  extensions Netlify's own example uses; it can only under-exclude, and correctness stays in
  `isInfiniteDocumentRequest`.
- Next.js installs are byte-identical: hosting detection never changes that lane.
- A file infinite-tag would create but does not manage is left alone, with its exact content in the
  brief; an unmanaged `lib/infinite-server-lane.*` is a planning blocker, never an overwrite.

## 0.7.0 — 2026-09-02

- **Server-lane copy stops claiming 100% of traffic.** The positioning line (brief + README) now
  reads: "server-side analytics: every page your server serves and every outcome it confirms,
  counted where ad-blockers can't reach. A floor for people, never an exact share — installed by
  your agent in ten minutes."
**Minor bump: the browser contract changes** (`contracts/browser-collect-v1.schema.json`, mirrored
byte-for-byte and hash-pinned in the cloud).

- **Campaign capture on the initial page view.** The `nav: "navigate"` `site_page_view` now carries
  an allowlisted campaign block read from the landing URL: `utm_source` / `utm_medium` /
  `utm_campaign` / `utm_content` / `utm_term` as bounded values (trimmed, control characters
  stripped, 100 chars, absent when empty) and `has_gclid` / `has_fbclid` / `has_ttclid` /
  `has_msclkid` as presence-only `true`. The click-id VALUE and the raw query string are never
  sent; every other parameter is dropped; History-API views carry `nav: "history"` only; click
  events never carry the block. Contract v1 gains those nine keys (`maxProperties` 4 → 13; the
  `site_page_view` branch allows `nav` + the nine).
- **Autocapture is a flag (default on).** `--infinite-autocapture on|off` (artifact field
  `infinite.autocapture: boolean`) — `off` stops unmarked links and buttons from emitting
  `site_click`; marked `data-analytics-cta-id` CTAs, the conversion destination, Stripe checkout
  buckets, `data-conversion="checkout|signup"` markers and sign-up paths still emit. With the flag
  absent the runtime config is byte-identical to 0.6.2, and the `auto_` / `button` / `external_*`
  cta ids are unchanged.
- **Meta pixel now installs with Automatic Configuration off:** `fbq('set', 'autoConfig',
  'false', <id>)` precedes `fbq('init', <id>)`, so no button clicks or page metadata are sent to
  Meta by default. The rest of the snippet is Meta's own native bootstrap, unchanged.
- **Existing tags are adopted instead of refused.** A requested provider that already exists in
  the repo (hand-pasted `gtag`/`posthog.init`/`twq`/`fbq` snippet, or GA4 served through a Google
  Tag Manager container) is left byte-for-byte alone, dropped from the install set, and reported
  under `adopted` (`{ provider, via: "snippet" | "gtm", file }`) — it is no longer a blocker, and
  `infinite-tag` never installs a second copy. Detection now walks the whole app root (bounded:
  2,000 files / 512 KB each, skipping `node_modules`, build output and dot-directories) instead of
  a fixed seven-file list. When everything requested already exists, `apply` writes nothing and
  records nothing. `detectUnmanagedProviders` returns the object shape above (was `string[]`).
- **Default same-origin collect path is now `/infinite/ledger`.** The old `/infinite/events/collect`
  wording matches privacy blocklists; an artifact or install that already records a path keeps it
  (no silent migration). `--infinite-api-origin <https://host>` / `INFINITE_API_ORIGIN` override the
  API host the route proxies to (default `https://api.ultima.inc`); the value is validated as an
  https origin with no path and only ever shapes the Vercel/Next rewrite destination.

## 0.6.2 — 2026-09-02

- **Precise Stripe checkout bucketing.** Hosted Stripe payment surfaces now emit structural
  `site_click` checkout-intent buckets instead of `app_download_click`: Payment Links
  (`buy.stripe.com`, `book.stripe.com`, `donate.stripe.com`), Checkout Sessions
  (`checkout.stripe.com/c/...`), and Hosted Invoice Pages (`invoice.stripe.com/i/...`). Other
  Stripe hosts, including docs, dashboard, support, customer portal, and unmatched paths, stay in
  the generic external-click lane. The runtime still never sends external URLs, query strings, or
  link/button text.
- **Safer unmarked button autocapture.** Standalone unmarked buttons now stay under the generic
  `button` CTA id instead of promoting arbitrary DOM `id` / `name` / test ids. Use explicit
  `data-analytics-cta-id` and `data-analytics-cta-location` markers for cleaner button reporting.

## 0.6.1 — 2026-09-02

- **Safe click autocapture.** The Infinite runtime now captures unmarked same-origin link and button
  clicks as structural `site_click` events, detects direct Stripe Payment Links as
  `app_download_click` conversion intent under `/external/stripe`, buckets other external links
  without storing external URLs, and treats obvious same-origin sign-up routes as `sign_up_click`
  intent. It still never captures DOM text, link text, button text, form values, query strings, or
  fragments.
- **Conversion path is a first-class CLI flag.** `--infinite-download-destination-path <path>` lets
  agents install checkout-style funnels (`/checkout` before Stripe, for example) without hand-editing
  the managed runtime.
- **Package-install UX.** `npm i infinite-tag` now prints the next command so a dependency install is
  not mistaken for completed instrumentation.

## 0.6.0 — 2026-08-19

**The consolidated truth-train release: providers stay independent; the runtime tells the truth
about page views.** A minor bump because the install CONFIG changes (mirror mode is removed).

- **Mirror mode removed.** The Infinite runtime now emits ONLY to Infinite's same-origin collect
  route. It no longer translates `site_page_view` → GA4 `page_view` / PostHog `$pageview`,
  `app_download_click` → `app_download_clicked`, or `sign_up_click` → GA4 `sign_up`; it no longer
  calls PostHog `set_config` / `opt_in_capturing` / `opt_out_capturing`, no longer drives the GA4
  consent bridge (`__infiniteGa4Consent` is gone), and no longer polls for provider globals
  before binding — it binds immediately. `InfiniteBrowserConfig.mirrors` is gone. Why (founder
  decision): healthy providers stay fully independent — the GA4 mirror already duplicated
  enhanced-measurement page_views on SPAs, and a provider that the installer had "reduced" was a
  provider nobody else could trust.
- **GA4 / PostHog bootstraps are FULL NATIVE.** GA4 = Google's own `gtag.js` snippet (loader +
  `dataLayer` + `gtag('js')` + `gtag('config', ID)` with the default `send_page_view`), no consent
  default queued by Infinite. PostHog = `posthog.init(key, { api_host, [ui_host], defaults:
  '2025-05-24' })` — PostHog's own autocapture / page views / pageleave / session recording /
  persistence / opt-in state. Installers only do explicit native setup or repair and never reduce
  a provider; consent for a provider is the site's own, exactly as with a hand-pasted snippet.
- **No dormant "mirror-only" runtime.** A GA4/PostHog install with no Infinite source embeds no
  Infinite runtime at all (there is nothing for it to do). Top-level `productionHosts` still
  scope the Infinite runtime when an Infinite source is present.
- **`navigator.webdriver` check.** When true the runtime emits nothing — automation-driven
  browsers (Playwright, Puppeteer, Lighthouse) are not visitors.
- **`nav` on `site_page_view`.** Every page view carries `properties.nav`: `"navigate"` for the
  initial document load, `"history"` for History-API route changes (pushState / replaceState /
  popstate); the pathname-only dedupe is unchanged. A consent grant after the load emits the
  current page as the initial view. `contracts/browser-collect-v1.schema.json` admits the bounded
  enum (optional — 0.5.x tags send no page-view properties).
- **Requires the receiving side.** Infinite's cloud collect endpoint must accept
  `properties.nav` on `site_page_view` before a 0.6.0 tag is installed anywhere — a collect
  endpoint on the pre-0.6.0 contract rejects the page view (`invalid_event`). Ship the cloud
  change first; then publish / pin this version.
- The Infinite consent contract (DNT/GPC default, explicit gesture-gated decision overrides it,
  `required` mode dormant until granted, `infinite:analytics-consent-change`) is unchanged.

## 0.5.0 — 2026-08-18

**Server lane (lossless analytics).** Customers get the same server-side Visitors / outcome /
rate board Infinite runs on its own site, installed by their coding agent.

- `install --server-lane` (also `plan` / `apply`): on Next.js creates `middleware.ts` (`proxy.ts`
  on 16+) or patches an existing one with fenced `// infinite-tag:server-lane:start … :end`
  blocks that wrap the existing handler; writes the managed `lib/infinite-server-lane.ts`
  (WebCrypto, Edge-safe) and the agent brief `INSTALL-SERVER-LANE.md`. Every write is
  manifest-tracked (`serverLane` + a new `text-edits` ownership kind) and `uninstall` reverses
  it byte-for-byte. Unrecognized middleware shapes and narrow matchers are refused, not guessed;
  the brief then carries the exact addition. Works alone (no browser artifacts) or with them.
- Every other stack gets the brief (written for Vite/static, printed for unrecognized repos);
  `server-lane --brief` prints it without installing.
- `verify --server-lane <url>`: loads the page like a browser, polls Infinite's receipt endpoint
  with the source key + HMAC signature (over the raw query string), prints PASS/FAIL with the most
  likely cause. Needs `INFINITE_SERVER_EVENT_SECRET` in the environment; never persisted.
- Contract constants: `INFINITE_API_ORIGIN` (one place for the api host),
  `INFINITE_SERVER_EVENTS_DESTINATION`, `INFINITE_SERVER_LANE_RECEIPT_URL`; recipe vectors in
  `contracts/server-lane-v1.vectors.json`.
- All server-lane prose lives in `src/server-lane/copy.ts`.
- **Requires the receiving side.** `--server-lane` installs and `verify --server-lane` only prove
  out once Infinite's API serves the server lane (the signed `site_document_request` ingest on
  `/api/analytics/events/server` and the `/api/analytics/site/server-lane/receipt` route). Before
  that, deliveries are refused and `verify` reports `receipt_unavailable` / `unauthorized`; the
  0.4.0 pixel install is unaffected either way.

## 0.4.0 — 2026-08-18

- `sign_up_click` intent emitter + parameterized download destination (see #135).
