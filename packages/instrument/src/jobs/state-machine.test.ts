import { describe, expect, it } from "vitest"

import type { ChecklistItem, CheckResult, CheckTier, JobId } from "../wizard/contracts/jobs.js"
import { applyClaim, applyResults, applyReview, blockItem, failItem, leaveForOwner, unblockItem, withNote } from "./state-machine.js"
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
})

describe("checks decide (§3e.5)", () => {
  it("claimed → done_in_code → waiting_deploy when S + B + T0 pass", () => {
    const claimed = item("posthog_improve", "claimed")
    const next = applyResults(claimed, [result("posthog_config", "S", "pass"), result("next_rewrites_exact", "S", "pass"), result("posthog_improve_applied", "S", "pass")], RUN, { budgetLeft: true })
    expect(next.item.state).toBe("waiting_deploy")
  })

  it("only a check that proves the change may tick; checks that pass on absence only fail", () => {
    // conversions_to_tools: `meta_event_id_from_server` passes with nothing of the job in the code; it never ticks alone.
    const bare: ChecklistItem = { ...item("conversions_to_tools", "claimed"), checks: [{ id: "meta_event_id_from_server", tier: "S", state: "not_run" }, { id: "first_real_conversion", tier: "P", state: "not_run" }] }
    expect(applyResults(bare, [result("meta_event_id_from_server", "S", "pass")], RUN, { budgetLeft: true }).item.state).toBe("claimed")
    // A claimed item with only such checks is still verified by its recorded, in-scope diff…
    const edited = { ...bare, edits: [{ editId: "e1", file: "app/page.tsx" }] }
    expect(applyResults(edited, [result("meta_event_id_from_server", "S", "pass")], RUN, { budgetLeft: true }).item.state).toBe("waiting_real_event")
    // …but an item checked with no claim never is.
    expect(applyResults(edited, [result("meta_event_id_from_server", "S", "pass")], RUN, { budgetLeft: true, claimless: true }).item.state).toBe("claimed")
    // The absence check still FAILS a job.
    expect(applyResults(bare, [result("meta_event_id_from_server", "S", "problem")], RUN, { budgetLeft: true }).item.state).toBe("pending")
    // With the proving check, the claim-less item is ticked by the code itself.
    const tracked: ChecklistItem = { ...bare, checks: [...bare.checks, { id: "conversion_tracked", tier: "S", state: "not_run" }] }
    expect(applyResults(tracked, [result("meta_event_id_from_server", "S", "pass"), result("conversion_tracked", "S", "pass")], RUN, { budgetLeft: true, claimless: true }).item.state).toBe("waiting_real_event")
    expect(checkProvesChange("conversions_to_tools", "S", "conversion_tracked")).toBe(true)
    expect(checkProvesChange("conversions_to_tools", "S", "meta_event_id_from_server")).toBe(false)
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

  it("a stored pass from an older run never proves a resumed item", () => {
    const resumed = claimedAt(item("posthog_improve", "waiting_deploy"), CLAIM_AT)
    resumed.checks = resumed.checks.map((check) => ({ ...check, state: "pass" as const, at: AT, runId: OTHER_RUN }))
    expect(applyResults(resumed, [], RUN, { budgetLeft: true }).item.state).toBe("waiting_deploy")
    // Positive: the same checks passed in THIS run do prove it.
    const ours = { ...resumed, checks: resumed.checks.map((check) => ({ ...check, runId: RUN })) }
    expect(applyResults(ours, [], RUN, { budgetLeft: true }).item.state).toBe("proven")
  })

  it("a production reading taken before the change could be live never proves it", () => {
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

  it("job 10 waits for a real event only after its click test passes; a failing click test sends it back", () => {
    const claimed = claimedAt(item("conversions_to_tools", "claimed"), CLAIM_AT)
    expect(claimed.checks.map((check) => `${check.tier}:${check.id}`)).toEqual(["RH:click_test", "S:conversion_tracked", "S:meta_event_id_from_server", "P:first_real_conversion"])
    const local = applyResults(claimed, [result("conversion_tracked", "S", "pass"), result("meta_event_id_from_server", "S", "pass")], RUN, { budgetLeft: true })
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
})

it("a Meta SPA rehearsal cannot prove the job before deployment", () => {
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

describe("a proof visit the site's own cookie banner kept silent", () => {
  const liveSince = "2026-10-02T08:50:00.000Z"
  const commerce = (): ChecklistItem => ({
    ...claimedAt(item("meta_improve", "waiting_deploy"), CLAIM_AT),
    id: "meta_improve:commerce_events",
    checks: [
      { id: "meta_event_id_from_helper", tier: "S", state: "pass", runId: RUN, at: AT },
      { id: "meta_seen_leaving", tier: "PV", state: "not_run" }
    ]
  })

  it("is not measured, never failed, and the note says why in plain words", () => {
    const held = { ...result("meta_seen_leaving", "PV", "undetermined"), reason: "held_by_consent — your cookie banner keeps every tool off until a visitor accepts; real visitors who accept are measured from their own visits" }
    const next = applyResults(commerce(), [held], RUN, { budgetLeft: true, liveSince, afterDeploy: true })
    expect(next.item.state).not.toBe("failed")
    expect(next.item.note).toBe("Not measured after the deploy: your cookie banner keeps every tool off until a visitor accepts; real visitors who accept are measured from their own visits")
    expect(next.item.note).not.toMatch(/\/tr|2xx|Failed/)
  })

  it("negative: a real miss still fails, in plain words", () => {
    const missed = { ...result("meta_seen_leaving", "PV", "problem"), reason: "not_seen_leaving — no Meta request left the page and was accepted" }
    const next = applyResults(commerce(), [missed], RUN, { budgetLeft: true, liveSince, afterDeploy: true })
    expect(next.item.state).toBe("failed")
    expect(next.item.note).toBe("Failed after the deploy: Meta on the real visit (no Meta request left the page and was accepted)")
  })
})

describe("the review agent's answers (applyReview): a pass proves, no answer ever reverts", () => {
  const review = (state: NonNullable<ChecklistItem["review"]>["state"], reason?: string, runId = RUN): NonNullable<ChecklistItem["review"]> => ({
    state,
    runId,
    at: AT,
    reviewer: state === "not_run" ? null : "codex",
    ...(reason ? { reason } : {}),
    questions: [{ id: "once", text: "Is it sent once?", answer: state === "not_run" ? "not_asked" : state === "cant_tell" ? "cant_tell" : state }]
  })
  // A guard job on Next: no local check at all, so nothing but the review can decide it.
  const guard = (): ChecklistItem => ({ ...item("preview_guard", "claimed"), checks: [{ id: "preview_self_silent", tier: "RH", state: "not_run" }] })

  it("pass: a job no check proves is done in code, said as checked by the review agent", () => {
    const next = applyReview(guard(), review("pass"))
    expect(next.item.state).toBe("done_in_code")
    expect(next.item.note).toBe("Checked by the review agent.")
    // Without the review the same job is never ticked (no proving check, no recorded edit).
    expect(applyResults(guard(), [], RUN, { budgetLeft: true }).item.state).toBe("claimed")
  })

  it("fail, cant_tell and not_run KEEP the edits (done in code) with the reviewer's words; never pending, failed or put back", () => {
    expect(applyReview(guard(), review("fail", "the guard keeps production silent too (app/layout.tsx:4)")).item).toMatchObject({ state: "done_in_code", note: "Needs your look: the guard keeps production silent too (app/layout.tsx:4)" })
    expect(applyReview(guard(), review("cant_tell", "the host list is built at runtime")).item).toMatchObject({ state: "done_in_code", note: "The review could not tell: the host list is built at runtime" })
    expect(applyReview(guard(), review("not_run", "no review agent was chosen for this run")).item).toMatchObject({ state: "done_in_code", note: "Not checked by a review agent: no review agent was chosen for this run" })
  })

  it("a later check of the same tree keeps a reviewed job in code; a hard check's problem still sends it back", () => {
    const reviewed = applyReview(guard(), review("fail", "x")).item
    // The settlement re-checks a kept job as claimed: the review answer keeps it.
    expect(applyResults({ ...reviewed, state: "claimed" }, [], RUN, { budgetLeft: false }).item.state).toBe("done_in_code")
    const signup: ChecklistItem = { ...item("server_conversions", "claimed"), checks: [{ id: "outcome_declared", tier: "S", state: "not_run" }], review: review("pass") }
    expect(applyResults(signup, [result("outcome_declared", "S", "problem")], RUN, { budgetLeft: true }).item.state).toBe("pending")
  })

  it("NEGATIVE: a review from another run proves nothing; a pending (hard-check failed) job only records the answers", () => {
    expect(applyResults({ ...guard(), review: review("pass", undefined, "another-run") }, [], RUN, { budgetLeft: true }).item.state).toBe("claimed")
    const pending = applyReview({ ...guard(), state: "pending" }, review("pass"))
    expect(pending.item.state).toBe("pending")
    expect(pending.item.review?.state).toBe("pass")
  })

  it("after the deploy, a job the review decided stays done in code while its live checks are not measured", () => {
    const done = { ...applyReview(guard(), review("pass")).item, claim: { status: "done" as const, note: "n", at: AT } }
    const after = applyResults(done, [], RUN, { budgetLeft: true, afterDeploy: true, liveSince: AT })
    expect(after.item.state).toBe("done_in_code")
  })
})
