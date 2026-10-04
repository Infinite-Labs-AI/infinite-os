// R4-13 (live run 4): "Live site today: GA4 page views per visit 1" sat next to "GA4 set up 2 times (problem)" with no
// word on how both are true. On run 4's own `before.json`: the duplicate cell says the copy uses the same ID and the
// page sent one page view per visit (LF4-P3-2: a no-send dry load whose beacons were cancelled, so GA4 itself counted nothing).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { liveTodayColumnInput } from "./before-column.js"
import { testExpectFromKeys } from "./contracts/test-engine.js"
import type { BeforeFactsFile } from "./handoff/before-facts.js"
import { buildColumn } from "./report.js"

const before = JSON.parse(readFileSync(join(__dirname, "../../test/wizard/fixtures/run4/wizard/before.json"), "utf8")) as BeforeFactsFile

function liveToday(dryLive: BeforeFactsFile["facts"]["dryLive"]) {
  const keys = before.facts.keys
  return buildColumn(
    "live_today",
    liveTodayColumnInput({
      runId: before.runId,
      measuredAt: before.measuredAt,
      keys,
      expect: testExpectFromKeys(keys),
      census: before.facts.census,
      dryLive,
      grades: before.grades,
      liveChecks: before.liveChecks,
      baseline: before.facts.baseline,
      repeatedInits: [{ tool: "ga4", id: "G-QWERT67890", count: 2 }],
      loginFound: before.loginFound,
      spaNavigationRequested: true
    })
  )
}

describe("R4-13: a duplicate that cost code, not data, says so", () => {
  it("run 4: set up 2 times with the same ID, and the page tried to send 1 page view per visit (a no-send dry load: GA4 received nothing)", () => {
    const column = liveToday(before.facts.dryLive)
    expect(column.cells.ga4_page_views_per_visit).toMatchObject({ display: "1", state: "pass" })
    expect(column.finishLine.each_tool_once).toMatchObject({ state: "problem" })
    expect(JSON.stringify(column.finishLine.each_tool_once)).toContain("GA4 set up 2 times with the same ID (the page tried to send 1 page view per visit in Infinite's no-send test, which GA4 never received: the copy costs code, not data)")
    // LF4-P3-2: never a claim that the dry load SENT anything or that GA4 counted it (every send was cancelled).
    expect(JSON.stringify(column.finishLine.each_tool_once)).not.toMatch(/GA4 still counted|the page sent 1/)
  })

  it("negative: when the load measured two page views, the words never say the copy is harmless", () => {
    const dry = structuredClone(before.facts.dryLive)!
    dry.ga4.events.push({ ...dry.ga4.events[0]! })
    const column = liveToday(dry)
    expect(column.cells.ga4_page_views_per_visit).toMatchObject({ display: "2", state: "problem" })
    expect(JSON.stringify(column)).not.toContain("costs code, not data")
  })
})
