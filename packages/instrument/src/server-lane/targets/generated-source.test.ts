// The generated non-Next lanes, EXECUTED. Every target's file is written to a temp dir and
// imported for real (vitest transforms the .ts on the way in), then driven against the fixed
// vectors in helpers.test.ts — the same vectors the receiving side proves. A lane that would post
// a different envelope than the Node recipe fails here, not in a customer's production traffic.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  DEFAULT_INFINITE_COLLECT_PATH,
  INFINITE_SERVER_EVENTS_DESTINATION,
  infiniteServerEventsDestination
} from "../../workspace-artifacts.js"
import { VECTORS } from "../helpers.test.js"
import { buildServerLaneModuleSource } from "../runtime-source.js"
import {
  hashInfiniteEmail,
  signServerEventBody,
  SERVER_LANE_SIGNATURE_HEADER,
  SERVER_LANE_SOURCE_KEY_HEADER
} from "../helpers.js"

import { cloudflarePagesMiddlewareSource } from "./cloudflare.js"
import { NETLIFY_EXCLUDED_ASSET_EXTENSIONS, netlifyEdgeFunctionSource } from "./netlify.js"
import { nodeLaneModuleSource, nodeOutcomeHelperSource } from "./node.js"
import {
  detectServerLaneHelperLanguage,
  edgeLaneCoreSource,
  nonDocumentPrefixes,
  outcomeHelperSource,
  outcomeHelperTarget
} from "./shared.js"
import { vercelLaneModuleSource, vercelMiddlewareSource } from "./vercel-any.js"

const tempRoots: string[] = []
const BUILD = { siteSourceKey: "site_test", productionHosts: [VECTORS.host] }

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
    fetchMock = vi.fn(async () => new Response("{}", { status: 202 }))
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
      ["a nested HTML page", { url: `https://${VECTORS.host}/blog/why-servers` }, true],
      ["a POST", { method: "POST" }, false],
      ["a non-HTML accept", { headers: { accept: "application/json" } }, false],
      ["a purpose:prefetch", { headers: { purpose: "prefetch" } }, false],
      ["a sec-purpose prerender", { headers: { "sec-purpose": "prefetch;prerender" } }, false],
      ["a Next router prefetch", { headers: { "next-router-prefetch": "1" } }, false],
      ["an API route", { url: `https://${VECTORS.host}/api/checkout` }, false],
      ["a Vercel internal", { url: `https://${VECTORS.host}/_vercel/insights/view` }, false],
      ["a Next internal", { url: `https://${VECTORS.host}/_next/static/chunk.js` }, false],
      ["the Infinite pixel's collect path", { url: `https://${VECTORS.host}${DEFAULT_INFINITE_COLLECT_PATH}` }, false],
      ["a file with an extension", { url: `https://${VECTORS.host}/logo.svg` }, false],
      ["a dotted path segment", { url: `https://${VECTORS.host}/assets/app.min.css` }, false]
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

  it("never throws and never rejects when the network fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      })
    )
    const lane = (await loadGenerated(vercelLaneModuleSource(BUILD))) as {
      recordInfiniteDocumentRequest: (request: Request, credentials: unknown) => Promise<boolean>
    }
    await expect(
      lane.recordInfiniteDocumentRequest(documentRequest(), { secret: VECTORS.secret, sourceKey: "site_test" })
    ).resolves.toBe(false)
  })
})

