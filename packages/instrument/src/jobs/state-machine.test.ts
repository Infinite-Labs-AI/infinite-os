import { describe, expect, it } from "vitest"

import type { ChecklistItem, CheckResult, CheckTier, JobId } from "../wizard/contracts/jobs.js"
import { applyClaim, applyResults, blockItem, failItem, leaveForOwner, unblockItem, withNote, markMerged, waitsForRealEvent } from "./state-machine.js"
import { createScanner } from "../review/scan.js"
import { JOB_TABLE, checkProvesChange } from "../wizard/contracts/jobs.js"

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
    const next = applyResults(claimed, [result("posthog_config", "S", "pass"), result("next_rewrites_exact", "S", "pass"), result("posthog_improve_applied", "S", "pass")], RUN, { budgetLeft: true })
    expect(next.item.state).toBe("waiting_deploy")
  })

  it("LF4 close round 2 (P1-1): only a check that proves the change may tick; checks that pass on absence only fail", () => {
    // conversions_to_tools: `no_fbq_standard_on_click` passes with nothing of the job in the code; it never ticks alone.
    const bare: ChecklistItem = { ...item("conversions_to_tools", "claimed"), checks: [{ id: "no_fbq_standard_on_click", tier: "S", state: "not_run" }, { id: "first_real_conversion", tier: "P", state: "not_run" }] }
    expect(applyResults(bare, [result("no_fbq_standard_on_click", "S", "pass")], RUN, { budgetLeft: true }).item.state).toBe("claimed")
    // A claimed item with only such checks is still verified by its recorded, in-scope diff…
    const edited = { ...bare, edits: [{ editId: "e1", file: "app/page.tsx" }] }
    expect(applyResults(edited, [result("no_fbq_standard_on_click", "S", "pass")], RUN, { budgetLeft: true }).item.state).toBe("waiting_real_event")
    // …but an item checked with no claim never is.
    expect(applyResults(edited, [result("no_fbq_standard_on_click", "S", "pass")], RUN, { budgetLeft: true, claimless: true }).item.state).toBe("claimed")
    // The absence check still FAILS a job.
    expect(applyResults(bare, [result("no_fbq_standard_on_click", "S", "problem")], RUN, { budgetLeft: true }).item.state).toBe("pending")
    // With the proving check, the claim-less item is ticked by the code itself.
    const tracked: ChecklistItem = { ...bare, checks: [...bare.checks, { id: "conversion_tracked", tier: "S", state: "not_run" }] }
    expect(applyResults(tracked, [result("no_fbq_standard_on_click", "S", "pass"), result("conversion_tracked", "S", "pass")], RUN, { budgetLeft: true, claimless: true }).item.state).toBe("waiting_real_event")
    expect(checkProvesChange("conversions_to_tools", "S", "conversion_tracked")).toBe(true)
    expect(checkProvesChange("conversions_to_tools", "S", "no_fbq_standard_on_click")).toBe(false)
    expect(checkProvesChange("meta_improve", "S", "meta_event_id_from_helper")).toBe(false)
    expect(checkProvesChange("identify_reset", "B", "build")).toBe(false)
  })

  it("a failing local check sends the item back to pending (budget left) or failed (budget spent)", () => {
    const claimed = item("posthog_improve", "claimed")
    const failing = [result("posthog_config", "S", "problem"), result("next_rewrites_exact", "S", "pass")]
    const retry = applyResults(claimed, failing, RUN, { budgetLeft: true })
    expect(retry.item.state).toBe("pending")
    expect(retry.note).toContain("PostHog settings")
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
    expect(early.item.state).toBe("claimed")
    expect(early.item.checks[0]!.state).toBe("not_run")
    // After the claim but before the deploy (liveSince): still not counted.
    const preDeploy = applyResults(early.item, [result("redirect_walk", "T1", "pass")], RUN, { budgetLeft: true, liveSince: "2026-10-02T10:00:00.000Z" })
    expect(preDeploy.item.state).toBe("claimed")
    // After the deploy: proven.
    const after = applyResults(early.item, [{ ...result("redirect_walk", "T1", "pass"), at: "2026-10-02T10:05:00.000Z" }], RUN, { budgetLeft: true, liveSince: "2026-10-02T10:00:00.000Z" })
    expect(after.item.state).toBe("proven")
    // No claim and no deploy time: no lower bound, so a production reading never counts.
    const unclaimed = item("redirect_utms", "waiting_deploy")
    expect(applyResults(unclaimed, [result("redirect_walk", "T1", "pass")], RUN, { budgetLeft: true }).item.state).toBe("waiting_deploy")
  })

  it("job 10 waits for a real event only after its click test passes; a failing click test sends it back (review P2-1)", () => {
    const claimed = claimedAt(item("conversions_to_tools", "claimed"), CLAIM_AT)
    expect(claimed.checks.map((check) => `${check.tier}:${check.id}`)).toEqual(["RH:click_test", "S:no_fbq_standard_on_click", "S:conversion_tracked", "S:track_after_success", "S:no_double_count", "S:meta_event_id_from_server", "P:first_real_conversion"])
    const local = applyResults(claimed, [result("no_fbq_standard_on_click", "S", "pass"), result("conversion_tracked", "S", "pass"), result("track_after_success", "S", "pass"), result("no_double_count", "S", "pass"), result("meta_event_id_from_server", "S", "pass")], RUN, { budgetLeft: true })
    // Negative: the click test has not run, so it is not "waiting for a real event".
    expect(local.item.state).toBe("done_in_code")
    const failed = applyResults(local.item, [result("click_test", "RH", "problem")], RUN, { budgetLeft: true })
    expect(failed.item.state).toBe("pending")
    expect(failed.note).toContain("The right buttons send conversions")
    expect(applyResults(local.item, [result("click_test", "RH", "problem")], RUN, { budgetLeft: false }).item.state).toBe("failed")
    const passed = applyResults(local.item, [result("click_test", "RH", "pass")], RUN, { budgetLeft: true })
    expect(passed.item.state).toBe("waiting_real_event")
    // B15: the first real conversion after the deploy (P, read from baseline(since)) proves it.
    expect(applyResults(passed.item, [result("first_real_conversion", "P", "pass")], RUN, { budgetLeft: true }).item.state).toBe("proven")
    // negative: an undetermined passive read never proves
    expect(applyResults(passed.item, [result("first_real_conversion", "P", "undetermined")], RUN, { budgetLeft: true }).item.state).toBe("waiting_real_event")
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

  it("live run 6: recorded edits without a local check stay claimed", () => {
    const claimed = item("redirect_utms", "claimed")
    expect(applyResults(claimed, [], RUN, { budgetLeft: true }).item.state).toBe("claimed")
    const withEdit = { ...claimed, edits: [{ editId: "edit_1", file: "vercel.json" }] }
    expect(applyResults(withEdit, [], RUN, { budgetLeft: true }).item.state).toBe("claimed")
  })

  it("a review-comment job is proven by the merge; a job with live checks is not", () => {
    const done = item("review_comments", "done_in_code")
    expect(markMerged(done).item.state).toBe("proven")
    expect(markMerged(item("preview_guard", "done_in_code")).changed).toBe(false)
  })

  it("leaves consent refusals for the owner as information", () => {
    expect(blockItem(item("csp"), "consent_touched").item).toMatchObject({ state: "left_for_you", checks: [] })
  })
})

