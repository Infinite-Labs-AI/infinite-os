import { describe, expect, it } from "vitest"
import { candidate } from "../../test/wizard/o7-fakes.js"
import { applyApprovalsTo } from "../jobs/registry.js"
import type { PlanModel } from "../wizard/contracts/jobs.js"
import { resolvePlanAnswers, seedItemsAfterApprovals } from "./plan-model.js"

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
