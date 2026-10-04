// Provider census (lane O9). Incidents guarded: the 849ccf1 merge near-miss (every init is counted,
// none merged away) and the 9fcbefa default-id leak's static half (`censusEntries` exposes every
// literal id).
import { describe, expect, it } from "vitest"

import { buildManagedHtmlBlock } from "../frameworks/managed-html.js"

import { censusEntries, checkProviderCensus } from "./provider-census.js"

const files = (record: Record<string, string>) => new Map(Object.entries(record))
const page = (head: string) => `<html><head>${head}</head><body><h1>Hi</h1></body></html>`
const GTAG = (id: string) => `<script>window.dataLayer=[];function gtag(){dataLayer.push(arguments)};gtag('js', new Date());gtag('config', '${id}');</script>`

describe("provider census", () => {
  it("flags the same GA4 id configured twice on one page (problem, certain)", () => {
    const result = checkProviderCensus({ files: files({ "index.html": page(GTAG("G-ABC123") + GTAG("G-ABC123")) }) })
    expect(result.state).toBe("problem")
    expect(result.findings[0]).toMatchObject({ code: "INF_SETUP_PROVIDER_DUPLICATE_INIT", confidence: "certain", file: "index.html", line: 1 })
    // §3x.6 (A7): what the code shows, never an unmeasured claim about page views.
    expect(result.findings[0]!.message).toContain("is initialised 2 times in one page")
    expect(result.findings[0]!.message).toContain("Keep one and delete the others.")
    expect(result.findings[0]!.message).not.toMatch(/counted|double-count/)
  })

  it("does not flag one init per page across a multi-page static site (negative)", () => {
    const result = checkProviderCensus({
      files: files({ "index.html": page(GTAG("G-ABC123")), "pricing/index.html": page(GTAG("G-ABC123")), "about.html": page(GTAG("G-ABC123")) })
    })
    expect(result.findings).toEqual([])
    expect(result.state).toBe("ok")
  })

  it("ignores a commented-out init (negative)", () => {
    const result = checkProviderCensus({
      files: files({ "src/app/layout.tsx": "posthog.init('phc_abcdefghijklmnop', {})\n// posthog.init('phc_abcdefghijklmnop', {})\n/* posthog.init('phc_abcdefghijklmnop') */" })
    })
    expect(result.findings).toEqual([])
  })

  it("flags a shared entry plus the same id in another module (likely)", () => {
    const result = checkProviderCensus({
      files: files({
        "app/layout.tsx": "posthog.init('phc_abcdefghijklmnop', { api_host: '/ingest' })",
        "components/analytics.tsx": "posthog.init('phc_abcdefghijklmnop', { api_host: '/ingest' })"
      })
    })
    expect(result.findings.map((finding) => [finding.code, finding.confidence])).toEqual([["INF_SETUP_PROVIDER_DUPLICATE_INIT", "likely"]])
  })

  it("flags infinite-tag's managed block plus the site's own init on one page", () => {
    const managed = buildManagedHtmlBlock([GTAG("G-ABC123")])
    const result = checkProviderCensus({ files: files({ "index.html": page(`${managed}\n${GTAG("G-XYZ789")}`) }) })
    const codes = result.findings.map((finding) => finding.code)
    expect(codes).toContain("INF_SETUP_PROVIDER_MANAGED_AND_ADOPTED")
    expect(codes).toContain("INF_SETUP_PROVIDER_MULTIPLE_IDS")
    expect(result.state).toBe("problem")
  })

  it("reads the managed Next bootstrap (escaped JSON literal) as managed", () => {
    const bootstrap = JSON.stringify("posthog.init(\"phc_abcdefghijklmnop\", { api_host: \"/ingest\" });")
    const module = `// Managed by Infinite. Public install artifacts only.\n\nconst bootstrapSource = ${bootstrap}\n`
    const entries = censusEntries(files({ "lib/infinite-analytics.ts": module }))
    expect(entries).toEqual([
      { tool: "posthog", kind: "posthog_init", id: "phc_abcdefghijklmnop", file: "lib/infinite-analytics.ts", line: 3, owner: "managed" }
    ])
  })

  it("notes GTM next to a hand-written gtag (info: the container is not read)", () => {
    const html = page(`<script src="https://www.googletagmanager.com/gtm.js?id=GTM-AB12CD"></script>${GTAG("G-ABC123")}`)
    const result = checkProviderCensus({ files: files({ "index.html": html }) })
    expect(result.findings.map((finding) => [finding.code, finding.state])).toEqual([["INF_SETUP_PROVIDER_GTM_AND_GTAG", "info"]])
  })

  it("counts every Meta bootstrap init, but not the Advanced Matching re-init", () => {
    const html = page("<script>fbq('init', '111222333444555');fbq('init', '111222333444555', {em: h});fbq('track','PageView');</script>")
    expect(checkProviderCensus({ files: files({ "index.html": html }) }).findings).toEqual([])
    const twice = page("<script>fbq('init', '111222333444555');fbq('init', '111222333444555');</script>")
    expect(checkProviderCensus({ files: files({ "index.html": twice }) }).findings[0]?.code).toBe("INF_SETUP_PROVIDER_DUPLICATE_INIT")
  })

  it("one line for the same duplicate on many pages", () => {
    const twice = page(GTAG("G-ABC123") + GTAG("G-ABC123"))
    const result = checkProviderCensus({ files: files({ "a.html": twice, "b.html": twice, "c.html": twice }) })
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]!.message).toContain("The same applies at b.html:1, c.html:1.")
  })
})
