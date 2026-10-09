// ALL server-lane prose lives here — the agent brief (INSTALL-SERVER-LANE.md / `server-lane --brief`),
// the CLI narration, and the verify PASS/FAIL wording. Edit words here; code lives in
// helpers.ts (recipe), runtime-source.ts (generated Next.js code), snippets.ts (reference
// implementations), install.ts (files), verify.ts (network check).
import type { ServerLaneMode } from "../types.js"
import {
  infiniteServerEventsDestination,
  infiniteServerLaneReceiptUrl
} from "../workspace-artifacts.js"

import {
  DOCUMENT_REQUEST_EVENT_NAME,
  SERVER_LANE_DELIVERY_TIMEOUT_MS,
  SERVER_LANE_SECRET_ENV,
  SERVER_LANE_SIGNATURE_HEADER,
  SERVER_LANE_SOURCE_KEY_ENV,
  SERVER_LANE_SOURCE_KEY_HEADER,
  VISIT_BUCKET_SECONDS
} from "./helpers.js"
import {
  NEXT_DOCUMENT_MATCHER,
  buildCreatedMiddlewareSource,
  buildServerLaneModuleSource
} from "./runtime-source.js"
import {
  existingStripeWebhookAddition,
  leadRouteEdit,
  mirrorRouteEdit,
  STRIPE_PURCHASE_EVENTS,
  STRIPE_WEBHOOK_SECRET_ENV,
  stripeCheckoutEdit,
  stripeWebhookRouteSource
} from "./recipes.js"
import {
  cloudflareWorkerSnippet,
  expressSnippet,
  manualNextMiddlewareAddition,
  netlifyEdgeSnippet,
  nextOutcomeSnippet,
  nodeHelperSnippet,
  outcomeRouteSnippet,
  outcomeSnippet,
  webCryptoHelperSnippet
} from "./snippets.js"

import { OWNER_BOUNDARY_INSTRUCTION } from "../jobs/owner-boundary.js"

export const SERVER_LANE_POSITIONING =
  "server-side analytics: every page your server serves and every outcome it confirms, counted where ad-blockers can't reach. A floor for people, never an exact share — installed by your agent in ten minutes."

/**
 * The short pointer at the repo ROOT. The full multi-platform guide is 700+ lines, so it lives under
 * docs/ (SERVER_LANE_GUIDE_FILE) instead of dumping it here; this file just points at it.
 */
export const SERVER_LANE_BRIEF_FILE = "INSTALL-SERVER-LANE.md"

/** The full agent brief, kept out of the repo root under docs/. */
export const SERVER_LANE_GUIDE_FILE = "docs/infinite-server-lane.md"

/** First line of the written brief; `removeManagedFile` keys off "Managed by Infinite". */
export const SERVER_LANE_BRIEF_BANNER =
  "<!-- Managed by Infinite (infinite-tag). Regenerate any time with: npx infinite-tag server-lane --brief -->"

export type ServerLaneBriefStatus =
  | { kind: "created"; middlewarePath: string; modulePath: string }
  | { kind: "patched"; middlewarePath: string; modulePath: string }
  | { kind: "kept"; middlewarePath: string; modulePath: string }
  | { kind: "unpatchable"; middlewarePath: string; modulePath: string; reason: string }
  | { kind: "next-manual"; modulePath: string }
  | {
      /** A non-Next target (Vercel / Netlify / Cloudflare Pages / Node) that wrote real files. */
      kind: "target"
      mode: ServerLaneMode
      label: string
      /** Root-relative files written, in write order. */
      created: string[]
      /** Files that could not be written, with the exact contents to add by hand. */
      manual: Array<{ path: string; reason: string; contents: string }>
      /** Packages the generated entry imports that the repo may not depend on yet. */
      installPackages: string[]
      /** The node target's exact mount lines; absent for every other target. */
      mount?: string
    }
  | { kind: "other-stack"; framework: string }

export interface ServerLaneBriefInput {
  status: ServerLaneBriefStatus
  siteSourceKey?: string
  productionHosts?: string[]
  /** Import specifier from the middleware to the managed module. */
  moduleImportPath?: string
  /** The resolved `--infinite-api-origin`, so the brief's URLs match the code that was written. */
  apiOrigin?: string
  /**
   * The import specifier for the emitted outcome helper — extensionless for a TS project, WITH the
   * extension (`../lib/infinite-outcome.js` / `.mjs`) for a JS one, so every example in the brief
   * resolves the same way the file on disk does. Defaults to the TS form.
   */
  outcomeImportSpecifier?: string
  /** The emitted outcome helper's language, so example routes are shown in the matching syntax. */
  outcomeLanguage?: "ts" | "js"
  /** Root-relative path of the outcome helper this run wrote (every mode writes one). */
  outcomeHelperPath?: string
  /** Next / brief mode: an outcome helper that could not be written, with the exact file to add. */
  outcomeManual?: Array<{ path: string; reason: string; contents: string }>
}

const DEFAULT_MODULE_IMPORT_PATH = "./lib/infinite-server-lane"

/** Where a founder finds (mints/rotates) the server-event secret in the Infinite app. One string, used everywhere. */
export const SERVER_LANE_SECRET_LOCATION =
  "Infinite → Connections → Website → Set them yourself → Reveal secret (or Infinite → Site Analytics → Settings → Conversions → Server events)"

/** Said wherever a founder is told to handle the secret by hand. */
export const SERVER_LANE_SECRET_PASTE_WARNING = "env var only — never paste the secret into chat, messages, or your repo"

const REDEPLOY_IN_VERCEL = "redeploy production in Vercel so the new variables take effect."
const RECONNECT_AND_RERUN = "reconnect Vercel in Infinite → Connections → Website, then re-run `infinite analytics`."

/** Unknown skip codes: the code stays visible, the step is the generic one. */
const REDEPLOY_GENERIC = (code: string) => `Redeploy didn't run (${code}). Redeploy production in Vercel so the new variables take effect.`

/** The cloud's redeploy `skipped` reason codes → plain copy, code in parentheses, unblock step last. */
export const REDEPLOY_SKIPPED_COPY: Record<string, (code: string) => string> = {
  no_production_deployment: (code) => `Redeploy didn't run (${code}): there is no production deployment yet — deploy production in Vercel so the new variables take effect.`,
  serving_deployment_unknown: (code) => `Redeploy didn't run (${code}): Infinite couldn't tell which deployment production serves — ${REDEPLOY_IN_VERCEL}`,
  serving_deployment_not_ready: (code) => `Redeploy didn't run (${code}): production's current deployment isn't ready yet — redeploy production in Vercel once it is.`,
  serving_deployment_mismatch: (code) => `Redeploy didn't run (${code}): production serves a deployment from a different repository — ${REDEPLOY_IN_VERCEL}`,
  serving_deployment_no_git_source: (code) => `Redeploy didn't run (${code}): production's deployment wasn't built from Git — ${REDEPLOY_IN_VERCEL}`,
  production_build_in_progress: (code) => `Redeploy not needed (${code}): a newer production build is already running — the new variables apply when it finishes.`,
  access_denied: (code) => `Redeploy didn't run (${code}): Infinite's Vercel connection was refused — ${RECONNECT_AND_RERUN}`,
  connection_unavailable: (code) => `Redeploy didn't run (${code}): Infinite's Vercel connection is unavailable — ${RECONNECT_AND_RERUN}`,
  project_mismatch: (code) => `Redeploy didn't run (${code}): the connected Vercel project doesn't match this site — ${RECONNECT_AND_RERUN}`,
  provider_unavailable: (code) => `Redeploy didn't run (${code}): Vercel was unreachable — re-run \`infinite analytics\` shortly.`,
  provider_rejected: (code) => `Redeploy didn't run (${code}): Vercel rejected the redeploy — ${REDEPLOY_IN_VERCEL}`
}

/** The cloud's redeploy `unconfirmed` reason codes. Something may be building: check before redeploying. */
export const REDEPLOY_UNCONFIRMED_COPY: Record<string, (code: string) => string> = {
  redeploy_submission_unknown: (code) => `Redeploy submitted, not confirmed (${code}) — check Vercel's latest production deployment before redeploying again.`,
  deployment_mismatch: (code) => `A deployment was created but didn't match production's commit (${code}) — check Vercel's latest production deployment before redeploying again.`
}

/** Both env var names, in the order a founder sets them. */
const SOURCE_ENV = SERVER_LANE_SOURCE_KEY_ENV
const SECRET_ENV = SERVER_LANE_SECRET_ENV

