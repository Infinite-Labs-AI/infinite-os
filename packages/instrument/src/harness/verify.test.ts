import { describe, expect, it, vi } from "vitest"

import { VERIFY_USER_AGENT } from "../server-lane/verify.js"

import {
  DESKTOP_UPDATE_REQUIRED_REASON,
  DesktopBridgeBackend,
  InfiniteCloudBackend,
  NoneBackend,
  PosthogQueryBackend,
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

describe("NoneBackend", () => {
  it("answers every lane as not verifiable and points at the desktop CLI", async () => {
    const backend = new NoneBackend()
    const result = await backend.verify({ url: "https://example.com", since: "2026-09-02T10:00:00.000Z", lanes: ALL_LANES })
    for (const lane of ALL_LANES) {
      expect(result[lane]).toEqual({
        state: "not_verifiable",
        reason: "run infinite analytics from the desktop CLI to verify"
      })
    }
  })
})

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

  it("reports a rejected session, a missing route, an unreachable cloud, and a receipt-less verified honestly", async () => {
    const make = (fetchImpl: () => Promise<Response>) =>
      new InfiniteCloudBackend({
        origin: "https://api.ultima.inc",
        token: "tok",
        engineProjectId: "ws_1",
        fetch: fetchImpl as unknown as typeof fetch,
        ...clock()
      })
    const input = { url: "https://example.com/", since: "s", lanes: ["ga4"] as VerifyLane[] }

    expect((await make(async () => new Response("", { status: 401 })).verify(input)).ga4).toEqual({
      state: "not_verifiable",
      reason: "the cloud rejected this session (HTTP 401)"
    })
    expect((await make(async () => jsonResponse(402, { error: "subscription_required", message: "Subscribe to continue." })).verify(input)).ga4).toEqual({
      state: "not_verifiable",
      reason: "subscription required — complete onboarding in Infinite Desktop"
    })
    expect((await make(async () => new Response("", { status: 404 })).verify(input)).ga4).toEqual({
      state: "not_verifiable",
      reason: "the cloud verify route is not available yet (HTTP 404)"
    })
    expect(
      (await make(async () => {
        throw new Error("ECONNREFUSED")
      }).verify(input)).ga4
    ).toEqual({ state: "not_verifiable", reason: "the cloud was unreachable (ECONNREFUSED)" })
    expect((await make(async () => jsonResponse(200, { lanes: { ga4: { state: "verified" } } })).verify(input)).ga4).toEqual({
      state: "not_verifiable",
      reason: "the cloud answered verified without a receipt timestamp"
    })
    expect((await make(async () => jsonResponse(200, { lanes: { ga4: { state: "not_verifiable", reason: "no GA4 property linked" } } })).verify(input)).ga4).toEqual({
      state: "not_verifiable",
      reason: "no GA4 property linked"
    })
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

  it("503 subscription_check_unavailable keeps the retry loop, then says 'subscription check unavailable, try again'", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { error: "subscription_check_unavailable", retryable: true }))
    const result = await make(fetchImpl).verify(input)
    expect(result.ga4).toEqual({ state: "not_verifiable", reason: "subscription check unavailable, try again" })
    expect(result.infinite).toEqual({ state: "not_verifiable", reason: "subscription check unavailable, try again" })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(result)).not.toContain("route was unavailable")
  })

  it("typed 400s are quoted verbatim and never retried", async () => {
    const hostFetch = vi.fn(async () => jsonResponse(400, { error: "host_not_registered", reason: "example.com is not a production host of this workspace" }))
    const host = await make(hostFetch).verify(input)
    expect(host.ga4).toEqual({ state: "not_verifiable", reason: "the cloud rejected the request: host_not_registered — example.com is not a production host of this workspace" })
    expect(hostFetch).toHaveBeenCalledTimes(1)
    const invalid = await make(async () => jsonResponse(400, { error: "invalid_request", reason: "lanes must be non-empty" })).verify(input)
    expect(invalid.infinite).toEqual({ state: "not_verifiable", reason: "the cloud rejected the request: invalid_request — lanes must be non-empty" })
  })

  it("429 honours Retry-After (capped at 30 s) within the budget, then reads 'rate limited'", async () => {
    const time = clock()
    const responses = [
      new Response("", { status: 429, headers: { "retry-after": "10" } }),
      jsonResponse(200, { lanes: { ga4: { state: "verified", receiptAt: "2026-09-02T10:00:20.000Z" }, infinite: { state: "verified", receiptAt: "2026-09-02T10:00:20.000Z" } } })
    ]
    const fetchImpl = vi.fn(async () => responses.shift() ?? new Response("", { status: 429, headers: { "retry-after": "10" } }))
    const backend = new InfiniteCloudBackend({ origin: "https://api.ultima.inc", token: "tok", engineProjectId: "proj_1", fetch: fetchImpl as unknown as typeof fetch, now: time.now, sleep: time.sleep })
    const start = time.now()
    const result = await backend.verify(input)
    expect(result.ga4).toEqual({ state: "verified", receiptAt: "2026-09-02T10:00:20.000Z" })
    expect(time.now() - start).toBe(10_000)
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    const forever = clock()
    const always = vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": "120" } }))
    const limited = await new InfiniteCloudBackend({ origin: "https://api.ultima.inc", token: "tok", engineProjectId: "proj_1", fetch: always as unknown as typeof fetch, now: forever.now, sleep: forever.sleep }).verify(input)
    expect(limited.ga4).toEqual({ state: "not_verifiable", reason: "rate limited by the cloud; try again in a minute" })
    // 120 s is capped to 30 s per wait, and the 60 s budget ends the loop after two waits.
    expect(always.mock.calls.length).toBeLessThanOrEqual(3)
    expect(forever.now() - 1_000_000).toBeLessThanOrEqual(60_000)
  })

  it("a plain 503 with no body still reads as the route being unavailable", async () => {
    const result = await make(async () => new Response("", { status: 503 })).verify(input)
    expect(result.ga4).toEqual({ state: "not_verifiable", reason: "the cloud verify route was unavailable (HTTP 503)" })
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

  it("409 not_ready names the exact blocker and never retries", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { error: "not_ready", state: "subscription_required", message: "finish onboarding" })
    )
    const result = await make(fetchImpl).verify(input)
    expect(result.ga4).toEqual({
      state: "not_verifiable",
      reason: "Infinite Desktop is not ready (subscription_required) — complete onboarding"
    })
    expect(result.infinite).toEqual(result.ga4)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("503 capability_unavailable says update the app; a FORWARDED 503 subscription_check_unavailable still retries", async () => {
    const stale = vi.fn(async () => jsonResponse(503, { error: { code: "capability_unavailable", message: "update" } }))
    expect((await make(stale).verify(input)).ga4).toEqual({
      state: "not_verifiable",
      reason: DESKTOP_UPDATE_REQUIRED_REASON
    })
    expect(stale).toHaveBeenCalledTimes(1)

    const checkDown = vi.fn(async () => jsonResponse(503, { error: "subscription_check_unavailable", retryable: true }))
    expect((await make(checkDown).verify(input)).ga4).toEqual({
      state: "not_verifiable",
      reason: "subscription check unavailable, try again"
    })
    expect(checkDown).toHaveBeenCalledTimes(3)
  })

  it("decodes the cloud shapes the bridge forwards verbatim: 402, typed 400s, and 429 Retry-After", async () => {
    expect(
      (await make(async () => jsonResponse(402, { error: "entitlement_required", code: "NO_PLATFORM_SUBSCRIPTION" })).verify(input)).ga4
    ).toEqual({ state: "not_verifiable", reason: "subscription required — complete onboarding in Infinite Desktop" })

    expect(
      (await make(async () => jsonResponse(400, { error: "host_not_registered", reason: "example.com is not a production host of this workspace" })).verify(input)).ga4
    ).toEqual({
      state: "not_verifiable",
      reason: "the Infinite app rejected the request: host_not_registered — example.com is not a production host of this workspace"
    })

    const time = clock()
    const responses = [
      new Response("", { status: 429, headers: { "retry-after": "10" } }),
      jsonResponse(200, { lanes: { ga4: { state: "verified", receiptAt: "2026-09-02T10:00:20.000Z" }, infinite: { state: "verified", receiptAt: "2026-09-02T10:00:20.000Z" } } })
    ]
    const limited = vi.fn(async () => responses.shift() ?? jsonResponse(200, { lanes: {} }))
    const start = time.now()
    const rateLimited = await new DesktopBridgeBackend({
      bridgeUrl: "http://127.0.0.1:54321",
      token: "bridge_tok",
      fetch: limited as unknown as typeof fetch,
      now: time.now,
      sleep: time.sleep
    }).verify(input)
    expect(rateLimited.ga4).toEqual({ state: "verified", receiptAt: "2026-09-02T10:00:20.000Z" })
    expect(time.now() - start).toBe(10_000)
  })

  it("quotes a bridge PROTOCOL fault ({error:{code,message}}) and reports a rejected token / closed app honestly", async () => {
    expect(
      (await make(async () => jsonResponse(400, { error: { code: "invalid_request", message: "lanes must be a non-empty array." } })).verify(input)).ga4
    ).toEqual({
      state: "not_verifiable",
      reason: "the Infinite app rejected the request: invalid_request — lanes must be a non-empty array."
    })

    expect((await make(async () => new Response("", { status: 401 })).verify(input)).ga4).toEqual({
      state: "not_verifiable",
      reason: "the Infinite app rejected this terminal's bridge credentials (HTTP 401) — restart the app and re-run"
    })

    expect((await make(async () => new Response("", { status: 404 })).verify(input)).ga4).toEqual({
      state: "not_verifiable",
      reason: DESKTOP_UPDATE_REQUIRED_REASON
    })

    expect(
      (await make(async () => {
        throw new Error("ECONNREFUSED")
      }).verify(input)).ga4
    ).toEqual({ state: "not_verifiable", reason: "the Infinite app was unreachable (ECONNREFUSED)" })
  })

  it("gives up with no_receipt — never a fake verified — when the lanes stay quiet", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { lanes: { ga4: { state: "no_receipt" }, infinite: { state: "no_receipt" } } }))
    const result = await make(fetchImpl).verify(input)
    expect(result.ga4).toEqual({ state: "no_receipt", causes: expect.arrayContaining([expect.stringContaining("60")]) })
    expect(fetchImpl.mock.calls.length).toBe(VERIFY_BUDGET_MS / VERIFY_POLL_INTERVAL_MS + 1)
  })
})

