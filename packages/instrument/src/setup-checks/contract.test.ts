import { describe, expect, it } from "vitest"

import { INFINITE_BROWSER_RUNTIME_SOURCE } from "../runtime/infinite-browser.js"

import { knownConversionValues, lanesFor, lanesMissedBy, parseConversionLanes, runtimeConversionLanes } from "./contract.js"

describe("the data-conversion contract, read off the runtime", () => {
  /**
   * THE TRIPWIRE. The setup checks are only honest while this parse keeps working: if the runtime
   * is refactored into a shape this cannot read, the checks would quietly find nothing to say and
   * every page would look clean. That failure must be loud here, not silent in a customer's report.
   */
  it("finds exactly the lanes the shipped runtime implements", () => {
    const lanes = runtimeConversionLanes()
    expect(lanes.length).toBeGreaterThan(0)
    expect(
      lanes.map((lane) => `${lane.event}:${lane.selector}`).sort()
    ).toEqual([
      'click:[data-conversion="checkout"]',
      'click:[data-conversion="signup"]',
      'submit:form[data-conversion="signup"]'
    ])
    expect(knownConversionValues(lanes)).toEqual(["checkout", "signup"])
  })

  it("keeps the runtime source readable (it is serialized with toString, not imported)", () => {
    expect(INFINITE_BROWSER_RUNTIME_SOURCE).toContain("addEventListener")
    expect(INFINITE_BROWSER_RUNTIME_SOURCE).toContain("data-conversion")
  })

  it("attributes each selector to the listener that lexically precedes it", () => {
    const lanes = parseConversionLanes(`
      document.addEventListener("click", () => { target.closest('[data-conversion="signup"]') })
      document.addEventListener("submit", () => { target.closest('form[data-conversion="signup"]') })
    `)
    expect(lanes).toEqual([
      { value: "signup", event: "click", requiredTag: null, selector: '[data-conversion="signup"]' },
      { value: "signup", event: "submit", requiredTag: "form", selector: 'form[data-conversion="signup"]' }
    ])
  })

  it("returns nothing rather than guessing when the source carries no selectors", () => {
    expect(parseConversionLanes("function runtime() { return 1 }")).toEqual([])
  })

  it("separates the lanes a tag fires from the lanes it locks out", () => {
    const lanes = runtimeConversionLanes()
    expect(lanesFor(lanes, "signup", "form").map((lane) => lane.event).sort()).toEqual(["click", "submit"])
    expect(lanesFor(lanes, "signup", "button").map((lane) => lane.event)).toEqual(["click"])
    expect(lanesMissedBy(lanes, "signup", "button").map((lane) => lane.event)).toEqual(["submit"])
    expect(lanesMissedBy(lanes, "signup", "form")).toEqual([])
  })
})
