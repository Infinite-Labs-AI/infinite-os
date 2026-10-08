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

import {
  defaultStripeWebhookRoute,
  existingStripeWebhookAddition,
  leadRouteEdit,
  mirrorRouteEdit,
  STRIPE_PURCHASE_EVENTS,
  STRIPE_WEBHOOK_SECRET_ENV,
  stripeCheckoutEdit,
  stripeWebhookRouteSource,
  type RecipeLanguage,
  type RecipeRouter
} from "./recipes.js"

/**
 * One event the scan found or expects, and where. LOCAL COPY of `EventInventoryEntry` from
 * `src/scan/event-inventory.ts` (Builder A's module, not merged yet): only the fields this brief reads.
 * Replace with `import type { EventInventoryEntry } from "../scan/event-inventory.js"` once it lands.
 */
export interface EventInventoryEntry {
  /** The conversion name: purchase, begin_checkout, lead, sign_up, start_trial, ... */
  event: string
  /** Repo-relative file where it happens (or where it should be reported from); null when unknown. */
  file?: string | null
  /** 1-based line in `file`, when known. */
  line?: number | null
  /** The payment provider behind it, when there is one ("stripe"). */
  provider?: string | null
  /** What the scan saw there, e.g. "stripe_checkout_session", "stripe_webhook", "api_route", "success_page". */
  kind?: string | null
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
  /** An existing Stripe webhook route, repo-relative, when the scan found one. */
  stripeWebhookFile?: string | null
  /** The app root ("." for the repo root), so a new route lands inside the app. */
  appRoot?: string
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

function where(entry: EventInventoryEntry): string {
  if (!entry.file) return "where it becomes real (the scan found no single place: find it)"
  return entry.line ? `${quotedPath(entry.file)} line ${Math.trunc(entry.line)}` : quotedPath(entry.file)
}

const COMMON_RULES = [
  "Match data rides ONLY with the page's explicit signal that the visitor allowed tracking: the page adds `ad_match=1` to the request (or `adMatch: true` to its JSON body) only where the site's own code would load its Meta pixel for that visitor. On a site with no consent gate that is always. Read the site's consent state; never change consent code, a cookie banner or a privacy page.",
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
export function serverConversionInstructions(entry: EventInventoryEntry, ctx: ServerConversionBriefContext): string {
  const helper = ctx.outcomeHelper ?? `${ctx.appRoot && ctx.appRoot !== "." ? `${ctx.appRoot}/` : ""}lib/infinite-outcome.ts`
  const language = languageOf(helper)
  const router = routerFor(ctx)
  const name = ctx.conversionName ?? entry.event
  const appPrefix = ctx.appRoot && ctx.appRoot !== "." ? `${ctx.appRoot}/` : ""
  const srcDir = /(^|\/)src\/lib\//.test(helper)
  const importFor = (file: string) => outcomeImportFrom(file, helper)

  if (PURCHASE_EVENTS.has(entry.event)) {
    const existing = ctx.stripeWebhookFile ?? (entry.kind === "stripe_webhook" ? entry.file ?? null : null)
    const route = defaultStripeWebhookRoute(router, language, srcDir)
    const routeFile = `${appPrefix}${route.file}`
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
      `2. The checkout route (where the site calls \`stripe.checkout.sessions.create\`${entry.file && entry.kind !== "stripe_webhook" ? `; the scan points at ${where(entry)}` : ""}) must save the cart and the buyer's device data on the session, or the webhook has nothing to report from (\`siteCheckout\` stays false and it answers 200). If the begin_checkout job does not already cover that route, apply its edit there:`,
      ...codeBlock(
        language,
        stripeCheckoutEdit({
          language,
          router,
          importSpecifier: entry.file && entry.kind !== "stripe_webhook" ? importFor(entry.file) : "<the helper, imported from that route>"
        })
      ),
      "   `contentIds` are the cart's product or price ids and `numItems` its item count; keep the route's own metadata and parameters.",
      "Do not also report the purchase anywhere else (no success-page call, no browser Purchase): the session id is the one event id, so the webhook alone counts it once.",
      ...COMMON_RULES.map((rule) => `- ${rule}`)
    ].join("\n")
  }

  if (CHECKOUT_EVENTS.has(entry.event)) {
    const file = entry.file ?? null
    return [
      `Here: report \`${name}\` (Meta InitiateCheckout through Infinite) where the route creates the Stripe Checkout Session: ${where(entry)}. In the background: the visitor is never held more than 800 ms.`,
      helperLine(helper),
      "Wrap the route's existing `stripe.checkout.sessions.create(params)` like this (keep its own parameters and metadata; `contentIds` = the cart's product or price ids, `numItems` = its item count):",
      ...codeBlock(language, stripeCheckoutEdit({ language, router, importSpecifier: file ? importFor(file) : "<the helper, imported from this route>" })),
      "`contextMetadata` stores one metadata field per value (the cart, the visit key, and only with the page's signal the `_fbc`/`_fbp` cookies, ip and user agent); a value over Stripe's 500-character limit is left out, never cut. The purchase webhook reads them back. Report after the session exists and before the redirect.",
      ...COMMON_RULES.map((rule) => `- ${rule}`)
    ].join("\n")
  }

  if (LEAD_EVENTS.has(entry.event)) {
    const file = entry.file ?? null
    const type = name
    return [
      `Here: report \`${type}\` from the server route that stores it: ${where(entry)}, right after the sign-up is stored (the row committed, the address subscribed), never on the click.`,
      helperLine(helper),
      ...codeBlock(language, leadRouteEdit({ language, router, importSpecifier: file ? importFor(file) : "<the helper, imported from this route>", type, fallbackPath: "/" })),
      "`email` is the submitted address, `body` the parsed request body, `signupId` the stored row's id. The event id is `" + type + ":<HMAC of the normalized email under LEAD_ID_SECRET>` (one per person, so a re-submit counts once), and the same person's purchase carries the same external_id. Set `fallbackPath` to the page the form is on.",
      "Only if this route's response is what the page waits on before it fires the browser Meta event, use the mirror form instead and return its two values to the page:",
      ...codeBlock(language, mirrorRouteEdit({ language, router, importSpecifier: file ? importFor(file) : "<the helper, imported from this route>" })),
      ...COMMON_RULES.map((rule) => `- ${rule}`)
    ].join("\n")
  }

  // Any other server outcome (start_trial, subscribe, a custom name): the generic call.
  return [
    `Here: report \`${name}\` at ${where(entry)}, the moment it becomes real, with \`await reportInfiniteOutcome({ type: ${JSON.stringify(name)}, eventId: <a stable id: the subscription, order or account id>, path: <the page it belongs to>, properties: { ... }, adMatch })\`.`,
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
 * entry is the item's target and first evidence; the context is the brief's facts. The ONE entry point
 * `jobs/briefs.ts` calls.
 */
export function serverConversionInstructionsForItem(
  item: Pick<ChecklistItem, "id" | "trigger">,
  facts: { framework: string; router: "app" | "pages" | null; appRoot: string; managedFiles?: string[] | null },
  conversionName?: string
): string {
  const index = item.id.indexOf(":")
  const event = index < 0 ? item.id : item.id.slice(index + 1)
  const first = item.trigger.evidence.find((evidence): evidence is { file: string; line: number } => "file" in evidence)
  const webhook = item.trigger.evidence.find((evidence): evidence is { file: string; line: number } => "file" in evidence && /webhook/i.test(evidence.file))
  return serverConversionInstructions(
    { event, file: first?.file ?? null, line: first?.line ?? null },
    {
      framework: facts.framework,
      router: facts.router,
      appRoot: facts.appRoot,
      outcomeHelper: outcomeHelperAmong(facts.managedFiles),
      ...(conversionName ? { conversionName } : {}),
      stripeWebhookFile: webhook?.file ?? null
    }
  )
}