export const serverLaneCopy = {
  title: "Infinite server lane — install brief for your coding agent",

  whatAndWhy: [
    "Client-side tags (GA4, PostHog, pixels) see well under half of real traffic — ad-blockers, consent gates, and privacy browsers drop them before the first byte. The Infinite server lane counts on the other side of that wall: your server records every HTML document it serves and every conversion it confirms, signs each record, and posts it to Infinite. The board you get back — Visitors, your outcome (downloads, sign-ups, purchases), and the rate between them — matches your server logs, not a sample.",
    "It is private by construction. Your server hashes the visitor identity itself (IP + user agent + a 30-minute window, keyed by a secret only you hold) and sends the hash; the raw IP and full user agent never leave your infrastructure. No cookies, no query strings, no request bodies. Delivery is fire-and-forget with a two-second ceiling, so it can never slow down or break a page. It also honors Do-Not-Track and Global-Privacy-Control (`DNT: 1` / `Sec-GPC: 1`) — a request carrying either is not recorded — exactly as the client pixel does.",
    "It counts DOCUMENT REQUESTS, not client-side page views. On a multi-page site that is one row per page. On a single-page app (SPA) it is one row per real document load — the first entry and every hard reload — NOT the in-app route changes your client router makes after that. So these numbers will NOT match PostHog's `$pageview` count (PostHog fires one per client-router navigation), and the gap is expected: it is the difference between documents your server served and views your JS rendered, not a bug to chase. To count SPA route changes too, keep the client pixel; the server lane is the ad-block-proof floor of real document loads."
  ],

  statusHeading: "Where you are",

  /** The env gate, right under the status: a merged middleware with no env vars records NOTHING. */
  envGateHeading: "Before anything records: two environment variables in PRODUCTION",
  envGate: [
    `The server lane reads \`${SOURCE_ENV}\` and \`${SECRET_ENV}\` from your deployment's environment. **If either is missing it silently records nothing** — no error, no event, an empty board. Merging this code is not enough.`,
    "**Automatic:** run `infinite analytics` in this repo with the Infinite app open. If Infinite has a Vercel connection for your site, it writes both variables to your production environment and redeploys. If this repo is linked to Vercel locally (`.vercel/project.json`), it can set both with your own `vercel` CLI after you confirm.",
    `**Manual:** add both to your host's PRODUCTION environment — the source key is your public \`site_…\` key, the secret is in ${SERVER_LANE_SECRET_LOCATION} (${SERVER_LANE_SECRET_PASTE_WARNING}) — then **redeploy**: a running deployment does not pick up new variables.`,
    "**Working** means Infinite has received the first event from your production site (`infinite analytics --verify-only`, or `npx infinite-tag verify --server-lane`) — never that the files were installed."
  ],
  status: {
    created: (middlewarePath: string, modulePath: string) =>
      `infinite-tag CREATED \`${middlewarePath}\` and \`${modulePath}\`. The lane itself needs nothing more written. Your conversions (purchases, checkout starts, sign-ups) are separate: each is reported from the route where it happens, with the outcome recipes in the guide below. Set the two environment variables below, deploy, then run the verify command.`,
    patched: (middlewarePath: string, modulePath: string) =>
      `infinite-tag PATCHED your existing \`${middlewarePath}\` (fenced \`// infinite-tag:server-lane:start … :end\` blocks; your handler body is unchanged, now wrapped by \`withInfiniteServerLane\`) and created \`${modulePath}\`. Review \`git diff\`, set the two environment variables below, deploy, then run the verify command.`,
    kept: (middlewarePath: string, modulePath: string) =>
      `\`${middlewarePath}\` already carries the infinite-tag server-lane fence, so it was left as is; \`${modulePath}\` is the managed module. Set the two environment variables below, deploy, then run the verify command.`,
    unpatchable: (middlewarePath: string, modulePath: string, reason: string) =>
      `infinite-tag did NOT touch your existing \`${middlewarePath}\` — ${reason} It DID create \`${modulePath}\` (the managed module). Your job: wire the module into the middleware by hand using the exact addition below, keep your own logic scoped by path, and make sure the matcher lets every HTML document through.`,
    nextManual: (modulePath: string) =>
      `This is a Next.js project. Create \`${modulePath}\` from the "Next.js" reference below (or run \`npx infinite-tag install --server-lane\` in the repo), then wire the middleware as shown.`,
    target: (label: string, created: string[]) =>
      created.length > 0
        ? `infinite-tag installed the ${label} server lane and wrote ${created.map((path) => `\`${path}\``).join(", ")}. Everything below is already in the repo — review \`git diff\`, then set the two environment variables, deploy, and run the verify command.`
        : `infinite-tag chose the ${label} server lane but wrote nothing this run (see the notes below). Add the files by hand from the code in this brief, set the two environment variables, deploy, then run the verify command.`,
    targetPackages: (packages: string[]) =>
      `The generated entry imports ${packages.map((name) => `\`${name}\``).join(", ")}. infinite-tag never installs packages, so add it yourself: \`npm install ${packages.join(" ")}\` (or your package manager's equivalent). Without it the build fails at the import.`,
    targetMount:
      "Nothing was wired into your server file: there is no safe, reversible place to guess. Add these two lines yourself, BEFORE your routes and your static handler.",
    outcomeHelper: (path: string) =>
      `Conversions are reported with \`${path}\`, the outcome helper: \`reportStripeCheckoutStarted\` / \`reportStripeCheckoutPurchase\` for a Stripe checkout and its webhook, \`reportInfiniteLead\` for a lead or sign-up, and \`reportInfiniteOutcome\` for anything else. It sends nothing until the environment variables below are set.`,
    targetManual: (path: string, reason: string) =>
      `\`${path}\` was NOT written — ${reason}. Create it with exactly this content:`,
    otherStack: (framework: string) =>
      `This project was detected as "${framework}" — infinite-tag does not patch it automatically. Pick the reference implementation below that matches your runtime (Express / any Node server, Cloudflare Workers, Netlify Edge; anything else follows the generic Node helper), add it in front of your HTML routes, then report outcomes from wherever they become real.`
  },
  exactAdditionHeading: "Exactly what to add to your middleware",
  targetPackagesHeading: "One package to install",
  targetMountHeading: "Mount it in your server",
  targetManualHeading: "Files to add by hand",
  outcomeRouteHeading: "Report conversions from your server",
  outcomeRouteIntro:
    "The lane counts page views on its own. Conversions are yours to report, from the moment they become REAL (a captured payment, a stored sign-up), never from a click. The generated outcome helper (`lib/infinite-outcome`) does the signing, the visit key, the Meta hashing and the timeout, and it does nothing until its environment variables are set. A lead or sign-up route needs one call:",
  outcomeRouteVercel: "After the sign-up is stored (`email`, `body` and `signupId` are the route's own):",
  outcomeRouteNote:
    "`type` is the exact name declared in Infinite → Conversions. The event id is one stable id per person (`HMAC-SHA256(LEAD_ID_SECRET, email)`), so a re-submitted form counts once and the person's later purchase carries the same `external_id`. `reportInfiniteOutcome` itself resolves Infinite's HTTP status (`202` accepted), or `null` when nothing reached Infinite (not configured yet, network error, the 2 s timeout); it never throws, so a failed report can never fail the sign-up.",
  outcomeContextsHeading: "await it, or hand it off: pick by where you call it",
  outcomeContexts: [
    "The right call differs by context, because only some places can safely wait for the network:",
    "- **Middleware / edge document lane**: never `await`. The document recorder is fire-and-forget inside the host's `waitUntil` (`event.waitUntil` on Next.js, `ctx.waitUntil` on Cloudflare, `context.waitUntil` on Netlify), so it can never hold or fail a page response.",
    "- **Payment webhooks**: `await` the report (`reportStripeCheckoutPurchase`). Nobody is waiting on the response, the send is bounded at 2 s, and awaiting it means a serverless function is not frozen before the send completes. Its answer is the webhook's answer: 500 only when a retry can deliver the report.",
    "- **Visitor-facing routes** (checkout redirect, sign-up, lead form): `reportInfiniteOutcomeInBackground` (used by `reportStripeCheckoutStarted` and `reportInfiniteLead`). It hands the send to the site's own `waitUntil` (when the site already depends on `@vercel/functions`) or Next's `after()`; with neither, it waits at most 800 ms. It never adds a dependency."
  ],
  outcomeWebhookNote:
    "Purchases come from the PAYMENT WEBHOOK, whose request is Stripe's, not the buyer's. So the checkout route saves the buyer's device data (their `_fbc`/`_fbp` cookies, ip, user agent and visit key, one metadata field each, only with the page's tracking signal) on the Checkout Session, and the webhook reads it back. Email, name and address are never stored there: the webhook reads them from the paid session.",
  outcomeWebhookExample: [
    "```ts",
    "// 1. The checkout route, around its existing stripe.checkout.sessions.create(params):",
    stripeCheckoutEdit({ language: "ts", router: "next-pages", importSpecifier: "../../lib/infinite-outcome" }).trimEnd(),
    "",
    "// 2. The Stripe webhook route (pages/api/stripe-webhook.ts):",
    stripeWebhookRouteSource({ language: "ts", router: "next-pages", importSpecifier: "../../lib/infinite-outcome" }).trimEnd(),
    "```"
  ],
  adMatchHeading: "Send conversions to Meta (through Infinite)",
  adMatch: (importSpecifier = "../lib/infinite-outcome", language: "ts" | "js" = "ts"): string[] => [
    "Infinite is the Meta path for server conversions, for every site, with or without PostHog. Turn on Infinite → Site Analytics → Settings → \u201cSend outcomes to Meta Conversions API\u201d (Meta connected in Infinite → Connections) and every outcome carrying an `adMatch` block is forwarded to Meta's Conversions API as it is ingested, with the match data then **discarded**: Infinite never stores it, never writes it to your ledger, never logs it.",
    "**If PostHog also sends events to Meta** (a Meta Ads destination in PostHog's data pipelines), turn that destination off for these events (purchase, begin_checkout, lead, sign_up): PostHog's copy carries no shared event id with the pixel and no browser cookies, ip or user agent, and two senders count every conversion twice.",
    "Match data rides ONLY when the page said the visitor allowed tracking (`ad_match=1` on the request, or `adMatch: true` in its JSON body), never inferred from cookies. The helpers below return no match data at all without it.",
    "```" + language,
    `import { adMatchFromRequest, personMatch, contextFromMetadata, stripeCheckoutPayer } from "${importSpecifier}"`,
    "",
    "// A route the buyer's own browser called: their cookies, ip and user agent, plus their hashed details.",
    "const adMatch = await adMatchFromRequest(request, { trackingAllowed: body.adMatch === true, person: { email, externalId: personId } })",
    "",
    "// A payment webhook: the device data the checkout saved, plus the PAYER read from the paid session.",
    "const context = contextFromMetadata(session.metadata)",
    "const adMatchForMeta = await personMatch(context.adMatch, await stripeCheckoutPayer(session))",
    "```",
    "- **Your generated helper hashes; Infinite never does.** `personMatch` / `adMatchFromRequest` emit sha256 hex for `em`, `external_id`, `fn`, `ln`, `ct`, `st`, `zp` and `country` using Meta's normalization rules, byte for byte Infinite's own. The name splits as Infinite's sender does: the first word is `fn`, every later word together is `ln`. Never store email/name/address anywhere new, never put them in Stripe metadata, never log them, and never send a phone number.",
    "- **The payer, never the recipient.** `stripeCheckoutPayer(session)` reads the email and name from `customer_details`, and the address WHOLE from one place: the billing address, or the shipping address only when billing has no city and the shipping name is the payer's own (trimmed, any case). A gift shipped to someone else never lends its address or its name.",
    "- **`external_id` is one stable per-person id shared by that person's lead and purchase:** `infiniteLeadId(email)` = `HMAC-SHA256(LEAD_ID_SECRET, email.trim().toLowerCase())` under a secret only your site holds, hashed once more for Meta. It is **trimmed only, its case kept**: the browser pixel's matching helper hashes the same id the same way, and an id hashed two different ways reaches Meta as two different people.",
    "- **`fbc` / `fbp` are Meta's own cookies** on your domain ([fbp and fbc](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc)). A visitor can set them to anything, so a malformed one is **dropped** and your outcome is still recorded — a tampered cookie can never delete your purchase. When a browser holds two `_fbc` cookies, `adMatchFromRequest` sends the newest ad click.",
    "- **`client_ip_address` / `client_user_agent` are the BUYER'S BROWSER'S**, and only you have them. Meta's spec: “the IP address of the browser” and “the user agent for the browser … required for website events shared using the Conversions API”. The call to Infinite is server-to-server (its ip is your host's egress address, its user agent is `node`), so the helpers read them from YOUR inbound request. In a webhook the incoming request is the provider's, not your buyer's: that is why the checkout saves them on the session (`contextMetadata`, one field each, any value over Stripe's 500-character limit left out) and the webhook reads them back (`contextFromMetadata`).",
    "- **`eventId` is Infinite's idempotency key, not Meta's event ID.** Make it stable per outcome (the session id for a purchase, the person's id for a lead); the helper sends `<type>:<eventId>`, so the same id is the same wire id everywhere and a retried webhook, or both Stripe events for one session, count once. Infinite decides the `event_id` Meta receives. For a conversion set to *Every event* or *Once per session* in Infinite → Conversions it is this value; for *Once per account*, and for *Once per visitor (TTL)* when the outcome carries a `visitKey`, Infinite derives a different id, which your pages never see.",
    "- **Purchases are server events only.** Report them from the payment webhook, as above, and do not also fire `fbq('track', 'Purchase')` on a thank-you page. The page never builds a Meta event ID, so a browser Purchase has no server event to be deduplicated against, and Meta can count the purchase twice.",
    "- **Never build a Meta event ID in the page, and never fire a Meta conversion (`Purchase`, `Lead`, `CompleteRegistration`, `StartTrial`, …) with `fbq` on a click.** A click is intent, not a conversion. A browser event with an id your page made up matches no server event, so Meta counts a conversion that may never have happened.",
    "- **Meta requires four things for a website event, and the relay declines rather than sending a broken one.** It skips (and tells you which, in Site Settings) when there is no `event_source_url` (send `path`: Infinite records an outcome without one, but cannot send it to Meta), no `client_user_agent`, a Purchase with no `value` + `currency`, or an `occurredAt` older than Meta's 7-day window. `value` is in major units: `stripeAmountToMajor` keeps zero-decimal currencies (JPY, KRW, …) whole. Your site's domain must also be verified in Meta, or Meta accepts the events and discounts them.",
    "- `adMatch` rides inside the SIGNED body, so nobody without your secret can inject one. It is never valid on a document request."
  ],

  contractHeading: "The contract (implement exactly)",
  contract: {
    transport: (apiOrigin?: string) => [
      `**Transport.** Signed \`POST ${infiniteServerEventsDestination(apiOrigin)}\` with \`content-type: application/json\`.`,
      `**Headers.** \`${SERVER_LANE_SOURCE_KEY_HEADER}: <site source key>\` and \`${SERVER_LANE_SIGNATURE_HEADER}: <lowercase hex HMAC-SHA256 of the RAW request body under the secret>\`. Sign the exact bytes you send.`,
      `**Environment.** \`${SERVER_LANE_SECRET_ENV}\` — the source's server-event secret, minted once in ${SERVER_LANE_SECRET_LOCATION} (shown once; store it only in your host's PRODUCTION environment). \`${SERVER_LANE_SOURCE_KEY_ENV}\` — the public site source key (the same one the browser pixel uses). Both must be set on the production deployment, which must be redeployed after they are added.`
    ],
    documentRequest: [
      `**1. Document request** — one per HTML page load (GET, non-asset, non-API):`,
      "```json",
      `{ "eventId": "doc:<hex>", "eventName": "${DOCUMENT_REQUEST_EVENT_NAME}", "occurredAt": "<ISO now>",`,
      `  "properties": { "path": "/pricing", "host": "example.com", "visitKey": "<hex>", "userAgentFamily": "browser", "referrerHost": "google.com" } }`,
      "```",
      `- \`visitKey\` = hex HMAC-SHA256(secret, \`"visit:" + clientIp + "|" + userAgent + "|" + floor(epochSeconds / ${VISIT_BUCKET_SECONDS})\`) — computed on YOUR server; the IP never leaves it.`,
      "- `eventId` = `\"doc:\" + hex HMAC-SHA256(secret, visitKey + \"|\" + path + \"|\" + occurredAtMs)` — deterministic, so a retry with the same values is safe (the server dedupes on eventId).",
      "- `userAgentFamily` ∈ `browser | automation | unknown` from a small conservative bot list (bot, crawler, spider, headless, preview, monitor, curl, wget, python-requests, …); empty UA → `unknown`.",
      "- `path` is the pathname only (no query string, no fragment). `host` is the request host and must be one of the site's verified production hosts — Infinite rejects others.",
      "- `referrerHost` is optional: the hostname of the Referer header when present, never its path."
    ],
    outcome: [
      "**2. Outcome** — your conversions (sign-up completed, purchase, download served), same endpoint and headers:",
      "```json",
      `{ "eventId": "signup:12345", "eventName": "sign_up", "occurredAt": "<ISO now>", "accountKey": "12345",`,
      `  "properties": { "visitKey": "<hex, when computed for that request>" } }`,
      "```",
      "- `eventName` is the exact taxonomy name shown in Infinite → Conversions for that outcome (`sign_up`, `purchase`, `download`, …). Undeclared names are rejected, never stored.",
      "- Send it from where the outcome becomes REAL (row committed, payment captured, file served) — never from a click.",
      "- `properties.visitKey`: include it when you can compute it for that request (same recipe) — it is what lets Infinite show the same-lane conversion rate.",
      "- `accountKey` is optional and opaque (a user or order id); Infinite hashes it at rest and uses it for account-deduped outcomes.",
      "- Use a stable `eventId` per outcome (order id, signup id). Retries with the same eventId are safe; the server dedupes.",
      "- `properties` may hold up to 16 keys (`visitKey` is not counted); keys are lowercase snake_case (`^[a-z][a-z0-9_]{0,63}$`; `visitKey` is the one camelCase exception); values are numbers, booleans, or printable tokens with no whitespace of at most 120 characters (no free text). One value outside these rules refuses the WHOLE event, so the generated helper drops such a value itself (and caps `content_ids` by dropping whole ids) rather than lose the conversion.",
      "- `properties.path` is optional for Infinite: an outcome without one is recorded. It is required for Meta, which needs the page (`event_source_url`), so every server conversion the wizard wires sends it.",
      "- `adMatch` is OPTIONAL and outcome-only: `{ em?, external_id?, fn?, ln?, ct?, st?, zp?, country?, fbc?, fbp?, client_ip_address?, client_user_agent? }` where email/name/address/external_id fields are sha256 hex YOU computed, `fbc`/`fbp` are Meta's own first-party cookies, and the ip + user agent are the BUYER'S BROWSER'S, copied from your own inbound request (never from the call to Infinite, which is server-to-server). Never send `ph`. A malformed hash is a 400; a malformed cookie, ip or user agent is dropped. It is consumed by the Meta Conversions API relay at ingest and then discarded, never stored. Send it on every server conversion the visitor allowed tracking for, PostHog or not."
    ],
    delivery: [
      `**Delivery.** Fire-and-forget; never block or fail the response. Timeout ${SERVER_LANE_DELIVERY_TIMEOUT_MS} ms. Never throw into the request path. Next.js middleware: \`event.waitUntil(fetch(...))\`; Cloudflare: \`ctx.waitUntil\`; Netlify Edge: \`context.waitUntil\`; Node/Express: fire the promise and \`.catch(() => {})\`.`,
      "**Skip.** Static assets (by extension and `/_next/`), `/api/*`, non-GET requests, prefetch/HEAD, and any request whose `accept` header does not include `text/html`.",
      "**Never send.** The raw IP, the full user agent (only the family), cookies, query strings (path only), or request bodies."
    ]
  },

  referenceHeading: "Reference implementations",
  reference: {
    next: "Next.js — `lib/infinite-server-lane.ts` (managed module) + `middleware.ts`. This is byte-for-byte what `infinite-tag install --server-lane` writes.",
    nextOutcome: "Next.js: reporting a conversion with the outcome helper (`lib/infinite-outcome`):",
    node: "Express / any Node server — the generic helper (`infinite-server-lane.mjs`) and an Express middleware:",
    nodeOutcome: "Node — reporting an outcome:",
    webCrypto: "Edge runtimes — the WebCrypto helper (`infinite-server-lane-edge.js`) shared by the two snippets below:",
    cloudflare: "Cloudflare Workers:",
    netlify: "Netlify Edge Functions:"
  },

  envHeading: "Environment variables",
  env: [
    "Fastest path: run `infinite analytics` in this repo with the Infinite app open — it sets both in your Vercel production environment for you (through Infinite's Vercel connection, or your own linked `vercel` CLI after you confirm). Otherwise:",
    "",
    `- \`${SERVER_LANE_SECRET_ENV}\` — server-event secret. Mint it in ${SERVER_LANE_SECRET_LOCATION}. It is shown once. Put it in your host's PRODUCTION environment (Vercel: \`vercel env add ${SERVER_LANE_SECRET_ENV} production\`, or Project → Settings → Environment Variables), and in \`.env.local\` only for local runs. It is an ${SERVER_LANE_SECRET_PASTE_WARNING}; infinite-tag never writes it to a file.`,
    `- \`${SERVER_LANE_SOURCE_KEY_ENV}\` — the public site source key (\`site_…\`). Same places. (The Next.js module falls back to the key baked at install time when this is unset.)`,
    "- **Redeploy production after adding them.** Without both variables on the running deployment the lane records nothing, silently.",
    "",
    "Example `.env.local`:",
    "```",
    `${SERVER_LANE_SOURCE_KEY_ENV}=site_xxxxxxxxxxxxxxxx`,
    `${SERVER_LANE_SECRET_ENV}=<paste the secret shown once in Infinite>`,
    "```"
  ],

  privacyHeading: "Privacy and honesty rules",
  privacy: [
    "Hash on your server. The visit key is derived from IP + user agent + a 30-minute window under YOUR secret; only the hash travels.",
    "Never send the raw IP, the full user agent, cookies, query strings, or bodies. Path and host only.",
    "Skip assets, API routes, prefetches, and non-HTML requests, so a page counts once. Classify obvious bots as `automation` — Infinite never sees the user agent, so the family you send is what it records (automation rows are split out, never counted as visitors).",
    "Report outcomes from the moment they are real, never from intent (a click is intent; a committed row is an outcome). Use stable event ids so retries never double count.",
    "Local, loopback, and preview hosts are ignored on Infinite's side (only verified production hosts count); the generated Next.js module also stays dormant on loopback and off-list hosts.",
    "The optional `adMatch` block is the ONE thing this lane forwards anywhere else, it goes only to Meta's Conversions API, only when you turn the relay on, and only from values your own server produced. It is discarded after the send: Infinite never stores it — including the buyer's ip and user agent, which exist only inside the outbound Meta request and are never written to your ledger."
  ],

  verifyHeading: "Verify",
  verify: (apiOrigin?: string) => [
    "With the Infinite app open, `infinite analytics --verify-only` waits for Infinite to receive the first event — no secret needed in your shell. Or, after deploying with both environment variables set in production, from any machine that has the secret:",
    "```",
    `${SERVER_LANE_SECRET_ENV}=<secret> ${SERVER_LANE_SOURCE_KEY_ENV}=site_… npx infinite-tag verify --server-lane https://<your-production-host>/`,
    "```",
    `It loads the page once as \`infinite-tag-verify\` — a self-identified automation user agent, so the check records a flagged agent row and never a visitor in your own numbers — then polls Infinite's receipt endpoint (\`GET ${infiniteServerLaneReceiptUrl(apiOrigin)}?since=<iso>\`, same two source headers; the signature covers the raw query string, e.g. \`since=2026-08-18T20%3A00%3A00.000Z\`) for up to a minute and prints PASS with received / lastPath / lastReceivedAt, or FAIL with the most likely cause.`,
    "That one request is real and is recorded — proving your middleware runs is the whole point — but it is filed as automation, so it stays out of visits and out of any human rate. If bot protection sits in front of the page it may refuse the check; allow the user agent, or load the page yourself while the check polls."
  ],

  doneHeading: "Done when",
  done: [
    "Every HTML document request on a production host produces one signed `site_document_request` (check: `verify --server-lane` prints PASS).",
    "Each declared outcome (`sign_up`, `purchase`, `download`, …) is reported from your server at the moment it becomes real, with a stable eventId and, where possible, `properties.visitKey`.",
    "The two environment variables are set in PRODUCTION and production was redeployed after they were added; the secret is not committed anywhere.",
    "Infinite has received the first server-lane event from production (installed is not working until then).",
    "No page is slower or breaks when Infinite is unreachable (delivery is fire-and-forget with a 2 s cap).",
    "In Infinite → Site Analytics the server-side Visitors / outcome / rate board is filling from your site."
  ],

  /** CLI narration (install / plan). */
  cli: {
    sectionTitle: "Server lane (lossless analytics)",
    created: (path: string) => `+ ${path}  records every HTML document request (fire-and-forget)`,
    patched: (path: string) => `~ ${path}  wrapped your middleware in a fenced infinite-tag block`,
    kept: (path: string) => `= ${path}  already carries the server-lane fence; left as is`,
    unpatchable: (path: string) => `! ${path}  left untouched — see ${SERVER_LANE_BRIEF_FILE} for the exact addition`,
    module: (path: string) => `+ ${path}  managed module (WebCrypto; secrets from env only)`,
    brief: (path: string) => `+ ${path}  the agent brief (contract + reference code + verify)`,
    briefOnly: (path: string) =>
      `+ ${path}  this stack is not patched automatically — the brief below is the install`,
    targetChosen: (label: string, evidence?: string) =>
      `→ ${label}${evidence ? `  (chosen because this repo has ${evidence})` : ""}`,
    targetFile: (path: string) => `+ ${path}  records every HTML document request (fire-and-forget)`,
    targetOutcomeFile: (path: string) => `+ ${path}  reportInfiniteOutcome() and the Stripe/lead helpers for your server routes`,
    targetKeptFile: (path: string) => `= ${path}  edited since infinite-tag wrote it; left as is`,
    targetManualFile: (path: string) =>
      `! ${path}  left untouched — ${SERVER_LANE_BRIEF_FILE} carries the exact file to add`,
    targetInstall: (packages: string[]) =>
      `→ then run: npm install ${packages.join(" ")}   (the generated entry imports it)`,
    targetMount: (path: string) =>
      `→ then add one line to your server: see "Mount it in your server" in ${SERVER_LANE_BRIEF_FILE} (${path})`,
    envIntro:
      "REQUIRED — set two environment variables on your PRODUCTION deployment, then redeploy. Without both, the server lane records nothing (never written to files by infinite-tag):",
    envLines: [
      `  ${SERVER_LANE_SOURCE_KEY_ENV}=site_…              your public site source key`,
      `  ${SERVER_LANE_SECRET_ENV}=…              ${SERVER_LANE_SECRET_LOCATION} (shown once)`,
      "  Automatic: run `infinite analytics` here with the Infinite app open — it writes both to Vercel production for you.",
      `  Manual: vercel env add ${SERVER_LANE_SECRET_ENV} production (or your host's env settings), then redeploy; .env.local is for local runs only`
    ],
    verifyHint: (host: string) =>
      `Then deploy and confirm receipts:  ${SERVER_LANE_SECRET_ENV}=… npx infinite-tag verify --server-lane https://${host}/`,
    briefPrinted: "The full agent brief follows (also written into the project):",
    briefPrintedNoWrite:
      "The full agent brief follows. Save it with:  npx infinite-tag server-lane --brief > INSTALL-SERVER-LANE.md",
    briefHelp: "server-lane --brief   Print the agent brief for the lossless server lane (no install)"
  },

  /** The harness's env step (`infinite analytics` / `infinite-tag harness`). Never interpolates a secret. */
  envStep: {
    title: "Server lane environment",
    receiving: (lastServerLaneEventAt: string) =>
      `✓ The server lane is receiving events with its current secret (last server-lane event at ${lastServerLaneEventAt}) — both environment variables are in place on production.`,
    statusRefused: (message: string) => `Infinite could not report this site's server lane: ${message}.`,
    noDesktop:
      "The Infinite app is not running, so the variables cannot be set for you. Open it and re-run `infinite analytics` to set them automatically.",
    updateRequired: "this Infinite app cannot manage server-lane environment variables yet — update the Infinite app",
    verifyOnlyNoWrites: "--verify-only writes nothing, so the variables are not set by this run.",
    infiniteWillWrite: (projectName: string | null) =>
      `Infinite will add ${SOURCE_ENV} and ${SECRET_ENV} to ${projectName ? `the Vercel project "${projectName}"` : "your connected Vercel project"} (production) and redeploy it. The secret goes from Infinite straight to Vercel; it never reaches this terminal.`,
    infiniteConfirm: "Add both variables and redeploy? [Y/n] ",
    nonInteractiveNoYes:
      "Non-interactive run without --yes: nothing was written to Vercel. Re-run with --yes to let Infinite add both variables.",
    declined: "Nothing was written to Vercel.",
    written: (names: string[], projectName: string | null) =>
      `✓ Infinite wrote ${names.join(" and ")} to ${projectName ? `"${projectName}"` : "your Vercel project"} (production).`,
    partialWrite: (missing: string[]) =>
      `! Infinite did not report writing ${missing.join(" and ")} — check the project's Environment Variables in Vercel.`,
    mintedNewSecret: "  This site had no server-event secret yet, so Infinite minted one and wrote it straight to Vercel.",
    redeployStarted: (deploymentId: string) =>
      `  Redeploy started (${deploymentId}). The variables take effect when it finishes.`,
    /** `redeploy: { skipped, reason }` — nothing was submitted. Every line ends with the unblock step. */
    redeploySkipped: (code: string) => `  ${REDEPLOY_SKIPPED_COPY[code]?.(code) ?? REDEPLOY_GENERIC(code)}`,
    /** `redeploy: { unconfirmed, reason }` — something may have been submitted; never "redeploy again" blind. */
    redeployUnconfirmed: (code: string) =>
      `  ${REDEPLOY_UNCONFIRMED_COPY[code]?.(code) ?? `Redeploy submitted, not confirmed (${code}) — check Vercel's latest production deployment before redeploying again.`}`,
    redeployUnknown:
      "  Redeploy status unknown — the Infinite app did not say whether a redeploy ran. Check Vercel's latest production deployment; the variables only take effect on a new deployment.",
    hostingReadFailed: (code: string) =>
      `Infinite couldn't read its Vercel connection (${code}) — this is not a permission problem. Re-run \`infinite analytics\` in a minute to let Infinite set the variables.`,
    multipleHostingConnections: (host: string | null) =>
      `More than one Vercel project is connected to this workspace in Infinite, so it can't pick which one to write. Set the variables on the project serving ${host ?? "your production site"}.`,
    reconnectVercel: "Reconnect Vercel in Infinite → Connections → Website to allow environment variables.",
    noHostingConnection: "Infinite has no Vercel hosting connection for this workspace.",
    connectHostingHint:
      "  Tip: connect Vercel in Infinite → Connections → Website and re-run `infinite analytics` — Infinite then sets both variables and redeploys for you.",
    envWriteUnknown: (message: string) =>
      `! Infinite could not confirm the write to Vercel (${message}). Check Project → Settings → Environment Variables in Vercel before re-running.`,
    providerRefused: (message: string) => `Infinite could not write the variables: ${message}.`,
    localExplain: (projectName: string | null, replacingSecretSetAt: string | null): string[] => [
      `This repo is linked to Vercel${projectName ? ` (project "${projectName}")` : ""} and the vercel CLI is installed.`,
      `It can set both variables with YOUR vercel CLI: first \`vercel env add ${SOURCE_ENV} production\` (the public key — nothing is minted yet), then Infinite mints this site's server-event secret and \`vercel env add ${SECRET_ENV} production\` stores it. Each value goes on stdin — never on the command line, never in a file, never printed.`,
      ...(replacingSecretSetAt
        ? [`This MINTS A NEW secret: the current one (set ${replacingSecretSetAt}) stops being accepted immediately, wherever it is configured.`]
        : [])
    ],
    localConfirm: "Mint the secret and set both variables in Vercel production now? [Y/n] ",
    localNeedsInteractive:
      "Setting them with your vercel CLI mints a new secret, so it needs an interactive yes (--yes does not approve it). Run `infinite analytics` in a terminal to do it.",
    liveSecretWarning: (secretSetAt: string | null) =>
      `! This site's current server-event secret${secretSetAt ? ` (set ${secretSetAt})` : ""} has already received server-lane events since it was set. Minting a new one stops that install from being accepted immediately, until the new value is deployed.`,
    liveSecretConfirm: "Replace that secret anyway? [y/N] ",
    liveSecretNonInteractive:
      "Refused: the current secret has received server-lane events since it was set, and minting a new one would break that install. Pass --replace-live-secret to replace it anyway.",
    liveSecretKept: "Kept the current secret — it was not replaced.",
    sourceKeyFailedNothingMinted: "Nothing was minted: this site's server-event secret is unchanged.",
    sourceChanged: (publicKey: string) =>
      `! This site's source key changed during the run; setting ${SOURCE_ENV} again to ${publicKey}.`,
    mintRefused: (message: string) => `Infinite did not mint a secret: ${message}.`,
    mintChangedConcurrently: "Another secret change happened at the same moment — nothing was replaced. Re-run `infinite analytics`.",
    localVarSet: (name: string, replaced: boolean) =>
      `✓ ${name} set in Vercel production${replaced ? " (replaced the existing value)" : ""}.`,
    localVarFailed: (name: string, detail: string) => `✗ vercel env add ${name} production failed: ${detail}`,
    secretActiveNotSet: [
      `✗ A NEW server-event secret is now ACTIVE for this site (minted just now), and it is NOT in Vercel. The server lane records nothing until ${SECRET_ENV} is set to it in production.`,
      `  It is shown nowhere else. To fix: reveal a new secret in Infinite → Connections → Website → Set them yourself → Reveal secret, run \`vercel env add ${SECRET_ENV} production\` and paste it at that prompt (${SERVER_LANE_SECRET_PASTE_WARNING}), then redeploy — or re-run \`infinite analytics\`.`
    ],
    redeployNeeded: "Redeploy production so the variables take effect (for example: vercel --prod).",
    redeployConfirm:
      "Run `vercel --prod` now? It deploys this LOCAL working tree (including uncommitted changes) to production. [y/N] ",
    redeployTreeUnsafe: (reason: "dirty_working_tree" | "unpushed_commits" | "git_state_unknown", ahead: number) =>
      reason === "dirty_working_tree"
        ? "Your working tree has uncommitted changes — `vercel --prod` would deploy them to production"
        : reason === "unpushed_commits"
          ? `This branch has ${ahead} commit${ahead === 1 ? "" : "s"} not pushed to its upstream — \`vercel --prod\` would deploy ${ahead === 1 ? "it" : "them"} to production`
          : "This folder's git state couldn't be read (is it a git repository?) — `vercel --prod` would deploy whatever is in it to production, unchecked",
    redeployUnsafeConfirm: (why: string) => `${why}. Run it anyway? [y/N] `,
    redeployRefusedUnsafe: (why: string) =>
      `Refused to run \`vercel --prod\`: ${why}. Commit and push, then redeploy — or pass --allow-dirty with --redeploy to deploy it anyway.`,
    redeployAllowDirty: (why: string) => `! ${why}. Deploying anyway (--redeploy --allow-dirty).`,
    redeployRan: (url: string | null) => `✓ Production deploy finished${url ? `: ${url}` : ""}.`,
    redeployFailed: (detail: string) => `✗ vercel --prod failed: ${detail}`,
    manualHeading:
      "Set the server-lane environment variables on your PRODUCTION deployment — the middleware records nothing until both are set:",
    manualLines: (publicKey: string | null): string[] => [
      `  ${SOURCE_ENV}=${publicKey ?? "site_…"}   ${publicKey ? "your site's public source key" : "your site's public source key (the same site_… key your browser pixel uses)"}`,
      `  ${SECRET_ENV}=<secret>   get it in ${SERVER_LANE_SECRET_LOCATION}; or run \`infinite analytics\` with a linked Vercel project to set it automatically`,
      `  The secret is an ${SERVER_LANE_SECRET_PASTE_WARNING}.`,
      "  Add both to your PRODUCTION environment, then redeploy."
    ],
    manualNextStep: (publicKey: string | null) =>
      `Server lane: set ${SOURCE_ENV}${publicKey ? `=${publicKey}` : ""} and ${SECRET_ENV} (from ${SERVER_LANE_SECRET_LOCATION}) on your PRODUCTION deployment, then redeploy — nothing is recorded until both are set.`,
    waiting: (seconds: number, url: string | undefined) =>
      `Waiting up to ${seconds}s for Infinite to receive the first server-lane event${url ? ` — open ${url} once the deploy is live` : ""} …`,
    firstEvent: (at: string) => `✓ Infinite received the first server-lane event at ${at}.`,
    awaitingReason: (envSet: "yes" | "no" | "unknown", polled: boolean) =>
      envSet === "yes"
        ? polled
          ? "both variables are set; no event arrived yet — wait for the redeploy to finish and load a page"
          : "both variables are set; no receipt check ran"
        : envSet === "no"
          ? `${SOURCE_ENV} and ${SECRET_ENV} are not both set on production — set them, then redeploy`
          : `this run could not confirm ${SOURCE_ENV} and ${SECRET_ENV} are set on production — set them, then redeploy`,
    awaitingRefused: (message: string) => `the first-event check could not complete: ${message}`,
    awaitingNextStep: (url: string | undefined) =>
      `Server lane: installed, not yet working — once production has both variables and a fresh deploy, ${url ? `open ${url}, then ` : ""}run \`infinite analytics --verify-only\` to confirm Infinite receives the first event.`,
    verifyOnlyIncomplete: (reason: string) =>
      `Server lane: Infinite has not received its first event (${reason}). Installed is not working.`
  },

  /** `verify --server-lane` wording. */
  verifyCli: {
    header: "Infinite OS · server-lane verify",
    loading: (url: string) =>
      `Loading ${url} once, identified as automation — the check records a flagged agent row, never a visitor…`,
    polling: (seconds: number) => `Polling Infinite for the receipt (up to ${seconds}s)…`,
    pass: (received: number, lastPath: string | null, lastReceivedAt: string | null) =>
      `PASS — Infinite received ${received} server-lane event${received === 1 ? "" : "s"} since the check started` +
      (lastPath ? ` (last path ${lastPath}` + (lastReceivedAt ? ` at ${lastReceivedAt}` : "") + ")" : "") +
      ".",
    fail: "FAIL — no server-lane receipt arrived.",
    likelyCause: "Most likely cause:",
    causes: {
      siteUnreachable: (status: string) =>
        `The site did not return a page (${status}). Check the URL and that the deployment is live.`,
      botProtection: (status: number, userAgent: string) =>
        `Your edge or WAF answered ${status}. The check identifies itself honestly as automation ("${userAgent}") rather than impersonating Chrome, so bot protection can refuse it. Allow that user agent for one path, or just open the page in your own browser while this check keeps polling — any document request on the lane produces the receipt.`,
      missingSecret: `${SERVER_LANE_SECRET_ENV} is not set in this shell; the receipt endpoint needs it to sign the check.`,
      missingSourceKey: `No site source key: pass --infinite-site-source-key <site_…> or set ${SERVER_LANE_SOURCE_KEY_ENV}.`,
      unauthorized:
        "Infinite rejected the source key + secret pair (401/403). Either the secret in this shell differs from the one minted for this source, or the server lane is not provisioned for it yet — mint/rotate it in Infinite → Site Analytics → Settings → Conversions → Server events.",
      receiptUnavailable: (status: number) =>
        `The receipt endpoint answered ${status}; the server lane may not be live on Infinite's side yet, or the source key is unknown.`,
      noReceipt: [
        "No middleware/proxy is recording document requests on the deployment you hit (was the server lane deployed? does the matcher include this page?).",
        `The deployment's ${SERVER_LANE_SECRET_ENV} differs from the one this shell used, or ${SERVER_LANE_SOURCE_KEY_ENV} is unset there — the lane stays dormant without both.`,
        "The host you loaded is not one of the site's verified production hosts (Infinite rejects others; the Next.js module also stays dormant off-list).",
        "Only assets/API routes were requested — load an HTML page (accept: text/html) that is not under /api or a file path."
      ]
    }
  }
} as const

