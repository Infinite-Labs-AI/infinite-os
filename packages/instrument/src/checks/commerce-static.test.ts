// Review r3 "static checks / prove": the commerce rules on small inline sites. Each rule gets the edit it passes
// and the edit it exists to catch, independent of the store fixture.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import type { CheckContext, CheckResult, ChecklistItem, JobId } from "../wizard/contracts/jobs.js"
import { JOB_TABLE } from "../wizard/contracts/jobs.js"
import type { EventInventory } from "./commerce-inventory.js"
import { promisesOf, readEventInventory } from "./commerce-inventory.js"
import {
  adMatchFindings,
  bodyView,
  canonicalEvent,
  clickPathFindings,
  codeAfterReturn,
  commerceFindings,
  deadCodeFindings,
  doubleCountFindings,
  leadFindings,
  leaveFindings,
  metaEventIdFindings,
  piiFindings,
  promiseFindings,
  sendsIn,
  signalFindings,
  signalReads,
  signalSends,
  valueFindings
} from "./commerce-static.js"
import { jobStaticCheckFunctions, type JobStaticCheckId, type JobStaticRunContext } from "./job-static.js"

const files = (entries: Record<string, string>) => new Map(Object.entries(entries))

/** A store whose Meta gets nothing but PageView: GA4 and PostHog get the funnel through the site's wrappers. */
const EVENTS_BEFORE = [
  'import { capturePosthog, sendGa } from "./tracking"',
  "export function addToCart(product) {",
  '  sendGa("add_to_cart", { items: [{ item_id: product.slug }] })',
  '  capturePosthog("product_added", { sku: product.slug })',
  "}",
  "export function purchase(sessionId) {",
  '  sendGa("purchase", { transaction_id: sessionId })',
  '  capturePosthog("purchase_completed", { session_id: sessionId })',
  "}",
  ""
].join("\n")

const INVENTORY: EventInventory = {
  rows: [
    {
      event: "add_to_cart",
      tools: {
        ga4: { state: "already_sent", evidence: [{ file: "src/events.ts", line: 3 }] },
        posthog: { state: "already_sent", siteEventName: "product_added", evidence: [{ file: "src/events.ts", line: 4 }] },
        meta: { state: "will_add", lane: "browser" },
        infinite: { state: "will_add", lane: "browser" }
      },
      sites: [{ file: "pages/index.tsx", line: 12 }]
    },
    {
      event: "purchase",
      tools: {
        ga4: { state: "already_sent", evidence: [{ file: "src/events.ts", line: 7 }] },
        posthog: { state: "already_sent", evidence: [{ file: "src/events.ts", line: 8 }] },
        meta: { state: "will_add", lane: "server" },
        infinite: { state: "will_add", lane: "server" }
      }
    }
  ]
}

describe("event names and sends", () => {
  it("canonicalEvent maps GA4, PostHog, Meta and site names to one event", () => {
    expect(canonicalEvent("AddToCart")).toBe("add_to_cart")
    expect(canonicalEvent("product_added")).toBe("add_to_cart")
    expect(canonicalEvent("ViewContent")).toBe("view_item")
    expect(canonicalEvent("InitiateCheckout")).toBe("begin_checkout")
    expect(canonicalEvent("checkout_started")).toBe("begin_checkout")
    expect(canonicalEvent("purchase_completed")).toBe("purchase")
    expect(canonicalEvent("generate_lead")).toBe("lead")
    expect(canonicalEvent("CompleteRegistration")).toBe("sign_up")
    expect(canonicalEvent("$pageview")).toBeNull()
    expect(canonicalEvent("PageView")).toBeNull()
  })

  it("sendsIn reads gtag, posthog.capture, fbq, the tag's helpers and the site's own wrappers; never comments or declarations", () => {
    const text = [
      "// gtag('event', 'purchase')",
      "export function sendGa(name, params) { ensureGtag()('event', name, params) }",
      "gtag('event', 'add_to_cart', {})",
      "ensureGtag()('event', 'begin_checkout', {})",
      "posthog.capture('product_viewed')",
      "window.fbq('track', 'AddToCart', {})",
      "fbq('trackSingle', '1116400780828774', 'ViewContent', {})",
      "sendGa('generate_lead', {})",
      "capturePosthog('mailing_list_joined', {})",
      "trackMetaEvent('ViewContent', {})",
      "infiniteTrack('add_to_cart', { item_id: 'a' }, { destinations: { ga4: false, posthog: false } })",
      "infiniteTrack('purchase')"
    ].join("\n")
    const got = sendsIn("src/a.ts", text).map((send) => `${send.tool}:${send.event}@${send.line}`)
    expect(got).toEqual(
      expect.arrayContaining([
        "ga4:add_to_cart@3",
        "ga4:begin_checkout@4",
        "posthog:view_item@5",
        "meta:add_to_cart@6",
        "meta:view_item@7",
        "ga4:lead@8",
        "posthog:lead@9",
        "meta:view_item@10",
        "infinite:add_to_cart@11",
        "meta:add_to_cart@11",
        "ga4:purchase@12",
        "posthog:purchase@12",
        "infinite:purchase@12"
      ])
    )
    expect(got).not.toContain("ga4:purchase@1")
    expect(got).not.toContain("ga4:add_to_cart@11")
    expect(got).not.toContain("posthog:add_to_cart@11")
    // A server-twin event never goes to Meta from infiniteTrack.
    expect(got).not.toContain("meta:purchase@12")
  })

  it("readEventInventory reads the scan's own shape: sites already sent, `missing` as this run's promises, Meta split by lane", () => {
    const scan = {
      events: [
        { event: "add_to_cart", sites: [{ file: "pages/index.tsx", line: 12, via: "helper:addToCart" }], tools: { ga4: [{ file: "src/events.ts", line: 3, via: "helper:sendGa" }], posthog: [{ file: "src/events.ts", line: 4, via: "helper:capturePosthog" }] }, missing: ["meta_browser"] },
        { event: "purchase", sites: [], tools: { ga4: [{ file: "src/events.ts", line: 7, via: "gtag" }] }, missing: ["posthog", "meta_server", "infinite"] }
      ],
      checkoutCreates: [],
      paymentWebhook: null,
      pixelRestrictedRoutes: ["/cart"]
    }
    const read = readEventInventory(scan)!
    const promises = promisesOf(read)
    expect(promises).toHaveLength(4)
    expect(promises).toEqual(
      expect.arrayContaining([
        { event: "add_to_cart", tool: "meta", lane: "browser" },
        { event: "purchase", tool: "meta", lane: "server" },
        { event: "purchase", tool: "posthog", lane: "browser" },
        { event: "purchase", tool: "infinite", lane: "server" }
      ])
    )
    expect(read.rows[0]!.tools.ga4).toMatchObject({ state: "already_sent", evidence: [{ file: "src/events.ts", line: 3 }] })
    // The trigger site keeps how it fires (P1-A reads it for the wait before a full page load).
    expect(read.rows[0]!.sites).toEqual([{ file: "pages/index.tsx", line: 12, via: "helper:addToCart" }])
  })

  it("readEventInventory keeps known rows and cells; promisesOf defaults Meta's server events to the server lane", () => {
    const read = readEventInventory({ rows: [{ event: "lead", tools: { meta: { state: "will_add" }, ga4: { state: "bogus" } } }, { event: "nope", tools: {} }] })
    expect(read?.rows).toHaveLength(1)
    expect(read?.rows[0]!.tools.ga4).toBeUndefined()
    expect(promisesOf(read!)).toEqual([{ event: "lead", tool: "meta", lane: "server" }])
    expect(readEventInventory(null)).toBeNull()
  })
})

