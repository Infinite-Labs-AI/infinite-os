import { describe, expect, it, vi } from "vitest"

import { VERIFY_USER_AGENT } from "../server-lane/verify.js"

import {
  DesktopBridgeBackend,
  InfiniteCloudBackend,
  VERIFY_BUDGET_MS,
  VERIFY_POLL_INTERVAL_MS,
  verifyLanes,
  type VerifyLane
} from "./verify.js"

const ALL_LANES: VerifyLane[] = ["infinite", "ga4", "posthog", "meta", "server_lane"]

function clock(startMs = 1_000_000) {
  let current = startMs
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms
    }
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("InfiniteCloudBackend", () => {
  it("polls POST /api/analytics/verify with the bearer token until a lane is verified", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const responses = [
      jsonResponse(200, { lanes: { ga4: { state: "no_receipt" }, infinite: { state: "no_receipt" } } }),
      jsonResponse(200, {
        lanes: {
          ga4: { state: "verified", receiptAt: "2026-09-02T10:00:07.000Z" },
          infinite: { state: "verified", receiptAt: "2026-09-02T10:00:06.000Z" }
        }
      })
    ]
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return responses.shift() ?? jsonResponse(200, { lanes: {} })
    })
    const time = clock()
    const backend = new InfiniteCloudBackend({
      origin: "https://api.ultima.inc",
      token: "tok_123",
      engineProjectId: "ws_1",
      fetch: fetchImpl as unknown as typeof fetch,
      now: time.now,
      sleep: time.sleep
    })
    const result = await backend.verify({ url: "https://example.com/", since: "2026-09-02T10:00:00.000Z", lanes: ["infinite", "ga4"] })
    expect(result).toEqual({
      ga4: { state: "verified", receiptAt: "2026-09-02T10:00:07.000Z" },
      infinite: { state: "verified", receiptAt: "2026-09-02T10:00:06.000Z" }
    })
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe("https://api.ultima.inc/api/analytics/verify")
    expect(calls[0].init.method).toBe("POST")
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok_123")
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      engineProjectId: "ws_1",
      url: "https://example.com/",
      since: "2026-09-02T10:00:00.000Z",
      lanes: ["infinite", "ga4"]
    })
  })

  it("gives up honestly after the 60 s budget at 3 s intervals with no_receipt", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { lanes: { ga4: { state: "no_receipt" } } }))
    const time = clock()
    const backend = new InfiniteCloudBackend({
      origin: "https://api.ultima.inc",
      token: "tok",
      engineProjectId: "ws_1",
      fetch: fetchImpl as unknown as typeof fetch,
      now: time.now,
      sleep: time.sleep
    })
    const result = await backend.verify({ url: "https://example.com/", since: "s", lanes: ["ga4"] })
    expect(result.ga4).toEqual({ state: "no_receipt", causes: expect.arrayContaining([expect.stringContaining("60")]) })
    expect(VERIFY_BUDGET_MS).toBe(60_000)
    expect(VERIFY_POLL_INTERVAL_MS).toBe(3_000)
    // One call at t=0, then one every 3 s up to and including t=60 s — never past the budget.
    expect(fetchImpl.mock.calls.length).toBe(VERIFY_BUDGET_MS / VERIFY_POLL_INTERVAL_MS + 1)
  })
})

