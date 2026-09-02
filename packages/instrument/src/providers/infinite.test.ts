import { describe, expect, it } from "vitest"

import type { InfinitePublicArtifact, WorkspaceInstallArtifacts } from "../types.js"

import { infiniteProviderAdapter, renderInfiniteBrowserTag } from "./infinite.js"

const validArtifact: InfinitePublicArtifact = {
  siteSourceKey: "site_public_abc123",
  collectPath: "/infinite/events/collect",
  productionHosts: ["example.com", "www.example.com"],
  consentMode: "required"
}

function context(artifacts: WorkspaceInstallArtifacts = {}) {
  return { artifacts }
}

describe("infinite provider plan", () => {
  it("rejects malformed source keys, collect paths, and production hosts", () => {
    const blocked = infiniteProviderAdapter.plan(
      "static-html",
      {
        siteSourceKey: "</script>",
        collectPath: "https://api.example/events",
        productionHosts: ["https://example.com/path"]
      },
      context()
    )

    expect(blocked.blockers.join("\n")).toContain("siteSourceKey")
    expect(blocked.blockers.join("\n")).toContain("collectPath")
    expect(blocked.blockers.join("\n")).toContain("production host")
    expect(blocked.instructions).toEqual([])
  })

  it("blocks an Infinite source with an empty production host allowlist", () => {
    const blocked = infiniteProviderAdapter.plan(
      "static-html",
      { ...validArtifact, productionHosts: [] },
      context({ infinite: { ...validArtifact, productionHosts: [] } })
    )

    expect(blocked.blockers.join("\n")).toContain("production host")
    expect(blocked.instructions).toEqual([])
  })

  it("embeds the self-contained browser runtime without an external loader", () => {
    const planned = infiniteProviderAdapter.plan(
      "static-html",
      validArtifact,
      context({ infinite: validArtifact })
    )
    const snippet = planned.instructions[0]!.snippet

    expect(planned.blockers).toEqual([])
    expect(planned.instructions[0]).toMatchObject({ path: "index.html", provider: "infinite" })
    expect(snippet).toContain('data-infinite-runtime="managed"')
    expect(snippet).toContain("site_public_abc123")
    expect(snippet).toContain("/infinite/events/collect")
    expect(snippet).not.toContain("app.ultima.inc")
    expect(snippet).not.toContain("/tracking/")
    expect(snippet).not.toContain("/sdk/")
  })

  it("can render a not-required consent runtime for Infinite-only collection", () => {
    const planned = infiniteProviderAdapter.plan(
      "static-html",
      { ...validArtifact, consentMode: "not_required" },
      context({ infinite: { ...validArtifact, consentMode: "not_required" } })
    )
    const snippet = planned.instructions[0]!.snippet

    expect(planned.blockers).toEqual([])
    expect(snippet).toContain('"consent":{"mode":"not_required"}')
    // The consent storage key ships in every mode: a not_required site still records
    // the explicit decision of a GPC/DNT visitor (the only visitors it suppresses).
    expect(snippet).toContain("infinite_analytics_consent")
  })

  it("blocks Infinite collection until consent mode is explicitly selected", () => {
    const { consentMode: _, ...artifactWithoutConsent } = validArtifact
    const planned = infiniteProviderAdapter.plan(
      "static-html",
      artifactWithoutConsent,
      context({ infinite: artifactWithoutConsent })
    )

    expect(planned.blockers.join("\n")).toContain("Choose how Infinite first-party analytics handles consent")
    expect(planned.blockers.join("\n")).toContain("--infinite-consent-mode required")
    expect(planned.blockers.join("\n")).toContain("--infinite-consent-mode not-required")
    expect(planned.instructions).toEqual([])
  })

  it("keeps GA4 / PostHog fully independent of Infinite in EVERY consent mode (0.6.0: no mirrors, no reduced providers)", () => {
    for (const consentMode of ["not_required", "required"] as const) {
      const planned = infiniteProviderAdapter.plan(
        "static-html",
        { ...validArtifact, consentMode },
        context({
          infinite: { ...validArtifact, consentMode },
          ga4: { measurementId: "G-ABC123XYZ" },
          posthog: { projectKey: "phc_abc123", apiHost: "https://us.i.posthog.com" }
        })
      )

      expect(planned.blockers).toEqual([])
      const snippet = planned.instructions[0]!.snippet
      expect(snippet).not.toContain("mirrors")
      expect(snippet).not.toContain("gtag")
      expect(snippet).not.toContain("posthog")
      const assumptions = planned.assumptions.join("\n")
      expect(assumptions).toContain("GA4 and PostHog run independently of Infinite")
      expect(assumptions).toContain("Infinite never forwards browser events into them")
      expect(assumptions).not.toContain("grant alone is insufficient")
      expect(assumptions).not.toContain("remains consent-denied")
      expect(assumptions).not.toContain("remains opted out")
    }
  })

  it("documents the required external consent signal", () => {
    const planned = infiniteProviderAdapter.plan(
      "static-html",
      validArtifact,
      context({ infinite: validArtifact })
    )

    expect(planned.assumptions.join("\n")).toContain("infinite:analytics-consent-change")
    expect(planned.assumptions.join("\n")).toContain("detail: { granted: true }")
    expect(planned.assumptions.join("\n")).toContain("detail: { granted: false }")
  })

  it("plans a dormant runtime without a source key (no collection) that carries no provider coupling", () => {
    // A JS-module framework (Next) exercises the stripped, module-embedded snippet path. (Vite now
    // injects the wrapped <script> into index.html like static-html.)
    const planned = infiniteProviderAdapter.plan(
      "next-app-router",
      undefined,
      context({ ga4: { measurementId: "G-ABC123XYZ" } })
    )
    const snippet = planned.instructions[0]!.snippet

    expect(planned.blockers).toEqual([])
    expect(planned.instructions[0]!.path).toBe("lib/infinite-analytics.ts")
    expect(snippet).not.toContain("mirrors")
    expect(snippet).not.toContain('"siteSourceKey":')
    expect(snippet).not.toContain("`")
    expect(snippet).not.toContain("${")
  })

  it("exports the same browser-safe renderer used by every framework", () => {
    const tag = renderInfiniteBrowserTag({
      siteSourceKey: validArtifact.siteSourceKey,
      collectPath: validArtifact.collectPath,
      productionHosts: validArtifact.productionHosts,
      respectDnt: true,
      consent: { mode: "not_required" }
    })

    expect(tag.startsWith('<script data-infinite-runtime="managed">')).toBe(true)
    expect(tag.endsWith("</script>")).toBe(true)
    expect(infiniteProviderAdapter.envKeys("next-app-router")).toEqual([])
  })
})

describe("autocapture threading", () => {
  it("omits the key when the artifact says nothing (0.6.2-identical runtime config)", () => {
    const plan = infiniteProviderAdapter.plan("static-html", validArtifact, context({ infinite: validArtifact }))
    expect(plan.instructions[0]!.snippet).not.toContain('"autocapture"')
  })

  it("threads autocapture:false from the artifact into the runtime config", () => {
    const artifact: InfinitePublicArtifact = { ...validArtifact, autocapture: false }
    const plan = infiniteProviderAdapter.plan("static-html", artifact, context({ infinite: artifact }))
    expect(plan.blockers).toEqual([])
    expect(plan.instructions[0]!.snippet).toContain('"autocapture":false')
  })
})
