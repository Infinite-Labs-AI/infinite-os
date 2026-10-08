// The server-conversion recipes, as code text: the Stripe webhook route, the checkout edit and the lead
// edit. One source for the agent's job brief (job-brief.ts), the wizard copy and the guide, so the three
// can never drift. Every name a recipe uses is either imported from the generated outcome helper
// (targets/outcome-helper.ts), defined in the recipe, or one of the free variables its comment names
// (the site's own request, Stripe client and cart). recipes.test.ts EXECUTES each one against the real
// helper with exactly those variables supplied.
//
// The behaviour is the first store customer's hand-built fix, generalized: the purchase is reported from
// the payment webhook only (paid, live, this site's own sessions), begin_checkout from the session
// creation in the background, and a lead from the sign-up route with one stable id per person.

export type RecipeLanguage = "ts" | "js"

/**
 * Which handler shape the site's server routes use:
 * - `next-pages`: Next.js Pages Router API route, (req, res) with req.query / req.body.
 * - `web`: (request: Request) => Response: Next.js App Router route handlers, Vercel and Netlify functions.
 * - `express`: Express / any Node server, (req, res) with express.raw() for the webhook.
 */
export type RecipeRouter = "next-pages" | "web" | "express"

export interface RecipeInput {
  language: RecipeLanguage
  router: RecipeRouter
  /** The import specifier from the route file to the outcome helper ("../../lib/infinite-outcome"). */
  importSpecifier: string
}

/** The Stripe webhook events the purchase is reported from. */
export const STRIPE_PURCHASE_EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded"] as const

/** The env var holding the webhook endpoint's signing secret (from Stripe, never from Infinite). */
export const STRIPE_WEBHOOK_SECRET_ENV = "STRIPE_WEBHOOK_SECRET"

/** The default route a new Stripe webhook is created at, per router. */
export function defaultStripeWebhookRoute(router: RecipeRouter, language: RecipeLanguage, srcDir = false): { file: string; urlPath: string } {
  const prefix = srcDir ? "src/" : ""
  if (router === "next-pages") return { file: `${prefix}pages/api/stripe-webhook.${language}`, urlPath: "/api/stripe-webhook" }
  if (router === "web") return { file: `${prefix}app/api/stripe-webhook/route.${language}`, urlPath: "/api/stripe-webhook" }
  return { file: `stripe-webhook.${language}`, urlPath: "/api/stripe-webhook" }
}

const ts = (language: RecipeLanguage, text: string): string => (language === "ts" ? text : "")

function webhookHeader(input: RecipeInput): string[] {
  return [
    "// Stripe → Infinite: each paid checkout is reported once, as a purchase, and Infinite relays it to Meta.",
    `// Stripe endpoint: https://<your-domain>/api/stripe-webhook, events ${STRIPE_PURCHASE_EVENTS.join(" + ")}.`,
    `// ${STRIPE_WEBHOOK_SECRET_ENV} is that endpoint's signing secret (Stripe → Developers → Webhooks).`,
    "// Inert until Infinite's environment variables are set: it answers 200 and reports nothing."
  ]
}

/**
 * A complete Stripe webhook route file. The signature is checked on the RAW body; everything after that
 * is `reportStripeCheckoutPurchase`, whose answer (200, or 500 only when a retry can deliver the report)
 * is the route's answer.
 */
