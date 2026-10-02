// Live CSP (lane O9): style first, then host by host. Job 12's evidence.
import { describe, expect, it } from "vitest"

import { FIXED_NOW, fixtureFetch } from "../../../test/wizard/fixture-fetch.js"
import type { TestExpect } from "../../wizard/contracts/test-engine.js"

import { analyzeCsp, checkCsp, cspNeeds, sourceAllows } from "./csp.js"

const ctx = { runId: null, now: FIXED_NOW }
const EXPECT: TestExpect = { ga4: ["G-ACME123"], posthog: { projectKey: "phc_x", apiHost: "/ingest" }, meta: ["111222333444555"] }

function check(headers: Record<string, string>, body = "<html><head></head></html>") {
  const fixture = fixtureFetch({ "https://acme.test/": { headers, body } })
  return checkCsp({ url: "https://acme.test/", expect: EXPECT }, { version: "t", fetch: fixture.fetch, attempts: 1 }, ctx).then((results) => ({
    result: results[0]!,
    requests: fixture.requests
  }))
}

const ALLOWING =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://connect.facebook.net; " +
  "connect-src 'self' *.google-analytics.com *.analytics.google.com https://www.facebook.com; img-src 'self' https://www.facebook.com"

describe("live CSP", () => {
  it("no policy → pass", async () => {
    const { result, requests } = await check({})
    expect(result.state).toBe("pass")
    expect(requests[0]!.headers.purpose).toBe("prefetch")
  })

  it("a host-list policy that allows every needed host passes (negative: drop one host → problem)", async () => {
    expect((await check({ "content-security-policy": ALLOWING })).result.state).toBe("pass")
    const missing = await check({ "content-security-policy": ALLOWING.replace(" https://connect.facebook.net", "") })
    expect(missing.result.state).toBe("problem")
    expect(missing.result.reason).toContain("script-src does not allow connect.facebook.net (meta)")
  })

  it("refusing inline scripts blocks the inline snippets", async () => {
    const { result } = await check({ "content-security-policy": ALLOWING.replace(" 'unsafe-inline'", "") })
    expect(result.state).toBe("problem")
    expect(result.reason).toContain("'unsafe-inline'")
  })

  it("a nonce / strict-dynamic policy is undetermined; Report-Only is info", async () => {
    expect((await check({ "content-security-policy": "script-src 'nonce-abc' 'strict-dynamic'" })).result.state).toBe("undetermined")
    const reportOnly = await check({ "content-security-policy-report-only": "default-src 'self'" })
    expect(reportOnly.result.state).toBe("info")
    expect(reportOnly.result.reason).toContain("would block")
  })

  it("reads a <meta http-equiv> policy too", async () => {
    const { result } = await check({}, `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"></head></html>`)
    expect(result.state).toBe("problem")
  })

  it("GA4's Google-signals host *.analytics.google.com is needed (review P3-2)", async () => {
    const missing = await check({ "content-security-policy": ALLOWING.replace(" *.analytics.google.com", "") })
    expect(missing.result.state).toBe("problem")
    expect(missing.result.reason).toContain("connect-src does not allow region1.analytics.google.com (ga4)")
  })

  it("a host-list policy with nothing to check against is info, never a pass (review P1-8)", async () => {
    const fixture = fixtureFetch({ "https://acme.test/": { headers: { "content-security-policy": ALLOWING }, body: "<html></html>" } })
    const results = await checkCsp({ url: "https://acme.test/", expect: {} }, { version: "t", fetch: fixture.fetch, attempts: 1 }, ctx)
    expect(results.map((result) => result.state)).toEqual(["info"])
  })

  it("an unreadable page is undetermined", async () => {
    const fixture = fixtureFetch({})
    const results = await checkCsp({ url: "https://acme.test/", expect: EXPECT }, { version: "t", fetch: fixture.fetch, attempts: 1 }, ctx)
    expect(results[0]!.state).toBe("undetermined")
  })
})

describe("CSP source matching", () => {
  const url = (value: string) => new URL(value)
  it("matches wildcards, schemes and 'self'", () => {
    expect(sourceAllows("*.google-analytics.com", url("https://region1.google-analytics.com/g/collect"), "https://acme.test")).toBe(true)
    expect(sourceAllows("*.google-analytics.com", url("https://google-analytics.com/g/collect"), "https://acme.test")).toBe(false)
    expect(sourceAllows("https:", url("https://x.test/"), "https://acme.test")).toBe(true)
    expect(sourceAllows("'self'", url("https://acme.test/ingest/e/"), "https://acme.test")).toBe(true)
    expect(sourceAllows("'self'", url("https://eu.i.posthog.com/e/"), "https://acme.test")).toBe(false)
    expect(sourceAllows("https://connect.facebook.net/en_US/", url("https://connect.facebook.net/en_US/fbevents.js"), "https://acme.test")).toBe(true)
  })

  it("a proxied PostHog needs only 'self'; a direct one needs its region's hosts", () => {
    const proxied = cspNeeds({ posthog: { projectKey: "phc_x", apiHost: "/ingest" } }, "https://acme.test")
    expect(analyzeCsp("default-src 'self'", null, [], proxied, "https://acme.test").missing).toEqual([])
    const direct = cspNeeds({ posthog: { projectKey: "phc_x", apiHost: "https://eu.i.posthog.com" } }, "https://acme.test")
    expect(analyzeCsp("default-src 'self'", null, [], direct, "https://acme.test").missing.map((row) => row.host)).toEqual([
      "eu-assets.i.posthog.com",
      "eu.i.posthog.com"
    ])
  })
})
