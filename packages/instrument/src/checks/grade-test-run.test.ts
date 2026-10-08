// THE grader (§3h.8), executed over every case in `contracts/tag-wizard-v1/test-run.fixtures.json` (the
// cross-repo fixtures 1bu-1's desktop also produces), plus negatives that flip one fact and must flip
// the verdict. Incidents named here (wf5-PORT-PLAN §4): "Traffic Permissions blocked delivery while every
// surface showed green" (traffic_permissions_blocked), "Preview leak" (previews_send_data), "Sandbox held
// the production pixel" (env_dependent), "Parser folded unreadable into absent" (undetermined ≠ pass).
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import type { TestRunFixtureCase } from "../wizard/contracts/test-engine.js"
import { TEST_TOOLS } from "../wizard/contracts/test-engine.js"
import { gradeTestRun, gradeTestRunFull, type GradeContext, NOT_A_BROWSER_DETAIL } from "./grade-test-run.js"

const here = dirname(fileURLToPath(import.meta.url))
const cases = JSON.parse(readFileSync(join(here, "../../contracts/tag-wizard-v1/test-run.fixtures.json"), "utf8")) as TestRunFixtureCase[]
const NOW = () => new Date("2026-10-02T10:00:00.000Z")

function contextOf(fixture: TestRunFixtureCase): GradeContext {
  return {
    cmpDetected: fixture.result.environment.cmpDetected,
    envSourcedIds: fixture.context.envSourcedIds,
    consentMode: fixture.context.consentMode,
    installedTools: fixture.context.installedTools,
    metaPixelOwnership: fixture.context.metaPixelOwnership ?? null,
    ...(fixture.context.spaNavigation ? { spaNavigation: true } : {}),
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
  // Representative rows of the cross-repo fixture file: the all-good run, duplicate page views, a wrong
  // id, PII, consent-held silence, Traffic Permissions, and automation / bot rules = undetermined.
  const KEPT = ["dry_live_all_once", "dry_live_ga4_two_page_views", "dry_live_ga4_wrong_tid", "dry_live_automation_detected", "dry_live_blocked_by_site_bot_rules", "dry_live_pii_in_ga4", "dry_live_held_by_consent", "dry_live_meta_traffic_permissions_blocked"]
  for (const fixture of cases.filter((entry) => KEPT.includes(entry.id))) {
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

  it("a silent tool the caller did not declare installed or not is undetermined (test_error), never guessed", () => {
    const fixture = byId("dry_live_installed_no_beacon")
    expect(code(grade(fixture, { installedTools: null }).posthog.reason)).toBe("test_error")
    expect(grade(fixture, { installedTools: ["infinite", "ga4", "meta"] }).posthog.state).toBe("info")
  })

  it("a Meta /tr 2xx in a real visit is delivering; 4xx is meta_tr_rejected", () => {
    const fixture = byId("real_visit_meta_tr_rejected")
    expect(code(grade(fixture).meta.reason)).toBe("meta_tr_rejected")
    fixture.result.meta.tr = fixture.result.meta.tr.map((tr) => ({ ...tr, status: 200 }))
    expect(grade(fixture).meta.reason).toContain("delivering")
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

  it("the rehearsal click test passes on its label, tier RH; a fbq standard conversion on the click fails it", () => {
    const fixture = byId("rehearsal_click_test")
    const label = fixture.result.clicks[0]!.label
    expect(derived(fixture)[`click_test:${label}`]!.state).toBe("pass")
    expect(derived(fixture)[`click_test:${label}`]!.tier).toBe("RH")
    fixture.result.clicks[0]!.events.meta = ["Lead"]
    expect(derived(fixture)[`click_test:${label}`]!.state).toBe("problem")
  })
})

describe("fix round (review O6): each rule with the fact that flips it", () => {
  const full = (fixture: TestRunFixtureCase, ctx: Partial<GradeContext> = {}) =>
    gradeTestRunFull(fixture.result, fixture.request.expect, fixture.request.mode, { ...contextOf(fixture), ...ctx })
  const check = (fixture: TestRunFixtureCase, id: string, ctx: Partial<GradeContext> = {}) => full(fixture, ctx).checks.find((entry) => entry.checkId === id)!

  it("R5: a page that never loaded is undetermined (test_error) for every tool, never 'installed but sent nothing'", () => {
    const fixture = byId("dry_live_installed_no_beacon")
    fixture.result.loads = fixture.result.loads.map((load) => ({ ...load, status: 500, rendered: false }))
    const graded = full(fixture)
    for (const tool of TEST_TOOLS) {
      expect(graded.tools[tool].state, graded.tools[tool].reason).toBe("undetermined")
      expect(code(graded.tools[tool].reason)).toBe("test_error")
    }
    // and silence on an unloaded preview is not "previews stay silent"
    const preview = byId("dry_live_preview_self_beacon")
    preview.result.ga4.events = []
    preview.result.loads = preview.result.loads.map((load) => ({ ...load, status: 404, rendered: false }))
    expect(full(preview).tools.ga4.state).toBe("undetermined")
    expect(check(preview, "preview_self_silent").state).toBe("undetermined")
    // negative: the same silence on a page that rendered is the no_beacon problem
    const loaded = byId("dry_live_installed_no_beacon")
    expect(TEST_TOOLS.some((tool) => code(full(loaded).tools[tool].reason) === "no_beacon")).toBe(true)
  })

  it("R19: facts from another run are refused; results carry the facts' own run id", () => {
    const fixture = byId("dry_live_all_once")
    expect(() => full(fixture, { runId: "00000000-0000-4000-8000-000000000000" })).toThrow(/stale facts/)
    const unscoped = full(fixture, { runId: null })
    expect(unscoped.tools.ga4.runId).toBe(fixture.result.runId)
    expect(unscoped.checks.every((entry) => entry.runId === fixture.result.runId)).toBe(true)
  })
})

describe("§3x.5 (W12) the grader's first rule: a test window that does not look like a normal browser proves nothing", () => {
  const base = () => clone(cases.find((entry) => entry.id === "dry_live_all_once")!)
  it("run 3's monitor UA → every tool undetermined (test_error), with the reason said", () => {
    const fixture = base()
    fixture.result.environment.ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) InfiniteDev9/0.4.2 Chrome/148.0.7778.280 Electron/42.11.8 Safari/537.36 InfiniteVerifyCheck/1 (+https://infinite.fast; analytics monitor)"
    const graded = gradeTestRun(fixture.result, fixture.request.expect, "dry_live", contextOf(fixture))
    for (const tool of ["infinite", "ga4", "posthog", "meta"] as const) {
      expect(graded[tool].state, tool).toBe("undetermined")
      expect(graded[tool].reason).toBe(`test_error — ${NOT_A_BROWSER_DETAIL}`)
    }
  })
})

