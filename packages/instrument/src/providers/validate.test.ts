import { describe, expect, it } from "vitest"

import { ga4ProviderAdapter } from "./ga4.js"
import { posthogProviderAdapter } from "./posthog.js"
import {
  jsLiteral,
  normalizePosthogApiHost,
  validateGa4MeasurementId,
  validatePosthogProjectKey,
  validateXEventTagIds,
  validateXPixelId
} from "./validate.js"
import { xProviderAdapter } from "./x.js"

describe("artifact validation", () => {
  it("accepts well-formed ids and rejects empty/malformed/hostile ones", () => {
    expect(validateGa4MeasurementId("G-ABC123XYZ")).toBeNull()
    expect(validateGa4MeasurementId("G-XX'); alert(1);//")).toBeTruthy()
    expect(validateGa4MeasurementId("")).toBeTruthy()
    expect(validateGa4MeasurementId(123 as unknown)).toBeTruthy()

    expect(validatePosthogProjectKey("phc_abcDEF0123456789xyz")).toBeNull()
    expect(validatePosthogProjectKey("phc_bad'key")).toBeTruthy()
    expect(validatePosthogProjectKey("pk_wrongprefix0123456789")).toBeTruthy()

    expect(validateXPixelId("o1abc")).toBeNull()
    expect(validateXPixelId("'),alert(1)//")).toBeTruthy()
    expect(validateXEventTagIds(["twabc", "twdef"])).toBeNull()
    expect(validateXEventTagIds([])).toBeTruthy()
    expect(validateXEventTagIds(["ok", "</script>"])).toBeTruthy()
  })

  it("normalizes a valid https apiHost preserving path and rejects unsafe ones", () => {
    // path preserved — reverse-proxy config like /ingest must survive
    expect(normalizePosthogApiHost("https://app.example.com/ingest")).toEqual({
      origin: "https://app.example.com/ingest"
    })
    // root trailing slash stripped
    expect(normalizePosthogApiHost("https://us.i.posthog.com/")).toEqual({
      origin: "https://us.i.posthog.com"
    })
    // plain origin unchanged
    expect(normalizePosthogApiHost("https://us.i.posthog.com")).toEqual({
      origin: "https://us.i.posthog.com"
    })
    // query string stripped
    expect(normalizePosthogApiHost("https://us.i.posthog.com/ingest?foo=bar")).toEqual({
      origin: "https://us.i.posthog.com/ingest"
    })
    // fragment stripped
    expect(normalizePosthogApiHost("https://us.i.posthog.com/ingest#hash")).toEqual({
      origin: "https://us.i.posthog.com/ingest"
    })
    // embedded credentials rejected
    expect(normalizePosthogApiHost("https://user:pass@evil.test")).toHaveProperty("error")
    // http rejected
    expect(normalizePosthogApiHost("http://us.i.posthog.com")).toHaveProperty("error")
    // non-URL rejected
    expect(normalizePosthogApiHost("not a url")).toHaveProperty("error")
  })

  it("jsLiteral escapes a value so it cannot close a <script> block, and round-trips", () => {
    const out = jsLiteral("</script><script>alert(1)</script>")
    expect(out).not.toContain("</script>")
    expect(out).toContain("\\u003c")
    expect(JSON.parse(out)).toBe("</script><script>alert(1)</script>")
  })

  it("jsLiteral does not throw on undefined and returns the string \"undefined\"", () => {
    expect(() => jsLiteral(undefined)).not.toThrow()
    expect(jsLiteral(undefined)).toBe("undefined")
  })

  it("GA4 measurement-id regex rejects all-hyphen bodies and accepts real IDs", () => {
    // all-hyphen body — must be rejected
    expect(validateGa4MeasurementId("G-----")).toBeTruthy()
    expect(validateGa4MeasurementId("G----")).toBeTruthy()
    // valid IDs — must be accepted
    expect(validateGa4MeasurementId("G-ABCDE12345")).toBeNull()
    expect(validateGa4MeasurementId("GT-XXXXXXX")).toBeNull()
    // internal hyphens still allowed
    expect(validateGa4MeasurementId("G-ABC-123")).toBeNull()
    // existing valid fixtures from the suite above
    expect(validateGa4MeasurementId("G-ABC123XYZ")).toBeNull()
  })
})

describe("provider plans reject hostile artifacts and escape valid ones", () => {
  it("GA4 blocks a malformed measurementId and escapes a valid one", () => {
    const blocked = ga4ProviderAdapter.plan("next-app-router", { measurementId: "G-x'); evil()//" })
    expect(blocked.blockers.length).toBeGreaterThan(0)
    expect(blocked.instructions).toHaveLength(0)

    const ok = ga4ProviderAdapter.plan("next-app-router", { measurementId: "G-ABC123XYZ" })
    expect(ok.blockers).toHaveLength(0)
    expect(ok.instructions[0]!.snippet).toContain("gtag('config', \"G-ABC123XYZ\")")
  })

  it("PostHog blocks a bad key/host and normalizes the host origin in the snippet", () => {
    const blocked = posthogProviderAdapter.plan("next-app-router", {
      projectKey: "nope",
      apiHost: "http://x"
    })
    expect(blocked.blockers.length).toBeGreaterThan(0)

    const ok = posthogProviderAdapter.plan("next-app-router", {
      projectKey: "phc_abcDEF0123456789xyz",
      apiHost: "https://us.i.posthog.com/ingest"
    })
    expect(ok.blockers).toHaveLength(0)
    // path is now preserved — reverse-proxy configs must survive into the snippet
    expect(ok.instructions[0]!.snippet).toContain('api_host: "https://us.i.posthog.com/ingest"')
    // query/hash must not appear in the api_host value
    expect(ok.instructions[0]!.snippet).not.toContain('api_host: "https://us.i.posthog.com/ingest?')
  })

  it("X blocks a malformed pixel id and escapes valid ones", () => {
    const blocked = xProviderAdapter.plan("next-app-router", {
      pixelId: "</script>",
      eventTagIds: ["ok"]
    })
    expect(blocked.blockers.length).toBeGreaterThan(0)

    const ok = xProviderAdapter.plan("next-app-router", {
      pixelId: "o1abc",
      eventTagIds: ["tw1", "tw2"]
    })
    expect(ok.blockers).toHaveLength(0)
    expect(ok.instructions[0]!.snippet).toContain("twq('config', \"o1abc\")")
  })
})