describe("promises: the plan's event × tool cells have their code", () => {
  const before = { "src/events.ts": EVENTS_BEFORE }

  it("a run that left Meta with PageView only is caught: no AddToCart, no server purchase", () => {
    const findings = promiseFindings({ files: files(before), inventory: INVENTORY })!
    expect(findings.map((finding) => `${finding.tool}:${finding.event}`)).toEqual(["meta:add_to_cart", "infinite:add_to_cart", "meta:purchase", "infinite:purchase"])
    expect(findings[0]!.message).toMatch(/promised Meta AddToCart, but no code sends it/)
    expect(findings[0]!.message).toMatch(/pages\/index\.tsx:12/)
    expect(findings[2]!.message).toMatch(/no reportInfiniteOutcome\(\{ type: "purchase"/)
  })

  it("passes once Meta AddToCart is sent from the page and the purchase is reported from a server file", () => {
    const after = {
      "src/events.ts": EVENTS_BEFORE.replace('  sendGa("add_to_cart"', '  infiniteTrack("add_to_cart", { item_id: product.slug }, { destinations: { ga4: false, posthog: false } })\n  sendGa("add_to_cart"'),
      "pages/api/stripe-webhook.ts": 'await reportInfiniteOutcome({ type: "purchase", eventId: `purchase:${session.id}`, path: "/success", properties: { value, currency }, adMatch })\n'
    }
    expect(promiseFindings({ files: files(after), inventory: INVENTORY })).toEqual([])
  })

  it("a purchase reported from page code does not count as the server event", () => {
    const after = { "src/events.ts": EVENTS_BEFORE, "pages/success.tsx": 'reportInfiniteOutcome({ type: "purchase", eventId: id, path: "/success" })\n' }
    expect(promiseFindings({ files: files(after), inventory: INVENTORY }, "purchase")!.map((finding) => finding.tool)).toEqual(["meta", "infinite"])
  })

  it("is unknown without the plan's inventory, never a pass", () => {
    expect(promiseFindings({ files: files(before) })).toBeNull()
    expect(commerceFindings({ files: files(before) }).some((finding) => finding.rule === "promise_missing" && finding.state === "undetermined")).toBe(true)
  })
})

describe("outcomes: match data, value and currency", () => {
  const route = (call: string) => files({ "pages/api/checkout.ts": `export default async function handler(req, res) {\n  ${call}\n}\n` })

  it("a Meta-bound outcome without adMatch is a problem; with it, or for a non-Meta event, it passes", () => {
    const missing = adMatchFindings({ files: route('await reportInfiniteOutcome({ type: "begin_checkout", eventId: `begin_checkout:${session.id}`, path: "/cart" })') })
    expect(missing).toHaveLength(1)
    expect(missing[0]!.message).toMatch(/begin_checkout to Infinite without match data \(no adMatch\)/)
    expect(adMatchFindings({ files: route('await reportInfiniteOutcome({ type: "begin_checkout", eventId: id, path: "/cart", adMatch: buyer.adMatch })') })).toEqual([])
    expect(adMatchFindings({ files: route('await reportInfiniteOutcome({ type: "download", eventId: id, path: "/d" })') })).toEqual([])
    expect(adMatchFindings({ files: route('await reportInfiniteOutcome({ type: "purchase", eventId: id, path: "/s" })'), metaInUse: false })).toEqual([])
  })

  it("a purchase without value or currency is a problem naming what is missing; properties built elsewhere are unknown", () => {
    expect(valueFindings({ files: route('await reportInfiniteOutcome({ type: "purchase", eventId: id, path: "/s", properties: { value: total / 100, currency: "USD" } })') })).toEqual([])
    expect(valueFindings({ files: route('await reportInfiniteOutcome({ type: "purchase", eventId: id, path: "/s", value, currency })') })).toEqual([])
    const noCurrency = valueFindings({ files: route('await reportInfiniteOutcome({ type: "purchase", eventId: id, path: "/s", properties: { value } })') })
    expect(noCurrency).toHaveLength(1)
    expect(noCurrency[0]!.message).toMatch(/purchase without its currency/)
    expect(valueFindings({ files: route('await reportInfiniteOutcome({ type: "purchase", eventId: id, path: "/s" })') })[0]!.message).toMatch(/without its value or currency/)
    expect(valueFindings({ files: route('await reportInfiniteOutcome({ type: "purchase", eventId: id, path: "/s", properties: props })') })[0]!.state).toBe("undetermined")
    expect(valueFindings({ files: route('await reportInfiniteOutcome({ type: "lead", eventId: id, path: "/s" })') })).toEqual([])
  })
})

describe("double counting", () => {
  const base = files({ "src/events.ts": EVENTS_BEFORE })

  it("a new GA4 purchase beside the site's own is a double count; the message names both places", () => {
    const now = files({ "src/events.ts": EVENTS_BEFORE.replace('  sendGa("purchase"', '  gtag("event", "purchase", { transaction_id: sessionId })\n  sendGa("purchase"') })
    const findings = doubleCountFindings({ files: now, base })!
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ rule: "double_count", tool: "ga4", event: "purchase", file: "src/events.ts", line: 7 })
    expect(findings[0]!.message).toMatch(/already sends GA4 the purchase \(src\/events\.ts:8\)/)
  })

  it("infiniteTrack with GA4 and PostHog on counts twice in both; turning them off does not", () => {
    const defaulted = files({ "src/events.ts": EVENTS_BEFORE.replace('  sendGa("add_to_cart"', '  infiniteTrack("add_to_cart", { item_id: product.slug })\n  sendGa("add_to_cart"') })
    const findings = doubleCountFindings({ files: defaulted, base })!
    expect(findings.map((finding) => finding.tool)).toEqual(["ga4", "posthog"])
    expect(findings[0]!.message).toMatch(/destinations: \{ ga4: false \}/)
    const scoped = files({ "src/events.ts": EVENTS_BEFORE.replace('  sendGa("add_to_cart"', '  infiniteTrack("add_to_cart", { item_id: product.slug }, { destinations: { ga4: false, posthog: false } })\n  sendGa("add_to_cart"') })
    expect(doubleCountFindings({ files: scoped, base })).toEqual([])
  })

  it("the inventory's already-sent cells count even when the site's send is not readable in the files checked", () => {
    const now = files({ "pages/success.tsx": 'useEffect(() => { gtag("event", "purchase", { transaction_id: id }) }, [])\n' })
    const findings = doubleCountFindings({ files: now, base: files({ "pages/success.tsx": "useEffect(() => {}, [])\n" }), inventory: INVENTORY })!
    expect(findings.map((finding) => `${finding.tool}:${finding.event}`)).toEqual(["ga4:purchase"])
  })

  it("moving the site's own send is not a second send; an unreadable base is unknown", () => {
    const moved = files({ "src/events.ts": EVENTS_BEFORE.replace('  sendGa("purchase", { transaction_id: sessionId })\n', ""), "src/other.ts": 'sendGa("purchase", { transaction_id: id })\n' })
    expect(doubleCountFindings({ files: moved, base: files({ "src/events.ts": EVENTS_BEFORE, "src/other.ts": null as unknown as string }) })).toEqual([])
    expect(doubleCountFindings({ files: base })).toBeNull()
  })
})

