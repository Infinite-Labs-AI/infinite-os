// The agent's exact instructions for ONE server conversion (purchase, begin_checkout, lead, sign_up, ...).
//
// The server-conversions job (`jobs/briefs.ts`, job `server_conversions`) routes here, so the agent gets
// the same recipes the guide shows (recipes.ts), built on the generated outcome helper's functions
// (targets/outcome-helper.ts): nothing for the agent to invent, and no name a recipe uses that the repo
// does not have. The behaviour is the first store customer's hand-built fix, generalized:
//   - purchase: from the Stripe payment webhook only (create the route when there is none), paid, live,
//     this site's own sessions, value / currency / content_ids / num_items and the PAYER's match data;
//   - begin_checkout: at the Checkout Session creation, in the background, saving the buyer's device data
//     on the session for the webhook;
//   - lead / sign_up: at the API route that stores it, with hashed em + the same external_id the person's
//     purchase carries (HMAC of the email under LEAD_ID_SECRET, hashed once), event id lead:<that id>.
// Match data only with the page's explicit tracking signal; never an email, name or address in metadata or
// logs; never a phone.
import { posix } from "node:path"

import { sanitizeUntrusted } from "../agents/sanitize.js"
import type { ChecklistItem } from "../wizard/contracts/jobs.js"
import { SERVER_SITE_VIAS, type EventInventory, type EventInventoryEntry, type EventSite, type PageRequest, type PageRequestHow, type TrackingSignal } from "../scan/event-inventory.js"

import {
  defaultStripeWebhookRoute,
  existingStripeWebhookAddition,
  leadRouteEdit,
  leadSignalExpression,
  mirrorRouteEdit,
  STRIPE_PURCHASE_EVENTS,
  STRIPE_WEBHOOK_SECRET_ENV,
  stripeCheckoutEdit,
  stripeWebhookRouteSource,
  trackingSignalExpression,
  type RecipeLanguage,
  type RecipeRouter,
  type SignalSource
} from "./recipes.js"

/**
 * One server conversion to brief: the job's target, the scan's inventory entry for it (`src/scan/event-inventory.ts`)
 * when there is one, and the route the scan found it in (a server trigger site, else the job's first evidence).
 */
export interface ServerConversionTarget {
  /** The conversion name: purchase, begin_checkout, lead, sign_up, start_trial, ... */
  event: string
  /** The scan's own entry for the event (where it fires, which tools already get it, which miss it). */
  entry?: EventInventoryEntry | null
  /** The server route to report from (or, for a purchase, the checkout route the scan points at). */
  file?: string | null
  /** 1-based line in `file`, when known. */
  line?: number | null
}

export interface ServerConversionBriefContext {
  /** The detected framework ("next-pages-router", "next-app-router", "express", "vite-react", ...). */
  framework: string
  /** `pages` / `app` for Next.js; null otherwise. */
  router: "app" | "pages" | null
  /** Repo-relative path of the generated outcome helper (lib/infinite-outcome.ts / .js / .mjs), or null. */
  outcomeHelper: string | null
  /** The approved conversion name the plan uses for this event (defaults to the event itself). */
  conversionName?: string
  /** The scan's payment webhook (`EventInventory.paymentWebhook`), when the site already has one. */
  paymentWebhook?: EventSite | null
  /** The scan's Stripe Checkout Session creations (`EventInventory.checkoutCreates`): where begin_checkout is reported. */
  checkoutCreates?: readonly EventSite[]
  /** The webhook route this job may create (the job's `allow.create`), when the site has none. */
  newWebhookFile?: string | null
  /** The app root ("." for the repo root), so a new route lands inside the app. */
  appRoot?: string
  /** P1-B: where the page's "visitor allowed tracking" signal comes from on this site (`EventInventory.trackingSignal`). */
  trackingSignal?: TrackingSignal | null
  /** Finding 1: the pages that send each server route's request, and how (`EventInventory.pageRequests`). */
  pageRequests?: readonly PageRequest[] | null
}

const PURCHASE_EVENTS = new Set(["purchase", "order_completed", "checkout_completed"])
const CHECKOUT_EVENTS = new Set(["begin_checkout", "initiate_checkout", "checkout_started"])
const LEAD_EVENTS = new Set(["lead", "lead_captured", "sign_up", "signup", "registration", "user_signed_up"])

function routerFor(ctx: ServerConversionBriefContext): RecipeRouter {
  if (ctx.router === "pages") return "next-pages"
  if (ctx.router === "app") return "web"
  return /express|node/.test(ctx.framework) ? "express" : "web"
}

