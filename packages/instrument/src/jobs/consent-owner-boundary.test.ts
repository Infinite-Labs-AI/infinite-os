import { describe, expect, it } from "vitest"
import { beforeFacts, census, scanResult } from "../../test/wizard/o8/fixtures.js"
import { fakeBefore, fakeKeys, fakeProductionDeniedConflict } from "../../test/wizard/o7-fakes.js"
import { buildPlanModel } from "../install/plan-model.js"
import { triage, type TriageItem } from "../review/triage.js"
import { globalDenyReason } from "./allow.js"
import { jobScanFrom } from "./detectors/index.js"
import { snapshotFromFiles } from "./repo-files.js"
import { seedCandidatesFrom } from "./registry.js"
import { blockItem } from "./state-machine.js"
import { item } from "../../test/wizard/repo.js"
import { missingApprovedFixes } from "../wizard/verdict.js"

describe("consent and policy belong to the site owner", () => {
  it("never seeds a privacy page job or evaluates the page's named tools", () => {
    const scan = jobScanFrom(scanResult(), snapshotFromFiles({ "app/privacy/page.tsx": "<p>Our policy</p>" }))
    expect(scan.detections.privacy).toEqual([])
    expect(seedCandidatesFrom(scan, beforeFacts()).some(x => x.jobId === "privacy_paragraph")).toBe(false)
  })
  it.each(["app/privacy/page.tsx", "pages/terms.tsx", "src/legal/privacy-policy.mdx", "public/terms-of-service.html"])("denies %s even when an agent claims it", path => {
    expect(globalDenyReason(path, [])).not.toBeNull()
  })
  it.each(["fbq('consent','grant');", "fbq(\n'consent',\n'revoke'\n);", "fbq('consent','revoke');", "gtag('consent','default',{ad_storage:'denied'});"])("leaves a preview guard for the owner when consent is in its file: %s", consent => {
    const file = "src/tracking.ts"
    const scan = jobScanFrom(scanResult(), snapshotFromFiles({ [file]: `function boot(){\nfbq('init','1234567890123456');\n${consent}\n}` }))
    const facts = beforeFacts({ census: census([{ tool: "meta", kind: "fbq_init", id: "1234567890123456", file, line: 2 }]) })
    expect(seedCandidatesFrom(scan, facts).find(x => x.id === "preview_guard:meta")).toMatchObject({ state: "left_for_you", checks: [], note: expect.stringContaining("consent code is in the way") })
  })
  it("does not ask a privacy question or return approved privacy prose for an agent", () => {
    const plan = buildPlanModel({ scan: { framework: "next-app-router", managedProviders: [], adopted: [], improve: [], serverLane: null, npm: null, sensitivePaths: [] }, keys: fakeKeys(), before: fakeBefore(), candidates: [], agent: { worker: "claude_code", whoPays: { payer: "plan", label: "plan" } }, consentFlag: null, productionDeniedConflict: fakeProductionDeniedConflict })
    expect(plan.lines.some(line => line.kind === "privacy_text")).toBe(false)
    expect(plan.decisions.privacyText).toBeNull()
  })
  it("a consent refusal is informational and is not an approved-fix failure", () => {
    const changed = blockItem(item("preview_guard:meta", ["src/tracking.ts"]), "consent_touched").item
    expect(changed.state).toBe("left_for_you")
    expect(changed.checks).toEqual([])
    expect(missingApprovedFixes([changed])).toEqual([])
  })
  it.each(["Consent is incorrectly configured", "Rewrite the privacy policy", "Consent guard bypasses a revoke"])("omits owner-only review findings, including a repeat: %s", body => {
    const finding: TriageItem = { source: "reviewer", threadId: null, findingId: "F1", item: "R6", severity: "blocker", path: "src/tracking.ts", line: 2, body, suggestedFix: null }
    const context = { allowlist: ["src/tracking.ts"], declinedKeys: new Set<string>(), passingChecks: new Set<string>(), answerFor: () => null }
    expect(triage([finding], context)[0]?.action).toBe("SKIP")
  })
})
