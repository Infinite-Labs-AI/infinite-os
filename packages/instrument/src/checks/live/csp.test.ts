// Live CSP (lane O9): style first, then host by host. Job 12's evidence.
import { describe, expect, it } from "vitest"

import { FIXED_NOW, fixtureFetch } from "../../../test/wizard/fixture-fetch.js"
import type { TestExpect } from "../../wizard/contracts/test-engine.js"

import { checkCsp } from "./csp.js"

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

  it("an unreadable page is undetermined", async () => {
    const fixture = fixtureFetch({})
    const results = await checkCsp({ url: "https://acme.test/", expect: EXPECT }, { version: "t", fetch: fixture.fetch, attempts: 1 }, ctx)
    expect(results[0]!.state).toBe("undetermined")
  })
})