describe("Meta event ids", () => {
  it("a page-made eventID on a browser Meta event is a problem; the server's id passes; the site's own old line is not the run's", () => {
    const built = metaEventIdFindings({ files: files({ "src/buy.ts": "fbq('track', 'AddToCart', {}, { eventID: 'atc-' + Date.now() })\n" }) })
    expect(built).toHaveLength(1)
    expect(built[0]!.state).toBe("problem")
    expect(metaEventIdFindings({ files: files({ "src/buy.ts": "fbq('track', 'Lead', {}, { eventID: res.metaEventId })\n" }) })).toEqual([])
    const old = "fbq('track', 'AddToCart', {}, { eventID: 'x' + id })\n"
    expect(metaEventIdFindings({ files: files({ "src/buy.ts": old }), base: files({ "src/buy.ts": old }) })).toEqual([])
  })
})

describe("personal data in outcomes and Stripe metadata (only what reaches the request body)", () => {
  const route = (body: string) => files({ "pages/api/lead.ts": `export default async function handler(req, res) {\n${body}\n}\n` })

  it("the review's false positive: email inside withPerson / adMatchFromRequest (digests only reach the body) passes", () => {
    expect(piiFindings({ files: route('  await reportInfiniteOutcome({ type: "lead", eventId: id, path: "/l", adMatch: withPerson(buyer.adMatch, { email: cleanEmail, externalId: id }) })') })).toEqual([])
    expect(piiFindings({ files: route('  await reportInfiniteOutcome({ type: "lead", eventId: id, path: "/l", adMatch: await adMatchFromRequest(req, { trackingAllowed, email, fullName, city }) })') })).toEqual([])
    expect(piiFindings({ files: route('  await reportInfiniteOutcome({ type: "purchase", eventId: id, path: "/s", properties: { content_name: product.name, value, currency } })') })).toEqual([])
  })

  it("a raw email, name or address in the body, an unhashed match key, or a phone anywhere is a problem", () => {
    for (const body of [
      '  await reportInfiniteOutcome({ type: "lead", eventId: id, path: "/l", properties: { email: cleanEmail } })',
      '  await reportInfiniteOutcome({ type: "lead", eventId: id, path: "/l", accountKey: email })',
      '  await reportInfiniteOutcome({ type: "lead", eventId: id, path: "/l", properties: { buyer: session.customer_details.name } })',
      '  await reportInfiniteOutcome({ type: "lead", eventId: id, path: "/l", adMatch: { em: email } })',
      '  await reportInfiniteOutcome({ type: "lead", eventId: id, path: "/l", adMatch: { em: sha256(email), fn: firstName } })',
      '  await reportInfiniteOutcome({ type: "lead", eventId: id, path: "/l", adMatch: await adMatchFromRequest(req, { email, phone }) })',
      '  await reportInfiniteOutcome({ type: "lead", eventId: id, path: "/l", adMatch: { ph: digest } })'
    ]) {
      const findings = piiFindings({ files: route(body) })
      expect(findings.length, body).toBe(1)
      expect(findings[0]!.rule).toBe("pii_in_outcome")
    }
    expect(piiFindings({ files: route('  await reportInfiniteOutcome({ type: "lead", eventId: id, path: "/l", adMatch: await adMatchFromRequest(req, { phone }) })') })[0]!.message).toMatch(/phone number.*never sent/)
  })

  it("Stripe metadata: ids and the consented context pass; a raw email or a phone is a problem", () => {
    const checkout = (metadata: string) => files({ "pages/api/checkout.ts": `const session = await stripe.checkout.sessions.create({\n  mode: "payment",\n  customer_email: email,\n  metadata: ${metadata},\n})\n` })
    expect(piiFindings({ files: checkout('{ skus: lines.map((l) => l.slug).join(","), ...(infiniteConfigured() ? contextMetadata(buyer) : {}) }') })).toEqual([])
    const email = piiFindings({ files: checkout("{ skus, email: req.body.email }") })
    expect(email).toHaveLength(1)
    expect(email[0]).toMatchObject({ rule: "pii_in_stripe_metadata", file: "pages/api/checkout.ts", line: 4 })
    expect(piiFindings({ files: checkout("{ skus, contact: customer.phone }") })[0]!.message).toMatch(/phone/)
  })

  it("bodyView blanks a nested call's arguments and keeps object literals", () => {
    expect(bodyView("{ a: f({ email }), b: { email: x } }")).toBe("{ a: f(         ), b: { email: x } }")
  })
})