function languageOf(helper: string | null): RecipeLanguage {
  return helper && /\.(js|mjs)$/.test(helper) ? "js" : "ts"
}

/** The import specifier from `file` to the outcome helper: extensionless for TS, WITH the extension for JS. */
export function outcomeImportFrom(file: string, helper: string): string {
  const from = posix.dirname(file.split("\\").join("/"))
  const target = /\.ts$/.test(helper) ? helper.replace(/\.ts$/, "") : helper
  let path = posix.relative(from === "" ? "." : from, target)
  if (!path.startsWith(".")) path = `./${path}`
  return path
}

function codeBlock(language: RecipeLanguage, code: string): string[] {
  return ["```" + language, code.trimEnd(), "```"]
}

/** A repo-derived path is UNTRUSTED data: one inert line, JSON-quoted, so it can never forge an instruction. */
function quotedPath(path: string): string {
  return JSON.stringify(sanitizeUntrusted(path.replace(/[\u2028\u2029]/g, " "), 100_000))
}

function whereAt(site: { file?: string | null; line?: number | null } | null | undefined): string {
  if (!site?.file) return "where it becomes real (the scan found no single place: find it)"
  return site.line ? `${quotedPath(site.file)} line ${Math.trunc(site.line)}` : quotedPath(site.file)
}

/** The pages that send this conversion's request (the entry's browser trigger sites), for the tracking signal. */
function pageSites(entry: EventInventoryEntry | null | undefined): EventSite[] {
  return (entry?.sites ?? []).filter((site) => !SERVER_SITE_VIAS.has(site.via))
}

/** A page that sends a server route's request, and how it sends it. */
export interface SignalPage {
  file: string
  line: number | null
  how: PageRequestHow
  /** In plain words ("a form that posts"); null when the scan only knows the page fires the event. */
  via: string | null
}

/**
 * Finding 1: the pages that send `routes`' requests: the scan's page requests to those routes, else the event's
 * browser trigger sites (how unknown). The one list the brief names and the static check (`commerce-static.ts`
 * `signalFindings`) reads.
 */
export function signalPagesFor(pageRequests: readonly PageRequest[] | null | undefined, routes: readonly string[], fallback: ReadonlyArray<{ file: string; line?: number | null }>): SignalPage[] {
  const requests = (pageRequests ?? []).filter((request) => routes.includes(request.route))
  if (requests.length > 0) return requests.map((request) => ({ file: request.file, line: request.line, how: request.how, via: request.via }))
  const seen = new Set<string>()
  return fallback.filter((site) => !seen.has(site.file) && seen.add(site.file)).map((site) => ({ file: site.file, line: site.line ?? null, how: "unknown" as const, via: null }))
}

/** The one way every page sends the request (a form post, a JSON fetch, a URL), or null when unknown or mixed. */
export function signalSourceOf(pages: readonly SignalPage[]): SignalSource | null {
  const hows = new Set(pages.map((page) => page.how))
  const [only] = [...hows]
  return hows.size === 1 && only !== undefined && only !== "unknown" ? only : null
}

/** The signal's value as the page computes it: the site's own reader, `true`, or the tag's helper. */
function signalValue(signal: TrackingSignal | null | undefined): string {
  if (signal?.kind === "site_getter") return signal.expression
  if (signal?.kind === "always") return "true"
  return "infiniteAdMatchAllowed()"
}

/** What the page adds to its request so the route can read the signal: ONE wording per way the page sends it. */
export function signalCarryWords(source: SignalSource, signal: TrackingSignal | null | undefined, pageFile?: string | null): string {
  const value = signalValue(signal)
  const always = signal?.kind === "always"
  if (source === "form") {
    if (pageFile && /\.html?$/i.test(pageFile)) return always ? "one hidden field `ad_match` with the value `1` inside the form" : `one hidden field \`ad_match\` inside the form, set to \`1\` just before it submits only when \`${value}\` is true`
    return always ? 'one hidden field inside the form: `<input type="hidden" name="ad_match" value="1" />`' : `one hidden field inside the form: \`<input type="hidden" name="ad_match" value={${value} ? "1" : "0"} />\``
  }
  if (source === "json") return `\`adMatch: ${value}\` in the JSON body it sends`
  return always ? "`ad_match=1` in the request's URL" : `\`ad_match=1\` in the request's URL only when \`${value}\` is true (for example \`\${${value} ? "&ad_match=1" : ""}\`)`
}

const SOURCE_WORDS: Readonly<Record<SignalSource, string>> = { form: "a form that posts", json: "a JSON fetch", query: "a link, a GET form or a fetch with no body" }

