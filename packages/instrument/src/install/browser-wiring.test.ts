// The installer's browser wiring: the tag's route rules (review P1-6), the site currency on the helpers (review P2),
// the managed pixel's route-change PageViews (parity gap 8), and that each reaches the bytes the page runs.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import { buildConversionHelpersScript, conversionHelpersOptions } from "../conversions/globals.js"
import { infiniteProviderAdapter } from "../providers/infinite.js"
import type { InfinitePublicArtifact } from "../types.js"
import { pixelFreePathsOf, withMetaRouteChangePageViews, withSiteCurrency } from "./installer.js"
import type { WizardInstallArtifacts } from "./keys-adapter.js"

const INFINITE: InfinitePublicArtifact = {
  siteSourceKey: "site_public_abc123",
  collectPath: "/infinite/ledger",
  productionHosts: ["shop.example"],
  consentMode: "not_required"
}
const PIXEL = "1116400780828774"

function site(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "browser-wiring-"))
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), contents)
  }
  return root
}

function runtimeConfig(artifact: InfinitePublicArtifact): string {
  const planned = infiniteProviderAdapter.plan("static-html", artifact, { artifacts: { infinite: artifact } })
  expect(planned.blockers).toEqual([])
  return planned.instructions[0]!.snippet
}

describe("the site's pixel-restricted routes (review P1-6)", () => {
  it("become pixelFreePaths: root-relative literal routes only, never '/', sorted and unique", () => {
    expect(pixelFreePathsOf({ pixelRestrictedRoutes: ["/success", "/cart", "/cart", "/", "/products/[id]", "https://x.example/a", "/mailing-list"] })).toEqual([
      "/cart",
      "/mailing-list",
      "/success"
    ])
    expect(pixelFreePathsOf({})).toEqual([])
  })

  it("reach the runtime config only with follow mode, and are never route exclusions", () => {
    const followed = runtimeConfig({ ...INFINITE, followSitePixels: true, pixelFreePaths: ["/cart", "/success"] })
    expect(followed).toContain('"pixelFreePaths":["/cart","/success"]')
    expect(followed).not.toContain('"excludedPaths":')
    const plain = runtimeConfig({ ...INFINITE, pixelFreePaths: ["/cart"] })
    expect(plain).not.toContain('"pixelFreePaths":')
  })
})

describe("the site currency (review P2)", () => {
  const helpers: WizardInstallArtifacts = { infinite: INFINITE, conversions: { helpers: true } }

  it("rides on the helpers when the scan found one, uppercased", () => {
    const withCurrency = withSiteCurrency(helpers, { siteCurrency: "usd" })
    expect(withCurrency.conversions).toEqual({ helpers: true, currency: "USD" })
    expect(buildConversionHelpersScript(conversionHelpersOptions(withCurrency))).toContain('var INFINITE_SITE_CURRENCY = "USD";')
  })

  it("is left out when unknown or invalid, or when no helpers are written", () => {
    expect(withSiteCurrency(helpers, {}).conversions).toEqual({ helpers: true })
    expect(withSiteCurrency(helpers, { siteCurrency: "dollars" }).conversions).toEqual({ helpers: true })
    const none: WizardInstallArtifacts = { infinite: INFINITE }
    expect(withSiteCurrency(none, { siteCurrency: "USD" }).conversions).toBeUndefined()
  })
})

describe("route-change PageViews for the managed Meta pixel (parity gap 8)", () => {
  const managed: WizardInstallArtifacts = { infinite: INFINITE, meta: { pixelId: PIXEL } }

  it("are on for a single-page app whose own code sends no Meta PageView", () => {
    const root = site({ "pages/index.tsx": "export default function Home() { return null }\n" })
    const wired = withMetaRouteChangePageViews(managed, { framework: "next-pages-router", root, appRoot: "." })
    expect(wired.infinite?.metaPageViews).toBe(true)
    expect(runtimeConfig(wired.infinite!)).toContain('"metaPageViews":true')
  })

  it("are off when the site's own code already sends one (a route-change handler would double it)", () => {
    const root = site({ "src/tracking.ts": "export function onRoute() { window.fbq('track', 'PageView') }\n" })
    expect(withMetaRouteChangePageViews(managed, { framework: "next-pages-router", root, appRoot: "." }).infinite?.metaPageViews).toBeUndefined()
  })

  it("are off for a multi-page site, a capture-only install beside the site's own pixel, or no Meta at all", () => {
    const root = site({ "index.html": "<html></html>\n" })
    expect(withMetaRouteChangePageViews(managed, { framework: "static-html", root, appRoot: "." }).infinite?.metaPageViews).toBeUndefined()
    const spa = site({ "src/main.tsx": "export {}\n" })
    expect(withMetaRouteChangePageViews({ infinite: INFINITE, meta: { pixelId: PIXEL, captureOnly: true } }, { framework: "vite-react", root: spa, appRoot: "." }).infinite?.metaPageViews).toBeUndefined()
    expect(withMetaRouteChangePageViews({ infinite: INFINITE }, { framework: "vite-react", root: spa, appRoot: "." }).infinite?.metaPageViews).toBeUndefined()
  })
})
