import { describe, expect, it } from "vitest"

import { INFINITE_SERVER_EVENTS_DESTINATION } from "../workspace-artifacts.js"

import {
  AUTOMATION_USER_AGENT_PATTERN,
  buildDocumentRequestEvent,
  buildSignedServerEventRequest,
  classifyUserAgent,
  clientIpFrom,
  computeDocumentEventId,
  computeVisitKey,
  hmacHex,
  isDocumentPath,
  referrerHostOf,
  shouldRecordDocumentRequest,
  signServerEventBody
} from "./helpers.js"

/**
 * FIXED VECTORS — shared with the receiving side (1bu-1) so both ends prove the same recipe.
 *   secret      = "test-secret"
 *   clientIp    = "203.0.113.9"
 *   userAgent   = Chrome 126 on macOS (below)
 *   nowMs       = 1755500000123  → epochSeconds 1755500000 → bucket floor(1755500000/1800) = 975277
 *   path        = "/pricing"
 */
export const VECTORS = {
  secret: "test-secret",
  clientIp: "203.0.113.9",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  nowMs: 1755500000123,
  path: "/pricing",
  host: "example.com",
  referrer: "https://google.com/search?q=infinite",
  bucket: 975277,
  visitKey: "b16eaccc3fc131a1fc6428105bf366164c1f8fff3e0de56d0da7bbfa1712005e",
  eventId: "doc:85c11b1b1ed121d9f91da03777ea890b895033f7a383dceca0694d59ceda8b67",
  emptyBodySignature: "a41bc6d81d6413576ae0994995e0ad89a416ec97389515c3604f47722122eeeb",
  helloSignature: "bcc889a40667cab715e1dc22ad280692cf4bf1c3a280eeeca60d8dbcd8e4b993",
  body:
    '{"eventId":"doc:85c11b1b1ed121d9f91da03777ea890b895033f7a383dceca0694d59ceda8b67","eventName":"site_document_request","occurredAt":"2025-08-18T06:53:20.123Z","properties":{"path":"/pricing","host":"example.com","visitKey":"b16eaccc3fc131a1fc6428105bf366164c1f8fff3e0de56d0da7bbfa1712005e","userAgentFamily":"browser","referrerHost":"google.com"}}',
  bodySignature: "679b2a1bd1e69c49f57534707df1c20e890c17a93ff5fa312fb45519950ddf03",
  /** verify --server-lane: the receipt GET signs its raw query string `since=<encoded iso>`. */
  receiptSince: "2026-08-18T20:00:00.000Z",
  receiptQuery: "since=2026-08-18T20%3A00%3A00.000Z",
  receiptSignature: "2d07572d2a6385584160e88deda6acab37233af2e6ec497b4340572d41aa9b16"
} as const

