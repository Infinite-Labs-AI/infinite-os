// The generated non-Next lanes, EXECUTED. Every target's file is written to a temp dir and
// imported for real (vitest transforms the .ts on the way in), then driven against the fixed
// vectors in helpers.test.ts — the same vectors the receiving side proves. A lane that would post
// a different envelope than the Node recipe fails here, not in a customer's production traffic.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  DEFAULT_INFINITE_COLLECT_PATH,
  INFINITE_SERVER_EVENTS_DESTINATION,
  infiniteServerEventsDestination
} from "../../workspace-artifacts.js"
import { VECTORS } from "../../../test/server-lane-vectors.js"
import {
  hashInfiniteEmail,
  signServerEventBody,
  SERVER_LANE_SIGNATURE_HEADER,
  SERVER_LANE_SOURCE_KEY_HEADER
} from "../helpers.js"

import { cloudflarePagesMiddlewareSource } from "./cloudflare.js"
import { NETLIFY_EXCLUDED_ASSET_EXTENSIONS, netlifyEdgeFunctionSource } from "./netlify.js"
import { nodeLaneModuleSource, nodeTarget } from "./node.js"
import { outcomeHelperSource } from "./outcome-helper.js"
import {
  detectServerLaneHelperLanguage,
  edgeLaneCoreSource,
  outcomeHelperTarget
} from "./shared.js"
import { vercelLaneModuleSource, vercelMiddlewareSource } from "./vercel-any.js"

const tempRoots: string[] = []
/** Infinite's real 202 (§3j.1, as answered today: no Meta instruction). */
const acceptedResponse = () => new Response(JSON.stringify({ accepted: true, duplicate: false }), { status: 202 })
const BUILD = { siteSourceKey: "site_test", productionHosts: [VECTORS.host] }
const META_MATCH = (
  JSON.parse(readFileSync(new URL("../../../contracts/server-lane-v1.vectors.json", import.meta.url), "utf8")) as {
    metaMatch: {
      email: { raw: string; sha256: string }
      externalId: { raw: string; sha256: string }
      city: { raw: string; sha256: string }
      usState: { raw: string; country: string; sha256: string }
      zip: { raw: string; sha256: string }
      country: { raw: string; sha256: string }
      fullName: { raw: string; fn: string; ln: string }
    }
  }
).metaMatch

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

async function loadGenerated(source: string, extension: "ts" | "js" = "ts"): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), "instrument-lane-target-"))
  tempRoots.push(dir)
  const modulePath = join(dir, `lane-${Math.random().toString(16).slice(2)}.${extension}`)
  writeFileSync(modulePath, source)
  return (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>
}

function documentRequest(overrides: { url?: string; method?: string; headers?: Record<string, string> } = {}) {
  return new Request(overrides.url ?? `https://${VECTORS.host}${VECTORS.path}`, {
    method: overrides.method ?? "GET",
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": VECTORS.userAgent,
      "x-forwarded-for": `${VECTORS.clientIp}, 10.0.0.1`,
      "x-forwarded-host": VECTORS.host,
      referer: VECTORS.referrer,
      ...(overrides.headers ?? {})
    }
  })
}

function postedBody(fetchMock: ReturnType<typeof vi.fn>): { url: string; headers: Headers; body: string } {
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  return { url, headers: new Headers(init.headers as HeadersInit), body: init.body as string }
}