describe("LF4-P1-2: a claimed item with nothing to verify in code and a failed rehearsal check", () => {
  const spa = (): ChecklistItem => ({
    ...item("ga4_improve", "claimed"),
    id: "ga4_improve:spa_page_view",
    claim: { status: "done", note: "", at: CLAIM_AT },
    checks: [
      { id: "ga4_spa_page_view", tier: "RH", state: "not_run" },
      { id: "ga4_one_page_view", tier: "RH", state: "not_run" },
      { id: "ga4_seen_leaving", tier: "PV", state: "not_run" }
    ]
  })

  it("live run 6: an edited SPA job waits for this run's complete rehearsal before waiting for deploy", () => {
    const edited = { ...spa(), edits: [{ editId: "e1", file: "app/layout.tsx" }] }
    expect(applyResults(edited, [], RUN, { budgetLeft: true }).item.state).toBe("claimed")
    const checks = [result("ga4_spa_page_view", "RH", "pass"), result("ga4_one_page_view", "RH", "pass")]
    expect(applyResults(edited, checks.slice(0, 1), RUN, { budgetLeft: true }).item.state).toBe("claimed")
    expect(applyResults(edited, checks.map(check => ({ ...check, runId: OTHER_RUN })), RUN, { budgetLeft: true }).item.state).toBe("claimed")
    const rehearsed = applyResults(edited, checks, RUN, { budgetLeft: true }).item
    expect(rehearsed.state).toBe("waiting_deploy")
    expect(applyResults(rehearsed, [result("ga4_seen_leaving", "PV", "pass")], RUN, { budgetLeft: true }).item.state).toBe("proven")
  })

  it("is sent back with that check's reason (budget left), never left 'claimed'", () => {
    const failed = { ...result("ga4_spa_page_view", "RH", "problem"), reason: "no page_view after the page change" }
    const out = applyResults(spa(), [failed], RUN, { budgetLeft: true })
    expect(out.item.state).toBe("pending")
    expect(out.item.note).toContain("GA4: one page view per page change (no page views after the page change)")
  })

  it("is failed with that check's reason once the budget is spent", () => {
    const failed = { ...result("ga4_spa_page_view", "RH", "problem"), reason: "no page_view after the page change" }
    const out = applyResults(spa(), [failed], RUN, { budgetLeft: false })
    expect(out.item.state).toBe("failed")
    expect(out.item.note).toContain("check failed and the budget is spent: GA4: one page view per page change")
  })

  it("NEGATIVE: with no failed check it stays claimed (unverified), never done in code", () => {
    const out = applyResults(spa(), [result("ga4_spa_page_view", "RH", "undetermined")], RUN, { budgetLeft: true })
    expect(out.item.state).toBe("claimed")
  })
})


