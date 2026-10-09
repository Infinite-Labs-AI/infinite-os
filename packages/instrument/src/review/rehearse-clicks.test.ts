// The rehearsal's click grades: a Meta standard event fired by a click is on the never-list, except the browser-only
// commerce event the click IS (a Buy button marked add_to_cart sends Meta AddToCart, with no event id).
import { describe, expect, it } from "vitest"

import type { TestResult } from "../wizard/contracts/test-engine.js"
import { clickResults } from "./rehearse.js"

function clicked(label: string, events: { ga4?: string[]; posthog?: string[]; meta?: string[]; infinite?: string[] }): TestResult {
  const click = { label, selector: `[data-infinite-conversion="${label}"]`, found: true, events: { ga4: [], posthog: [], meta: [], infinite: [], ...events }, nonGetCancelled: 0, navigatedAfterMs: null, navigationCancelled: false, refused: null }
  return { clicks: [click] } as unknown as TestResult
}

describe("rehearsal clicks and Meta", () => {
  it("an add_to_cart click that sends Meta AddToCart passes, even with nothing else (GA4 / PostHog keep the site's own names)", () => {
    expect(clickResults(clicked("add_to_cart", { meta: ["AddToCart"] }), ["add_to_cart"]).verdicts).toEqual([["add_to_cart", { state: "pass" }]])
  })

  it("any other Meta standard event from a click is still a problem (a Purchase on a Buy button, a Lead on a signup click)", () => {
    expect(clickResults(clicked("add_to_cart", { meta: ["AddToCart", "Purchase"] }), ["add_to_cart"]).verdicts[0]![1]).toEqual({ state: "problem", reason: "fbq_standard_on_click — Purchase" })
    expect(clickResults(clicked("signup", { ga4: ["signup"], meta: ["Lead"] }), ["signup"]).verdicts[0]![1]).toMatchObject({ state: "problem" })
    expect(clickResults(clicked("download", { ga4: ["download"], meta: ["AddToCart"] }), ["download"]).verdicts[0]![1]).toMatchObject({ state: "problem" })
  })
})