describe("the shared edge core, executed", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => acceptedResponse())
    vi.stubGlobal("fetch", fetchMock)
    vi.spyOn(Date, "now").mockReturnValue(VECTORS.nowMs)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("posts the byte-exact site_document_request envelope and signature from the shared vectors", async () => {
    const lane = (await loadGenerated(vercelLaneModuleSource(BUILD))) as {
      recordInfiniteDocumentRequest: (request: Request, credentials: unknown) => Promise<boolean>
    }

    await expect(
      lane.recordInfiniteDocumentRequest(documentRequest(), {
        secret: VECTORS.secret,
        sourceKey: "site_test"
      })
    ).resolves.toBe(true)

    const posted = postedBody(fetchMock)
    expect(posted.url).toBe(INFINITE_SERVER_EVENTS_DESTINATION)
    expect(posted.body).toBe(VECTORS.body)
    expect(posted.headers.get(SERVER_LANE_SOURCE_KEY_HEADER)).toBe("site_test")
    expect(posted.headers.get(SERVER_LANE_SIGNATURE_HEADER)).toBe(VECTORS.bodySignature)
    expect(posted.headers.get("content-type")).toBe("application/json")
    // The raw IP, the full user agent, cookies and the query string never leave the customer's server.
    expect(posted.body).not.toContain(VECTORS.clientIp)
    expect(posted.body).not.toContain("Mozilla")
    expect(posted.body).not.toContain("q=infinite")
  })

  it("passes an outcome's adMatch block through the shared sender, unchanged and signed", async () => {
    const lane = (await loadGenerated(edgeLaneCoreSource({ ...BUILD, exported: true }))) as {
      sendInfiniteServerEvent: (
        event: Record<string, unknown>,
        credentials: { secret: string; sourceKey?: string }
      ) => Promise<boolean>
    }
    const adMatch = { em: hashInfiniteEmail("founder@example.com") }
    await lane.sendInfiniteServerEvent(
      { eventId: "purchase:1", eventName: "purchase", occurredAt: "2025-08-18T06:53:20.123Z", adMatch },
      { secret: VECTORS.secret }
    )
    const posted = postedBody(fetchMock)
    expect(JSON.parse(posted.body).adMatch).toEqual(adMatch)
    expect(posted.headers.get(SERVER_LANE_SIGNATURE_HEADER)).toBe(
      signServerEventBody(VECTORS.secret, posted.body)
    )
  })

  it("never puts an adMatch on a document request — a page load is not a conversion", async () => {
    const lane = (await loadGenerated(edgeLaneCoreSource({ ...BUILD, exported: true }))) as {
      recordInfiniteDocumentRequest: (
        request: Request,
        credentials: { secret: string; sourceKey?: string }
      ) => Promise<boolean>
    }
    await lane.recordInfiniteDocumentRequest(documentRequest(), { secret: VECTORS.secret })
    expect(postedBody(fetchMock).body).not.toContain("adMatch")
  })

  it("derives the same 30-minute visitKey as the Node recipe", async () => {
    const lane = (await loadGenerated(vercelLaneModuleSource(BUILD))) as {
      infiniteVisitKey: (headers: Headers, secret: string, nowMs?: number) => Promise<string>
    }
    await expect(lane.infiniteVisitKey(documentRequest().headers, VECTORS.secret, VECTORS.nowMs)).resolves.toBe(
      VECTORS.visitKey
    )
  })

  it("prefers a host-supplied client IP over the forwarded header, and still never sends it", async () => {
    const lane = (await loadGenerated(vercelLaneModuleSource(BUILD))) as {
      infiniteVisitKey: (headers: Headers, secret: string, nowMs?: number, clientIp?: string) => Promise<string>
    }
    const other = await lane.infiniteVisitKey(documentRequest().headers, VECTORS.secret, VECTORS.nowMs, "198.51.100.7")
    expect(other).not.toBe(VECTORS.visitKey)
    expect(other).toMatch(/^[0-9a-f]{64}$/)
  })

  describe("the document gate", () => {
    const cases: Array<[string, Parameters<typeof documentRequest>[0], boolean]> = [
      ["an HTML page", {}, true],
      ["a POST", { method: "POST" }, false],
      ["a purpose:prefetch", { headers: { purpose: "prefetch" } }, false],
      // Privacy: DNT / Global-Privacy-Control are honored like the client pixel does.
      ["a Do-Not-Track signal", { headers: { dnt: "1" } }, false],
      ["an API route", { url: `https://${VECTORS.host}/api/checkout` }, false],
      ["the Infinite pixel's collect path", { url: `https://${VECTORS.host}${DEFAULT_INFINITE_COLLECT_PATH}` }, false],
      ["a file with an extension", { url: `https://${VECTORS.host}/logo.svg` }, false],
    ]

    it.each(cases)("%s -> %s", async (_label, overrides, expected) => {
      const lane = (await loadGenerated(vercelLaneModuleSource(BUILD))) as {
        isInfiniteDocumentRequest: (request: Request, path: string) => boolean
      }
      const request = documentRequest(overrides)
      expect(lane.isInfiniteDocumentRequest(request, new URL(request.url).pathname)).toBe(expected)
    })
  })

  it("stays dormant on loopback, on an off-allowlist host, and without a secret", async () => {
    const lane = (await loadGenerated(vercelLaneModuleSource(BUILD))) as {
      recordInfiniteDocumentRequest: (request: Request, credentials: unknown) => Promise<boolean>
    }
    const credentials = { secret: VECTORS.secret, sourceKey: "site_test" }

    await expect(
      lane.recordInfiniteDocumentRequest(
        documentRequest({ url: "http://localhost:3000/pricing", headers: { "x-forwarded-host": "localhost:3000" } }),
        credentials
      )
    ).resolves.toBe(false)
    await expect(
      lane.recordInfiniteDocumentRequest(
        documentRequest({ url: "https://staging.example.net/pricing", headers: { "x-forwarded-host": "staging.example.net" } }),
        credentials
      )
    ).resolves.toBe(false)
    await expect(
      lane.recordInfiniteDocumentRequest(documentRequest(), { secret: "", sourceKey: "site_test" })
    ).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("one host normaliser: example.com. (any case, with a port) is the baked host; a baked trailing dot matches too", async () => {
    const credentials = { secret: VECTORS.secret, sourceKey: "site_test" }
    for (const [baked, host] of [
      [VECTORS.host, "EXAMPLE.com.:443"],
      [`${VECTORS.host.toUpperCase()}.`, VECTORS.host]
    ] as const) {
      fetchMock.mockClear()
      const lane = (await loadGenerated(vercelLaneModuleSource({ ...BUILD, productionHosts: [baked] }))) as {
        recordInfiniteDocumentRequest: (request: Request, credentials: unknown) => Promise<boolean>
      }
      await expect(
        lane.recordInfiniteDocumentRequest(documentRequest({ headers: { "x-forwarded-host": host } }), credentials)
      ).resolves.toBe(true)
      expect(JSON.parse(postedBody(fetchMock).body).properties.host).toBe(VECTORS.host)
    }
    const lane = (await loadGenerated(vercelLaneModuleSource(BUILD))) as {
      recordInfiniteDocumentRequest: (request: Request, credentials: unknown) => Promise<boolean>
    }
    await expect(
      lane.recordInfiniteDocumentRequest(documentRequest({ headers: { "x-forwarded-host": "staging.example.com." } }), credentials)
    ).resolves.toBe(false)
  })

  it("records on any host when no production allowlist was baked in", async () => {
    const lane = (await loadGenerated(vercelLaneModuleSource({ productionHosts: [] }))) as {
      recordInfiniteDocumentRequest: (request: Request, credentials: unknown) => Promise<boolean>
    }
    await expect(
      lane.recordInfiniteDocumentRequest(
        documentRequest({ url: "https://anything.example.org/pricing", headers: { "x-forwarded-host": "anything.example.org" } }),
        { secret: VECTORS.secret, sourceKey: "site_test" }
      )
    ).resolves.toBe(true)
  })
})