function codeBlock(language: string, code: string): string[] {
  return ["```" + language, code.replace(/\n$/, ""), "```"]
}

/** The facts the owner hand-off is written from (handoff.ts). Never a secret value. */
export interface ServerEventsHandoffFacts {
  /** The server conversions in the plan (purchase, begin_checkout, lead, sign_up, ...). */
  conversions: string[]
  /** The site's production host, or null when unknown. */
  productionHost: string | null
  /** The public site source key (`site_...`), or null. */
  siteSourceKey: string | null
  /** Infinite can write its two variables into the connected hosting project itself. */
  envSetByInfinite: boolean
  /** Meta is connected in Infinite (the relay can send). */
  metaConnected: boolean
  /** The site takes payments with Stripe (a webhook endpoint is needed). */
  usesStripe: boolean
  /** The site runs PostHog (its own Meta destination must not double count). */
  usesPosthog: boolean
  /** The webhook's URL path ("/api/stripe-webhook"). */
  webhookUrlPath: string
}

/** "a", "a and b", "a, b and c" (plain words). */
const andList = (items: readonly string[]): string => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`)

/**
 * Whether the server code reads LEAD_ID_SECRET: a sign-up's event id (`lead:<HMAC of the email>`), and the hashed
 * `external_id` a purchase or any other outcome with the customer's email carries (`stripeCheckoutPayer` and the
 * generic report both call `infiniteLeadId`). A checkout start has no email, so it alone never needs it.
 */
export function usesPersonId(conversions: readonly string[]): boolean {
  return conversions.some((name) => name !== "begin_checkout")
}

const listOf = (names: readonly string[]): string =>
  names.length <= 1 ? names.map((name) => `\`${name}\``).join("") : `${names.slice(0, -1).map((name) => `\`${name}\``).join(", ")} and \`${names.at(-1)}\``