// ---- the registered checks (one result each; what the job notes and the reviewer read) ----

const RUN = "7f3c2a91-b0de-4c55-9a11-23456789abcd"
const ctx: CheckContext = { runId: RUN, now: () => new Date("2026-10-08T10:00:00.000Z") }
const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function site(entries: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "commerce-static-"))
  roots.push(root)
  for (const [path, text] of Object.entries(entries)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}

function item(jobId: JobId, target: string, paths: string[]): ChecklistItem {
  return { id: `${jobId}:${target}`, jobId, n: JOB_TABLE[jobId].n, title: "t", owner: "agent", trigger: { finding: "f", evidence: [] }, allow: { files: paths, create: [] }, checks: [], state: "claimed" }
}

async function check(id: JobStaticCheckId, entries: Record<string, string>, jobItem: ChecklistItem, run: JobStaticRunContext = {}, base?: Record<string, string | null>): Promise<CheckResult> {
  const root = site(entries)
  const fns = jobStaticCheckFunctions({ run: () => run, readBaseFile: (_root, file) => (base ? (base[file] ?? null) : undefined) })
  const raw = await fns[id]({ item: jobItem, root, appRoot: ".", runId: RUN }, ctx)
  const results = Array.isArray(raw) ? raw : [raw]
  expect(results).toHaveLength(1)
  return results[0]!
}

describe("registered checks", () => {
  const WEBHOOK = "pages/api/stripe-webhook.ts"
  const job8 = item("server_conversions", "purchase", [WEBHOOK])

  it("job 8 carries the match-data and money checks; job 10 the double-count and Meta event-id checks", () => {
    const ids = (jobId: JobId) => JOB_TABLE[jobId].checks.map((spec) => `${spec.tier}:${spec.checkId}`)
    expect(ids("server_conversions")).toEqual(expect.arrayContaining(["S:outcome_ad_match", "S:outcome_value_currency", "S:no_pii_in_outcome"]))
    expect(ids("conversions_to_tools")).toEqual(expect.arrayContaining(["S:no_double_count", "S:meta_event_id_from_server"]))
  })

  it("outcome_ad_match / outcome_value_currency: problem on the bare purchase, pass on the full one", async () => {
    const bare = { [WEBHOOK]: 'await reportInfiniteOutcome({ type: "purchase", eventId: `purchase:${session.id}`, path: "/success" })\n' }
    const full = { [WEBHOOK]: 'await reportInfiniteOutcome({ type: "purchase", eventId: `purchase:${session.id}`, path: "/success", properties: { value: session.amount_total / 100, currency: session.currency.toUpperCase() }, adMatch: matchFromSession(session) })\n' }
    expect((await check("outcome_ad_match", bare, job8)).state).toBe("problem")
    expect((await check("outcome_value_currency", bare, job8)).state).toBe("problem")
    expect((await check("outcome_ad_match", full, job8)).state).toBe("pass")
    expect((await check("outcome_value_currency", full, job8)).state).toBe("pass")
    expect((await check("outcome_ad_match", bare, job8, { metaInUse: false })).state).toBe("pass")
  })

  it("no_pii_in_outcome: the nested withPerson({ email }) passes; Stripe metadata with an email fails", async () => {
    const lead = item("server_conversions", "lead", ["pages/api/mailing-list.ts"])
    const ok = 'await reportInfiniteOutcome({ type: "lead", eventId: `lead:${id}`, path: "/mailing-list", adMatch: withPerson(buyer.adMatch, { email: cleanEmail, externalId: id }) })\n'
    expect((await check("no_pii_in_outcome", { "pages/api/mailing-list.ts": ok }, lead)).state).toBe("pass")
    const leak = ok + "await stripe.checkout.sessions.create({ metadata: { email: cleanEmail } })\n"
    const result = await check("no_pii_in_outcome", { "pages/api/mailing-list.ts": leak }, lead)
    expect(result.state).toBe("problem")
    expect(result.reason).toMatch(/Stripe metadata/)
  })

  it("no_double_count reads the code before the run; meta_event_id_from_server flags a page-made id", async () => {
    const job10 = item("conversions_to_tools", "purchase", ["src/events.ts"])
    const doubled = { "src/events.ts": EVENTS_BEFORE.replace('  sendGa("purchase"', '  gtag("event", "purchase", {})\n  sendGa("purchase"') }
    const result = await check("no_double_count", doubled, job10, {}, { "src/events.ts": EVENTS_BEFORE })
    expect(result.state).toBe("problem")
    expect(result.reason).toMatch(/count twice in GA4/)
    expect((await check("no_double_count", doubled, job10)).state).toBe("undetermined")
    expect((await check("no_double_count", { "src/events.ts": EVENTS_BEFORE }, job10, {}, { "src/events.ts": EVENTS_BEFORE })).state).toBe("pass")
    const built = { "src/events.ts": "fbq('track', 'AddToCart', {}, { eventID: `atc-${id}` })\n" }
    expect((await check("meta_event_id_from_server", built, job10, {}, { "src/events.ts": "" })).state).toBe("problem")
  })

  it("commerce_promises_met reads the whole app against the inventory; unknown without it", async () => {
    const job10 = item("conversions_to_tools", "add_to_cart", ["src/events.ts"])
    const before = { "src/events.ts": EVENTS_BEFORE }
    expect((await check("commerce_promises_met", before, job10)).state).toBe("undetermined")
    const missing = await check("commerce_promises_met", before, job10, { eventInventory: INVENTORY })
    expect(missing.state).toBe("problem")
    expect(missing.reason).toMatch(/Meta AddToCart/)
    const fixed = { "src/events.ts": EVENTS_BEFORE.replace("export function addToCart(product) {", 'export function addToCart(product) {\n  infiniteTrack("add_to_cart", { item_id: product.slug }, { destinations: { ga4: false, posthog: false } })') }
    expect((await check("commerce_promises_met", fixed, job10, { eventInventory: INVENTORY })).state).toBe("pass")
  })
})

