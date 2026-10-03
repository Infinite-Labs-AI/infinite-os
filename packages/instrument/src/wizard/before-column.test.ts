// The live_today column's inputs (lane O8, review P1-2): a pure mapping from `before`'s facts to the typed
// readings lane O1's column builder turns into cells. These tests hold it to §3i: every reading names a
// live_today input of FINISH_LINE_SOURCES, an unmeasured value is null with a reason (never 0), and an
// undetermined grade is never a problem.
import { describe, expect, it } from "vitest"

import { census, fixtureBaseline, fixtureDryLive, fixtureKeys, RUN_ID } from "../../test/wizard/o8/fixtures.js"
import { liveTodayColumnInput, type LiveTodaySource } from "./before-column.js"
import type { CheckResult } from "./contracts/jobs.js"
import { FINISH_LINE_IDS, FINISH_LINE_SOURCES, PROVENANCE_SOURCES } from "./contracts/report.js"
import { testExpectFromKeys, type TestTool } from "./contracts/test-engine.js"

const AT = "2026-10-02T09:12:00.000Z"
const grade = (tool: TestTool, state: CheckResult["state"], reason?: string): CheckResult => ({ checkId: `dry_live_${tool}`, tier: "T1", state, at: AT, runId: RUN_ID, ...(reason ? { reason } : {}) })

function source(overrides: Partial<LiveTodaySource> = {}): LiveTodaySource {
  const keys = fixtureKeys()
  return {
    runId: RUN_ID,
    measuredAt: AT,
    keys,
    expect: testExpectFromKeys(keys),
    census: census([{ tool: "ga4", kind: "gtag_config", id: "G-FAKE00001", file: "app/layout.tsx", line: 2 }]),
    dryLive: fixtureDryLive(),
    grades: { infinite: grade("infinite", "pass"), ga4: grade("ga4", "pass"), posthog: grade("posthog", "pass"), meta: grade("meta", "problem", "traffic_permissions_blocked") },
    liveChecks: [
      { checkId: "live_bytes", tier: "T1", state: "pass", at: AT, runId: RUN_ID },
      { checkId: "redirect_walk", tier: "T1", state: "problem", at: AT, runId: RUN_ID },
      { checkId: "csp_header", tier: "T1", state: "pass", at: AT, runId: RUN_ID },
      { checkId: "meta_domains", tier: "T1", state: "pass", at: AT, runId: RUN_ID }
    ],
    baseline: fixtureBaseline(),
    repeatedInits: [],
    loginFound: true,
    spaNavigationRequested: true,
    ...overrides
  }
}

