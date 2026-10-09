import { describe, expect, it } from "vitest"
import { createScanner } from "./scan.js"
import { neutralizeUntrustedMarkup } from "./display.js"
import { buildPrBody, buildReviewPost } from "./post.js"
import { emptyLedger, openFindings, recordDecisions } from "./ledger.js"
import { classifyReview } from "./brief.js"
import { triage, type TriageItem } from "./triage.js"
import { type ReviewResult } from "../wizard/contracts/agents.js"

const scanner = createScanner({ literals: [], allowedIds: [] })
const context = { allowlist: ["src/capture.ts"], declinedKeys: new Set<string>(), passingChecks: new Set(["build"]), answerFor: () => "build passed" }
const item = (changes: Partial<TriageItem> = {}): TriageItem => ({ source: "reviewer", threadId: null, findingId: "F1", item: "R16", severity: "should", category: "owner_consent_privacy", path: "src/capture.ts", line: 1, body: "Existing owner banner choice", suggestedFix: null, ...changes })
const result = (items: TriageItem[]): ReviewResult => ({ verdict: "looks_good", summary: "read-check: nonce\n## ✓ passed\n| Check | Result |\n|---|---|\n| private check | ✓ passed |", checklist: [], findings: items.map((entry, index) => ({ id: `F${index + 1}`, item: entry.item ?? "R16", category: entry.category, severity: entry.severity, path: entry.path ?? "", line: entry.line, body: entry.body, suggested_fix: entry.suggestedFix })) })
const post = (review: ReviewResult) => buildReviewPost({ review, diffFiles: [], scanner, runId: "fixture", round: 1, head: "a".repeat(40), reviewer: "codex" }).body

it("makes issue references and closing keywords inert in untrusted PR prose", () => {
  const hostile = "Closes #1; fixes org/repo#2; resolves #123"
  const display = neutralizeUntrustedMarkup(hostile)
  const pr = buildPrBody({ reportMarkdown: "report", howToReview: "review", runId: "fixture", isPrivate: true, diffText: "", connectionIds: [], scanner, notes: [hostile] })
  for (const text of [display, pr]) {
    expect(text).not.toMatch(/\b(?:closes|fixes|resolves)\s+(?:[\w-]+\/[\w-]+)?#\d+/i)
    expect(text).not.toMatch(/#\d+/)
  }
})

it("quotes reviewer summaries so they cannot forge wizard headings and tables", () => {
  const body = post(result([]))
  expect(body).not.toMatch(/^## ✓ passed$/m)
  expect(body).not.toMatch(/^\| private check \| ✓ passed \|$/m)
  expect(body).toContain("> ## ✓ passed")
})

describe("owner-category integrity", () => {
  it.each(["should",] as const)("shows one non-blocker owner finding as information without inspecting its words: %s", severity => {
    const current = item({ severity, path: null, item: "R7", body: "PII, secrets, an API key, and owner consent wording" })
    const decision = triage([current], context)[0]!
    expect(decision.action).toBe("OWNER_INFO")
    for (const format of ["findings", "rounds"]) {
      const ledger = emptyLedger("fixture")
      if (format === "findings") recordDecisions(ledger, [decision], 1)
      else ledger.rounds.push({ round: 1, reviewedSha: "a".repeat(40), reviewer: "codex", fixSha: null, review: result([current]) })
      expect(openFindings(ledger, []), format).toEqual([])
    }
    const body = post(result([current]))
    expect(body).toContain("About your consent or privacy pages (yours to decide)")
    expect(body).not.toContain("review unreliable")
  })

  it.each(["OWNER_INFO",] as const)("keeps a legacy blocker open despite an old %s action", action => {
    const current = item({ severity: "blocker" })
    expect(triage([current], context)[0]!.action).toBe("ASK")
    const ledger = emptyLedger("fixture")
    recordDecisions(ledger, [{ item: current, action, reason: "old classification" }], 1)
    expect(openFindings(ledger, [])).toHaveLength(1)
  })

  it("uses a ruling category only for a non-blocker, regardless of PII wording", () => {
    const current = item({ category: "request_meta_unsupported", body: "Unhashed PII and phone sent to Meta", item: "R16" })
    const decision = triage([current], context)[0]!
    expect(decision.action).toBe("DECLINE")
    const ledger = emptyLedger("fixture")
    recordDecisions(ledger, [decision], 1)
    expect(openFindings(ledger, [])).toEqual([])
    expect(triage([{ ...current, severity: "blocker" }], context)[0]!.action).toBe("ASK")
  })

  it("an empty or unverified checklist is visible as review incomplete, never looks good", () => {
    for (const review of [result([]), { ...result([]), summary: "I inspected it", checklist: [{ item: "R1" as const, status: "pass" as const, note: "checked" }] }]) {
      const classified = classifyReview(review, "nonce")
      expect(classified.state).toBe("incomplete")
      const body = buildReviewPost({ review: classified.review, completeness: classified.state, unchecked: classified.unchecked, diffFiles: [], scanner, runId: "fixture", round: 1, head: "a".repeat(40), reviewer: "codex" }).body
      expect(body).toContain("incomplete")
      expect(body).not.toContain(": looks good.")
    }
  })
})