describe("the outcome helper's own reporters (lib/infinite-outcome)", () => {
  const WEBHOOK = "pages/api/stripe-webhook.ts"
  const CHECKOUT = "pages/api/checkout.ts"
  const LEAD = "pages/api/mailing-list.ts"
  const webhook = 'import { reportStripeCheckoutPurchase } from "../../lib/infinite-outcome"\nexport default async function handler(req, res) {\n  return res.status(await reportStripeCheckoutPurchase(event, { path: "/success" })).end()\n}\n'
  const checkout = 'import { reportStripeCheckoutStarted } from "../../lib/infinite-outcome"\nexport default async function handler(req, res) {\n  await reportStripeCheckoutStarted(session, { path: "/cart" })\n}\n'
  const lead = 'import { reportInfiniteLead } from "../../lib/infinite-outcome"\nexport default async function handler(req, res) {\n  await reportInfiniteLead(req, { email, trackingAllowed: body.adMatch === true, fallbackPath: "/mailing-list", fallbackId: id })\n}\n'

  it("reportStripeCheckoutPurchase / reportStripeCheckoutStarted / reportInfiniteLead are the purchase, begin_checkout and lead, with value, currency and match data inside", () => {
    const all = files({ [WEBHOOK]: webhook, [CHECKOUT]: checkout, [LEAD]: lead })
    const inventory: EventInventory = { rows: ["purchase", "begin_checkout", "lead"].map((event) => ({ event: event as "purchase", tools: { meta: { state: "will_add" as const, lane: "server" as const }, infinite: { state: "will_add" as const, lane: "server" as const } } })) }
    expect(promiseFindings({ files: all, inventory })).toEqual([])
    expect(adMatchFindings({ files: all })).toEqual([])
    expect(valueFindings({ files: all })).toEqual([])
    // The lead's email is an input the helper hashes, never a personal detail in the body.
    expect(piiFindings({ files: all })).toEqual([])
    // Its properties ARE sent: an email there is a leak; a phone anywhere in the call is one too.
    expect(piiFindings({ files: files({ [LEAD]: lead.replace("fallbackId: id", "fallbackId: id, properties: { email: user.email }") }) })).toHaveLength(1)
    expect(piiFindings({ files: files({ [LEAD]: lead.replace("fallbackId: id", "fallbackId: id, phone: user.phone") }) })[0]!.message).toMatch(/phone number/)
  })

  it("job 8's checks recognise them: outcome_declared grades only this job's conversion, event_id_stable trusts their own ids", async () => {
    const purchase = item("server_conversions", "purchase", [CHECKOUT, WEBHOOK])
    const both = { [CHECKOUT]: checkout, [WEBHOOK]: webhook }
    const run = { conversionNames: ["purchase", "begin_checkout"] }
    expect((await check("outcome_declared", both, purchase, run)).state).toBe("pass")
    expect((await check("event_id_stable", both, purchase, run)).state).toBe("pass")
    expect((await check("no_pii_in_outcome", both, purchase, run)).state).toBe("pass")
    expect((await check("outcome_ad_match", both, purchase, run)).state).toBe("pass")
    expect((await check("outcome_value_currency", both, purchase, run)).state).toBe("pass")
    // Another conversion's report under a name nobody approved is still a problem.
    const stray = { [CHECKOUT]: checkout.replace('{ path: "/cart" }', '{ path: "/cart", type: "checkout_begun" }'), [WEBHOOK]: webhook }
    expect((await check("outcome_declared", stray, purchase, run)).reason).toMatch(/"checkout_begun", which is not an approved conversion name/)
    // A job with none of them is still told its report is missing.
    expect((await check("outcome_declared", { [CHECKOUT]: "export default function handler() {}\n" }, purchase, run)).reason).toMatch(/no report to Infinite/)
  })

  it("infiniteTrack with a destinations list sends to exactly those tools", () => {
    const text = 'infiniteTrack("add_to_cart", { item_id: "a" }, { destinations: ["meta"] })\n'
    expect(sendsIn("src/events.ts", text).map((send) => send.tool)).toEqual(["meta"])
    const both = 'infiniteTrack("add_to_cart", { item_id: "a" }, { destinations: ["meta", "posthog"] })\n'
    expect(sendsIn("src/events.ts", both).map((send) => send.tool).sort()).toEqual(["meta", "posthog"])
  })
})

