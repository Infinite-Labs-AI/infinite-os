import { runInNewContext } from "node:vm"
import { renderInfiniteBrowserTag } from "../src/runtime/infinite-browser.js"

export const campaignWireQueries = [
  "utm_source=paid&ad_id=120211234567890123&adset_id=456&campaign_id=789&utm_placement=instagram_stories",
  "utm_placement=instagram%20stories", "utm_placement=feed!", "utm_placement=%7B%7Bplacement%7D%7D",
  "utm_placement=" + "x".repeat(65), "ad_id=abc", "ad_id=", "ad_id=123%0A", "ad_id=123%E2%80%A8", ""
]

/** Executes the actual serialized tag. No network, provider SDK or browser process. */
export function emitCampaignWireFixture(search: string, render = renderInfiniteBrowserTag): Record<string, unknown> {
  const location = new URL("https://example.com/pricing/?" + search)
  const storage = () => {
    const values = new Map<string, string>()
    return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
  }
  const requests: Record<string, unknown>[] = []
  let id = 0
  const window: Record<string, unknown> = { addEventListener() {} }
  const context = { window, location, document: { referrer: "https://referrer.example/", addEventListener() {} },
    localStorage: storage(), sessionStorage: storage(), history: { pushState() {}, replaceState() {} },
    navigator: { doNotTrack: "0", sendBeacon: () => false },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}` },
    fetch: async (_path: string, init: { body: string }) => { requests.push(JSON.parse(init.body)); return { ok: true } },
    setTimeout: (run: () => void) => { run(); return 1 }, clearTimeout() {}, URL, URLSearchParams, Date, JSON, Math, console }
  Object.assign(window, context)
  const tag = render({ siteSourceKey: "site_public_fixture", collectPath: "/infinite/ledger", productionHosts: ["example.com"], respectDnt: true, consent: { mode: "not_required" } })
  runInNewContext(tag.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""), context)
  if (requests.length !== 1) throw new Error("Expected exactly one emitted fixture page view")
  return requests[0]!
}