/**
 * P1-B / Finding 1: the page side. The request carries the visitor's tracking signal, read on the page, never from
 * cookies on the server: the site's OWN consent reader (read only) when the scan found one, `true` on a site with no
 * consent gate at all, else the tag's `infiniteAdMatchAllowed()`. It goes where the page's request already carries
 * data (a hidden field in a posted form, the JSON body, the URL), and the route reads it from that same place under
 * that same key (`read`).
 */
export function pageSignalLine(pages: readonly SignalPage[], signal: TrackingSignal | null | undefined, read: (source: SignalSource) => string): string {
  const where = pages.length > 0 ? ` (${pages.slice(0, 3).map((page) => `${quotedPath(page.file)}${page.line ? ` line ${Math.trunc(page.line)}` : ""}${page.via ? `, ${page.via}` : ""}`).join("; ")})` : ""
  const head = `On the page that sends this request${where}, add the visitor's tracking signal to it and change nothing else there:`
  const origin =
    signal?.kind === "site_getter"
      ? ` The signal is the site's own consent reader \`${signal.expression}\` (\`${signal.name}\` is exported by ${quotedPath(signal.file)} line ${Math.trunc(signal.line)}; import it relative to the page). That file is the site's consent code: only import and call the reader, never edit it.`
      : signal?.kind === "always"
        ? " This site has no consent gate, so the signal is always true."
        : " If the site keeps its own consent state, read that instead of `infiniteAdMatchAllowed()` (read only, never edit it)."
  const source = signalSourceOf(pages)
  if (source) return `${head} ${signalCarryWords(source, signal, pages[0]?.file)}. The route reads it as \`${read(source)}\`, as the code above does.${origin}`
  const ways = (["form", "json", "query"] as const).map((way) => `${SOURCE_WORDS[way]}: ${signalCarryWords(way, signal, pages[0]?.file)}, read in the route as \`${read(way)}\``)
  return `${head} send it the way this request already carries data, and make the route's \`trackingAllowed\` read it from that same place (replace the read in the code above): ${ways.join("; ")}.${origin}`
}

const COMMON_RULES = [
  "Match data rides ONLY with the page's signal that the visitor allowed tracking (`ad_match=1` / `adMatch: true`, from the place the page-side line above names). The server never infers it from cookies. Never change consent code, a cookie banner or a privacy page.",
  "Never write an email, a name or an address into metadata, logs or any new place; never send a phone number. The helper hashes in-process and sends digests only.",
  "Never build a Meta event id in the page and never fire a Meta conversion with `fbq` on a click. Never add a dependency or edit package.json.",
  "Everything here is inert until the site owner sets the environment variables (they are in the owner's hand-off, not your job): do not ask for them, do not write them anywhere."
]

function helperLine(helper: string): string {
  return `Use the generated outcome helper ${quotedPath(helper)} (never open, copy or re-implement it); every function below is exported by it.`
}

/**
 * The instructions for one server conversion. The job is only seeded when the server lane is installed (the
 * plan withholds it otherwise), so the helper exists; `ctx.outcomeHelper` names its exact file, and without
 * that record the lane's own default (`<app>/lib/infinite-outcome.ts`) is named.
 */
