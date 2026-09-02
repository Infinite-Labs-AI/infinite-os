import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { INFINITE_SERVER_EVENTS_DESTINATION } from "../workspace-artifacts.js"

import { VECTORS } from "./helpers.test.js"
import { hashInfiniteEmail, signServerEventBody } from "./helpers.js"
import {
  NEXT_DOCUMENT_MATCHER,
  SERVER_LANE_FENCE_END,
  SERVER_LANE_FENCE_START,
  buildCreatedMiddlewareSource,
  buildFencedExportBlock,
  buildFencedImportBlock,
  buildServerLaneModuleSource
} from "./runtime-source.js"

const tempRoots: string[] = []

afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

/**
 * Write the generated TS module (with `next/server` stubbed) to a temp dir and import it for real —
 * vitest's module runner transforms the .ts on the way in, so the code that ships is what executes.
 */
async function loadGeneratedModule(input?: Parameters<typeof buildServerLaneModuleSource>[0]) {
  const dir = mkdtempSync(join(tmpdir(), "instrument-server-lane-runtime-"))
  tempRoots.push(dir)
  writeFileSync(
    join(dir, "next-server-stub.ts"),
    'export const NextResponse = { next: () => ({ kind: "next-response" }) }\n'
  )
  const source = buildServerLaneModuleSource(input).replaceAll('"next/server"', '"./next-server-stub.ts"')
  const modulePath = join(dir, `infinite-server-lane-${Date.now()}-${Math.random().toString(16).slice(2)}.ts`)
  writeFileSync(modulePath, source)
  return import(pathToFileURL(modulePath).href) as Promise<{
    withInfiniteServerLane: (handler?: unknown) => (request: unknown, event: unknown) => unknown
    recordInfiniteDocumentRequest: (request: unknown, event?: unknown) => void
    sendInfiniteServerEvent: (input: Record<string, unknown>) => Promise<boolean>
    infiniteVisitKey: (headers: Headers, secret?: string, nowMs?: number) => Promise<string | null>
  }>
}

function fakeRequest(overrides: {
  method?: string
  path?: string
  host?: string
  headers?: Record<string, string>
}) {
  const headers = new Headers({
    accept: "text/html,application/xhtml+xml",
    "user-agent": VECTORS.userAgent,
    "x-forwarded-for": `${VECTORS.clientIp}, 10.0.0.1`,
    referer: VECTORS.referrer,
    host: overrides.host ?? VECTORS.host,
    ...(overrides.headers ?? {})
  })
  return {
    method: overrides.method ?? "GET",
    headers,
    nextUrl: { pathname: overrides.path ?? VECTORS.path, host: overrides.host ?? VECTORS.host }
  }
}

function fakeEvent() {
  const tasks: Promise<unknown>[] = []
  return { tasks, waitUntil: (promise: Promise<unknown>) => tasks.push(promise) }
}