/**
 * The WIZARD's server-lane copy (`npx infinite-tag`). Kept apart from `serverLaneCopy` on purpose: the
 * plain installer (`install --server-lane`) keeps its exact words, while the wizard wires conversions with
 * the outcome helper's Stripe and lead functions and hands the site owner a plain list of steps.
 * Every recipe is the code text from recipes.ts, so the brief, this copy and the guide cannot drift.
 */
export const serverLaneWizardCopy = {
  /** Decision 5: the npm-install line, as the wizard's plan shows it. */
  targetPackages: (packages: string[]) =>
    `The generated entry imports ${packages.map((name) => `\`${name}\``).join(", ")}. The wizard installs it as its own plan line (\`npm install ${packages.join(" ")}\`, or your package manager's equivalent), only after you approve the plan. Without it the build fails at the import.`,

  reportOutcomeHeading: "Leads and sign-ups: report from the route that stores them",
  /** The lead / sign-up recipe, plus the variant whose response hands the page Infinite's Meta id. */
  reportOutcomeRecipe: (importSpecifier = "../lib/infinite-outcome", language: "ts" | "js" = "ts"): string[] => [
    "Report the conversion from the server route that stores it, the moment it is REAL (the row committed, the address subscribed), never on a click. `reportInfiniteLead` never makes the visitor wait long: it hands the send to the site's own background primitive, or waits at most 800 ms.",
    "```" + language,
    leadRouteEdit({ language, router: "next-pages", importSpecifier }).trimEnd(),
    "```",
    "A route whose response the page waits on, and that should let the page fire the matching browser Meta event, returns Infinite's id instead (`type`, `stableId` and `email` are the route's own):",
    "```" + language,
    mirrorRouteEdit({ language, router: "next-pages", importSpecifier, path: "/signup" }).trimEnd(),
    "```",
    "Then, in the page, fire it ONLY with what the server returned, and wait for it before leaving:",
    "```" + language,
    "const data = await response.json()",
    "await infiniteMetaMirror(data.metaEventName, data.metaEventId)  // null: Infinite is not sending one, nothing fires",
    'location.assign("/welcome")',
    "```",
    "- **One stable id per person.** `infiniteLeadId(email)` is `HMAC-SHA256(LEAD_ID_SECRET, email.trim().toLowerCase())` under a secret only the site holds. It is the lead's event id (`lead:<id>`, so a re-submit counts once) and, hashed once more, the `external_id` the same person's purchase carries. Without `LEAD_ID_SECRET` the stored row id is the event id and no `external_id` is sent.",
    "- **Match data needs the page's signal.** Only when the page sent `adMatch: true` (or `ad_match=1`) because the visitor allowed tracking; never inferred from cookies. Without it the helpers attach no match data at all.",
    "- **Never write the email, name or address anywhere new**, never into metadata or logs, and never send a phone number. The helper hashes the email in-process.",
    "- **Never build a Meta event id in the page, and never fire a Meta conversion with `fbq` on a click.** The page mirrors only the id the server returned; the mirror refuses `Purchase` and waits at most 400 ms for Meta's request before navigation.",
    "- **Browser Meta guards:** browser-only events that navigate immediately (`add_to_cart`, custom CTA clicks) need the same 400 ms wait, and Meta pixels need `fbq.disablePushState = true` before init so Meta's automatic history PageViews do not double count or leak onto pixel-free routes."
  ],

  webhookCaptureHeading: "Purchases: save the buyer's device at checkout, report from the payment webhook",
  /** The checkout edit + the Stripe webhook route (P1-2, P1-3, gap 7). */
  webhookCaptureRecipe: (importSpecifier = "../lib/infinite-outcome", language: "ts" | "js" = "ts"): string[] => [
    "A payment webhook's request is Stripe's, not the buyer's. So the CHECKOUT route saves the buyer's device data on the Checkout Session (their `_fbc`/`_fbp` cookies, ip, user agent and visit key, one metadata field each, only with the page's tracking signal) together with the cart, and reports `begin_checkout`. The WEBHOOK reads it back and reports the purchase.",
    "```" + language,
    stripeCheckoutEdit({ language, router: "next-pages", importSpecifier }).trimEnd(),
    "```",
    `A new webhook route (\`pages/api/stripe-webhook.${language}\`; an App Router or Express site uses its own route shape):`,
    "```" + language,
    stripeWebhookRouteSource({ language, router: "next-pages", importSpecifier: importSpecifier.replace(/^\.\.\//, "../../") }).trimEnd(),
    "```",
    "A site that already has a Stripe webhook keeps it and adds, right after its signature check:",
    "```" + language,
    existingStripeWebhookAddition({ importSpecifier }).trimEnd(),
    "```",
    "- **Purchases are server events only.** No browser `fbq('track', 'Purchase')` and no mirror: a purchase reaches Meta from this webhook alone, through Infinite.",
    `- **Which events count:** only \`${STRIPE_PURCHASE_EVENTS.join("` and `")}\`, only paid, only live (\`livemode\`; test-mode payments are ignored on purpose), and only sessions this site's checkout created (Payment Links and other integrations on the same Stripe account are skipped). The session id is the event id, so both events for one session and every Stripe retry count once.`,
    "- **No retry storm:** the webhook answers 500 (so Stripe retries) only when the report was not delivered or Infinite answered 5xx, 401, 403 or 429. Before Infinite is configured, and for every refusal a retry cannot fix, it answers 200.",
    "- **The payer, never the recipient:** email and name come from `customer_details`; the address comes whole from the billing address, or from the shipping address only when billing has no city and it is addressed to the payer by name. They are hashed in the helper and never stored, logged or put in metadata; never send a phone number.",
    "- **Commerce values:** `value` is the amount charged in major units (zero-decimal currencies such as JPY and KRW are not divided), `currency` is uppercase, and `content_ids` is one comma-joined token capped at 120 characters by dropping whole ids.",
    "- **Outcome names:** declare `purchase`, `begin_checkout` and `lead` in Infinite from \u201cYour server\u201d. Infinite's relay sends `begin_checkout` to Meta as InitiateCheckout and `purchase` as Purchase."
  ],

  /** The site owner's hand-off file + PR section (P0-6): plain words, the exact steps, no secrets. */
  handoff: {
    title: "Turn on server conversions",
    intro: (facts: ServerEventsHandoffFacts) =>
      `This pull request adds server code that reports ${listOf(facts.conversions)} to Infinite, which counts them and sends them on to Meta. The code stays switched off until you do the steps below: it sends nothing and changes nothing for your visitors until then.`,
    steps: (facts: ServerEventsHandoffFacts): string[] => {
      const host = facts.productionHost ?? "<your-domain>"
      const steps: string[] = [
        `In the Infinite app, open **Site Analytics → Settings → Sources** and check that \`${host}\` is listed for this site.`,
        `In **Site Analytics → Settings → Conversions**, add ${listOf(facts.conversions)}, each with the source **Your server**.`,
        `In **Site Analytics → Settings → Conversions → Server events**, click **Generate secret**. It is shown once: paste it straight into the next step, never into chat, email or a file.`,
        [
          `In your hosting's **production** environment variables, add: ${andList([
            `\`${SERVER_LANE_SOURCE_KEY_ENV}\` = \`${facts.siteSourceKey ?? "site_..."}\``,
            `\`${SERVER_LANE_SECRET_ENV}\` = the secret from the step above`,
            // Live run 4: only when the code reads it (a sign-up's id, a buyer's or subscriber's match id), never for
            // checkout starts alone.
            ...(usesPersonId(facts.conversions) ? ["`LEAD_ID_SECRET` = a long random value you make once and never change (for example the output of `openssl rand -hex 32`); it turns each customer's email into one private id Meta matches them by"] : []),
            ...(facts.usesStripe ? [`\`${STRIPE_WEBHOOK_SECRET_ENV}\` (from the Stripe step below)`] : [])
          ])}.`,
          facts.envSetByInfinite
            ? `Infinite can add the first two to your connected Vercel project for you: run \`infinite analytics\` with the Infinite app open. Then redeploy.`
            : "Then redeploy: a running deployment does not pick up new variables."
        ].join(" ")
      ]
      if (facts.usesStripe) {
        steps.push(
          `In **Stripe → Developers → Webhooks**, add an endpoint \`https://${host}${facts.webhookUrlPath}\` that listens to \`${STRIPE_PURCHASE_EVENTS.join("` and `")}\`. Copy its signing secret into \`${STRIPE_WEBHOOK_SECRET_ENV}\` and redeploy.`
        )
      }
      steps.push(
        facts.metaConnected
          ? "In **Site Analytics → Settings**, check that **Send outcomes to Meta Conversions API** is on."
          : "In the Infinite app, open **Connections** and connect Meta, then in **Site Analytics → Settings** turn on **Send outcomes to Meta Conversions API**.",
        `In **Meta Business Settings → Brand safety → Domains**, verify \`${host}\`. Without it Meta accepts these events but gives them less weight.`
      )
      if (facts.usesPosthog) {
        steps.push(
          `If PostHog sends events to Meta (a Meta Ads destination in PostHog's data pipelines), turn it off for ${listOf(facts.conversions)}: Infinite already sends them, and two senders count each one twice.`
        )
      }
      steps.push(
        facts.usesStripe
          ? "After the redeploy, make one real purchase (test-mode payments are ignored on purpose; refund it afterwards) and watch it arrive in **Site Analytics**."
          : "After the redeploy, sign up once yourself and watch it arrive in **Site Analytics**."
      )
      return steps
    },
    untilThen: (facts: ServerEventsHandoffFacts) =>
      `Until these steps are done, the new code does nothing: it reports nothing${facts.usesStripe ? ", and Stripe gets an ordinary 200 from the webhook" : ""}.`,
    prHeading: "Your steps before server conversions reach Infinite and Meta",
    prIntro: (path: string) => `The server code in this pull request stays switched off until you do these steps. They are also in \`${path}\`.`
  }
}

