import { describe, expect, it } from "vitest"

import { compareApiHost, posthogRegion } from "./posthog-hosts.js"

describe("posthogRegion", () => {
  it("negative: a host that only ENDS in the letters `posthog.com` is not PostHog's", () => {
    expect(posthogRegion("https://eu.i.evilposthog.com")).toBe("other")
    expect(posthogRegion("https://us.i.notposthog.com")).toBe("other")
    expect(posthogRegion("https://eu.i.posthog.com.evil.test")).toBe("other")
    expect(posthogRegion("/ingest")).toBe("other")
  })

  it("a lookalike api_host is compared by origin, so it never passes as the project's cloud", () => {
    expect(compareApiHost("https://eu.i.evilposthog.com", "https://eu.i.posthog.com")).toMatch(/expected https:\/\/eu\.i\.posthog\.com/)
    expect(compareApiHost("/ingest///", "/ingest")).toBeNull()
  })
})
