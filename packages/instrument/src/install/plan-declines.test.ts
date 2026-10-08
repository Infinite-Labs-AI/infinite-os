import { describe, expect, it } from "vitest"
import { candidate } from "../../test/wizard/o7-fakes.js"
import { applyApprovalsTo } from "../jobs/registry.js"
import type { PlanModel } from "../wizard/contracts/jobs.js"
import { gateSeededItems, resolvePlanAnswers, seedItemsAfterApprovals } from "./plan-model.js"

const item = candidate("posthog_improve", "proxy")
const plan: PlanModel = {
  hash: "sha256:plan",
  lines: [{ id: "improve_additive:posthog:proxy", kind: "improve_additive", text: "Send PostHog through this site's domain", requires: "info", editable: false, jobIds: [item.id] }],
  decisions: { consentMode: null, conversionNames: [], privacyText: null, npmInstall: null }
}
const no = { approved: [plan.lines[0]!.id], declined: [plan.lines[0]!.id], edits: {} }

describe("an explicit no survives shown-and-continued repository work", () => {
  it("resolves the decline even when the same answer also approves it", () => {
    const resolved = resolvePlanAnswers(plan, no, { consentFlag: null })
    expect(resolved.approvals.declined).toEqual(no.declined)
    expect(resolved.approvals.approved).toEqual([])
    expect(resolved.lines).toEqual([{ id: no.declined[0], approved: false }])
  })
  it("drops explicitly excluded work at both registry and seeding gates", () => {
    expect(applyApprovalsTo([item], plan, no)).toEqual([])
    expect(seedItemsAfterApprovals([item], [], plan, no)).toEqual([])
  })
  it("continues unexcluded repository work without asking for line approvals", () => {
    const answer = { approved: [], declined: [], edits: {} }
    expect(resolvePlanAnswers(plan, answer, { consentFlag: null }).lines[0]?.approved).toBe(true)
    expect(applyApprovalsTo([item], plan, answer).map(job => job.id)).toEqual([item.id])
  })
})

it("honors declines read from an answers file", async () => {
  const { parseAnswersFile, planAnswerFromFile } = await import("../wizard/asks.js")
  const answer = planAnswerFromFile(plan.lines, parseAnswersFile(JSON.stringify({ v: 1, plan: no })))
  expect(seedItemsAfterApprovals([item], [], plan, resolvePlanAnswers(plan, answer, { consentFlag: null }).approvals)).toEqual([])
})

it("a duplicate exclusion also suppresses its setup-check repair path", () => {
  const duplicate = candidate("duplicates_remove", "ga4_config:G-FAKE")
  const setup = candidate("setup_check_fixes", "provider_census")
  const duplicatePlan: PlanModel = { ...plan, lines: [{ id: "remove_duplicate:ga4", kind: "remove_duplicate", text: "Keep one GA4", requires: "info", editable: false, jobIds: [duplicate.id] }] }
  expect(applyApprovalsTo([duplicate, setup], duplicatePlan, { approved: [], declined: ["remove_duplicate:ga4"], edits: {} })).toEqual([])
})

it("excluding the only helper provider suppresses rewrite and conversion jobs", () => {
  const jobs = [candidate("unusual_layout", "next_config_rewrites"), candidate("conversions_to_tools", "signup")]
  const helperPlan: PlanModel = { ...plan, lines: [
    { id: "install_provider:infinite", kind: "install_provider", text: "Install Infinite", requires: "info", editable: false },
    { id: "user_action:next_config_rewrites", kind: "improve_additive", text: "Rewrite", requires: "info", editable: false, jobIds: [jobs[0]!.id] },
    { id: "conversion_names", kind: "conversion_names", text: "Signup", requires: "approval", editable: true, jobIds: [jobs[1]!.id] }
  ], decisions: { ...plan.decisions, conversionNames: ["signup"] } }
  const resolved = resolvePlanAnswers(helperPlan, { approved: ["conversion_names"], declined: ["install_provider:infinite"], edits: {} }, { consentFlag: null })
  expect(resolved.conversions).toEqual([])
  expect(seedItemsAfterApprovals(jobs, [], helperPlan, resolved.approvals)).toEqual([])
  expect(gateSeededItems(helperPlan, { lines: helperPlan.lines.map(line => ({ id: line.id, approved: line.id !== "install_provider:infinite" })) }, jobs)).toEqual([])
})

it.each([
  ["preview_guard_adopted", "host_guard"],
  ["capture_beside_adopted_pixel", "click_id_capture"],
] as const)("exclusion of %s also blocks setup-check path %s", (kind, check) => {
  const excludedPlan: PlanModel = { ...plan, lines: [{ id: "excluded", kind, text: "Excluded", requires: "info", editable: false }] }
  expect(applyApprovalsTo([candidate("setup_check_fixes", check)], excludedPlan, { approved: [], declined: ["excluded"], edits: {} })).toEqual([])
})

