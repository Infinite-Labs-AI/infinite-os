import { describe, expect, it, vi } from "vitest"

import { INFINITE_SERVER_LANE_RECEIPT_URL } from "../workspace-artifacts.js"

import { VECTORS } from "./helpers.test.js"
import { classifyUserAgent, hmacHex, isDocumentPath } from "./helpers.js"
import {
  VERIFY_USER_AGENT,
  parseReceipt,
  receiptRequestSignature,
  renderServerLaneVerify,
  verifyServerLane
} from "./verify.js"

const SITE = "https://example.com/pricing"

/** A fetch double: the site GET answers `siteStatus`; receipt GETs walk through `receipts` in order. */
function fakeFetch(input: {
  siteStatus?: number | Error
  receipts: Array<{ status: number; body?: unknown } | Error>
}) {
  const calls: Array<{ url: string; init: RequestInit & { headers: Record<string, string> } }> = []
  let receiptIndex = 0
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init: init as RequestInit & { headers: Record<string, string> } })
    if (url === SITE) {
      if (input.siteStatus instanceof Error) throw input.siteStatus
      return new Response("<html></html>", { status: input.siteStatus ?? 200 })
    }
    const step = input.receipts[Math.min(receiptIndex, input.receipts.length - 1)]!
    receiptIndex += 1
    if (step instanceof Error) throw step
    return new Response(step.body === undefined ? null : JSON.stringify(step.body), { status: step.status })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

const fastClock = () => {
  let time = 1_755_500_000_000
  return { now: () => time, sleep: async (ms: number) => void (time += ms) }
}

