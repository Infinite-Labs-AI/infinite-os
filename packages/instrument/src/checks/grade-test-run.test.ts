// THE grader (§3h.8), executed over every case in `contracts/tag-wizard-v1/test-run.fixtures.json` (the
// cross-repo fixtures 1bu-1's desktop also produces), plus negatives that flip one fact and must flip
// the verdict. Incidents named here (wf5-PORT-PLAN §4): "Traffic Permissions blocked delivery while every
// surface showed green" (traffic_permissions_blocked), "Preview leak" (previews_send_data), "Sandbox held
// the production pixel" (env_dependent), "Parser folded unreadable into absent" (undetermined ≠ pass).
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import type { TestResult, TestRunFixtureCase } from "../wizard/contracts/test-engine.js"
import { TEST_TOOLS } from "../wizard/contracts/test-engine.js"
import { gradeTestRun, gradeTestRunFull, type GradeContext } from "./grade-test-run.js"

const here = dirname(fileURLToPath(import.meta.url))
const cases = JSON.parse(readFileSync(join(here, "../../contracts/tag-wizard-v1/test-run.fixtures.json"), "utf8")) as TestRunFixtureCase[]
const NOW = () => new Date("2026-10-02T10:00:00.000Z")

function contextOf(fixture: TestRunFixtureCase): GradeContext {
  return {
    cmpDetected: fixture.result.environment.cmpDetected,
    envSourcedIds: fixture.context.envSourcedIds,
    consentMode: fixture.context.consentMode,
    installedTools: fixture.context.installedTools,
    ...(fixture.context.metaPixelOwnership ? { metaPixelOwnership: fixture.context.metaPixelOwnership } : {}),
    runId: fixture.request.runId,
    now: NOW
  }
}

function code(reason: string | undefined): string | undefined {
  return reason?.includes(" — ") ? reason.split(" — ")[0] : undefined
}

function clone(fixture: TestRunFixtureCase): TestRunFixtureCase {
  return JSON.parse(JSON.stringify(fixture)) as TestRunFixtureCase
}

function byId(id: string): TestRunFixtureCase {
  const fixture = cases.find((entry) => entry.id === id)
  if (!fixture) throw new Error(`missing fixture ${id}`)
  return clone(fixture)
}

describe("the grader agrees with every test-run fixture", () => {
  it("covers every fixture", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20)
  })

  for (const fixture of cases) {
    it(`${fixture.id}: ${fixture.note}`, () => {
      const graded = gradeTestRunFull(fixture.result, fixture.request.expect, fixture.request.mode, contextOf(fixture))
      for (const tool of TEST_TOOLS) {
        const expected = fixture.expected[tool]
        if (!expected) continue
        const result = graded.tools[tool]
        expect(result.state, `${tool}: ${result.reason}`).toBe(expected.state)
        if (expected.because) expect(code(result.reason), `${tool}: ${result.reason}`).toBe(expected.because)
        expect(result.runId).toBe(fixture.request.runId)
        expect(result.checkId).toBe(`test_run:${tool}`)
      }
      if (fixture.expected.meta_automatic_events) {
        expect(graded.metaAutomaticEvents).not.toBeNull()
        expect(graded.metaAutomaticEvents!.result.state).toBe(fixture.expected.meta_automatic_events.state)
        expect(code(graded.metaAutomaticEvents!.result.reason)).toBe(fixture.expected.meta_automatic_events.because)
        if (fixture.expected.meta_automatic_events.count !== undefined) expect(graded.metaAutomaticEvents!.count).toBe(fixture.expected.meta_automatic_events.count)
      } else expect(graded.metaAutomaticEvents).toBeNull()
    })
  }
})

