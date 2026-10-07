import { parseReview } from "../agents/schema-check.js"
import { expect, it } from "vitest"
import { buildReviewPost, buildFinalComment } from "./post.js"
import { createScanner } from "./scan.js"
import { classifyReview, isReviewResult } from "./brief.js"
import { emptyLedger, openFindings, recordDecisions } from "./ledger.js"
import { triage, type TriageItem } from "./triage.js"
import type { ReviewResult } from "../wizard/contracts/agents.js"

const context = { allowlist: ["src/capture.ts"], declinedKeys: new Set<string>(), passingChecks: new Set<string>(), answerFor: () => null }
const item = (overrides: Partial<TriageItem> = {}): TriageItem => ({ source: "reviewer", threadId: null, findingId: "F1", category: "owner_consent_privacy", item: "R7", severity: "should", path: "src/capture.ts", line: 1, body: "PII and a signing secret are readable here", suggestedFix: null, ...overrides })

it.each([null, "src/capture.ts"])("uses the non-blocker owner category without words, path or ratios: %s", path => {
  const finding = item({ path })
  const decision = triage([finding], { ...context, writtenByRun: () => true })[0]!
  expect(decision.action).toBe("OWNER_INFO")
  const ledger = emptyLedger("fixture")
  recordDecisions(ledger, [decision], 1)
  expect(openFindings(ledger, [], undefined, () => true)).toEqual([])
})

it.each(["owner_consent_privacy", "request_ga4_proxy", "request_meta_unsupported", "request_meta_deletion", "analytics"] as const)("never drops a blocker regardless of category: %s", category => {
  const finding = item({ category, severity: "blocker" })
  const decision = triage([finding], context)[0]!
  expect(["DECLINE", "OWNER_INFO", "ANSWER"]).not.toContain(decision.action)
  const ledger = emptyLedger("fixture")
  recordDecisions(ledger, [{ item: finding, action: "OWNER_INFO", reason: "old classification" }], 1)
  expect(openFindings(ledger, [])).toHaveLength(1)
})

it("an empty checklist is incomplete even with a correct read-check and no findings", () => {
  const review: ReviewResult = { verdict: "looks_good", summary: "read-check: fixture", checklist: [], findings: [] }
  expect(classifyReview(review, "fixture").state).toBe("incomplete")
})


it("plain posts require both checklist rows and verified completeness before saying looks good", () => {
  const scanner = createScanner({ literals: [], allowedIds: [] })
  for (const [checklist, completeness] of [[[], "complete"], [[{ item: "R1", status: "pass", note: "checked" }], undefined]] as const) {
    const review: ReviewResult = { verdict: "looks_good", summary: "Review opinion", checklist: [...checklist], findings: [] }
    const body = buildReviewPost({ review, completeness, scanner, diffFiles: [], runId: "fixture", round: 1, head: "a".repeat(40), reviewer: "codex" }).body
    expect(body).toContain("incomplete")
    expect(body).not.toContain("could not check no checklist rows")
    expect(body).not.toContain(": looks good.")
    expect(body.match(/Owner actions and copyable handoffs/g)).toHaveLength(1)
  }
})

it("uses the structured report flag to show owner information once", () => {
  const heading = "About your consent or privacy pages (yours to decide)"
  const scanner = createScanner({ literals: [], allowedIds: [] })
  const comment = buildFinalComment({ runId: "fixture", reportMarkdown: `**${heading}**\n\nOwner opinion`, ownerInformationInReport: true, reviewer: "codex", reviewed: true, jobs: [], decisions: triage([item()], context), untrusted: [], notes: [], scanner })
  expect(comment.split(heading)).toHaveLength(2)
})

it("normalizes canonical labels and explicit severity synonyms without losing unknown findings", () => {
  for (const [severity, category, expected] of [["HIGH", "SECURITY", "blocker"], ["Critical", "Analytics", "blocker"], ["Should", "ANALYTICS", "should"], ["urgent", "analytics", "blocker"], ["nit", "unknown_kind", "blocker"]]) {
    const review = { verdict: "changes_suggested", summary: "checked", checklist: [], findings: [{ id: "F1", item: "R7", severity, category, path: "src/a.ts", line: 1, body: "Original reason", suggested_fix: null }] }
    expect(parseReview(JSON.stringify(review))).not.toBeNull()
    expect(isReviewResult(review)).toBe(true)
    expect(review.findings[0]!.severity).toBe(expected)
    expect(review.findings[0]!.body).toContain("Original reason")
    if (severity === "urgent" || category === "unknown_kind") expect(review.findings[0]!.body).toContain(severity === "urgent" ? "urgent" : "unknown_kind")
  }
})
it("requires every rubric row before calling a review complete", () => {
  const review: ReviewResult = { verdict: "looks_good", summary: "read-check: fixture", checklist: [{ item: "R1", status: "pass", note: "checked" }], findings: [] }
  expect(classifyReview(review, "fixture").state).toBe("incomplete")
  expect(classifyReview(review, "fixture").unchecked).toContain("R2")
})

it("unknown labels promote only their own finding", () => {
  const base = { id: "F1", item: "R7", severity: "nit", category: "analytics", path: "a.ts", line: 1, body: "Specific reason", suggested_fix: null }
  const parsed = parseReview({ verdict: "changes_suggested", summary: "Read", checklist: [], findings: [{ ...base, severity: "mystery" }, { ...base, id: "F2" }] })
  expect(parsed?.findings.map(finding => finding.severity)).toEqual(["blocker", "nit"])
  expect(parsed?.findings[0]?.body).toContain("mystery")
})
