import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { INFINITE_SERVER_EVENTS_DESTINATION, INFINITE_SERVER_LANE_RECEIPT_URL } from "../workspace-artifacts.js"

import {
  SERVER_LANE_BRIEF_BANNER,
  SERVER_LANE_POSITIONING,
  renderServerLaneBrief,
  serverLaneCopy,
  serverLaneWizardCopy
} from "./copy.js"
import { createScanner } from "../review/scan.js"

describe("the agent brief", () => {
  const brief = renderServerLaneBrief({
    status: { kind: "other-stack", framework: "Express" },
    moduleImportPath: "./lib/infinite-server-lane"
  })

  it("keeps generated source-reference examples publishable through the real secret scanner", () => {
    const guide = renderServerLaneBrief({ status: { kind: "created", middlewarePath: "middleware.ts", modulePath: "lib/infinite-server-lane.ts" }, siteSourceKey: "site_fixture", productionHosts: ["example.test"] })
    const scanner = createScanner({ literals: [], allowedIds: [] })
    expect(guide).toContain("contextMetadata(context, { contentIds, numItems })")
    expect(scanner.redact(guide).hits).toEqual([])
    expect(scanner.findInCommit([{ path: "docs/infinite-server-lane.md", added: guide.split("\n").map((text, index) => ({ text, line: index + 1 })) }], () => false)).toEqual([])
  })

  it("opens with the managed banner and the positioning line", () => {
    expect(brief.startsWith(`${SERVER_LANE_BRIEF_BANNER}\n# `)).toBe(true)
    expect(brief.slice(0, 900)).toContain("Consent, cookie banners, CMP code, privacy policies and terms pages belong to the site owner")
    expect(brief).toContain(`> ${SERVER_LANE_POSITIONING}`)
    expect(SERVER_LANE_POSITIONING).toBe(
      "server-side analytics: every page your server serves and every outcome it confirms, counted where ad-blockers can't reach. A floor for people, never an exact share — installed by your agent in ten minutes."
    )
    expect(SERVER_LANE_POSITIONING).not.toContain("100%")
    expect(brief).not.toContain("100%")
  })

  it("states the contract verbatim: endpoint, headers, env, both body shapes, recipes, delivery, skips, never-send", () => {
    expect(brief).toContain(`POST ${INFINITE_SERVER_EVENTS_DESTINATION}`)
    expect(brief).toContain("`x-infinite-source-key: <site source key>`")
    expect(brief).toContain("`x-infinite-signature: <lowercase hex HMAC-SHA256 of the RAW request body under the secret>`")
    expect(brief).toContain("`INFINITE_SERVER_EVENT_SECRET`")
    expect(brief).toContain("`INFINITE_SITE_SOURCE_KEY`")
    expect(brief).toContain('"eventName": "site_document_request"')
    expect(brief).toContain('"userAgentFamily": "browser"')
    expect(brief).toContain('"visit:" + clientIp + "|" + userAgent + "|" + floor(epochSeconds / 1800)')
    expect(brief).toContain('"doc:" + hex HMAC-SHA256(secret, visitKey + "|" + path + "|" + occurredAtMs)')
    expect(brief).toContain("`browser | automation | unknown`")
    expect(brief).toContain('"eventName": "sign_up"')
    expect(brief).toContain("`accountKey` is optional")
    expect(brief).toContain("event.waitUntil(fetch(...))")
    expect(brief).toContain("`ctx.waitUntil`")
    expect(brief).toContain("`context.waitUntil`")
    expect(brief).toContain("Timeout 2000 ms")
    expect(brief).toContain("**Skip.**")
    expect(brief).toContain("**Never send.**")
  })

  it("carries every reference implementation and the verify command", () => {
    expect(brief).toContain("```ts\n// Managed by Infinite. Public install artifacts only.")
    expect(brief).toContain("export default withInfiniteServerLane()")
    expect(brief).toContain("// server.mjs (Express)")
    expect(brief).toContain("// infinite-server-lane.mjs — generic Node helper")
    expect(brief).toContain("// worker.js (Cloudflare Workers)")
    expect(brief).toContain("// netlify/edge-functions/infinite-server-lane.js")
    expect(brief).toContain("crypto.subtle.importKey")
    expect(brief).toContain('createHmac("sha256", SECRET)')
    expect(brief).toContain("npx infinite-tag verify --server-lane https://<your-production-host>/")
    expect(brief).toContain(INFINITE_SERVER_LANE_RECEIPT_URL)
    expect(brief).toContain("## Done when")
    expect(brief).toContain("- [ ] ")
  })

  it("documents the relay as THE Meta path (PostHog or not), customer-hashed, payer-only, and never stored", () => {
    expect(brief).toContain(`### ${serverLaneCopy.adMatchHeading}`)
    // Gap 6 / P1-10: the relay is the default; PostHog's own Meta destination is the one turned off.
    expect(brief).toContain("for every site, with or without PostHog")
    expect(brief).toContain("turn that destination off for these events")
    expect(brief).not.toContain("do not use PostHog")
    expect(brief).not.toMatch(/(?<!with or )without PostHog/)
    expect(brief).toContain("Send outcomes to Meta Conversions API")
    // Match data needs the page's explicit signal.
    expect(brief).toContain("trackingAllowed: body.adMatch === true")
    expect(brief).toContain("never inferred from cookies")
    expect(brief).toContain("`fn`, `ln`, `ct`, `st`, `zp` and `country`")
    // P1-1: the name split, in words.
    expect(brief).toContain("the first word is `fn`, every later word together is `ln`")
    // P1-2: the payer, never the recipient; the address whole from one place.
    expect(brief).toContain("**The payer, never the recipient.**")
    expect(brief).toContain("the address WHOLE from one place")
    expect(brief).toContain("only when billing has no city and the shipping name is the payer's own")
    expect(brief).toContain("stripeCheckoutPayer(session)")
    expect(brief).not.toMatch(/customer_details\.address \?\? session\.(collected_information|shipping_details)/)
    expect(brief).toContain("Never store email/name/address anywhere new")
    expect(brief).toContain("never put them in Stripe metadata")
    expect(brief).toContain("never log them")
    expect(brief).toContain("never send a phone number")
    // ONE external_id rule: a stable per-person id shared by lead and purchase, then trimmed only.
    expect(brief).toContain("one stable per-person id shared by that person's lead and purchase")
    expect(brief).toContain("HMAC-SHA256(LEAD_ID_SECRET, email.trim().toLowerCase())")
    expect(brief).toContain("**trimmed only, its case kept**")
    expect(brief).not.toMatch(/external_id:\s*createHash[^\n]*\.toLowerCase\(\)/)
    expect(brief).toContain("personMatch(context.adMatch, await stripeCheckoutPayer(session))")
    expect(brief).toContain("discarded")
    expect(brief).toContain("A malformed hash is a 400")
    expect(brief).toContain("**`eventId` is Infinite's idempotency key, not Meta's event ID.**")
    expect(brief).toContain("Infinite derives a different id, which your pages never see")
    expect(brief).toContain("**Purchases are server events only.**")
    expect(brief).toContain("**Never build a Meta event ID in the page, and never fire a Meta conversion")
    expect(brief).not.toContain("Meta gets the same event_id")
    expect(brief).not.toContain("becomes Meta's `event_id`")
    expect(brief).not.toMatch(/eventID:\s*\\?"purchase:/)
    expect(brief).not.toMatch(/fbq\([^)]*\{\s*eventID/)
    // No undefined helper names in any recipe (review P2).
    for (const undefinedName of ["hmacSha256(", "saveCheckoutAdMatch(", "loadCheckoutAdMatch(", "checkoutAdMatchMetadata(", "productIdsForSession("]) {
      expect(brief).not.toContain(undefinedName)
    }
    // No new dependency in any recipe (review P2).
    expect(brief).not.toContain('import { waitUntil } from "@vercel/functions"')
    expect(brief).toContain("the IP address of the browser")
    expect(brief).toContain("server-to-server")
    expect(brief).toContain("adMatchFromRequest(request")
    expect(brief).toContain("a tampered cookie can never delete your purchase")
    expect(brief).toContain("declines rather than sending a broken one")
    expect(brief).toContain("7-day window")
    expect(brief).toContain("zero-decimal currencies")
    expect(brief).toContain("`adMatch` is OPTIONAL and outcome-only")
    expect(brief).toContain("Send it on every server conversion the visitor allowed tracking for, PostHog or not.")
    // P1-5: path is optional for Infinite, required for Meta, said plainly.
    expect(brief).toContain("`properties.path` is optional for Infinite: an outcome without one is recorded. It is required for Meta")
  })

  it("sets the SPA expectation, states DNT/GPC is honored, and shows the checkout→webhook carry", () => {
    // Task G: the SPA vs client-router-pageview expectation, and why it won't match PostHog.
    expect(brief).toContain("DOCUMENT REQUESTS")
    expect(brief).toContain("single-page app")
    expect(brief).toContain("$pageview")
    // Task C: DNT / Global-Privacy-Control are documented as honored.
    expect(brief).toContain("Do-Not-Track")
    expect(brief).toContain("Global-Privacy-Control")
    // Gap 7: the checkout → webhook carry (device data on the session's metadata, one field per value).
    expect(brief).toContain("const context = await buyerContext(req, { trackingAllowed })")
    expect(brief).toContain("metadata: { ...params.metadata, ...contextMetadata(context, { contentIds, numItems }) }")
    expect(brief).toContain("reportStripeCheckoutPurchase(event, { path: \"/success\" })")
    expect(brief).toContain("one metadata field each")
  })

  it("never contains a secret value or a raw-IP field", () => {
    expect(brief).not.toMatch(/INFINITE_SERVER_EVENT_SECRET\s*=\s*"[^<]/)
    expect(brief).not.toContain('"clientIp"')
    expect(brief).not.toContain('"ip":')
  })

  it("renders the per-status paragraph and the exact addition only where needed", () => {
    const created = renderServerLaneBrief({
      status: { kind: "created", middlewarePath: "middleware.ts", modulePath: "lib/infinite-server-lane.ts" }
    })
    expect(created).toContain("infinite-tag CREATED `middleware.ts` and `lib/infinite-server-lane.ts`")
    expect(created).not.toContain(`### ${serverLaneCopy.exactAdditionHeading}`)

    const manual = renderServerLaneBrief({ status: { kind: "next-manual", modulePath: "lib/infinite-server-lane.ts" } })
    expect(manual).toContain(`### ${serverLaneCopy.exactAdditionHeading}`)
    expect(manual).toContain("export default withInfiniteServerLane(middleware)")

    expect(brief).toContain('This project was detected as "Express"')
  })

  it("is deterministic for the same input (byte-idempotent re-runs)", () => {
    const again = renderServerLaneBrief({
      status: { kind: "other-stack", framework: "Express" },
      moduleImportPath: "./lib/infinite-server-lane"
    })
    expect(again).toBe(brief)
  })
})

// The published README carries the same Meta rules as the brief: one external_id rule, eventId is
// Infinite's idempotency key (never Meta's event ID), purchases are server-only, and the page never
// builds a Meta event ID. The README ships in the npm package, so it is what customers read first.
describe("the README's Meta advice", () => {
  it("matches the brief, and the old wrong advice is gone", async () => {
    const { readFileSync } = await import("node:fs")
    const { fileURLToPath } = await import("node:url")
    const readme = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8").replace(/\n\s*/g, " ")
    expect(readme).toContain("**`eventId` is Infinite's idempotency key, not Meta's event ID.**")
    expect(readme).toContain("**Purchases are server events only.**")
    expect(readme).toContain("trimmed only")
    expect(readme).toContain("Email and name come from `session.customer_details`")
    expect(readme).toContain("only when billing has no city and the shipping name is the payer's own")
    expect(readme).toContain("For leads, use the submitted email")
    expect(readme).toContain("with or without PostHog")
    expect(readme).not.toContain("do not use PostHog")
    expect(readme).toContain("Infinite records an outcome without one, but Meta needs it")
    expect(readme).toContain("Never store")
    expect(readme).toContain("never send")
    expect(readme).not.toContain("Meta gets the same event_id")
    expect(readme).not.toContain("becomes Meta's `event_id`")
    expect(readme).not.toMatch(/eventID:\s*"purchase:/)
    expect(readme).not.toMatch(/`em` and `external_id` are sha256 hex of the trimmed, lowercased/)
    expect(readme).not.toContain("hashed the same way\n")
  })
})

// Review fixes F1/F2/F5 on the Meta forwarding example. Every place this slice owns and a customer
// (or their agent) copies the recipe from: the brief in both languages and the README.
const README = readFileSync(fileURLToPath(new URL("../../README.md", import.meta.url)), "utf8")
const BRIEF_TS = renderServerLaneBrief({ status: { kind: "other-stack", framework: "Express" } })
const BRIEF_JS = renderServerLaneBrief({
  status: { kind: "other-stack", framework: "Express" },
  outcomeImportSpecifier: "../lib/infinite-outcome.js",
  outcomeLanguage: "js"
})

/** Every distinct `X` in `eventId: "purchase:" + X` — one purchase must be reported under one id. */
function purchaseEventIdSources(text: string): Set<string> {
  return new Set([...text.matchAll(/eventId:\s*\\?"purchase:\\?"\s*\+\s*([\w.]+)/g)].map((match) => match[1]!))
}

/**
 * Run the `external_id` line of a recipe as the customer's checkout route would: the line becomes
 * one entry of an object literal (comment and trailing comma removed), evaluated with a real
 * sha256 and the given `user`. Throws exactly where the customer's checkout would throw.
 */
function runExternalIdLine(line: string, user: unknown): Record<string, unknown> {
  const entry = line
    .replace(/^\s*\*?\s*/, "")
    .replace(/\s*\/\/.*$/, "")
    .replace(/,\s*$/, "")
  return runInNewContext(`({ ${entry} })`, { createHash, user }) as Record<string, unknown>
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex")

describe("the Meta forwarding example: one purchase, one eventId (review F1)", () => {
  it.each(Object.entries({ BRIEF_TS, BRIEF_JS, README }))("%s reports the purchase from the webhook only, under the session id", (_name, text) => {
    // The purchase is reported by the helper's webhook function, keyed on the session id; no hand-built id.
    expect(text).toContain("reportStripeCheckoutPurchase(event, { path: \"/success\" })")
    expect(purchaseEventIdSources(text).size).toBe(0)
    expect(text).not.toMatch(/eventId:\s*\\?"purchase:/)
  })

  it("negative: the old copy reported one purchase under two different ids", () => {
    const old = [
      'eventId: "purchase:" + session.id,  // stable: a retried webhook is counted once',
      'eventId: \\"purchase:\\" + order.id,   // Infinite\'s idempotency key'
    ].join("\n")
    expect([...purchaseEventIdSources(old)].sort()).toEqual(["order.id", "session.id"])
  })
})

describe("the external_id recipe is safe to paste into a route (review F2)", () => {
  it.each(Object.entries({ BRIEF_TS, BRIEF_JS, README }))("%s: lead-to-purchase external_id is one stable per-person id", (_name, text) => {
    expect(text).toContain("one stable per-person id shared by")
    expect(text).toContain("HMAC-SHA256(LEAD_ID_SECRET, email.trim().toLowerCase())")
    expect(text).toContain("infiniteLeadId(email)")
    expect(text).not.toMatch(/external_id:\s*createHash[^\n]*\.toLowerCase\(\)/)
  })

  it("negative: the old recipe line throws on a numeric id and on a guest", () => {
    const old = '  external_id: createHash("sha256").update(user.id.trim()).digest("hex")  // trimmed only: never lowercase an id'
    expect(runExternalIdLine(old, { id: "Acct_A" }).external_id).toBe(sha("Acct_A"))
    expect(() => runExternalIdLine(old, { id: 42 })).toThrow(/trim is not a function/)
    expect(() => runExternalIdLine(old, undefined)).toThrow(/Cannot read properties of undefined/)
  })
})

describe("the event-ID copy uses the app's own dedupe labels and the real reason (review F5)", () => {
  it.each(Object.entries({ BRIEF_TS, README }))("%s", (_name, text) => {
    const flat = text.replace(/\s+/g, " ")
    expect(flat).toContain("*Every event* or *Once per session* in Infinite → Conversions it is this value")
    expect(flat).toContain("for *Once per account*, and for *Once per visitor (TTL)* when the outcome carries a `visitKey`")
    expect(flat).toContain("The page never builds a Meta event ID, so a browser Purchase has no server event")
    // Negative: the old labels and the old (false for Every-event bindings) reason are gone.
    expect(flat).not.toContain("counted once per account or once per visit")
    expect(flat).not.toContain("cannot carry the id Meta received")
  })
})

// The plain installer keeps its decision boundary: `install --server-lane` still installs nothing and
// says so, while the wizard has its own strings for decision 5 and the reportInfiniteOutcome / mirror
// recipes. The hash pins the current public copy (the outcome helper API, the relay as the Meta path for every site).
describe("the plain installer's server-lane copy stays pinned", () => {
  function serialise(value: unknown): unknown {
    if (typeof value === "function") return "fn:" + value.toString()
    if (Array.isArray(value)) return value.map(serialise)
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, serialise(inner)]))
    }
    return value
  }

  // Re-pinned for P2-4: the "created" status no longer says "Nothing else to write" while conversions still need reporting.
  it("hashes to the pre-wizard value", () => {
    const text = JSON.stringify(serialise(serverLaneCopy))
    expect(createHash("sha256").update(text).digest("hex")).toBe(
      "6b0b7b925a3909e4c0ee36c990bba820d67fc655d68ac4b098fb4350631af74b"
    )
    expect(createHash("sha256").update(serverLaneCopy.status.targetPackages(["@vercel/functions"])).digest("hex")).toBe(
      "9b0fbf1256ca539e699938d069961dc145855359f994b43133afa58d89add7ec"
    )
  })

  it("negative: the wizard's npm line never leaks into install --server-lane output", () => {
    const brief = renderServerLaneBrief({
      status: {
        kind: "target",
        mode: "vercel-middleware",
        label: "Vercel",
        created: ["middleware.js", "lib/infinite-server-lane.js"],
        manual: [],
        installPackages: ["@vercel/functions"]
      }
    })
    expect(brief).toContain("infinite-tag never installs packages")
    const wizardLine = serverLaneWizardCopy.targetPackages(["@vercel/functions"])
    expect(wizardLine).toContain("The wizard installs it as its own plan line")
    expect(brief).not.toContain("as its own plan line")
    expect(brief).not.toContain(wizardLine)
    for (const recipe of [serverLaneWizardCopy.reportOutcomeRecipe(), serverLaneWizardCopy.webhookCaptureRecipe()]) {
      expect(brief).not.toContain(recipe[0]!)
    }
  })
})

describe("the wizard's recipes", () => {
  const report = serverLaneWizardCopy.reportOutcomeRecipe().join("\n")
  const webhook = serverLaneWizardCopy.webhookCaptureRecipe().join("\n")

  it("leads: one call after the row is stored, a stable per-person id, and a mirror only of the returned id", () => {
    expect(report).toContain("await reportInfiniteLead(req, {")
    expect(report).toContain("trackingAllowed: body.adMatch === true")
    expect(report).toContain("reportInfiniteOutcomeForMirror({")
    expect(report).toContain("eventId: personId ?? stableId")
    expect(report).toContain("infiniteMetaMirror(data.metaEventName, data.metaEventId)")
    expect(report).toContain("`lead:<id>`")
    expect(report).not.toMatch(/eventID:|fbq\(/)
  })

  it("visitor-facing routes never add a dependency; consented match data; the browser Meta guards", () => {
    expect(report).not.toContain("@vercel/functions")
    expect(webhook).not.toContain("@vercel/functions")
    expect(report).toContain("waits at most 800 ms")
    expect(report).toContain("LEAD_ID_SECRET")
    expect(report).toContain("never inferred from cookies")
    expect(report).toContain("400 ms")
    expect(report).toContain("disablePushState")
  })

  it("checkout saves the device data with the cart; the purchase comes from the webhook only, for the payer", () => {
    expect(webhook).toContain("const context = await buyerContext(req, { trackingAllowed })")
    expect(webhook).toContain("contextMetadata(context, { contentIds, numItems })")
    expect(webhook).toContain("await reportStripeCheckoutStarted(session, { path: \"/cart\" })")
    expect(webhook).toContain("export const config = { api: { bodyParser: false } }")
    expect(webhook).toContain("stripe.webhooks.constructEvent(await rawBody(req)")
    expect(webhook).toContain("reportStripeCheckoutPurchase(event, { path: \"/success\" })")
    expect(webhook).toContain("`checkout.session.completed` and `checkout.session.async_payment_succeeded`")
    expect(webhook).toContain("only live (`livemode`")
    expect(webhook).toContain("**The payer, never the recipient:**")
    expect(webhook).toContain("never send a phone number")
    expect(webhook).not.toMatch(/\bph\b|phone_number|infiniteMetaMirror\(/)
  })

  it("prints the retry rule and the commerce payload rules", () => {
    expect(webhook).toContain("answers 500 (so Stripe retries) only when the report was not delivered or Infinite answered 5xx, 401, 403 or 429")
    expect(webhook).toContain("Before Infinite is configured, and for every refusal a retry cannot fix, it answers 200")
    expect(webhook).toContain("zero-decimal currencies such as JPY and KRW are not divided")
    expect(webhook).toContain("capped at 120 characters by dropping whole ids")
    expect(webhook).toContain("begin_checkout")
  })

  it("speaks the JS helper's import specifier when the helper is .mjs", () => {
    expect(serverLaneWizardCopy.reportOutcomeRecipe("../lib/infinite-outcome.mjs", "js")[1]).toBe("```js")
    expect(serverLaneWizardCopy.reportOutcomeRecipe("../lib/infinite-outcome.mjs", "js").join("\n")).toContain(
      'from "../lib/infinite-outcome.mjs"'
    )
  })
})