export function renderStatusParagraph(status: ServerLaneBriefStatus): string {
  switch (status.kind) {
    case "created":
      return serverLaneCopy.status.created(status.middlewarePath, status.modulePath)
    case "patched":
      return serverLaneCopy.status.patched(status.middlewarePath, status.modulePath)
    case "kept":
      return serverLaneCopy.status.kept(status.middlewarePath, status.modulePath)
    case "unpatchable":
      return serverLaneCopy.status.unpatchable(status.middlewarePath, status.modulePath, status.reason)
    case "next-manual":
      return serverLaneCopy.status.nextManual(status.modulePath)
    case "target":
      return serverLaneCopy.status.target(status.label, status.created)
    case "other-stack":
      return serverLaneCopy.status.otherStack(status.framework)
  }
}

/** The complete brief as Markdown. Pure; deterministic for a given input. */
export function renderServerLaneBrief(input: ServerLaneBriefInput): string {
  const moduleImportPath = input.moduleImportPath ?? DEFAULT_MODULE_IMPORT_PATH
  const outcomeImportSpecifier = input.outcomeImportSpecifier ?? "../lib/infinite-outcome"
  const outcomeLanguage = input.outcomeLanguage ?? "ts"
  const lines: string[] = [
    SERVER_LANE_BRIEF_BANNER,
    `# ${serverLaneCopy.title}`,
    "",
    OWNER_BOUNDARY_INSTRUCTION,
    "",
    `> ${SERVER_LANE_POSITIONING}`,
    "",
    "## What this is (and why)",
    "",
    ...serverLaneCopy.whatAndWhy.flatMap((paragraph) => [paragraph, ""]),
    `## ${serverLaneCopy.statusHeading}`,
    "",
    renderStatusParagraph(input.status),
    "",
    ...(input.outcomeHelperPath ? [serverLaneCopy.status.outcomeHelper(input.outcomeHelperPath), ""] : []),
    ...(input.outcomeManual ?? []).flatMap((file) => [
      serverLaneCopy.status.targetManual(file.path, file.reason),
      "",
      ...codeBlock(file.path.endsWith(".ts") ? "ts" : "js", file.contents),
      ""
    ]),
    `### ${serverLaneCopy.envGateHeading}`,
    "",
    ...serverLaneCopy.envGate.flatMap((line) => [line, ""])
  ]

  if (input.status.kind === "target") {
    const status = input.status
    if (status.installPackages.length > 0) {
      lines.push(
        `### ${serverLaneCopy.targetPackagesHeading}`,
        "",
        serverLaneCopy.status.targetPackages(status.installPackages),
        ""
      )
    }
    if (status.mount) {
      lines.push(
        `### ${serverLaneCopy.targetMountHeading}`,
        "",
        serverLaneCopy.status.targetMount,
        "",
        ...codeBlock("js", status.mount),
        ""
      )
    }
    if (status.manual.length > 0) {
      lines.push(`### ${serverLaneCopy.targetManualHeading}`, "")
      for (const file of status.manual) {
        lines.push(
          serverLaneCopy.status.targetManual(file.path, file.reason),
          "",
          ...codeBlock(file.path.endsWith(".js") ? "js" : "ts", file.contents),
          ""
        )
      }
    }
  }

  if (input.status.kind === "unpatchable" || input.status.kind === "next-manual") {
    lines.push(
      `### ${serverLaneCopy.exactAdditionHeading}`,
      "",
      ...codeBlock("ts", manualNextMiddlewareAddition({ moduleImportPath, matcher: NEXT_DOCUMENT_MATCHER })),
      ""
    )
  }

  lines.push(
    `## ${serverLaneCopy.contractHeading}`,
    "",
    ...serverLaneCopy.contract.transport(input.apiOrigin).flatMap((line) => [line, ""]),
    ...serverLaneCopy.contract.documentRequest,
    "",
    ...serverLaneCopy.contract.outcome,
    "",
    ...serverLaneCopy.contract.delivery.flatMap((line) => [line, ""]),
    `## ${serverLaneCopy.referenceHeading}`,
    "",
    `### ${serverLaneCopy.reference.next}`,
    "",
    "`lib/infinite-server-lane.ts`:",
    "",
    ...codeBlock(
      "ts",
      buildServerLaneModuleSource({
        siteSourceKey: input.siteSourceKey,
        productionHosts: input.productionHosts,
        ...(input.apiOrigin ? { apiOrigin: input.apiOrigin } : {})
      })
    ),
    "",
    "`middleware.ts` (when the project has none; `proxy.ts` on Next.js 16+):",
    "",
    ...codeBlock("ts", buildCreatedMiddlewareSource({ moduleImportPath })),
    "",
    serverLaneCopy.reference.nextOutcome,
    "",
    ...codeBlock("ts", nextOutcomeSnippet("@/lib/infinite-outcome")),
    "",
    `### ${serverLaneCopy.reference.node}`,
    "",
    ...codeBlock("js", nodeHelperSnippet(input.apiOrigin)),
    "",
    ...codeBlock("js", expressSnippet()),
    "",
    serverLaneCopy.reference.nodeOutcome,
    "",
    ...codeBlock("js", outcomeSnippet()),
    "",
    `### ${serverLaneCopy.reference.webCrypto}`,
    "",
    ...codeBlock("js", webCryptoHelperSnippet(input.apiOrigin)),
    "",
    `### ${serverLaneCopy.reference.cloudflare}`,
    "",
    ...codeBlock("js", cloudflareWorkerSnippet()),
    "",
    `### ${serverLaneCopy.reference.netlify}`,
    "",
    ...codeBlock("js", netlifyEdgeSnippet()),
    "",
    `## ${serverLaneCopy.outcomeRouteHeading}`,
    "",
    serverLaneCopy.outcomeRouteIntro,
    "",
    serverLaneCopy.outcomeRouteVercel,
    "",
    ...codeBlock(
      outcomeLanguage,
      outcomeRouteSnippet({ importSpecifier: outcomeImportSpecifier, language: outcomeLanguage })
    ),
    "",
    serverLaneCopy.outcomeRouteNote,
    "",
    `### ${serverLaneCopy.outcomeContextsHeading}`,
    "",
    ...serverLaneCopy.outcomeContexts,
    "",
    serverLaneCopy.outcomeWebhookNote,
    "",
    ...serverLaneCopy.outcomeWebhookExample,
    "",
    `### ${serverLaneCopy.adMatchHeading}`,
    "",
    ...serverLaneCopy.adMatch(outcomeImportSpecifier, outcomeLanguage),
    "",
    `## ${serverLaneCopy.envHeading}`,
    "",
    ...serverLaneCopy.env,
    "",
    `## ${serverLaneCopy.privacyHeading}`,
    "",
    ...serverLaneCopy.privacy.map((line) => `- ${line}`),
    "",
    `## ${serverLaneCopy.verifyHeading}`,
    "",
    ...serverLaneCopy.verify(input.apiOrigin),
    "",
    `## ${serverLaneCopy.doneHeading}`,
    "",
    ...serverLaneCopy.done.map((line) => `- [ ] ${line}`),
    ""
  )
  return lines.join("\n")
}

