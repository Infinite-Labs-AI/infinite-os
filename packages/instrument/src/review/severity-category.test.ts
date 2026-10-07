import { expect, it } from "vitest"
import { classifyReview } from "./brief.js"
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
