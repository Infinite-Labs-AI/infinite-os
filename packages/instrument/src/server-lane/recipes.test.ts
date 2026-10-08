// The server-conversion recipes, RUN: every recipe (the Stripe webhook route for each router shape, the
// checkout edit, the lead edit, the mirror edit) is written to a temp dir next to the REAL generated
// outcome helper and a stand-in `stripe` package, imported, and driven like a live request. A recipe that
// names something the repo does not have fails here, not in a customer's build. The TypeScript forms are
// also compiled under --strict.
import { createHmac } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import ts from "typescript"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { VECTORS } from "./helpers.test.js"
import {
  defaultStripeWebhookRoute,
  leadRouteEdit,
  mirrorRouteEdit,
  stripeCheckoutEdit,
  stripeWebhookRouteSource,
  type RecipeLanguage,
  type RecipeRouter
} from "./recipes.js"
import { outcomeHelperSource } from "./targets/outcome-helper.js"

const tempRoots: string[] = []
const BUILD = { siteSourceKey: "site_test", productionHosts: ["shop.example"] }
const LEAD_SECRET = "site-only-lead-secret"

const STRIPE_STUB = [
  "export default class Stripe {",
  "  constructor(key) { this.key = key }",
  "  webhooks = {",
  "    constructEvent(payload, signature, secret) {",
  '      if (signature !== "t=valid" || secret !== "whsec_test") throw new Error("bad signature")',
  "      return JSON.parse(Buffer.isBuffer(payload) ? payload.toString(\"utf8\") : String(payload))",
  "    },",
  "    async constructEventAsync(payload, signature, secret) { return this.constructEvent(payload, signature, secret) }",
  "  }",
  "}",
  ""
].join("\n")

/** A temp app: the helper at lib/, the stand-in stripe package, and `files` written where given. */
function app(language: RecipeLanguage, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "instrument-recipes-"))
  tempRoots.push(dir)
  const stripe = join(dir, "node_modules", "stripe")
  mkdirSync(stripe, { recursive: true })
  writeFileSync(join(stripe, "package.json"), JSON.stringify({ name: "stripe", type: "module", main: "index.js" }))
  writeFileSync(join(stripe, "index.js"), STRIPE_STUB)
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }))
  const helperPath = join(dir, "lib", language === "ts" ? "infinite-outcome.ts" : "infinite-outcome.js")
  mkdirSync(dirname(helperPath), { recursive: true })
  writeFileSync(helperPath, outcomeHelperSource(BUILD, language === "ts" ? {} : { language: "js", extension: "js" }))
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), source)
  }
  return dir
}

const helperSpecifier = (language: RecipeLanguage, fromDepth: number) =>
  `${fromDepth === 0 ? "./" : "../".repeat(fromDepth)}lib/infinite-outcome${language === "ts" ? "" : ".js"}`

/** Wrap a fragment as a module: its import lines on top, the rest inside `run(<free variables>)`. */
function harness(fragment: string, freeVariables: string[], returns: string): string {
  const lines = fragment.split("\n")
  const imports = lines.filter((line) => line.startsWith("import "))
  const body = lines.filter((line) => !line.startsWith("import "))
  return [...imports, `export async function run(${freeVariables.join(", ")}) {`, ...body.map((line) => `  ${line}`), `  return ${returns}`, "}", ""].join("\n")
}

function paidSessionEvent(metadata: Record<string, string>, overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "checkout.session.completed",
    livemode: true,
    data: {
      object: {
        id: "cs_live_1",
        amount_total: 12900,
        currency: "usd",
        payment_status: "paid",
        metadata,
        customer_details: { email: "payer@example.com", name: "Ada Lovelace", address: { city: "Boston", state: "MA", postal_code: "02110", country: "US" } },
        ...overrides
      }
    }
  }
}

function fakeNodeResponse() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(body: unknown) {
      res.body = body
      return res
    },
    end() {
      return res
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value
    },
    redirect(code: number, url: string) {
      res.statusCode = code
      res.headers.location = url
      return res
    }
  }
  return res
}