/**
 * The short pointer written to the repo ROOT (INSTALL-SERVER-LANE.md). It carries the status line,
 * a link to the full guide under docs/, and the two environment variables — so the root stays
 * uncluttered while the 700-line guide (and the .infinite/install.json record) hold the detail.
 *
 * `guidePath` is null when the guide could NOT be written (an unmanaged file already sits at docs/).
 * The pointer must never link to the customer's own file or claim a `serverLane.guide` record that
 * does not exist, so it points at the CLI instead.
 */
export function renderServerLanePointer(input: ServerLaneBriefInput & { guidePath: string | null }): string {
  const guideLine = input.guidePath
    ? `**The full install guide is in [\`${input.guidePath}\`](${input.guidePath})** — contract, reference implementations for every platform, the outcome + Meta relay recipes, and the verify steps. It is also recorded in \`.infinite/install.json\` (\`serverLane.guide\`).`
    : "**The full install guide was NOT written** — a file Infinite does not manage already sits where it would go (docs/). It was printed during install; regenerate it any time with `npx infinite-tag server-lane --brief` (redirect it to a path of your choosing)."
  return [
    SERVER_LANE_BRIEF_BANNER,
    `# ${serverLaneCopy.title}`,
    "",
    OWNER_BOUNDARY_INSTRUCTION,
    "",
    `> ${SERVER_LANE_POSITIONING}`,
    "",
    renderStatusParagraph(input.status),
    "",
    guideLine,
    "",
    `## ${serverLaneCopy.envGateHeading}`,
    "",
    ...serverLaneCopy.envGate.flatMap((line) => [line, ""]),
    "```",
    `${SERVER_LANE_SOURCE_KEY_ENV}=site_xxxxxxxxxxxxxxxx`,
    `${SERVER_LANE_SECRET_ENV}=<paste the secret shown once in ${SERVER_LANE_SECRET_LOCATION}>`,
    "```",
    "",
    `Then deploy and confirm receipts: \`${SERVER_LANE_SECRET_ENV}=… npx infinite-tag verify --server-lane https://<your-production-host>/\``,
    ""
  ].join("\n")
}
