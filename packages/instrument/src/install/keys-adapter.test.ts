import { describe, expect, it } from "vitest"

import { fakeKeys, IDS, notConnectedKeys } from "../../test/wizard/o7-fakes.js"
import type { TagKeys } from "../wizard/contracts/bridge.js"

import { artifactsFromKeys, artifactsFromKeysDetailed, wizardInstallWorkspaceId } from "./keys-adapter.js"

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
    // Parity gap 5: the browser leg's match data is ON by default when Meta is connected.
    expect(artifacts.meta).toEqual({ pixelId: IDS.meta, consentMode: "not_required", advancedMatching: true })
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
    [
      "meta multiple",
      { meta: { status: "multiple", pixels: [{ pixelId: IDS.meta, sourceRef: "a", adAccountLabel: null }, { pixelId: "6543210987654321", sourceRef: "b", adAccountLabel: null }] } },
      "meta",
      "multiple_pixels"
    ],
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
})

