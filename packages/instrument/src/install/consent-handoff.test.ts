import { describe, expect, it } from "vitest"
import { fakeBefore, fakeKeys, fakeProductionDeniedConflict } from "../../test/wizard/o7-fakes.js"
import { buildPlanModel, type PlanModelInput } from "./plan-model.js"
import { buildColumn, buildReport, renderMarkdown, renderTerminal } from "../wizard/report.js"
import { buildFinalComment, buildPrBody } from "../review/post.js"
import { createScanner } from "../review/scan.js"

function planInput(sources: Record<string, string>): PlanModelInput {
  return {
    scan: { framework: "next-app-router", managedProviders: [], adopted: [], improve: [], serverLane: null, npm: null, sensitivePaths: [], sources },
    keys: fakeKeys(), before: fakeBefore(), candidates: [], agent: null, consentFlag: null,
    productionDeniedConflict: fakeProductionDeniedConflict
  }
}

describe("the owner banner handoff", () => {
  it("defaults a site with no recognized consent or banner signs to collection", () => {
    const plan = buildPlanModel(planInput({ "app/page.tsx": "export default function Page(){ return <main>Example</main> }" }))
    expect(plan.decisions.consentMode).toBe("not_required")
    expect(plan.lines.find(line => line.kind === "consent_mode")?.text).toContain("Default: no banner or consent call was recognized")
  })
  it.each(["MarketingConsent", "SiteConsentBanner", "GdprBanner"])("uses the requested %s banner sign only as a default", name => {
    const input = planInput({ [`components/${name}.tsx`]: `export function ${name}(){ return null }` })
    expect(buildPlanModel(input).decisions.consentMode).toBe("required")
    expect(buildPlanModel({ ...input, consentFlag: "not_required" }).decisions.consentMode).toBe("not_required")
  })
  it("uses the explicit react-cookie-consent import as a default sign", () => {
    expect(buildPlanModel(planInput({ "app/page.tsx": 'import Banner from "react-cookie-consent"; export default function Page(){ return <Banner /> }' })).decisions.consentMode).toBe("required")
  })
  it.each([
    '<script src="https://consent.cookiebot.com/uc.js"></script>',
    '<script type="text/plain" data-cookieconsent="statistics">startAnalytics();</script>'
  ])("uses a script-tag CMP sign only as a consent default: %s", source => {
    const input = planInput({ "index.html": source })
    expect(buildPlanModel(input).decisions.consentMode).toBe("required")
    expect(buildPlanModel({ ...input, consentFlag: "not_required" }).decisions.consentMode).toBe("not_required")
  })
  it.each<Record<string, string>>([
    { "src/pixel.ts": "fbq('consent', 'revoke');" },
    { "components/CookieBanner.tsx": "export function CookieBanner(){ return <button>Accept</button> }" }
  ])("defaults to required when consent handling is recognized: %j", sources => {
    const plan = buildPlanModel(planInput(sources))
    expect(plan.decisions.consentMode).toBe("required")
    const question = plan.lines.find(line => line.kind === "consent_mode")!.text
    expect(question).toContain("Infinite's tag and the Meta ad-click cookie")
    expect(question).toMatch(/found.*(?:consent|banner)/i)
    expect(question).not.toContain("covers Infinite only")
    expect(plan.lines.find(line => line.requires === "user_action")?.text).toContain("infinite:analytics-consent-change")
  })

  it("keeps the explicit default-collection choice and says other banners are independent", () => {
    const plan = buildPlanModel({ ...planInput({ "src/pixel.ts": "fbq('consent', 'revoke');" }), consentFlag: "not_required" })
    expect(plan.decisions.consentMode).toBe("not_required")
    expect(plan.lines.find(line => line.kind === "consent_mode")?.text).toContain("independent of your other banner until you connect it")
  })

  it("proposes required over an old cloud default while retaining an explicit flag choice", () => {
    const input = planInput({ "components/CookieBanner.tsx": "export function CookieBanner(){ return null }" })
    input.keys.infinite.consentMode = "not_required"
    expect(buildPlanModel(input).decisions.consentMode).toBe("required")
    expect(buildPlanModel({ ...input, consentFlag: "not_required" }).decisions.consentMode).toBe("not_required")
  })

  it("reports required-mode artifacts as not active and prints the exact owner actions", () => {
    const report = buildReport({ runId: "00000000-0000-4000-8000-000000000001", tagVersion: "fixture", site: { repoLabel: "example/site", productionHost: "example.test" }, columns: { live_today: null, in_pr: null, proven_live: null }, provenLivePending: "deploy", day7: null, notes: [], verdictFacts: { jobs: [], openFindings: [], tools: null, installedUnknown: null, consentActivation: { mode: "required", infinite: true, capture: true } } })
    const markdown = renderMarkdown(report)
    const scanner = createScanner({ literals: [], allowedIds: [] })
    const pr = buildPrBody({ reportMarkdown: markdown, howToReview: "Review the files", runId: report.runId, isPrivate: true, diffText: "", connectionIds: [], scanner })
    const comment = buildFinalComment({ reportMarkdown: markdown, runId: report.runId, reviewer: null, reviewed: false, jobs: [], decisions: [], untrusted: [], notes: [], scanner })
    for (const text of [markdown, renderTerminal(report, 160), pr, comment]) {
      expect(text).toContain("NOT ACTIVE YET (waiting on your banner signal)")
      expect(text).toContain('window.dispatchEvent(new CustomEvent("infinite:analytics-consent-change", { detail: { granted: true } }));')
      expect(text).toContain('window.dispatchEvent(new CustomEvent("infinite:analytics-consent-change", { detail: { granted: false } }));')
      expect(text).toContain("wherever your banner's state changes")
      expect(text).toContain("Withdrawal or expiry:")
    }
  })

  it("prints each waiting activation status only once in the terminal", () => {
    const report = buildReport({ runId: "00000000-0000-4000-8000-000000000001", tagVersion: "fixture", site: { repoLabel: "example/site", productionHost: "example.test" }, columns: { live_today: null, in_pr: null, proven_live: null }, provenLivePending: "deploy", day7: null, notes: [], verdictFacts: { jobs: [], openFindings: [], tools: null, installedUnknown: null, consentActivation: { mode: "required", infinite: true, capture: true } } })
    const text = renderTerminal(report, 160)
    expect(text.split("Infinite tag: NOT ACTIVE YET")).toHaveLength(2)
    expect(text.split("Meta ad-click capture: NOT ACTIVE YET")).toHaveLength(2)
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