export function serverConversionInstructions(target: ServerConversionTarget, ctx: ServerConversionBriefContext): string {
  const helper = ctx.outcomeHelper ?? `${ctx.appRoot && ctx.appRoot !== "." ? `${ctx.appRoot}/` : ""}lib/infinite-outcome.ts`
  const language = languageOf(helper)
  const router = routerFor(ctx)
  const name = ctx.conversionName ?? target.event
  const appPrefix = ctx.appRoot && ctx.appRoot !== "." ? `${ctx.appRoot}/` : ""
  const srcDir = /(^|\/)src\/lib\//.test(helper)
  const importFor = (file: string) => outcomeImportFrom(file, helper)
  const entry = target.entry ?? null
  const at = target.file ? { file: target.file, line: target.line ?? null } : null
  // The scan's checkout session creation (the inventory), else the job's own place when it is not a webhook.
  const checkout = ctx.checkoutCreates?.[0] ?? (at && !/webhook/i.test(at.file) ? at : null)

  if (PURCHASE_EVENTS.has(target.event)) {
    const existing = ctx.paymentWebhook?.file ?? null
    const route = defaultStripeWebhookRoute(router, language, srcDir)
    const routeFile = ctx.newWebhookFile ?? `${appPrefix}${route.file}`
    return [
      `Here: report \`${name}\` from the Stripe PAYMENT WEBHOOK only (Meta Purchase through Infinite), never from the page, the success page or a click.`,
      helperLine(helper),
      existing
        ? `1. The repo already has a Stripe webhook at ${quotedPath(existing)}. Keep everything it does and add these lines right after its signature check (the event must be the VERIFIED one, built from the RAW body):`
        : `1. The repo has no Stripe webhook route: create ${quotedPath(routeFile)} exactly like this (adapt only the Stripe client to the site's existing one, if it has one):`,
      ...codeBlock(
        language,
        existing
          ? existingStripeWebhookAddition({ importSpecifier: importFor(existing) })
          : stripeWebhookRouteSource({ language, router, importSpecifier: importFor(routeFile) })
      ),
      `   It verifies Stripe's signature on the raw body (${STRIPE_WEBHOOK_SECRET_ENV}), then \`reportStripeCheckoutPurchase\` reports only \`${STRIPE_PURCHASE_EVENTS.join("` / `")}\` for a paid, live (livemode) session that this site's checkout created, with value (major units; zero-decimal currencies kept whole), currency, content_ids, num_items, the visit key and the PAYER's hashed match data. Its answer is the route's answer: 500 only when a retry can deliver the report (not delivered, Infinite 5xx, 401, 403, 429), 200 for everything else, so Stripe never retry-storms before setup.`,
      `2. The checkout route (where the site calls \`stripe.checkout.sessions.create\`${checkout ? `; the scan points at ${whereAt(checkout)}` : ""}) must save the cart and the buyer's device data on the session, or the webhook has nothing to report from (\`siteCheckout\` stays false and it answers 200). If the begin_checkout job does not already cover that route, apply its edit there:`,
      ...codeBlock(
        language,
        // The same read as the begin_checkout job's edit of that route (Finding 1: where the cart page sends the signal).
        stripeCheckoutEdit({ language, router, importSpecifier: checkout ? importFor(checkout.file) : "<the helper, imported from that route>", signal: signalSourceOf(signalPagesFor(ctx.pageRequests, checkout ? [checkout.file] : [], [])) ?? "query" })
      ),
      "   `contentIds` are the cart's product or price ids and `numItems` its item count; keep the route's own metadata and parameters.",
      "Do not also report the purchase anywhere else (no success-page call, no browser Purchase): the session id is the one event id, so the webhook alone counts it once.",
      ...COMMON_RULES.map((rule) => `- ${rule}`)
    ].join("\n")
  }

  if (CHECKOUT_EVENTS.has(target.event)) {
    const file = checkout?.file ?? null
    const pages = signalPagesFor(ctx.pageRequests, file ? [file] : [], pageSites(entry))
    const source = signalSourceOf(pages) ?? "query"
    return [
      `Here: report \`${name}\` (Meta InitiateCheckout through Infinite) where the route creates the Stripe Checkout Session: ${whereAt(checkout)}. In the background: the visitor is never held more than 800 ms.`,
      helperLine(helper),
      "Wrap the route's existing `stripe.checkout.sessions.create(params)` like this (keep its own parameters and metadata; `contentIds` = the cart's product or price ids, `numItems` = its item count):",
      ...codeBlock(language, stripeCheckoutEdit({ language, router, importSpecifier: file ? importFor(file) : "<the helper, imported from this route>", signal: source })),
      "`contextMetadata` stores one metadata field per value (the cart, the visit key, and only with the page's signal the `_fbc`/`_fbp` cookies, ip and user agent); a value over Stripe's 500-character limit is left out, never cut. The purchase webhook reads them back. Report after the session exists and before the redirect.",
      pageSignalLine(pages, ctx.trackingSignal, (way) => trackingSignalExpression(router, way)),
      ...COMMON_RULES.map((rule) => `- ${rule}`)
    ].join("\n")
  }

  if (LEAD_EVENTS.has(target.event)) {
    const file = at?.file ?? null
    const type = name
    const pages = signalPagesFor(ctx.pageRequests, file ? [file] : [], pageSites(entry))
    const source = signalSourceOf(pages) ?? "json"
    return [
      `Here: report \`${type}\` from the server route that stores it: ${whereAt(at)}, right after the sign-up is stored (the row committed, the address subscribed), never on the click.`,
      helperLine(helper),
      ...codeBlock(language, leadRouteEdit({ language, router, importSpecifier: file ? importFor(file) : "<the helper, imported from this route>", type, fallbackPath: "/", signal: source })),
      "`email` is the submitted address, `body` the parsed request body, `signupId` the stored row's id. Always pass `fallbackId`: without it nothing is reported until the owner sets LEAD_ID_SECRET. When the route stores no row, pass a new id per submission instead (`randomUUID()` from `node:crypto`, or `crypto.randomUUID()` in an edge route), so each sign-up counts once. With LEAD_ID_SECRET set, the event id is `" + type + ":<HMAC of the normalized email under LEAD_ID_SECRET>` (one per person, so a re-submit counts once), and the same person's purchase carries the same external_id. Set `fallbackPath` to the page the form is on.",
      pageSignalLine(pages, ctx.trackingSignal, (way) => leadSignalExpression(router, way)),
      "Only if this route's response is what the page waits on before it fires the browser Meta event, use the mirror form instead and return its two values to the page:",
      ...codeBlock(language, mirrorRouteEdit({ language, router, importSpecifier: file ? importFor(file) : "<the helper, imported from this route>", signal: source })),
      ...COMMON_RULES.map((rule) => `- ${rule}`)
    ].join("\n")
  }

  // Any other server outcome (start_trial, subscribe, a custom name): the generic call.
  return [
    `Here: report \`${name}\` at ${whereAt(at)}, the moment it becomes real, with \`await reportInfiniteOutcome({ type: ${JSON.stringify(name)}, eventId: <a stable id: the subscription, order or account id>, path: <the page it belongs to>, properties: { ... }, adMatch })\`.`,
    helperLine(helper),
    "In a route the visitor's own browser called, `adMatch` is `await adMatchFromRequest(request, { trackingAllowed, person: { email, externalId: await infiniteLeadId(email) } })`. In a webhook, the browser's device data must have been saved earlier (`buyerContext` + `contextMetadata` at checkout, `contextFromMetadata` + `personMatch` in the webhook). A webhook answers 500 only when `reportInfiniteOutcome` resolved null, a 5xx, 401, 403 or 429, and only after `infiniteConfigured()` is true.",
    ...COMMON_RULES.map((rule) => `- ${rule}`)
  ].join("\n")
}

