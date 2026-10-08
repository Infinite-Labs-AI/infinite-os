// The ONE outcome helper every server-lane target ships, EXECUTED and TYPE-CHECKED.
//
// 1. Strict TypeScript: every emitted .ts helper (each background mode) and every target's own .ts files
//    are written to a temp dir and compiled with the repo's typescript under --strict (plus
//    noUncheckedIndexedAccess, which many customer repos turn on). A helper that fails here would fail the
//    customer's `next build` (review P0-2).
// 2. Behaviour: the TS and the JS helper are imported for real and driven end to end: the Stripe
//    webhook answer (P1-3), the payer-only identity (P1-2), the name split (P1-1), the optional path
//    (P1-5), the content_ids cap (P1-9), zero-decimal currencies, the checkout → webhook carry (gap 7)
//    and the background modes (no new dependency).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createHash, createHmac } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import ts from "typescript"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { VECTORS } from "../helpers.test.js"
import { buildCreatedMiddlewareSource, buildServerLaneModuleSource } from "../runtime-source.js"

import { cloudflarePagesMiddlewareSource } from "./cloudflare.js"
import { netlifyEdgeFunctionSource } from "./netlify.js"
import {
  detectOutcomeBackgroundMode,
  outcomeBackgroundModeOf,
  outcomeHelperSource,
  type OutcomeBackgroundMode
} from "./outcome-helper.js"
import { vercelLaneModuleSource, vercelMiddlewareSource } from "./vercel-any.js"

const here = dirname(fileURLToPath(import.meta.url))
const VECTOR_FILE = JSON.parse(readFileSync(resolve(here, "../../../contracts/server-lane-v1.vectors.json"), "utf8")) as {
  metaMatch: {
    email: { raw: string; sha256: string }
    fullName: { raw: string; fn: string; ln: string }
    fullNameMultiWord: { raw: string; fn: string; ln: string }
    city: { raw: string; sha256: string }
    usState: { raw: string; country: string; sha256: string }
    zip: { raw: string; sha256: string }
    country: { raw: string; sha256: string }
  }
}
const META = VECTOR_FILE.metaMatch
const BUILD = { siteSourceKey: "site_test", productionHosts: [VECTORS.host] }
const sha = (value: string) => createHash("sha256").update(value).digest("hex")
const tempRoots: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

/** Minimal stand-ins for the two packages a helper may import (only when the site already has them). */
function writeStubPackages(dir: string, calls: { waitUntil: unknown[]; after: unknown[] }): void {
  const vercel = join(dir, "node_modules", "@vercel", "functions")
  mkdirSync(vercel, { recursive: true })
  writeFileSync(join(vercel, "package.json"), JSON.stringify({ name: "@vercel/functions", type: "module", main: "index.js", types: "index.d.ts" }))
  writeFileSync(join(vercel, "index.js"), "export function waitUntil(task) { globalThis.__infiniteStubCalls.waitUntil.push(task) }\nexport function next() { return new Response(null) }\n")
  writeFileSync(join(vercel, "index.d.ts"), "export declare function waitUntil(task: Promise<unknown>): void\nexport declare function next(): Response\n")
  const next = join(dir, "node_modules", "next")
  mkdirSync(next, { recursive: true })
  writeFileSync(join(next, "package.json"), JSON.stringify({ name: "next", type: "module", exports: { "./server": { types: "./server.d.ts", default: "./server.js" } } }))
  writeFileSync(
    join(next, "server.js"),
    "export function after(task) { if (globalThis.__infiniteStubCalls.afterThrows) throw new Error('outside a request scope'); globalThis.__infiniteStubCalls.after.push(task) }\n" +
      "export const NextResponse = { next: () => new Response(null) }\n"
  )
  writeFileSync(
    join(next, "server.d.ts"),
    [
      "export declare function after<T>(task: Promise<T> | (() => T | Promise<T>)): void",
      "export declare class NextRequest extends Request { nextUrl: URL }",
      "export interface NextFetchEvent { waitUntil(promise: Promise<unknown>): void }",
      "export declare const NextResponse: { next(): Response }",
      ""
    ].join("\n")
  )
  ;(globalThis as { __infiniteStubCalls?: unknown }).__infiniteStubCalls = calls
}

function strictDiagnostics(files: Record<string, string>, extra: ts.CompilerOptions = {}): string[] {
  const dir = tempDir("instrument-outcome-tsc-")
  writeStubPackages(dir, { waitUntil: [], after: [] })
  const paths = Object.entries(files).map(([name, source]) => {
    const path = join(dir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
    return path
  })
  const program = ts.createProgram(paths, {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    types: [],
    skipLibCheck: true,
    ...extra
  })
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const where = diagnostic.file ? `${diagnostic.file.fileName.slice(dir.length + 1)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1}` : ""
    return `${where} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`
  })
}