function nodeRequest(input: { method?: string; headers: Record<string, string>; body?: unknown; raw?: string; query?: Record<string, string> }) {
  const raw = input.raw ?? ""
  return {
    method: input.method ?? "POST",
    headers: input.headers,
    query: input.query ?? {},
    body: input.body,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(raw)
    }
  }
}

const sentBodies = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls
    .filter((call) => String((call as [string])[0]).includes("/api/analytics/events/server"))
    .map((call) => JSON.parse(String((call as [string, RequestInit])[1].body)) as Record<string, any>)

describe.each(["ts", "js"] as const)("the recipes (%s), run against the real helper", (language) => {
  const originalEnv = { ...process.env }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env.INFINITE_SERVER_EVENT_SECRET = VECTORS.secret
    process.env.INFINITE_SITE_SOURCE_KEY = "site_test"
    process.env.LEAD_ID_SECRET = LEAD_SECRET
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test"
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ accepted: true, duplicate: false }), { status: 202 }))
    vi.stubGlobal("fetch", fetchMock)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    process.env = { ...originalEnv }
    while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
  })

  const checkoutMetadata = { infinite_checkout: "1", infinite_skus: "price_a,price_b", infinite_num_items: "2", infinite_ua: "Mozilla/5.0 Buyer" }

  describe.each(["next-pages", "web", "express"] as const)("the Stripe webhook route (%s)", (router: RecipeRouter) => {
    async function route(): Promise<Record<string, (...args: never[]) => Promise<unknown>>> {
      const file = defaultStripeWebhookRoute(router, language).file
      const depth = file.split("/").length - 1
      const dir = app(language, { [file]: stripeWebhookRouteSource({ language, router, importSpecifier: helperSpecifier(language, depth) }) })
      return (await import(pathToFileURL(join(dir, file)).href)) as Record<string, (...args: never[]) => Promise<unknown>>
    }

    async function deliver(module: Record<string, (...args: never[]) => Promise<unknown>>, event: unknown, signature = "t=valid"): Promise<number> {
      const raw = JSON.stringify(event)
      if (router === "web") {
        const response = (await (module.POST as unknown as (request: Request) => Promise<Response>)(
          new Request("https://shop.example/api/stripe-webhook", { method: "POST", headers: { "stripe-signature": signature }, body: raw })
        ))
        return response.status
      }
      const res = fakeNodeResponse()
      if (router === "next-pages") {
        await (module.default as unknown as (req: unknown, res: unknown) => Promise<unknown>)(nodeRequest({ headers: { "stripe-signature": signature }, raw }), res)
      } else {
        await (module.stripeWebhook as unknown as (req: unknown, res: unknown) => Promise<unknown>)({ headers: { "stripe-signature": signature }, body: Buffer.from(raw) }, res)
      }
      return res.statusCode
    }

    it("verifies the signature on the raw body, reports the paid purchase, answers 200", async () => {
      const module = await route()
      await expect(deliver(module, paidSessionEvent(checkoutMetadata))).resolves.toBe(200)
      const [body] = sentBodies(fetchMock)
      expect(body).toMatchObject({ eventId: "purchase:cs_live_1", eventName: "purchase", properties: { path: "/success", value: 129, currency: "USD", content_ids: "price_a,price_b", num_items: 2 } })
      expect(body!.adMatch).toMatchObject({ client_user_agent: "Mozilla/5.0 Buyer", fn: expect.any(String), ln: expect.any(String), em: expect.any(String) })
      expect(JSON.stringify(body)).not.toContain("payer@example.com")
    })

    it("400 for a request Stripe did not sign, with nothing sent", async () => {
      const module = await route()
      await expect(deliver(module, paidSessionEvent(checkoutMetadata), "t=forged")).resolves.toBe(400)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it("500 only when a retry can deliver; 200 for test mode and before setup", async () => {
      const module = await route()
      fetchMock.mockImplementation(async () => new Response("{}", { status: 503 }))
      await expect(deliver(module, paidSessionEvent(checkoutMetadata))).resolves.toBe(500)
      await expect(deliver(module, { ...paidSessionEvent(checkoutMetadata), livemode: false })).resolves.toBe(200)
      delete process.env.INFINITE_SERVER_EVENT_SECRET
      fetchMock.mockClear()
      await expect(deliver(module, paidSessionEvent(checkoutMetadata))).resolves.toBe(200)
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  it("the checkout edit saves the cart and device data on the session and reports begin_checkout", async () => {
    const fragment = stripeCheckoutEdit({ language, router: "next-pages", importSpecifier: helperSpecifier(language, 2) })
    const dir = app(language, { [`pages/api/checkout-run.${language}`]: harness(fragment, ["req", "stripe", "params", "contentIds", "numItems"], "session") })
    const { run } = (await import(pathToFileURL(join(dir, `pages/api/checkout-run.${language}`)).href)) as { run: (...args: unknown[]) => Promise<unknown> }
    const created: Array<Record<string, any>> = []
    const stripe = {
      checkout: {
        sessions: {
          create: async (params: Record<string, any>) => {
            created.push(params)
            return { id: "cs_live_2", amount_total: 4500, currency: "jpy", metadata: params.metadata, url: "https://checkout.stripe.test/x" }
          }
        }
      }
    }
    const req = { query: { ad_match: "1" }, headers: { cookie: "_fbp=fb.1.1700000000000.42", "user-agent": "Mozilla/5.0 Buyer", "x-forwarded-for": "203.0.113.9" } }
    await run(req, stripe, { mode: "payment", metadata: { campaign: "spring" } }, ["price_a"], 1)
    expect(created[0]!.mode).toBe("payment")
    expect(created[0]!.metadata).toMatchObject({ campaign: "spring", infinite_checkout: "1", infinite_skus: "price_a", infinite_num_items: "1", infinite_fbp: "fb.1.1700000000000.42", infinite_ip: "203.0.113.9" })
    expect(sentBodies(fetchMock)[0]).toMatchObject({ eventId: "begin_checkout:cs_live_2", eventName: "begin_checkout", properties: { path: "/cart", value: 4500, currency: "JPY", content_ids: "price_a" } })
    // Without the page's signal: the cart and the visit key ride, the device data does not.
    created.length = 0
    await run({ ...req, query: {} }, stripe, { mode: "payment" }, ["price_a"], 1)
    expect(created[0]!.metadata).not.toHaveProperty("infinite_fbp")
    expect(created[0]!.metadata).toHaveProperty("infinite_visit_key")
  })

  it("the lead edit reports one stable id per person with hashed match data", async () => {
    const fragment = leadRouteEdit({ language, router: "next-pages", importSpecifier: helperSpecifier(language, 2), fallbackPath: "/mailing-list" })
    const dir = app(language, { [`pages/api/lead-run.${language}`]: harness(fragment, ["req", "email", "body", "signupId"], "true") })
    const { run } = (await import(pathToFileURL(join(dir, `pages/api/lead-run.${language}`)).href)) as { run: (...args: unknown[]) => Promise<unknown> }
    await run({ headers: { "user-agent": "Mozilla/5.0 Buyer" } }, "Fan@Example.com", { adMatch: true }, "row_1")
    const id = createHmac("sha256", LEAD_SECRET).update("fan@example.com").digest("hex")
    const [body] = sentBodies(fetchMock)
    expect(body).toMatchObject({ eventId: `lead:${id}`, eventName: "lead", properties: { path: "/mailing-list" } })
    expect(body!.adMatch).toHaveProperty("external_id")
    expect(JSON.stringify(body)).not.toMatch(/fan@example\.com/i)
  })

  it("the mirror edit returns only what Infinite answered", async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ accepted: true, duplicate: false, metaEventId: "sign_up:x", metaEventName: "CompleteRegistration" }), { status: 202 }))
    const fragment = mirrorRouteEdit({ language, router: "next-pages", importSpecifier: helperSpecifier(language, 2), path: "/signup" })
    const dir = app(language, { [`pages/api/mirror-run.${language}`]: harness(fragment, ["req", "body", "type", "stableId", "email"], "mirror") })
    const { run } = (await import(pathToFileURL(join(dir, `pages/api/mirror-run.${language}`)).href)) as { run: (...args: unknown[]) => Promise<unknown> }
    await expect(run({ headers: { "user-agent": "UA" } }, { adMatch: false }, "sign_up", "acct_1", "a@b.co")).resolves.toEqual({ metaEventId: "sign_up:x", metaEventName: "CompleteRegistration" })
  })
})