describe("the Netlify edge function, executed", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response("{}", { status: 202 }))
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

  it("does nothing on an asset request", async () => {
    const fn = (await loadGenerated(netlifyEdgeFunctionSource(BUILD))) as {
      default: (request: Request, context: unknown) => Promise<void>
    }
    await fn.default(documentRequest({ url: `https://${VECTORS.host}/logo.svg` }), { waitUntil: () => undefined })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("the Cloudflare Pages middleware, executed", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response("{}", { status: 202 }))
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
    fetchMock = vi.fn(async () => new Response("{}", { status: 202 }))
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

  it("stays dormant on an off-allowlist host", async () => {
    const lane = (await loadGenerated(nodeLaneModuleSource(BUILD), "js")) as {
      infiniteServerLane: () => (req: unknown, res: unknown, next: () => void) => void
    }
    const next = vi.fn()
    lane.infiniteServerLane()(expressRequest({ headers: { host: "localhost:3000" } }), {}, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("the outcome helper, executed", () => {
  const originalEnv = { ...process.env }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    process.env.INFINITE_SERVER_EVENT_SECRET = VECTORS.secret
    process.env.INFINITE_SITE_SOURCE_KEY = "site_test"
    fetchMock = vi.fn(async () => new Response("{}", { status: 202 }))
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
      postInfiniteOutcome: (input: Record<string, unknown>) => Promise<boolean>
    }
    await expect(
      helper.postInfiniteOutcome({
        type: "purchase",
        path: "/checkout",
        eventId: "purchase:cs_test_123",
        accountKey: "cus_123",
        occurredAt: new Date(VECTORS.nowMs),
        visitKeyInputs: documentRequest()
      })
    ).resolves.toBe(true)

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
      postInfiniteOutcome: (input: Record<string, unknown>) => Promise<boolean>
    }
    const adMatch = {
      em: hashInfiniteEmail("founder@example.com"),
      fbc: "fb.1.1755500000123.IwAR0abcDEF_-123",
      fbp: "fb.1.1755500000123.987654321",
      client_ip_address: VECTORS.clientIp,
      client_user_agent: VECTORS.userAgent
    }
    await helper.postInfiniteOutcome({
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

  it("adMatchFromRequest reads the BUYER'S cookies, ip and user agent from the customer's request", async () => {
    const helper = (await loadGenerated(outcomeHelperSource(BUILD))) as {
      adMatchFromRequest: (
        request: { headers: Headers },
        hashed?: { em?: string; external_id?: string }
      ) => Record<string, string>
      postInfiniteOutcome: (input: Record<string, unknown>) => Promise<boolean>
    }
    const em = hashInfiniteEmail("founder@example.com")
    const block = helper.adMatchFromRequest(
      documentRequest({
        headers: {
          cookie: "_ga=GA1.1.x; _fbp=fb.1.1755500000123.987654321; _fbc=fb.1.1755500000123.IwAR0abc; other=1"
        }
      }),
      { em }
    )
    expect(block).toEqual({
      em,
      fbc: "fb.1.1755500000123.IwAR0abc",
      fbp: "fb.1.1755500000123.987654321",
      // First hop of x-forwarded-for — the buyer, not the proxy chain.
      client_ip_address: VECTORS.clientIp,
      client_user_agent: VECTORS.userAgent
    })
  })

  it("adMatchFromRequest omits what the request did not carry, and never invents a value", async () => {
    const helper = (await loadGenerated(outcomeHelperSource(BUILD))) as {
      adMatchFromRequest: (request: { headers: Headers }) => Record<string, string>
    }
    const bare = helper.adMatchFromRequest({ headers: new Headers({ "user-agent": VECTORS.userAgent }) })
    expect(bare).toEqual({ client_user_agent: VECTORS.userAgent })
    // An empty cookie value is absent, not an empty string Meta would have to reject.
    const emptyCookie = helper.adMatchFromRequest({
      headers: new Headers({ cookie: "_fbp=; _fbc=fb.1.1.abc", "user-agent": "ua" })
    })
    expect(emptyCookie).toEqual({ fbc: "fb.1.1.abc", client_user_agent: "ua" })
  })

  it("omits adMatch entirely when the caller sends none — the block is opt-in per outcome", async () => {
    const helper = (await loadGenerated(outcomeHelperSource(BUILD))) as {
      postInfiniteOutcome: (input: Record<string, unknown>) => Promise<boolean>
    }
    await helper.postInfiniteOutcome({ type: "sign_up", eventId: "signup:1" })
    expect(postedBody(fetchMock).body).not.toContain("adMatch")
  })

  it("accepts raw visit-key inputs, and mints a random event id when none is given", async () => {
    const helper = (await loadGenerated(outcomeHelperSource(BUILD))) as {
      postInfiniteOutcome: (input: Record<string, unknown>) => Promise<boolean>
    }
    await helper.postInfiniteOutcome({
      type: "sign_up",
      visitKeyInputs: { clientIp: VECTORS.clientIp, userAgent: VECTORS.userAgent }
    })
    const body = JSON.parse(postedBody(fetchMock).body) as { eventId: string; properties: Record<string, string> }
    expect(body.eventId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.properties.visitKey).toBe(VECTORS.visitKey)
  })

  it("falls back to the baked source key, takes explicit credentials, and stays silent with no secret", async () => {
    const helper = (await loadGenerated(outcomeHelperSource(BUILD))) as {
      postInfiniteOutcome: (input: Record<string, unknown>) => Promise<boolean>
    }
    delete process.env.INFINITE_SITE_SOURCE_KEY
    await helper.postInfiniteOutcome({ type: "download" })
    expect(postedBody(fetchMock).headers.get(SERVER_LANE_SOURCE_KEY_HEADER)).toBe("site_test")

    fetchMock.mockClear()
    delete process.env.INFINITE_SERVER_EVENT_SECRET
    await expect(helper.postInfiniteOutcome({ type: "download" })).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()

    // Cloudflare Workers have no process.env: the caller passes its binding values instead.
    await expect(
      helper.postInfiniteOutcome({
        type: "download",
        credentials: { secret: VECTORS.secret, sourceKey: "site_worker" }
      })
    ).resolves.toBe(true)
    expect(postedBody(fetchMock).headers.get(SERVER_LANE_SOURCE_KEY_HEADER)).toBe("site_worker")
  })

  it("never throws when Infinite is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      })
    )
    const helper = (await loadGenerated(outcomeHelperSource(BUILD))) as {
      postInfiniteOutcome: (input: Record<string, unknown>) => Promise<boolean>
    }
    await expect(helper.postInfiniteOutcome({ type: "purchase" })).resolves.toBe(false)
  })

  it("the Node twin posts the same shape on top of the generated Node module", async () => {
    const dir = mkdtempSync(join(tmpdir(), "instrument-lane-node-outcome-"))
    tempRoots.push(dir)
    writeFileSync(join(dir, "infinite-server-lane.js"), nodeLaneModuleSource(BUILD))
    const outcomePath = join(dir, "infinite-outcome.js")
    writeFileSync(outcomePath, nodeOutcomeHelperSource())
    const helper = (await import(pathToFileURL(outcomePath).href)) as {
      postInfiniteOutcome: (input: Record<string, unknown>) => Promise<boolean>
    }

    await expect(
      helper.postInfiniteOutcome({
        type: "purchase",
        path: "/checkout",
        eventId: "purchase:1",
        occurredAt: new Date(VECTORS.nowMs),
        visitKeyInputs: { clientIp: VECTORS.clientIp, userAgent: VECTORS.userAgent }
      })
    ).resolves.toBe(true)
    const body = JSON.parse(postedBody(fetchMock).body) as { properties: Record<string, string> }
    expect(body.properties).toEqual({ path: "/checkout", visitKey: VECTORS.visitKey })
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

  it("the Vercel middleware imports @vercel/functions, the lane module, and matches only documents", () => {
    const source = vercelMiddlewareSource(BUILD)
    expect(source).toContain('from "@vercel/functions"')
    expect(source).toContain('from "./lib/infinite-server-lane"')
    expect(source).toContain("export default function middleware")
    expect(source).toContain(
      `matcher: ["/((?!api/|_next/|_vercel/|${DEFAULT_INFINITE_COLLECT_PATH.slice(1)}|.*\\\\..*).*)"]`
    )
  })

  it("takes the collect-path default from the one place it is defined", () => {
    // The default moved to /infinite/ledger; a second copy of the old string here would be exactly
    // the drift the "interpolated from one place" design exists to prevent.
    expect(nonDocumentPrefixes(undefined)).toEqual(["/api/", "/_next/", "/_vercel/", DEFAULT_INFINITE_COLLECT_PATH])
    expect(DEFAULT_INFINITE_COLLECT_PATH).toBe("/infinite/ledger")
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

  it("the Next.js module follows the override too, and is byte-identical without one", () => {
    const origin = "https://api.infinite.fast"
    const withoutOverride = buildServerLaneModuleSource(BUILD)
    expect(withoutOverride).toBe(buildServerLaneModuleSource({ ...BUILD, apiOrigin: undefined }))
    expect(withoutOverride).toContain(`"${INFINITE_SERVER_EVENTS_DESTINATION}"`)
    expect(buildServerLaneModuleSource({ ...BUILD, apiOrigin: origin })).toContain(
      `"${infiniteServerEventsDestination(origin)}"`
    )
  })

  it("an overridden origin actually reaches the wire", async () => {
    const origin = "https://api.infinite.fast"
    const lane = (await loadGenerated(vercelLaneModuleSource({ ...BUILD, apiOrigin: origin }))) as {
      recordInfiniteDocumentRequest: (request: Request, credentials: unknown) => Promise<boolean>
    }
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }))
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

  it("the emitted JS helper carries no TypeScript syntax and names its own extension in the example", () => {
    const source = outcomeHelperSource(BUILD, { language: "js", extension: "mjs" })
    expect(source).not.toMatch(/\binterface\b/)
    expect(source).not.toMatch(/: Promise<|Record<string|as InfiniteVisitKeyInputs|: InfiniteAdMatch/)
    expect(source).toContain('from "../lib/infinite-outcome.mjs"')
    // The TS helper still shows the extensionless import (bundler-resolved).
    expect(outcomeHelperSource(BUILD)).toContain('from "../lib/infinite-outcome"')
  })

  describe("the JS helper, executed", () => {
    const originalEnv = { ...process.env }
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      process.env.INFINITE_SERVER_EVENT_SECRET = VECTORS.secret
      process.env.INFINITE_SITE_SOURCE_KEY = "site_test"
      fetchMock = vi.fn(async () => new Response("{}", { status: 202 }))
      vi.stubGlobal("fetch", fetchMock)
      vi.spyOn(Date, "now").mockReturnValue(VECTORS.nowMs)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      process.env = { ...originalEnv }
    })

    it("posts the SAME envelope as the TS helper — the strip changed types, never behavior", async () => {
      const helper = (await loadGenerated(
        outcomeHelperSource(BUILD, { language: "js", extension: "js" }),
        "js"
      )) as {
        postInfiniteOutcome: (input: Record<string, unknown>) => Promise<boolean>
        adMatchFromRequest: (request: { headers: Headers }, hashed?: { em?: string }) => Record<string, string>
      }
      await expect(
        helper.postInfiniteOutcome({
          type: "purchase",
          path: "/checkout",
          eventId: "purchase:cs_test_123",
          accountKey: "cus_123",
          occurredAt: new Date(VECTORS.nowMs),
          visitKeyInputs: documentRequest()
        })
      ).resolves.toBe(true)
      const posted = postedBody(fetchMock)
      const body = JSON.parse(posted.body) as { properties: Record<string, string> }
      expect(body.properties).toEqual({ path: "/checkout", visitKey: VECTORS.visitKey })
      expect(posted.headers.get(SERVER_LANE_SOURCE_KEY_HEADER)).toBe("site_test")

      const block = helper.adMatchFromRequest(
        documentRequest({ headers: { cookie: "_fbp=fb.1.1.987; _fbc=fb.1.1.abc" } }),
        { em: hashInfiniteEmail("founder@example.com") }
      )
      expect(block).toMatchObject({ fbc: "fb.1.1.abc", fbp: "fb.1.1.987", client_user_agent: VECTORS.userAgent })
    })
  })
})
