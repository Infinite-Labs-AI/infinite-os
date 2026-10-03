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
import { automaticEventsPerVisitOf, gradeTestRun, gradeTestRunFull, type GradeContext, NOT_A_BROWSER_DETAIL } from "./grade-test-run.js"

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
    expect(code(grade(fixture, { installedTools: null }).posthog.reason)).toBe("test_error")
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

  it("B12: the stored D10 result reads back as its count (the plan's one source); a non-info result is unmeasured", () => {
    const fixture = byId("dry_live_meta_automatic_events_info")
    const graded = gradeTestRunFull(fixture.result, fixture.request.expect, "dry_live", contextOf(fixture)).metaAutomaticEvents!
    expect(automaticEventsPerVisitOf([graded.result])).toBe(graded.count)
    expect(graded.count).not.toBeNull()
    // negative: blocked / ungraded / absent → null, never 0
    expect(automaticEventsPerVisitOf([{ ...graded.result, state: "undetermined", reason: "no_beacon — the pixel sent nothing" }])).toBeNull()
    expect(automaticEventsPerVisitOf([])).toBeNull()
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

  it("R8: a seeded run releases a MANAGED Meta pixel too, so its silence is no_beacon; an adopted one stays held", () => {
    const fixture = byId("dry_live_held_by_consent")
    fixture.result.environment.consentSeeded = true
    fixture.result.meta.tr = []
    expect(code(full(fixture, { metaPixelOwnership: "managed" }).tools.meta.reason)).toBe("no_beacon")
    expect(full(fixture, { metaPixelOwnership: "managed" }).tools.meta.state).toBe("problem")
    // negative: an adopted pixel reads its own (site) consent, which the seed does not touch
    expect(code(full(fixture, { metaPixelOwnership: "adopted" }).tools.meta.reason)).toBe("held_by_consent")
  })

  it("R9: an omitted consentMode makes a silent tool undetermined (test_error), never no_beacon", () => {
    const fixture = byId("dry_live_installed_no_beacon")
    const silent = TEST_TOOLS.filter((tool) => code(full(fixture).tools[tool].reason) === "no_beacon")
    expect(silent.length).toBeGreaterThan(0)
    const unknown = full(fixture, { consentMode: null })
    for (const tool of silent) expect(code(unknown.tools[tool].reason)).toBe("test_error")
    // negative: a tool that fires is still graded on its facts without the consent mode
    const firing = byId("dry_live_all_once")
    expect(full(firing, { consentMode: null }).tools.ga4.state).toBe("pass")
  })

  it("R10: a doubled page_view is reported by one_beacon_per_tool and ga4_one_page_view even when pii wins the per-tool verdict", () => {
    const fixture = byId("dry_live_ga4_two_page_views")
    expect(check(fixture, "one_beacon_per_tool").state).toBe("problem")
    fixture.result.pii = [{ lane: "ga4", kind: "email", count: 1 }]
    expect(code(full(fixture).tools.ga4.reason)).toBe("no_pii")
    expect(check(fixture, "one_beacon_per_tool").state).toBe("problem")
    expect(code(check(fixture, "ga4_one_page_view").reason)).toBe("duplicate_page_view")
    // negative: pii alone does not make ga4_one_page_view fail
    const once = byId("dry_live_pii_in_ga4")
    expect(check(once, "ga4_one_page_view").state).toBe("pass")
    expect(check(once, "one_beacon_per_tool").state).toBe("pass")
  })

  it("R11: a second Meta PageView after a client-side navigation is not a duplicate; without the navigation it is", () => {
    const fixture = byId("rehearsal_click_test")
    const pageView = fixture.result.meta.tr.find((tr) => tr.ev === "PageView")
    expect(pageView).toBeDefined()
    fixture.result.meta.tr.push({ ...pageView! })
    expect(check(fixture, "meta_pixel_once").state).toBe("problem")
    fixture.result.ga4.events.push({ ...fixture.result.ga4.events.find((event) => event.en === "page_view")!, afterNav: true })
    expect(check(fixture, "meta_pixel_once").state).toBe("pass")
  })

  it("R12: the RH click test needs the label in GA4 when GA4 is installed; PostHog alone is not enough", () => {
    const fixture = byId("rehearsal_click_test")
    const label = fixture.result.clicks[0]!.label
    const clickResult = (ctx: Partial<GradeContext> = {}) => full(fixture, ctx).checks.find((entry) => entry.checkId === "click_test")!
    expect(clickResult().state).toBe("pass")
    fixture.result.clicks[0]!.events.ga4 = []
    fixture.result.clicks[0]!.events.posthog = [label]
    expect(clickResult().state).toBe("problem")
    expect(clickResult().reason).toContain("ga4")
    // unknown installs → undetermined, never a pass
    expect(clickResult({ installedTools: null }).state).toBe("undetermined")
    // negative: with only PostHog installed, PostHog receiving it is the pass
    expect(clickResult({ installedTools: ["infinite", "posthog"] }).state).toBe("pass")
  })

  it("R18: D10 never reports a measured 0 when the pixel was not graded or sent nothing", () => {
    const fixture = byId("dry_live_meta_automatic_events_info")
    expect(full(fixture).metaAutomaticEvents!.result.state).toBe("info")
    const automation = byId("dry_live_meta_automatic_events_info")
    automation.result.environment.automationDetected = true
    expect(full(automation).metaAutomaticEvents).toMatchObject({ count: null, result: { state: "undetermined" } })
    const nothing = byId("dry_live_meta_automatic_events_info")
    nothing.result.meta.tr = []
    expect(full(nothing).metaAutomaticEvents).toMatchObject({ count: null, result: { state: "undetermined" } })
  })

  it("R19: facts from another run are refused; results carry the facts' own run id", () => {
    const fixture = byId("dry_live_all_once")
    expect(() => full(fixture, { runId: "00000000-0000-4000-8000-000000000000" })).toThrow(/stale facts/)
    const unscoped = full(fixture, { runId: null })
    expect(unscoped.tools.ga4.runId).toBe(fixture.result.runId)
    expect(unscoped.checks.every((entry) => entry.runId === fixture.result.runId)).toBe(true)
  })

  it("R21 (§3z.9, A17): PostHog / Meta beacons carry their load, so a mixed run is split per load, never guessed", () => {
    const fixture = byId("dry_live_all_once")
    fixture.result.loads.push({ ...fixture.result.loads[0]!, label: "preview_self", url: "https://acme-git-x.vercel.app/", finalUrl: "https://acme-git-x.vercel.app/" })
    // every beacon is on the home load: graded normally
    expect(full(fixture).tools.posthog.state).toBe("pass")
    expect(full(fixture).tools.meta.state).toBe("pass")
    // negative: the same beacons labelled with the preview's own load are a preview leak
    fixture.result.posthog.events = fixture.result.posthog.events.map((event) => ({ ...event, loadLabel: "preview_self" }))
    fixture.result.meta.tr = fixture.result.meta.tr.map((tr) => ({ ...tr, loadLabel: "preview_self" }))
    expect(code(full(fixture).tools.posthog.reason)).toBe("previews_send_data")
    expect(code(full(fixture).tools.meta.reason)).toBe("previews_send_data")
  })

  it("§3z.9 (A17): a click the engine refused (submit control, consent banner) is not exercised, never a problem", () => {
    const fixture = byId("rehearsal_click_test")
    fixture.result.clicks[0] = { ...fixture.result.clicks[0]!, found: false, refused: "submit_control", events: { ga4: [], posthog: [], meta: [], infinite: [] } }
    const click = full(fixture).checks.find((entry) => entry.checkId === "click_test")!
    expect(click.state).toBe("undetermined")
    expect(code(click.reason)).toBe("not_exercised")
    // negative: the same empty click that was NOT refused, on a found element, is a problem
    fixture.result.clicks[0] = { ...fixture.result.clicks[0]!, found: true, refused: null }
    expect(full(fixture).checks.find((entry) => entry.checkId === "click_test")!.state).toBe("problem")
  })

  it("§3z.9 (A17): two PostHog page views on one load are a duplicate; one per load (or one after a client navigation) is not", () => {
    const fixture = byId("dry_live_all_once")
    const view = fixture.result.posthog.events[0]!
    fixture.result.posthog.events = [view, { ...view, afterNav: true }]
    expect(full(fixture).tools.posthog.state).toBe("pass")
    fixture.result.posthog.events = [view, { ...view }]
    expect(code(full(fixture).tools.posthog.reason)).toBe("duplicate_page_view")
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
  it("negative: the reduced Chrome UA grades normally; an Electron token alone is refused too", () => {
    const fixture = base()
    expect(gradeTestRun(fixture.result, fixture.request.expect, "dry_live", contextOf(fixture)).meta.state).toBe("pass")
    fixture.result.environment.ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36"
    expect(gradeTestRun(fixture.result, fixture.request.expect, "dry_live", contextOf(fixture)).meta.state).toBe("undetermined")
  })
})

describe("§3x.3 (W21) Meta on a client-side navigation", () => {
  const spa = () => clone(cases.find((entry) => entry.id === "dry_live_meta_spa_page_view_missing")!)
  const meta = (fixture: TestRunFixtureCase) => gradeTestRun(fixture.result, fixture.request.expect, "dry_live", contextOf(fixture)).meta
  it("no PageView after the page change → problem meta_spa_page_view_missing", () => {
    expect(code(meta(spa()).reason)).toBe("meta_spa_page_view_missing")
  })
  it("exactly one → pass; two → duplicate_page_view", () => {
    const one = spa()
    one.result.meta.tr.push({ ...one.result.meta.tr[0]!, afterNav: true })
    expect(meta(one).state).toBe("pass")
    const two = spa()
    two.result.meta.tr.push({ ...two.result.meta.tr[0]!, afterNav: true }, { ...two.result.meta.tr[0]!, afterNav: true })
    expect(code(meta(two).reason)).toBe("duplicate_page_view")
  })
  it("negative: a load that did not navigate is not graded for it", () => {
    const fixture = spa()
    delete fixture.context.spaNavigation
    expect(meta(fixture).state).toBe("pass")
  })
})