describe("server-lane recipe vectors", () => {
  it("hmacHex is lowercase hex HMAC-SHA256", () => {
    expect(hmacHex(VECTORS.secret, "hello")).toBe(VECTORS.helloSignature)
    expect(hmacHex(VECTORS.secret, "")).toBe(VECTORS.emptyBodySignature)
  })

  it("visitKey = HMAC(secret, 'visit:' + ip + '|' + ua + '|' + floor(epochSeconds/1800))", () => {
    expect(
      computeVisitKey({
        secret: VECTORS.secret,
        clientIp: VECTORS.clientIp,
        userAgent: VECTORS.userAgent,
        epochSeconds: Math.floor(VECTORS.nowMs / 1000)
      })
    ).toBe(VECTORS.visitKey)
    // Same 30-minute bucket → same key; next bucket → different key.
    expect(
      computeVisitKey({
        secret: VECTORS.secret,
        clientIp: VECTORS.clientIp,
        userAgent: VECTORS.userAgent,
        epochSeconds: VECTORS.bucket * 1800 + 1799
      })
    ).toBe(VECTORS.visitKey)
    expect(
      computeVisitKey({
        secret: VECTORS.secret,
        clientIp: VECTORS.clientIp,
        userAgent: VECTORS.userAgent,
        epochSeconds: (VECTORS.bucket + 1) * 1800
      })
    ).not.toBe(VECTORS.visitKey)
  })

  it("eventId = 'doc:' + HMAC(secret, visitKey + '|' + path + '|' + occurredAtMs) — retry-idempotent", () => {
    const first = computeDocumentEventId({
      secret: VECTORS.secret,
      visitKey: VECTORS.visitKey,
      path: VECTORS.path,
      occurredAtMs: VECTORS.nowMs
    })
    expect(first).toBe(VECTORS.eventId)
    expect(
      computeDocumentEventId({
        secret: VECTORS.secret,
        visitKey: VECTORS.visitKey,
        path: VECTORS.path,
        occurredAtMs: VECTORS.nowMs
      })
    ).toBe(first)
  })

  it("buildDocumentRequestEvent produces the exact envelope and the body signs to the vector", () => {
    const event = buildDocumentRequestEvent({
      secret: VECTORS.secret,
      path: VECTORS.path,
      host: VECTORS.host,
      clientIp: VECTORS.clientIp,
      userAgent: VECTORS.userAgent,
      referrer: VECTORS.referrer,
      nowMs: VECTORS.nowMs
    })
    expect(JSON.stringify(event)).toBe(VECTORS.body)
    expect(signServerEventBody(VECTORS.secret, JSON.stringify(event))).toBe(VECTORS.bodySignature)
    // No raw IP, no full UA, no query string anywhere in the envelope.
    expect(VECTORS.body).not.toContain(VECTORS.clientIp)
    expect(VECTORS.body).not.toContain("Macintosh")
    expect(VECTORS.body).not.toContain("q=infinite")
  })

  it("buildSignedServerEventRequest sets the two headers and the destination", () => {
    const request = buildSignedServerEventRequest({
      sourceKey: "site_abc",
      secret: VECTORS.secret,
      event: JSON.parse(VECTORS.body)
    })
    expect(request.url).toBe(INFINITE_SERVER_EVENTS_DESTINATION)
    expect(request.headers["x-infinite-source-key"]).toBe("site_abc")
    expect(request.headers["x-infinite-signature"]).toBe(VECTORS.bodySignature)
    expect(request.headers["content-type"]).toBe("application/json")
    expect(request.body).toBe(VECTORS.body)
  })
})

describe("classifyUserAgent", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36", "browser"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1", "browser"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0", "browser"],
    ["Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "automation"],
    ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "automation"],
    ["Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)", "automation"],
    ["Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/124.0.0.0 Safari/537.36", "automation"],
    ["curl/8.4.0", "automation"],
    ["Wget/1.21", "automation"],
    ["python-requests/2.31.0", "automation"],
    ["Go-http-client/2.0", "automation"],
    ["facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "automation"],
    ["Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)", "automation"],
    ["Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)", "automation"],
    ["Chrome-Lighthouse", "automation"],
    ["Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 GSA/15", "browser"],
    ["", "unknown"],
    ["   ", "unknown"]
  ])("%s → %s", (userAgent, expected) => {
    expect(classifyUserAgent(userAgent)).toBe(expected)
  })

  it("null/undefined → unknown", () => {
    expect(classifyUserAgent(null)).toBe("unknown")
    expect(classifyUserAgent(undefined)).toBe("unknown")
  })

  it("the pattern is case-insensitive and word-bounded on 'bot'", () => {
    expect(AUTOMATION_USER_AGENT_PATTERN.flags).toContain("i")
    expect(classifyUserAgent("Something/1.0 (Robots welcome)")).toBe("browser")
  })
})