describe("PosthogQueryBackend", () => {
  it("is not verifiable without a query key", async () => {
    const backend = new PosthogQueryBackend({ apiHost: "https://us.i.posthog.com", queryKey: undefined, ...clock() })
    const result = await backend.verify({ url: "https://example.com/", since: "s", lanes: ["posthog"] })
    expect(result.posthog).toEqual({ state: "not_verifiable", reason: "no query key" })
  })

  it("runs the HogQL pageview query on the region's app host with the personal key and returns the receipt", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const responses = [jsonResponse(200, { results: [] }), jsonResponse(200, { results: [["2026-09-02T10:00:09.000000Z"]] })]
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return responses.shift() ?? jsonResponse(200, { results: [] })
    })
    const backend = new PosthogQueryBackend({
      apiHost: "https://eu.i.posthog.com",
      queryKey: "phx_secret",
      fetch: fetchImpl as unknown as typeof fetch,
      ...clock()
    })
    const result = await backend.verify({ url: "https://example.com/", since: "2026-09-02T10:00:00.000Z", lanes: ["posthog"] })
    expect(result.posthog).toEqual({ state: "verified", receiptAt: "2026-09-02T10:00:09.000Z" })
    expect(calls[0].url).toBe("https://eu.posthog.com/api/projects/@current/query/")
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer phx_secret")
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.query.kind).toBe("HogQLQuery")
    expect(body.query.query).toContain("event = '$pageview'")
    expect(body.query.query).toContain("limit 1")
    expect(body.query.values).toEqual({ since: "2026-09-02T10:00:00.000Z" })
  })

  it("reports a rejected key and an empty budget honestly", async () => {
    const rejected = new PosthogQueryBackend({
      apiHost: "https://us.i.posthog.com",
      queryKey: "phx_bad",
      fetch: (async () => new Response("", { status: 401 })) as unknown as typeof fetch,
      ...clock()
    })
    expect((await rejected.verify({ url: "u", since: "s", lanes: ["posthog"] })).posthog).toEqual({
      state: "not_verifiable",
      reason: "PostHog rejected the query key (HTTP 401) — it needs the Query Read scope"
    })
    const empty = new PosthogQueryBackend({
      apiHost: "https://us.i.posthog.com",
      queryKey: "phx_ok",
      fetch: (async () => jsonResponse(200, { results: [] })) as unknown as typeof fetch,
      ...clock()
    })
    expect((await empty.verify({ url: "u", since: "s", lanes: ["posthog"] })).posthog).toMatchObject({ state: "no_receipt" })
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
    expect(result.lanes.meta).toEqual({
      state: "not_verifiable",
      reason: "Meta has no install-time read-back; open Events Manager → Test Events"
    })
    expect(result.lanes.posthog).toEqual({ state: "not_verifiable", reason: "no backend can read this lane back" })
    expect(result.lanes.server_lane).toEqual({ state: "not_verifiable", reason: "no backend can read this lane back" })
  })

  it("names an unreachable site instead of polling", async () => {
    const result = await verifyLanes({
      url: "https://down.example/",
      lanes: ["ga4"],
      backends: [],
      fetch: (async () => {
        throw new Error("ENOTFOUND")
      }) as unknown as typeof fetch,
      ...clock()
    })
    expect(result.siteStatus).toBeNull()
    expect(result.lanes.ga4).toEqual({ state: "not_verifiable", reason: expect.stringContaining("ENOTFOUND") })
  })
})
