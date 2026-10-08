import { describe, expect, it } from "vitest"

import type { ReviewFailure } from "./contracts/agents.js"
import { fallbackReviewer, NO_REVIEW_HEADLINE, notRunReason, notRunUnchecked, reviewNotRunCode, reviewOutcome, shouldAskAgain, usableReviewers } from "./review-outcome.js"

const REVIEW = { verdict: "looks_good", summary: "ok", checklist: [], findings: [] }

describe("reviewOutcome: a review that did not run keeps the pull request a draft, said plainly", () => {
  const cases: Array<[ReviewFailure, string, string]> = [
    [{ error: "rejected", message: "Invalid schema for response_format 'codex_output_schema': 'required' is required" }, "Codex's service refused the request", "INF_WIZ_AGENT_FAILED"],
    [{ error: "error", message: "stream disconnected before completion." }, "Codex stopped with an error: stream disconnected before completion", "INF_WIZ_AGENT_FAILED"],
    [{ error: "error" }, "Codex stopped with an error", "INF_WIZ_AGENT_FAILED"],
    [{ error: "unavailable", message: "is not installed" }, "Codex is not installed", "INF_WIZ_AGENT_FAILED"],
    [{ error: "unparseable" }, "Codex's answer did not match the format twice", "INF_WIZ_REVIEW_UNPARSEABLE"],
    [{ error: "timeout" }, "Codex ran out of time (10 minutes)", "INF_WIZ_AGENT_TIMEOUT"],
    [{ error: "out_of_usage" }, "Codex is out of usage", "INF_WIZ_AGENT_OUT_OF_USAGE"]
  ]
  it.each(cases)("%j → draft, “%s”", (failure, words, code) => {
    const outcome = reviewOutcome([{ reviewer: "codex", result: failure }])
    expect(outcome).toMatchObject({ ran: false, reviewer: null, keepDraft: true, headline: NO_REVIEW_HEADLINE, reasonWords: words, stoppedBy: failure.error, note: null })
    expect(outcome.message).toBe(`No second review ran on this pull request. ${words}. The pull request stays a draft.`)
    expect(reviewNotRunCode(outcome.stoppedBy!)).toBe(code)
    // No internal code in the sentence.
    expect(outcome.message).not.toMatch(/INF_WIZ|R\d+\b/)
  })

  it("a refused request never says 'schema', even when the service's own text does", () => {
    const outcome = reviewOutcome([{ reviewer: "codex", result: { error: "rejected", message: "Invalid schema: 'schema.properties' did not match" } }])
    expect(outcome.message).not.toMatch(/schema/i)
    expect(outcome.message).not.toMatch(/did not match/i)
  })

  it("a review that ran is not held: ready as before, no headline", () => {
    expect(reviewOutcome([{ reviewer: "codex", result: REVIEW }])).toEqual({ ran: true, reviewer: "codex", keepDraft: false, headline: null, reasonWords: "", message: "", stoppedBy: null, note: null })
  })

  it("the other agent's review, after the first failed, is used, and the note says who reviewed and why", () => {
    const outcome = reviewOutcome([{ reviewer: "codex", result: { error: "rejected" } }, { reviewer: "claude_code", result: REVIEW }])
    expect(outcome).toMatchObject({ ran: true, reviewer: "claude_code", keepDraft: false, headline: null })
    expect(outcome.note).toBe("Claude Code reviewed this pull request instead: Codex's service refused the request.")
  })

  it("both failing keeps the draft with both reasons; the last failure picks the outcome", () => {
    const outcome = reviewOutcome([{ reviewer: "codex", result: { error: "rejected" } }, { reviewer: "claude_code", result: { error: "error", message: "API Error: 500" } }])
    expect(outcome).toMatchObject({ ran: false, keepDraft: true, stoppedBy: "error" })
    expect(outcome.message).toBe("No second review ran on this pull request. Codex's service refused the request. Asked instead, Claude Code stopped with an error: API Error: 500. The pull request stays a draft.")
  })
})

describe("the re-ask and the fallback", () => {
  it("only an answer that broke the format is asked again", () => {
    expect(shouldAskAgain({ error: "unparseable" })).toBe(true)
    for (const error of ["rejected", "error", "unavailable", "timeout", "out_of_usage"] as const) expect(shouldAskAgain({ error })).toBe(false)
    expect(shouldAskAgain(REVIEW)).toBe(false)
  })

  it("asks the other usable agent once; never on out of usage; never one already tried", () => {
    expect(fallbackReviewer("codex", { error: "rejected" }, ["claude_code", "codex"])).toBe("claude_code")
    expect(fallbackReviewer("claude_code", { error: "unavailable" }, ["codex"])).toBe("codex")
    expect(fallbackReviewer("codex", { error: "timeout" }, ["codex"])).toBeNull()
    expect(fallbackReviewer("codex", { error: "out_of_usage" }, ["claude_code", "codex"])).toBeNull()
    expect(fallbackReviewer("codex", { error: "error" }, ["claude_code", "codex"], ["codex", "claude_code"])).toBeNull()
  })

  it("usable reviewers come from detect(), minus the ones it lists unavailable", () => {
    const info = (kind: "claude_code" | "codex") => ({ kind, binPath: `/bin/${kind}`, version: "1", whoPays: null as never })
    expect(usableReviewers({ worker: info("claude_code"), reviewer: info("codex"), nested: null })).toEqual(["claude_code", "codex"])
    expect(usableReviewers({ worker: info("claude_code"), reviewer: null, nested: null, unavailable: [{ kind: "codex", reason: "not_installed" }] })).toEqual(["claude_code"])
    expect(usableReviewers({ worker: null, reviewer: null, nested: null })).toEqual([])
  })

  it("the ledger keeps the reason words and gives them back", () => {
    expect(notRunReason(["x", notRunUnchecked("Codex is not installed")])).toBe("Codex is not installed")
    expect(notRunReason(["answer did not match the schema"])).toBeNull()
  })
})