export function stripeWebhookRouteSource(input: RecipeInput & { successPath?: string }): string {
  const t = (text: string) => ts(input.language, text)
  const successPath = JSON.stringify(input.successPath ?? "/success")
  const importHelper = `import { reportStripeCheckoutPurchase } from ${JSON.stringify(input.importSpecifier)}`
  const client = [
    "// Use the site's existing Stripe client here instead, if it already has one.",
    'const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "")'
  ]
  if (input.router === "next-pages") {
    return [
      ...webhookHeader(input),
      ...(input.language === "ts" ? ['import type { NextApiRequest, NextApiResponse } from "next"'] : []),
      'import Stripe from "stripe"',
      importHelper,
      "",
      ...client,
      "",
      "// Stripe signs the raw bytes, so Next must not parse the body.",
      "export const config = { api: { bodyParser: false } }",
      "",
      `async function rawBody(req${t(": NextApiRequest")})${t(": Promise<Buffer>")} {`,
      `  const chunks${t(": Buffer[]")} = []`,
      "  for await (const chunk of req) chunks.push(Buffer.from(chunk))",
      "  return Buffer.concat(chunks)",
      "}",
      "",
      `export default async function handler(req${t(": NextApiRequest")}, res${t(": NextApiResponse")}) {`,
      '  if (req.method !== "POST") {',
      '    res.setHeader("Allow", "POST")',
      "    return res.status(405).end()",
      "  }",
      `  let event${t(": Stripe.Event")}`,
      "  try {",
      `    event = stripe.webhooks.constructEvent(await rawBody(req), String(req.headers["stripe-signature"] ?? ""), process.env.${STRIPE_WEBHOOK_SECRET_ENV} ?? "")`,
      "  } catch {",
      "    return res.status(400).end() // not signed by Stripe",
      "  }",
      "  // 500 only when a retry can deliver the report; 200 for everything else (test mode, other sessions, before setup).",
      `  return res.status(await reportStripeCheckoutPurchase(event, { path: ${successPath} })).json({ received: true })`,
      "}",
      ""
    ].join("\n")
  }
  if (input.router === "web") {
    return [
      ...webhookHeader(input),
      'import Stripe from "stripe"',
      importHelper,
      "",
      ...client,
      "",
      `export async function POST(request${t(": Request")})${t(": Promise<Response>")} {`,
      `  let event${t(": Stripe.Event")}`,
      "  try {",
      "    // Stripe signs the raw bytes: read the body as text, never as parsed JSON.",
      `    event = await stripe.webhooks.constructEventAsync(await request.text(), request.headers.get("stripe-signature") ?? "", process.env.${STRIPE_WEBHOOK_SECRET_ENV} ?? "")`,
      "  } catch {",
      "    return new Response(null, { status: 400 }) // not signed by Stripe",
      "  }",
      "  // 500 only when a retry can deliver the report; 200 for everything else (test mode, other sessions, before setup).",
      `  return Response.json({ received: true }, { status: await reportStripeCheckoutPurchase(event, { path: ${successPath} }) })`,
      "}",
      ""
    ].join("\n")
  }
  return [
    ...webhookHeader(input),
    ...(input.language === "ts" ? ['import type { Request as ExpressRequest, Response as ExpressResponse } from "express"'] : []),
    'import Stripe from "stripe"',
    importHelper,
    "",
    ...client,
    "",
    "// Mount it with the RAW body parser, before any JSON body parser sees the request:",
    '//   app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), stripeWebhook)',
    `export async function stripeWebhook(req${t(": ExpressRequest")}, res${t(": ExpressResponse")}) {`,
    `  let event${t(": Stripe.Event")}`,
    "  try {",
    `    event = stripe.webhooks.constructEvent(req.body, String(req.headers["stripe-signature"] ?? ""), process.env.${STRIPE_WEBHOOK_SECRET_ENV} ?? "")`,
    "  } catch {",
    "    return res.status(400).end() // not signed by Stripe",
    "  }",
    `  return res.status(await reportStripeCheckoutPurchase(event, { path: ${successPath} })).json({ received: true })`,
    "}",
    ""
  ].join("\n")
}

/**
 * The lines to add to an EXISTING Stripe webhook route, right after its signature check. The route keeps
 * everything it already does; its final answer becomes 500 only when the report asks for a retry.
 */
export function existingStripeWebhookAddition(input: { importSpecifier: string; successPath?: string }): string {
  return [
    `import { reportStripeCheckoutPurchase } from ${JSON.stringify(input.importSpecifier)}`,
    "",
    "// Right after the signature check (event = the VERIFIED Stripe event), before the route answers:",
    `const infiniteStatus = await reportStripeCheckoutPurchase(event, { path: ${JSON.stringify(input.successPath ?? "/success")} })`,
    "// ... the route's own handling stays as it is ...",
    "// Answer 500 when infiniteStatus is 500 (a retry can deliver the report) and the route would otherwise",
    "// answer 2xx; never turn the route's own error into a 200.",
    ""
  ].join("\n")
}

/**
 * Where the page sends its "visitor allowed tracking" signal, which is where the route reads it (never from cookies):
 *   form  — a hidden `ad_match` field in a form that posts: the parsed request body;
 *   json  — `adMatch` in a JSON body;
 *   query — `ad_match=1` in the URL (a link, a GET form, a fetch with no body).
 */
export type SignalSource = "form" | "json" | "query"

/**
 * How a route reads the page's signal, per router. A Next pages-router API route parses a posted form's fields
 * (urlencoded) and a JSON body into `req.body` with its default body parser; Express needs `express.urlencoded()` /
 * `express.json()` for the same; a web route reads its own `await request.formData()` (`form`) or parsed JSON (`body`).
 */
export function trackingSignalExpression(router: RecipeRouter, source: SignalSource): string {
  if (router === "web") {
    if (source === "query") return 'new URL(request.url).searchParams.get("ad_match") === "1"'
    if (source === "form") return 'form.get("ad_match") === "1"'
    return "body.adMatch === true"
  }
  if (source === "query") return 'req.query.ad_match === "1"'
  if (source === "form") return 'req.body?.ad_match === "1"'
  return "req.body?.adMatch === true"
}