describe("liveTodayColumnInput", () => {
  it("uses only live_today inputs §3i.7 allows, and row sources §3i.2 allows (no agent source)", () => {
    const input = liveTodayColumnInput(source())
    const allowed = new Set(FINISH_LINE_IDS.flatMap((id) => FINISH_LINE_SOURCES[id].live_today.inputs))
    for (const fact of input.facts) expect(allowed.has(fact.input)).toBe(true)
    for (const row of Object.values(input.rows)) expect(PROVENANCE_SOURCES).toContain(row!.source)
    // F17: §3i.1 and the cloud parser want null here (the live site has no commit SHA).
    expect(input.meta).toEqual({ measuredAt: AT, sha: null })
    // The meta_domains check maps to no live_today input (it is not a finish-line reading here).
    expect(input.facts.some((fact) => fact.checkId === "meta_domains")).toBe(false)
  })

  it("maps the dry load, the T1 reads and the cloud's baseline to their readings", () => {
    const input = liveTodayColumnInput(source())
    const byInput = (name: string) => input.facts.filter((fact) => fact.input === name)
    expect(byInput("dry_live.graded").find((fact) => fact.display?.startsWith("Meta pixel"))).toMatchObject({ state: "problem", display: "Meta pixel: blocked on www.acme-store.com" })
    expect(byInput("t1.redirect_walk")).toEqual([{ input: "t1.redirect_walk", state: "problem", at: AT, checkId: "redirect_walk" }])
    expect(byInput("baseline.preview_share")[0]).toMatchObject({ state: "problem", display: "5 of 44 page views from previews" })
    // The fixture site has no consent mode recorded yet.
    expect(byInput("keys.consent_mode")[0]).toMatchObject({ state: "problem", display: "not recorded" })
    expect(input.rows.preview_share).toMatchObject({ value: 5, raw: { numerator: 5, denominator: 44 }, state: "problem", source: "cloud_read" })
    expect(input.rows.meta_pixel).toMatchObject({ state: "problem", display: "blocked on www.acme-store.com", source: "desktop_test" })
    expect(input.rows.live_test_per_tool).toMatchObject({ value: "3/4", state: "problem" })
  })

  it("never shows an unmeasured value as 0 (negative: no baseline, no dry load, nothing connected)", () => {
    const input = liveTodayColumnInput(source({ baseline: null, dryLive: null, grades: null }))
    for (const id of ["preview_share", "server_conversions", "ga4_key_events", "ga4_page_views_per_visit", "posthog_route", "live_test_per_tool"] as const) {
      expect(input.rows[id]).toMatchObject({ value: null, reason: expect.any(String) })
      expect(input.rows[id]!.state === "pass" || input.rows[id]!.state === "problem").toBe(false)
    }
    expect(input.rows.preview_share!.reason).toBe("read_failed")
    expect(input.facts.some((fact) => fact.input.startsWith("baseline.") || fact.input.startsWith("dry_live."))).toBe(false)
    const keys = fixtureKeys()
    keys.ga4 = { status: "not_connected", propertyLabel: null, streams: [] }
    const unconnected = liveTodayColumnInput(source({ keys, expect: testExpectFromKeys(keys) }))
    expect(unconnected.rows.ga4_page_views_per_visit).toMatchObject({ value: null, reason: "not_connected" })
  })

  it("an undetermined grade (held by consent) is never a problem", () => {
    const held = liveTodayColumnInput(source({ grades: { infinite: grade("infinite", "pass"), ga4: grade("ga4", "undetermined", "held_by_consent"), posthog: grade("posthog", "pass"), meta: grade("meta", "undetermined", "held_by_consent") } }))
    const meta = held.facts.find((fact) => fact.input === "dry_live.graded" && fact.display?.startsWith("Meta pixel"))!
    expect(meta).toMatchObject({ state: "undetermined", reason: "held_by_consent" })
    expect(held.rows.meta_pixel).toMatchObject({ value: null, state: "undetermined", reason: "held_by_consent" })
    expect(held.rows.ga4_page_views_per_visit).toMatchObject({ value: null, state: "undetermined", reason: "held_by_consent" })
    expect(held.rows.live_test_per_tool!.state).toBe("undetermined")
  })

  it("reads identity from the census only where a login exists, and duplicates from the census", () => {
    expect(liveTodayColumnInput(source()).facts.find((fact) => fact.input === "census.identify_reset")).toMatchObject({ state: "problem" })
    expect(liveTodayColumnInput(source({ loginFound: false })).facts.find((fact) => fact.input === "census.identify_reset")).toMatchObject({ state: "info" })
    const repeated = liveTodayColumnInput(source({ repeatedInits: [{ tool: "ga4", id: "G-FAKE00001", count: 2 }] }))
    // R4-13: this source's no-send load measured 1 GA4 page view per visit, so the cell says the copy cost code, not data.
    expect(repeated.facts.find((fact) => fact.input === "census")).toMatchObject({ state: "problem", display: "GA4 set up 2 times with the same ID (GA4 still counted 1 page view per visit: the copy costs code, not data)" })
    expect(liveTodayColumnInput(source({ repeatedInits: [{ tool: "ga4", id: "G-FAKE00001", count: 2 }], dryLive: null })).facts.find((fact) => fact.input === "census")).toMatchObject({ display: "GA4 set up 2 times" })
  })
})
