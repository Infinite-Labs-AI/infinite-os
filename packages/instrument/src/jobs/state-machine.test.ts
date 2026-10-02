import { describe, expect, it } from "vitest"

import type { ChecklistItem, CheckResult, CheckTier, JobId } from "../wizard/contracts/jobs.js"
import { applyClaim, applyResults, blockItem, markMerged, waitsForRealEvent } from "./state-machine.js"
import { JOB_TABLE } from "../wizard/contracts/jobs.js"

const RUN = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
const OTHER_RUN = "11111111-2222-4333-8444-555555555555"
const AT = "2026-10-02T09:00:00.000Z"

function item(jobId: JobId, state: ChecklistItem["state"] = "pending"): ChecklistItem {
  const spec = JOB_TABLE[jobId]
  return {
    id: `${jobId}:x`,
    jobId,
    n: spec.n,
    title: spec.title,
    owner: "agent",
    trigger: { finding: "found", evidence: [{ file: "app/layout.tsx", line: 3 }] },
    allow: { files: ["app/layout.tsx"], create: [] },
    checks: spec.checks.filter((check) => !(check.checkId === "click_test" && check.tier === "T0")).map((check) => ({ id: check.checkId, tier: check.tier, state: "not_run" as const })),
    state
  }
}

const CLAIM_AT = "2026-10-02T08:45:00.000Z"
const claimedAt = (base: ChecklistItem, at: string): ChecklistItem => ({ ...base, claim: { status: "done", note: "", at } })

const result = (checkId: string, tier: CheckTier, state: CheckResult["state"], runId: string | null = RUN): CheckResult => ({ checkId, tier, state, at: AT, runId })
const never = () => {
  throw new Error("reverify must not run for this claim")
}

describe("claims (§3e.5: the agent can only claim)", () => {
  it("a done claim moves no further than claimed", () => {
    const next = applyClaim(item("posthog_improve"), { jobId: "posthog_improve:x", status: "done", note: "did it", at: AT }, never)
    expect(next.item.state).toBe("claimed")
    expect(next.item.claim).toEqual({ status: "done", note: "did it", at: AT })
    // Negative: a claim on an item already past claimed changes nothing.
    const later = applyClaim(item("posthog_improve", "waiting_deploy"), { jobId: "posthog_improve:x", status: "done", note: "", at: AT }, never)
    expect(later.changed).toBe(false)
    expect(later.item.state).toBe("waiting_deploy")
  })

  it("not_needed is re-verified: agreement → not_needed, disagreement → pending with the evidence", () => {
    const agreed = applyClaim(item("identify_reset"), { jobId: "identify_reset:x", status: "not_needed", note: "", at: AT }, () => ({ agrees: true, evidence: [] }))
    expect(agreed.item.state).toBe("not_needed")
    const disagreed = applyClaim(item("identify_reset"), { jobId: "identify_reset:x", status: "not_needed", note: "", at: AT }, () => ({
      agrees: false,
      evidence: [{ file: "app/login/actions.ts", line: 7 }]
    }))
    expect(disagreed.item.state).toBe("pending")
    expect(disagreed.note).toBe("agent said not needed; the wizard found app/login/actions.ts:7")
    expect(disagreed.item.trigger.evidence).toEqual([{ file: "app/login/actions.ts", line: 7 }])
  })

  it("a blocked claim blocks with agent_blocked; code jobs ignore claims", () => {
    expect(applyClaim(item("csp"), { jobId: "csp:x", status: "blocked", note: "nonce", at: AT }, never).item).toMatchObject({ state: "blocked", blockedReason: "agent_blocked" })
    const code = { ...item("csp"), owner: "code" as const }
    expect(applyClaim(code, { jobId: "csp:x", status: "done", note: "", at: AT }, never).changed).toBe(false)
  })
})

