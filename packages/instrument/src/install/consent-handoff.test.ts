import { describe, expect, it } from "vitest"
import { fakeBefore, fakeKeys, fakeProductionDeniedConflict } from "../../test/wizard/o7-fakes.js"
import { buildPlanModel, type PlanModelInput } from "./plan-model.js"
import { buildColumn, buildReport } from "../wizard/report.js"

function planInput(sources: Record<string, string>): PlanModelInput {
  return {
    scan: { framework: "next-app-router", managedProviders: [], adopted: [], improve: [], serverLane: null, npm: null, sensitivePaths: [], sources },
    keys: fakeKeys(), before: fakeBefore(), candidates: [], agent: null, consentFlag: null,
    productionDeniedConflict: fakeProductionDeniedConflict
  }
}

describe("the owner banner handoff", () => {
  it.each<Record<string, string>>([
    { "components/SiteConsentBanner.tsx": "export function SiteConsentBanner(){ return null }" },
    { "index.html": '<script src="https://consent.cookiebot.com/uc.js"></script>' },
  ])("asks nothing about how the tag runs and installs it active, whatever the site holds: %j", sources => {
    const input = planInput(sources)
    input.keys.infinite.consentMode = "required"
    const plan = buildPlanModel(input)
    expect(plan.decisions.consentMode).toBe("not_required")
    expect(plan.lines.some(line => line.kind === "consent_mode")).toBe(false)
    expect(plan.lines.some(line => line.id === "user_action:banner_signal")).toBe(false)
    expect(plan.lines.map(line => line.text).join("\n")).not.toMatch(/banner's yes|consent-change|NOT ACTIVE YET/)
  })

  it("does not leave aggregate activation cells passed because a sandbox grant worked", () => {
    const runId = "00000000-0000-4000-8000-000000000001", at = "2026-10-07T00:00:00Z"
    const inPr = buildColumn("in_pr", { runId, meta: { sha: "a".repeat(40), measuredAt: at }, facts: [{ input: "rehearsal.graded", state: "pass", at }], rows: {} })
    const live = buildColumn("proven_live", { runId, meta: { sha: "b".repeat(40), measuredAt: at }, facts: [{ input: "real_visit.graded", state: "pass", at }, { input: "receipts.per_tool", state: "pass", at, receiptAt: at }], rows: {} })
    const report = buildReport({ runId, tagVersion: "fixture", site: { repoLabel: "example/site", productionHost: "example.test" }, columns: { live_today: null, in_pr: inPr, proven_live: live }, provenLivePending: null, day7: null, notes: [], verdictFacts: { jobs: [], openFindings: [], tools: [], installedUnknown: null, consentActivation: { mode: "required", infinite: true, capture: true } } })
    expect(report.finishLine.find(line => line.id === "each_tool_once")?.cells.in_pr).toMatchObject({ state: "info", display: expect.stringContaining("NOT ACTIVE YET") })
    expect(report.finishLine.find(line => line.id === "proof_from_real_visit")?.cells.proven_live).toMatchObject({ state: "info", display: expect.stringContaining("NOT ACTIVE YET") })
    expect(report.verdict?.state).not.toBe("properly")
  })
})