it("request 2 P3-3: a Meta SPA rehearsal cannot prove the job before deployment", () => {
  const spa: ChecklistItem = {
    ...claimedAt(item("meta_improve", "claimed"), CLAIM_AT),
    id: "meta_improve:spa_page_view", edits: [{ editId: "e", file: "app/layout.tsx" }],
    checks: [{ id: "meta_spa_page_view", tier: "RH", state: "not_run" }]
  }
  const rehearsal = result("meta_spa_page_view", "RH", "pass")
  const rehearsed = applyResults(spa, [rehearsal], RUN, { budgetLeft: true }).item
  expect(rehearsed.state).toBe("waiting_deploy")
  const liveSince = "2026-10-02T10:00:00.000Z"
  expect(applyResults(rehearsed, [], RUN, { budgetLeft: true, liveSince }).item.state).toBe("waiting_deploy")
  const production = { ...rehearsal, at: "2026-10-02T10:05:00.000Z" }
  // A preview rehearsal after the merge is still not a measurement of production.
  expect(applyResults(rehearsed, [production], RUN, { budgetLeft: true, liveSince }).item.state).toBe("waiting_deploy")
  expect(applyResults(rehearsed, [production], RUN, { budgetLeft: true, liveSince, afterDeploy: true }).item.state).toBe("proven")
})


it("request 3 P2-B: a passed check without a deployment bound is checked but not tied to deployment", () => {
  const spa: ChecklistItem = { ...item("meta_improve", "waiting_deploy"), checks: [{ id: "meta_spa_page_view", tier: "RH", state: "not_run" }], claim: { status: "done", note: "done", at: CLAIM_AT } }
  const final = applyResults(spa, [result("meta_spa_page_view", "RH", "pass")], RUN, { budgetLeft: true, afterDeploy: true }).item
  expect(final.note).toContain("Checked, but not tied to this deploy")
  expect(final.note).not.toContain("Not checked")
})

