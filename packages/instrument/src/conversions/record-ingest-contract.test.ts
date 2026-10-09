// Review P0-3: every event the managed helpers record to Infinite must be one the cloud ACCEPTS. The send is
// fire-and-forget, so an event the ingest rejects (invalid_event 400) is lost with no error anywhere.
//
// This runs the REAL runtime and the REAL helper script together in one vm page, drives the helpers the way a store's
// code does (product view, Buy with a navigation, Meta-only, a custom CTA), captures every beacon the runtime sends,
// and checks each one against the cloud's own rules, copied into `test/fixtures/browser-ingest-v1.contract.json` from
// 1bu-1 `src/lib/analytics/ingest.ts` (its source line names the commit).
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { createBrowserVm } from "../../test/site-code/browser-vm.js"
import { renderInfiniteBrowserTag } from "../runtime/infinite-browser.js"
import { buildConversionHelpersScript } from "./globals.js"

interface IngestContract {
  browserEvents: string[]
  payloadKeys: string[]
  propertyKeys: string[]
  pageViewOnlyKeys: string[]
  maxProperties: number
  structuralToken: string
  siteClickRequires: string[]
}

const contract = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/browser-ingest-v1.contract.json"), "utf8")
) as IngestContract

/** The cloud's accept/reject decision for one browser event, as `parseBrowserEvent` + `cleanProperties` make it. */
function ingestRejects(body: Record<string, unknown>): string | null {
  if (!contract.browserEvents.includes(String(body.eventName))) return `event name ${String(body.eventName)}`
  for (const key of Object.keys(body)) if (!contract.payloadKeys.includes(key)) return `payload key ${key}`
  const properties = (body.properties ?? {}) as Record<string, unknown>
  const keys = Object.keys(properties)
  if (keys.length > contract.maxProperties) return "too many properties"
  for (const key of keys) {
    if (!contract.propertyKeys.includes(key)) return `property ${key}`
    if (body.eventName !== "site_page_view" && contract.pageViewOnlyKeys.includes(key)) return `page-view key ${key} on ${String(body.eventName)}`
  }
  const token = new RegExp(contract.structuralToken)
  for (const key of ["cta_id", "cta_location"]) {
    if (key in properties && (typeof properties[key] !== "string" || !token.test(properties[key] as string))) return `${key} not a token`
  }
  if (body.eventName === "site_click") for (const key of contract.siteClickRequires) if (!(key in properties)) return `site_click without ${key}`
  return null
}

function storePage() {
  const vm = createBrowserVm({ url: "https://acme.com/products/trail-pack" })
  const fbq: unknown[][] = []
  vm.window.fbq = (...args: unknown[]) => void fbq.push(args)
  vm.window.posthog = { capture() {} }
  vm.window.gtag = () => {}
  const tag = renderInfiniteBrowserTag({
    siteSourceKey: "site_public_fixture",
    collectPath: "/infinite/ledger",
    respectDnt: true,
    consent: { mode: "not_required" },
    productionHosts: ["acme.com"]
  })
  vm.runScript(tag.replace(/^<script[^>]*>/i, "").replace(/<\/script[^>]*>$/i, ""))
  vm.runScript(buildConversionHelpersScript({ consentMode: "not_required", ownHosts: ["acme.com"], currency: "USD", metaPixelId: "1234567890123456" }))
  expect(vm.scriptErrors).toEqual([])
  const bodies = () => vm.beacons.map((beacon) => JSON.parse(String(beacon.body)) as Record<string, unknown>)
  return { vm, fbq, bodies }
}

describe("helper-recorded events pass the cloud's browser ingest (review P0-3)", () => {
  it("the contract fixture names its source", () => {
    const raw = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/browser-ingest-v1.contract.json"), "utf8")) as { source: string }
    expect(raw.source).toMatch(/src\/lib\/analytics\/ingest\.ts/)
  })

  it("every beacon a store's product, Buy, Meta-only and CTA calls produce is accepted, and carries no product or money", async () => {
    const page = storePage()
    const product = "{ item_id: 'sku_2', item_name: 'Trail Pack', price: 249, quantity: 1, value: 249, currency: 'USD' }"
    page.vm.evaluate(`infiniteTrack('view_item', ${product})`)
    page.vm.evaluate(`infiniteTrack('add_to_cart', ${product}, { destinations: ['meta', 'infinite'] })`)
    page.vm.evaluate(`infiniteTrack('hero_cta', { cta_location: 'hero', plan: 'pro' }, { destinations: { meta: true } })`)
    page.vm.evaluate(`infiniteTrackThenNavigate(null, '/cart', 'add_to_cart', ${product})`)
    await page.vm.advance(1000)

    const bodies = page.bodies()
    const clicks = bodies.filter((body) => body.eventName === "site_click")
    expect(clicks.map((body) => (body.properties as Record<string, unknown>).cta_id)).toEqual(["view_item", "add_to_cart", "hero_cta", "add_to_cart"])
    for (const body of bodies) expect(ingestRejects(body), JSON.stringify(body)).toBeNull()
    for (const body of clicks) expect(body.properties).toEqual({ cta_id: (body.properties as Record<string, unknown>).cta_id, cta_location: "conversion" })
    // The money still reached Meta (and would reach GA4/PostHog): only Infinite's ledger leaves it out.
    expect(page.fbq.some((call) => call[1] === "AddToCart" && (call[2] as Record<string, unknown>).value === 249)).toBe(true)
  })

  it("negative: the event the old helper sent (product keys on a site_click) is one the cloud rejects", () => {
    const old = {
      siteSourceKey: "site_public_fixture",
      eventId: "00000000-0000-4000-8000-000000000003",
      eventName: "site_click",
      occurredAt: "2026-10-08T09:00:00.000Z",
      anonymousId: "00000000-0000-4000-8000-000000000001",
      sessionId: "00000000-0000-4000-8000-000000000002",
      url: "https://acme.com/products/trail-pack/",
      properties: { cta_id: "add_to_cart", cta_location: "conversion", item_id: "sku_2", value: 249, currency: "USD" }
    }
    expect(ingestRejects(old)).toBe("property item_id")
  })

  it("destinations without 'infinite' record nothing to Infinite", () => {
    const page = storePage()
    page.vm.evaluate("infiniteTrack('add_to_cart', { item_id: 'sku_2', price: 249 }, { destinations: ['meta'] })")
    expect(page.bodies().filter((body) => body.eventName === "site_click")).toEqual([])
  })
})