/** The lead's read: as above, except a JSON body is the route's own parsed `body` (a free variable of the lead edit). */
export function leadSignalExpression(router: RecipeRouter, source: SignalSource): string {
  return source === "json" ? "body.adMatch === true" : trackingSignalExpression(router, source)
}

/**
 * The checkout edit, around the route's existing `stripe.checkout.sessions.create(params)`.
 * Free variables (the route's own): `req` / `request`, `stripe`, `params` (its session parameters),
 * `contentIds` (the cart's product or price ids) and `numItems` (the item count); in a web route, also `form` (its
 * `await request.formData()`) for a form post, or `body` (its parsed JSON) for a JSON fetch.
 */
export function stripeCheckoutEdit(input: RecipeInput & { cartPath?: string; signal?: SignalSource }): string {
  const request = input.router === "web" ? "request" : "req"
  return [
    `import { buyerContext, contextMetadata, reportStripeCheckoutStarted } from ${JSON.stringify(input.importSpecifier)}`,
    "",
    "// The page adds the signal only when the visitor allowed tracking; never infer it from cookies.",
    `const trackingAllowed = ${trackingSignalExpression(input.router, input.signal ?? "query")}`,
    `const context = await buyerContext(${request}, { trackingAllowed })`,
    "const session = await stripe.checkout.sessions.create({",
    "  ...params, // the route's existing session parameters, unchanged",
    "  // The cart and the buyer's device data ride to the webhook. Never an email, a name or an address.",
    "  metadata: { ...params.metadata, ...contextMetadata(context, { contentIds, numItems }) }",
    "})",
    "// begin_checkout (Meta InitiateCheckout through Infinite); waits at most 800 ms, or runs after the response.",
    `await reportStripeCheckoutStarted(session, { path: ${JSON.stringify(input.cartPath ?? "/cart")} })`,
    ""
  ].join("\n")
}

/**
 * The lead / sign-up edit, after the sign-up is stored. Free variables (the route's own): `req` /
 * `request`, `email` (the submitted address), `body` (the parsed JSON body, for the page's signal; `form` in a web
 * route that reads a posted form) and `signupId` (the stored row's id, used only when LEAD_ID_SECRET is not set).
 */
export function leadRouteEdit(input: RecipeInput & { type?: string; fallbackPath?: string; signal?: SignalSource }): string {
  const request = input.router === "web" ? "request" : "req"
  return [
    `import { reportInfiniteLead } from ${JSON.stringify(input.importSpecifier)}`,
    "",
    "// Once the sign-up is REAL (stored, subscribed), never on the click:",
    `await reportInfiniteLead(${request}, {`,
    `  type: ${JSON.stringify(input.type ?? "lead")},`,
    "  email, // the submitted address: hashed in the helper, never sent, stored or logged",
    `  trackingAllowed: ${leadSignalExpression(input.router, input.signal ?? "json")}, // the page's signal that the visitor allowed tracking`,
    `  fallbackPath: ${JSON.stringify(input.fallbackPath ?? "/")}, // used when the request carries no same-site Referer`,
    "  fallbackId: signupId // the stored row's id; used only when LEAD_ID_SECRET is not set",
    "})",
    ""
  ].join("\n")
}

/**
 * A route whose response the PAGE awaits and that should hand the page Infinite's Meta id, so the page
 * can fire the matching browser event (infiniteMetaMirror). Free variables: `req` / `request`, `body`,
 * `type`, `stableId`, `email`.
 */
export function mirrorRouteEdit(input: RecipeInput & { path?: string; signal?: SignalSource }): string {
  const request = input.router === "web" ? "request" : "req"
  return [
    `import { adMatchFromRequest, infiniteLeadId, reportInfiniteOutcomeForMirror } from ${JSON.stringify(input.importSpecifier)}`,
    "",
    "const personId = await infiniteLeadId(email)",
    "const report = await reportInfiniteOutcomeForMirror({",
    "  type,",
    "  eventId: personId ?? stableId,",
    `  path: ${JSON.stringify(input.path ?? "/")},`,
    `  visitKeyInputs: ${request},`,
    `  adMatch: await adMatchFromRequest(${request}, { trackingAllowed: ${leadSignalExpression(input.router, input.signal ?? "json")}, person: { email, externalId: personId } })`,
    "})",
    "// Hand the page only what Infinite returned; null means no browser event fires.",
    "const mirror = { metaEventId: report.metaEventId, metaEventName: report.metaEventName }",
    ""
  ].join("\n")
}