it("request 3 wording: post-deploy notes use plain labels and receipt words", () => {
  const base: ChecklistItem = { ...item("posthog_improve", "waiting_deploy"), checks: [{ id: "posthog_distinct_id_receipt", tier: "PV", state: "not_run" }], claim: { status: "done", note: "done", at: CLAIM_AT } }
  const final = applyResults(base, [{ ...result("posthog_distinct_id_receipt", "PV", "problem"), reason: "receipt no_receipt" }], RUN, { budgetLeft: true, afterDeploy: true }).item
  expect(final.note).toBe("Failed after the deploy: PostHog received this visit (PostHog has no record of this visit)")
  expect(final.note).not.toMatch(/PV:|no_receipt|posthog_distinct/)
})

it("request 3 post-deploy RH: an old route failure cannot fail the new deployment", () => {
  const waiting: ChecklistItem = { ...item("posthog_improve", "waiting_deploy"), checks: [{ id: "posthog_via_proxy_once", tier: "RH", state: "not_run" }], claim: { status: "done", note: "done", at: CLAIM_AT } }
  const final = applyResults(waiting, [result("posthog_via_proxy_once", "RH", "problem")], RUN, { budgetLeft: true, afterDeploy: true, liveSince: "2026-10-02T10:00:00.000Z" }).item
  expect(final.state).toBe("claimed")
  expect(final.checks[0]!.state).toBe("not_run")
})


it("request 4 P3-before: failed rehearsal notes use plain words before deployment too", () => {
  const waiting: ChecklistItem = { ...item("duplicates_remove", "waiting_deploy"), checks: [{ id: "one_beacon_per_tool", tier: "RH", state: "not_run" }], claim: { status: "done", note: "done", at: CLAIM_AT } }
  const out = applyResults(waiting, [{ ...result("one_beacon_per_tool", "RH", "problem"), reason: "duplicate_page_view — ga4: G-ABC123 sent 2 page_view on home" }], RUN, { budgetLeft: false })
  expect(out.item.note).toContain("Each tag once per page (GA4 sent 2 page views on the home page)")
  expect(out.note).not.toMatch(/RH:|one_beacon_per_tool|duplicate_page_view/)
})


describe("notes redact before storage and display limits", () => {
  const secret = "fixtureDatabasePassword"
  const note = `Could not connect to postgres://user:${secret}@db.example/app`

  it("stores and returns redacted notes for every transition", () => {
    const outputs = [
      withNote(item("posthog_improve"), note),
      failItem(item("posthog_improve"), note),
      leaveForOwner(item("posthog_improve"), note),
      blockItem(item("posthog_improve"), "agent_blocked", note),
      unblockItem(item("posthog_improve", "blocked"), note)
    ]
    for (const output of outputs) {
      expect(JSON.stringify(output)).not.toContain(secret)
      expect(JSON.stringify(output)).toContain("[redacted: url_password]")
    }
  })

  it.each(["done", "blocked", "not_needed"] as const)("redacts a stored %s claim", status => {
    const output = applyClaim(item("posthog_improve"), { jobId: "posthog_improve:x", status, note, at: AT }, () => ({ agrees: true, evidence: [] }))
    expect(JSON.stringify(output)).not.toContain(secret)
    expect(output.item.claim?.note).toContain("[redacted: url_password]")
  })

  it("redacts stored check reasons before they become item and transition notes", () => {
    const output = applyResults(item("posthog_improve", "claimed"), [{ ...result("posthog_config", "S", "problem"), reason: note }], RUN, { budgetLeft: false })
    expect(JSON.stringify(output)).not.toContain(secret)
    expect(output.item.checks.find(check => check.id === "posthog_config")?.reason).toContain("[redacted: url_password]")
    expect(output.note).toContain("[redacted:")
  })

  it("uses a supplied scanner before truncating environment values", () => {
    const envSecret = "opaque@fixture|environmentCredential"
    const scanner = createScanner({ literals: [{ value: envSecret, kind: "env_value" }], allowedIds: [] })
    const output = withNote(item("posthog_improve"), "x".repeat(280) + envSecret, scanner)
    expect(output.note).not.toContain("opaque")
    expect(output.note).toContain("redacted")
  })
})