describe("verify --server-lane", () => {
  it("PASS: loads the page as self-identified automation, polls the receipt with the source headers, reports the count", async () => {
    const clock = fastClock()
    const { impl, calls } = fakeFetch({
      receipts: [
        { status: 200, body: { received: 0, lastPath: null, lastReceivedAt: null } },
        { status: 200, body: { received: 1, lastPath: "/pricing", lastReceivedAt: "2026-08-18T10:00:00.000Z" } }
      ]
    })
    const result = await verifyServerLane({
      url: SITE,
      secret: VECTORS.secret,
      sourceKey: "site_test",
      fetch: impl,
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 1000,
      budgetMs: 10_000
    })
    expect(result.ok).toBe(true)
    expect(result.received).toBe(1)
    expect(result.lastPath).toBe("/pricing")
    expect(result.lastReceivedAt).toBe("2026-08-18T10:00:00.000Z")
    expect(result.siteStatus).toBe(200)

    // 1. the page load
    const page = calls[0]!
    expect(page.url).toBe(SITE)
    expect(page.init.headers["user-agent"]).toBe(VERIFY_USER_AGENT)
    expect(page.init.headers.accept).toContain("text/html")
    // 2. the receipt polls: same source headers, signature over the empty string, since= before the load
    const receipt = calls[1]!
    expect(receipt.url.startsWith(`${INFINITE_SERVER_LANE_RECEIPT_URL}?since=`)).toBe(true)
    const since = decodeURIComponent(receipt.url.split("since=")[1]!)
    expect(new Date(since).getTime()).toBeLessThan(clock.now())
    expect(receipt.init.headers["x-infinite-source-key"]).toBe("site_test")
    // The signature covers the raw query string — the exact bytes after "?" — as the receipt route verifies it.
    const rawQuery = receipt.url.slice(receipt.url.indexOf("?") + 1)
    expect(rawQuery).toBe(`since=${encodeURIComponent(since)}`)
    expect(receipt.init.headers["x-infinite-signature"]).toBe(hmacHex(VECTORS.secret, rawQuery))
    expect(calls).toHaveLength(3)
    expect(renderServerLaneVerify(result)).toContain("PASS — Infinite received 1 server-lane event")
  })

  it("FAIL after the budget when the receipt stays empty, listing the likely causes", async () => {
    const clock = fastClock()
    const { impl, calls } = fakeFetch({ receipts: [{ status: 200, body: { received: 0 } }] })
    const result = await verifyServerLane({
      url: SITE,
      secret: VECTORS.secret,
      sourceKey: "site_test",
      fetch: impl,
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 2000,
      budgetMs: 6000
    })
    expect(result.ok).toBe(false)
    expect(result.failure).toBe("no_receipt")
    expect(result.causes[0]).toMatch(/No middleware\/proxy is recording/)
    expect(result.causes.join("\n")).toMatch(/verified production hosts/)
    expect(result.causes.join("\n")).toMatch(/assets\/API routes/)
    // page + 4 polls (t = 0, 2000, 4000, 6000 — the last lands exactly on the budget)
    expect(calls.length).toBe(5)
    const rendered = renderServerLaneVerify(result)
    expect(rendered).toContain("FAIL — no server-lane receipt arrived.")
    expect(rendered).toContain("Most likely cause:")
  })

  // ── The check must never invent a visitor ───────────────────────────────────────────────────
  // verify used to send a real Chrome user agent, so every run wrote ONE fabricated human visit
  // into the customer's own analytics — on the lane whose honesty is the product, and silently on
  // the first run. The row still exists (proving the middleware runs is the entire point, and
  // hiding a real request would be its own lie); it is now filed as automation. Both halves of
  // that are pinned here against the SAME helpers the generated middleware interpolates.
  describe("the probe identifies itself as automation", () => {
    it("classifies as automation, so the recorded row is a flagged agent and not a visit", () => {
      expect(classifyUserAgent(VERIFY_USER_AGENT)).toBe("automation")
      expect(VERIFY_USER_AGENT.startsWith("infinite-tag-verify/")).toBe(true)
      expect(VERIFY_USER_AGENT).toContain("+https://infinite.fast")
      expect(/Mozilla|Chrome|Safari|AppleWebKit/i.test(VERIFY_USER_AGENT)).toBe(false)
    })

    it("still satisfies the customer middleware's document gate, or no receipt could ever arrive", async () => {
      const clock = fastClock()
      const { impl, calls } = fakeFetch({ receipts: [{ status: 200, body: { received: 1 } }] })
      await verifyServerLane({
        url: SITE,
        secret: VECTORS.secret,
        sourceKey: "site_test",
        fetch: impl,
        now: clock.now,
        sleep: clock.sleep
      })
      const page = calls[0]!
      // isDocumentRequest(): GET, Accept text/html, extensionless non-API path, and NOT a prefetch.
      // The family is a recorded property, never a gate — which is exactly why an honest user agent
      // costs nothing here.
      expect(page.init.method).toBe("GET")
      expect(page.init.headers.accept).toContain("text/html")
      expect(isDocumentPath(new URL(SITE).pathname)).toBe(true)
      expect(page.init.headers.purpose).toBeUndefined()
      expect(page.init.headers["sec-purpose"]).toBeUndefined()
      expect(page.init.headers["next-router-prefetch"]).toBeUndefined()
    })

    it("names bot protection first when the edge refuses a self-identified monitor", async () => {
      const clock = fastClock()
      const { impl } = fakeFetch({ siteStatus: 403, receipts: [{ status: 200, body: { received: 0 } }] })
      const result = await verifyServerLane({
        url: SITE,
        secret: VECTORS.secret,
        sourceKey: "site_test",
        fetch: impl,
        now: clock.now,
        sleep: clock.sleep,
        pollIntervalMs: 1000,
        budgetMs: 1000
      })
      expect(result.failure).toBe("no_receipt")
      expect(result.causes[0]).toContain("edge or WAF answered 403")
      expect(result.causes[0]).toContain(VERIFY_USER_AGENT)
    })
  })

  it("FAIL immediately with the wrong-secret cause on 401/403", async () => {
    const clock = fastClock()
    const { impl, calls } = fakeFetch({ receipts: [{ status: 403, body: { error: "invalid_signature" } }] })
    const result = await verifyServerLane({
      url: SITE,
      secret: "wrong",
      sourceKey: "site_test",
      fetch: impl,
      now: clock.now,
      sleep: clock.sleep
    })
    expect(result.ok).toBe(false)
    expect(result.failure).toBe("unauthorized")
    expect(result.causes[0]).toMatch(/rejected the source key \+ secret pair/)
    expect(calls).toHaveLength(2)
  })

  it("FAIL with receipt_unavailable after three non-OK answers (endpoint not live yet)", async () => {
    const clock = fastClock()
    const { impl } = fakeFetch({ receipts: [{ status: 404 }] })
    const result = await verifyServerLane({
      url: SITE,
      secret: VECTORS.secret,
      sourceKey: "site_test",
      fetch: impl,
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 100
    })
    expect(result.failure).toBe("receipt_unavailable")
    expect(result.causes[0]).toContain("answered 404")
  })

  it("FAIL when the site itself is unreachable", async () => {
    const { impl, calls } = fakeFetch({ siteStatus: new Error("getaddrinfo ENOTFOUND"), receipts: [] })
    const result = await verifyServerLane({ url: SITE, secret: VECTORS.secret, sourceKey: "site_test", fetch: impl })
    expect(result.failure).toBe("site_unreachable")
    expect(result.causes[0]).toContain("getaddrinfo ENOTFOUND")
    expect(calls).toHaveLength(1)
  })

  it("a non-2xx page still gets polled (middleware runs before routing) but leads the causes on FAIL", async () => {
    const clock = fastClock()
    const { impl } = fakeFetch({ siteStatus: 404, receipts: [{ status: 200, body: { received: 0 } }] })
    const result = await verifyServerLane({
      url: SITE,
      secret: VECTORS.secret,
      sourceKey: "site_test",
      fetch: impl,
      now: clock.now,
      sleep: clock.sleep,
      pollIntervalMs: 1000,
      budgetMs: 1000
    })
    expect(result.siteStatus).toBe(404)
    expect(result.failure).toBe("no_receipt")
    expect(result.causes[0]).toContain("HTTP 404")
  })

  it("requires the secret and the source key without touching the network", async () => {
    const { impl, calls } = fakeFetch({ receipts: [] })
    const noSecret = await verifyServerLane({ url: SITE, secret: undefined, sourceKey: "site_test", fetch: impl })
    expect(noSecret.failure).toBe("missing_secret")
    expect(noSecret.causes[0]).toContain("INFINITE_SERVER_EVENT_SECRET")
    const noKey = await verifyServerLane({ url: SITE, secret: "s", sourceKey: "", fetch: impl })
    expect(noKey.failure).toBe("missing_source_key")
    expect(calls).toHaveLength(0)
  })

  it("receiptRequestSignature is the ONE place the receipt signing lives (raw query string) — fixed vector", () => {
    expect(receiptRequestSignature(VECTORS.secret, VECTORS.receiptSince)).toBe(VECTORS.receiptSignature)
    expect(receiptRequestSignature(VECTORS.secret, VECTORS.receiptSince)).toBe(
      hmacHex(VECTORS.secret, "since=2026-08-18T20%3A00%3A00.000Z")
    )
  })

  it("parseReceipt tolerates the likely field spellings and rejects junk", () => {
    expect(parseReceipt({ received: 2, lastPath: "/", lastReceivedAt: "t" })).toEqual({ received: 2, lastPath: "/", lastReceivedAt: "t" })
    expect(parseReceipt({ count: 1, last_path: "/x", last_received_at: "t" })).toEqual({ received: 1, lastPath: "/x", lastReceivedAt: "t" })
    expect(parseReceipt({ received: true })).toEqual({ received: 1, lastPath: null, lastReceivedAt: null })
    expect(parseReceipt({ nope: 1 })).toBeNull()
    expect(parseReceipt(null)).toBeNull()
    expect(parseReceipt("x")).toBeNull()
  })
})
