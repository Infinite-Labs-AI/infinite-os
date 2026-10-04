// Live run 5 (review 2 P3-d): a desktop that waits out GA4's ~5 s event batch spends about 7 s per click and 7.5 s per
// page change (1bu-1 `test-engine/engine.ts` DEFAULT_CLICK_SETTLE_MS / DEFAULT_NAV_SETTLE_MS), so 20 clicks alone would
// pass the fixed 180 s rehearsal deadline. Its deadline grows with the clicks; an older desktop keeps the fixed one.
import { describe, expect, it } from "vitest"

import { TEST_LIMITS } from "../wizard/contracts/test-engine.js"
import { rehearsalDeadlineMs } from "./rehearse.js"

describe("review 2 P3-d: the rehearsal's deadline scales with its clicks on a desktop that waits out GA4's batch", () => {
  it("adds 7.5 s per click and for the page change, up to the most a desktop accepts", () => {
    expect(rehearsalDeadlineMs(0, false, true)).toBe(180_000)
    expect(rehearsalDeadlineMs(4, true, true)).toBe(180_000 + 4 * 7_500 + 7_500)
    expect(rehearsalDeadlineMs(TEST_LIMITS.maxClicks, true, true)).toBe(TEST_LIMITS.rehearsalMaxDeadlineMs)
    expect(TEST_LIMITS.rehearsalMaxDeadlineMs).toBe(337_500)
    expect(rehearsalDeadlineMs(500, true, true)).toBe(TEST_LIMITS.rehearsalMaxDeadlineMs)
  })

  it("covers the desktop's own worst case: 20 clicks at 7 s, a 7.5 s page change and two loads with their 4 s settle", () => {
    const desktopClicksAndChange = 20 * 7_000 + 7_500
    const twoSlowLoads = 2 * (30_000 + 4_000)
    expect(rehearsalDeadlineMs(20, true, true)).toBeGreaterThan(desktopClicksAndChange + twoSlowLoads)
  })

  it("an older desktop (no tag.test.ga4-batch.v1: 2 s per click, caps rehearsal at 180 s) keeps the fixed deadline", () => {
    expect(rehearsalDeadlineMs(20, true, false)).toBe(TEST_LIMITS.deadlineMs.rehearsal)
  })
})
