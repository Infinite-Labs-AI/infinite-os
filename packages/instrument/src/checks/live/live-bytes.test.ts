// T1 live bytes (lane O9), against fixture pages built from infinite-tag's OWN emitters, through an
// injected fetch (no network). Incidents guarded (PORT-PLAN §4):
//   • guardrail counted its own visits (d2f1809) → every probe carries `Purpose: prefetch`;
//   • the expected pixel vanished and the verifier printed SKIP / exit 0 → absent = problem;
//   • preview leak with a default `phc_` (9fcbefa) → ids come only from the expectation;
//   • month-long silent outage (stale deploy, injector gap, PostHog region flip) → the live checks run
//     on their own and a wrong region / missing runtime / dead proxy is a problem, an unreadable page
//     is undetermined (never pass).
import { describe, expect, it } from "vitest"

import { FIXED_NOW, fixtureFetch, type FixtureHandler } from "../../../test/wizard/fixture-fetch.js"
import { buildManagedHtmlBlock } from "../../frameworks/managed-html.js"
import { buildMetaPixelSnippet } from "../../providers/meta.js"
import { buildPostHogBootstrapSnippet } from "../../providers/posthog.js"
import { renderInfiniteBrowserTag } from "../../runtime/infinite-browser.js"
import type { TestExpect } from "../../wizard/contracts/test-engine.js"

import { checkLiveBytes, LIVE_BYTES_CHECK_IDS } from "./live-bytes.js"

const SITE = "https://acme-store.test"
const GA4 = "G-ACME123"
const POSTHOG = "phc_acmeAcmeAcmeAcme0001"
const PIXEL = "111222333444555"
const SITE_KEY = "site_acme_live"
const ctx = { runId: "7f3c2a91-b0de-4c5e-9f00-000000000000", now: FIXED_NOW }

const ga4Snippet = (id: string) =>
  [
    "<script>",
    "window.dataLayer = window.dataLayer || [];",
    "window.gtag = window.gtag || function(){window.dataLayer.push(arguments);};",
    `(function(){ var s = document.createElement('script'); s.async = true; s.src = "https://www.googletagmanager.com/gtag/js?id=${id}"; document.head.appendChild(s); })();`,
    "window.gtag('js', new Date());",
    `window.gtag('config', "${id}");`,
    "</script>"
  ].join("\n")
const posthogSnippet = (key: string, apiHost: string) => `<script>${buildPostHogBootstrapSnippet(key, apiHost)}</script>`
const metaSnippet = (id: string) => `<script>${buildMetaPixelSnippet(id)}</script>`
const runtimeTag = (key: string) =>
  renderInfiniteBrowserTag({ siteSourceKey: key, collectPath: "/infinite/ledger", productionHosts: ["acme-store.test"], respectDnt: true, consent: { mode: "not_required" } })

function managedPage(parts: string[]): string {
  return `<!doctype html><html><head><title>Acme</title>${buildManagedHtmlBlock(parts)}</head><body><h1>Acme</h1></body></html>`
}

const FULL_EXPECT: TestExpect = {
  ga4: [GA4],
  posthog: { projectKey: POSTHOG, apiHost: "/ingest" },
  meta: [PIXEL],
  infinite: { siteSourceKey: SITE_KEY, collectPath: "/infinite/ledger" }
}

const POSTHOG_LIB: FixtureHandler = { body: "/* posthog-js array.js */ !function(){ window.posthog = window.posthog || {} }()" }

function run(routes: Record<string, FixtureHandler>, expect: TestExpect, mode: "wizard" | "doctor" = "wizard", urls = [`${SITE}/`]) {
  const fixture = fixtureFetch(routes)
  return checkLiveBytes({ urls, expect, mode }, { version: "0.12.0-test", fetch: fixture.fetch, attempts: 1 }, ctx).then((results) => ({
    results,
    requests: fixture.requests
  }))
}

const byId = (results: Awaited<ReturnType<typeof run>>["results"], checkId: string) => results.filter((result) => result.checkId === checkId)

