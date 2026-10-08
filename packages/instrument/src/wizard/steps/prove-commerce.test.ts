// Review r3 "static checks / prove": prove used to check Meta's PageView only. The shop-event proof checks, on the
// deployed code, that a product page sends Meta ViewContent and a Buy click sends AddToCart (no-send rehearsal of the
// merge's own deployment), says value and currency are not measurable by a browser test, and reads Infinite's own
// record for the server events. Every line is seen, missing, or not measured with its reason.
import { describe, expect, it } from "vitest"

import { HOST, MERGE_SHA, PIXEL_ID, RUN_ID, fakeContext, fakeDeps, realVisitResult } from "../../../test/wizard/runtime-fakes.js"
import type { EventInventory } from "../../checks/commerce-inventory.js"
import type { BaselineResponseFields } from "../contracts/report.js"
import type { TestResult, TestRunRequest } from "../contracts/test-engine.js"
import { WIZARD_PATHS } from "../contracts/state.js"
import { createRunState } from "../run-state.js"
import { commerceProofPlan, gradeCommerceBrowser, gradeCommerceServer, productPagePath, proveCommerce } from "./prove-commerce.js"
import { step } from "./prove.js"

const INVENTORY: EventInventory = {
  rows: [
    { event: "view_item", tools: { ga4: { state: "already_sent" }, meta: { state: "will_add", lane: "browser" } }, sites: [{ file: "pages/products/[slug].tsx", line: 20 }] },
    { event: "add_to_cart", tools: { ga4: { state: "already_sent" }, meta: { state: "will_add", lane: "browser" } }, sites: [{ file: "pages/index.tsx", line: 15 }] },
    { event: "purchase", tools: { ga4: { state: "already_sent" }, meta: { state: "will_add", lane: "server" }, infinite: { state: "will_add", lane: "server" } } },
    { event: "lead", tools: { meta: { state: "will_add", lane: "server" } } }
  ]
}
const FILES = new Map([
  ["pages/products/[slug].tsx", "export default function Product() { return null }\n"],
  ["components/Layout.tsx", '<Link href="/products/oak-one">Oak</Link>\n<Link href="/cart">Cart</Link>\n']
])

function rehearsalResult(overrides: Partial<TestResult> = {}): TestResult {
  return realVisitResult({
    mode: "rehearsal",
    loads: [
      { label: "product_page", url: `https://${HOST}/products/oak-one`, finalUrl: `https://${HOST}/products/oak-one`, status: 200, rendered: true, managedMarkerSeen: true, redirects: [] },
      { label: "home", url: `https://${HOST}/`, finalUrl: `https://${HOST}/`, status: 200, rendered: true, managedMarkerSeen: true, redirects: [] }
    ],
    meta: {
      configRequests: [PIXEL_ID],
      tr: [
        { pixelId: PIXEL_ID, ev: "PageView", eid: null, method: "GET", status: "cancelled", loadLabel: "product_page", afterNav: false },
        { pixelId: PIXEL_ID, ev: "ViewContent", eid: null, method: "GET", status: "cancelled", loadLabel: "product_page", afterNav: false },
        { pixelId: PIXEL_ID, ev: "PageView", eid: null, method: "GET", status: "cancelled", loadLabel: "home", afterNav: false }
      ],
      console: [],
      fbc: { present: false, value: null, domain: null },
      fbp: { present: true }
    },
    clicks: [{ label: "add_to_cart", selector: '[data-infinite-conversion="add_to_cart"]', found: true, events: { ga4: ["add_to_cart"], posthog: [], meta: ["AddToCart"], infinite: ["add_to_cart"] }, nonGetCancelled: 2, navigatedAfterMs: 420, navigationCancelled: false, refused: null }],
    ...overrides
  })
}

