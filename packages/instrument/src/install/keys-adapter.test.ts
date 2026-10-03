import { describe, expect, it } from "vitest"

import { fakeKeys, IDS, notConnectedKeys } from "../../test/wizard/o7-fakes.js"
import type { TagKeys } from "../wizard/contracts/bridge.js"

import { artifactsFromKeys, artifactsFromKeysDetailed, manifestIdsFor, withConversionHelpers, wizardInstallWorkspaceId } from "./keys-adapter.js"

const decided = { consentMode: "not_required" as const, conversionNames: [], privacyText: null, npmInstall: null }

describe("artifactsFromKeys (§3b keys → the installer's input)", () => {
  it("maps every connected tool to its connection's public id, PostHog proxied to its own region", () => {
    const artifacts = artifactsFromKeys(fakeKeys(), decided)
    expect(artifacts.infinite).toEqual({
      siteSourceKey: IDS.siteSource,
      collectPath: "/infinite/ledger",
      productionHosts: ["acme-store.com"],
      consentMode: "not_required"
    })
    expect(artifacts.ga4).toEqual({ measurementId: IDS.ga4 })
    expect(artifacts.posthog).toEqual({
      projectKey: IDS.posthog,
      apiHost: "/ingest",
      uiHost: "https://us.posthog.com",
      proxy: { path: "/ingest", ingestHost: "https://us.i.posthog.com", assetsHost: "https://us-assets.i.posthog.com" }
    })
    expect(artifacts.meta).toEqual({ pixelId: IDS.meta })
    expect(artifacts.productionHosts).toEqual(["acme-store.com"])
  })

  it("EU comes from the connection's region, never a US default", () => {
    const keys = fakeKeys({
      posthog: { status: "connected", projectKey: IDS.posthog, apiHost: "https://eu.i.posthog.com", ingestHost: "https://eu.i.posthog.com", uiHost: "https://eu.posthog.com", region: "eu" }
    })
    expect(artifactsFromKeys(keys, decided).posthog?.proxy?.ingestHost).toBe("https://eu.i.posthog.com")
  })

  it("self-hosted PostHog goes straight to the connection's own host (no proxy invented)", () => {
    const keys = fakeKeys({
      posthog: { status: "connected", projectKey: IDS.posthog, apiHost: "https://ph.acme.internal", ingestHost: "https://ph.acme.internal", uiHost: null, region: "self_hosted" }
    })
    expect(artifactsFromKeys(keys, decided).posthog).toEqual({ projectKey: IDS.posthog, apiHost: "https://ph.acme.internal" })
  })

  const statuses: Array<[string, Partial<TagKeys>, "ga4" | "posthog" | "meta" | "infinite", string]> = [
    ["ga4 not_connected", { ga4: { status: "not_connected", propertyLabel: null, streams: [] } }, "ga4", "not_connected"],
    ["ga4 read_failed", { ga4: { status: "read_failed", propertyLabel: null, streams: [] } }, "ga4", "read_failed"],
    [
      "ga4 two streams, neither this site's",
      {
        ga4: {
          status: "connected",
          propertyLabel: "Acme",
          streams: [
            { measurementId: IDS.ga4, defaultUri: "https://staging.example.org", streamName: "a" },
            { measurementId: IDS.ga4Other, defaultUri: "https://other.example.org", streamName: "b" }
          ]
        }
      },
      "ga4",
      "multiple_streams"
    ],
    ["posthog not_connected", { posthog: { status: "not_connected", projectKey: null, apiHost: null, ingestHost: null, uiHost: null, region: null } }, "posthog", "not_connected"],
    ["posthog read_failed", { posthog: { status: "read_failed", projectKey: null, apiHost: null, ingestHost: null, uiHost: null, region: null } }, "posthog", "read_failed"],
    ["meta not_connected", { meta: { status: "not_connected", pixels: [] } }, "meta", "not_connected"],
    ["meta no_pixel", { meta: { status: "no_pixel", pixels: [] } }, "meta", "no_pixel"],
    [
      "meta multiple",
      { meta: { status: "multiple", pixels: [{ pixelId: IDS.meta, sourceRef: "a", adAccountLabel: null }, { pixelId: "6543210987654321", sourceRef: "b", adAccountLabel: null }] } },
      "meta",
      "multiple_pixels"
    ],
    ["meta infinite_dataset", { meta: { status: "infinite_dataset", pixels: [] } }, "meta", "infinite_dataset"],
    ["meta invalid id", { meta: { status: "connected", pixels: [{ pixelId: "12345", sourceRef: "a", adAccountLabel: null }] } }, "meta", "invalid_id"],
    [
      "infinite not_provisioned",
      { infinite: { status: "not_provisioned", siteSourceKey: null, productionHosts: [], consentMode: null, consentStorageKey: null, collectPath: null } },
      "infinite",
      "not_provisioned"
    ]
  ]
  it.each(statuses)("NEGATIVE %s → no artifact, never a default id", (_label, override, tool, reason) => {
    const result = artifactsFromKeysDetailed(fakeKeys(override), decided)
    expect(result.artifacts[tool]).toBeUndefined()
    expect(result.skipped[tool]).toBe(reason)
  })

  it("NEGATIVE: with nothing connected, the only artifact is Infinite's own (no id is ever made up)", () => {
    const artifacts = artifactsFromKeys(notConnectedKeys(), decided)
    expect(Object.keys(artifacts).sort()).toEqual(["infinite", "productionHosts"])
    expect(JSON.stringify(artifacts)).not.toMatch(/G-|phc_|\b\d{15,16}\b/)
  })

  it("two GA4 streams: the one whose default URI is this site's production host", () => {
    const keys = fakeKeys({
      ga4: {
        status: "connected",
        propertyLabel: "Acme",
        streams: [
          { measurementId: IDS.ga4Other, defaultUri: "https://staging.acme-store.com", streamName: "staging" },
          { measurementId: IDS.ga4, defaultUri: "https://ACME-STORE.com.", streamName: "web" }
        ]
      }
    })
    expect(artifactsFromKeys(keys, decided).ga4).toEqual({ measurementId: IDS.ga4 })
  })

  it("Infinite's pixel waits for an answered consent mode", () => {
    const result = artifactsFromKeysDetailed(fakeKeys(), { ...decided, consentMode: null })
    expect(result.artifacts.infinite).toBeUndefined()
    expect(result.skipped.infinite).toBe("consent_unanswered")
  })
})

