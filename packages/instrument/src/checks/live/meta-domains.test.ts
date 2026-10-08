// Meta delivery per registrable domain + the preview host matrix (lane O9). Incidents guarded:
//   • 2026-09-20 (ecff171): Traffic Permissions blocked delivery while every surface showed green;
//   • b714a65: a parser that folded "unreadable" into "absent" — unknown is undetermined, never pass.
import { describe, expect, it } from "vitest"

import { FIXED_NOW, fixtureFetch, type FixtureHandler } from "../../../test/wizard/fixture-fetch.js"

import { checkMetaDomains } from "./meta-domains.js"

const PIXEL = "111222333444555"
const ctx = { runId: null, now: FIXED_NOW }
const healthy = `config.set("${PIXEL}", "something", {"a":1});\ninstance.configLoaded("${PIXEL}");`
const blocked = `config.set("${PIXEL}", "prohibitedPixels", {"lockWebpage":false,"blockReason":"traffic_permissions"});\ninstance.configLoaded("${PIXEL}");`

/** Serves Meta's signals config per `domain=` query: blocked for the listed domains. */
function signals(blockedDomains: string[], extra: Record<string, FixtureHandler> = {}) {
  return fixtureFetch({
    [`https://connect.facebook.net/signals/config/${PIXEL}`]: (request) => {
      const domain = new URL(request.url).searchParams.get("domain") ?? ""
      return { body: blockedDomains.includes(domain) ? blocked : healthy }
    },
    ...extra
  })
}

describe("Meta domain delivery", () => {
  it("one probe per registrable domain; allowed = pass ('delivery not blocked', never 'verified')", async () => {
    const fixture = signals([])
    const results = await checkMetaDomains({ domains: ["acme.com", "www.acme.com", "shop.acme.com"], pixelIds: [PIXEL] }, { version: "t", fetch: fixture.fetch }, ctx)
    expect(results.map((result) => [result.checkId, result.state])).toEqual([["meta_traffic_permissions", "pass"]])
    expect(results[0]!.reason).toContain("delivery not blocked")
    expect(results[0]!.reason).not.toMatch(/verified/i)
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]!.headers.purpose).toBe("prefetch")
    expect(new URL(fixture.requests[0]!.url).searchParams.get("domain")).toBe("acme.com")
  })

  it("a traffic-permissions block is a problem (negative: the healthy config passes, above)", async () => {
    const results = await checkMetaDomains({ domains: ["acme.com"], pixelIds: [PIXEL] }, { version: "t", fetch: signals(["acme.com"]).fetch }, ctx)
    expect(results[0]!.state).toBe("problem")
    expect(results[0]!.reason).toContain("Traffic Permissions")
  })

  it("an unreadable config is undetermined, never pass", async () => {
    const fixture = fixtureFetch({ [`https://connect.facebook.net/signals/config/${PIXEL}`]: { body: `config.set("${PIXEL}", "prohibitedPixels", {not json});` } })
    const results = await checkMetaDomains({ domains: ["acme.com"], pixelIds: [PIXEL] }, { version: "t", fetch: fixture.fetch }, ctx)
    expect(results[0]!.state).toBe("undetermined")
  })

  it("never probes a preview-shaped host as a production domain", async () => {
    const fixture = signals([])
    const results = await checkMetaDomains({ domains: ["acme.vercel.app", "localhost"], pixelIds: [PIXEL] }, { version: "t", fetch: fixture.fetch }, ctx)
    expect(results.map((result) => result.state)).toEqual(["undetermined"])
    expect(fixture.requests).toEqual([])
  })
})