const MODES: OutcomeBackgroundMode[] = ["bounded", "vercel-wait-until", "next-after"]

describe("every emitted TypeScript file passes tsc --strict (review P0-2)", () => {
  afterEach(() => {
    while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
  })

  it.each(MODES)("the outcome helper (%s), strict and with noUncheckedIndexedAccess", (background) => {
    const source = outcomeHelperSource(BUILD, { background })
    expect(strictDiagnostics({ "lib/infinite-outcome.ts": source })).toEqual([])
    expect(strictDiagnostics({ "lib/infinite-outcome.ts": source }, { noUncheckedIndexedAccess: true })).toEqual([])
  })

  it("each target's own .ts files: Vercel, Netlify, Cloudflare Pages, Next.js", () => {
    expect(
      strictDiagnostics({
        "vercel/lib/infinite-server-lane.ts": vercelLaneModuleSource(BUILD),
        "vercel/middleware.ts": vercelMiddlewareSource(BUILD),
        "netlify/edge.ts": netlifyEdgeFunctionSource(BUILD),
        "cloudflare/functions/_middleware.ts": cloudflarePagesMiddlewareSource(BUILD),
        "next/lib/infinite-server-lane.ts": buildServerLaneModuleSource(BUILD),
        "next/middleware.ts": buildCreatedMiddlewareSource({ moduleImportPath: "./lib/infinite-server-lane" }),
        // The hosts' own globals the entries read (Node's process.env); nothing else is declared.
        "host-globals.d.ts": "declare const process: { env: Record<string, string | undefined> }\n"
      })
    ).toEqual([])
  })

  it("a webhook written against the helper's own types compiles: no undefined names, Stripe-shaped input", () => {
    const route = [
      'import { reportStripeCheckoutPurchase, reportStripeCheckoutStarted, buyerContext, contextMetadata, reportInfiniteLead, reportInfiniteOutcomeForMirror, stripeAmountToMajor } from "./lib/infinite-outcome"',
      "declare const verified: { type: \"checkout.session.completed\"; livemode: boolean; data: { object: { id: string; amount_total: number | null; currency: string | null; payment_status: \"paid\" | \"unpaid\"; metadata: { [name: string]: string } | null; customer_details: { email: string | null; name: string | null; address: { city: string | null; state: string | null; postal_code: string | null; country: string | null; line1: string | null } | null } | null; collected_information: { shipping_details: { name: string; address: { city: string | null; state: string | null; postal_code: string | null; country: string | null } } | null } | null } } }",
      "declare const req: { headers: { [key: string]: string | string[] | undefined } }",
      "export async function handler(): Promise<number> {",
      "  const context = await buyerContext(req, { trackingAllowed: true })",
      "  const metadata: Record<string, string> = { ...contextMetadata(context, { contentIds: [\"price_1\"], numItems: 1 }) }",
      "  await reportStripeCheckoutStarted({ id: \"cs_1\", amount_total: 100, currency: \"usd\", metadata }, { path: \"/cart\" })",
      "  await reportInfiniteLead(req, { email: \"a@b.co\", trackingAllowed: false, fallbackId: \"row_1\" })",
      "  const mirror = await reportInfiniteOutcomeForMirror({ type: \"lead\", eventId: \"x\" })",
      "  return (await reportStripeCheckoutPurchase(verified, { path: \"/success\" })) + (stripeAmountToMajor(1, \"usd\") ?? 0) + (mirror.status ?? 0)",
      "}",
      ""
    ].join("\n")
    expect(strictDiagnostics({ "lib/infinite-outcome.ts": outcomeHelperSource(BUILD), "route.ts": route })).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------

type Helper = Record<string, (...args: never[]) => unknown> & {
  reportInfiniteOutcome: (outcome: Record<string, unknown>) => Promise<number | null>
  reportInfiniteOutcomeForMirror: (outcome: Record<string, unknown>) => Promise<Record<string, unknown>>
  reportInfiniteOutcomeInBackground: (outcome: Record<string, unknown>) => Promise<void>
  reportStripeCheckoutPurchase: (event: unknown, options: { path: string }) => Promise<number>
  reportStripeCheckoutStarted: (session: unknown, options: { path: string }) => Promise<void>
  reportInfiniteLead: (request: unknown, options: Record<string, unknown>) => Promise<void>
  adMatchFromRequest: (request: unknown, options: Record<string, unknown>) => Promise<Record<string, string> | undefined>
  personMatch: (adMatch: unknown, person: unknown) => Promise<Record<string, string> | undefined>
  buyerContext: (request: unknown, options: Record<string, unknown>) => Promise<{ visitKey?: string; adMatch?: Record<string, string> }>
  contextMetadata: (context: unknown, cart?: unknown) => Record<string, string>
  contextFromMetadata: (metadata: unknown) => Record<string, unknown>
  stripeCheckoutPayer: (session: unknown) => Promise<Record<string, unknown>>
  stripeAmountToMajor: (amount: unknown, currency: unknown) => number | undefined
  infiniteContentIds: (ids: unknown) => string | undefined
  infiniteLeadId: (email: unknown, secret?: string) => Promise<string | null>
  infiniteConfigured: () => boolean
  infinitePagePath: (request: unknown, fallback: string) => string
}

const stubCalls = { waitUntil: [] as unknown[], after: [] as unknown[], afterThrows: false }

async function loadHelper(form: "ts" | "js", background: OutcomeBackgroundMode = "bounded"): Promise<Helper> {
  const dir = tempDir("instrument-outcome-run-")
  writeStubPackages(dir, stubCalls)
  const extension = form === "ts" ? "ts" : "mjs"
  const path = join(dir, "lib", `infinite-outcome-${Math.random().toString(16).slice(2)}.${extension}`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, outcomeHelperSource(BUILD, form === "ts" ? { background } : { language: "js", extension: "mjs", background }))
  return (await import(pathToFileURL(path).href)) as Helper
}

const accepted = (extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ accepted: true, duplicate: false, ...extra }), { status: 202 })

function sentBodies(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, any>> {
  return fetchMock.mock.calls.map((call) => JSON.parse(String((call as [string, RequestInit])[1].body)))
}

const LEAD_SECRET = "site-only-lead-secret"
const buyerHeaders = {
  cookie: "_fbc=fb.1.1700000000000.OLDCLICK; _fbc=fb.1.1800000000000.NEWCLICK; _fbp=fb.1.1700000000000.123456789",
  "user-agent": "Mozilla/5.0 (Macintosh) Buyer",
  "x-forwarded-for": "203.0.113.9, 10.0.0.1",
  host: "shop.example",
  referer: "https://shop.example/mailing-list?utm_source=x"
}

function paidSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_live_abc123",
    object: "checkout.session",
    amount_total: 49900,
    currency: "usd",
    payment_status: "paid",
    metadata: {} as Record<string, string>,
    customer_details: {
      email: " Payer@Example.COM ",
      name: "Juan Carlos de la Cruz",
      address: { city: "New York", state: "California", postal_code: "94107-1234", country: "US", line1: "1 Main St" }
    },
    collected_information: { shipping_details: { name: "Someone Else", address: { city: "Austin", state: "TX", postal_code: "73301", country: "US" } } },
    ...overrides
  }
}

function paidEvent(session: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return { id: "evt_1", type: "checkout.session.completed", livemode: true, data: { object: session }, ...overrides }
}

describe.each(["ts", "js"] as const)("the outcome helper (%s), executed", (form) => {
  const originalEnv = { ...process.env }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env.INFINITE_SERVER_EVENT_SECRET = VECTORS.secret
    process.env.INFINITE_SITE_SOURCE_KEY = "site_test"
    process.env.LEAD_ID_SECRET = LEAD_SECRET
    fetchMock = vi.fn(async () => accepted())
    vi.stubGlobal("fetch", fetchMock)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    stubCalls.waitUntil.length = 0
    stubCalls.after.length = 0
    stubCalls.afterThrows = false
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    process.env = { ...originalEnv }
    while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
  })

  describe("reportInfiniteOutcome → Infinite's status, or null when nothing was sent", () => {
    it("resolves the HTTP status, signs the body, and sends the wire id <type>:<id>", async () => {
      const helper = await loadHelper(form)
      await expect(helper.reportInfiniteOutcome({ type: "purchase", eventId: "cs_1", path: "/success" })).resolves.toBe(202)
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe("https://api.ultima.inc/api/analytics/events/server")
      const headers = init.headers as Record<string, string>
      expect(headers["x-infinite-signature"]).toBe(createHmac("sha256", VECTORS.secret).update(String(init.body)).digest("hex"))
      expect(sentBodies(fetchMock)[0]).toMatchObject({ eventId: "purchase:cs_1", eventName: "purchase", properties: { path: "/success" } })
    })

    it("an id already namespaced with its type is sent as is, never purchase:purchase:", async () => {
      const helper = await loadHelper(form)
      await helper.reportInfiniteOutcome({ type: "purchase", eventId: "purchase:cs_1", path: "/success" })
      await helper.reportInfiniteOutcome({ type: "lead", eventId: "lead:abc", path: "/" })
      expect(sentBodies(fetchMock).map((body) => body.eventId)).toEqual(["purchase:cs_1", "lead:abc"])
    })

    it("null when the env vars are missing (inert until set), with no network call", async () => {
      delete process.env.INFINITE_SERVER_EVENT_SECRET
      const helper = await loadHelper(form)
      expect(helper.infiniteConfigured()).toBe(false)
      await expect(helper.reportInfiniteOutcome({ type: "purchase", eventId: "cs_1", path: "/success" })).resolves.toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("null on a network error or the 2 s timeout; the HTTP status on a refusal; never throws", async () => {
      const helper = await loadHelper(form)
      fetchMock.mockImplementationOnce(async () => Promise.reject(new Error("offline")))
      await expect(helper.reportInfiniteOutcome({ type: "purchase", eventId: "a", path: "/s" })).resolves.toBeNull()
      fetchMock.mockImplementationOnce(async () => Promise.reject(new DOMException("aborted", "AbortError")))
      await expect(helper.reportInfiniteOutcome({ type: "purchase", eventId: "b", path: "/s" })).resolves.toBeNull()
      fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 503 }))
      await expect(helper.reportInfiniteOutcome({ type: "purchase", eventId: "c", path: "/s" })).resolves.toBe(503)
      fetchMock.mockImplementationOnce(async () => new Response("{}", { status: 400 }))
      await expect(helper.reportInfiniteOutcome({ type: "purchase", eventId: "d", path: "/s" })).resolves.toBe(400)
    })

    it("an outcome with no type or eventId is refused HERE as 400 (a retry cannot fix it), never thrown", async () => {
      const helper = await loadHelper(form)
      for (const outcome of [{ type: "purchase" }, { type: "purchase", eventId: "  " }, { eventId: "x" }]) {
        await expect(helper.reportInfiniteOutcome(outcome)).resolves.toBe(400)
      }
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("P1-5: path is optional for recording (only Meta needs it); a query is cut, a bad path is dropped", async () => {
      const helper = await loadHelper(form)
      await expect(helper.reportInfiniteOutcome({ type: "lead", eventId: "1" })).resolves.toBe(202)
      await helper.reportInfiniteOutcome({ type: "lead", eventId: "2", path: "/mailing-list?utm_source=x#top" })
      await helper.reportInfiniteOutcome({ type: "lead", eventId: "3", path: "mailing list" })
      const [none, cut, bad] = sentBodies(fetchMock)
      expect(none!.properties).not.toHaveProperty("path")
      expect(cut!.properties.path).toBe("/mailing-list")
      expect(bad!.properties).not.toHaveProperty("path")
    })

    it("P1-9: content_ids of long Stripe price ids is capped to 120 characters by dropping WHOLE ids", async () => {
      const helper = await loadHelper(form)
      const ids = Array.from({ length: 6 }, (_, index) => `price_1Q${String(index).repeat(2)}aBcDeFgHiJkLmNoPqRsT`)
      await expect(helper.reportInfiniteOutcome({ type: "purchase", eventId: "cs", path: "/s", properties: { content_ids: ids.join(",") } })).resolves.toBe(202)
      const sent = String(sentBodies(fetchMock)[0]!.properties.content_ids)
      expect(sent.length).toBeLessThanOrEqual(120)
      expect(sent).toMatch(/^[\x21-\x7e]{1,120}$/)
      for (const id of sent.split(",")) expect(ids).toContain(id)
      expect(sent.split(",").length).toBe(Math.floor(121 / (ids[0]!.length + 1)))
      expect(helper.infiniteContentIds(["a", "a", " b ", "has space", "c,d", "", null])).toBe("a,b")
      expect(helper.infiniteContentIds(["x".repeat(121)])).toBeUndefined()
    })

    it("a value Infinite would refuse drops ITSELF; the outcome is still recorded", async () => {
      const helper = await loadHelper(form)
      await helper.reportInfiniteOutcome({
        type: "purchase",
        eventId: "cs",
        path: "/s",
        properties: { value: 10, note: "free text with spaces", BadKey: "x", nan: Number.NaN, visitKey: "not-a-digest", ok: true, missing: undefined }
      })
      expect(sentBodies(fetchMock)[0]!.properties).toEqual({ path: "/s", value: 10, ok: true })
    })

    it("never more than 16 counted properties (visitKey is not counted, as at Infinite)", async () => {
      const helper = await loadHelper(form)
      const many = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`p${index}`, index]))
      await helper.reportInfiniteOutcome({ type: "purchase", eventId: "cs", path: "/s", properties: { ...many, visitKey: "a".repeat(64) } })
      const properties = sentBodies(fetchMock)[0]!.properties
      expect(Object.keys(properties).filter((key) => key !== "visitKey")).toHaveLength(16)
      expect(properties.visitKey).toBe("a".repeat(64))
    })

    it("reportInfiniteOutcomeForMirror resolves the whole answer for a page that mirrors", async () => {
      fetchMock.mockImplementation(async () => accepted({ metaEventId: "lead:abc", metaEventName: "Lead" }))
      const helper = await loadHelper(form)
      await expect(helper.reportInfiniteOutcomeForMirror({ type: "lead", eventId: "abc", path: "/" })).resolves.toEqual({
        status: 202,
        accepted: true,
        duplicate: false,
        metaEventId: "lead:abc",
        metaEventName: "Lead"
      })
    })
  })

  describe("match data", () => {
    it("P1-1: fn is the first word and ln is EVERY later word, joined (Infinite's split)", async () => {
      const helper = await loadHelper(form)
      const device = { client_user_agent: "UA" }
      expect(await helper.personMatch(device, { name: META.fullNameMultiWord.raw })).toMatchObject({ fn: META.fullNameMultiWord.fn, ln: META.fullNameMultiWord.ln })
      expect(await helper.personMatch(device, { name: META.fullName.raw })).toMatchObject({ fn: META.fullName.fn, ln: META.fullName.ln })
      expect(await helper.personMatch(device, { name: "Cher" })).not.toHaveProperty("ln")
    })

    it("adMatchFromRequest: nothing at all unless the page said tracking is allowed; never a phone", async () => {
      const helper = await loadHelper(form)
      const request = new Request("https://shop.example/api/checkout", { headers: buyerHeaders })
      await expect(helper.adMatchFromRequest(request, { trackingAllowed: false, person: { email: META.email.raw } })).resolves.toBeUndefined()
      const match = await helper.adMatchFromRequest(request, {
        trackingAllowed: true,
        person: { email: META.email.raw, name: META.fullName.raw, city: META.city.raw, state: META.usState.raw, postcode: META.zip.raw, country: META.country.raw, phone: "+15555550100" }
      })
      expect(match).toEqual({
        fbc: "fb.1.1800000000000.NEWCLICK",
        fbp: "fb.1.1700000000000.123456789",
        client_ip_address: "203.0.113.9",
        client_user_agent: "Mozilla/5.0 (Macintosh) Buyer",
        em: META.email.sha256,
        fn: META.fullName.fn,
        ln: META.fullName.ln,
        ct: META.city.sha256,
        st: META.usState.sha256,
        zp: META.zip.sha256,
        country: META.country.sha256
      })
      // A plain-object request (Pages Router / Express req.headers) reads the same.
      expect(await helper.adMatchFromRequest({ headers: buyerHeaders }, { trackingAllowed: true })).toMatchObject({ fbc: "fb.1.1800000000000.NEWCLICK" })
      expect(await helper.personMatch(undefined, { email: "a@b.co" })).toBeUndefined()
    })

    it("P1-2: the payer only: name and email from customer_details, the address WHOLE from one place", async () => {
      const helper = await loadHelper(form)
      // A gift: billing has a city, shipping goes to someone else → billing address, payer's name.
      const gift = await helper.stripeCheckoutPayer(paidSession())
      expect(gift).toEqual({
        email: " Payer@Example.COM ",
        externalId: createHmac("sha256", LEAD_SECRET).update("payer@example.com").digest("hex"),
        name: "Juan Carlos de la Cruz",
        city: "New York",
        state: "California",
        postcode: "94107-1234",
        country: "US"
      })
      // Card-only billing (no city) and shipping addressed to the payer by name (any case, trimmed) → shipping, whole.
      const self = await helper.stripeCheckoutPayer(
        paidSession({
          customer_details: { email: "p@example.com", name: "Ada Lovelace", address: { city: null, state: null, postal_code: "10001", country: "US" } },
          collected_information: { shipping_details: { name: "  ada lovelace ", address: { city: "Austin", state: "TX", postal_code: "73301", country: "US" } } }
        })
      )
      expect(self).toMatchObject({ name: "Ada Lovelace", city: "Austin", state: "TX", postcode: "73301", country: "US" })
      // Card-only billing and a shipping name that is NOT the payer's → billing's own fields, never mixed.
      const other = await helper.stripeCheckoutPayer(
        paidSession({
          customer_details: { email: "p@example.com", name: "Ada Lovelace", address: { city: null, state: null, postal_code: "10001", country: "US" } },
          collected_information: null,
          shipping_details: { name: "Grace Hopper", address: { city: "Austin", state: "TX", postal_code: "73301", country: "US" } }
        })
      )
      expect(other).toMatchObject({ name: "Ada Lovelace", city: null, state: null, postcode: "10001", country: "US" })
    })

    it("buyerContext → contextMetadata → contextFromMetadata carries the device data to the webhook (gap 7)", async () => {
      const helper = await loadHelper(form)
      const context = await helper.buyerContext({ headers: buyerHeaders }, { trackingAllowed: true })
      expect(context.visitKey).toMatch(/^[a-f0-9]{64}$/)
      const metadata = helper.contextMetadata(context, { contentIds: ["price_a", "price_b"], numItems: 3 })
      expect(metadata).toEqual({
        infinite_checkout: "1",
        infinite_visit_key: context.visitKey,
        infinite_fbc: "fb.1.1800000000000.NEWCLICK",
        infinite_fbp: "fb.1.1700000000000.123456789",
        infinite_ip: "203.0.113.9",
        infinite_ua: "Mozilla/5.0 (Macintosh) Buyer",
        infinite_skus: "price_a,price_b",
        infinite_num_items: "3"
      })
      for (const value of Object.values(metadata)) expect(value).not.toMatch(/@|Payer|Juan/)
      expect(helper.contextFromMetadata(metadata)).toEqual({
        siteCheckout: true,
        visitKey: context.visitKey,
        adMatch: { fbc: "fb.1.1800000000000.NEWCLICK", fbp: "fb.1.1700000000000.123456789", client_ip_address: "203.0.113.9", client_user_agent: "Mozilla/5.0 (Macintosh) Buyer" },
        contentIds: "price_a,price_b",
        numItems: 3
      })
      // No device data without the page's signal; the visit key (Infinite's own join) still rides.
      const denied = await helper.buyerContext({ headers: buyerHeaders }, { trackingAllowed: false })
      expect(denied.adMatch).toBeUndefined()
      expect(helper.contextMetadata(denied)).toEqual({ infinite_checkout: "1", infinite_visit_key: denied.visitKey })
      // A value over Stripe's 500-character limit is left out, never cut.
      const long = helper.contextMetadata({ adMatch: { client_user_agent: "U".repeat(501), fbp: "fb.1.1.x" } })
      expect(long).not.toHaveProperty("infinite_ua")
      expect(long.infinite_fbp).toBe("fb.1.1.x")
      // Nothing is kept in Stripe before Infinite is configured.
      delete process.env.INFINITE_SERVER_EVENT_SECRET
      expect(helper.contextMetadata(context, { contentIds: ["a"] })).toEqual({})
      expect(helper.contextFromMetadata(null)).toEqual({ siteCheckout: false })
      expect(helper.contextFromMetadata({ infinite_fbc: "<script>", infinite_visit_key: "zz" })).toEqual({ siteCheckout: false })
    })

    it("zero-decimal and three-decimal currencies convert to major units correctly", async () => {
      const helper = await loadHelper(form)
      expect(helper.stripeAmountToMajor(49900, "usd")).toBe(499)
      expect(helper.stripeAmountToMajor(1999, "eur")).toBe(19.99)
      expect(helper.stripeAmountToMajor(5000, "jpy")).toBe(5000)
      expect(helper.stripeAmountToMajor(12000, "KRW")).toBe(12000)
      expect(helper.stripeAmountToMajor(12340, "kwd")).toBe(12.34)
      expect(helper.stripeAmountToMajor(null, "usd")).toBeUndefined()
    })
  })

  describe("reportStripeCheckoutPurchase: the webhook's answer (P1-3: no retry storm)", () => {
    async function siteSession(helper: Helper, overrides: Record<string, unknown> = {}) {
      const context = await helper.buyerContext({ headers: buyerHeaders }, { trackingAllowed: true })
      return paidSession({ metadata: helper.contextMetadata(context, { contentIds: ["price_a"], numItems: 2 }), ...overrides })
    }

    it("reports a paid live session: value, currency, products, payer match data, the carried device data", async () => {
      const helper = await loadHelper(form)
      const session = await siteSession(helper)
      await expect(helper.reportStripeCheckoutPurchase(paidEvent(session), { path: "/success" })).resolves.toBe(200)
      const body = sentBodies(fetchMock)[0]!
      expect(body).toMatchObject({
        eventId: "purchase:cs_live_abc123",
        eventName: "purchase",
        properties: { path: "/success", value: 499, currency: "USD", content_ids: "price_a", num_items: 2 }
      })
      expect(body.properties.visitKey).toMatch(/^[a-f0-9]{64}$/)
      const leadId = createHmac("sha256", LEAD_SECRET).update("payer@example.com").digest("hex")
      expect(body.adMatch).toEqual({
        fbc: "fb.1.1800000000000.NEWCLICK",
        fbp: "fb.1.1700000000000.123456789",
        client_ip_address: "203.0.113.9",
        client_user_agent: "Mozilla/5.0 (Macintosh) Buyer",
        em: sha("payer@example.com"),
        external_id: sha(leadId),
        fn: META.fullNameMultiWord.fn,
        ln: META.fullNameMultiWord.ln,
        ct: META.city.sha256,
        st: META.usState.sha256,
        zp: META.zip.sha256,
        country: META.country.sha256
      })
      const raw = JSON.stringify(body)
      for (const secret of ["Payer@", "Juan", "New York", "94107", "Someone Else", "Austin"]) expect(raw).not.toContain(secret)
    })

    it("a zero-decimal purchase sends the yen amount as is", async () => {
      const helper = await loadHelper(form)
      await helper.reportStripeCheckoutPurchase(paidEvent(await siteSession(helper, { amount_total: 5000, currency: "jpy" })), { path: "/success" })
      expect(sentBodies(fetchMock)[0]!.properties).toMatchObject({ value: 5000, currency: "JPY" })
    })

    it("answers 200 and sends nothing for what a retry can never report", async () => {
      const helper = await loadHelper(form)
      const session = await siteSession(helper)
      const cases = [
        paidEvent(session, { livemode: false }),
        paidEvent(session, { type: "checkout.session.expired" }),
        paidEvent({ ...session, payment_status: "unpaid" }),
        paidEvent({ ...session, metadata: { order: "from-a-payment-link" } }),
        paidEvent({ ...session, metadata: null }),
        { type: "checkout.session.completed", livemode: true, data: { object: { object: "checkout.session" } } }
      ]
      for (const event of cases) await expect(helper.reportStripeCheckoutPurchase(event, { path: "/success" })).resolves.toBe(200)
      expect(fetchMock).not.toHaveBeenCalled()
      delete process.env.INFINITE_SERVER_EVENT_SECRET
      await expect(helper.reportStripeCheckoutPurchase(paidEvent(session), { path: "/success" })).resolves.toBe(200)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("async_payment_succeeded reports the same purchase id (counted once with completed)", async () => {
      const helper = await loadHelper(form)
      const session = await siteSession(helper)
      await helper.reportStripeCheckoutPurchase(paidEvent(session), { path: "/success" })
      await helper.reportStripeCheckoutPurchase(paidEvent(session, { type: "checkout.session.async_payment_succeeded" }), { path: "/success" })
      expect(sentBodies(fetchMock).map((body) => body.eventId)).toEqual(["purchase:cs_live_abc123", "purchase:cs_live_abc123"])
    })

    it.each([
      ["not delivered (network)", () => Promise.reject(new Error("offline")), 500],
      ["Infinite 5xx", async () => new Response("{}", { status: 502 }), 500],
      ["401 (secret fixed later)", async () => new Response("{}", { status: 401 }), 500],
      ["403", async () => new Response("{}", { status: 403 }), 500],
      ["429", async () => new Response("{}", { status: 429 }), 500],
      ["400 (not declared / refused: a retry fails again)", async () => new Response("{}", { status: 400 }), 200],
      ["202", async () => accepted(), 200]
    ] as const)("%s → %i", async (_name, answer, expected) => {
      const helper = await loadHelper(form)
      const session = await siteSession(helper)
      fetchMock.mockImplementation(answer as () => Promise<Response>)
      await expect(helper.reportStripeCheckoutPurchase(paidEvent(session), { path: "/success" })).resolves.toBe(expected)
    })
  })

  describe("checkout and lead routes", () => {
    it("reportStripeCheckoutStarted sends begin_checkout from the session it just created", async () => {
      const helper = await loadHelper(form)
      const context = await helper.buyerContext({ headers: buyerHeaders }, { trackingAllowed: true })
      const session = { id: "cs_live_9", amount_total: 1500, currency: "eur", metadata: helper.contextMetadata(context, { contentIds: "price_x", numItems: 1 }) }
      await helper.reportStripeCheckoutStarted(session, { path: "/cart" })
      const body = sentBodies(fetchMock)[0]!
      expect(body).toMatchObject({ eventId: "begin_checkout:cs_live_9", eventName: "begin_checkout", properties: { path: "/cart", value: 15, currency: "EUR", content_ids: "price_x", num_items: 1 } })
      expect(body.adMatch).toMatchObject({ fbc: "fb.1.1800000000000.NEWCLICK", client_user_agent: "Mozilla/5.0 (Macintosh) Buyer" })
      // Not this site's metadata (Infinite not configured when the session was made) → nothing.
      fetchMock.mockClear()
      await helper.reportStripeCheckoutStarted({ id: "cs_2", amount_total: 1, currency: "usd", metadata: {} }, { path: "/cart" })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("reportInfiniteLead: one stable id per person, hashed em + the same external_id as the purchase", async () => {
      const helper = await loadHelper(form)
      const request = { headers: buyerHeaders }
      await helper.reportInfiniteLead(request, { email: "Payer@Example.com", trackingAllowed: true, fallbackPath: "/mailing-list" })
      await helper.reportInfiniteLead(request, { email: "payer@example.com ", trackingAllowed: false, fallbackId: "row_1" })
      const [allowed, denied] = sentBodies(fetchMock)
      const leadId = createHmac("sha256", LEAD_SECRET).update("payer@example.com").digest("hex")
      expect(allowed).toMatchObject({ eventId: `lead:${leadId}`, eventName: "lead", properties: { path: "/mailing-list" } })
      expect(allowed!.adMatch).toMatchObject({ em: sha("payer@example.com"), external_id: sha(leadId), fbc: "fb.1.1800000000000.NEWCLICK" })
      expect(denied!.eventId).toBe(`lead:${leadId}`)
      expect(denied).not.toHaveProperty("adMatch")
      expect(JSON.stringify([allowed, denied])).not.toMatch(/payer@|Payer@/i)
      // Without LEAD_ID_SECRET: the row id, and no external_id.
      delete process.env.LEAD_ID_SECRET
      fetchMock.mockClear()
      await helper.reportInfiniteLead(request, { email: "a@b.co", trackingAllowed: true, fallbackId: "row_7", type: "sign_up", path: "/signup" })
      const body = sentBodies(fetchMock)[0]!
      expect(body).toMatchObject({ eventId: "sign_up:row_7", eventName: "sign_up", properties: { path: "/signup" } })
      expect(body.adMatch).not.toHaveProperty("external_id")
      fetchMock.mockClear()
      await helper.reportInfiniteLead(request, { email: "a@b.co", trackingAllowed: true })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("infinitePagePath: the same-host Referer's path, else the fallback", async () => {
      const helper = await loadHelper(form)
      expect(helper.infinitePagePath({ headers: buyerHeaders }, "/x")).toBe("/mailing-list")
      expect(helper.infinitePagePath({ headers: { ...buyerHeaders, referer: "https://evil.example/a" } }, "/x")).toBe("/x")
      expect(helper.infinitePagePath({ headers: {} }, "/x")).toBe("/x")
    })
  })

  describe("background sends never add a dependency", () => {
    it("bounded: waits for the send, but never longer than 800 ms", async () => {
      fetchMock.mockImplementation(() => new Promise(() => undefined))
      const helper = await loadHelper(form, "bounded")
      const started = Date.now()
      await helper.reportInfiniteOutcomeInBackground({ type: "lead", eventId: "1", path: "/" })
      const waited = Date.now() - started
      expect(waited).toBeGreaterThanOrEqual(780)
      expect(waited).toBeLessThan(1500)
    })

    it("vercel-wait-until: hands the send to the site's own @vercel/functions waitUntil and returns at once", async () => {
      fetchMock.mockImplementation(() => new Promise(() => undefined))
      const helper = await loadHelper(form, "vercel-wait-until")
      const started = Date.now()
      await helper.reportInfiniteOutcomeInBackground({ type: "lead", eventId: "1", path: "/" })
      expect(Date.now() - started).toBeLessThan(300)
      expect(stubCalls.waitUntil).toHaveLength(1)
    })

    it("next-after: hands it to after(); where Next refuses after(), falls back to the bounded wait", async () => {
      const helper = await loadHelper(form, "next-after")
      await helper.reportInfiniteOutcomeInBackground({ type: "lead", eventId: "1", path: "/" })
      expect(stubCalls.after).toHaveLength(1)
      stubCalls.afterThrows = true
      await helper.reportInfiniteOutcomeInBackground({ type: "lead", eventId: "2", path: "/" })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })
})

describe("the background mode follows what the site already has", () => {
  afterEach(() => {
    while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
  })

  function site(packageJson: Record<string, unknown>, dirs: string[] = []): string {
    const dir = tempDir("instrument-outcome-site-")
    writeFileSync(join(dir, "package.json"), JSON.stringify(packageJson))
    for (const sub of dirs) mkdirSync(join(dir, sub), { recursive: true })
    return dir
  }

  it("@vercel/functions → waitUntil; Next >= 15.1 App Router → after; otherwise the bounded wait", () => {
    expect(detectOutcomeBackgroundMode(site({ dependencies: { "@vercel/functions": "^2.0.0", next: "15.5.0" } }, ["pages"]))).toBe("vercel-wait-until")
    expect(detectOutcomeBackgroundMode(site({ dependencies: { next: "^15.1.0" } }, ["app"]))).toBe("next-after")
    expect(detectOutcomeBackgroundMode(site({ dependencies: { next: "16.0.1" } }, ["src/app"]))).toBe("next-after")
    expect(detectOutcomeBackgroundMode(site({ dependencies: { next: "15.0.3" } }, ["app"]))).toBe("bounded")
    expect(detectOutcomeBackgroundMode(site({ dependencies: { next: "15.5.27" } }, ["pages"]))).toBe("bounded")
    expect(detectOutcomeBackgroundMode(site({ dependencies: { express: "4" } }))).toBe("bounded")
  })

  it("only the mode's own import is emitted; the bounded helper imports nothing", () => {
    const bounded = outcomeHelperSource(BUILD, { background: "bounded" })
    expect(bounded).not.toMatch(/^import /m)
    expect(outcomeBackgroundModeOf(bounded)).toBe("bounded")
    expect(outcomeHelperSource(BUILD, { background: "vercel-wait-until" })).toContain('import { waitUntil } from "@vercel/functions"')
    expect(outcomeHelperSource(BUILD, { background: "next-after" })).toContain('import { after } from "next/server"')
  })
})