describe("the wizard install's manifest workspaceId and ids (§3e.6, R1-15)", () => {
  it("is wizard:<first 16 hex of the fingerprint>, stable, and never a cloud id", () => {
    const id = wizardInstallWorkspaceId(IDS.fingerprint)
    expect(id).toBe(`wizard:${"ab".repeat(8)}`)
    expect(wizardInstallWorkspaceId(IDS.fingerprint)).toBe(id)
    // The tripwire rejects ws_<16 hex> anywhere in infinite-os (scripts/ci/repo-tripwire.sh).
    expect(id).not.toMatch(/ws_[0-9a-f]{16}/)
  })

  it("NEGATIVE: refuses anything but sha256:<64 hex>", () => {
    // A cloud-workspace-shaped id, assembled at run time (the tripwire forbids the literal in tracked files).
    expect(() => wizardInstallWorkspaceId(["ws", "0123456789abcdef"].join("_"))).toThrow()
    expect(() => wizardInstallWorkspaceId(`sha256:${"z".repeat(64)}`)).toThrow()
  })

  it("lists exactly the public ids an install emitted", () => {
    expect(manifestIdsFor(artifactsFromKeys(fakeKeys(), decided))).toEqual({
      ga4: [IDS.ga4],
      posthog: { projectKey: IDS.posthog, apiHost: "/ingest" },
      meta: [IDS.meta],
      infinite: { siteSourceKey: IDS.siteSource }
    })
    expect(manifestIdsFor({})).toEqual({ ga4: [], posthog: null, meta: [], infinite: null })
  })
})

describe("withConversionHelpers: THE one place conversions.helpers is set (review P3-4)", () => {
  const infinite = { siteSourceKey: "site_0123456789abcdef0123456789abcdef", consentMode: "not_required" as const, collectPath: "/c", consentStorageKey: "k" }
  it("helpers exactly when a conversion is approved AND a tool is written; dropped otherwise", () => {
    expect(withConversionHelpers({ infinite } as never, ["signup"])).toMatchObject({ conversions: { helpers: true } })
    expect(withConversionHelpers({ infinite } as never, [])).not.toHaveProperty("conversions")
    expect(withConversionHelpers({ conversions: { helpers: true } } as never, ["signup"])).not.toHaveProperty("conversions")
  })
})