describe("the Netlify edge function, executed", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => acceptedResponse())
    vi.stubGlobal("fetch", fetchMock)
    vi.stubGlobal("Netlify", {
      env: {
        get: (name: string) =>
          name === "INFINITE_SERVER_EVENT_SECRET" ? VECTORS.secret : name === "INFINITE_SITE_SOURCE_KEY" ? "site_test" : undefined
      }
    })
    vi.spyOn(Date, "now").mockReturnValue(VECTORS.nowMs)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("records the document request through context.waitUntil and returns nothing (the chain continues)", async () => {
    const fn = (await loadGenerated(netlifyEdgeFunctionSource(BUILD))) as {
      default: (request: Request, context: unknown) => Promise<void>
      config: { path: string; excludedPath: string[] }
    }
    const tasks: Array<Promise<unknown>> = []
    const result = await fn.default(documentRequest(), {
      ip: VECTORS.clientIp,
      waitUntil: (promise: Promise<unknown>) => tasks.push(promise)
    })
    expect(result).toBeUndefined()
    expect(tasks).toHaveLength(1)
    await Promise.all(tasks)

    const posted = postedBody(fetchMock)
    expect(posted.body).toBe(VECTORS.body)
    expect(posted.headers.get(SERVER_LANE_SIGNATURE_HEADER)).toBe(VECTORS.bodySignature)
  })

  it("declares itself in-file for every path except assets, APIs and internals", async () => {
    const fn = (await loadGenerated(netlifyEdgeFunctionSource(BUILD))) as {
      config: { path: string; excludedPath: string[] }
    }
    expect(fn.config.path).toBe("/*")
    expect(fn.config.excludedPath).toEqual([
      "/api/*",
      "/_next/*",
      "/_vercel/*",
      `${DEFAULT_INFINITE_COLLECT_PATH}*`,
      ...NETLIFY_EXCLUDED_ASSET_EXTENSIONS.map((extension) => `/*.${extension}`)
    ])
    // Never a blanket "/*.*": URLPattern's wildcard is greedy across "/", so it would also exclude a
    // real page like /v1.0/pricing. https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API
    expect(fn.config.excludedPath).not.toContain("/*.*")
  })
})