describe("live bytes: a managed static site", () => {
  const page = managedPage([ga4Snippet(GA4), posthogSnippet(POSTHOG, "/ingest"), metaSnippet(PIXEL), runtimeTag(SITE_KEY)])

  it("passes every tool against the expected ids, and the proxy is alive", async () => {
    const { results } = await run({ [`${SITE}/`]: { body: page }, [`${SITE}/ingest/static/array.js`]: POSTHOG_LIB }, FULL_EXPECT)
    const states = Object.fromEntries(results.map((result) => [result.checkId, result.state]))
    expect(states).toMatchObject({
      [LIVE_BYTES_CHECK_IDS.ga4]: "pass",
      [LIVE_BYTES_CHECK_IDS.posthog]: "pass",
      [LIVE_BYTES_CHECK_IDS.meta]: "pass",
      [LIVE_BYTES_CHECK_IDS.metaAutoConfig]: "pass",
      [LIVE_BYTES_CHECK_IDS.metaClickIdCapture]: "pass",
      [LIVE_BYTES_CHECK_IDS.infinite]: "pass",
      [LIVE_BYTES_CHECK_IDS.census]: "pass",
      posthog_proxy: "pass"
    })
    expect(results.every((result) => result.runId === ctx.runId && result.tier === "T1")).toBe(true)
  })

  it("an expected pixel that is ABSENT is a problem, never a skip", async () => {
    const { results } = await run({ [`${SITE}/`]: { body: page }, [`${SITE}/ingest/static/array.js`]: POSTHOG_LIB }, { ...FULL_EXPECT, meta: ["999888777666555"] })
    const meta = byId(results, LIVE_BYTES_CHECK_IDS.meta)
    expect(meta.map((result) => result.state)).toEqual(["problem"])
    expect(meta[0]!.reason).toContain("is not initialised")
    // …and the pixel that IS there is reported as unknown (a plan line), not silently accepted.
    expect(byId(results, LIVE_BYTES_CHECK_IDS.metaUnknownPixel).map((result) => result.state)).toEqual(["info"])
  })

  it("a GA4 id that is not a connected stream is a problem; either of two streams passes", async () => {
    const wrong = await run({ [`${SITE}/`]: { body: page }, [`${SITE}/ingest/static/array.js`]: POSTHOG_LIB }, { ...FULL_EXPECT, ga4: ["G-OTHER999"] })
    expect(byId(wrong.results, LIVE_BYTES_CHECK_IDS.ga4)[0]!.state).toBe("problem")
    const either = await run({ [`${SITE}/`]: { body: page }, [`${SITE}/ingest/static/array.js`]: POSTHOG_LIB }, { ...FULL_EXPECT, ga4: ["G-OTHER999", GA4] })
    expect(byId(either.results, LIVE_BYTES_CHECK_IDS.ga4)[0]!.state).toBe("pass")
  })

  it("a page that cannot be read is undetermined for every tool, never a pass", async () => {
    const { results } = await run({ [`${SITE}/`]: { status: 503, body: "down" } }, FULL_EXPECT)
    expect(results.map((result) => result.state)).toEqual(["undetermined", "undetermined", "undetermined", "undetermined"])
  })
})

describe("live bytes: shapes that need care", () => {
  it("autoConfig: infinite-tag's own pixel without the opt-out is a problem; the site's own is info", async () => {
    const adopted = `<html><head><script>fbq('init', '${PIXEL}');fbq('track','PageView');</script></head><body></body></html>`
    const { results } = await run({ [`${SITE}/`]: { body: adopted } }, { meta: [PIXEL] })
    expect(byId(results, LIVE_BYTES_CHECK_IDS.metaAutoConfig)[0]!.state).toBe("info")
    expect(byId(results, LIVE_BYTES_CHECK_IDS.metaClickIdCapture)[0]!.state).toBe("info")
    const managed = managedPage([`<script>fbq('init', '${PIXEL}');fbq('track','PageView');</script>`])
    const own = await run({ [`${SITE}/`]: { body: managed } }, { meta: [PIXEL] })
    expect(byId(own.results, LIVE_BYTES_CHECK_IDS.metaAutoConfig)[0]!.state).toBe("problem")
  })

  it("the Infinite runtime must carry the expected site key (negative: a different key is a problem)", async () => {
    const page = managedPage([runtimeTag("site_someone_else")])
    const { results } = await run({ [`${SITE}/`]: { body: page } }, { infinite: FULL_EXPECT.infinite! })
    expect(byId(results, LIVE_BYTES_CHECK_IDS.infinite)[0]!.state).toBe("problem")
  })
})

describe("live bytes: never a pass or a 'not on the page' from bytes that were not read (review P2-4, P2-5, P3-6)", () => {
  it("byte_census is undetermined when a same-origin script was not read (negative: all read → pass)", async () => {
    const html = managedPage([posthogSnippet(POSTHOG, "/ingest")]).replace("</head>", `<script src="/assets/app.js"></script></head>`)
    const failed = await run({ [`${SITE}/`]: { body: html }, [`${SITE}/assets/app.js`]: { status: 404 }, [`${SITE}/ingest/static/array.js`]: POSTHOG_LIB }, { posthog: FULL_EXPECT.posthog! })
    expect(byId(failed.results, LIVE_BYTES_CHECK_IDS.census)[0]!.state).toBe("undetermined")
    const read = await run({ [`${SITE}/`]: { body: html }, [`${SITE}/assets/app.js`]: { body: "console.log(1)" }, [`${SITE}/ingest/static/array.js`]: POSTHOG_LIB }, { posthog: FULL_EXPECT.posthog! })
    expect(byId(read.results, LIVE_BYTES_CHECK_IDS.census)[0]!.state).toBe("pass")
  })
})