describe("what to prove", () => {
  it("resolves a dynamic product route to the first literal link to it; a static route is itself; none → null", () => {
    expect(productPagePath(INVENTORY, FILES, ".")).toBe("/products/oak-one")
    const statics: EventInventory = { rows: [{ event: "view_item", tools: {}, sites: [{ file: "pages/shop/oak.tsx", line: 3 }] }] }
    expect(productPagePath(statics, new Map(), ".")).toBe("/shop/oak")
    expect(productPagePath(INVENTORY, new Map([["components/Layout.tsx", '"/cart"']]), ".")).toBeNull()
  })

  it("takes Meta's browser events and the server events from the plan's promises", () => {
    expect(commerceProofPlan(INVENTORY, FILES, ".")).toEqual({ browser: ["view_item", "add_to_cart"], server: ["purchase", "lead"], productPath: "/products/oak-one" })
  })
})

describe("grading the deployed code's rehearsal", () => {
  const plan = commerceProofPlan(INVENTORY, FILES, ".")

  it("ViewContent on the product page and AddToCart on the Buy click are seen; value and currency are said to be unmeasured", () => {
    const lines = gradeCommerceBrowser(plan, rehearsalResult(), null)
    expect(lines.map((line) => [line.id, line.state])).toEqual([
      ["meta:view_item", "seen"],
      ["meta:add_to_cart", "seen"],
      ["meta:value_currency", "not_measured"]
    ])
    expect(lines[2]!.words).toMatch(/never their contents/)
  })

  it("Meta running but the events absent (a PageView-only run) is MISSING, never a pass", () => {
    const pageViewOnly = rehearsalResult({
      meta: { ...rehearsalResult().meta, tr: rehearsalResult().meta.tr.filter((tr) => tr.ev === "PageView") },
      clicks: [{ ...rehearsalResult().clicks[0]!, events: { ga4: ["add_to_cart"], posthog: [], meta: [], infinite: [] } }]
    })
    const lines = gradeCommerceBrowser(plan, pageViewOnly, null)
    expect(lines.slice(0, 2).map((line) => line.state)).toEqual(["missing", "missing"])
    expect(lines[0]!.words).toBe("Meta ViewContent: NOT sent on /products/oak-one; Meta's pixel ran there but got no ViewContent.")
  })

  it("Meta never started (a cookie banner), no Buy button marked, or no load at all: not measured, with the reason", () => {
    const noMeta = rehearsalResult({ meta: { ...rehearsalResult().meta, tr: [], configRequests: [] }, clicks: [{ ...rehearsalResult().clicks[0]!, events: { ga4: [], posthog: [], meta: [], infinite: [] } }] })
    const lines = gradeCommerceBrowser(plan, noMeta, null)
    expect(lines.slice(0, 2).every((line) => line.state === "not_measured" && /did not run in the test browser/.test(line.words))).toBe(true)
    const unmarked = gradeCommerceBrowser(plan, rehearsalResult({ clicks: [{ ...rehearsalResult().clicks[0]!, found: false }] }), null)
    expect(unmarked[1]!.words).toMatch(/no Buy button marked data-infinite-conversion="add_to_cart"/)
    expect(gradeCommerceBrowser(plan, null, "the deployment address is password protected").slice(0, 2).map((line) => line.words)).toEqual([
      "Meta ViewContent: not measured (the deployment address is password protected).",
      "Meta AddToCart: not measured (the deployment address is password protected)."
    ])
  })

  it("server events: a real one in Infinite's record since the merge is seen; none yet is waiting, never a failure", () => {
    const baseline = { conversions: { infinite: [{ name: "purchase", count: 2 }, { name: "generate_lead", count: 0 }] } } as Pick<BaselineResponseFields, "conversions">
    expect(gradeCommerceServer(plan, baseline, null)).toEqual([
      { id: "infinite:purchase", state: "seen", words: "purchase from your server: Infinite has received 2 since the merge." },
      { id: "infinite:lead", state: "not_measured", words: "lead from your server: none has reached Infinite since the merge yet; it shows after the first real one." }
    ])
    expect(gradeCommerceServer(plan, null, "this Infinite app cannot read it yet")[0]!.state).toBe("not_measured")
  })
})

