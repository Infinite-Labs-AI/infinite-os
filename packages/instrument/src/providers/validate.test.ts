import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { ga4ProviderAdapter } from "./ga4.js"
import { posthogProviderAdapter } from "./posthog.js"
import {
  derivePosthogRegionHosts,
  jsLiteral,
  normalizeInfiniteCollectPath,
  normalizeInfiniteProductionHosts,
  normalizePosthogApiHost,
  normalizePosthogUiHost,
  validateGa4MeasurementId,
  validateInfiniteSiteSourceKey,
  validateMetaPixelId,
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

  it("accepts a ROOT-RELATIVE reverse-proxy path as apiHost, stripping a trailing slash", () => {
    // The first-party /ingest path can't pass new URL(); it needs the dedicated branch.
    expect(normalizePosthogApiHost("/ingest")).toEqual({ origin: "/ingest" })
    expect(normalizePosthogApiHost("/ingest/")).toEqual({ origin: "/ingest" })
    // A protocol-relative //host is NOT a root-relative path — it still hits the URL checks.
    expect(normalizePosthogApiHost("//evil.test")).toHaveProperty("error")
  })

  it("normalizePosthogUiHost accepts absolute https only (no relative, no http)", () => {
    expect(normalizePosthogUiHost("https://us.posthog.com")).toEqual({ origin: "https://us.posthog.com" })
    // trailing slash stripped
    expect(normalizePosthogUiHost("https://eu.posthog.com/")).toEqual({ origin: "https://eu.posthog.com" })
    // a relative path is not a valid ui_host
    expect(normalizePosthogUiHost("/ingest")).toHaveProperty("error")
    // http + credentials rejected
    expect(normalizePosthogUiHost("http://us.posthog.com")).toHaveProperty("error")
    expect(normalizePosthogUiHost("https://user:pass@evil.test")).toHaveProperty("error")
  })

  it("derivePosthogRegionHosts defaults to US and selects EU only for explicit eu hosts", () => {
    expect(derivePosthogRegionHosts("https://us.i.posthog.com")).toEqual({
      ingestHost: "https://us.i.posthog.com",
      assetsHost: "https://us-assets.i.posthog.com",
      uiHost: "https://us.posthog.com"
    })
    // unknown / empty apiHost → US default (never hardcode EU)
    expect(derivePosthogRegionHosts("").ingestHost).toBe("https://us.i.posthog.com")
    expect(derivePosthogRegionHosts("https://custom.example/ingest").uiHost).toBe("https://us.posthog.com")
    // explicit EU host → EU
    expect(derivePosthogRegionHosts("https://eu.i.posthog.com")).toEqual({
      ingestHost: "https://eu.i.posthog.com",
      assetsHost: "https://eu-assets.i.posthog.com",
      uiHost: "https://eu.posthog.com"
    })
    expect(derivePosthogRegionHosts("https://eu-assets.i.posthog.com").ingestHost).toBe(
      "https://eu.i.posthog.com"
    )
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

  it("validates the public Infinite source, path, and host allowlist", () => {
    expect(validateInfiniteSiteSourceKey("site_public_abc123")).toBeNull()
    expect(validateInfiniteSiteSourceKey("workspace_abc")).toBeTruthy()
    expect(validateInfiniteSiteSourceKey("</script>")).toBeTruthy()

    expect(normalizeInfiniteCollectPath("/infinite/events/collect/")).toEqual({
      path: "/infinite/events/collect"
    })
    expect(normalizeInfiniteCollectPath("https://api.example/events")).toHaveProperty("error")
    expect(normalizeInfiniteCollectPath("//api.example/events")).toHaveProperty("error")
    expect(normalizeInfiniteCollectPath("/events?workspace=forged")).toHaveProperty("error")
    expect(normalizeInfiniteCollectPath("/tracking/events")).toHaveProperty("error")
    expect(normalizeInfiniteCollectPath("/sdk/events")).toHaveProperty("error")

    expect(normalizeInfiniteProductionHosts(["Example.com", "www.example.com", "example.com"])).toEqual({
      hosts: ["example.com", "www.example.com"]
    })
    expect(normalizeInfiniteProductionHosts([])).toHaveProperty("error")
    expect(normalizeInfiniteProductionHosts(["https://example.com"])).toHaveProperty("error")
    expect(normalizeInfiniteProductionHosts(["example.com/path"])).toHaveProperty("error")
  })

  it("accepts numeric Meta pixel ids and rejects non-numeric/hostile ones", () => {
    expect(validateMetaPixelId("1234567890123456")).toBeNull()
    expect(validateMetaPixelId("")).toBeTruthy()
    expect(validateMetaPixelId("abc123")).toBeTruthy()
    expect(validateMetaPixelId("</script>")).toBeTruthy()
    expect(validateMetaPixelId(123 as unknown)).toBeTruthy()
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
    // 0.6.0 — full native: GA4's own config with its DEFAULT send_page_view; no Infinite consent
    // default/bridge, no reduced configuration.
    expect(ok.instructions[0]!.snippet).toContain("gtag('config', \"G-ABC123XYZ\")")
    expect(ok.instructions[0]!.snippet).not.toContain("send_page_view")
    expect(ok.instructions[0]!.snippet).not.toContain("gtag('consent'")
    expect(ok.instructions[0]!.snippet).not.toContain("__infiniteGa4Consent")
  })

  it("GA4 installs natively: loads gtag.js exactly once, immediately, and configures with the default page_view", () => {
    const planned = ga4ProviderAdapter.plan("next-app-router", {
      measurementId: "G-ABC123XYZ"
    })
    const timeline: string[] = []
    const insertedScripts: Array<{ async?: boolean; src?: string }> = []
    const dataLayer: unknown[] = []
    const windowObject: Record<string, unknown> = { dataLayer }
    const context = {
      window: windowObject,
      document: {
        createElement(tagName: string) {
          expect(tagName).toBe("script")
          return {} as { async?: boolean; src?: string }
        },
        head: {
          appendChild(script: { async?: boolean; src?: string }) {
            timeline.push("insert")
            insertedScripts.push(script)
          }
        }
      },
      Date
    }
    runInNewContext(planned.instructions[0]!.snippet, context)

    // Google's snippet shape: loader inserted, then gtag('js'), then gtag('config', ID) — pushed as
    // the `arguments` object (what gtag.js expects), with no send_page_view override.
    expect(insertedScripts).toEqual([
      {
        async: true,
        src: "https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ"
      }
    ])
    const commands = dataLayer.map((entry) => Array.from(entry as ArrayLike<unknown>))
    expect(commands.map((entry) => entry[0])).toEqual(["js", "config"])
    expect(commands[1]).toEqual(["config", "G-ABC123XYZ"])
    expect(windowObject.__infiniteGa4Consent).toBeUndefined()
    // Re-running the snippet (a second managed install call) keeps the dataLayer function stable.
    expect(typeof windowObject.gtag).toBe("function")
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
    // no proxy uiHost → no ui_host in the init options
    expect(ok.instructions[0]!.snippet).not.toContain("ui_host")
    // 0.6.0 — full native: PostHog's OWN defaults (autocapture, pageview, pageleave, recording,
    // persistence, opt-in state are PostHog's), opted into its current defaults bundle. The
    // installer never reduces the provider.
    expect(ok.instructions[0]!.snippet).toContain("defaults: '2025-05-24'")
    for (const reduced of [
      "capture_pageview: false",
      "autocapture: false",
      "capture_pageleave: false",
      "disable_session_recording: true",
      "opt_out_capturing_by_default: true",
      "persistence: 'memory'"
    ]) {
      expect(ok.instructions[0]!.snippet, reduced).not.toContain(reduced)
    }
  })

  it("PostHog reverse-proxy artifact emits a first-party api_host + a real ui_host", () => {
    const ok = posthogProviderAdapter.plan("next-app-router", {
      projectKey: "phc_abcDEF0123456789xyz",
      apiHost: "/ingest",
      uiHost: "https://us.posthog.com"
    })
    expect(ok.blockers).toHaveLength(0)
    expect(ok.instructions[0]!.snippet).toContain('api_host: "/ingest"')
    expect(ok.instructions[0]!.snippet).toContain('ui_host: "https://us.posthog.com"')
  })

  it("PostHog blocks a malformed proxy uiHost", () => {
    const blocked = posthogProviderAdapter.plan("next-app-router", {
      projectKey: "phc_abcDEF0123456789xyz",
      apiHost: "/ingest",
      uiHost: "http://not-https.example"
    })
    expect(blocked.blockers.length).toBeGreaterThan(0)
    expect(blocked.instructions).toHaveLength(0)
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