describe("P1-A: one click, one send; a full page load waits", () => {
  const helper = [
    'import { infiniteTrack, infiniteTrackBeforeLeaving } from "../lib/infinite-analytics"',
    "export function addToCart(p) {",
    '  sendGa("add_to_cart", { id: p.id })',
    '  return infiniteTrackBeforeLeaving("add_to_cart", { item_id: p.id, price: p.price }, { destinations: ["meta", "infinite"] })',
    "}",
    "export function addBundle(p) {",
    '  infiniteTrack("add_to_cart", { item_id: p.id, price: p.price }, { destinations: ["meta", "infinite"] })',
    "}",
    ""
  ].join("\n")
  const page = (body: string) => ['import { addToCart, addBundle } from "../src/events"', "export default function Page({ p }) {", `  const buy = () => {\n${body}\n  }`, "  return null", "}", ""].join("\n")

  it("the helper's send plus a send in the handler, or two helpers that both send, is one click counted twice; one helper is fine", () => {
    const twice = clickPathFindings({ files: files({ "src/events.ts": helper, "pages/a.tsx": page('    addToCart(p)\n    infiniteTrack("add_to_cart", { item_id: p.id }, { destinations: ["meta"] })') }) })
    expect(twice.map((finding) => [finding.rule, finding.tool, finding.event, finding.file])).toEqual([["sent_twice_on_one_click", "meta", "add_to_cart", "pages/a.tsx"]])
    const two = clickPathFindings({ files: files({ "src/events.ts": helper, "pages/a.tsx": page("    addToCart(p)\n    addBundle(p)") }) })
    expect(two.map((finding) => finding.rule)).toEqual(["sent_twice_on_one_click"])
    expect(two[0]!.message).toContain("through addToCart()")
    expect(two[0]!.message).toContain("through addBundle()")
    expect(clickPathFindings({ files: files({ "src/events.ts": helper, "pages/a.tsx": page("    addToCart(p)\n    window.location.assign(\"/cart\")") }) })).toEqual([])
    // Two separate buttons, each sending once, are two clicks.
    const buttons = ['import { addToCart } from "../src/events"', "export default function Page({ p }) {", '  const one = () => addToCart(p)', '  const two = () => infiniteTrack("add_to_cart", { item_id: p.id }, { destinations: ["meta"] })', "  return null", "}", ""].join("\n")
    expect(clickPathFindings({ files: files({ "src/events.ts": helper, "pages/b.tsx": buttons }) })).toEqual([])
  })

  it("a click the scan saw leave with a full page load must wait: infiniteLeaveAfter, await or .then pass; leaving at once does not", () => {
    const inventory: EventInventory = { rows: [{ event: "add_to_cart", tools: { meta: { state: "will_add", lane: "browser" } }, sites: [{ file: "pages/a.tsx", line: 4, via: "helper:addToCart", navigation: "full_load", helperAt: { file: "src/events.ts", line: 2 } }] }] }
    const leave = (body: string) => leaveFindings({ files: files({ "src/events.ts": helper, "pages/a.tsx": page(body) }), inventory })
    expect(leave("    addToCart(p)\n    window.location.assign(\"/cart\")").map((finding) => finding.rule)).toEqual(["lost_before_leaving"])
    expect(leave("    infiniteLeaveAfter(() => addToCart(p), () => window.location.assign(\"/cart\"))")).toEqual([])
    expect(leave("    void addToCart(p).then(() => window.location.assign(\"/cart\"))")).toEqual([])
    // The helper must return the wait, not a plain infiniteTrack.
    const plain = helper.replace('return infiniteTrackBeforeLeaving("add_to_cart"', 'infiniteTrack("add_to_cart"')
    const found = leaveFindings({ files: files({ "src/events.ts": plain, "pages/a.tsx": page("    infiniteLeaveAfter(() => addToCart(p), () => window.location.assign(\"/cart\"))") }), inventory })
    expect(found.map((finding) => [finding.rule, finding.file])).toEqual([["lost_before_leaving", "src/events.ts"]])
    expect(found[0]!.message).toMatch(/^addToCart\(\) sends Meta AddToCart with nothing to wait on/)
  })

  it("P2-7: a lead with no fallbackId is a problem; with one it passes; unreadable options are unknown", () => {
    const route = (options: string) => `import { reportInfiniteLead } from "../../lib/infinite-outcome"\nexport default async function handler(req, res) {\n  await reportInfiniteLead(req, ${options})\n}\n`
    expect(leadFindings({ files: files({ "pages/api/join.ts": route("{ email, trackingAllowed: true }") }) }).map((finding) => finding.state)).toEqual(["problem"])
    expect(leadFindings({ files: files({ "pages/api/join.ts": route("{ email, trackingAllowed: true, fallbackId: row.id }") }) })).toEqual([])
    expect(leadFindings({ files: files({ "pages/api/join.ts": route("options") }) }).map((finding) => finding.state)).toEqual(["undetermined"])
  })
})