describe("document request gate", () => {
  it.each([
    ["/", true],
    ["/pricing", true],
    ["/blog/hello-world", true],
    ["/api/health", false],
    ["/api", true],
    ["/_next/static/chunks/main.js", false],
    ["/_next/data/build/index.json", false],
    ["/_vercel/insights/script.js", false],
    ["/favicon.ico", false],
    ["/robots.txt", false],
    ["/sitemap.xml", false],
    ["/images/logo.png", false],
    ["/v1.2/docs", true],
    ["relative", false]
  ])("isDocumentPath(%s) → %s", (path, expected) => {
    expect(isDocumentPath(path)).toBe(expected)
  })

  it("requires GET, text/html accept, and no prefetch", () => {
    const base = { method: "GET", path: "/pricing", accept: "text/html,application/xhtml+xml", prefetch: false }
    expect(shouldRecordDocumentRequest(base)).toBe(true)
    expect(shouldRecordDocumentRequest({ ...base, method: "HEAD" })).toBe(false)
    expect(shouldRecordDocumentRequest({ ...base, method: "POST" })).toBe(false)
    expect(shouldRecordDocumentRequest({ ...base, prefetch: true })).toBe(false)
    expect(shouldRecordDocumentRequest({ ...base, accept: "*/*" })).toBe(false)
    expect(shouldRecordDocumentRequest({ ...base, accept: "text/x-component" })).toBe(false)
    expect(shouldRecordDocumentRequest({ ...base, accept: null })).toBe(false)
    expect(shouldRecordDocumentRequest({ ...base, accept: "TEXT/HTML" })).toBe(true)
    expect(shouldRecordDocumentRequest({ ...base, path: "/api/x" })).toBe(false)
  })
})

describe("header helpers", () => {
  it("referrerHostOf keeps only a plain lowercase hostname", () => {
    expect(referrerHostOf("https://www.google.com/search?q=x")).toBe("www.google.com")
    expect(referrerHostOf("https://News.YCombinator.com/item?id=1")).toBe("news.ycombinator.com")
    expect(referrerHostOf("http://[::1]:3000/x")).toBeUndefined()
    expect(referrerHostOf("not a url")).toBeUndefined()
    expect(referrerHostOf("")).toBeUndefined()
    expect(referrerHostOf(null)).toBeUndefined()
  })

  it("clientIpFrom prefers the first x-forwarded-for hop", () => {
    expect(clientIpFrom({ forwardedFor: "198.51.100.7, 10.0.0.1", realIp: "10.0.0.2" })).toBe("198.51.100.7")
    expect(clientIpFrom({ forwardedFor: null, realIp: "10.0.0.2" })).toBe("10.0.0.2")
    expect(clientIpFrom({ forwardedFor: "", realIp: "", fallback: "203.0.113.1" })).toBe("203.0.113.1")
    expect(clientIpFrom({})).toBe("")
  })
})

describe("contracts/server-lane-v1.vectors.json (shared with the receiving side)", () => {
  it("matches the helper outputs exactly", async () => {
    const { readFileSync } = await import("node:fs")
    const { fileURLToPath } = await import("node:url")
    const { resolve, dirname } = await import("node:path")
    const here = dirname(fileURLToPath(import.meta.url))
    const vectors = JSON.parse(
      readFileSync(resolve(here, "../../contracts/server-lane-v1.vectors.json"), "utf8")
    ) as Record<string, unknown> & { userAgentFamilySamples: Record<string, string[]> }
    expect(vectors.secret).toBe(VECTORS.secret)
    expect(vectors.visitBucket).toBe(VECTORS.bucket)
    expect(vectors.visitKey).toBe(VECTORS.visitKey)
    expect(vectors.documentEventId).toBe(VECTORS.eventId)
    expect(vectors.documentEventBody).toBe(VECTORS.body)
    expect(vectors.documentEventBodySignature).toBe(VECTORS.bodySignature)
    expect(vectors.emptyBodySignature).toBe(VECTORS.emptyBodySignature)
    expect(vectors.receiptQuery).toBe(VECTORS.receiptQuery)
    expect(vectors.receiptSignature).toBe(VECTORS.receiptSignature)
    expect(hmacHex(VECTORS.secret, VECTORS.receiptQuery)).toBe(VECTORS.receiptSignature)
    expect(vectors.headers).toEqual({ sourceKey: "x-infinite-source-key", signature: "x-infinite-signature" })
    for (const [family, samples] of Object.entries(vectors.userAgentFamilySamples)) {
      for (const sample of samples) {
        expect(classifyUserAgent(sample)).toBe(family)
      }
    }
  })
})
