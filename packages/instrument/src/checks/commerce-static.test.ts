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
import { bodyView, canonicalEvent, commerceFindings, metaEventIdFindings, piiFindings, valueFindings } from "./commerce-static.js"
import { jobStaticCheckFunctions, type JobStaticCheckId, type JobStaticRunContext } from "./job-static.js"

const files = (entries: Record<string, string>) => new Map(Object.entries(entries))

describe("event names and the inventory", () => {
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

describe("outcomes: value and currency", () => {
  const route = (call: string) => files({ "pages/api/checkout.ts": `export default async function handler(req, res) {\n  ${call}\n}\n` })

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

  it("job 8 and job 10 carry only the mechanical rules; the judgements are review questions", () => {
    const ids = (jobId: JobId) => JOB_TABLE[jobId].checks.map((spec) => `${spec.tier}:${spec.checkId}`)
    expect(ids("server_conversions")).toEqual(["S:outcome_declared", "S:no_pii_in_outcome", "S:outcome_value_currency", "B:build", "P:first_real_outcome"])
    expect(ids("conversions_to_tools")).toEqual(["T0:click_test", "RH:click_test", "S:conversion_tracked", "S:meta_event_id_from_server", "P:first_real_conversion"])
    for (const gone of ["outcome_ad_match", "tracking_signal_carried", "no_double_count", "commerce_promises_met", "sends_before_leaving", "sends_kept", "event_id_stable", "outcome_after_success", "track_after_success"]) {
      expect(Object.keys(jobStaticCheckFunctions({})), gone).not.toContain(gone)
    }
  })

  it("outcome_value_currency: problem on the bare purchase, pass on the full one", async () => {
    const bare = { [WEBHOOK]: 'await reportInfiniteOutcome({ type: "purchase", eventId: `purchase:${session.id}`, path: "/success" })\n' }
    const full = { [WEBHOOK]: 'await reportInfiniteOutcome({ type: "purchase", eventId: `purchase:${session.id}`, path: "/success", properties: { value: session.amount_total / 100, currency: session.currency.toUpperCase() }, adMatch: matchFromSession(session) })\n' }
    expect((await check("outcome_value_currency", bare, job8)).state).toBe("problem")
    expect((await check("outcome_value_currency", full, job8)).state).toBe("pass")
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

  it("meta_event_id_from_server flags a page-made id the run added, never the site's own old line", async () => {
    const job10 = item("conversions_to_tools", "purchase", ["src/events.ts"])
    const built = { "src/events.ts": "fbq('track', 'AddToCart', {}, { eventID: `atc-${id}` })\n" }
    expect((await check("meta_event_id_from_server", built, job10, {}, { "src/events.ts": "" })).state).toBe("problem")
    expect((await check("meta_event_id_from_server", built, job10, {}, built)).state).toBe("pass")
  })
})

describe("the outcome helper's own reporters (lib/infinite-outcome)", () => {
  const WEBHOOK = "pages/api/stripe-webhook.ts"
  const CHECKOUT = "pages/api/checkout.ts"
  const LEAD = "pages/api/mailing-list.ts"
  const webhook = 'import { reportStripeCheckoutPurchase } from "../../lib/infinite-outcome"\nexport default async function handler(req, res) {\n  return res.status(await reportStripeCheckoutPurchase(event, { path: "/success" })).end()\n}\n'
  const checkout = 'import { reportStripeCheckoutStarted } from "../../lib/infinite-outcome"\nexport default async function handler(req, res) {\n  await reportStripeCheckoutStarted(session, { path: "/cart" })\n}\n'
  const lead = 'import { reportInfiniteLead } from "../../lib/infinite-outcome"\nexport default async function handler(req, res) {\n  await reportInfiniteLead(req, { email, trackingAllowed: body.adMatch === true, fallbackPath: "/mailing-list", fallbackId: id })\n}\n'

  it("reportStripeCheckoutPurchase / reportStripeCheckoutStarted / reportInfiniteLead carry their value and currency inside, and the lead's email is an input, never a leak", () => {
    const all = files({ [WEBHOOK]: webhook, [CHECKOUT]: checkout, [LEAD]: lead })
    expect(valueFindings({ files: all })).toEqual([])
    // The lead's email is an input the helper hashes, never a personal detail in the body.
    expect(piiFindings({ files: all })).toEqual([])
    // Its properties ARE sent: an email there is a leak; a phone anywhere in the call is one too.
    expect(piiFindings({ files: files({ [LEAD]: lead.replace("fallbackId: id", "fallbackId: id, properties: { email: user.email }") }) })).toHaveLength(1)
    expect(piiFindings({ files: files({ [LEAD]: lead.replace("fallbackId: id", "fallbackId: id, phone: user.phone") }) })[0]!.message).toMatch(/phone number/)
  })

  it("job 8's checks recognise them: outcome_declared grades only this job's conversion", async () => {
    const purchase = item("server_conversions", "purchase", [CHECKOUT, WEBHOOK])
    const both = { [CHECKOUT]: checkout, [WEBHOOK]: webhook }
    const run = { conversionNames: ["purchase", "begin_checkout"] }
    expect((await check("outcome_declared", both, purchase, run)).state).toBe("pass")
    expect((await check("no_pii_in_outcome", both, purchase, run)).state).toBe("pass")
    expect((await check("outcome_value_currency", both, purchase, run)).state).toBe("pass")
    // Another conversion's report under a name nobody approved is still a problem.
    const stray = { [CHECKOUT]: checkout.replace('{ path: "/cart" }', '{ path: "/cart", type: "checkout_begun" }'), [WEBHOOK]: webhook }
    expect((await check("outcome_declared", stray, purchase, run)).reason).toMatch(/"checkout_begun", which is not an approved conversion name/)
    // A job with none of them is still told its report is missing.
    expect((await check("outcome_declared", { [CHECKOUT]: "export default function handler() {}\n" }, purchase, run)).reason).toMatch(/no report to Infinite/)
  })

})

describe("commerceFindings: the blocking rules only", () => {
  it("is the value, Meta event id and personal-data rules, nothing that judges meaning", () => {
    const route = files({ "pages/api/checkout.ts": 'await reportInfiniteOutcome({ type: "purchase", eventId: id, path: "/s", adMatch: { em: email } })\n' })
    expect(commerceFindings({ files: route }).map((finding) => finding.rule).sort()).toEqual(["pii_in_outcome", "purchase_without_value"])
  })
})