describe("Finding 1: the page's tracking signal reaches the route's read", () => {
  const inventory: EventInventory = {
    rows: [{ event: "lead", tools: { meta: { state: "will_add", lane: "server" } }, sites: [{ file: "pages/api/join.ts", line: 3, via: "form-api" }, { file: "pages/join.tsx", line: 5, via: "helper:generateLead" }] }],
    pageRequests: [{ route: "pages/api/join.ts", file: "pages/join.tsx", line: 5, how: "json" }],
    trackingSignal: { kind: "site_getter", expression: "trackingAllowed()", name: "trackingAllowed" }
  }
  const route = (read: string) => `import { reportInfiniteLead } from "../../lib/infinite-outcome"\nexport default async function handler(req, res) {\n  await reportInfiniteLead(req, { email: req.body.email, trackingAllowed: ${read}, fallbackId: "x" })\n}\n`
  const page = (body: string) => `import { trackingAllowed } from "../src/consent"\nexport default function Join() {\n  const submit = () =>\n    fetch("/api/join", {\n      body: JSON.stringify(${body}) })\n  return null\n}\n`
  const check = (read: string, body: string) => signalFindings({ files: files({ "pages/api/join.ts": route(read), "pages/join.tsx": page(body) }), inventory })

  it("passes when the page sends adMatch from the site's reader in the JSON body and the route reads req.body.adMatch", () => {
    expect(check("req.body?.adMatch === true", "{ email, adMatch: trackingAllowed() }")).toEqual([])
  })

  it("a page that sends nothing, a read from the URL, another key, or a value not built from the reader is a problem", () => {
    expect(check("req.body?.adMatch === true", "{ email }").map((finding) => finding.message)).toEqual([expect.stringMatching(/^pages\/join\.tsx:5 sends its request to pages\/api\/join\.ts with no tracking signal, so the lead reaches Meta with no match data\. Add adMatch: <the signal> in its JSON body/)])
    expect(check('req.query.ad_match === "1"', "{ email, adMatch: trackingAllowed() }").map((finding) => finding.message)).toEqual([expect.stringMatching(/sends the tracking signal as adMatch in the request body, but pages\/api\/join\.ts:3 reads ad_match from the URL/)])
    expect(check("req.body?.ad_match === true", "{ email, adMatch: trackingAllowed() }")).toHaveLength(1)
    expect(check("req.body?.adMatch === true", "{ email, adMatch: true }").map((finding) => finding.message)).toEqual([expect.stringMatching(/sends adMatch, but not from the site's tracking signal \(trackingAllowed\(\)\)/)])
    // Meta not in use: nothing to carry.
    expect(signalFindings({ files: files({ "pages/api/join.ts": route("false"), "pages/join.tsx": page("{ email }") }), inventory, metaInUse: false })).toEqual([])
  })

  it("reads sends and reads by place: a posted form's field and a JSON key are the body, a URL parameter is the URL", () => {
    expect(signalSends('<form method="post" action="/api/x"><input type="hidden" name="ad_match" value="1" /></form>').map((use) => [use.key, use.place])).toEqual([["ad_match", "body"]])
    expect(signalSends('<form action="/api/x"><input name="ad_match" /></form>').map((use) => use.place)).toEqual(["query"])
    expect(signalSends('fetch(`/api/x?ad_match=1`)').map((use) => use.place)).toEqual(["query"])
    expect(signalSends("const ok = body.adMatch").map((use) => use.place)).toEqual([])
    expect(signalReads('const a = new URL(request.url).searchParams.get("ad_match") === "1"').map((use) => use.place)).toEqual(["query"])
    expect(signalReads('const a = form.get("ad_match") === "1"').map((use) => use.place)).toEqual(["body"])
    expect(signalReads("const { adMatch } = req.body").map((use) => [use.key, use.place])).toEqual([["adMatch", "body"]])
  })
})

describe("Finding 3: code after a return in a function the run changed", () => {
  const before = 'export function addToCart(p) {\n  sendGa("add_to_cart", { id: p.id })\n  capturePosthog("product_added", { id: p.id })\n}\n'
  const dead = (now: string) => deadCodeFindings({ files: files({ "src/events.ts": now }), base: new Map([["src/events.ts", before]]) })

  it("the wait returned as the helper's first line drops its own sends below it: a problem naming the first dead line", () => {
    const first = 'export function addToCart(p) {\n  return infiniteTrackBeforeLeaving("add_to_cart", { item_id: p.id }, { destinations: ["meta"] })\n  sendGa("add_to_cart", { id: p.id })\n  capturePosthog("product_added", { id: p.id })\n}\n'
    expect(dead(first).map((finding) => [finding.rule, finding.line])).toEqual([["code_after_return", 3]])
    expect(dead(first)[0]!.message).toMatch(/^src\/events\.ts:3 never runs: addToCart\(\) returns before it/)
  })

  it("const wait first and return wait last, the return at the end, a guard clause, a nested return and a hoisted function all pass", () => {
    expect(dead('export function addToCart(p) {\n  const wait = infiniteTrackBeforeLeaving("add_to_cart", { item_id: p.id }, { destinations: ["meta"] })\n  sendGa("add_to_cart", { id: p.id })\n  capturePosthog("product_added", { id: p.id })\n  return wait\n}\n')).toEqual([])
    expect(dead('export function addToCart(p) {\n  if (!p) return\n  sendGa("add_to_cart", { id: p.id })\n  return infiniteTrackBeforeLeaving("add_to_cart", {\n    item_id: p.id\n  })\n}\n')).toEqual([])
    expect(dead('export function addToCart(p) {\n  if (p.gift) { return }\n  sendGa("add_to_cart", { id: p.id })\n  return helper()\n  function helper() { return 1 }\n}\n')).toEqual([])
    // A function the run did not change is not read (only its layout moved).
    expect(deadCodeFindings({ files: files({ "src/a.ts": "function f() {\n  return 1\n  g()\n}\n" }), base: new Map([["src/a.ts", "function f() {  return 1\n g() }\n"]]) })).toEqual([])
  })

  it("codeAfterReturn follows a statement over its line breaks", () => {
    const text = "{\n  return a\n    .then(go)\n}"
    expect(codeAfterReturn(text, 1, text.length - 1)).toBeNull()
    const two = "{\n  return a\n  go()\n}"
    expect(codeAfterReturn(two, 1, two.length - 1)).toBe(two.indexOf("go()"))
  })
})

describe("Finding 2: sends_before_leaving proves the wait reaches the navigation", () => {
  const helper = (body: string) => ['import { infiniteTrackBeforeLeaving } from "../lib/infinite-analytics"', "export function addToCart(p) {", body, "}", ""].join("\n")
  const RETURNED = '  const wait = infiniteTrackBeforeLeaving("add_to_cart", { item_id: p.id }, { destinations: ["meta", "infinite"] })\n  sendGa("add_to_cart", { id: p.id })\n  return wait'
  const page = (body: string) => ['import { addToCart } from "../src/events"', 'import { infiniteLeaveAfter, infiniteTrackBeforeLeaving } from "../lib/infinite-analytics"', "export default function Page({ p }) {", "  const buy = () => {", body, "  }", "  return null", "}", ""].join("\n")
  const inventory: EventInventory = { rows: [{ event: "add_to_cart", tools: { meta: { state: "will_add", lane: "browser" } }, sites: [{ file: "pages/a.tsx", line: 5, via: "helper:addToCart", navigation: "full_load", helperAt: { file: "src/events.ts", line: 2 } }] }] }
  const check = (events: string, body: string) => {
    const input = { files: files({ "src/events.ts": events, "pages/a.tsx": page(body) }), inventory }
    return [...clickPathFindings(input), ...leaveFindings(input)].map((finding) => `${finding.rule}@${finding.file}`)
  }

  it("the reference fix's shape passes: the helper returns its wait, start returns the helper's call, go navigates", () => {
    expect(check(helper(RETURNED), '    infiniteLeaveAfter(() => {\n      cart.add(p)\n      return addToCart(p)\n    }, () => window.location.assign("/cart"))')).toEqual([])
    expect(check(helper(RETURNED), '    void addToCart(p).then(() => window.location.assign("/cart"))')).toEqual([])
    expect(check(helper(RETURNED), '    infiniteLeaveAfter(() => addToCart(p), () => router.push("/cart"))')).toEqual([])
  })

  it("start without return: go runs at once, nothing waits", () => {
    expect(check(helper(RETURNED), '    infiniteLeaveAfter(() => {\n      cart.add(p)\n      addToCart(p)\n    }, () => window.location.assign("/cart"))')).toEqual(["lost_before_leaving@pages/a.tsx"])
  })

  it("the helper starts the wait but does not return it (void infiniteTrackBeforeLeaving)", () => {
    const found = leaveFindings({ files: files({ "src/events.ts": helper('  void infiniteTrackBeforeLeaving("add_to_cart", { item_id: p.id }, { destinations: ["meta"] })'), "pages/a.tsx": page('    infiniteLeaveAfter(() => addToCart(p), () => window.location.assign("/cart"))') }), inventory })
    expect(found.map((finding) => finding.message)).toEqual([expect.stringMatching(/^addToCart\(\) starts the wait for Meta AddToCart but does not return it/)])
  })

  it("P3: a local variable named location is not a navigation after an await", () => {
    expect(check(helper(RETURNED), '    await addToCart(p)\n    window.location.assign("/cart")')).toEqual([])
    expect(check(helper(RETURNED), '    await addToCart(p)\n    const location = "eu"')).toEqual(["lost_before_leaving@pages/a.tsx"])
  })

  it(".then without the navigation in it, and a go that does nothing, fail", () => {
    expect(check(helper(RETURNED), '    void addToCart(p).then(() => undefined)\n    window.location.assign("/cart")')).toEqual(["lost_before_leaving@pages/a.tsx"])
    expect(check(helper(RETURNED), "    infiniteLeaveAfter(() => addToCart(p), () => {})")).toEqual(["lost_before_leaving@pages/a.tsx"])
  })

  it("a second send in a nested infiniteLeaveAfter beside the helper call is one click counted twice (grouped by the outermost handler)", () => {
    expect(check(helper(RETURNED), '    addToCart(p)\n    infiniteLeaveAfter(() => infiniteTrackBeforeLeaving("add_to_cart", { item_id: p.id }, { destinations: ["meta"] }), () => router.push("/cart"))')).toEqual(["sent_twice_on_one_click@pages/a.tsx", "lost_before_leaving@pages/a.tsx"])
  })
})

describe("Finding 4: a link or a form that leaves by itself must cancel that before it waits", () => {
  const helper = 'export function addToCart(p) {\n  const wait = infiniteTrackBeforeLeaving("add_to_cart", { item_id: p.id }, { destinations: ["meta"] })\n  return wait\n}\n'
  const page = (handler: string) => `import { addToCart } from "../src/events"\nexport default function Page({ p }) {\n  const buy = ${handler}\n  return <a href="/cart" onClick={buy}>Buy</a>\n}\n`
  const inventory: EventInventory = { rows: [{ event: "add_to_cart", tools: { meta: { state: "will_add", lane: "browser" } }, sites: [{ file: "pages/a.tsx", line: 3, via: "helper:addToCart", navigation: "full_load", leavesBy: "link", helperAt: { file: "src/events.ts", line: 1 } }] }] }
  const leave = (handler: string) => leaveFindings({ files: files({ "src/events.ts": helper, "pages/a.tsx": page(handler) }), inventory })

  it("preventDefault and a go that leaves pass; a literal empty go, or no preventDefault, fail", () => {
    expect(leave('(e) => {\n    e.preventDefault()\n    infiniteLeaveAfter(() => addToCart(p), () => window.location.assign("/cart"))\n  }')).toEqual([])
    expect(leave("(e) => {\n    infiniteLeaveAfter(() => addToCart(p), () => {})\n  }").map((finding) => finding.rule)).toEqual(["lost_before_leaving"])
    const found = leave('(e) => {\n    infiniteLeaveAfter(() => addToCart(p), () => window.location.assign("/cart"))\n  }')
    expect(found.map((finding) => finding.message)).toEqual([expect.stringMatching(/its click is on a plain link or a form that leaves by itself, so the page unloads before the wait ends\. Call event\.preventDefault\(\) first/)])
  })
})

describe("Finding 6: lost_before_leaving answers per caller, not per file", () => {
  const helper = 'export function addToCart(p) {\n  const wait = infiniteTrackBeforeLeaving("add_to_cart", { item_id: p.id }, { destinations: ["meta"] })\n  return wait\n}\n'
  const before = [
    'import { addToCart } from "../src/events"',
    "export default function Page({ p }) {",
    "  const buy = () => {",
    "    addToCart(p)",
    '    router.push("/cart")',
    "  }",
    "  const buyNow = () => {",
    "    addToCart(p)",
    '    window.location.assign("/checkout")',
    "  }",
    "  return null",
    "}",
    ""
  ].join("\n")
  // The scan read the file before the run: the client caller at line 4, the full-load caller at line 8.
  const inventory: EventInventory = {
    rows: [{
      event: "add_to_cart",
      tools: { meta: { state: "will_add", lane: "browser" } },
      sites: [
        { file: "pages/a.tsx", line: 4, via: "helper:addToCart", navigation: "client", helperAt: { file: "src/events.ts", line: 1 } },
        { file: "pages/a.tsx", line: 8, via: "helper:addToCart", navigation: "full_load", helperAt: { file: "src/events.ts", line: 1 } }
      ]
    }]
  }
  const correct = before
    .replace('import { addToCart } from "../src/events"', 'import { addToCart } from "../src/events"\nimport { infiniteLeaveAfter } from "../lib/infinite-analytics"')
    .replace('  const buyNow = () => {\n    addToCart(p)\n    window.location.assign("/checkout")\n  }', '  const buyNow = () =>\n    infiniteLeaveAfter(\n      () => addToCart(p),\n      () => window.location.assign("/checkout")\n    )')

  it("only the full-load caller must wait; the client-routing caller left as it is passes (lines moved by the edit)", () => {
    expect(leaveFindings({ files: files({ "src/events.ts": helper, "pages/a.tsx": correct }), base: new Map([["pages/a.tsx", before]]), inventory })).toEqual([])
  })

  it("the full-load caller left as it is fails, and only it is named", () => {
    const found = leaveFindings({ files: files({ "src/events.ts": helper, "pages/a.tsx": before }), base: new Map([["pages/a.tsx", before]]), inventory })
    expect(found.map((finding) => [finding.rule, finding.line])).toEqual([["lost_before_leaving", 8]])
  })
})