describe("running it", () => {
  const state = () => {
    const run = createRunState({ tagVersion: "0.12.0", root: "/repo", appRoot: ".", now: new Date("2026-10-02T09:00:00Z"), displayId: "r-7f3c" })
    run.runId = RUN_ID
    return run
  }
  const reader = (url: string | null) => ({
    productionDeployment: async () => ({ state: "ready" as const }),
    productionDeploymentUrl: async () => url,
    latestProductionDeployment: async () => null,
    vercelDeploymentSeen: async () => true
  })

  it("asks ONE no-send rehearsal of the merge's own deployment under the production host, with the product page and the Buy click", async () => {
    const bundle = fakeDeps({ bridge: { testPolls: [{ state: "done", progress: [], result: rehearsalResult() }] } })
    bundle.deps.bridge.baseline = (async () => ({ protocolVersion: 1, requestId: "r", window: { days: 1, from: "", to: "" }, conversions: { infinite: [{ name: "purchase", count: 1 }] } })) as unknown as typeof bundle.deps.bridge.baseline
    const ctx = fakeContext(state(), {}, bundle.clock)
    const lines = await proveCommerce(ctx, bundle.deps, {
      runId: RUN_ID,
      mergeSha: MERGE_SHA,
      productionHost: HOST,
      expect: {},
      reader: reader("https://acme-store-git-9f1e2d.vercel.app"),
      inventory: INVENTORY,
      files: FILES,
      since: "2026-10-02T09:38:00.000Z"
    })
    const started = bundle.log.calls.filter((call) => call.what === "startTest").map((call) => call.args[0] as TestRunRequest)
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({
      mode: "rehearsal",
      productionHost: HOST,
      rehearsal: { previewOrigin: "https://acme-store-git-9f1e2d.vercel.app", headSha: MERGE_SHA },
      targets: [
        { url: `https://${HOST}/products/oak-one`, label: "product_page" },
        { url: `https://${HOST}/`, label: "home" }
      ],
      clicks: [{ selector: '[data-infinite-conversion="add_to_cart"]', label: "add_to_cart" }]
    })
    expect(lines.map((line) => `${line.id}:${line.state}`)).toEqual(["meta:view_item:seen", "meta:add_to_cart:seen", "meta:value_currency:not_measured", "infinite:purchase:seen", "infinite:lead:not_measured"])
  })

  it("no deployment address, or no inventory: nothing is claimed (not measured, or no lines at all)", async () => {
    const bundle = fakeDeps()
    const ctx = fakeContext(state(), {}, bundle.clock)
    const base = { runId: RUN_ID, mergeSha: MERGE_SHA, productionHost: HOST, expect: {}, files: FILES, since: null }
    const lines = await proveCommerce(ctx, bundle.deps, { ...base, reader: reader(null), inventory: INVENTORY })
    expect(bundle.log.calls.some((call) => call.what === "startTest")).toBe(false)
    expect(lines.filter((line) => line.id.startsWith("meta:")).every((line) => line.state === "not_measured")).toBe(true)
    expect(lines.find((line) => line.id === "infinite:purchase")!.words).toMatch(/the merge time is not known/)
    expect(await proveCommerce(ctx, bundle.deps, { ...base, reader: null, inventory: null })).toEqual([])
  })

  it("the prove step says the shop lines after the deploy when the run's inventory promised them", async () => {
    const bundle = fakeDeps()
    const run = state()
    run.pr = { host: "github", number: 42, url: "https://github.com/acme/acme-store/pull/42", nodeId: "PR_x", isDraft: false, round: 1, reviewedSha: null, handledThreadIds: [], mergeSha: MERGE_SHA }
    const ctx = fakeContext(run, {}, bundle.clock)
    const before = { schema: "infinite-tag.before-facts.v1", runId: RUN_ID, measuredAt: "2026-10-02T09:00:00.000Z", facts: { census: { entries: [] }, keys: {}, hosting: {}, dryLive: null }, eventInventory: INVENTORY }
    await bundle.deps.fs.writeTextAtomic(`/repo/${WIZARD_PATHS.beforeFacts}`, JSON.stringify(before), 0o600)
    const outcome = await step.run(ctx, bundle.deps)
    expect(outcome.kind).toBe("ok")
    const subs = ctx.events.filter((event) => event.type === "step.sub").map((event) => (event.fields as { text: string }).text)
    expect(subs).toContain("· Meta AddToCart: not measured (the merge's own deployment address is only known through GitHub on Vercel).")
    expect(subs.some((text) => text.startsWith("· purchase from your server: not measured"))).toBe(true)
  })
})