describe("the Cloudflare Pages middleware, executed", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => acceptedResponse())
    vi.stubGlobal("fetch", fetchMock)
    vi.spyOn(Date, "now").mockReturnValue(VECTORS.nowMs)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function pagesContext(request: Request) {
    const tasks: Array<Promise<unknown>> = []
    const passthrough = new Response("<html></html>", { status: 200 })
    return {
      tasks,
      passthrough,
      context: {
        request,
        env: { INFINITE_SERVER_EVENT_SECRET: VECTORS.secret, INFINITE_SITE_SOURCE_KEY: "site_test" },
        next: async () => passthrough,
        waitUntil: (promise: Promise<unknown>) => tasks.push(promise)
      }
    }
  }

  it("records the request, then returns context.next() untouched", async () => {
    const fn = (await loadGenerated(cloudflarePagesMiddlewareSource(BUILD))) as {
      onRequest: (context: unknown) => Promise<Response>
    }
    const { tasks, passthrough, context } = pagesContext(documentRequest())
    await expect(fn.onRequest(context)).resolves.toBe(passthrough)
    expect(tasks).toHaveLength(1)
    await Promise.all(tasks)

    const posted = postedBody(fetchMock)
    expect(posted.body).toBe(VECTORS.body)
    expect(posted.headers.get(SERVER_LANE_SIGNATURE_HEADER)).toBe(VECTORS.bodySignature)
  })

  it("uses cf-connecting-ip for the visit key", async () => {
    const fn = (await loadGenerated(cloudflarePagesMiddlewareSource(BUILD))) as {
      onRequest: (context: unknown) => Promise<Response>
    }
    const request = documentRequest({ headers: { "cf-connecting-ip": VECTORS.clientIp, "x-forwarded-for": "10.0.0.1" } })
    const { tasks, context } = pagesContext(request)
    await fn.onRequest(context)
    await Promise.all(tasks)
    expect(postedBody(fetchMock).body).toContain(VECTORS.visitKey)
  })

  it("passes an asset request straight through without recording", async () => {
    const fn = (await loadGenerated(cloudflarePagesMiddlewareSource(BUILD))) as {
      onRequest: (context: unknown) => Promise<Response>
    }
    const { passthrough, context } = pagesContext(documentRequest({ url: `https://${VECTORS.host}/app.js` }))
    await expect(fn.onRequest(context)).resolves.toBe(passthrough)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("the Node module, executed", () => {
  const originalEnv = { ...process.env }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env.INFINITE_SERVER_EVENT_SECRET = VECTORS.secret
    process.env.INFINITE_SITE_SOURCE_KEY = "site_test"
    fetchMock = vi.fn(async () => acceptedResponse())
    vi.stubGlobal("fetch", fetchMock)
    vi.spyOn(Date, "now").mockReturnValue(VECTORS.nowMs)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    process.env = { ...originalEnv }
  })

  function expressRequest(overrides: { path?: string; method?: string; headers?: Record<string, string> } = {}) {
    return {
      method: overrides.method ?? "GET",
      path: overrides.path ?? VECTORS.path,
      ip: VECTORS.clientIp,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": VECTORS.userAgent,
        "x-forwarded-for": `${VECTORS.clientIp}, 10.0.0.1`,
        host: VECTORS.host,
        referer: VECTORS.referrer,
        ...(overrides.headers ?? {})
      } as Record<string, string>
    }
  }

  it("posts the same envelope the edge lanes post, and always calls next()", async () => {
    const lane = (await loadGenerated(nodeLaneModuleSource(BUILD), "js")) as {
      infiniteServerLane: () => (req: unknown, res: unknown, next: () => void) => void
    }
    const next = vi.fn()
    lane.infiniteServerLane()(expressRequest(), {}, next)
    expect(next).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(postedBody(fetchMock).body).toBe(VECTORS.body)
  })

  it("skips assets, API routes, non-GETs and non-HTML, and still calls next()", async () => {
    const lane = (await loadGenerated(nodeLaneModuleSource(BUILD), "js")) as {
      infiniteServerLane: () => (req: unknown, res: unknown, next: () => void) => void
    }
    const middleware = lane.infiniteServerLane()
    const next = vi.fn()
    for (const request of [
      expressRequest({ path: "/logo.svg" }),
      expressRequest({ path: "/api/checkout" }),
      expressRequest({ method: "POST" }),
      expressRequest({ headers: { accept: "application/json" } }),
      expressRequest({ headers: { purpose: "prefetch" } })
    ]) {
      middleware(request, {}, next)
    }
    expect(next).toHaveBeenCalledTimes(5)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("the outcome helper, executed", () => {
  const originalEnv = { ...process.env }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env.INFINITE_SERVER_EVENT_SECRET = VECTORS.secret
    process.env.INFINITE_SITE_SOURCE_KEY = "site_test"
    fetchMock = vi.fn(async () => acceptedResponse())
    vi.stubGlobal("fetch", fetchMock)
    vi.spyOn(Date, "now").mockReturnValue(VECTORS.nowMs)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    process.env = { ...originalEnv }
  })

  it("posts a purchase with a stable event id, the path, and the SAME visit key as the page view", async () => {
    const helper = (await loadGenerated(outcomeHelperSource(BUILD))) as {
      reportInfiniteOutcome: (input: Record<string, unknown>) => Promise<number | null>
    }
    await expect(
      helper.reportInfiniteOutcome({
        type: "purchase",
        path: "/checkout",
        eventId: "purchase:cs_test_123",
        accountKey: "cus_123",
        occurredAt: new Date(VECTORS.nowMs),
        visitKeyInputs: documentRequest()
      })
    ).resolves.toBe(202)

    const posted = postedBody(fetchMock)
    const body = JSON.parse(posted.body) as {
      eventId: string
      eventName: string
      occurredAt: string
      accountKey: string
      properties: Record<string, string>
    }
    expect(body).toMatchObject({
      eventId: "purchase:cs_test_123",
      eventName: "purchase",
      occurredAt: new Date(VECTORS.nowMs).toISOString(),
      accountKey: "cus_123"
    })
    expect(body.properties).toEqual({ path: "/checkout", visitKey: VECTORS.visitKey })
    expect(posted.headers.get(SERVER_LANE_SOURCE_KEY_HEADER)).toBe("site_test")
    expect(posted.body).not.toContain(VECTORS.clientIp)
  })

  it("carries an adMatch block VERBATIM inside the signed body (the Meta CAPI relay)", async () => {
    const helper = (await loadGenerated(outcomeHelperSource(BUILD))) as {
      reportInfiniteOutcome: (input: Record<string, unknown>) => Promise<number | null>
    }
    const adMatch = {
      em: hashInfiniteEmail("founder@example.com"),
      fbc: "fb.1.1755500000123.IwAR0abcDEF_-123",
      fbp: "fb.1.1755500000123.987654321",
      client_ip_address: VECTORS.clientIp,
      client_user_agent: VECTORS.userAgent
    }
    await helper.reportInfiniteOutcome({
      type: "purchase",
      path: "/checkout",
      eventId: "purchase:cs_test_123",
      occurredAt: new Date(VECTORS.nowMs),
      adMatch
    })
    const posted = postedBody(fetchMock)
    // Verbatim: the helper hashes nothing and rewrites nothing — the customer already did.
    expect(JSON.parse(posted.body).adMatch).toEqual(adMatch)
    // Inside the SIGNED bytes, so it cannot be injected without the secret.
    expect(posted.headers.get(SERVER_LANE_SIGNATURE_HEADER)).toBe(
      signServerEventBody(VECTORS.secret, posted.body)
    )
    // The address itself never leaves the customer's process.
    expect(posted.body).not.toContain("founder@example.com")
  })

  it("adMatchFromRequest omits what the request did not carry, and never invents a value", async () => {
    const helper = (await loadGenerated(outcomeHelperSource(BUILD))) as {
      adMatchFromRequest: (request: { headers: Headers }, match: Record<string, unknown>) => Promise<Record<string, string> | undefined>
    }
    // No page signal, no match data: undefined, never an empty block.
    const bare = await helper.adMatchFromRequest({ headers: new Headers({ "user-agent": VECTORS.userAgent }) }, { trackingAllowed: false })
    expect(bare).toBeUndefined()
    await expect(
      helper.adMatchFromRequest({ headers: new Headers({ "user-agent": VECTORS.userAgent }) }, { trackingAllowed: true })
    ).resolves.toEqual({ client_user_agent: VECTORS.userAgent })
    await expect(
      helper.adMatchFromRequest({ headers: new Headers({ "user-agent": VECTORS.userAgent }) }, { trackingAllowed: false, person: { email: META_MATCH.email.raw } })
    ).resolves.toBeUndefined()
    // An empty cookie value is absent, not an empty string Meta would have to reject.
    const emptyCookie = await helper.adMatchFromRequest(
      {
        headers: new Headers({ cookie: "_fbp=; _fbc=fb.1.1.abc", "user-agent": "ua" })
      },
      { trackingAllowed: true }
    )
    expect(emptyCookie).toEqual({ fbc: "fb.1.1.abc", client_user_agent: "ua" })
  })

  it("reads a PLAIN-OBJECT request (Vercel Node function / Express req.headers), not just a WHATWG Request", async () => {
    // Regression: req.headers on a Vercel Node function is a plain object, so headers.get(...) threw
    // and the whole outcome was swallowed as false — no visit key, no purchase posted.
    const helper = (await loadGenerated(outcomeHelperSource(BUILD))) as {
      reportInfiniteOutcome: (input: Record<string, unknown>) => Promise<number | null>
    }
    const nodeReq = {
      headers: {
        "x-forwarded-for": `${VECTORS.clientIp}, 10.0.0.1`,
        "user-agent": VECTORS.userAgent
      }
    }
    await expect(
      helper.reportInfiniteOutcome({
        type: "purchase",
        path: "/checkout",
        eventId: "purchase:node_1",
        occurredAt: new Date(VECTORS.nowMs),
        visitKeyInputs: nodeReq
      })
    ).resolves.toBe(202)
    const body = JSON.parse(postedBody(fetchMock).body) as { properties: Record<string, string> }
    // A real key from the plain object — never false/empty, and the IP itself still never leaves.
    expect(body.properties.visitKey).toBe(VECTORS.visitKey)
    expect(postedBody(fetchMock).body).not.toContain(VECTORS.clientIp)
  })

  it("exports infiniteVisitKey so a checkout can compute the key and a webhook can carry it", async () => {
    const helper = (await loadGenerated(outcomeHelperSource(BUILD))) as {
      infiniteVisitKey: (inputs: { clientIp?: string; userAgent?: string; nowMs?: number }) => Promise<string>
      reportInfiniteOutcome: (input: Record<string, unknown>) => Promise<number | null>
    }
    // 1. At CHECKOUT, from the buyer's request — same recipe as the page-view lane.
    const visitKey = await helper.infiniteVisitKey({
      clientIp: VECTORS.clientIp,
      userAgent: VECTORS.userAgent,
      nowMs: VECTORS.nowMs
    })
    expect(visitKey).toBe(VECTORS.visitKey)
    // 2. In the WEBHOOK, carried via properties.visitKey (the request there is the provider's) — the
    //    helper skips its own derivation and keeps the carried key verbatim.
    await helper.reportInfiniteOutcome({
      type: "purchase",
      path: "/success",
      eventId: "purchase:cs_1",
      occurredAt: new Date(VECTORS.nowMs),
      properties: { visitKey }
    })
    expect(JSON.parse(postedBody(fetchMock).body).properties.visitKey).toBe(VECTORS.visitKey)
  })

  it("falls back to the baked source key, takes explicit credentials, and stays silent with no secret", async () => {
    const helper = (await loadGenerated(outcomeHelperSource(BUILD))) as {
      reportInfiniteOutcome: (input: Record<string, unknown>) => Promise<number | null>
    }
    delete process.env.INFINITE_SITE_SOURCE_KEY
    await helper.reportInfiniteOutcome({ type: "download", eventId: "d1", path: "/download" })
    expect(postedBody(fetchMock).headers.get(SERVER_LANE_SOURCE_KEY_HEADER)).toBe("site_test")

    fetchMock.mockClear()
    delete process.env.INFINITE_SERVER_EVENT_SECRET
    await expect(helper.reportInfiniteOutcome({ type: "download", eventId: "d1", path: "/download" })).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()

    // Cloudflare Workers have no process.env: the caller passes its binding values instead.
    await expect(
      helper.reportInfiniteOutcome({
        type: "download",
        eventId: "d2",
        path: "/download",
        credentials: { secret: VECTORS.secret, sourceKey: "site_worker" }
      })
    ).resolves.toBe(202)
    expect(postedBody(fetchMock).headers.get(SERVER_LANE_SOURCE_KEY_HEADER)).toBe("site_worker")
  })

  it("the Node target ships this same helper (one API on every host), never a Node-only twin", () => {
    const dir = mkdtempSync(join(tmpdir(), "instrument-lane-node-outcome-"))
    tempRoots.push(dir)
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module", dependencies: { express: "4" } }))
    writeFileSync(join(dir, "tsconfig.json"), "{}")
    const built = nodeTarget.build(BUILD, dir)
    expect(Object.keys(built).sort()).toEqual(["lib/infinite-outcome.js", "lib/infinite-server-lane.js"])
    expect(built["lib/infinite-outcome.js"]).toBe(outcomeHelperSource(BUILD, { language: "js", extension: "js", background: "bounded" }))
  })
})

describe("the generated files as text", () => {
  it("bakes the public source key and host allowlist, and never the secret", () => {
    for (const source of [
      vercelLaneModuleSource(BUILD),
      netlifyEdgeFunctionSource(BUILD),
      cloudflarePagesMiddlewareSource(BUILD),
      nodeLaneModuleSource(BUILD),
      outcomeHelperSource(BUILD)
    ]) {
      expect(source.startsWith("// Managed by Infinite")).toBe(true)
      expect(source).toContain('"site_test"')
      expect(source).not.toMatch(/INFINITE_SERVER_EVENT_SECRET\s*=\s*"[^"]/)
      expect(source).not.toContain(VECTORS.secret)
    }
    for (const source of [
      vercelLaneModuleSource(BUILD),
      netlifyEdgeFunctionSource(BUILD),
      cloudflarePagesMiddlewareSource(BUILD),
      nodeLaneModuleSource(BUILD)
    ]) {
      expect(source).toContain(`["${VECTORS.host}"]`)
    }
  })

  it("an overridden origin actually reaches the wire", async () => {
    const origin = "https://api.infinite.fast"
    const lane = (await loadGenerated(vercelLaneModuleSource({ ...BUILD, apiOrigin: origin }))) as {
      recordInfiniteDocumentRequest: (request: Request, credentials: unknown) => Promise<boolean>
    }
    const fetchMock = vi.fn(async () => acceptedResponse())
    vi.stubGlobal("fetch", fetchMock)
    vi.spyOn(Date, "now").mockReturnValue(VECTORS.nowMs)
    try {
      await lane.recordInfiniteDocumentRequest(documentRequest(), { secret: VECTORS.secret, sourceKey: "site_test" })
      expect(postedBody(fetchMock).url).toBe(infiniteServerEventsDestination(origin))
    } finally {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })

  it("posts to the resolved --infinite-api-origin, and to the default when there is no override", () => {
    const origin = "https://api.infinite.fast"
    const overridden = { ...BUILD, apiOrigin: origin }
    for (const source of [
      vercelLaneModuleSource(overridden),
      netlifyEdgeFunctionSource(overridden),
      cloudflarePagesMiddlewareSource(overridden),
      nodeLaneModuleSource(overridden),
      outcomeHelperSource(overridden)
    ]) {
      expect(source).toContain(`"${infiniteServerEventsDestination(origin)}"`)
      expect(source).not.toContain(INFINITE_SERVER_EVENTS_DESTINATION)
    }
    for (const source of [
      vercelLaneModuleSource(BUILD),
      netlifyEdgeFunctionSource(BUILD),
      cloudflarePagesMiddlewareSource(BUILD),
      nodeLaneModuleSource(BUILD),
      outcomeHelperSource(BUILD)
    ]) {
      expect(source).toContain(`"${INFINITE_SERVER_EVENTS_DESTINATION}"`)
    }
  })

  it("honours a custom Infinite collect path in every skip list", () => {
    const custom = { ...BUILD, collectPath: "/metrics/collect" }
    expect(vercelMiddlewareSource(custom)).toContain("metrics/collect")
    expect(vercelLaneModuleSource(custom)).toContain('"/metrics/collect"')
    expect(netlifyEdgeFunctionSource(custom)).toContain('"/metrics/collect*"')
    expect(nodeLaneModuleSource(custom)).toContain('"/metrics/collect"')
  })
})

describe("the outcome helper module format (TS vs JS)", () => {
  function makeProject(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "instrument-outcome-lang-"))
    tempRoots.push(root)
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolute = join(root, relativePath)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, contents)
    }
    return root
  }

  it("keeps .ts for a TypeScript project (tsconfig, TS api dir, or a top-level *.ts)", () => {
    expect(outcomeHelperTarget(makeProject({ "tsconfig.json": "{}" }))).toEqual({
      path: "lib/infinite-outcome.ts",
      language: "ts",
      extension: "ts"
    })
    expect(detectServerLaneHelperLanguage(makeProject({ "api/pay.ts": "export default 1" }))).toBe("ts")
    expect(detectServerLaneHelperLanguage(makeProject({ "vite.config.ts": "export default {}" }))).toBe("ts")
  })

  it("emits .js for a JS api dir under \"type\":\"module\", and .mjs when it is not ESM", () => {
    const esm = makeProject({
      "package.json": '{"type":"module"}',
      "api/checkout-status.js": "export default () => {}"
    })
    expect(outcomeHelperTarget(esm)).toEqual({ path: "lib/infinite-outcome.js", language: "js", extension: "js" })

    const cjs = makeProject({
      "package.json": "{}",
      "api/checkout-status.js": "module.exports = () => {}"
    })
    expect(outcomeHelperTarget(cjs)).toEqual({ path: "lib/infinite-outcome.mjs", language: "js", extension: "mjs" })
  })

  it("a JS api dir wins even when the frontend is TypeScript (the real Vite+React-on-Vercel bug)", () => {
    // Vite frontend is TS (vite.config.ts, tsconfig) but the Vercel serverless functions are plain JS,
    // and they are what import the helper — so the helper must be JS or it will not resolve at runtime.
    const project = makeProject({
      "package.json": '{"type":"module"}',
      "tsconfig.json": "{}",
      "vite.config.ts": "export default {}",
      "src/main.tsx": "createRoot()",
      "api/checkout-status.js": "export default () => {}"
    })
    expect(outcomeHelperTarget(project)).toMatchObject({ path: "lib/infinite-outcome.js", language: "js" })
  })
})