describe("negatives: one fact flipped flips the verdict", () => {
  const grade = (fixture: TestRunFixtureCase, ctx: Partial<GradeContext> = {}) =>
    gradeTestRun(fixture.result, fixture.request.expect, fixture.request.mode, { ...contextOf(fixture), ...ctx })

  it("pii: 0 → pass, 1 → no_pii problem", () => {
    const fixture = byId("dry_live_pii_in_ga4")
    expect(grade(fixture).ga4.state).toBe("problem")
    fixture.result.pii = fixture.result.pii.map((entry) => ({ ...entry, count: 0 }))
    expect(grade(fixture).ga4.state).toBe("pass")
  })

  it("a tid equal to either connected stream passes; a third id is wrong", () => {
    const fixture = byId("dry_live_all_once")
    expect(grade(fixture).ga4.state).toBe("pass")
    fixture.result.ga4.events = fixture.result.ga4.events.map((event) => ({ ...event, tid: "G-FAKE00002" }))
    expect(grade(fixture).ga4.state).toBe("pass")
    fixture.result.ga4.events = fixture.result.ga4.events.map((event) => ({ ...event, tid: "G-NOTCONNECTED" }))
    expect(code(grade(fixture).ga4.reason)).toBe("wrong_id")
  })

  it("two page_views on ONE load are a duplicate; one on the load and one after an SPA navigation are not", () => {
    const fixture = byId("dry_live_ga4_two_page_views")
    expect(code(grade(fixture).ga4.reason)).toBe("duplicate_page_view")
    fixture.result.ga4.events = fixture.result.ga4.events.map((event, index) => ({ ...event, afterNav: index === 1 }))
    expect(grade(fixture).ga4.state).toBe("pass")
  })

  it("held by consent is never a problem: the same silence with consent not required and no CMP is no_beacon", () => {
    const fixture = byId("dry_live_held_by_consent")
    expect(Object.values(grade(fixture)).map((result) => result.state)).toEqual(["undetermined", "undetermined", "undetermined", "undetermined"])
    expect(code(grade(fixture, { consentMode: "not_required" }).ga4.reason)).toBe("no_beacon")
  })

  it("a consent-seeded Infinite that still sends nothing is no_beacon (the seed targets Infinite's own key)", () => {
    const fixture = byId("dry_live_held_by_consent")
    fixture.result.environment.consentSeeded = true
    const graded = grade(fixture)
    expect(code(graded.infinite.reason)).toBe("no_beacon")
    expect(code(graded.ga4.reason)).toBe("held_by_consent")
  })

  it("env_dependent only on a preview build: the same silent env-sourced pixel on production is no_beacon", () => {
    const fixture = byId("rehearsal_env_dependent_meta")
    expect(code(grade(fixture).meta.reason)).toBe("env_dependent")
    const production: TestResult = { ...fixture.result, mode: "dry_live" }
    expect(code(gradeTestRun(production, fixture.request.expect, "dry_live", contextOf(fixture)).meta.reason)).toBe("no_beacon")
  })

  it("a silent tool the caller did not declare installed or not is undetermined (test_error), never guessed", () => {
    const fixture = byId("dry_live_installed_no_beacon")
    expect(code(grade(fixture, { installedTools: undefined }).posthog.reason)).toBe("test_error")
    expect(grade(fixture, { installedTools: ["infinite", "ga4", "meta"] }).posthog.state).toBe("info")
  })

  it("previews: silence on preview_self is the pass; the same beacon on a production load is graded normally", () => {
    const fixture = byId("dry_live_preview_self_beacon")
    expect(code(grade(fixture).ga4.reason)).toBe("previews_send_data")
    fixture.result.loads = fixture.result.loads.map((load) => ({ ...load, label: "home" }))
    fixture.result.ga4.events = fixture.result.ga4.events.map((event) => ({ ...event, loadLabel: "home" }))
    expect(grade(fixture).ga4.state).toBe("pass")
  })

  it("a Meta /tr 2xx in a real visit is delivering; 4xx is meta_tr_rejected", () => {
    const fixture = byId("real_visit_meta_tr_rejected")
    expect(code(grade(fixture).meta.reason)).toBe("meta_tr_rejected")
    fixture.result.meta.tr = fixture.result.meta.tr.map((tr) => ({ ...tr, status: 200 }))
    expect(grade(fixture).meta.reason).toContain("delivering")
  })

  it("not connected is undetermined even when the tool fires; connecting it makes it a pass", () => {
    const fixture = byId("dry_live_posthog_not_connected")
    expect(code(grade(fixture).posthog.reason)).toBe("not_connected")
    const expect2 = { ...fixture.request.expect, posthog: { projectKey: "phc_FAKEtestProjectKeyNotReal000", apiHost: "https://us.i.posthog.com" } }
    expect(gradeTestRun(fixture.result, expect2, "dry_live", contextOf(fixture)).posthog.state).toBe("pass")
  })

  it("D10 is counted only for an ADOPTED pixel", () => {
    const fixture = byId("dry_live_meta_automatic_events_info")
    expect(gradeTestRunFull(fixture.result, fixture.request.expect, "dry_live", { ...contextOf(fixture), metaPixelOwnership: "managed" }).metaAutomaticEvents).toBeNull()
  })

  it("refuses to grade a result under the wrong mode", () => {
    const fixture = byId("real_visit_delivering")
    expect(() => gradeTestRun(fixture.result, fixture.request.expect, "dry_live", contextOf(fixture))).toThrow(/real_visit/)
  })
})