describe("generated Next.js module (executed with WebCrypto)", () => {
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

  it("posts the exact vector envelope, signed, via event.waitUntil, and passes the request through", async () => {
    const mod = await loadGeneratedModule()
    const event = fakeEvent()
    const handler = mod.withInfiniteServerLane()
    const response = handler(fakeRequest({}), event)
    expect(response).toEqual({ kind: "next-response" })
    expect(event.tasks).toHaveLength(1)
    await Promise.all(event.tasks)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe(INFINITE_SERVER_EVENTS_DESTINATION)
    expect(init.method).toBe("POST")
    expect(init.body).toBe(VECTORS.body)
    expect(init.headers["x-infinite-source-key"]).toBe("site_test")
    expect(init.headers["x-infinite-signature"]).toBe(VECTORS.bodySignature)
    expect(init.headers["x-infinite-signature"]).toBe(signServerEventBody(VECTORS.secret, String(init.body)))
    expect(init.headers["content-type"]).toBe("application/json")
  })

  it("wraps an existing handler and calls it with (request, event)", async () => {
    const mod = await loadGeneratedModule()
    const inner = vi.fn(() => ({ kind: "inner" }))
    const event = fakeEvent()
    const request = fakeRequest({})
    expect(mod.withInfiniteServerLane(inner)(request, event)).toEqual({ kind: "inner" })
    expect(inner).toHaveBeenCalledWith(request, event)
    await Promise.all(event.tasks)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["POST", fakeRequest({ method: "POST" })],
    ["HEAD", fakeRequest({ method: "HEAD" })],
    ["asset path", fakeRequest({ path: "/logo.png" })],
    ["/_next path", fakeRequest({ path: "/_next/static/x.js" })],
    ["/api path", fakeRequest({ path: "/api/health" })],
    ["non-html accept", fakeRequest({ headers: { accept: "*/*" } })],
    ["RSC accept", fakeRequest({ headers: { accept: "text/x-component" } })],
    ["prefetch purpose", fakeRequest({ headers: { purpose: "prefetch" } })],
    ["next-router-prefetch", fakeRequest({ headers: { "next-router-prefetch": "1" } })],
    // Privacy: DNT / Global-Privacy-Control are honored like the client pixel does.
    ["Do-Not-Track", fakeRequest({ headers: { dnt: "1" } })],
    ["Sec-GPC", fakeRequest({ headers: { "sec-gpc": "1" } })],
    ["localhost", fakeRequest({ host: "localhost:3000" })],
    ["loopback", fakeRequest({ host: "127.0.0.1" })]
  ])("skips %s", async (_label, request) => {
    const mod = await loadGeneratedModule()
    const event = fakeEvent()
    mod.recordInfiniteDocumentRequest(request, event)
    await Promise.all(event.tasks)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("records a normal document request when DNT/GPC are absent or explicitly disabled", async () => {
    const mod = await loadGeneratedModule()
    const event = fakeEvent()
    mod.recordInfiniteDocumentRequest(fakeRequest({ headers: { dnt: "0" } }), event)
    await Promise.all(event.tasks)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("stays dormant without the secret and never throws", async () => {
    delete process.env.INFINITE_SERVER_EVENT_SECRET
    const mod = await loadGeneratedModule()
    const event = fakeEvent()
    expect(() => mod.recordInfiniteDocumentRequest(fakeRequest({}), event)).not.toThrow()
    await Promise.all(event.tasks)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("respects a baked production-host allowlist and falls back to the baked source key", async () => {
    delete process.env.INFINITE_SITE_SOURCE_KEY
    const mod = await loadGeneratedModule({ siteSourceKey: "site_baked", productionHosts: ["example.com"] })
    const offList = fakeEvent()
    mod.recordInfiniteDocumentRequest(fakeRequest({ host: "preview.vercel.app" }), offList)
    await Promise.all(offList.tasks)
    expect(fetchMock).not.toHaveBeenCalled()

    const onList = fakeEvent()
    mod.recordInfiniteDocumentRequest(fakeRequest({ host: "example.com" }), onList)
    await Promise.all(onList.tasks)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
    expect(init.headers["x-infinite-source-key"]).toBe("site_baked")
  })

  it("never lets a failing fetch reach the request path", async () => {
    fetchMock.mockRejectedValue(new Error("network down"))
    const mod = await loadGeneratedModule()
    const event = fakeEvent()
    expect(() => mod.recordInfiniteDocumentRequest(fakeRequest({}), event)).not.toThrow()
    await expect(Promise.all(event.tasks)).resolves.toBeDefined()
  })

  it("sendInfiniteServerEvent reports an outcome with the same-lane visitKey from the request", async () => {
    const mod = await loadGeneratedModule()
    const ok = await mod.sendInfiniteServerEvent({
      eventName: "sign_up",
      eventId: "signup:42",
      accountKey: "42",
      occurredAt: new Date(VECTORS.nowMs),
      request: fakeRequest({})
    })
    expect(ok).toBe(true)
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }]
    const body = JSON.parse(init.body) as Record<string, unknown>
    expect(body).toEqual({
      eventId: "signup:42",
      eventName: "sign_up",
      occurredAt: new Date(VECTORS.nowMs).toISOString(),
      accountKey: "42",
      properties: { visitKey: VECTORS.visitKey }
    })
    expect(init.headers["x-infinite-signature"]).toBe(signServerEventBody(VECTORS.secret, init.body))
  })

  it("carries an adMatch block verbatim inside the signed body, and omits it when absent", async () => {
    const mod = await loadGeneratedModule()
    const adMatch = { em: hashInfiniteEmail("founder@example.com"), fbp: "fb.1.1755500000123.987654321" }
    await mod.sendInfiniteServerEvent({
      eventName: "purchase",
      eventId: "purchase:1",
      occurredAt: new Date(VECTORS.nowMs),
      adMatch
    })
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string; headers: Record<string, string> }]
    expect((JSON.parse(init.body) as { adMatch: unknown }).adMatch).toEqual(adMatch)
    // Signed with the rest of the body — the relay can trust it because the secret signed it.
    expect(init.headers["x-infinite-signature"]).toBe(signServerEventBody(VECTORS.secret, init.body))
    expect(init.body).not.toContain("founder@example.com")

    fetchMock.mockClear()
    await mod.sendInfiniteServerEvent({ eventName: "sign_up", eventId: "signup:1" })
    const [, plain] = fetchMock.mock.calls[0] as [string, { body: string }]
    expect(plain.body).not.toContain("adMatch")
  })

  it("infiniteVisitKey matches the Node recipe vector", async () => {
    const mod = await loadGeneratedModule()
    expect(await mod.infiniteVisitKey(fakeRequest({}).headers, VECTORS.secret, VECTORS.nowMs)).toBe(VECTORS.visitKey)
  })
})

describe("generated sources (static)", () => {
  it("the module is Edge-safe: WebCrypto only, secrets from env, contract constants baked", () => {
    const source = buildServerLaneModuleSource()
    expect(source).not.toMatch(/from "node:/)
    expect(source).toContain("crypto.subtle")
    expect(source).toContain("process.env.INFINITE_SERVER_EVENT_SECRET")
    expect(source).toContain("process.env.INFINITE_SITE_SOURCE_KEY")
    expect(source).toContain(INFINITE_SERVER_EVENTS_DESTINATION)
    expect(source).toContain('"x-infinite-source-key"')
    expect(source).toContain('"x-infinite-signature"')
    expect(source).toContain('"site_document_request"')
    expect(source).toContain("Managed by Infinite")
    expect(source.startsWith("// Managed by Infinite")).toBe(true)
    // No secret value can be baked: the only literal after SOURCE_KEY's env read is the empty fallback.
    expect(source).toContain('process.env.INFINITE_SITE_SOURCE_KEY || ""')
  })

  it("the created middleware uses the standard document matcher inside the fence", () => {
    const source = buildCreatedMiddlewareSource({ moduleImportPath: "./lib/infinite-server-lane" })
    expect(source).toContain(SERVER_LANE_FENCE_START)
    expect(source).toContain(SERVER_LANE_FENCE_END)
    expect(source).toContain('import { withInfiniteServerLane } from "./lib/infinite-server-lane"')
    expect(source).toContain("export default withInfiniteServerLane()")
    expect(source).toContain(`matcher: [${JSON.stringify(NEXT_DOCUMENT_MATCHER)}]`)
    // The matcher literal survives as a JS string that yields the intended regex.
    expect(NEXT_DOCUMENT_MATCHER).toBe("/((?!_next/static|_next/image|favicon.ico|api|.*\\..*).*)")
  })

  it("fenced blocks are self-delimiting", () => {
    expect(buildFencedImportBlock({ moduleImportPath: "./lib/infinite-server-lane" })).toBe(
      [
        SERVER_LANE_FENCE_START,
        'import { withInfiniteServerLane } from "./lib/infinite-server-lane"',
        SERVER_LANE_FENCE_END,
        ""
      ].join("\n")
    )
    expect(buildFencedExportBlock({ innerIdentifier: "middleware" })).toContain(
      "export default withInfiniteServerLane(middleware)"
    )
  })
})