// THE SERVER HALF OF infinite.fast's 2026-09-29 "first click shadowed later ones" incident (06b2ce8).
// A browser can hold two _fbc cookies — a host-only one and Meta's registrable-domain one — and
// lists the OLDER first. Reading the first-listed value sends Meta the oldest ad click, so Meta
// credits the wrong ad. infinite.fast's reader (scripts/lib/meta-click-id.mjs rule 3 at 9f65b47)
// picks the newest by the creation time inside Meta's format, skipping values without Meta's shape.
// Run against the type-stripped .js helper (the .ts one is the same source with types).
describe.each([
  { variant: "js", language: "js" as const, extension: "js" as const }
])("adMatchFromRequest picks the newest ad click ($variant helper, executed)", ({ language, extension }) => {
  const FIRST_CLICK = "fb.1.1790645529960.TEST_NOT_REAL_FIRST"
  const SECOND_CLICK = "fb.1.1790645538268.TEST_NOT_REAL_SECOND"
  type AdMatchHelper = {
    adMatchFromRequest: (request: { headers: unknown }, match?: Record<string, unknown>) => Promise<Record<string, string>>
  }
  const helper = async (): Promise<AdMatchHelper> =>
    (await loadGenerated(outcomeHelperSource(BUILD, { language, extension }), extension)) as AdMatchHelper
  const withCookie = (cookie: string) => ({ headers: new Headers({ cookie, "user-agent": "ua" }) })

  it("sends the SECOND click when the older first click is listed first (the live 09-29 capture)", async () => {
    const block = await (await helper()).adMatchFromRequest(withCookie(`_fbc=${FIRST_CLICK}; _fbc=${SECOND_CLICK}`), { trackingAllowed: true })
    expect(block.fbc).toBe(SECOND_CLICK)
    expect(block.fbc).not.toBe(FIRST_CLICK)
  })

  it("a malformed first _fbc cannot hide a valid later one, and is never forwarded itself", async () => {
    const bad = "fb.1.notms.IwAR0bad"
    const h = await helper()
    expect((await h.adMatchFromRequest(withCookie(`_fbc=${bad}; _fbc=${FIRST_CLICK}`), { trackingAllowed: true })).fbc).toBe(FIRST_CLICK)
    // Negative: only malformed values → no fbc at all, never the bad bytes.
    const onlyBad = await h.adMatchFromRequest(withCookie(`_fbc=${bad}; _fbc=fb.1.1790645538268.has space`), { trackingAllowed: true })
    expect(onlyBad).not.toHaveProperty("fbc")
    expect(JSON.stringify(onlyBad)).not.toContain("IwAR0bad")
  })

  it("keeps the fbclid byte for byte (Meta's _fbc is case-sensitive), and ties keep the first listed", async () => {
    const h = await helper()
    const mixedCase = "fb.2.1790645538268.IwAR0aBc-DeF_9.x"
    expect((await h.adMatchFromRequest(withCookie(`_fbc=${mixedCase}`), { trackingAllowed: true })).fbc).toBe(mixedCase)
    const tieA = "fb.1.1790645538268.TEST_NOT_REAL_A"
    const tieB = "fb.1.1790645538268.TEST_NOT_REAL_B"
    expect((await h.adMatchFromRequest(withCookie(`_fbc=${tieA}; _fbc=${tieB}`), { trackingAllowed: true })).fbc).toBe(tieA)
  })

  it("_fbp is a browser id, not a click: first listed, and dropped when it lacks Meta's shape", async () => {
    const h = await helper()
    expect(
      (await h.adMatchFromRequest(withCookie("_fbp=fb.1.1755500000123.111; _fbp=fb.1.1790645538268.222"), { trackingAllowed: true })).fbp
    ).toBe("fb.1.1755500000123.111")
    // Negative: an oversized or malformed _fbp is absent, never forwarded.
    await expect(h.adMatchFromRequest(withCookie(`_fbp=fb.1.1725350400000.${"A".repeat(513)}`), { trackingAllowed: true })).resolves.not.toHaveProperty("fbp")
    await expect(h.adMatchFromRequest(withCookie("_fbp=garbage"), { trackingAllowed: true })).resolves.not.toHaveProperty("fbp")
  })
})