describe("the TypeScript recipes compile under --strict", () => {
  afterEach(() => {
    while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
  })

  const STUB_TYPES = [
    "declare const process: { env: Record<string, string | undefined> }",
    "declare class Buffer extends Uint8Array { static from(value: unknown): Buffer; static concat(list: Buffer[]): Buffer; static isBuffer(value: unknown): boolean }",
    'declare module "stripe" {',
    "  namespace Stripe { interface Event { type: string; livemode: boolean; data: { object: unknown } } }",
    "  class Stripe {",
    "    constructor(key: string)",
    "    webhooks: { constructEvent(payload: string | Buffer, header: string, secret: string): Stripe.Event; constructEventAsync(payload: string, header: string, secret: string): Promise<Stripe.Event> }",
    "    checkout: { sessions: { create(params: Record<string, unknown> & { metadata?: Record<string, string> }): Promise<{ id: string; amount_total: number | null; currency: string | null; metadata: Record<string, string> | null }> } }",
    "  }",
    "  export default Stripe",
    "}",
    'declare module "next" {',
    "  interface NextApiRequest extends AsyncIterable<Uint8Array> { method?: string; headers: Record<string, string | string[] | undefined>; query: Record<string, string | string[] | undefined>; body: any }",
    "  interface NextApiResponse { status(code: number): NextApiResponse; json(body: unknown): void; end(): void; setHeader(name: string, value: string): void }",
    "}",
    'declare module "express" {',
    "  interface Request { headers: Record<string, string | string[] | undefined>; body: any }",
    "  interface Response { status(code: number): Response; json(body: unknown): Response; end(): Response }",
    "}",
    ""
  ].join("\n")

  it("every webhook route shape and every fragment, with the free variables a route already has", () => {
    const dir = mkdtempSync(join(tmpdir(), "instrument-recipes-tsc-"))
    tempRoots.push(dir)
    const files: Record<string, string> = {
      "stubs.d.ts": STUB_TYPES,
      "lib/infinite-outcome.ts": outcomeHelperSource(BUILD),
      "pages/api/stripe-webhook.ts": stripeWebhookRouteSource({ language: "ts", router: "next-pages", importSpecifier: "../../lib/infinite-outcome" }),
      "app/api/stripe-webhook/route.ts": stripeWebhookRouteSource({ language: "ts", router: "web", importSpecifier: "../../../lib/infinite-outcome" }),
      "stripe-webhook.ts": stripeWebhookRouteSource({ language: "ts", router: "express", importSpecifier: "./lib/infinite-outcome" }),
      "pages/api/checkout.ts": [
        'import type { NextApiRequest } from "next"',
        'import Stripe from "stripe"',
        harness(stripeCheckoutEdit({ language: "ts", router: "next-pages", importSpecifier: "../../lib/infinite-outcome" }), ["req: NextApiRequest", "stripe: Stripe", "params: { mode: string; metadata?: Record<string, string> }", "contentIds: string[]", "numItems: number"], "session")
      ].join("\n"),
      "app/api/lead/route.ts": harness(leadRouteEdit({ language: "ts", router: "web", importSpecifier: "../../../lib/infinite-outcome" }), ["request: Request", "email: string", "body: { adMatch?: boolean }", "signupId: string"], "true"),
      "app/api/signup/route.ts": harness(mirrorRouteEdit({ language: "ts", router: "web", importSpecifier: "../../../lib/infinite-outcome" }), ["request: Request", "body: { adMatch?: boolean }", "type: string", "stableId: string", "email: string"], "mirror")
    }
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
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.asynciterable.d.ts"],
      types: [],
      skipLibCheck: true,
      esModuleInterop: true
    })
    const diagnostics = ts.getPreEmitDiagnostics(program).map((diagnostic) => {
      const where = diagnostic.file ? `${diagnostic.file.fileName.slice(dir.length + 1)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1}` : ""
      return `${where} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`
    })
    expect(diagnostics).toEqual([])
  })
})