describe("the derived rehearsal / prove checks", () => {
  const derived = (fixture: TestRunFixtureCase) =>
    Object.fromEntries(gradeTestRunFull(fixture.result, fixture.request.expect, fixture.request.mode, contextOf(fixture)).checks.map((check) => [check.checkId === "click_test" ? `click_test:${check.reason?.match(/label=([^;]+)/)?.[1]}` : check.checkId, check]))

  it("a delivering real visit: seen leaving per tool, one beacon per tool, tier PV", () => {
    const checks = derived(byId("real_visit_delivering"))
    expect(checks.ga4_seen_leaving!.state).toBe("pass")
    expect(checks.meta_seen_leaving!.reason).toBe("sent, domain allowed")
    expect(checks.one_beacon_per_tool!.state).toBe("pass")
    expect(checks.ga4_seen_leaving!.tier).toBe("PV")
  })

  it("negative: a real visit whose GA4 never left with a 2xx is not seen leaving", () => {
    const fixture = byId("real_visit_delivering")
    fixture.result.ga4.events = fixture.result.ga4.events.map((event) => ({ ...event, status: 0 }))
    expect(derived(fixture).ga4_seen_leaving!.state).toBe("problem")
  })

  it("the rehearsal click test passes on its label, tier RH; a fbq standard conversion on the click fails it", () => {
    const fixture = byId("rehearsal_click_test")
    const label = fixture.result.clicks[0]!.label
    expect(derived(fixture)[`click_test:${label}`]!.state).toBe("pass")
    expect(derived(fixture)[`click_test:${label}`]!.tier).toBe("RH")
    fixture.result.clicks[0]!.events.meta = ["Lead"]
    expect(derived(fixture)[`click_test:${label}`]!.state).toBe("problem")
  })

  it("preview_self_silent: pass when silent, problem on a beacon, undetermined when no preview load ran", () => {
    expect(derived(byId("dry_live_preview_self_beacon")).preview_self_silent!.state).toBe("problem")
    const silent = byId("dry_live_preview_self_beacon")
    silent.result.ga4.events = []
    expect(derived(silent).preview_self_silent!.state).toBe("pass")
    expect(derived(byId("dry_live_all_once")).preview_self_silent!.state).toBe("undetermined")
  })

  it("one_beacon_per_tool fails on a duplicate page view", () => {
    expect(derived(byId("dry_live_posthog_double_pageview")).one_beacon_per_tool!.state).toBe("problem")
  })
})
