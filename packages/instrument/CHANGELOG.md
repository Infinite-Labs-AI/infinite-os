# Changelog — infinite-tag

All notable changes to the `infinite-tag` npm package (`packages/instrument`). Versions before
0.5.0 are recorded in git history only (`git log -- packages/instrument`).

## Unreleased

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