describe("InfiniteCloudBackend entitlement gate (requireActiveSubscriptionOr402)", () => {
  const input = { url: "https://example.com/", since: "s", lanes: ["ga4", "infinite"] as VerifyLane[] }
  function make(fetchImpl: () => Promise<Response>) {
    return new InfiniteCloudBackend({ origin: "https://api.ultima.inc", token: "tok", engineProjectId: "proj_1", fetch: fetchImpl as unknown as typeof fetch, ...clock() })
  }

  it("402 entitlement_required → not_verifiable 'subscription required', no retries, never no_receipt", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(402, { error: "entitlement_required", code: "NO_PLATFORM_SUBSCRIPTION", feature: "platform", action: { type: "upgrade" } })
    )
    const result = await make(fetchImpl).verify(input)
    expect(result).toEqual({
      ga4: { state: "not_verifiable", reason: "subscription required — complete onboarding in Infinite Desktop" },
      infinite: { state: "not_verifiable", reason: "subscription required — complete onboarding in Infinite Desktop" }
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe("DesktopBridgeBackend", () => {
  const input = { url: "https://example.com/", since: "2026-09-02T10:00:00.000Z", lanes: ["ga4", "infinite"] as VerifyLane[] }
  function make(fetchImpl: () => Promise<Response>) {
    return new DesktopBridgeBackend({
      bridgeUrl: "http://127.0.0.1:54321",
      token: "bridge_tok",
      fetch: fetchImpl as unknown as typeof fetch,
      ...clock()
    })
  }

  it("polls the app's loopback bridge with the LOCAL bearer and no engineProjectId — the desktop supplies it", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const responses = [
      jsonResponse(200, { lanes: { ga4: { state: "no_receipt" }, infinite: { state: "no_receipt" } } }),
      jsonResponse(200, {
        lanes: {
          ga4: { state: "verified", receiptAt: "2026-09-02T10:00:07.000Z" },
          infinite: { state: "verified", receiptAt: "2026-09-02T10:00:06.000Z" }
        }
      })
    ]
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return responses.shift() ?? jsonResponse(200, { lanes: {} })
    })
    const time = clock()
    const backend = new DesktopBridgeBackend({
      bridgeUrl: "http://127.0.0.1:54321",
      token: "bridge_tok",
      fetch: fetchImpl as unknown as typeof fetch,
      now: time.now,
      sleep: time.sleep
    })
    const result = await backend.verify(input)
    expect(result).toEqual({
      ga4: { state: "verified", receiptAt: "2026-09-02T10:00:07.000Z" },
      infinite: { state: "verified", receiptAt: "2026-09-02T10:00:06.000Z" }
    })
    expect(calls[0].url).toBe("http://127.0.0.1:54321/v1/analytics/verify")
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer bridge_tok")
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
    expect(body).toEqual({
      protocolVersion: 1,
      url: "https://example.com/",
      since: "2026-09-02T10:00:00.000Z",
      lanes: ["ga4", "infinite"]
    })
    // The CLI never names a workspace on this route: the desktop's ACTIVE one is the only answer.
    expect(body.engineProjectId).toBeUndefined()
  })

  it("gives up with no_receipt — never a fake verified — when the lanes stay quiet", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { lanes: { ga4: { state: "no_receipt" }, infinite: { state: "no_receipt" } } }))
    const result = await make(fetchImpl).verify(input)
    expect(result.ga4).toEqual({ state: "no_receipt", causes: expect.arrayContaining([expect.stringContaining("60")]) })
    expect(fetchImpl.mock.calls.length).toBe(VERIFY_BUDGET_MS / VERIFY_POLL_INTERVAL_MS + 1)
  })
})

describe("verifyLanes", () => {
  it("loads the page once as the verify agent, merges backends, and never invents a receipt", async () => {
    const pageLoads: string[] = []
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      pageLoads.push(`${String(url)} ${(init?.headers as Record<string, string>)["user-agent"]}`)
      return new Response("<html></html>", { status: 200 })
    })
    const cloud = {
      name: "stub-cloud",
      lanes: ["infinite", "ga4"] as VerifyLane[],
      verify: async () => ({
        infinite: { state: "verified" as const, receiptAt: "2026-09-02T10:00:05.000Z" },
        ga4: { state: "no_receipt" as const, causes: ["not deployed yet"] }
      })
    }
    const time = clock(Date.parse("2026-09-02T10:00:00.000Z"))
    const result = await verifyLanes({
      url: "https://example.com/",
      lanes: ALL_LANES,
      backends: [cloud],
      fetch: fetchImpl as unknown as typeof fetch,
      now: time.now,
      sleep: time.sleep
    })
    expect(pageLoads).toEqual([`https://example.com/ ${VERIFY_USER_AGENT}`])
    expect(result.siteStatus).toBe(200)
    expect(result.since).toBe("2026-09-02T09:59:55.000Z")
    expect(result.lanes.infinite).toEqual({ state: "verified", receiptAt: "2026-09-02T10:00:05.000Z" })
    expect(result.lanes.ga4).toEqual({ state: "no_receipt", causes: ["not deployed yet"] })
    // The Meta lane is no longer a flat stub: it runs the credential-free delivery check against
    // the page body this step already fetched. That body carries no `fbq('init', …)`, so the honest
    // answer is "there is no pixel here to check" — and, crucially, no probe was fired for one.
    expect(result.lanes.meta).toEqual({
      state: "not_verifiable",
      reason: "no fbq('init', …) was found on the loaded page, so there is no Meta pixel to check"
    })
    expect(result.lanes.posthog).toEqual({ state: "not_verifiable", reason: "no backend can read this lane back" })
    expect(result.lanes.server_lane).toEqual({ state: "not_verifiable", reason: "no backend can read this lane back" })
  })
})