describe("checks decide (§3e.5)", () => {
  it("claimed → done_in_code → waiting_deploy when S + B + T0 pass", () => {
    const claimed = item("posthog_improve", "claimed")
    const next = applyResults(claimed, [result("posthog_config", "S", "pass"), result("next_rewrites_exact", "S", "pass")], RUN, { budgetLeft: true })
    expect(next.item.state).toBe("waiting_deploy")
  })

  it("a failing local check sends the item back to pending (budget left) or failed (budget spent)", () => {
    const claimed = item("posthog_improve", "claimed")
    const failing = [result("posthog_config", "S", "problem"), result("next_rewrites_exact", "S", "pass")]
    const retry = applyResults(claimed, failing, RUN, { budgetLeft: true })
    expect(retry.item.state).toBe("pending")
    expect(retry.note).toContain("S:posthog_config")
    expect(applyResults(claimed, failing, RUN, { budgetLeft: false }).item.state).toBe("failed")
  })

  it("undetermined never counts as pass", () => {
    const claimed = item("posthog_improve", "claimed")
    const next = applyResults(claimed, [result("posthog_config", "S", "undetermined"), result("next_rewrites_exact", "S", "pass")], RUN, { budgetLeft: true })
    expect(next.item.state).toBe("claimed")
  })

  it("proven requires every live check to pass with THIS run's id", () => {
    const waiting = claimedAt(item("posthog_improve", "waiting_deploy"), CLAIM_AT)
    const ours = applyResults(waiting, [result("posthog_via_proxy_once", "RH", "pass"), result("posthog_distinct_id_receipt", "PV", "pass")], RUN, { budgetLeft: true })
    expect(ours.item.state).toBe("proven")
    // Negative: another run's receipt (and a run-less result) never proves.
    const theirs = applyResults(waiting, [result("posthog_via_proxy_once", "RH", "pass"), result("posthog_distinct_id_receipt", "PV", "pass", OTHER_RUN)], RUN, { budgetLeft: true })
    expect(theirs.item.state).toBe("waiting_deploy")
    expect(theirs.item.checks.find((check) => check.id === "posthog_distinct_id_receipt")?.state).toBe("not_run")
    const runless = applyResults(waiting, [result("posthog_via_proxy_once", "RH", "pass", null), result("posthog_distinct_id_receipt", "PV", "pass", null)], RUN, { budgetLeft: true })
    expect(runless.item.state).toBe("waiting_deploy")
  })

  it("a stored pass from an older run never proves a resumed item (review P2-2, probe P-H)", () => {
    const resumed = claimedAt(item("posthog_improve", "waiting_deploy"), CLAIM_AT)
    resumed.checks = resumed.checks.map((check) => ({ ...check, state: "pass" as const, at: AT, runId: OTHER_RUN }))
    expect(applyResults(resumed, [], RUN, { budgetLeft: true }).item.state).toBe("waiting_deploy")
    // Positive: the same checks passed in THIS run do prove it.
    const ours = { ...resumed, checks: resumed.checks.map((check) => ({ ...check, runId: RUN })) }
    expect(applyResults(ours, [], RUN, { budgetLeft: true }).item.state).toBe("proven")
  })

  it("a production reading taken before the change could be live never proves it (review P2-2, probe P-G)", () => {
    const claimed = { ...claimedAt(item("redirect_utms", "claimed"), CLAIM_AT), edits: [{ editId: "edit_1", file: "vercel.json" }] }
    // `before`'s own redirect walk ran at 08:30, before the claim at 08:45.
    const early = applyResults(claimed, [{ ...result("redirect_walk", "T1", "pass"), at: "2026-10-02T08:30:00.000Z" }], RUN, { budgetLeft: true })
    expect(early.item.state).toBe("waiting_deploy")
    expect(early.item.checks[0]!.state).toBe("not_run")
    // After the claim but before the deploy (liveSince): still not counted.
    const preDeploy = applyResults(early.item, [result("redirect_walk", "T1", "pass")], RUN, { budgetLeft: true, liveSince: "2026-10-02T10:00:00.000Z" })
    expect(preDeploy.item.state).toBe("waiting_deploy")
    // After the deploy: proven.
    const after = applyResults(early.item, [{ ...result("redirect_walk", "T1", "pass"), at: "2026-10-02T10:05:00.000Z" }], RUN, { budgetLeft: true, liveSince: "2026-10-02T10:00:00.000Z" })
    expect(after.item.state).toBe("proven")
    // No claim and no deploy time: no lower bound, so a production reading never counts.
    const unclaimed = item("redirect_utms", "waiting_deploy")
    expect(applyResults(unclaimed, [result("redirect_walk", "T1", "pass")], RUN, { budgetLeft: true }).item.state).toBe("waiting_deploy")
  })

  it("job 10 waits for a real event only after its click test passes; a failing click test sends it back (review P2-1)", () => {
    const claimed = claimedAt(item("conversions_to_tools", "claimed"), CLAIM_AT)
    expect(claimed.checks.map((check) => `${check.tier}:${check.id}`)).toEqual(["RH:click_test", "S:no_fbq_standard_on_click"])
    const local = applyResults(claimed, [result("no_fbq_standard_on_click", "S", "pass")], RUN, { budgetLeft: true })
    // Negative: the click test has not run, so it is not "waiting for a real event".
    expect(local.item.state).toBe("done_in_code")
    const failed = applyResults(local.item, [result("click_test", "RH", "problem")], RUN, { budgetLeft: true })
    expect(failed.item.state).toBe("pending")
    expect(failed.note).toContain("RH:click_test")
    expect(applyResults(local.item, [result("click_test", "RH", "problem")], RUN, { budgetLeft: false }).item.state).toBe("failed")
    const passed = applyResults(local.item, [result("click_test", "RH", "pass")], RUN, { budgetLeft: true })
    expect(passed.item.state).toBe("waiting_real_event")
  })

  it("a failing rehearsal check on a deploy-bound item sends it back too", () => {
    const waiting = claimedAt(item("posthog_improve", "waiting_deploy"), CLAIM_AT)
    expect(applyResults(waiting, [result("posthog_via_proxy_once", "RH", "problem")], RUN, { budgetLeft: true }).item.state).toBe("pending")
  })

  it("jobs 8 and 9 wait for a real event after the code is done", () => {
    for (const jobId of ["server_conversions", "identify_reset"] as const) {
      const claimed = item(jobId, "claimed")
      const local = claimed.checks.filter((check) => check.tier === "S" || check.tier === "B").map((check) => result(check.id, check.tier, "pass"))
      const next = applyResults(claimed, local, RUN, { budgetLeft: true })
      expect(next.item.state).toBe("waiting_real_event")
      const passive = claimed.checks.filter((check) => check.tier === "P").map((check) => result(check.id, "P", "pass"))
      expect(applyResults(next.item, passive, RUN, { budgetLeft: true }).item.state).toBe("proven")
    }
    expect(waitsForRealEvent("conversions_to_tools")).toBe(true)
    expect(waitsForRealEvent("csp")).toBe(false)
  })

  it("a job with no local check needs the recorded diff before done_in_code (a bare claim is not enough)", () => {
    const claimed = item("redirect_utms", "claimed")
    expect(applyResults(claimed, [], RUN, { budgetLeft: true }).item.state).toBe("claimed")
    const withEdit = { ...claimed, edits: [{ editId: "edit_1", file: "vercel.json" }] }
    expect(applyResults(withEdit, [], RUN, { budgetLeft: true }).item.state).toBe("waiting_deploy")
  })

  it("the privacy paragraph is proven by the merge; a job with live checks is not", () => {
    const done = item("privacy_paragraph", "done_in_code")
    expect(markMerged(done).item.state).toBe("proven")
    expect(markMerged(item("preview_guard", "done_in_code")).changed).toBe(false)
  })

  it("blocks with a reason", () => {
    expect(blockItem(item("csp"), "consent_touched").item).toMatchObject({ state: "blocked", blockedReason: "consent_touched" })
  })
})