/** Infinite's generated outcome helper among the files the install wrote (`.infinite/install.json`), or null. */
export function outcomeHelperAmong(files: readonly string[] | null | undefined): string | null {
  return (files ?? []).find((file) => /(?:^|\/)lib\/infinite-outcome\.(ts|js|mjs)$/.test(file)) ?? null
}

/**
 * The server-conversions job's instructions for one checklist item (`server_conversions:<conversion>`): the
 * item's target and its inventory entry (the registry seeds it from the scan), the server route the scan found
 * (a server trigger site of the entry, else the item's first evidence), and the scan's checkout and webhook facts
 * (`facts.inventory`, the before step's inventory; the item's own evidence when it is absent). The ONE entry point
 * `jobs/briefs.ts` calls.
 */
export function serverConversionInstructionsForItem(
  item: Pick<ChecklistItem, "id" | "trigger" | "allow" | "inventory">,
  facts: { framework: string; router: "app" | "pages" | null; appRoot: string; managedFiles?: string[] | null; inventory?: EventInventory | null },
  conversionName?: string
): string {
  const index = item.id.indexOf(":")
  const event = index < 0 ? item.id : item.id.slice(index + 1)
  const entry = item.inventory?.[0] ?? null
  const evidence = item.trigger.evidence.filter((entry): entry is { file: string; line: number } => "file" in entry)
  const serverSite = (entry?.sites ?? []).find((site) => site.via === "form-api" || site.via === "payment-webhook")
  const first = serverSite ?? evidence[0] ?? null
  const inventory = facts.inventory ?? null
  // The scan's facts, else what the item itself carries (its entry's sites, its webhook evidence).
  const checkoutCreates = inventory?.checkoutCreates.length ? inventory.checkoutCreates : (entry?.sites ?? []).filter((site) => site.via === "stripe.checkout.sessions.create")
  const webhookEvidence = evidence.find((site) => /webhook/i.test(site.file))
  const paymentWebhook = inventory ? inventory.paymentWebhook : (entry?.sites.find((site) => site.via === "payment-webhook") ?? (webhookEvidence ? { ...webhookEvidence, via: "payment-webhook" } : null))
  const newWebhookFile = item.allow?.create.find((file) => /webhook/i.test(file)) ?? null
  return serverConversionInstructions(
    { event, entry, file: first?.file ?? null, line: first?.line ?? null },
    {
      framework: facts.framework,
      router: facts.router,
      appRoot: facts.appRoot,
      outcomeHelper: outcomeHelperAmong(facts.managedFiles),
      ...(conversionName ? { conversionName } : {}),
      checkoutCreates,
      paymentWebhook,
      newWebhookFile,
      trackingSignal: inventory?.trackingSignal ?? null,
      pageRequests: inventory?.pageRequests ?? null
    }
  )
}
